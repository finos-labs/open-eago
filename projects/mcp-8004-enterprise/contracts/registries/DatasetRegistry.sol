// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IDatasetRegistry.sol";

/**
 * @title DatasetRegistry
 * @notice Two-tier dataset governance for the ERC-8004/MCP stack.
 *
 * Tier 1 (global): owner registers datasets into a capability-keyed catalogue and
 *   marks them globally approved. Revocation re-evaluates whether any remain approved.
 *
 * Tier 2 (per-flow): the flow initiator calls approveForFlow() to declare which
 *   catalogue entries are allowed within a specific traceId. Immutable once set.
 *
 * isApproved() is fully opt-in: with no configuration it always returns true.
 */
contract DatasetRegistry is IDatasetRegistry {

    struct DatasetEntry {
        string  metadataUri;     // IPFS CID, git path, or URL
        uint256 registeredAt;
        bool    globallyApproved;
    }

    address public owner;

    // capability → contentHash → entry (global catalogue)
    mapping(bytes32 => mapping(bytes32 => DatasetEntry)) private _catalogue;
    // capability → ordered list of content hashes (for enumeration)
    mapping(bytes32 => bytes32[]) private _datasetList;
    // capability → at least one dataset globally approved
    mapping(bytes32 => bool) private _hasGlobalApproved;
    // flat index: is this hash registered under any capability?
    mapping(bytes32 => bool) private _anyRegistered;

    // traceId → contentHash → allowed (per-flow allowlist)
    mapping(bytes32 => mapping(bytes32 => bool)) private _flowApproved;
    // traceId → flow policy exists (immutable once set)
    mapping(bytes32 => bool) private _hasFlowPolicy;
    // traceId → list of approved hashes (for enumeration)
    mapping(bytes32 => bytes32[]) private _flowDatasetList;

    event DatasetRegistered(bytes32 indexed capability, bytes32 indexed contentHash, string metadataUri);
    event DatasetApproved(bytes32 indexed capability, bytes32 indexed contentHash);
    event DatasetRevoked(bytes32 indexed capability, bytes32 indexed contentHash);
    event FlowDatasetsApproved(bytes32 indexed traceId, bytes32[] contentHashes);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor() { owner = msg.sender; }

    // ── Owner-only: global catalogue management ───────────────────────────────

    /**
     * @notice Register a dataset in the global catalogue under a capability.
     * @dev Reverts on zero hash or duplicate registration.
     */
    function registerDataset(bytes32 capability, bytes32 contentHash, string calldata metadataUri)
        external onlyOwner
    {
        require(contentHash != bytes32(0), "zero contentHash");
        require(_catalogue[capability][contentHash].registeredAt == 0, "already registered");
        _catalogue[capability][contentHash] = DatasetEntry(metadataUri, block.timestamp, false);
        _datasetList[capability].push(contentHash);
        _anyRegistered[contentHash] = true;
        emit DatasetRegistered(capability, contentHash, metadataUri);
    }

    /**
     * @notice Mark a registered dataset as globally approved for a capability.
     * @dev Reverts if not registered. Sets _hasGlobalApproved flag for the capability.
     */
    function approveGlobally(bytes32 capability, bytes32 contentHash) external onlyOwner {
        require(_catalogue[capability][contentHash].registeredAt != 0, "not registered");
        _catalogue[capability][contentHash].globallyApproved = true;
        _hasGlobalApproved[capability] = true;
        emit DatasetApproved(capability, contentHash);
    }

    /**
     * @notice Revoke global approval for a dataset.
     * @dev If no datasets remain approved for the capability, clears _hasGlobalApproved
     *   so the capability returns to opt-in (all hashes pass).
     */
    function revokeGlobal(bytes32 capability, bytes32 contentHash) external onlyOwner {
        require(_catalogue[capability][contentHash].globallyApproved, "not approved");
        _catalogue[capability][contentHash].globallyApproved = false;
        emit DatasetRevoked(capability, contentHash);
        // Re-check whether any datasets remain globally approved for this capability.
        bytes32[] storage list = _datasetList[capability];
        for (uint256 i; i < list.length; i++) {
            if (_catalogue[capability][list[i]].globallyApproved) return;
        }
        _hasGlobalApproved[capability] = false;
    }

    // ── Anyone (flow initiator): per-flow allowlist ───────────────────────────

    /**
     * @notice Declare which datasets are allowed within a specific flow.
     * @dev Reverts on zero traceId, duplicate call, or any hash not in the catalogue.
     *   Immutable once set.
     */
    function approveForFlow(bytes32 traceId, bytes32[] calldata contentHashes) external {
        require(traceId != bytes32(0), "zero traceId");
        require(!_hasFlowPolicy[traceId], "flow policy already set");
        for (uint256 i; i < contentHashes.length; i++) {
            bytes32 h = contentHashes[i];
            require(_anyRegistered[h], "not in catalogue");
            _flowApproved[traceId][h] = true;
            _flowDatasetList[traceId].push(h);
        }
        _hasFlowPolicy[traceId] = true;
        emit FlowDatasetsApproved(traceId, contentHashes);
    }

    // ── IDatasetRegistry ──────────────────────────────────────────────────────

    /**
     * @inheritdoc IDatasetRegistry
     */
    function isApproved(bytes32 traceId, bytes32 capability, bytes32 contentHash)
        external view returns (bool)
    {
        bool globalOk = !_hasGlobalApproved[capability]
            || _catalogue[capability][contentHash].globallyApproved;
        bool flowOk = !_hasFlowPolicy[traceId]
            || _flowApproved[traceId][contentHash];
        return globalOk && flowOk;
    }

    // ── View helpers ──────────────────────────────────────────────────────────

    function isRegistered(bytes32 capability, bytes32 contentHash) external view returns (bool) {
        return _catalogue[capability][contentHash].registeredAt != 0;
    }

    function getDatasets(bytes32 capability) external view returns (bytes32[] memory) {
        return _datasetList[capability];
    }

    function getDatasetInfo(bytes32 capability, bytes32 contentHash)
        external view
        returns (string memory metadataUri, uint256 registeredAt, bool globallyApproved)
    {
        DatasetEntry storage e = _catalogue[capability][contentHash];
        return (e.metadataUri, e.registeredAt, e.globallyApproved);
    }

    function getFlowDatasets(bytes32 traceId) external view returns (bytes32[] memory) {
        return _flowDatasetList[traceId];
    }

    function flowPolicyExists(bytes32 traceId) external view returns (bool) {
        return _hasFlowPolicy[traceId];
    }
}
