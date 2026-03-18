// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IParticipantRegistry
 * @notice Interface consumed by IdentityRegistryUpgradeable (minting gate) and
 *         oracle contracts (Tier 2 approver checks).
 *
 * ParticipantType distinguishes banks from institutional clients.
 * DeploymentTier drives bridge placement: BANK_INTERNAL bridges submit txs only;
 * BANK_EXTERNAL and CLIENT_EXTERNAL bridges are bidirectional (event subscription
 * + tx submission) and are deployed in the external DMZ tier.
 */
interface IParticipantRegistry {

    enum ParticipantType { BANK, CLIENT }
    enum DeploymentTier  { BANK_INTERNAL, BANK_EXTERNAL, CLIENT_EXTERNAL }

    /// @notice Returns true if `minter` is an approved minting address for an
    ///         active participant. Used by IdentityRegistryUpgradeable.register().
    function isApprovedMinter(address minter) external view returns (bool);

    /// @notice Returns the participantId for the participant that owns `minter`,
    ///         or bytes32(0) if the address is not a registered minter.
    function getMinterParticipantId(address minter) external view returns (bytes32);

    /// @notice Returns true if `addr` is a registered standard Tier 2 approver
    ///         for any active participant.
    function isApprover(address addr) external view returns (bool);

    /// @notice Returns true if `addr` is a registered senior approver (escalation
    ///         path) for any active participant.
    function isSeniorApprover(address addr) external view returns (bool);

    /// @notice Returns the ParticipantType for the given participantId.
    function getParticipantType(bytes32 participantId) external view returns (ParticipantType);

    /// @notice Returns the default DeploymentTier for agents minted by this participant.
    function getDeploymentTier(bytes32 participantId) external view returns (DeploymentTier);

    /// @notice Returns true if the participant is active (not deactivated).
    function isActive(bytes32 participantId) external view returns (bool);
}
