// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title IPromptRegistry
 * @notice Minimal interface consumed by oracle contracts to verify that the
 *         prompt template used by a bridge is the currently active (approved)
 *         version for a given capability.
 */
interface IPromptRegistry {
    /**
     * @notice Returns true if `templateHash` is the currently active prompt
     *         for `capability`, or if no active prompt is configured for that
     *         capability (opt-in).
     */
    function isActive(bytes32 capability, bytes32 templateHash) external view returns (bool);
}
