// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IAutonomyBoundsRegistry
 * @notice Minimal interface consumed by oracle contracts to gate fulfillment on
 *         per-tool autonomy bounds.
 *
 * The off-chain bounds-monitor writes state here when anomaly or performance
 * signals exceed thresholds declared in the MCP spec's autonomy_bounds block.
 * Oracle contracts call isToolEnabled() inside every fulfillment function.
 */
interface IAutonomyBoundsRegistry {
    /**
     * @notice Returns true if the named tool is currently enabled for the agent.
     *
     * @param agentId  The ERC-8004 agentId of the fulfilling agent.
     * @param toolHash keccak256(bytes(toolName)) — e.g. keccak256("review_pr").
     */
    function isToolEnabled(uint256 agentId, bytes32 toolHash) external view returns (bool);
}
