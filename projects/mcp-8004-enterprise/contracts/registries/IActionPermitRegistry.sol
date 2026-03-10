// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IActionPermitRegistry
 * @notice Minimal interface consumed by oracle contracts to gate fulfillment
 *         on per-action, per-flow permits.
 *
 * Oracle contracts call validateAction() inside every fulfillment function.
 * Setting actionPermitRegistry to address(0) disables the layer with no
 * gas overhead beyond a single ISZERO check.
 */
interface IActionPermitRegistry {
    /**
     * @notice Returns true if the agent holds a valid approved permit for the
     *         given action within the given flow.
     *
     * @dev Tier 3 patterns always return false regardless of any permit.
     *      Tier 0 patterns (read-only) return true unconditionally.
     *      Unregistered patterns return true (opt-in; no restriction declared).
     *      Tier 1/2 patterns require an explicit, approved ActionPermit.
     *
     * @param flowId     The traceId of the enclosing flow.
     * @param agentId    The ERC-8004 agentId of the acting agent.
     * @param actionType keccak256 of the canonical action identifier
     *                   (e.g. keccak256("review_pr"), keccak256("SQL:DROP")).
     */
    function validateAction(bytes32 flowId, uint256 agentId, bytes32 actionType)
        external view returns (bool);
}