// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../registries/IIdentityRegistry.sol";
import "../registries/OnboardingRegistry.sol";

/**
 * @title AMLOracle
 * @notice On-chain oracle for the AML review sub-workflow.
 *
 * Lifecycle per request:
 *   PENDING → [DATA_REQUESTED ↔ PENDING (data loop)] → IN_HUMAN_REVIEW
 *          → [ESCALATED → IN_HUMAN_REVIEW] → CLEARED | REJECTED
 *
 * Authorization layers:
 *   1. onlyBankAgent   — bank AML agent (msg.sender == agentWallet, oracle bound to this contract)
 *   2. onlyClientAgent — hedge fund document agent (msg.sender == registered document agent wallet)
 *   3. Tier 2 human    — bank approver registered in ParticipantRegistry (checked off-chain via
 *                        ActionPermitRegistry; enforced here by requiring status == IN_HUMAN_REVIEW
 *                        and caller != the agent wallet, i.e. a separate human approver address)
 *   4. onlyActiveFlow  — OnboardingRegistry.isActive() must be true (if registry configured)
 *
 * Payload privacy: raw AML results are never stored on-chain. Only
 * keccak256(result) is committed; the full payload is stored off-chain by the bank.
 */
contract AMLOracle {

    // ── Status enum ───────────────────────────────────────────────────────────

    enum Status {
        None,            // 0 — request does not exist
        Pending,         // 1 — AML review in progress (agent working)
        DataRequested,   // 2 — waiting for client to supply documents
        InHumanReview,   // 3 — agent submitted recommendation; awaiting human sign-off
        Escalated,       // 4 — elevated to senior approver
        Cleared,         // 5 — AML passed (terminal)
        Rejected         // 6 — AML failed (terminal); flow will be terminated
    }

    // ── Types ─────────────────────────────────────────────────────────────────

    struct AMLRequest {
        bytes32 flowId;
        uint256 clientAgentId;   // hedge fund document agent NFT id
        uint256 bankAgentId;     // bank AML agent NFT id
        Status  status;
        bytes32 dataRequestSpec; // keccak256 of requested document spec (off-chain)
        uint8   dataRequestRound;
        bytes32 resultHash;      // keccak256 of screening result payload (off-chain)
        uint256 createdAt;
    }

    // ── Storage ───────────────────────────────────────────────────────────────

    IIdentityRegistry    public immutable identityRegistry;
    OnboardingRegistry   public immutable onboardingRegistry;

    mapping(bytes32 => AMLRequest) private _requests;

    // ── Events ────────────────────────────────────────────────────────────────

    event AMLReviewRequested(
        bytes32 indexed requestId,
        bytes32 indexed flowId,
        uint256 bankAgentId,
        uint256 clientAgentId,
        uint256 timestamp
    );
    event DataRequested(
        bytes32 indexed requestId,
        bytes32 indexed flowId,
        bytes32 dataSpecHash,
        uint8   round,
        uint256 timestamp
    );
    event DataFulfilled(
        bytes32 indexed requestId,
        bytes32 indexed flowId,
        bytes32 dataHash,
        uint256 submittingAgentId,
        uint256 timestamp
    );
    event InHumanReview(bytes32 indexed requestId, bytes32 indexed flowId, uint256 timestamp);
    event Escalated(bytes32 indexed requestId, bytes32 indexed flowId, bytes reason, uint256 timestamp);
    event AMLCleared(bytes32 indexed requestId, bytes32 indexed flowId, uint256 bankAgentId, uint256 timestamp);
    event AMLRejected(bytes32 indexed requestId, bytes32 indexed flowId, bytes reason, uint256 bankAgentId, uint256 timestamp);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address identityRegistry_, address onboardingRegistry_) {
        require(identityRegistry_    != address(0), "zero identityRegistry");
        require(onboardingRegistry_  != address(0), "zero onboardingRegistry");
        identityRegistry   = IIdentityRegistry(identityRegistry_);
        onboardingRegistry = OnboardingRegistry(onboardingRegistry_);
    }

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyBankAgent(uint256 agentId) {
        require(
            identityRegistry.getAgentWallet(agentId) == msg.sender,
            "AMLOracle: caller is not the bank agent wallet"
        );
        require(
            identityRegistry.getOracleAddress(agentId) == address(this),
            "AMLOracle: agent not bound to this oracle"
        );
        _;
    }

    modifier onlyClientAgent(uint256 agentId) {
        require(
            identityRegistry.getAgentWallet(agentId) == msg.sender,
            "AMLOracle: caller is not the client agent wallet"
        );
        _;
    }

    modifier onlyActiveFlow(bytes32 flowId) {
        require(onboardingRegistry.isActive(flowId), "AMLOracle: flow terminated or does not exist");
        _;
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /**
     * @dev If the agent has committed a card hash, enforce that the caller
     *      supplies the matching hash. Skipped when no hash has been committed
     *      (bytes32(0)) — opt-in per agent.
     */
    function _checkCardHash(uint256 agentId, bytes32 cardHash_) internal view {
        bytes32 committed = identityRegistry.getCardHash(agentId);
        if (committed != bytes32(0)) {
            require(committed == cardHash_, "card hash mismatch");
        }
    }

    // ── Request initiation ────────────────────────────────────────────────────

    /**
     * @notice Open an AML review request for a client. Called by the bank's
     *         OnboardingOrchestrator bridge at flow start.
     * @param flowId        The onboarding flow (== traceId).
     * @param bankAgentId   Bank AML agent NFT id.
     * @param clientAgentId Hedge fund document agent NFT id.
     * @return requestId    keccak256(flowId, bankAgentId, block.timestamp)
     */
    function requestAMLReview(
        bytes32 flowId,
        uint256 bankAgentId,
        uint256 clientAgentId
    )
        external
        onlyBankAgent(bankAgentId)
        onlyActiveFlow(flowId)
        returns (bytes32 requestId)
    {
        requestId = keccak256(abi.encode(flowId, bankAgentId, block.timestamp));
        require(_requests[requestId].createdAt == 0, "requestId collision");

        _requests[requestId] = AMLRequest({
            flowId:           flowId,
            clientAgentId:    clientAgentId,
            bankAgentId:      bankAgentId,
            status:           Status.Pending,
            dataRequestSpec:  bytes32(0),
            dataRequestRound: 0,
            resultHash:       bytes32(0),
            createdAt:        block.timestamp
        });

        emit AMLReviewRequested(requestId, flowId, bankAgentId, clientAgentId, block.timestamp);
    }

    // ── AML agent actions ─────────────────────────────────────────────────────

    /**
     * @notice Request additional KYC / AML documents from the client.
     *         Flow pauses until fulfillDataRequest() is called by the client agent.
     */
    function requestClientData(
        bytes32 requestId,
        uint256 bankAgentId,
        bytes32 dataSpecHash
    )
        external
        onlyBankAgent(bankAgentId)
    {
        AMLRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(req.bankAgentId == bankAgentId, "wrong agent");
        require(req.status == Status.Pending, "must be Pending to request data");
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");

        req.status          = Status.DataRequested;
        req.dataRequestSpec = dataSpecHash;
        req.dataRequestRound++;
        emit DataRequested(requestId, req.flowId, dataSpecHash, req.dataRequestRound, block.timestamp);
    }

    /**
     * @notice Submit agent recommendation for human review.
     *         Moves status to IN_HUMAN_REVIEW; a bank human approver must then
     *         call clear() or reject().
     */
    function submitRecommendation(
        bytes32 requestId,
        uint256 bankAgentId,
        bytes32 resultHash,
        bytes32 cardHash_
    )
        external
        onlyBankAgent(bankAgentId)
    {
        _checkCardHash(bankAgentId, cardHash_);
        AMLRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(req.bankAgentId == bankAgentId, "wrong agent");
        require(
            req.status == Status.Pending || req.status == Status.DataRequested,
            "must be Pending or DataRequested"
        );
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");

        req.status     = Status.InHumanReview;
        req.resultHash = resultHash;
        emit InHumanReview(requestId, req.flowId, block.timestamp);
    }

    /**
     * @notice Escalate to senior approver path. Moves from InHumanReview → Escalated.
     *         A different (senior) human approver address is then required for clear/reject.
     */
    function escalate(
        bytes32 requestId,
        uint256 bankAgentId,
        bytes   calldata reason
    )
        external
        onlyBankAgent(bankAgentId)
    {
        AMLRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(req.bankAgentId == bankAgentId, "wrong agent");
        require(req.status == Status.InHumanReview, "must be InHumanReview to escalate");
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");

        req.status = Status.Escalated;
        emit Escalated(requestId, req.flowId, reason, block.timestamp);
    }

    // ── Client agent action ───────────────────────────────────────────────────

    /**
     * @notice Submit requested documents. Called by the hedge fund's
     *         HedgeFundDocumentAgent. Resumes the flow from DataRequested → Pending.
     */
    function fulfillDataRequest(
        bytes32 requestId,
        uint256 clientAgentId,
        bytes32 dataHash,
        bytes32 cardHash_
    )
        external
        onlyClientAgent(clientAgentId)
    {
        _checkCardHash(clientAgentId, cardHash_);
        AMLRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(req.clientAgentId == clientAgentId, "wrong client agent");
        require(req.status == Status.DataRequested, "not waiting for data");
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");

        req.status = Status.Pending;
        emit DataFulfilled(requestId, req.flowId, dataHash, clientAgentId, block.timestamp);
    }

    // ── Human approver actions (Tier 2) ──────────────────────────────────────

    /**
     * @notice AML cleared — approved by a bank human approver.
     *         Caller must NOT be the bank agent wallet (human, not agent).
     *         Updates OnboardingRegistry phase bitmask.
     */
    function clear(bytes32 requestId, uint256 bankAgentId) external {
        AMLRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(req.bankAgentId == bankAgentId, "wrong agent");
        require(
            req.status == Status.InHumanReview || req.status == Status.Escalated,
            "must be InHumanReview or Escalated"
        );
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");
        // Human approver must not be the agent itself
        require(
            msg.sender != identityRegistry.getAgentWallet(bankAgentId),
            "AMLOracle: agent cannot self-approve"
        );

        req.status = Status.Cleared;
        onboardingRegistry.setPhaseComplete(req.flowId, onboardingRegistry.PHASE_AML_CLEARED());
        emit AMLCleared(requestId, req.flowId, bankAgentId, block.timestamp);
    }

    /**
     * @notice AML rejected — bank human approver rejects; terminates onboarding flow.
     */
    function reject(bytes32 requestId, uint256 bankAgentId, bytes calldata reason) external {
        AMLRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(req.bankAgentId == bankAgentId, "wrong agent");
        require(
            req.status == Status.InHumanReview || req.status == Status.Escalated,
            "must be InHumanReview or Escalated"
        );
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");
        require(
            msg.sender != identityRegistry.getAgentWallet(bankAgentId),
            "AMLOracle: agent cannot self-reject"
        );

        req.status = Status.Rejected;
        onboardingRegistry.terminate(req.flowId, reason);
        emit AMLRejected(requestId, req.flowId, reason, bankAgentId, block.timestamp);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getRequest(bytes32 requestId) external view returns (AMLRequest memory) {
        return _requests[requestId];
    }

    function getStatus(bytes32 requestId) external view returns (Status) {
        return _requests[requestId].status;
    }
}
