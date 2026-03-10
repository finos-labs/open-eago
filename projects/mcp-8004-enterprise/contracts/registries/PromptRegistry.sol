// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "./IPromptRegistry.sol";

/**
 * @title PromptRegistry
 * @notice On-chain registry of approved prompt template hashes, keyed by
 *         capability (bytes32).  Stores keccak256(templateText) per version;
 *         the full template text lives off-chain in the MCP spec files.
 *
 * Governance model
 * ────────────────
 * - Owner registers prompt versions with registerPrompt().
 * - Owner activates a version with setActiveVersion().
 * - isActive() returns true when no active version is configured (opt-in).
 * - Owner can deactivate() to restore opt-in behaviour without deleting history.
 * - Rollback is free: re-activate any previously registered version.
 *
 * Integration
 * ───────────
 * Oracle contracts call isActive(capability, hash) before accepting a
 * fulfillment.  The bridge computes hash = keccak256(templateText) at
 * startup from its local MCP spec file and includes it in every fulfillment.
 */
contract PromptRegistry is IPromptRegistry {

    // ── Storage ──────────────────────────────────────────────────────────────

    struct PromptVersion {
        bytes32 templateHash;
        string  metadataUri;   // optional: relative path, IPFS URI, etc.
        uint256 registeredAt;
    }

    address public owner;

    /// capability → ordered list of registered versions (index = version number)
    mapping(bytes32 => PromptVersion[]) private _versions;

    /// capability → currently active version index
    mapping(bytes32 => uint256) private _activeVersion;

    /// capability → whether an active version has been set
    mapping(bytes32 => bool) private _hasActive;

    // ── Events ───────────────────────────────────────────────────────────────

    event PromptRegistered(
        bytes32 indexed capability,
        uint256 indexed version,
        bytes32         templateHash,
        string          metadataUri
    );

    event PromptActivated(
        bytes32 indexed capability,
        uint256 indexed version,
        bytes32         templateHash
    );

    event PromptDeactivated(bytes32 indexed capability);

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
    }

    // ── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    // ── Owner-only configuration ─────────────────────────────────────────────

    /**
     * @notice Register a new prompt version for a capability.
     * @param capability   keccak256 of the capability name (e.g. keccak256("review_code"))
     * @param templateHash keccak256 of the raw template text (off-chain)
     * @param metadataUri  Optional pointer to the full text (path or IPFS URI)
     * @return version     The version index assigned to this registration
     */
    function registerPrompt(
        bytes32 capability,
        bytes32 templateHash,
        string calldata metadataUri
    ) external onlyOwner returns (uint256 version) {
        require(templateHash != bytes32(0), "templateHash required");
        version = _versions[capability].length;
        _versions[capability].push(PromptVersion({
            templateHash:  templateHash,
            metadataUri:   metadataUri,
            registeredAt:  block.timestamp
        }));
        emit PromptRegistered(capability, version, templateHash, metadataUri);
    }

    /**
     * @notice Activate a registered version for a capability.
     *         Only the active version's hash will pass isActive().
     */
    function setActiveVersion(bytes32 capability, uint256 version) external onlyOwner {
        require(version < _versions[capability].length, "version does not exist");
        _activeVersion[capability] = version;
        _hasActive[capability]    = true;
        emit PromptActivated(capability, version, _versions[capability][version].templateHash);
    }

    /**
     * @notice Remove the active version for a capability, restoring opt-in
     *         behaviour (isActive returns true for any hash).
     *         Does NOT delete version history — rollback remains possible.
     */
    function deactivate(bytes32 capability) external onlyOwner {
        require(_hasActive[capability], "no active version");
        _hasActive[capability] = false;
        emit PromptDeactivated(capability);
    }

    // ── View functions ────────────────────────────────────────────────────────

    /**
     * @notice Returns true if templateHash matches the active version for
     *         capability, or if no active version is configured (opt-in).
     */
    function isActive(bytes32 capability, bytes32 templateHash) external view override returns (bool) {
        if (!_hasActive[capability]) return true;
        return _versions[capability][_activeVersion[capability]].templateHash == templateHash;
    }

    /**
     * @notice Returns the currently active prompt for a capability.
     * @return version      Active version index
     * @return templateHash Hash of the active template
     * @return metadataUri  Metadata pointer stored with that version
     * @return active       False if no active version is configured
     */
    function getActivePrompt(bytes32 capability)
        external view
        returns (uint256 version, bytes32 templateHash, string memory metadataUri, bool active)
    {
        if (!_hasActive[capability]) return (0, bytes32(0), "", false);
        version = _activeVersion[capability];
        PromptVersion storage pv = _versions[capability][version];
        return (version, pv.templateHash, pv.metadataUri, true);
    }

    /**
     * @notice Returns the stored fields for a specific version.
     */
    function getPromptVersion(bytes32 capability, uint256 version)
        external view
        returns (bytes32 templateHash, string memory metadataUri, uint256 registeredAt)
    {
        require(version < _versions[capability].length, "version does not exist");
        PromptVersion storage pv = _versions[capability][version];
        return (pv.templateHash, pv.metadataUri, pv.registeredAt);
    }

    /**
     * @notice Returns the number of registered versions for a capability.
     */
    function getVersionCount(bytes32 capability) external view returns (uint256) {
        return _versions[capability].length;
    }
}
