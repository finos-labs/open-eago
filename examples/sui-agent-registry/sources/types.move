/// Shared types, error codes, and constants used across all three registries.
/// Inspired by ERC-8004 (Trustless Agents) adapted for the SUI object model,
/// with governance extensions influenced by the OpenEAGO specification
/// (FINOS Labs — https://github.com/finos-labs/open-eago).
module sui_a2a_registry::types {

    // ─── Error codes ──────────────────────────────────────────────────────────

    /// Caller is not the owner of the agent or the AgentCap
    const ENotOwner: u64 = 0;
    /// Referenced agent ID does not exist in the registry
    const EAgentNotFound: u64 = 1;
    /// A client cannot give feedback about their own agent
    const ESelfFeedback: u64 = 2;
    /// `valueDecimals` must be between 0 and 18
    const EInvalidDecimals: u64 = 3;
    /// The metadata key "agentWallet" is reserved and cannot be set via setMetadata
    const EReservedKey: u64 = 4;
    /// The referenced validation request does not exist
    const EValidationNotFound: u64 = 5;
    /// Only the originally designated validator may respond to a request
    const EWrongValidator: u64 = 6;
    /// Validation response value must be 0–100
    const EInvalidResponse: u64 = 7;
    /// Feedback index is out of range
    const EInvalidFeedbackIndex: u64 = 8;
    /// AgentCap does not match the target registry
    const ERegistryMismatch: u64 = 9;
    /// Agent is not active
    const EAgentInactive: u64 = 10;
    /// URI is already registered by another agent
    const EDuplicateURI: u64 = 11;
    /// Supplied agent_type value is not one of the four OpenEAGO classifications
    const EInvalidAgentType: u64 = 12;
    /// Agent is suspended and cannot be selected for execution
    const EAgentSuspended: u64 = 13;
    /// Agent has been revoked; this state is terminal
    const EAgentRevoked: u64 = 14;
    /// Reported SLA metrics do not meet the OpenEAGO minimum performance bar
    const ESlaThresholdNotMet: u64 = 15;
    /// The requested lifecycle state transition is not permitted
    const EInvalidLifecycleTransition: u64 = 16;
    /// Supplied risk_tier value is not one of the four OpenEAGO tiers
    const EInvalidRiskTier: u64 = 17;

    // ─── Public accessor functions for error codes ────────────────────────────
    // Exposed so other modules can abort with these codes without duplicating them.

    public fun e_not_owner(): u64 { ENotOwner }
    public fun e_agent_not_found(): u64 { EAgentNotFound }
    public fun e_self_feedback(): u64 { ESelfFeedback }
    public fun e_invalid_decimals(): u64 { EInvalidDecimals }
    public fun e_reserved_key(): u64 { EReservedKey }
    public fun e_validation_not_found(): u64 { EValidationNotFound }
    public fun e_wrong_validator(): u64 { EWrongValidator }
    public fun e_invalid_response(): u64 { EInvalidResponse }
    public fun e_invalid_feedback_index(): u64 { EInvalidFeedbackIndex }
    public fun e_registry_mismatch(): u64 { ERegistryMismatch }
    public fun e_agent_inactive(): u64 { EAgentInactive }
    public fun e_duplicate_uri(): u64 { EDuplicateURI }
    public fun e_invalid_agent_type(): u64 { EInvalidAgentType }
    public fun e_agent_suspended(): u64 { EAgentSuspended }
    public fun e_agent_revoked(): u64 { EAgentRevoked }
    public fun e_sla_threshold_not_met(): u64 { ESlaThresholdNotMet }
    public fun e_invalid_lifecycle_transition(): u64 { EInvalidLifecycleTransition }
    public fun e_invalid_risk_tier(): u64 { EInvalidRiskTier }

    // ─── Constants ────────────────────────────────────────────────────────────

    /// Reserved metadata key for the agent payment wallet
    public fun agent_wallet_key(): vector<u8> { b"agentWallet" }

    /// Maximum allowed valueDecimals in feedback (mirrors ERC-8004)
    public fun max_value_decimals(): u8 { 18 }

    /// Minimum reliability score (0–100) required by spec §4.2 / Appendix D.1
    /// Aligns with OpenEAGO Appendix D.1: reliability_score ≥ 0.95
    public fun min_reliability(): u8 { 95 }

    /// Minimum uptime percentage (0–100_00 basis points = 99.00%) per Appendix D.1
    /// Stored as basis points: 9900 = 99.00%
    /// Aligns with OpenEAGO Appendix D.1: availability_pct ≥ 0.9900
    public fun min_uptime_bps(): u64 { 9900 }

    /// Maximum error rate (basis points: 500 = 5.00%) per OpenEAGO Appendix D.1
    /// Aligns with OpenEAGO Appendix D.1: error_rate ≤ 0.05
    public fun max_error_rate_bps(): u64 { 500 }

    // ─── OpenEAGO Agent Type constants ────────────────────────────────────────
    // Mirrors the four agent classifications from OpenEAGO §3 (overview.md).

    /// Framework agents: LangChain, LangGraph, AutoGPT, custom ML frameworks
    public fun agent_type_framework(): u8 { 0 }
    /// Core agents: KYC/AML, risk assessment, compliance validation, data classification
    public fun agent_type_core(): u8 { 1 }
    /// Utility agents: FX conversion, address standardisation, translation, encryption
    public fun agent_type_utility(): u8 { 2 }
    /// Flow agents: orchestration of complex multi-agent workflows
    public fun agent_type_flow(): u8 { 3 }

    /// Validate that an agent_type value is within the defined range (0–3)
    public fun is_valid_agent_type(t: u8): bool { t <= 3 }

    // ─── OpenEAGO Lifecycle State constants ───────────────────────────────────
    // Mirrors the identity lifecycle state machine from OpenEAGO identity.md.

    /// Agent is authorised for runtime interactions (default at registration)
    public fun lifecycle_active(): u8 { 0 }
    /// Agent is temporarily blocked pending policy / security review
    public fun lifecycle_suspended(): u8 { 1 }
    /// Agent is permanently invalidated; this state is terminal
    public fun lifecycle_revoked(): u8 { 2 }
    /// Agent is retained for audit but excluded from runtime operations
    public fun lifecycle_archived(): u8 { 3 }

    /// Returns true if the given state is a terminal state (no further transitions)
    public fun is_terminal_lifecycle_state(s: u8): bool { s == 2 || s == 3 }

    // ─── OpenEAGO Risk Tier constants ─────────────────────────────────────────
    // Mirrors OpenEAGO SPECIFICATION.md Appendix E.2 risk tier thresholds.

    /// composite_risk_score ∈ [0.00, 0.39] — proceed with standard monitoring
    public fun risk_tier_low(): u8 { 0 }
    /// composite_risk_score ∈ [0.40, 0.59] — proceed with enhanced monitoring
    public fun risk_tier_medium(): u8 { 1 }
    /// composite_risk_score ∈ [0.60, 0.79] — requires Human-in-the-Loop approval
    public fun risk_tier_high(): u8 { 2 }
    /// composite_risk_score ∈ [0.80, 1.00] — automatic rejection unless overridden
    public fun risk_tier_critical(): u8 { 3 }

    /// Validate that a risk_tier value is within the defined range (0–3)
    public fun is_valid_risk_tier(t: u8): bool { t <= 3 }

    // ─── OpenEAGO Skill Proficiency constants ─────────────────────────────────

    /// Mirrors the proficiency_level field used in OpenEAGO skill definitions
    public fun proficiency_beginner(): u8 { 0 }
    public fun proficiency_intermediate(): u8 { 1 }
    public fun proficiency_advanced(): u8 { 2 }
    public fun proficiency_expert(): u8 { 3 }

    // ─── Dynamic-field key prefixes (OpenEAGO governance extensions) ──────────

    /// Prefix for skill dynamic fields: key = b"eago:skill:" ++ skill_id_bytes
    public fun skill_key_prefix(): vector<u8> { b"eago:skill:" }

    /// Prefix for compliance tag dynamic fields: key = b"eago:compliance:" ++ tag_bytes
    public fun compliance_key_prefix(): vector<u8> { b"eago:compliance:" }

    /// Key for the SLA metrics dynamic field (stores a SlaMetrics struct)
    public fun sla_metrics_key(): vector<u8> { b"eago:sla_metrics" }

    /// Key for the persisted risk tier dynamic field (stores a u8)
    public fun risk_tier_key(): vector<u8> { b"eago:risk_tier" }

    // ─── Global registry identifier helpers ──────────────────────────────────

    /// Produce a SUI registry global identifier string:
    /// `sui:{network}:{object_id_hex}`
    /// e.g. `sui:testnet:0xabc123...`
    public fun registry_id(network: vector<u8>, object_id_hex: vector<u8>): vector<u8> {
        let mut result = b"sui:";
        result.append(network);
        result.append(b":");
        result.append(object_id_hex);
        result
    }

    /// Full agent global identifier:
    /// `sui:{network}:{object_id_hex}:{agent_id}`
    public fun agent_global_id(network: vector<u8>, object_id_hex: vector<u8>, agent_id: u64): vector<u8> {
        let mut result = registry_id(network, object_id_hex);
        result.append(b":");
        // Append decimal representation of agent_id
        result.append(u64_to_bytes(agent_id));
        result
    }

    /// Minimal u64 → ASCII decimal byte vector
    public fun u64_to_bytes(mut n: u64): vector<u8> {
        if (n == 0) {
            return b"0"
        };
        let mut digits: vector<u8> = vector[];
        while (n > 0) {
            digits.push_back(((n % 10) as u8) + 48);
            n = n / 10;
        };
        // reverse
        let len = digits.length();
        let mut i = 0;
        while (i < len / 2) {
            let j = len - 1 - i;
            let tmp = digits[i];
            *digits.borrow_mut(i) = digits[j];
            *digits.borrow_mut(j) = tmp;
            i = i + 1;
        };
        digits
    }
}
