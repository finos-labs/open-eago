// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../registries/IIdentityRegistry.sol";
import "../registries/OnboardingRegistry.sol";

/**
 * @title CreditRiskOracle
 * @notice On-chain oracle for the Credit Risk review sub-workflow.
 *
 * Lifecycle per request:
 *   PENDING → [DATA_REQUESTED ↔ PENDING (data loop)]
 *           → [NEGOTIATING ↔ PENDING (negotiation loop)]
 *           → IN_HUMAN_REVIEW
 *           → [ESCALATED → IN_HUMAN_REVIEW] → APPROVED | REJECTED
 *
 * The credit negotiation loop allows the bank's CreditRiskAgent to propose
 * terms, the hedge fund's CreditNegotiatorAgent to counter-propose, and
 * the bank agent to accept or continue iterating. Once terms are agreed,
 * the agent submits a recommendation for human review (Tier 2).
 *
 * Authorization layers:
 *   1. onlyBankAgent   — bank credit risk agent (agentWallet + oracleAddress binding)
 *   2. onlyClientAgent — hedge fund credit negotiator or document agent
 *   3. Tier 2 human    — bank approver; must not be the agent wallet
 *   4. onlyActiveFlow  — OnboardingRegistry.isActive() must be true
 *
 * Payload privacy: raw credit assessment results and proposed terms are
 * never stored on-chain. Only keccak256 hashes are committed.
 */
contract CreditRiskOracle {

    // ── Status enum ───────────────────────────────────────────────────────────

    enum Status {
        None,           // 0 — request does not exist
        Pending,        // 1 — credit review in progress
        DataRequested,  // 2 — waiting for client to supply documents
        Negotiating,    // 3 — terms proposed; waiting for counter-proposal
        InHumanReview,  // 4 — agent submitted recommendation; awaiting human sign-off
        Escalated,      // 5 — elevated to senior approver
        Approved,       // 6 — credit approved (terminal)
        Rejected        // 7 — credit rejected (terminal); flow will be terminated
    }

    // ── Types ─────────────────────────────────────────────────────────────────

    struct CreditRequest {
        bytes32 flowId;
        uint256 clientAgentId;        // HF document or credit negotiator agent NFT id
        uint256 bankAgentId;          // bank credit risk agent NFT id
        Status  status;
        bytes32 dataRequestSpec;      // keccak256 of requested document spec
        uint8   dataRequestRound;
        bytes32 currentTermsHash;     // keccak256 of latest proposed terms (off-chain)
        uint8   negotiationRound;
        bytes32 resultHash;           // keccak256 of final credit assessment (off-chain)
        uint256 createdAt;
    }

    // ── Storage ───────────────────────────────────────────────────────────────

    IIdentityRegistry  public immutable identityRegistry;
    OnboardingRegistry public immutable onboardingRegistry;

    mapping(bytes32 => CreditRequest) private _requests;

    // ── Events ────────────────────────────────────────────────────────────────

    event CreditReviewRequested(
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
    event TermsProposed(
        bytes32 indexed requestId,
        bytes32 indexed flowId,
        bytes32 termsHash,
        uint8   round,
        uint256 timestamp
    );
    event CounterProposed(
        bytes32 indexed requestId,
        bytes32 indexed flowId,
        bytes32 proposalHash,
        uint256 agentId,
        uint256 timestamp
    );
    event TermsAgreed(
        bytes32 indexed requestId,
        bytes32 indexed flowId,
        bytes32 agreedTermsHash,
        uint256 timestamp
    );
    event InHumanReview(bytes32 indexed requestId, bytes32 indexed flowId, uint256 timestamp);
    event Escalated(bytes32 indexed requestId, bytes32 indexed flowId, bytes reason, uint256 timestamp);
    event CreditApproved(bytes32 indexed requestId, bytes32 indexed flowId, uint256 bankAgentId, uint256 timestamp);
    event CreditRejected(bytes32 indexed requestId, bytes32 indexed flowId, bytes reason, uint256 bankAgentId, uint256 timestamp);

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
            "CreditRiskOracle: caller is not the bank agent wallet"
        );
        require(
            identityRegistry.getOracleAddress(agentId) == address(this),
            "CreditRiskOracle: agent not bound to this oracle"
        );
        _;
    }

    modifier onlyClientAgent(uint256 agentId) {
        require(
            identityRegistry.getAgentWallet(agentId) == msg.sender,
            "CreditRiskOracle: caller is not the client agent wallet"
        );
        _;
    }

    modifier onlyActiveFlow(bytes32 flowId) {
        require(onboardingRegistry.isActive(flowId), "CreditRiskOracle: flow terminated or does not exist");
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
     * @notice Open a credit risk review request for a client.
     * @param flowId        The onboarding flow (== traceId).
     * @param bankAgentId   Bank credit risk agent NFT id.
     * @param clientAgentId Hedge fund document or credit negotiator agent NFT id.
     * @return requestId    keccak256(flowId, bankAgentId, block.timestamp)
     */
    function requestCreditReview(
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

        _requests[requestId] = CreditRequest({
            flowId:            flowId,
            clientAgentId:     clientAgentId,
            bankAgentId:       bankAgentId,
            status:            Status.Pending,
            dataRequestSpec:   bytes32(0),
            dataRequestRound:  0,
            currentTermsHash:  bytes32(0),
            negotiationRound:  0,
            resultHash:        bytes32(0),
            createdAt:         block.timestamp
        });

        emit CreditReviewRequested(requestId, flowId, bankAgentId, clientAgentId, block.timestamp);
    }

    // ── Bank agent actions ────────────────────────────────────────────────────

    /**
     * @notice Request additional documents from the client.
     *         Pauses the flow until fulfillDataRequest() is called.
     */
    function requestClientData(
        bytes32 requestId,
        uint256 bankAgentId,
        bytes32 dataSpecHash
    )
        external
        onlyBankAgent(bankAgentId)
    {
        CreditRequest storage req = _requests[requestId];
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
     * @notice Propose credit terms to the hedge fund. Opens a negotiation round.
     *         Moves status to NEGOTIATING; the HF credit negotiator must respond
     *         via submitCounterProposal() or the bank can call acceptTerms()
     *         after receiving an off-chain response and encoding it on-chain.
     */
    function proposeTerms(
        bytes32 requestId,
        uint256 bankAgentId,
        bytes32 termsHash,
        bytes32 cardHash_
    )
        external
        onlyBankAgent(bankAgentId)
    {
        _checkCardHash(bankAgentId, cardHash_);
        CreditRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(req.bankAgentId == bankAgentId, "wrong agent");
        require(req.status == Status.Pending, "must be Pending to propose terms");
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");

        req.status           = Status.Negotiating;
        req.currentTermsHash = termsHash;
        req.negotiationRound++;
        emit TermsProposed(requestId, req.flowId, termsHash, req.negotiationRound, block.timestamp);
    }

    /**
     * @notice Accept the current agreed terms and advance to recommendation.
     *         Called by the bank agent after both parties have converged
     *         (off-chain) on final terms. Moves to Pending for submitRecommendation.
     */
    function acceptTerms(
        bytes32 requestId,
        uint256 bankAgentId,
        bytes32 agreedTermsHash,
        bytes32 cardHash_
    )
        external
        onlyBankAgent(bankAgentId)
    {
        _checkCardHash(bankAgentId, cardHash_);
        CreditRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(req.bankAgentId == bankAgentId, "wrong agent");
        require(req.status == Status.Negotiating, "must be Negotiating to accept");
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");

        req.status           = Status.Pending;
        req.currentTermsHash = agreedTermsHash;
        emit TermsAgreed(requestId, req.flowId, agreedTermsHash, block.timestamp);
    }

    /**
     * @notice Submit agent recommendation for human review.
     *         Moves status to IN_HUMAN_REVIEW; a bank human approver must then
     *         call approve() or reject().
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
        CreditRequest storage req = _requests[requestId];
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
     * @notice Escalate to senior approver. Moves InHumanReview → Escalated.
     */
    function escalate(
        bytes32 requestId,
        uint256 bankAgentId,
        bytes   calldata reason
    )
        external
        onlyBankAgent(bankAgentId)
    {
        CreditRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(req.bankAgentId == bankAgentId, "wrong agent");
        require(req.status == Status.InHumanReview, "must be InHumanReview to escalate");
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");

        req.status = Status.Escalated;
        emit Escalated(requestId, req.flowId, reason, block.timestamp);
    }

    // ── Client agent actions ──────────────────────────────────────────────────

    /**
     * @notice Submit requested documents. Resumes the flow from DataRequested → Pending.
     *         Called by the HF document agent.
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
        CreditRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(req.clientAgentId == clientAgentId, "wrong client agent");
        require(req.status == Status.DataRequested, "not waiting for data");
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");

        req.status = Status.Pending;
        emit DataFulfilled(requestId, req.flowId, dataHash, clientAgentId, block.timestamp);
    }

    /**
     * @notice Submit a counter-proposal to the bank's proposed terms.
     *         Called by the HF credit negotiator agent. Resumes Negotiating → Pending
     *         so the bank agent can review the counter and either propose new terms
     *         or call acceptTerms().
     */
    function submitCounterProposal(
        bytes32 requestId,
        uint256 clientAgentId,
        bytes32 proposalHash,
        bytes32 cardHash_
    )
        external
        onlyClientAgent(clientAgentId)
    {
        _checkCardHash(clientAgentId, cardHash_);
        CreditRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(req.clientAgentId == clientAgentId, "wrong client agent");
        require(req.status == Status.Negotiating, "not in negotiation");
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");

        req.status           = Status.Pending;
        req.currentTermsHash = proposalHash;
        emit CounterProposed(requestId, req.flowId, proposalHash, clientAgentId, block.timestamp);
    }

    // ── Human approver actions (Tier 2) ──────────────────────────────────────

    /**
     * @notice Credit approved by a bank human approver.
     *         Caller must NOT be the bank agent wallet.
     *         Updates OnboardingRegistry phase bitmask.
     */
    function approve(bytes32 requestId, uint256 bankAgentId) external {
        CreditRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(req.bankAgentId == bankAgentId, "wrong agent");
        require(
            req.status == Status.InHumanReview || req.status == Status.Escalated,
            "must be InHumanReview or Escalated"
        );
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");
        require(
            msg.sender != identityRegistry.getAgentWallet(bankAgentId),
            "CreditRiskOracle: agent cannot self-approve"
        );

        req.status = Status.Approved;
        onboardingRegistry.setPhaseComplete(req.flowId, onboardingRegistry.PHASE_CREDIT_APPROVED());
        emit CreditApproved(requestId, req.flowId, bankAgentId, block.timestamp);
    }

    /**
     * @notice Credit rejected — bank human approver rejects; terminates onboarding flow.
     */
    function reject(bytes32 requestId, uint256 bankAgentId, bytes calldata reason) external {
        CreditRequest storage req = _requests[requestId];
        require(req.createdAt != 0, "request does not exist");
        require(req.bankAgentId == bankAgentId, "wrong agent");
        require(
            req.status == Status.InHumanReview || req.status == Status.Escalated,
            "must be InHumanReview or Escalated"
        );
        require(onboardingRegistry.isActive(req.flowId), "flow terminated");
        require(
            msg.sender != identityRegistry.getAgentWallet(bankAgentId),
            "CreditRiskOracle: agent cannot self-reject"
        );

        req.status = Status.Rejected;
        onboardingRegistry.terminate(req.flowId, reason);
        emit CreditRejected(requestId, req.flowId, reason, bankAgentId, block.timestamp);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getRequest(bytes32 requestId) external view returns (CreditRequest memory) {
        return _requests[requestId];
    }

    function getStatus(bytes32 requestId) external view returns (Status) {
        return _requests[requestId].status;
    }
}
