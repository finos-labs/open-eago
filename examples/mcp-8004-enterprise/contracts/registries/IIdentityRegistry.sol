// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IIdentityRegistry
 * @notice Minimal interface for ERC-8004 IdentityRegistryUpgradeable consumed by oracle contracts.
 *
 * Oracle contracts use this interface to:
 *   1. Verify that a caller's address matches the agentWallet registered for a given agentId.
 *   2. Verify that this oracle contract's address matches the oracleAddress registered for a given agentId.
 *
 * This keeps oracle contracts loosely coupled — they depend only on this interface,
 * not on the full upgradeable implementation.
 */
interface IIdentityRegistry {
    /**
     * @notice Returns the verified signing wallet for an agent.
     * @param agentId The agent token ID.
     * @return The registered agentWallet address, or address(0) if unset.
     */
    function getAgentWallet(uint256 agentId) external view returns (address);

    /**
     * @notice Returns the oracle contract bound to an agent identity.
     * @param agentId The agent token ID.
     * @return The bound oracle address, or address(0) if unset.
     */
    function getOracleAddress(uint256 agentId) external view returns (address);

    /**
     * @notice Returns arbitrary metadata stored for an agent.
     * @param agentId     The agent token ID.
     * @param metadataKey The metadata key (e.g. "capability").
     * @return Raw bytes value.
     */
    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory);

    /**
     * @notice Returns the keccak256 hash of the agent card committed at deploy time.
     * @param agentId The agent token ID.
     * @return The committed card hash, or bytes32(0) if unset.
     */
    function getCardHash(uint256 agentId) external view returns (bytes32);

    /**
     * @notice Returns the owner of the agent NFT.
     */
    function ownerOf(uint256 agentId) external view returns (address);
}

