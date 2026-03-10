// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IReputationRegistry
 * @notice Minimal interface for ReputationGate to call getSummary() on the
 *         ReputationRegistryUpgradeable without importing the full implementation.
 *
 * @dev clientAddresses must be non-empty — the registry reverts if the array is
 *      empty. ReputationGate guards against this by checking evaluator count first.
 */
interface IReputationRegistry {
    /**
     * @notice Returns the aggregate reputation score for an agent across a set of
     *         client addresses, optionally filtered by feedback tags.
     *
     * @param agentId          The ERC-8004 agentId to query.
     * @param clientAddresses  Non-empty list of evaluator addresses whose feedback counts.
     * @param tag1             First tag filter; empty string means any tag.
     * @param tag2             Second tag filter; empty string means any tag.
     *
     * @return count                  Number of non-revoked feedback entries matched.
     * @return summaryValue           Average score at mode decimal precision.
     * @return summaryValueDecimals   Decimal precision of summaryValue (0–18).
     */
    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
}
