// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../registries/IIdentityRegistry.sol";
import "../registries/OnboardingRegistry.sol";

/**
 * @title ClientSetupOracle
 * @notice On-chain oracle for the three sequential client setup phases:
 *         Legal Entity Setup → Account Setup → Product Setup.
 *
 * All three phases are handled in this single contract.
 *
 * Gating rules (enforced on-chain, not off-chain):
 *   setupLegalEntity — requires ALL_REVIEWS_DONE (AML + Credit + Legal all complete)
 *   setupAccount     — requires ENTITY_SETUP_DONE
 *   setupProducts    — requires ACCOUNT_SETUP_DONE
 *
 * Each phase calls OnboardingRegistry.setPhaseComplete() on completion.
 * When setupProducts completes, PRODUCT_SETUP_DONE is set, which triggers
 * ReadyToTransact in OnboardingRegistry (phaseBitmask == ALL_PHASES_DONE).
 *
 * Authorization layers:
 *   1. onlyBankAgent  — the relevant setup agent (agentWallet + oracleAddress binding)
 *   2. onlyActiveFlow — OnboardingRegistry.isActive() must be true
 *
 * Payload privacy: entity specs, account parameters, and product configuration
 * are never stored on-chain. Only their keccak256 hashes are committed.
 */
contract ClientSetupOracle {

    // ── Storage ───────────────────────────────────────────────────────────────

    IIdentityRegistry  public immutable identityRegistry;
    OnboardingRegistry public immutable onboardingRegistry;

    // ── Events ────────────────────────────────────────────────────────────────

    event LegalEntitySetupStarted(bytes32 indexed flowId, uint256 agentId, uint256 timestamp);
    event LegalEntitySetupComplete(bytes32 indexed flowId, bytes32 entitySpecHash, uint256 agentId, uint256 timestamp);
    event AccountSetupStarted(bytes32 indexed flowId, uint256 agentId, uint256 timestamp);
    event AccountSetupComplete(bytes32 indexed flowId, bytes32 accountSpecHash, uint256 agentId, uint256 timestamp);
    event ProductSetupStarted(bytes32 indexed flowId, uint256 agentId, uint256 timestamp);
    event ProductSetupComplete(bytes32 indexed flowId, bytes32 productSpecHash, uint256 agentId, uint256 timestamp);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address identityRegistry_, address onboardingRegistry_) {
        require(identityRegistry_   != address(0), "zero identityRegistry");
        require(onboardingRegistry_ != address(0), "zero onboardingRegistry");
        identityRegistry   = IIdentityRegistry(identityRegistry_);
        onboardingRegistry = OnboardingRegistry(onboardingRegistry_);
    }

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyBankAgent(uint256 agentId) {
        require(
            identityRegistry.getAgentWallet(agentId) == msg.sender,
            "ClientSetupOracle: caller is not the bank agent wallet"
        );
        require(
            identityRegistry.getOracleAddress(agentId) == address(this),
            "ClientSetupOracle: agent not bound to this oracle"
        );
        _;
    }

    modifier onlyActiveFlow(bytes32 flowId) {
        require(onboardingRegistry.isActive(flowId), "ClientSetupOracle: flow terminated or does not exist");
        _;
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _checkCardHash(uint256 agentId, bytes32 cardHash_) internal view {
        bytes32 committed = identityRegistry.getCardHash(agentId);
        if (committed != bytes32(0)) {
            require(committed == cardHash_, "card hash mismatch");
        }
    }

    // ── Phase 1: Legal Entity Setup ───────────────────────────────────────────

    /**
     * @notice Execute the legal entity setup for the onboarding client.
     *
     * Gating: all three review sub-flows (AML, Credit Risk, Legal) must be
     * complete before legal entity setup can proceed. This is enforced on-chain
     * by checking phaseBitmask against ALL_REVIEWS_DONE.
     *
     * @param flowId         The onboarding flow.
     * @param agentId        The LegalEntitySetupAgent NFT id.
     * @param entitySpecHash keccak256 of the legal entity specification (off-chain).
     */
    function setupLegalEntity(
        bytes32 flowId,
        uint256 agentId,
        bytes32 entitySpecHash,
        bytes32 cardHash_
    )
        external
        onlyBankAgent(agentId)
        onlyActiveFlow(flowId)
    {
        _checkCardHash(agentId, cardHash_);
        uint8 mask = onboardingRegistry.phaseBitmask(flowId);
        uint8 allReviewsDone = onboardingRegistry.ALL_REVIEWS_DONE();
        uint8 entityDone     = onboardingRegistry.PHASE_ENTITY_SETUP_DONE();

        require(
            (mask & allReviewsDone) == allReviewsDone,
            "ClientSetupOracle: reviews not complete"
        );
        require(
            (mask & entityDone) == 0,
            "ClientSetupOracle: legal entity already set up"
        );

        emit LegalEntitySetupStarted(flowId, agentId, block.timestamp);
        onboardingRegistry.setPhaseComplete(flowId, entityDone);
        emit LegalEntitySetupComplete(flowId, entitySpecHash, agentId, block.timestamp);
    }

    // ── Phase 2: Account Setup ────────────────────────────────────────────────

    /**
     * @notice Execute the account setup for the onboarding client.
     *
     * Gating: legal entity setup must be complete.
     *
     * @param flowId          The onboarding flow.
     * @param agentId         The AccountSetupAgent NFT id.
     * @param accountSpecHash keccak256 of the account configuration (off-chain).
     */
    function setupAccount(
        bytes32 flowId,
        uint256 agentId,
        bytes32 accountSpecHash,
        bytes32 cardHash_
    )
        external
        onlyBankAgent(agentId)
        onlyActiveFlow(flowId)
    {
        _checkCardHash(agentId, cardHash_);
        uint8 mask        = onboardingRegistry.phaseBitmask(flowId);
        uint8 entityDone  = onboardingRegistry.PHASE_ENTITY_SETUP_DONE();
        uint8 accountDone = onboardingRegistry.PHASE_ACCOUNT_SETUP_DONE();

        require(
            (mask & entityDone) == entityDone,
            "ClientSetupOracle: legal entity setup not complete"
        );
        require(
            (mask & accountDone) == 0,
            "ClientSetupOracle: account already set up"
        );

        emit AccountSetupStarted(flowId, agentId, block.timestamp);
        onboardingRegistry.setPhaseComplete(flowId, accountDone);
        emit AccountSetupComplete(flowId, accountSpecHash, agentId, block.timestamp);
    }

    // ── Phase 3: Product Setup ────────────────────────────────────────────────

    /**
     * @notice Execute the product setup for the onboarding client.
     *
     * Gating: account setup must be complete.
     *
     * Setting PRODUCT_SETUP_DONE completes ALL_PHASES_DONE in OnboardingRegistry,
     * which emits ReadyToTransact.
     *
     * @param flowId          The onboarding flow.
     * @param agentId         The ProductSetupAgent NFT id.
     * @param productSpecHash keccak256 of the product configuration (off-chain).
     */
    function setupProducts(
        bytes32 flowId,
        uint256 agentId,
        bytes32 productSpecHash,
        bytes32 cardHash_
    )
        external
        onlyBankAgent(agentId)
        onlyActiveFlow(flowId)
    {
        _checkCardHash(agentId, cardHash_);
        uint8 mask        = onboardingRegistry.phaseBitmask(flowId);
        uint8 accountDone = onboardingRegistry.PHASE_ACCOUNT_SETUP_DONE();
        uint8 productDone = onboardingRegistry.PHASE_PRODUCT_SETUP_DONE();

        require(
            (mask & accountDone) == accountDone,
            "ClientSetupOracle: account setup not complete"
        );
        require(
            (mask & productDone) == 0,
            "ClientSetupOracle: products already set up"
        );

        emit ProductSetupStarted(flowId, agentId, block.timestamp);
        onboardingRegistry.setPhaseComplete(flowId, productDone);
        emit ProductSetupComplete(flowId, productSpecHash, agentId, block.timestamp);
    }
}
