// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IFlowAuthorizationRegistry
 * @notice Minimal interface consumed by oracle contracts to gate fulfillment
 *         on per-flow agent authorization policies.
 *
 * Oracle contracts call isAuthorized() in every fulfillment function.
 * If no policy has been registered for the traceId (opt-in mode), the
 * function returns true so that existing unmanaged flows are unaffected.
 */
interface IFlowAuthorizationRegistry {
    /**
     * @notice Returns true if the agent is authorized to exercise the given
     *         capability within the specified flow.
     * @dev    Returns true when no policy exists for the traceId (opt-in).
     * @param traceId    The execution chain correlation token.
     * @param agentId    The ERC-8004 agentId of the fulfilling agent.
     * @param capability keccak256 of the MCP tool name (e.g. keccak256("review_code")).
     */
    function isAuthorized(bytes32 traceId, uint256 agentId, bytes32 capability)
        external view returns (bool);
}