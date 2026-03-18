// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title PromptRegistry
 * @notice On-chain registry of approved prompt template hashes.
 *
 * Each prompt is identified by a bytes32 promptId (e.g. keccak256("aml-review-agent"))
 * and a string version (e.g. a LangSmith commit hash or semver tag).
 * The stored value is the keccak256 hash of the prompt's canonical content,
 * computed off-chain by the bridge before registration.
 *
 * Typical flow:
 *   CI/CD  → registry_bridge.py  → register(promptId, version, contentHash)
 *   Runtime → runtime_verifier.py → verify(promptId, version, recomputedHash)
 */
contract PromptRegistry {
    address public owner;

    // keccak256(abi.encodePacked(promptId, version)) => contentHash
    mapping(bytes32 => bytes32) private _hashes;

    event PromptRegistered(
        bytes32 indexed promptId,
        string  version,
        bytes32 contentHash,
        address registeredBy
    );

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "PromptRegistry: not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "PromptRegistry: zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /**
     * @notice Register or update a prompt hash. Only callable by owner (CI/CD key).
     * @param promptId   Identifier for the prompt template (e.g. keccak256 of agent name).
     * @param version    LangSmith commit hash or semver string.
     * @param contentHash keccak256 of the prompt's canonical content, computed off-chain.
     */
    function register(
        bytes32 promptId,
        string calldata version,
        bytes32 contentHash
    ) external onlyOwner {
        require(contentHash != bytes32(0), "PromptRegistry: zero hash");
        bytes32 key = keccak256(abi.encodePacked(promptId, version));
        _hashes[key] = contentHash;
        emit PromptRegistered(promptId, version, contentHash, msg.sender);
    }

    /**
     * @notice Return the registered content hash for a prompt + version pair.
     *         Returns bytes32(0) if not registered.
     */
    function getHash(
        bytes32 promptId,
        string calldata version
    ) external view returns (bytes32) {
        return _hashes[keccak256(abi.encodePacked(promptId, version))];
    }

    /**
     * @notice Check whether a given contentHash matches the registered value.
     *         Returns false if the prompt/version pair was never registered.
     */
    function verify(
        bytes32 promptId,
        string calldata version,
        bytes32 contentHash
    ) external view returns (bool) {
        bytes32 key = keccak256(abi.encodePacked(promptId, version));
        bytes32 stored = _hashes[key];
        return stored != bytes32(0) && stored == contentHash;
    }
}
