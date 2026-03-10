// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IFlowAuthorizationRegistry.sol";
import "./IIdentityRegistry.sol";
import "./IParticipantRegistry.sol";

/**
 * @title FlowAuthorizationRegistry
 * @notice Per-flow authorization policy registry for ERC-8004 agent workflows.
 *
 * When a flow is initiated, the orchestrator calls createFlow() to declare
 * the flow exists. Each institution then independently consents for its own
 * agents via authorizeAgentForFlow() — enforcing bilateral participation in
 * cross-bank workflows (P2 control).
 *
 * Opt-in enforcement: if no policy exists for a traceId, isAuthorized() returns
 * true so that existing flows without a registered policy are unaffected.
 *
 * Bilateral consent: if governance contracts are configured, authorizeAgentForFlow()
 * verifies that the caller belongs to the same institution as the agent (via
 * ParticipantRegistry + IdentityRegistry "participantId" metadata).
 *
 * Immutability: once a flow policy is created it cannot be modified or deleted,
 * making it a permanent on-chain audit record of who was authorized to act.
 */
contract FlowAuthorizationRegistry is IFlowAuthorizationRegistry {

    // ── Well-known capability identifiers ────────────────────────────────────────
    // keccak256 of the MCP tool name string — mirrors agents/mcp/*.mcp.json tool names.

    bytes32 public constant CAP_REVIEW_CODE = keccak256("review_code");
    bytes32 public constant CAP_APPROVE_PR  = keccak256("approve_pr");

    // ── Governance references (optional — address(0) = unrestricted) ─────────────

    address public owner;
    IIdentityRegistry    private _identityRegistry;
    IParticipantRegistry private _participantRegistry;

    // ── Types ────────────────────────────────────────────────────────────────────

    struct FlowPolicy {
        address initiator;
        uint256 createdAt;
        bool    exists;
    }

    /// @notice Input type for createFlow — one entry per authorized agent.
    struct AgentAuthorization {
        uint256   agentId;
        bytes32[] capabilities;
    }

    // ── Storage ──────────────────────────────────────────────────────────────────

    /// traceId → policy metadata
    mapping(bytes32 => FlowPolicy) private _policies;

    /// traceId → agentId → capability → authorized
    mapping(bytes32 => mapping(uint256 => mapping(bytes32 => bool))) private _grants;

    /// traceId → ordered list of authorized agentIds (for enumeration / audit)
    mapping(bytes32 => uint256[]) private _authorizedAgents;

    // ── Events ───────────────────────────────────────────────────────────────────

    event GovernanceConfigured(address identityRegistry, address participantRegistry);

    event FlowCreated(
        bytes32 indexed traceId,
        address indexed initiator,
        uint256 timestamp
    );

    event AgentCapabilityGranted(
        bytes32 indexed traceId,
        uint256 indexed agentId,
        bytes32 indexed capability
    );

    event AgentFlowConsentGranted(
        bytes32 indexed flowId,
        uint256 indexed agentId,
        bytes32         participantId
    );

    // ── Constructor ──────────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
    }

    /**
     * @notice Configure the optional governance references.
     *         When set, authorizeAgentForFlow() enforces institutional ownership.
     *         When left unset (address(0)), bilateral consent is not enforced.
     * @param identityRegistry_    IIdentityRegistry for agent metadata lookups.
     * @param participantRegistry_ IParticipantRegistry for minter → participantId.
     */
    function setGovernanceContracts(
        address identityRegistry_,
        address participantRegistry_
    ) external {
        require(msg.sender == owner, "not owner");
        _identityRegistry    = IIdentityRegistry(identityRegistry_);
        _participantRegistry = IParticipantRegistry(participantRegistry_);
        emit GovernanceConfigured(identityRegistry_, participantRegistry_);
    }

    // ── Core ─────────────────────────────────────────────────────────────────────

    /**
     * @notice Register the authorization policy for a new flow.
     *
     * @param traceId        The correlation token for this flow (must be non-zero
     *                       and not previously registered).
     * @param authorizations One entry per agent: the agentId and the set of
     *                       capability hashes it is permitted to exercise.
     *
     * Emits FlowCreated and one AgentCapabilityGranted per (agentId, capability) pair.
     */
    function createFlow(
        bytes32               traceId,
        AgentAuthorization[] calldata authorizations
    ) external {
        require(traceId != bytes32(0), "zero traceId");
        require(!_policies[traceId].exists, "flow already exists");

        _policies[traceId] = FlowPolicy(msg.sender, block.timestamp, true);
        emit FlowCreated(traceId, msg.sender, block.timestamp);

        for (uint256 i; i < authorizations.length; i++) {
            uint256 agentId = authorizations[i].agentId;
            _authorizedAgents[traceId].push(agentId);

            bytes32[] calldata caps = authorizations[i].capabilities;
            for (uint256 j; j < caps.length; j++) {
                _grants[traceId][agentId][caps[j]] = true;
                emit AgentCapabilityGranted(traceId, agentId, caps[j]);
            }
        }
    }

    /**
     * @notice Consent to an agent participating in an existing flow.
     *
     * In cross-bank deployments each institution calls this for its own agents.
     * If governance contracts are configured:
     *   - The caller must be a registered minter (in ParticipantRegistry).
     *   - The caller's participantId must match the "participantId" metadata
     *     stored on the agent in IdentityRegistry.
     *
     * @param flowId       The flow to authorize participation in (must exist).
     * @param agentId      The agent being authorized.
     * @param capabilities The capability hashes the agent is permitted to exercise.
     */
    function authorizeAgentForFlow(
        bytes32   flowId,
        uint256   agentId,
        bytes32[] calldata capabilities
    ) external {
        require(_policies[flowId].exists, "flow does not exist");

        bytes32 callerParticipantId;
        if (address(_participantRegistry) != address(0)) {
            callerParticipantId = _participantRegistry.getMinterParticipantId(msg.sender);
            require(callerParticipantId != bytes32(0), "caller is not a registered minter");

            if (address(_identityRegistry) != address(0)) {
                bytes memory agentPidBytes = _identityRegistry.getMetadata(agentId, "participantId");
                if (agentPidBytes.length == 32) {
                    bytes32 agentParticipantId = abi.decode(agentPidBytes, (bytes32));
                    require(
                        callerParticipantId == agentParticipantId,
                        "caller not from agent's institution"
                    );
                }
            }
        }

        _authorizedAgents[flowId].push(agentId);
        for (uint256 j; j < capabilities.length; j++) {
            _grants[flowId][agentId][capabilities[j]] = true;
            emit AgentCapabilityGranted(flowId, agentId, capabilities[j]);
        }
        emit AgentFlowConsentGranted(flowId, agentId, callerParticipantId);
    }

    /**
     * @notice Check whether an agent is authorized to exercise a capability
     *         within the specified flow.
     *
     * @dev Returns true when no policy exists for the traceId so that flows
     *      that were not registered continue to work unchanged (opt-in).
     */
    function isAuthorized(bytes32 traceId, uint256 agentId, bytes32 capability)
        external view override returns (bool)
    {
        if (!_policies[traceId].exists) return true;
        return _grants[traceId][agentId][capability];
    }

    /**
     * @notice Returns true if a flow policy has been registered for the traceId.
     */
    function flowExists(bytes32 traceId) external view returns (bool) {
        return _policies[traceId].exists;
    }

    /**
     * @notice Returns the policy metadata and the ordered list of authorized
     *         agentIds for a flow.
     */
    function getFlowPolicy(bytes32 traceId)
        external view
        returns (address initiator, uint256 createdAt, uint256[] memory agentIds)
    {
        FlowPolicy storage p = _policies[traceId];
        return (p.initiator, p.createdAt, _authorizedAgents[traceId]);
    }
}