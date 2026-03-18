// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title OnboardingRegistry
 * @notice Central state machine for institutional client onboarding flows.
 *
 * Owns the phase bitmask that tracks progress through six sub-flow phases:
 *   AML cleared → Credit approved → Legal executed →
 *   Legal entity setup → Account setup → Product setup → ReadyToTransact
 *
 * Sub-flow oracle contracts call setPhaseComplete() as each phase finishes.
 * Any oracle can call terminate() on rejection — this sets an absorbing terminal
 * state that blocks all other sub-flow oracles via onlyActiveFlow().
 *
 * Access control: only addresses registered as sub-flow oracles may call
 * setPhaseComplete() or terminate(). Registered via setOracle() by the owner.
 *
 * Opt-in: oracle contracts check isActive(flowId) before processing actions.
 * If OnboardingRegistry is not configured (address(0) in oracle), the check
 * is skipped so governance tests work without a full registry deployment.
 */
contract OnboardingRegistry is Ownable {

    // ── Phase bitmask constants ───────────────────────────────────────────────

    uint8 public constant PHASE_AML_CLEARED        = 0x01;
    uint8 public constant PHASE_CREDIT_APPROVED    = 0x02;
    uint8 public constant PHASE_LEGAL_EXECUTED     = 0x04;
    uint8 public constant PHASE_ENTITY_SETUP_DONE  = 0x08;
    uint8 public constant PHASE_ACCOUNT_SETUP_DONE = 0x10;
    uint8 public constant PHASE_PRODUCT_SETUP_DONE = 0x20;

    uint8 public constant ALL_REVIEWS_DONE = PHASE_AML_CLEARED | PHASE_CREDIT_APPROVED | PHASE_LEGAL_EXECUTED;
    uint8 public constant ALL_PHASES_DONE  = 0x3F;

    // ── Types ─────────────────────────────────────────────────────────────────

    struct OnboardingFlow {
        address initiator;
        uint8   phaseBitmask;
        bool    terminated;
        bytes   terminationReason;
        uint256 createdAt;
    }

    // ── Storage ───────────────────────────────────────────────────────────────

    /// flowId → flow state
    mapping(bytes32 => OnboardingFlow) private _flows;

    /// addresses permitted to call setPhaseComplete() and terminate()
    mapping(address => bool) private _oracles;

    // ── Events ────────────────────────────────────────────────────────────────

    event OnboardingInitiated(bytes32 indexed flowId, address indexed clientInitiator, uint256 timestamp);
    event PhaseCompleted(bytes32 indexed flowId, uint8 indexed phase, uint256 timestamp);
    event OnboardingTerminated(bytes32 indexed flowId, bytes reason, uint256 timestamp);
    event ReadyToTransact(bytes32 indexed flowId, address indexed clientInitiator, uint256 timestamp);
    event OracleSet(address indexed oracle, bool enabled);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ── Oracle registration ───────────────────────────────────────────────────

    function setOracle(address oracle, bool enabled) external onlyOwner {
        _oracles[oracle] = enabled;
        emit OracleSet(oracle, enabled);
    }

    function isOracle(address addr) external view returns (bool) {
        return _oracles[addr];
    }

    // ── Flow lifecycle ────────────────────────────────────────────────────────

    /**
     * @notice Initiate a new onboarding flow. Called by the bank's
     *         OnboardingOrchestrator bridge at flow start.
     * @param flowId   Unique flow identifier (bytes32 traceId).
     * @param initiator Address of the client institution initiating onboarding.
     */
    function initiateOnboarding(bytes32 flowId, address initiator) external {
        require(_oracles[msg.sender], "OnboardingRegistry: not an oracle");
        require(flowId != bytes32(0), "zero flowId");
        require(_flows[flowId].createdAt == 0, "flow already exists");

        _flows[flowId] = OnboardingFlow({
            initiator:         initiator,
            phaseBitmask:      0,
            terminated:        false,
            terminationReason: "",
            createdAt:         block.timestamp
        });
        emit OnboardingInitiated(flowId, initiator, block.timestamp);
    }

    /**
     * @notice Mark a phase as complete. Called by the sub-flow oracle that
     *         owns that phase (e.g. AMLOracle calls this with PHASE_AML_CLEARED).
     * @param flowId Flow to update.
     * @param phase  One of the PHASE_* bitmask constants.
     */
    function setPhaseComplete(bytes32 flowId, uint8 phase) external {
        require(_oracles[msg.sender], "OnboardingRegistry: not an oracle");
        OnboardingFlow storage flow = _flows[flowId];
        require(flow.createdAt != 0, "flow does not exist");
        require(!flow.terminated, "flow terminated");

        flow.phaseBitmask |= phase;
        emit PhaseCompleted(flowId, phase, block.timestamp);

        if (flow.phaseBitmask == ALL_PHASES_DONE) {
            emit ReadyToTransact(flowId, flow.initiator, block.timestamp);
        }
    }

    /**
     * @notice Terminate a flow on rejection. Sets an absorbing terminal state.
     *         All sub-flow oracles check isActive() before processing further
     *         actions, so this propagates automatically.
     * @param flowId Flow to terminate.
     * @param reason Human-readable reason (stored as bytes, e.g. ABI-encoded string).
     */
    function terminate(bytes32 flowId, bytes calldata reason) external {
        require(_oracles[msg.sender], "OnboardingRegistry: not an oracle");
        OnboardingFlow storage flow = _flows[flowId];
        require(flow.createdAt != 0, "flow does not exist");
        require(!flow.terminated, "already terminated");

        flow.terminated        = true;
        flow.terminationReason = reason;
        emit OnboardingTerminated(flowId, reason, block.timestamp);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function isActive(bytes32 flowId) external view returns (bool) {
        OnboardingFlow storage flow = _flows[flowId];
        return flow.createdAt != 0 && !flow.terminated;
    }

    function phaseBitmask(bytes32 flowId) external view returns (uint8) {
        return _flows[flowId].phaseBitmask;
    }

    function reviewsDone(bytes32 flowId) external view returns (bool) {
        return (_flows[flowId].phaseBitmask & ALL_REVIEWS_DONE) == ALL_REVIEWS_DONE;
    }

    function getFlow(bytes32 flowId) external view returns (
        address initiator,
        uint8   phases,
        bool    terminated,
        bytes memory terminationReason,
        uint256 createdAt
    ) {
        OnboardingFlow storage f = _flows[flowId];
        return (f.initiator, f.phaseBitmask, f.terminated, f.terminationReason, f.createdAt);
    }
}
