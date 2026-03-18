// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IDatasetRegistry {
    /**
     * @notice Returns true if contentHash is approved for the given traceId / capability pair.
     *
     * Two-tier opt-in logic:
     *   - No global approvals configured for capability AND no flow policy for traceId → true.
     *   - Global approvals configured → hash must be globally approved for that capability.
     *   - Flow policy configured → hash must be in the flow allowlist.
     *   - Both configured → hash must pass both checks.
     */
    function isApproved(bytes32 traceId, bytes32 capability, bytes32 contentHash)
        external view returns (bool);
}
