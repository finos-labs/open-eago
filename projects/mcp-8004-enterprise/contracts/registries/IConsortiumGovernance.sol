// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IConsortiumGovernance
 * @notice Minimal interface consumed by oracle contracts and bridges that need
 *         to check whether cross-bank flows are paused.
 */
interface IConsortiumGovernance {
    /// @notice Returns true when the emergency cross-bank pause is active.
    function crossBankPaused() external view returns (bool);

    /// @notice Returns true when the given participantId is an active member.
    function isMember(bytes32 participantId) external view returns (bool);
}
