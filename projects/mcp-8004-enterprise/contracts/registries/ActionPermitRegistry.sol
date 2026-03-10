// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IActionPermitRegistry.sol";
import "./IParticipantRegistry.sol";

/**
 * @title ActionPermitRegistry
 * @notice Per-flow, per-agent, per-action authorization registry (Concept 10).
 *
 * Every tool invocation that reaches an external system is classified into one
 * of four tiers:
 *
 *   Tier 0  Read-only   — permitted by default if the agent holds flow authorization
 *   Tier 1  Reversible  — requires an explicit permit granted by the flow initiator
 *   Tier 2  Destructive — requires a permit AND multi-agent/human approval
 *   Tier 3  Forbidden   — never executable; hard block, no override
 *
 * Pattern catalogue (owner-managed):
 *   registerPattern(patternHash, tier) — maps a keccak256 action identifier
 *   to its default tier.  Tier 3 patterns are globally forbidden.
 *
 * Permit lifecycle (flow-scoped):
 *   grantPermit   — flow initiator declares an agent is permitted to perform an
 *                   action type within a specific flow.
 *   approveAction — one approver adds their signature to a Tier 2 permit.
 *   revokePermit  — flow initiator or owner removes a previously granted permit.
 *
 * Permits are keyed by keccak256(abi.encodePacked(flowId, agentId, actionType))
 * for O(1) lookup in validateAction.
 */
contract ActionPermitRegistry is IActionPermitRegistry {

    // ── Types ────────────────────────────────────────────────────────────────

    struct ActionPattern {
        uint8 tier;
        bool  registered;
    }

    struct ActionPermit {
        uint256 agentId;
        bytes32 flowId;
        bytes32 actionType;
        uint8   tier;
        bool    approved;
        uint256 approvalCount;
        uint256 requiredApprovals;
    }

    // ── Storage ──────────────────────────────────────────────────────────────

    address public owner;

    /// Optional ParticipantRegistry gate for Tier 2 approvals.
    /// address(0) = unrestricted (any EOA can approve).
    address private _participantRegistry;

    /// patternHash → ActionPattern
    mapping(bytes32 => ActionPattern) private _patterns;

    /// permitKey → ActionPermit
    /// permitKey = keccak256(abi.encodePacked(flowId, agentId, actionType))
    mapping(bytes32 => ActionPermit) private _permits;

    /// permitKey → approver address → has voted
    mapping(bytes32 => mapping(address => bool)) private _approvals;

    /// flowId → address that first called grantPermit for this flow
    mapping(bytes32 => address) private _flowInitiators;

    // ── Events ───────────────────────────────────────────────────────────────

    event ActionPatternRegistered(bytes32 indexed patternHash, uint8 tier);
    event ActionPermitGranted(bytes32 indexed flowId, uint256 indexed agentId, bytes32 actionType, uint8 tier);
    event ActionPermitApproved(bytes32 indexed flowId, uint256 indexed agentId, bytes32 actionType, address approver);
    event ActionPermitResolved(bytes32 indexed flowId, uint256 indexed agentId, bytes32 actionType, bool approved);
    event ActionPermitRevoked(bytes32 indexed flowId, uint256 indexed agentId, bytes32 actionType);
    event ParticipantRegistrySet(address indexed participantRegistry);

    // ── Access control ───────────────────────────────────────────────────────

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor() {
        owner = msg.sender;
    }

    /**
     * @notice Configure the optional ParticipantRegistry gate for approveAction.
     *         When set, only credentialed approvers (isApprover / isSeniorApprover)
     *         may add signatures to Tier 2 permits.
     *         Pass address(0) to disable the gate (unrestricted mode).
     */
    function setParticipantRegistry(address participantRegistry_) external onlyOwner {
        _participantRegistry = participantRegistry_;
        emit ParticipantRegistrySet(participantRegistry_);
    }

    function getParticipantRegistry() external view returns (address) {
        return _participantRegistry;
    }

    // ── Pattern catalogue ────────────────────────────────────────────────────

    /**
     * @notice Register a known action pattern with its default tier.
     *
     * @param patternHash keccak256 of the canonical action identifier string
     *                    (e.g. keccak256("SQL:DROP"), keccak256("review_pr")).
     * @param tier        0–3; Tier 3 means globally forbidden.
     *
     * Can be called repeatedly to update a pattern's tier.
     */
    function registerPattern(bytes32 patternHash, uint8 tier) external onlyOwner {
        require(patternHash != bytes32(0), "zero patternHash");
        require(tier <= 3, "invalid tier");
        _patterns[patternHash] = ActionPattern({ tier: tier, registered: true });
        emit ActionPatternRegistered(patternHash, tier);
    }

    function getPattern(bytes32 patternHash)
        external view returns (bool registered, uint8 tier)
    {
        ActionPattern storage p = _patterns[patternHash];
        return (p.registered, p.tier);
    }

    // ── Permit lifecycle ─────────────────────────────────────────────────────

    /**
     * @notice Grant an agent permission to perform a specific action type
     *         within a flow.
     *
     * The first caller for a given flowId becomes the flow initiator.
     * Subsequent calls for the same flowId require msg.sender == initiator.
     *
     * @param flowId            The traceId of the enclosing flow.
     * @param agentId           The ERC-8004 agentId of the acting agent.
     * @param actionType        keccak256 of the action identifier.
     * @param tier              The tier to enforce (must not be 3).
     * @param requiredApprovals Number of approvals needed before the permit is
     *                          resolved (only meaningful for Tier 2).
     */
    function grantPermit(
        bytes32 flowId,
        uint256 agentId,
        bytes32 actionType,
        uint8   tier,
        uint256 requiredApprovals
    ) external {
        require(flowId     != bytes32(0), "zero flowId");
        require(actionType != bytes32(0), "zero actionType");
        require(tier != 3, "tier 3 cannot be permitted");
        require(tier <= 3, "invalid tier");

        // Establish or verify flow initiator.
        if (_flowInitiators[flowId] == address(0)) {
            _flowInitiators[flowId] = msg.sender;
        } else {
            require(_flowInitiators[flowId] == msg.sender, "not flow initiator");
        }

        bytes32 key = _permitKey(flowId, agentId, actionType);
        require(_permits[key].flowId == bytes32(0), "permit already exists");

        // Tier 0 and Tier 1 with zero required approvals are immediately approved.
        bool immediatelyApproved = (tier < 2) || (requiredApprovals == 0);

        _permits[key] = ActionPermit({
            agentId:          agentId,
            flowId:           flowId,
            actionType:       actionType,
            tier:             tier,
            approved:         immediatelyApproved,
            approvalCount:    0,
            requiredApprovals: requiredApprovals
        });

        emit ActionPermitGranted(flowId, agentId, actionType, tier);
        if (immediatelyApproved) {
            emit ActionPermitResolved(flowId, agentId, actionType, true);
        }
    }

    /**
     * @notice Add an approval signature to a Tier 2 permit.
     *
     * When approvalCount reaches requiredApprovals the permit is marked
     * approved and ActionPermitResolved is emitted.
     */
    function approveAction(bytes32 flowId, uint256 agentId, bytes32 actionType) external {
        if (_participantRegistry != address(0)) {
            IParticipantRegistry pr = IParticipantRegistry(_participantRegistry);
            require(
                pr.isApprover(msg.sender) || pr.isSeniorApprover(msg.sender),
                "caller is not a credentialed approver"
            );
        }
        bytes32 key = _permitKey(flowId, agentId, actionType);
        ActionPermit storage permit = _permits[key];
        require(permit.flowId != bytes32(0), "permit not found");
        require(!permit.approved, "already approved");
        require(!_approvals[key][msg.sender], "already voted");

        _approvals[key][msg.sender] = true;
        permit.approvalCount += 1;
        emit ActionPermitApproved(flowId, agentId, actionType, msg.sender);

        if (permit.approvalCount >= permit.requiredApprovals) {
            permit.approved = true;
            emit ActionPermitResolved(flowId, agentId, actionType, true);
        }
    }

    /**
     * @notice Revoke a previously granted permit.
     *
     * Only the flow initiator or the contract owner may revoke.
     */
    function revokePermit(bytes32 flowId, uint256 agentId, bytes32 actionType) external {
        require(
            msg.sender == owner || msg.sender == _flowInitiators[flowId],
            "not authorized to revoke"
        );
        bytes32 key = _permitKey(flowId, agentId, actionType);
        require(_permits[key].flowId != bytes32(0), "permit not found");
        delete _permits[key];
        emit ActionPermitRevoked(flowId, agentId, actionType);
    }

    // ── Validation ────────────────────────────────────────────────────────────

    /**
     * @notice Returns true if the agent holds a valid approved permit for the
     *         given action within the given flow.
     *
     * Decision table (at most 3 SLOADs in the hot path):
     *   1. Pattern not registered  → true  (opt-in; no restriction declared)
     *   2. Pattern tier == 3       → false (globally forbidden)
     *   3. Pattern tier == 0       → true  (read-only; covered by FlowAuthorizationRegistry)
     *   4. Pattern tier == 1 or 2  → true only if an approved permit exists
     */
    function validateAction(bytes32 flowId, uint256 agentId, bytes32 actionType)
        external view override returns (bool)
    {
        ActionPattern storage pattern = _patterns[actionType];

        if (!pattern.registered) return true;   // opt-in default
        if (pattern.tier == 3)   return false;  // globally forbidden
        if (pattern.tier == 0)   return true;   // read-only; no explicit permit needed

        // Tier 1 or Tier 2: require an explicit, approved permit.
        bytes32 key = _permitKey(flowId, agentId, actionType);
        ActionPermit storage permit = _permits[key];
        if (permit.flowId == bytes32(0)) return false;
        return permit.approved;
    }

    // ── Reads ─────────────────────────────────────────────────────────────────

    function getPermit(bytes32 flowId, uint256 agentId, bytes32 actionType)
        external view
        returns (bool exists, uint8 tier, bool approved, uint256 approvalCount, uint256 requiredApprovals)
    {
        bytes32 key = _permitKey(flowId, agentId, actionType);
        ActionPermit storage p = _permits[key];
        if (p.flowId == bytes32(0)) return (false, 0, false, 0, 0);
        return (true, p.tier, p.approved, p.approvalCount, p.requiredApprovals);
    }

    function getFlowInitiator(bytes32 flowId) external view returns (address) {
        return _flowInitiators[flowId];
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _permitKey(bytes32 flowId, uint256 agentId, bytes32 actionType)
        internal pure returns (bytes32)
    {
        return keccak256(abi.encodePacked(flowId, agentId, actionType));
    }
}
