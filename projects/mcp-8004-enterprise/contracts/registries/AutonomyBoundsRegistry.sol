// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IAutonomyBoundsRegistry.sol";

/**
 * @title AutonomyBoundsRegistry
 * @notice Tracks per-tool enabled/disabled state for agents.
 *
 * A trusted off-chain monitor (bounds-monitor.js) watches oracle fulfillment
 * events and computes sliding-window error/success rates against thresholds
 * declared in each tool's MCP spec `autonomy_bounds` block.  When a threshold
 * is breached the monitor calls disableTool(); when signals recover it calls
 * enableTool().  Oracle contracts check isToolEnabled() before accepting a
 * fulfillment transaction.
 *
 * Access model:
 *   - owner   : contract deployer; can set/replace the monitor address.
 *   - monitor : trusted off-chain process; can call disableTool / enableTool.
 *
 * toolHash = keccak256(bytes(toolName)) — consistent with ReputationGate's
 * capability hash convention.
 */
contract AutonomyBoundsRegistry is IAutonomyBoundsRegistry {

    struct ToolState {
        bool    enabled;
        string  disabledReason;
        uint256 disabledAt;
    }

    address public owner;
    address public monitor;

    // agentId → toolHash → ToolState
    mapping(uint256 => mapping(bytes32 => ToolState)) private _state;

    event ToolDisabled(uint256 indexed agentId, bytes32 indexed toolHash, string reason, uint256 timestamp);
    event ToolEnabled(uint256 indexed agentId, bytes32 indexed toolHash, uint256 timestamp);
    event MonitorSet(address indexed monitor);

    modifier onlyOwner()   { require(msg.sender == owner,   "not owner");   _; }
    modifier onlyMonitor() { require(msg.sender == monitor, "not monitor"); _; }

    constructor() {
        owner = msg.sender;
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function setMonitor(address monitor_) external onlyOwner {
        monitor = monitor_;
        emit MonitorSet(monitor_);
    }

    // ── Monitor writes ────────────────────────────────────────────────────────

    function disableTool(uint256 agentId, bytes32 toolHash, string calldata reason)
        external onlyMonitor
    {
        _state[agentId][toolHash] = ToolState({ enabled: false, disabledReason: reason, disabledAt: block.timestamp });
        emit ToolDisabled(agentId, toolHash, reason, block.timestamp);
    }

    function enableTool(uint256 agentId, bytes32 toolHash) external onlyMonitor {
        ToolState storage s = _state[agentId][toolHash];
        s.enabled        = true;
        s.disabledReason = '';
        s.disabledAt     = 0;
        emit ToolEnabled(agentId, toolHash, block.timestamp);
    }

    // ── Reads ─────────────────────────────────────────────────────────────────

    /**
     * @notice Returns true if the tool is enabled (or has never been disabled).
     *         Tools start enabled by default — only an explicit disableTool()
     *         call makes this return false.
     */
    function isToolEnabled(uint256 agentId, bytes32 toolHash)
        external view override returns (bool)
    {
        ToolState storage s = _state[agentId][toolHash];
        // Default (zero struct): enabled field is false, but we treat never-set
        // as enabled.  disabledAt == 0 means it was never disabled.
        if (s.disabledAt == 0) return true;
        return s.enabled;
    }

    function getToolState(uint256 agentId, bytes32 toolHash)
        external view returns (bool enabled, string memory disabledReason, uint256 disabledAt)
    {
        ToolState storage s = _state[agentId][toolHash];
        if (s.disabledAt == 0) return (true, '', 0);
        return (s.enabled, s.disabledReason, s.disabledAt);
    }
}
