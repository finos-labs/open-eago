// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockOracle
 * @notice Minimal oracle stub used only in governance contract tests.
 *
 * Accepts the same constructor signature as the onboarding oracle contracts
 * (AMLOracle, CreditRiskOracle, LegalOracle, ClientSetupOracle) so that
 * governance test fixtures can deploy a valid oracle address to bind agents to
 * without depending on any specific workflow contract.
 *
 * Contains no oracle logic — governance unit tests do not need to invoke
 * actual oracle fulfillment flows.
 */
contract MockOracle {
    address public immutable identityRegistry;
    address public immutable traceLog;

    constructor(address identityRegistry_, address traceLog_) {
        identityRegistry = identityRegistry_;
        traceLog         = traceLog_;
    }
}
