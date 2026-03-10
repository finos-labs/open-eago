// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../registries/IIdentityRegistry.sol";
import "../registries/OnboardingRegistry.sol";

/**
 * @title LegalOracle
 * @notice On-chain oracle for the Legal review and contract execution sub-workflow.
 *
 * Lifecycle per request:
 *   PENDING → DRAFT_ISSUED → [MARKUP_SUBMITTED → DRAFT_ISSUED (negotiation loop)]
 *           → IN_HUMAN_REVIEW → [ESCALATED → IN_HUMAN_REVIEW] → EXECUTED | REJECTED
 *
 * Each negotiation round stores the keccak256(contractDocument) for that round,
 * creating an immutable on-chain audit trail of the full negotiation history.
 *
 * Contract execution requires bilateral Tier 2 approval — one human approver from
 * the bank AND one from the hedge fund — before execute() can be called.
 * This is tracked via two separate approval flags.
 *
 * Authorization layers:
 *   1. onlyBankAgent   — bank legal agent (agentWallet + oracleAddress binding)
 *   2. onlyClientAgent — hedge fund legal agent (agentWallet check only)
 *   3. Tier 2 bilateral human — bank approver calls approveBankSide(),
 *                               HF approver calls approveClientSide(),
 *                               then either may call execute()
 *   4. onlyActiveFlow  — OnboardingRegistry.isActive() must be true
 *
 * Payload privacy: contract document text is never stored on-chain.
 * Only keccak256(contractDocument) per round is committed.
 */
contract LegalOracle {

    // ── Status enum ───────────────────────────────────────────────────────────

    enum Status {
        None,           // 0 — request does not exist
        Pending,        // 1 — legal review in progress
        DraftIssued,    // 2 — bank has issued a draft; waiting for HF markup
        MarkupSubmitted,// 3 — HF has submitted markup; bank reviews (maps back to Pending)
        InHumanReview,  // 4 — agent submitted final recommendation; awaiting human sign-off
        Escalated,      // 5 — elevated to senior approvers (both sides)
        Executed,       // 6 — contract bilaterally executed (terminal)
        Rejected        // 7 — rejected (terminal); flow will be terminated
    }

    // ── Types ─────────────────────────────────────────────────────────────────

    struct LegalRequest {
        bytes32 flowId;
        uint256 clientAgentId;       // HF legal agent NFT id
        uint256 bankAgentId;         // bank legal agent NFT id
        Status  status;
        uint8   roundNumber;         // current negotiation round (0 = no draft yet)
        bytes32 latestVersionHash;   // keccak256 of the most recent document version
        bool    bankApproved;        // Tier 2: bank human approver has signed off
        bool    clientApproved;      // Tier 2: HF human approver has signed off
        bytes32 resultHash;          // keccak256 of final executed contract (set on execute)
        uint256 createdAt;
    }

    // ── Storage ───────────────────────────────────────────────────────────────

    IIdentityRegistry  public immutable identityRegistry;
    OnboardingRegistry public immutable onboardingRegistry;

    mapping(bytes32 => LegalRequest) private _requests;

    /// Per-request per-round contract version hashes (immutable audit trail)
    mapping(bytes32 => mapping(uint8 => bytes32)) private _versionHashes;

    // ── Events ────────────────────────────────────────────────────────────────

    event LegalReviewRequested(
        bytes32 indexed requestId,
        bytes32 indexed flowId,
        uint256 bankAgentId,
        uint256 clientAgentId,
        uint256 timestamp
    );
    event DraftIssued(
        bytes32 indexed requestId,
        bytes32 indexed flowId,
        bytes32 contractHash,
        uint8   round,
        uint256 timestamp
    );
    event MarkupSubmitted(
        bytes32 indexed requestId,
        bytes32 indexed flowId,
        bytes32 markupHash,
        uint8   round,
        uint256 agentId,
        uint256 timestamp
    );
    event InHumanReview(bytes32 indexed requestId, bytes32 indexed flowId, uint8 round, uint256 timestamp);
    event Escalated(bytes32 indexed requestId, bytes32 indexed flowId, bytes reason, uint256 timestamp);
    event BankSideApproved(bytes32 indexed requestId, bytes32 indexed flowId, uint256 timestamp);
    event ClientSideApproved(bytes32 indexed requestId, bytes32 indexed flowId, uint256 timestamp);
    event ContractExecuted(
        bytes32 indexed requestId,
        bytes32 indexed flowId,
        bytes32 finalContractHash,
        uint256 timestamp
    );
    event LegalRejected(
        bytes32 indexed requestId,
        bytes32 indexed flowId,
        bytes reason,
        uint256 timestamp
    );

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address identityRegistry_, address onboardingRegistry_) {
        require(identityRegistry_   != address(0), "zero identityRegistry");
        require(onboardingRegistry_ != address(0), "zero onboardingRegistry");
        identityRegistry   = IIdentityRegistry(identityRegistry_);
        onboardingRegistry = OnboardingRegistry(onboardingRegistry_);
    }

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyBankAgent(uint256 agentId) {
        require(
            identityRegistry.getAgentWallet(agentId) == msg.sender,
            "LegalOracle: caller is not the bank agent wallet"
        );
        require(
            identityRegistry.getOracleAddress(agentId) == address(this),
            "LegalOracle: agent not bound to this oracle"
        );
        _;
    }

    modifier onlyClientAgent(uint256 agentId) {
        require(
            identityRegistry.getAgentWallet(agentId) == msg.sender,
            "LegalOracle: caller is not the client agent wallet"
        );
        _;
    }

    modifier onlyActiveFlow(bytes32 flowId) {
        require(onboardingRegistry.isActive(flowId), "LegalOracle: flow terminated or does not exist");
        _;
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _checkCardHash(uint256 agentId, bytes32 cardHash_) internal view {
        bytes32 committed = identityRegistry.getCardHash(agentId);
        if (committed != bytes32(0)) {
            require(committed == cardHash_, "card hash mismatch");
        }
    }

    // ── Request initiation ────────────────────────────────────────────────────

    /**
     * @notice Open a legal review request.
     * @param flowId        The onboarding flow (== traceId).
     * @param bankAgentId   Bank legal agent NFT id.
     * @param clientAgentId Hedge fund legal agent NFT id.
     * @return requestId    keccak256(flowId, bankAgentId, block.timestamp)
     */
    function requestLegalReview(
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

        _requests[requestId] = LegalRequest({
            flowId:            flowId,
            clientAgentId:     clientAgentId,
            bankAgentId:       bankAgentId,
            status:            Status.Pending,
            roundNumber:       0,
            latestVersionHash: bytes32(0),
            bankApproved:      false,
            clientApproved:    false,
            resultHash:        bytes32(0),
            createdAt:         block.timestamp
        });

        emit LegalReviewRequested(requestId, flowId, bankAgentId, clientAgentId, block.timestamp);
    }

    // ── Bank agent actions ────────────────────────────────────────────────────

    /**
     * @notice Issue (or re-issue) a contract draft to the hedge fund.
     *         First call opens round 1; subsequent calls after markup advance the round.
     *         Moves status to DRAFT_ISSUED.
     */
    function issueDraft(
        bytes32 requestId,
        uint256 bankAgentId,
        bytes32 contractHash,
        bytes32 cardHash_
    )
        external
        onlyBankAgent(bankAgentId)
    {
        _checkCardHash(bankAgentId, cardHash_);
        LegalRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(req.bankAgentId == bankAgentId, "wrong agent");
        require(
            req.status == Status.Pending,
            "must be Pending to issue draft"
        );
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");

        req.roundNumber++;
        req.status            = Status.DraftIssued;
        req.latestVersionHash = contractHash;
        _versionHashes[requestId][req.roundNumber] = contractHash;

        emit DraftIssued(requestId, req.flowId, contractHash, req.roundNumber, block.timestamp);
    }

    /**
     * @notice Submit agent recommendation for bilateral human review.
     *         Moves status to IN_HUMAN_REVIEW. Both sides must then approve
     *         before execute() can be called.
     */
    function submitRecommendation(
        bytes32 requestId,
        uint256 bankAgentId,
        bytes32 finalHash,
        bytes32 cardHash_
    )
        external
        onlyBankAgent(bankAgentId)
    {
        _checkCardHash(bankAgentId, cardHash_);
        LegalRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(req.bankAgentId == bankAgentId, "wrong agent");
        require(req.status == Status.Pending, "must be Pending to submit recommendation");
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");

        req.status            = Status.InHumanReview;
        req.latestVersionHash = finalHash;
        emit InHumanReview(requestId, req.flowId, req.roundNumber, block.timestamp);
    }

    /**
     * @notice Escalate to senior approvers (both sides). InHumanReview → Escalated.
     */
    function escalate(
        bytes32 requestId,
        uint256 bankAgentId,
        bytes   calldata reason
    )
        external
        onlyBankAgent(bankAgentId)
    {
        LegalRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(req.bankAgentId == bankAgentId, "wrong agent");
        require(req.status == Status.InHumanReview, "must be InHumanReview to escalate");
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");

        req.status = Status.Escalated;
        emit Escalated(requestId, req.flowId, reason, block.timestamp);
    }

    // ── Client agent action ───────────────────────────────────────────────────

    /**
     * @notice Submit markup on the issued draft. Records the markup hash for
     *         this round and moves status back to Pending so the bank agent
     *         can review and issue a revised draft or proceed to recommendation.
     */
    function submitMarkup(
        bytes32 requestId,
        uint256 clientAgentId,
        bytes32 markupHash,
        bytes32 cardHash_
    )
        external
        onlyClientAgent(clientAgentId)
    {
        _checkCardHash(clientAgentId, cardHash_);
        LegalRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(req.clientAgentId == clientAgentId, "wrong client agent");
        require(req.status == Status.DraftIssued, "no draft to mark up");
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");

        req.status            = Status.Pending;
        req.latestVersionHash = markupHash;
        emit MarkupSubmitted(requestId, req.flowId, markupHash, req.roundNumber, clientAgentId, block.timestamp);
    }

    // ── Human approver actions (bilateral Tier 2) ─────────────────────────────

    /**
     * @notice Bank-side human approver signs off on contract execution.
     *         Caller must NOT be the bank agent wallet.
     */
    function approveBankSide(bytes32 requestId, uint256 bankAgentId) external {
        LegalRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(req.bankAgentId == bankAgentId, "wrong agent");
        require(
            req.status == Status.InHumanReview || req.status == Status.Escalated,
            "must be InHumanReview or Escalated"
        );
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");
        require(
            msg.sender != identityRegistry.getAgentWallet(bankAgentId),
            "LegalOracle: agent cannot self-approve"
        );
        require(!req.bankApproved, "bank side already approved");

        req.bankApproved = true;
        emit BankSideApproved(requestId, req.flowId, block.timestamp);
    }

    /**
     * @notice Client-side (hedge fund) human approver signs off on contract execution.
     *         Caller must NOT be the client agent wallet.
     */
    function approveClientSide(bytes32 requestId, uint256 clientAgentId) external {
        LegalRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(req.clientAgentId == clientAgentId, "wrong agent");
        require(
            req.status == Status.InHumanReview || req.status == Status.Escalated,
            "must be InHumanReview or Escalated"
        );
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");
        require(
            msg.sender != identityRegistry.getAgentWallet(clientAgentId),
            "LegalOracle: agent cannot self-approve"
        );
        require(!req.clientApproved, "client side already approved");

        req.clientApproved = true;
        emit ClientSideApproved(requestId, req.flowId, block.timestamp);
    }

    /**
     * @notice Execute the contract once both sides have approved.
     *         Can be called by any account once both approval flags are set.
     *         Updates OnboardingRegistry phase bitmask.
     */
    function execute(bytes32 requestId) external {
        LegalRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(
            req.status == Status.InHumanReview || req.status == Status.Escalated,
            "must be InHumanReview or Escalated"
        );
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");
        require(req.bankApproved,   "LegalOracle: bank side not yet approved");
        require(req.clientApproved, "LegalOracle: client side not yet approved");

        req.status     = Status.Executed;
        req.resultHash = req.latestVersionHash;
        onboardingRegistry.setPhaseComplete(req.flowId, onboardingRegistry.PHASE_LEGAL_EXECUTED());
        emit ContractExecuted(requestId, req.flowId, req.latestVersionHash, block.timestamp);
    }

    /**
     * @notice Reject the legal contract — terminates onboarding flow.
     *         Either side's human approver may reject. Caller must not be an agent wallet.
     */
    function reject(bytes32 requestId, uint256 bankAgentId, bytes calldata reason) external {
        LegalRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(req.bankAgentId == bankAgentId, "wrong agent");
        require(
            req.status == Status.InHumanReview || req.status == Status.Escalated,
            "must be InHumanReview or Escalated"
        );
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");
        require(
            msg.sender != identityRegistry.getAgentWallet(bankAgentId),
            "LegalOracle: agent cannot self-reject"
        );

        req.status = Status.Rejected;
        onboardingRegistry.terminate(req.flowId, reason);
        emit LegalRejected(requestId, req.flowId, reason, block.timestamp);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getRequest(bytes32 requestId) external view returns (LegalRequest memory) {
        return _requests[requestId];
    }

    function getStatus(bytes32 requestId) external view returns (Status) {
        return _requests[requestId].status;
    }

    /**
     * @notice Returns the contract version hash for a specific negotiation round.
     */
    function getVersionHash(bytes32 requestId, uint8 round) external view returns (bytes32) {
        return _versionHashes[requestId][round];
    }
}
