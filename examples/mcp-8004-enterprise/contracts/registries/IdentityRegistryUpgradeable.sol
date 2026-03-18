// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721URIStorageUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "./IParticipantRegistry.sol";

contract IdentityRegistryUpgradeable is
    ERC721URIStorageUpgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable,
    EIP712Upgradeable
{
    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    /// @custom:storage-location erc7201:erc8004.identity.registry
    struct IdentityRegistryStorage {
        uint256 _lastId;
        // agentId => metadataKey => metadataValue
        // Reserved keys: "agentWallet", "oracleAddress", "cardHash", "participantId"
        mapping(uint256 => mapping(string => bytes)) _metadata;
        // Optional minting gate. address(0) = unrestricted (opt-in).
        address _participantRegistry;
    }

    // keccak256(abi.encode(uint256(keccak256("erc8004.identity.registry")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant IDENTITY_REGISTRY_STORAGE_LOCATION =
    0xa040f782729de4970518741823ec1276cbcd41a0c7493f62d173341566a04e00;

    function _getIdentityRegistryStorage() private pure returns (IdentityRegistryStorage storage $) {
        assembly {
            $.slot := IDENTITY_REGISTRY_STORAGE_LOCATION
        }
    }

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    /// @notice Emitted when an oracle contract is bound to an agent identity.
    event OracleAddressSet(uint256 indexed agentId, address indexed oracleAddress, address indexed setBy);
    /// @notice Emitted when the agent card content hash is committed or updated.
    event CardHashSet(uint256 indexed agentId, bytes32 indexed cardHash, address indexed setBy);
    /// @notice Emitted when the ParticipantRegistry minting gate is configured.
    event ParticipantRegistrySet(address indexed participantRegistry, address indexed setBy);

    bytes32 private constant AGENT_WALLET_SET_TYPEHASH =
    keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");
    bytes4 private constant ERC1271_MAGICVALUE = 0x1626ba7e;
    uint256 private constant MAX_DEADLINE_DELAY = 5 minutes;
    bytes32 private constant RESERVED_AGENT_WALLET_KEY_HASH  = keccak256("agentWallet");
    /// @dev Prevents oracleAddress being set/overwritten via generic setMetadata.
    bytes32 private constant RESERVED_ORACLE_ADDRESS_KEY_HASH = keccak256("oracleAddress");
    /// @dev Prevents cardHash being set/overwritten via generic setMetadata.
    bytes32 private constant RESERVED_CARD_HASH_KEY_HASH        = keccak256("cardHash");
    /// @dev Prevents participantId being set/overwritten via generic setMetadata.
    bytes32 private constant RESERVED_PARTICIPANT_ID_KEY_HASH   = keccak256("participantId");

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize() public initializer {
        __ERC721_init("AgentIdentity", "AGENT");
        __ERC721URIStorage_init();
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();
        __EIP712_init("ERC8004IdentityRegistry", "1");
    }

    // -------------------------------------------------------------------------
    // Participant registry minting gate (opt-in)
    // -------------------------------------------------------------------------

    /**
     * @notice Configure the ParticipantRegistry minting gate.
     *         When set to a non-zero address, all register() calls will check
     *         that msg.sender is an approved minter for an active participant,
     *         and will record the participantId on the minted agent.
     *         Set to address(0) to disable gating (unrestricted minting).
     */
    function setParticipantRegistry(address participantRegistry_) external onlyOwner {
        IdentityRegistryStorage storage $ = _getIdentityRegistryStorage();
        $._participantRegistry = participantRegistry_;
        emit ParticipantRegistrySet(participantRegistry_, msg.sender);
    }

    function getParticipantRegistryAddress() external view returns (address) {
        return _getIdentityRegistryStorage()._participantRegistry;
    }

    // -------------------------------------------------------------------------
    // Registration
    // -------------------------------------------------------------------------

    function register() external returns (uint256 agentId) {
        IdentityRegistryStorage storage $ = _getIdentityRegistryStorage();
        _checkAndRecordParticipant($, msg.sender);
        agentId = $._lastId++;
        $._metadata[agentId]["agentWallet"] = abi.encodePacked(msg.sender);
        _safeMint(msg.sender, agentId);
        emit Registered(agentId, "", msg.sender);
        emit MetadataSet(agentId, "agentWallet", "agentWallet", abi.encodePacked(msg.sender));
    }

    function register(string memory agentURI) external returns (uint256 agentId) {
        IdentityRegistryStorage storage $ = _getIdentityRegistryStorage();
        _checkAndRecordParticipant($, msg.sender);
        agentId = $._lastId++;
        $._metadata[agentId]["agentWallet"] = abi.encodePacked(msg.sender);
        _safeMint(msg.sender, agentId);
        _setTokenURI(agentId, agentURI);
        emit Registered(agentId, agentURI, msg.sender);
        emit MetadataSet(agentId, "agentWallet", "agentWallet", abi.encodePacked(msg.sender));
    }

    function register(string memory agentURI, MetadataEntry[] memory metadata) external returns (uint256 agentId) {
        IdentityRegistryStorage storage $ = _getIdentityRegistryStorage();
        _checkAndRecordParticipant($, msg.sender);
        agentId = $._lastId++;
        $._metadata[agentId]["agentWallet"] = abi.encodePacked(msg.sender);
        _safeMint(msg.sender, agentId);
        _setTokenURI(agentId, agentURI);
        emit Registered(agentId, agentURI, msg.sender);
        emit MetadataSet(agentId, "agentWallet", "agentWallet", abi.encodePacked(msg.sender));

        for (uint256 i; i < metadata.length; i++) {
            _requireNotReserved(metadata[i].metadataKey);
            $._metadata[agentId][metadata[i].metadataKey] = metadata[i].metadataValue;
            emit MetadataSet(agentId, metadata[i].metadataKey, metadata[i].metadataKey, metadata[i].metadataValue);
        }
    }

    /**
     * @notice Register an agent with a URI, arbitrary metadata, and a bound oracle contract.
     *         This is the canonical enterprise registration path — agent identity, card URI,
     *         capability metadata, and on-chain oracle are all established in a single transaction.
     * @param agentURI       URI pointing to the agent card (e.g. IPFS or HTTP endpoint).
     * @param metadata       Arbitrary key/value metadata entries (reserved keys are rejected).
     * @param oracleAddress  Address of the deployed oracle contract to bind to this agent identity.
     */
    function register(
        string memory agentURI,
        MetadataEntry[] memory metadata,
        address oracleAddress
    ) external returns (uint256 agentId) {
        require(oracleAddress != address(0), "ERC8004: zero oracle address");

        IdentityRegistryStorage storage $ = _getIdentityRegistryStorage();
        _checkAndRecordParticipant($, msg.sender);
        agentId = $._lastId++;
        $._metadata[agentId]["agentWallet"]    = abi.encodePacked(msg.sender);
        $._metadata[agentId]["oracleAddress"]  = abi.encodePacked(oracleAddress);
        _safeMint(msg.sender, agentId);
        _setTokenURI(agentId, agentURI);

        emit Registered(agentId, agentURI, msg.sender);
        emit MetadataSet(agentId, "agentWallet",   "agentWallet",   abi.encodePacked(msg.sender));
        emit OracleAddressSet(agentId, oracleAddress, msg.sender);

        for (uint256 i; i < metadata.length; i++) {
            _requireNotReserved(metadata[i].metadataKey);
            $._metadata[agentId][metadata[i].metadataKey] = metadata[i].metadataValue;
            emit MetadataSet(agentId, metadata[i].metadataKey, metadata[i].metadataKey, metadata[i].metadataValue);
        }
    }

    // -------------------------------------------------------------------------
    // Generic metadata
    // -------------------------------------------------------------------------

    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory) {
        IdentityRegistryStorage storage $ = _getIdentityRegistryStorage();
        return $._metadata[agentId][metadataKey];
    }

    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external {
        address agentOwner = _ownerOf(agentId);
        require(
            msg.sender == agentOwner ||
            isApprovedForAll(agentOwner, msg.sender) ||
            msg.sender == getApproved(agentId),
            "Not authorized"
        );
        _requireNotReserved(metadataKey);
        IdentityRegistryStorage storage $ = _getIdentityRegistryStorage();
        $._metadata[agentId][metadataKey] = metadataValue;
        emit MetadataSet(agentId, metadataKey, metadataKey, metadataValue);
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        address owner = ownerOf(agentId);
        require(
            msg.sender == owner ||
            isApprovedForAll(owner, msg.sender) ||
            msg.sender == getApproved(agentId),
            "Not authorized"
        );
        _setTokenURI(agentId, newURI);
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    // -------------------------------------------------------------------------
    // agentWallet — reserved typed field
    // -------------------------------------------------------------------------

    function getAgentWallet(uint256 agentId) external view returns (address) {
        IdentityRegistryStorage storage $ = _getIdentityRegistryStorage();
        bytes memory walletData = $._metadata[agentId]["agentWallet"];
        return address(bytes20(walletData));
    }

    struct AgentWalletSetParams {
        uint256 agentId;
        address newWallet;
        uint256 deadline;
        bytes   signature;
    }

    function setAgentWallet(AgentWalletSetParams calldata params) external {
        address owner = ownerOf(params.agentId);
        require(
            msg.sender == owner ||
            isApprovedForAll(owner, msg.sender) ||
            msg.sender == getApproved(params.agentId),
            "Not authorized"
        );
        require(params.newWallet != address(0), "bad wallet");
        require(block.timestamp <= params.deadline, "expired");
        require(params.deadline <= block.timestamp + MAX_DEADLINE_DELAY, "deadline too far");

        bytes32 structHash = keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, params.agentId, params.newWallet, owner, params.deadline));
        bytes32 digest = _hashTypedDataV4(structHash);

        // Try ECDSA first (EOAs + EIP-7702 delegated EOAs)
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, params.signature);
        if (err != ECDSA.RecoverError.NoError || recovered != params.newWallet) {
            // ECDSA failed, try ERC1271 (smart contract wallets)
            (bool ok, bytes memory res) = params.newWallet.staticcall(
                abi.encodeCall(IERC1271.isValidSignature, (digest, params.signature))
            );
            require(ok && res.length >= 32 && abi.decode(res, (bytes4)) == ERC1271_MAGICVALUE, "invalid wallet sig");
        }

        IdentityRegistryStorage storage $ = _getIdentityRegistryStorage();
        $._metadata[params.agentId]["agentWallet"] = abi.encodePacked(params.newWallet);
        emit MetadataSet(params.agentId, "agentWallet", "agentWallet", abi.encodePacked(params.newWallet));
    }

    function unsetAgentWallet(uint256 agentId) external {
        address owner = ownerOf(agentId);
        require(
            msg.sender == owner ||
            isApprovedForAll(owner, msg.sender) ||
            msg.sender == getApproved(agentId),
            "Not authorized"
        );
        IdentityRegistryStorage storage $ = _getIdentityRegistryStorage();
        $._metadata[agentId]["agentWallet"] = "";
        emit MetadataSet(agentId, "agentWallet", "agentWallet", "");
    }

    // -------------------------------------------------------------------------
    // oracleAddress — reserved typed field (ERC-8004 extension, Option A)
    // -------------------------------------------------------------------------

    /**
     * @notice Returns the oracle contract address bound to this agent identity.
     * @param agentId The agent token ID.
     * @return The bound oracle address, or address(0) if none is set.
     */
    function getOracleAddress(uint256 agentId) external view returns (address) {
        IdentityRegistryStorage storage $ = _getIdentityRegistryStorage();
        bytes memory data = $._metadata[agentId]["oracleAddress"];
        if (data.length == 0) return address(0);
        return address(bytes20(data));
    }

    /**
     * @notice Bind or update the oracle contract address for an agent.
     *         Only the agent owner or an approved operator may call this.
     *         Setting address(0) effectively unbinds the oracle.
     * @param agentId       The agent token ID.
     * @param oracleAddress The deployed oracle contract to bind.
     */
    function setOracleAddress(uint256 agentId, address oracleAddress) external {
        address owner = ownerOf(agentId);
        require(
            msg.sender == owner ||
            isApprovedForAll(owner, msg.sender) ||
            msg.sender == getApproved(agentId),
            "Not authorized"
        );
        IdentityRegistryStorage storage $ = _getIdentityRegistryStorage();
        $._metadata[agentId]["oracleAddress"] = abi.encodePacked(oracleAddress);
        emit OracleAddressSet(agentId, oracleAddress, msg.sender);
    }

    // -------------------------------------------------------------------------
    // participantId — reserved typed field
    // -------------------------------------------------------------------------

    /**
     * @notice Returns the participantId recorded at mint time, or bytes32(0) if
     *         the agent was minted before a ParticipantRegistry was configured.
     */
    function getParticipantId(uint256 agentId) external view returns (bytes32) {
        IdentityRegistryStorage storage $ = _getIdentityRegistryStorage();
        bytes memory data = $._metadata[agentId]["participantId"];
        if (data.length == 0) return bytes32(0);
        return abi.decode(data, (bytes32));
    }

    // -------------------------------------------------------------------------
    // cardHash — reserved typed field
    // -------------------------------------------------------------------------

    /**
     * @notice Returns the keccak256 hash of the agent card committed at deploy time.
     * @param agentId The agent token ID.
     * @return The committed card hash, or bytes32(0) if unset.
     */
    function getCardHash(uint256 agentId) external view returns (bytes32) {
        IdentityRegistryStorage storage $ = _getIdentityRegistryStorage();
        bytes memory data = $._metadata[agentId]["cardHash"];
        if (data.length == 0) return bytes32(0);
        return abi.decode(data, (bytes32));
    }

    /**
     * @notice Commit or update the keccak256 hash of the agent card.
     *         Only the agent owner or an approved operator may call this.
     * @param agentId   The agent token ID.
     * @param cardHash_ keccak256 of the raw agent card file bytes.
     */
    function setCardHash(uint256 agentId, bytes32 cardHash_) external {
        address owner = ownerOf(agentId);
        require(
            msg.sender == owner ||
            isApprovedForAll(owner, msg.sender) ||
            msg.sender == getApproved(agentId),
            "Not authorized"
        );
        IdentityRegistryStorage storage $ = _getIdentityRegistryStorage();
        $._metadata[agentId]["cardHash"] = abi.encode(cardHash_);
        emit CardHashSet(agentId, cardHash_, msg.sender);
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /// @dev Reverts if the key is a reserved field that must not be set via generic setMetadata.
    function _requireNotReserved(string memory metadataKey) internal pure {
        bytes32 h = keccak256(bytes(metadataKey));
        require(h != RESERVED_AGENT_WALLET_KEY_HASH,    "reserved key: agentWallet");
        require(h != RESERVED_ORACLE_ADDRESS_KEY_HASH,  "reserved key: oracleAddress");
        require(h != RESERVED_CARD_HASH_KEY_HASH,       "reserved key: cardHash");
        require(h != RESERVED_PARTICIPANT_ID_KEY_HASH,  "reserved key: participantId");
    }

    /**
     * @dev If a ParticipantRegistry is configured, verify msg.sender is an approved
     *      minter and record the participantId on the about-to-be-minted agentId.
     *      The agentId slot in $ must already be incremented before _safeMint is
     *      called; we write participantId using the same agentId that will be minted.
     *
     *      Called at the top of every register() overload, before _safeMint.
     *      The agentId written here matches $._lastId (before increment).
     */
    function _checkAndRecordParticipant(IdentityRegistryStorage storage $, address minter) private {
        address pr = $._participantRegistry;
        if (pr == address(0)) return;

        IParticipantRegistry registry = IParticipantRegistry(pr);
        require(registry.isApprovedMinter(minter), "ERC8004: minter not registered participant");

        bytes32 pid = registry.getMinterParticipantId(minter);
        // Write to the slot that _lastId will assign — store before increment so
        // agentId == $._lastId at the moment we write.
        $._metadata[$._lastId]["participantId"] = abi.encode(pid);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /**
     * @dev Override _update to clear both agentWallet and oracleAddress on transfer.
     *      Verified wallet and oracle binding must not persist to new owners.
     *      Cleared BEFORE super._update() to follow Checks-Effects-Interactions.
     */
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);

        if (from != address(0) && to != address(0)) {
            IdentityRegistryStorage storage $ = _getIdentityRegistryStorage();
            $._metadata[tokenId]["agentWallet"]   = "";
            $._metadata[tokenId]["oracleAddress"] = "";
            $._metadata[tokenId]["cardHash"]      = "";
            $._metadata[tokenId]["participantId"] = "";
            emit MetadataSet(tokenId, "agentWallet",   "agentWallet",   "");
            emit OracleAddressSet(tokenId, address(0), msg.sender);
            emit CardHashSet(tokenId, bytes32(0), msg.sender);
        }

        return super._update(to, tokenId, auth);
    }

    // -------------------------------------------------------------------------
    // Utility
    // -------------------------------------------------------------------------

    /**
     * @notice Checks if spender is owner or approved for the agent.
     * @dev Reverts with ERC721NonexistentToken if agent doesn't exist.
     */
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool) {
        address owner = ownerOf(agentId);
        return _isAuthorized(owner, spender, agentId);
    }

    function getVersion() external pure returns (string memory) {
        return "3.0.0";
    }
}