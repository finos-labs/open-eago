// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./IParticipantRegistry.sol";

/**
 * @title ParticipantRegistry
 * @notice Registry of approved institutions (banks and institutional clients)
 *         participating in the ERC-8004 / MCP consortium.
 *
 * Responsibilities:
 *   1. Permissioned minting — only addresses registered as minters for an active
 *      participant may call IdentityRegistryUpgradeable.register().
 *   2. Approver sets — Tier 2 action approvals (ActionPermitRegistry) are gated
 *      on isApprover() / isSeniorApprover() so that only credentialed humans at
 *      registered institutions can sign off on destructive actions.
 *   3. Deployment topology — each participant carries a defaultAgentTier that
 *      ops tooling uses to determine bridge placement (internal vs external DMZ).
 *
 * Governance: owned by a multi-sig (Gnosis Safe M-of-N across member institutions).
 * In local development, a single EOA owner is sufficient.
 *
 * Opt-in: if IdentityRegistryUpgradeable has no ParticipantRegistry configured
 * (address(0)), minting is unrestricted. Configuring the registry enables the gate.
 */
contract ParticipantRegistry is IParticipantRegistry, Ownable {

    // ── Types ────────────────────────────────────────────────────────────────────

    struct Participant {
        bytes32         participantId;
        ParticipantType participantType;
        DeploymentTier  defaultAgentTier;
        bool            active;
    }

    // ── Storage ──────────────────────────────────────────────────────────────────

    /// participantId → participant record
    mapping(bytes32 => Participant) private _participants;

    /// participantId → address → role membership
    mapping(bytes32 => mapping(address => bool)) private _minters;
    mapping(bytes32 => mapping(address => bool)) private _approvers;
    mapping(bytes32 => mapping(address => bool)) private _seniorApprovers;

    /// address → participantId reverse lookups (for O(1) isApproved* checks)
    mapping(address => bytes32) private _minterToParticipant;
    mapping(address => bytes32) private _approverToParticipant;
    mapping(address => bytes32) private _seniorApproverToParticipant;

    // ── Events ───────────────────────────────────────────────────────────────────

    event ParticipantRegistered(
        bytes32 indexed participantId,
        ParticipantType participantType,
        DeploymentTier  defaultAgentTier
    );
    event ParticipantDeactivated(bytes32 indexed participantId);
    event MinterAdded(bytes32 indexed participantId, address indexed minter);
    event MinterRemoved(bytes32 indexed participantId, address indexed minter);
    event ApproverAdded(bytes32 indexed participantId, address indexed approver);
    event ApproverRemoved(bytes32 indexed participantId, address indexed approver);
    event SeniorApproverAdded(bytes32 indexed participantId, address indexed approver);
    event SeniorApproverRemoved(bytes32 indexed participantId, address indexed approver);

    // ── Constructor ──────────────────────────────────────────────────────────────

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ── Registration ─────────────────────────────────────────────────────────────

    /**
     * @notice Register a new participant institution.
     * @param participantId     Unique identifier (e.g. keccak256("ACME_BANK")).
     * @param participantType   BANK or CLIENT.
     * @param defaultAgentTier  Bridge placement default for agents minted by this participant.
     * @param minters           Addresses permitted to mint agent NFTs on behalf of this participant.
     * @param approvers         Tier 2 standard approver addresses.
     * @param seniorApprovers   Escalation-path approver addresses.
     */
    function registerParticipant(
        bytes32          participantId,
        ParticipantType  participantType,
        DeploymentTier   defaultAgentTier,
        address[]        calldata minters,
        address[]        calldata approvers,
        address[]        calldata seniorApprovers
    ) external onlyOwner {
        require(participantId != bytes32(0), "zero participantId");
        require(!_participants[participantId].active, "already registered");

        _participants[participantId] = Participant(participantId, participantType, defaultAgentTier, true);
        emit ParticipantRegistered(participantId, participantType, defaultAgentTier);

        for (uint256 i; i < minters.length; i++)        _addMinter(participantId, minters[i]);
        for (uint256 i; i < approvers.length; i++)      _addApprover(participantId, approvers[i]);
        for (uint256 i; i < seniorApprovers.length; i++) _addSeniorApprover(participantId, seniorApprovers[i]);
    }

    /**
     * @notice Deactivate a participant. Existing agent NFTs are unaffected but
     *         minting and approvals from this participant will be blocked.
     */
    function deactivateParticipant(bytes32 participantId) external onlyOwner {
        require(_participants[participantId].active, "not active");
        _participants[participantId].active = false;
        emit ParticipantDeactivated(participantId);
    }

    // ── Minter management ────────────────────────────────────────────────────────

    function addMinter(bytes32 participantId, address minter) external onlyOwner {
        require(_participants[participantId].active, "participant not active");
        _addMinter(participantId, minter);
    }

    function removeMinter(bytes32 participantId, address minter) external onlyOwner {
        require(_minters[participantId][minter], "not a minter");
        _minters[participantId][minter] = false;
        delete _minterToParticipant[minter];
        emit MinterRemoved(participantId, minter);
    }

    // ── Approver management ──────────────────────────────────────────────────────

    function addApprover(bytes32 participantId, address approver) external onlyOwner {
        require(_participants[participantId].active, "participant not active");
        _addApprover(participantId, approver);
    }

    function removeApprover(bytes32 participantId, address approver) external onlyOwner {
        require(_approvers[participantId][approver], "not an approver");
        _approvers[participantId][approver] = false;
        delete _approverToParticipant[approver];
        emit ApproverRemoved(participantId, approver);
    }

    function addSeniorApprover(bytes32 participantId, address approver) external onlyOwner {
        require(_participants[participantId].active, "participant not active");
        _addSeniorApprover(participantId, approver);
    }

    function removeSeniorApprover(bytes32 participantId, address approver) external onlyOwner {
        require(_seniorApprovers[participantId][approver], "not a senior approver");
        _seniorApprovers[participantId][approver] = false;
        delete _seniorApproverToParticipant[approver];
        emit SeniorApproverRemoved(participantId, approver);
    }

    // ── IParticipantRegistry views ───────────────────────────────────────────────

    function isApprovedMinter(address minter) external view override returns (bool) {
        bytes32 pid = _minterToParticipant[minter];
        if (pid == bytes32(0)) return false;
        return _minters[pid][minter] && _participants[pid].active;
    }

    function getMinterParticipantId(address minter) external view override returns (bytes32) {
        return _minterToParticipant[minter];
    }

    function isApprover(address addr) external view override returns (bool) {
        bytes32 pid = _approverToParticipant[addr];
        if (pid == bytes32(0)) return false;
        return _approvers[pid][addr] && _participants[pid].active;
    }

    function isSeniorApprover(address addr) external view override returns (bool) {
        bytes32 pid = _seniorApproverToParticipant[addr];
        if (pid == bytes32(0)) return false;
        return _seniorApprovers[pid][addr] && _participants[pid].active;
    }

    function getParticipantType(bytes32 participantId) external view override returns (ParticipantType) {
        return _participants[participantId].participantType;
    }

    function getDeploymentTier(bytes32 participantId) external view override returns (DeploymentTier) {
        return _participants[participantId].defaultAgentTier;
    }

    function isActive(bytes32 participantId) external view override returns (bool) {
        return _participants[participantId].active;
    }

    // ── Additional views ─────────────────────────────────────────────────────────

    function getParticipant(bytes32 participantId) external view returns (Participant memory) {
        return _participants[participantId];
    }

    function isMinterFor(bytes32 participantId, address minter) external view returns (bool) {
        return _minters[participantId][minter];
    }

    function isApproverFor(bytes32 participantId, address approver) external view returns (bool) {
        return _approvers[participantId][approver];
    }

    function isSeniorApproverFor(bytes32 participantId, address approver) external view returns (bool) {
        return _seniorApprovers[participantId][approver];
    }

    // ── Internal ─────────────────────────────────────────────────────────────────

    function _addMinter(bytes32 participantId, address minter) internal {
        require(minter != address(0), "zero address");
        require(!_minters[participantId][minter], "already a minter");
        require(_minterToParticipant[minter] == bytes32(0), "address is minter for another participant");
        _minters[participantId][minter] = true;
        _minterToParticipant[minter] = participantId;
        emit MinterAdded(participantId, minter);
    }

    function _addApprover(bytes32 participantId, address approver) internal {
        require(approver != address(0), "zero address");
        require(!_approvers[participantId][approver], "already an approver");
        _approvers[participantId][approver] = true;
        _approverToParticipant[approver] = participantId;
        emit ApproverAdded(participantId, approver);
    }

    function _addSeniorApprover(bytes32 participantId, address approver) internal {
        require(approver != address(0), "zero address");
        require(!_seniorApprovers[participantId][approver], "already a senior approver");
        _seniorApprovers[participantId][approver] = true;
        _seniorApproverToParticipant[approver] = participantId;
        emit SeniorApproverAdded(participantId, approver);
    }
}
