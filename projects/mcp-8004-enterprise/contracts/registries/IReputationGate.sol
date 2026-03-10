// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IReputationGate
 * @notice Minimal interface consumed by oracle contracts to gate fulfillment on
 *         per-capability reputation thresholds.
 *
 * Oracle contracts call meetsThreshold() inside every fulfillment function.
 * Returns true when no threshold is configured for the capability (opt-in mode).
 */
interface IReputationGate {
    /**
     * @notice Returns true if the agent's reputation meets the configured threshold
     *         for the given capability.
     *
     * @dev Returns true when no threshold exists for the capability (opt-in),
     *      or when no evaluators are configured.
     *
     * @param agentId    The ERC-8004 agentId of the fulfilling agent.
     * @param capability keccak256 of the MCP tool name (e.g. keccak256("review_code")).
     */
    function meetsThreshold(uint256 agentId, bytes32 capability) external view returns (bool);
}
