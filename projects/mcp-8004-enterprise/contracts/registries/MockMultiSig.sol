// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title MockMultiSig
 * @notice Minimal M-of-N multi-signature wallet for local development and testing.
 *
 * Replaces the single-EOA Ownable owner on governance contracts (ParticipantRegistry,
 * IdentityRegistryUpgradeable, AutonomyBoundsRegistry, ActionPermitRegistry, etc.)
 * with a multi-sig that requires M-of-N signatures to execute any call.
 *
 * In production this would be a Gnosis Safe. This mock reproduces the same external
 * behaviour — execute(to, value, data, sigs[]) — with a minimal, auditable
 * implementation for the development consortium.
 *
 * Signature scheme:
 *   txHash     = keccak256(abi.encode(to, value, keccak256(data), nonce, address(this)))
 *   Each signer calls eth_sign(txHash), producing a personal_sign signature.
 *   Signatures must be passed in ascending signer-address order to prevent duplicate use.
 *
 * Replay protection: an on-chain nonce increments after every successful execution.
 */
contract MockMultiSig {
    using ECDSA for bytes32;

    // ── State ─────────────────────────────────────────────────────────────────

    address[] public signers;
    uint256   public threshold;
    uint256   public nonce;

    mapping(address => bool) public isSigner;

    // ── Events ────────────────────────────────────────────────────────────────

    event Executed(address indexed to, uint256 value, bytes data, uint256 nonce);
    event SignerAdded(address indexed signer);
    event SignerRemoved(address indexed signer);
    event ThresholdChanged(uint256 newThreshold);

    // ── Constructor ───────────────────────────────────────────────────────────

    /**
     * @param _signers    Initial signer set. Must be non-empty, no duplicates, no zero addresses.
     * @param _threshold  Minimum number of signatures required. Must be ≥ 1 and ≤ signers.length.
     */
    constructor(address[] memory _signers, uint256 _threshold) {
        require(_signers.length > 0, "no signers");
        require(_threshold >= 1 && _threshold <= _signers.length, "bad threshold");

        for (uint256 i; i < _signers.length; i++) {
            address s = _signers[i];
            require(s != address(0), "zero signer");
            require(!isSigner[s], "duplicate signer");
            isSigner[s] = true;
            signers.push(s);
            emit SignerAdded(s);
        }
        threshold = _threshold;
    }

    receive() external payable {}

    // ── Core execution ────────────────────────────────────────────────────────

    /**
     * @notice Execute a transaction if M-of-N valid signatures are provided.
     *
     * @param to    Target contract address.
     * @param value ETH value to forward (usually 0 for governance calls).
     * @param data  Encoded calldata (e.g. abi.encodeCall(Ownable.transferOwnership, [newOwner])).
     * @param sigs  Signatures in ascending signer-address order to prevent replay within a call.
     *
     * Emits Executed on success.
     */
    function executeTransaction(
        address        to,
        uint256        value,
        bytes calldata data,
        bytes[] calldata sigs
    ) external returns (bytes memory) {
        require(sigs.length >= threshold, "insufficient signatures");

        bytes32 txHash   = getTransactionHash(to, value, data, nonce);
        bytes32 ethHash  = MessageHashUtils.toEthSignedMessageHash(txHash);

        address prev = address(0);
        uint256 valid;
        for (uint256 i; i < sigs.length; i++) {
            address recovered = ethHash.recover(sigs[i]);
            require(isSigner[recovered], "invalid signer");
            require(recovered > prev, "signatures not in order / duplicate");
            prev = recovered;
            valid++;
        }
        require(valid >= threshold, "threshold not met");

        uint256 usedNonce = nonce;
        nonce++;

        (bool ok, bytes memory ret) = to.call{value: value}(data);
        require(ok, "execution failed");

        emit Executed(to, value, data, usedNonce);
        return ret;
    }

    // ── View helpers ──────────────────────────────────────────────────────────

    /**
     * @notice Returns the hash that each signer must sign for a given transaction.
     *         Use eth_sign (personal_sign) to produce the off-chain signature.
     */
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint256 _nonce
    ) public view returns (bytes32) {
        return keccak256(abi.encode(to, value, keccak256(data), _nonce, address(this)));
    }

    function getSigners() external view returns (address[] memory) {
        return signers;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }
}
