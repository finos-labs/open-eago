// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ExecutionTraceLog
 * @notice Shared on-chain audit trail for distributed agent execution chains.
 *
 * Every oracle contract calls `recordHop()` during request and fulfillment to
 * produce a single, queryable trace of all hops in an execution chain, keyed
 * by a `bytes32 traceId` that is born once and propagated through every hop.
 *
 * This is the on-chain equivalent of OpenTelemetry's trace concept, applied
 * to an on-chain/off-chain oracle bridge system.
 *
 * Flow-level anomaly policies (Concept 8):
 *   - loopDetectionEnabled: reverts if the same (oracle, agentId, action) triple
 *     appears more than once in a trace.
 *   - maxHopsPerTrace: reverts if a trace accumulates more hops than the limit.
 *   Both default to disabled (0 / false) and are configured by the owner.
 */
contract ExecutionTraceLog {

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    struct Hop {
        address oracle;        // which oracle contract recorded this hop
        uint256 agentId;       // which registered agent performed the action
        string  action;        // "reviewRequested", "reviewFulfilled", etc.
        uint256 timestamp;
    }

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    /// traceId → ordered list of hops
    mapping(bytes32 => Hop[]) private _traces;

    address public owner;

    /// 0 = disabled (no limit)
    uint256 public maxHopsPerTrace;

    /// false = disabled (no loop detection)
    bool public loopDetectionEnabled;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event HopRecorded(
        bytes32 indexed traceId,
        address indexed oracle,
        uint256 indexed agentId,
        string  action,
        uint256 timestamp
    );

    event MaxHopsSet(uint256 max);
    event LoopDetectionSet(bool enabled);

    // -------------------------------------------------------------------------
    // Access control
    // -------------------------------------------------------------------------

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // -------------------------------------------------------------------------
    // Policy configuration
    // -------------------------------------------------------------------------

    /**
     * @notice Set the maximum number of hops allowed per trace. 0 = disabled.
     */
    function setMaxHops(uint256 max_) external onlyOwner {
        maxHopsPerTrace = max_;
        emit MaxHopsSet(max_);
    }

    /**
     * @notice Enable or disable loop detection.
     */
    function setLoopDetection(bool enabled_) external onlyOwner {
        loopDetectionEnabled = enabled_;
        emit LoopDetectionSet(enabled_);
    }

    // -------------------------------------------------------------------------
    // Core
    // -------------------------------------------------------------------------

    /**
     * @notice Record a hop in an execution trace.
     * @dev    `msg.sender` is stored as the oracle — only oracle contracts should call this.
     *         Reverts if loop detection is on and the same (oracle, agentId, action) has been
     *         seen before in this trace, or if the hop count would exceed maxHopsPerTrace.
     * @param traceId The execution chain correlation token.
     * @param agentId The ERC-8004 agentId of the agent performing this action.
     * @param action  Human-readable action label (e.g. "reviewRequested").
     */
    function recordHop(
        bytes32 traceId,
        uint256 agentId,
        string calldata action
    ) external {
        if (loopDetectionEnabled) {
            Hop[] storage hops = _traces[traceId];
            bytes32 actionHash = keccak256(bytes(action));
            for (uint256 i; i < hops.length; i++) {
                if (hops[i].oracle == msg.sender &&
                    hops[i].agentId == agentId &&
                    keccak256(bytes(hops[i].action)) == actionHash) {
                    revert("loop detected");
                }
            }
        }
        if (maxHopsPerTrace > 0 && _traces[traceId].length >= maxHopsPerTrace) {
            revert("max hops exceeded");
        }
        _traces[traceId].push(Hop({
            oracle:    msg.sender,
            agentId:   agentId,
            action:    action,
            timestamp: block.timestamp
        }));
        emit HopRecorded(traceId, msg.sender, agentId, action, block.timestamp);
    }

    // -------------------------------------------------------------------------
    // Queries
    // -------------------------------------------------------------------------

    /**
     * @notice Returns the full ordered trace for a given traceId.
     */
    function getTrace(bytes32 traceId) external view returns (Hop[] memory) {
        return _traces[traceId];
    }

    /**
     * @notice Returns the number of hops recorded for a given traceId.
     */
    function getHopCount(bytes32 traceId) external view returns (uint256) {
        return _traces[traceId].length;
    }
}
