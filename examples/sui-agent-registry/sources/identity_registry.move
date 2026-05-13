/// Identity Registry — SUI equivalent of the ERC-8004 Identity Registry,
/// extended with OpenEAGO (FINOS Labs) governance concepts:
///   - Agent type classification (framework / core / utility / flow)
///   - Jurisdiction tagging for cross-border data governance
///   - Lifecycle state machine (active → suspended / revoked / archived)
///   - Skill declarations stored as dynamic fields
///   - Compliance tag declarations stored as dynamic fields
///   - SLA metrics self-reporting aligned with OpenEAGO Appendix D.1
///   - Risk tier annotation (low / medium / high / critical)
///
/// Each agent is represented by:
///   - A shared `AgentRegistry` singleton that holds all `AgentEntry` records.
///   - An owned `AgentCap` object given to the registrant, acting as an ownership
///     proof (analogous to ERC-721 token ownership in ERC-8004).
///
/// Global agent identifier: `sui:{network}:{registry_object_id}:{agent_id}`
/// (agent_id is an incrementing u64 counter, maintaining ERC-8004 compatibility)
///
/// Dynamic fields on each `AgentEntry.id` store:
///   - Arbitrary metadata: String → vector<u8>  (ERC-8004 pattern)
///   - Agent wallet:       b"agentWallet" → address  (reserved key)
///   - Skills:             b"eago:skill:{id}" → SkillRecord
///   - Compliance tags:    b"eago:compliance:{tag}" → bool
///   - SLA metrics:        b"eago:sla_metrics" → SlaMetrics
///   - Risk tier:          b"eago:risk_tier" → u8
module sui_a2a_registry::identity_registry {

    use std::string::{Self, String};
    use sui::dynamic_field;
    use sui::event;
    use sui::object_table::{Self, ObjectTable};
    use sui::table::{Self, Table};
    use sui::clock::{Self, Clock};
    use sui_a2a_registry::types;

    // ─── Core objects ─────────────────────────────────────────────────────────

    /// Singleton shared object. Deployed once per network.
    /// Accessible globally via its Object ID.
    public struct AgentRegistry has key {
        id: UID,
        /// Monotonically increasing counter; next agent gets this value then it increments.
        counter: u64,
        /// Maps agent_id → AgentEntry (object table keeps entries as child objects).
        agents: ObjectTable<u64, AgentEntry>,
        /// Maps agent_uri → agent_id — enforces URI uniqueness at the contract level.
        uri_index: Table<String, u64>,
    }

    /// Stored as a child object inside `agents` table.
    /// The `id` carries dynamic fields (metadata, agentWallet, skills, compliance tags,
    /// SLA metrics, and risk tier — all defined by the OpenEAGO governance extensions).
    public struct AgentEntry has key, store {
        id: UID,
        agent_id: u64,
        owner: address,
        agent_uri: String,
        /// true iff lifecycle_state == lifecycle_active() (kept for backward compat)
        active: bool,
        created_at: u64,
        updated_at: u64,
        // ── OpenEAGO governance extensions ──────────────────────────────────
        /// Agent classification per OpenEAGO §3:
        ///   0 = framework, 1 = core, 2 = utility, 3 = flow
        agent_type: u8,
        /// Jurisdiction string, e.g. "US-EAST", "EU", "APAC", "GLOBAL"
        /// Used for cross-border data governance checks in OpenEAGO Phase 2.
        jurisdiction: String,
        /// OpenEAGO lifecycle state:
        ///   0 = active, 1 = suspended, 2 = revoked, 3 = archived
        lifecycle_state: u8,
    }

    /// SLA performance metrics stored as a dynamic field under key b"eago:sla_metrics".
    /// Agents self-report these values; any off-chain planner can read them to
    /// enforce the OpenEAGO Appendix D.1 minimum performance bar before selection.
    public struct SlaMetrics has store, drop {
        /// Rolling reliability score in basis points (0–10000; e.g. 9900 = 99.00%)
        /// OpenEAGO minimum: ≥ 9500 (reliability_score ≥ 0.95)
        reliability_bps: u64,
        /// Rolling uptime in basis points (0–10000; e.g. 9900 = 99.00%)
        /// OpenEAGO minimum: ≥ 9900 (availability_pct ≥ 0.9900)
        uptime_bps: u64,
        /// Rolling error rate in basis points (0–10000; e.g. 500 = 5.00%)
        /// OpenEAGO maximum: ≤ 500 (error_rate ≤ 0.05)
        error_rate_bps: u64,
        /// p99 latency in milliseconds (used for SLO feasibility in Phase 2)
        latency_p99_ms: u64,
        /// Timestamp (ms) of the last metrics update
        last_updated: u64,
    }

    /// Skill record stored as a dynamic field under key b"eago:skill:{skill_id}".
    /// Mirrors the OASF-aligned skill definition from OpenEAGO identity.md §Step 2.
    public struct SkillRecord has store, drop {
        /// Broad category, e.g. "document_processing", "text_analysis"
        skill_category: String,
        /// Domain, e.g. "legal", "finance", "compliance", "general"
        domain_category: String,
        /// Proficiency level: 0=beginner, 1=intermediate, 2=advanced, 3=expert
        proficiency_level: u8,
        /// URI pointing to extended skill metadata / OASF schema record (may be empty)
        metadata_uri: String,
    }

    /// Owned capability object transferred to the registrant.
    /// Holding this proves ownership of `agent_id` within `registry_id`.
    public struct AgentCap has key, store {
        id: UID,
        agent_id: u64,
        registry_id: ID,
    }

    /// One-time witness for module initialisation.
    public struct IDENTITY_REGISTRY has drop {}

    // ─── Events ───────────────────────────────────────────────────────────────

    public struct AgentRegistered has copy, drop {
        agent_id: u64,
        agent_uri: String,
        owner: address,
        registry_id: ID,
        // OpenEAGO governance fields included at registration time
        agent_type: u8,
        jurisdiction: String,
    }

    public struct URIUpdated has copy, drop {
        agent_id: u64,
        new_uri: String,
        updated_by: address,
        registry_id: ID,
    }

    public struct MetadataSet has copy, drop {
        agent_id: u64,
        metadata_key: String,
        registry_id: ID,
    }

    public struct AgentWalletSet has copy, drop {
        agent_id: u64,
        new_wallet: address,
        registry_id: ID,
    }

    public struct AgentWalletUnset has copy, drop {
        agent_id: u64,
        registry_id: ID,
    }

    // ── OpenEAGO governance events ────────────────────────────────────────────

    public struct AgentTypeSet has copy, drop {
        agent_id: u64,
        agent_type: u8,
        registry_id: ID,
    }

    public struct JurisdictionSet has copy, drop {
        agent_id: u64,
        jurisdiction: String,
        registry_id: ID,
    }

    /// Emitted on every lifecycle state transition.
    /// OpenEAGO identity.md: state transitions MUST be logged with actor and reason.
    public struct LifecycleStateChanged has copy, drop {
        agent_id: u64,
        old_state: u8,
        new_state: u8,
        actor: address,
        registry_id: ID,
    }

    public struct SkillSet has copy, drop {
        agent_id: u64,
        skill_id: String,
        proficiency_level: u8,
        registry_id: ID,
    }

    public struct SkillRemoved has copy, drop {
        agent_id: u64,
        skill_id: String,
        registry_id: ID,
    }

    public struct ComplianceTagAdded has copy, drop {
        agent_id: u64,
        tag: String,
        registry_id: ID,
    }

    public struct ComplianceTagRemoved has copy, drop {
        agent_id: u64,
        tag: String,
        registry_id: ID,
    }

    /// Emitted when an agent self-reports updated SLA metrics.
    /// OpenEAGO Appendix D.1: agents must meet reliability ≥ 0.95, availability ≥ 0.9900,
    /// error_rate ≤ 0.05. Values that breach these thresholds are rejected on-chain.
    public struct SlaMetricsUpdated has copy, drop {
        agent_id: u64,
        reliability_bps: u64,
        uptime_bps: u64,
        error_rate_bps: u64,
        latency_p99_ms: u64,
        registry_id: ID,
    }

    public struct RiskTierSet has copy, drop {
        agent_id: u64,
        risk_tier: u8,
        registry_id: ID,
    }

    // ─── Module initialiser ───────────────────────────────────────────────────

    fun init(_witness: IDENTITY_REGISTRY, ctx: &mut TxContext) {
        let registry = AgentRegistry {
            id: object::new(ctx),
            counter: 0,
            agents: object_table::new(ctx),
            uri_index: table::new(ctx),
        };
        transfer::share_object(registry);
    }

    // ─── Public entry functions ───────────────────────────────────────────────

    /// Register a new agent with an agent URI.
    /// Returns (via transfer) an `AgentCap` to the caller as ownership proof.
    /// OpenEAGO governance fields default to: agent_type=framework(0), jurisdiction="",
    /// lifecycle_state=active(0).
    public fun register(
        registry: &mut AgentRegistry,
        agent_uri: String,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        register_with_governance(
            registry,
            agent_uri,
            types::agent_type_framework(),
            string::utf8(b""),
            clock,
            ctx,
        )
    }

    /// Register a new agent with full OpenEAGO governance metadata.
    ///
    /// `agent_type` must be one of the four OpenEAGO classifications (0–3).
    /// `jurisdiction` is a free-form string (e.g. "US-EAST", "EU", "APAC");
    ///   it may be empty and updated later via `set_jurisdiction`.
    #[allow(lint(self_transfer))]
    public fun register_with_governance(
        registry: &mut AgentRegistry,
        agent_uri: String,
        agent_type: u8,
        jurisdiction: String,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(types::is_valid_agent_type(agent_type), types::e_invalid_agent_type());
        assert!(agent_uri.is_empty() || !table::contains(&registry.uri_index, agent_uri), types::e_duplicate_uri());

        let agent_id = registry.counter;
        registry.counter = registry.counter + 1;

        let owner = tx_context::sender(ctx);
        let now = clock::timestamp_ms(clock);

        let entry = AgentEntry {
            id: object::new(ctx),
            agent_id,
            owner,
            agent_uri: agent_uri,
            active: true,
            created_at: now,
            updated_at: now,
            agent_type,
            jurisdiction,
            lifecycle_state: types::lifecycle_active(),
        };
        let registry_id = object::id(registry);
        object_table::add(&mut registry.agents, agent_id, entry);
        if (!agent_uri.is_empty()) {
            table::add(&mut registry.uri_index, agent_uri, agent_id);
        };

        let cap = AgentCap {
            id: object::new(ctx),
            agent_id,
            registry_id,
        };

        event::emit(AgentRegistered {
            agent_id,
            agent_uri,
            owner,
            registry_id,
            agent_type,
            jurisdiction,
        });

        transfer::transfer(cap, owner);
    }

    /// Register a new agent without an initial URI (URI added later via set_agent_uri).
    /// OpenEAGO governance fields default to: agent_type=framework(0), jurisdiction="".
    public fun register_empty(
        registry: &mut AgentRegistry,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        register(registry, string::utf8(b""), clock, ctx);
    }

    /// Register without a URI but with full OpenEAGO governance metadata.
    public fun register_empty_with_governance(
        registry: &mut AgentRegistry,
        agent_type: u8,
        jurisdiction: String,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        register_with_governance(registry, string::utf8(b""), agent_type, jurisdiction, clock, ctx);
    }

    /// Update the agent URI. Caller must own the `AgentCap`.
    public fun set_agent_uri(
        registry: &mut AgentRegistry,
        cap: &AgentCap,
        new_uri: String,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_cap_matches(cap, registry);
        assert!(new_uri.is_empty() || !table::contains(&registry.uri_index, new_uri), types::e_duplicate_uri());

        let agent_id = cap.agent_id;
        let entry = object_table::borrow_mut(&mut registry.agents, agent_id);
        let old_uri = entry.agent_uri;
        entry.agent_uri = new_uri;
        entry.updated_at = clock::timestamp_ms(clock);

        // Update the URI index: remove old (if indexed), add new (if non-empty)
        if (!old_uri.is_empty()) {
            table::remove(&mut registry.uri_index, old_uri);
        };
        if (!new_uri.is_empty()) {
            table::add(&mut registry.uri_index, new_uri, agent_id);
        };

        event::emit(URIUpdated {
            agent_id,
            new_uri,
            updated_by: tx_context::sender(ctx),
            registry_id: object::id(registry),
        });
    }

    /// Set an arbitrary metadata key/value on the agent entry.
    /// The key `"agentWallet"` is reserved — use `set_agent_wallet` instead.
    public fun set_metadata(
        registry: &mut AgentRegistry,
        cap: &AgentCap,
        key: String,
        value: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_cap_matches(cap, registry);
        assert!(
            key.as_bytes() != &types::agent_wallet_key(),
            types::e_reserved_key()
        );

        let agent_id = cap.agent_id;
        let entry = object_table::borrow_mut(&mut registry.agents, agent_id);
        entry.updated_at = clock::timestamp_ms(clock);
        let _ = ctx; // consumed for potential future use

        // Add or overwrite dynamic field
        if (dynamic_field::exists(&entry.id, key)) {
            let existing: &mut vector<u8> = dynamic_field::borrow_mut(&mut entry.id, key);
            *existing = value;
        } else {
            dynamic_field::add(&mut entry.id, key, value);
        };

        event::emit(MetadataSet {
            agent_id,
            metadata_key: key,
            registry_id: object::id(registry),
        });
    }

    /// Set the agent wallet (payment address). Must own the `AgentCap`.
    /// In ERC-8004 this requires an EIP-712 signature; on SUI the cap ownership
    /// provides equivalent proof because the cap is non-copyable.
    public fun set_agent_wallet(
        registry: &mut AgentRegistry,
        cap: &AgentCap,
        new_wallet: address,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_cap_matches(cap, registry);
        let agent_id = cap.agent_id;
        let entry = object_table::borrow_mut(&mut registry.agents, agent_id);
        entry.updated_at = clock::timestamp_ms(clock);
        let _ = ctx;

        let wallet_key = string::utf8(types::agent_wallet_key());
        if (dynamic_field::exists(&entry.id, wallet_key)) {
            let existing: &mut address = dynamic_field::borrow_mut(&mut entry.id, wallet_key);
            *existing = new_wallet;
        } else {
            dynamic_field::add(&mut entry.id, wallet_key, new_wallet);
        };

        event::emit(AgentWalletSet {
            agent_id,
            new_wallet,
            registry_id: object::id(registry),
        });
    }

    /// Remove the agent wallet, resetting it to "not set".
    public fun unset_agent_wallet(
        registry: &mut AgentRegistry,
        cap: &AgentCap,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_cap_matches(cap, registry);
        let agent_id = cap.agent_id;
        let entry = object_table::borrow_mut(&mut registry.agents, agent_id);
        entry.updated_at = clock::timestamp_ms(clock);
        let _ = ctx;

        let wallet_key = string::utf8(types::agent_wallet_key());
        if (dynamic_field::exists(&entry.id, wallet_key)) {
            let _: address = dynamic_field::remove(&mut entry.id, wallet_key);
        };

        event::emit(AgentWalletUnset {
            agent_id,
            registry_id: object::id(registry),
        });
    }

    /// Deactivate (archive) an agent. Only the cap owner can do this.
    /// Sets lifecycle_state to ARCHIVED and active to false.
    public fun deactivate(
        registry: &mut AgentRegistry,
        cap: &AgentCap,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_cap_matches(cap, registry);
        let actor = tx_context::sender(ctx);
        let agent_id = cap.agent_id;
        let entry = object_table::borrow_mut(&mut registry.agents, agent_id);
        let old_state = entry.lifecycle_state;
        assert!(!types::is_terminal_lifecycle_state(old_state), types::e_invalid_lifecycle_transition());
        entry.active = false;
        entry.lifecycle_state = types::lifecycle_archived();
        entry.updated_at = clock::timestamp_ms(clock);
        event::emit(LifecycleStateChanged {
            agent_id,
            old_state,
            new_state: types::lifecycle_archived(),
            actor,
            registry_id: object::id(registry),
        });
    }

    // ── OpenEAGO governance entry functions ───────────────────────────────────

    /// Update the agent's OpenEAGO classification type.
    public fun set_agent_type(
        registry: &mut AgentRegistry,
        cap: &AgentCap,
        agent_type: u8,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_cap_matches(cap, registry);
        assert!(types::is_valid_agent_type(agent_type), types::e_invalid_agent_type());
        let _ = ctx;
        let agent_id = cap.agent_id;
        let entry = object_table::borrow_mut(&mut registry.agents, agent_id);
        entry.agent_type = agent_type;
        entry.updated_at = clock::timestamp_ms(clock);
        event::emit(AgentTypeSet { agent_id, agent_type, registry_id: object::id(registry) });
    }

    /// Update the agent's jurisdiction string.
    public fun set_jurisdiction(
        registry: &mut AgentRegistry,
        cap: &AgentCap,
        jurisdiction: String,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_cap_matches(cap, registry);
        let _ = ctx;
        let agent_id = cap.agent_id;
        let entry = object_table::borrow_mut(&mut registry.agents, agent_id);
        entry.jurisdiction = jurisdiction;
        entry.updated_at = clock::timestamp_ms(clock);
        event::emit(JurisdictionSet { agent_id, jurisdiction, registry_id: object::id(registry) });
    }

    /// Transition the agent's lifecycle state.
    ///
    /// Permitted transitions (OpenEAGO identity.md lifecycle state machine):
    ///   active (0) → suspended (1), revoked (2), or archived (3)
    ///   suspended (1) → active (0), revoked (2), or archived (3)
    /// Terminal states (revoked=2, archived=3) cannot be left.
    public fun update_lifecycle_state(
        registry: &mut AgentRegistry,
        cap: &AgentCap,
        new_state: u8,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_cap_matches(cap, registry);
        let actor = tx_context::sender(ctx);
        let agent_id = cap.agent_id;
        let entry = object_table::borrow_mut(&mut registry.agents, agent_id);
        let old_state = entry.lifecycle_state;
        // Block transitions out of terminal states
        assert!(!types::is_terminal_lifecycle_state(old_state), types::e_invalid_lifecycle_transition());
        // Ensure new_state is a known value (0–3)
        assert!(new_state <= 3, types::e_invalid_lifecycle_transition());
        entry.lifecycle_state = new_state;
        // Keep the `active` bool synchronised
        entry.active = new_state == types::lifecycle_active();
        entry.updated_at = clock::timestamp_ms(clock);
        event::emit(LifecycleStateChanged {
            agent_id,
            old_state,
            new_state,
            actor,
            registry_id: object::id(registry),
        });
    }

    /// Declare or update a skill on this agent.
    /// The skill is stored as a dynamic field keyed by b"eago:skill:" ++ skill_id_bytes.
    public fun set_skill(
        registry: &mut AgentRegistry,
        cap: &AgentCap,
        skill_id: String,
        skill_category: String,
        domain_category: String,
        proficiency_level: u8,
        metadata_uri: String,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_cap_matches(cap, registry);
        let _ = ctx;
        assert!(proficiency_level <= 3, types::e_invalid_agent_type()); // reuse error for range check
        let agent_id = cap.agent_id;
        let entry = object_table::borrow_mut(&mut registry.agents, agent_id);
        entry.updated_at = clock::timestamp_ms(clock);

        let mut field_key = string::utf8(types::skill_key_prefix());
        field_key.append(skill_id);

        let record = SkillRecord { skill_category, domain_category, proficiency_level, metadata_uri };
        if (dynamic_field::exists(&entry.id, field_key)) {
            let existing: &mut SkillRecord = dynamic_field::borrow_mut(&mut entry.id, field_key);
            *existing = record;
        } else {
            dynamic_field::add(&mut entry.id, field_key, record);
        };
        event::emit(SkillSet { agent_id, skill_id, proficiency_level, registry_id: object::id(registry) });
    }

    /// Remove a previously declared skill.
    public fun remove_skill(
        registry: &mut AgentRegistry,
        cap: &AgentCap,
        skill_id: String,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_cap_matches(cap, registry);
        let _ = ctx;
        let agent_id = cap.agent_id;
        let entry = object_table::borrow_mut(&mut registry.agents, agent_id);
        entry.updated_at = clock::timestamp_ms(clock);

        let mut field_key = string::utf8(types::skill_key_prefix());
        field_key.append(skill_id);

        if (dynamic_field::exists(&entry.id, field_key)) {
            let _: SkillRecord = dynamic_field::remove(&mut entry.id, field_key);
        };
        event::emit(SkillRemoved { agent_id, skill_id, registry_id: object::id(registry) });
    }

    /// Assert a regulatory/compliance certification (e.g. "SOX", "GDPR", "HIPAA").
    /// Stored as a dynamic field keyed by b"eago:compliance:" ++ tag_bytes.
    public fun add_compliance_tag(
        registry: &mut AgentRegistry,
        cap: &AgentCap,
        tag: String,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_cap_matches(cap, registry);
        let _ = ctx;
        let agent_id = cap.agent_id;
        let entry = object_table::borrow_mut(&mut registry.agents, agent_id);
        entry.updated_at = clock::timestamp_ms(clock);

        let mut field_key = string::utf8(types::compliance_key_prefix());
        field_key.append(tag);

        if (!dynamic_field::exists(&entry.id, field_key)) {
            dynamic_field::add(&mut entry.id, field_key, true);
        };
        event::emit(ComplianceTagAdded { agent_id, tag, registry_id: object::id(registry) });
    }

    /// Retract a compliance certification.
    public fun remove_compliance_tag(
        registry: &mut AgentRegistry,
        cap: &AgentCap,
        tag: String,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_cap_matches(cap, registry);
        let _ = ctx;
        let agent_id = cap.agent_id;
        let entry = object_table::borrow_mut(&mut registry.agents, agent_id);
        entry.updated_at = clock::timestamp_ms(clock);

        let mut field_key = string::utf8(types::compliance_key_prefix());
        field_key.append(tag);

        if (dynamic_field::exists(&entry.id, field_key)) {
            let _: bool = dynamic_field::remove(&mut entry.id, field_key);
        };
        event::emit(ComplianceTagRemoved { agent_id, tag, registry_id: object::id(registry) });
    }

    /// Self-report SLA performance metrics aligned with OpenEAGO Appendix D.1.
    ///
    /// All values are in basis points (0–10_000) except latency_p99_ms (milliseconds).
    /// The function aborts if any value breaches the OpenEAGO minimum performance bar:
    ///   reliability_bps ≥ 9500  (≥ 95.00%)
    ///   uptime_bps      ≥ 9900  (≥ 99.00%)
    ///   error_rate_bps  ≤  500  (≤  5.00%)
    public fun update_sla_metrics(
        registry: &mut AgentRegistry,
        cap: &AgentCap,
        reliability_bps: u64,
        uptime_bps: u64,
        error_rate_bps: u64,
        latency_p99_ms: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_cap_matches(cap, registry);
        let _ = ctx;
        // Enforce OpenEAGO Appendix D.1 minimum performance bar
        let min_rel = (types::min_reliability() as u64) * 100; // 9500
        assert!(reliability_bps >= min_rel, types::e_sla_threshold_not_met());
        assert!(uptime_bps >= types::min_uptime_bps(), types::e_sla_threshold_not_met());
        assert!(error_rate_bps <= types::max_error_rate_bps(), types::e_sla_threshold_not_met());

        let agent_id = cap.agent_id;
        let entry = object_table::borrow_mut(&mut registry.agents, agent_id);
        let now = clock::timestamp_ms(clock);
        entry.updated_at = now;

        let metrics = SlaMetrics { reliability_bps, uptime_bps, error_rate_bps, latency_p99_ms, last_updated: now };
        let sla_key = string::utf8(types::sla_metrics_key());
        if (dynamic_field::exists(&entry.id, sla_key)) {
            let existing: &mut SlaMetrics = dynamic_field::borrow_mut(&mut entry.id, sla_key);
            *existing = metrics;
        } else {
            dynamic_field::add(&mut entry.id, sla_key, metrics);
        };
        event::emit(SlaMetricsUpdated {
            agent_id,
            reliability_bps,
            uptime_bps,
            error_rate_bps,
            latency_p99_ms,
            registry_id: object::id(registry),
        });
    }

    /// Set the agent's risk tier (low=0, medium=1, high=2, critical=3) per OpenEAGO Appendix E.2.
    /// This is typically set by a trusted external process after computing the composite_risk_score.
    public fun set_risk_tier(
        registry: &mut AgentRegistry,
        cap: &AgentCap,
        risk_tier: u8,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_cap_matches(cap, registry);
        assert!(types::is_valid_risk_tier(risk_tier), types::e_invalid_risk_tier());
        let _ = ctx;
        let agent_id = cap.agent_id;
        let entry = object_table::borrow_mut(&mut registry.agents, agent_id);
        entry.updated_at = clock::timestamp_ms(clock);

        let tier_key = string::utf8(types::risk_tier_key());
        if (dynamic_field::exists(&entry.id, tier_key)) {
            let existing: &mut u8 = dynamic_field::borrow_mut(&mut entry.id, tier_key);
            *existing = risk_tier;
        } else {
            dynamic_field::add(&mut entry.id, tier_key, risk_tier);
        };
        event::emit(RiskTierSet { agent_id, risk_tier, registry_id: object::id(registry) });
    }

    // ─── Read-only view functions ─────────────────────────────────────────────

    public fun agent_count(registry: &AgentRegistry): u64 {
        registry.counter
    }

    public fun agent_exists(registry: &AgentRegistry, agent_id: u64): bool {
        object_table::contains(&registry.agents, agent_id)
    }

    public fun get_agent_uri(registry: &AgentRegistry, agent_id: u64): String {
        assert!(object_table::contains(&registry.agents, agent_id), types::e_agent_not_found());
        let entry = object_table::borrow(&registry.agents, agent_id);
        entry.agent_uri
    }

    public fun get_agent_owner(registry: &AgentRegistry, agent_id: u64): address {
        assert!(object_table::contains(&registry.agents, agent_id), types::e_agent_not_found());
        let entry = object_table::borrow(&registry.agents, agent_id);
        entry.owner
    }

    public fun is_active(registry: &AgentRegistry, agent_id: u64): bool {
        if (!object_table::contains(&registry.agents, agent_id)) { return false };
        object_table::borrow(&registry.agents, agent_id).active
    }

    public fun get_agent_wallet(registry: &AgentRegistry, agent_id: u64): Option<address> {
        assert!(object_table::contains(&registry.agents, agent_id), types::e_agent_not_found());
        let entry = object_table::borrow(&registry.agents, agent_id);
        let wallet_key = string::utf8(types::agent_wallet_key());
        if (dynamic_field::exists(&entry.id, wallet_key)) {
            option::some(*dynamic_field::borrow<String, address>(&entry.id, wallet_key))
        } else {
            option::none()
        }
    }

    public fun get_metadata(registry: &AgentRegistry, agent_id: u64, key: String): Option<vector<u8>> {
        assert!(object_table::contains(&registry.agents, agent_id), types::e_agent_not_found());
        let entry = object_table::borrow(&registry.agents, agent_id);
        if (dynamic_field::exists(&entry.id, key)) {
            option::some(*dynamic_field::borrow<String, vector<u8>>(&entry.id, key))
        } else {
            option::none()
        }
    }

    // ── OpenEAGO governance read-only views ───────────────────────────────────

    /// Return the OpenEAGO agent type (0=framework, 1=core, 2=utility, 3=flow).
    public fun get_agent_type(registry: &AgentRegistry, agent_id: u64): u8 {
        assert!(object_table::contains(&registry.agents, agent_id), types::e_agent_not_found());
        object_table::borrow(&registry.agents, agent_id).agent_type
    }

    /// Return the agent's jurisdiction string (may be empty if not set).
    public fun get_jurisdiction(registry: &AgentRegistry, agent_id: u64): String {
        assert!(object_table::contains(&registry.agents, agent_id), types::e_agent_not_found());
        object_table::borrow(&registry.agents, agent_id).jurisdiction
    }

    /// Return the agent's current lifecycle state (0=active, 1=suspended, 2=revoked, 3=archived).
    public fun get_lifecycle_state(registry: &AgentRegistry, agent_id: u64): u8 {
        assert!(object_table::contains(&registry.agents, agent_id), types::e_agent_not_found());
        object_table::borrow(&registry.agents, agent_id).lifecycle_state
    }

    /// Return true if the agent has declared the given skill.
    public fun has_skill(registry: &AgentRegistry, agent_id: u64, skill_id: String): bool {
        if (!object_table::contains(&registry.agents, agent_id)) { return false };
        let entry = object_table::borrow(&registry.agents, agent_id);
        let mut field_key = string::utf8(types::skill_key_prefix());
        field_key.append(skill_id);
        dynamic_field::exists(&entry.id, field_key)
    }

    /// Return true if the agent holds the given compliance tag.
    public fun has_compliance_tag(registry: &AgentRegistry, agent_id: u64, tag: String): bool {
        if (!object_table::contains(&registry.agents, agent_id)) { return false };
        let entry = object_table::borrow(&registry.agents, agent_id);
        let mut field_key = string::utf8(types::compliance_key_prefix());
        field_key.append(tag);
        dynamic_field::exists(&entry.id, field_key)
    }

    /// Return the agent's self-reported risk tier, defaulting to low(0) if not set.
    public fun get_risk_tier(registry: &AgentRegistry, agent_id: u64): u8 {
        if (!object_table::contains(&registry.agents, agent_id)) { return types::risk_tier_low() };
        let entry = object_table::borrow(&registry.agents, agent_id);
        let tier_key = string::utf8(types::risk_tier_key());
        if (dynamic_field::exists(&entry.id, tier_key)) {
            *dynamic_field::borrow<String, u8>(&entry.id, tier_key)
        } else {
            types::risk_tier_low()
        }
    }

    /// Return true if the agent meets the OpenEAGO Appendix D.1 minimum SLA bar.
    /// Returns false if no SLA metrics have been reported yet.
    public fun meets_sla_minimum(registry: &AgentRegistry, agent_id: u64): bool {
        if (!object_table::contains(&registry.agents, agent_id)) { return false };
        let entry = object_table::borrow(&registry.agents, agent_id);
        let sla_key = string::utf8(types::sla_metrics_key());
        if (!dynamic_field::exists(&entry.id, sla_key)) { return false };
        let m = dynamic_field::borrow<String, SlaMetrics>(&entry.id, sla_key);
        let min_rel = (types::min_reliability() as u64) * 100;
        m.reliability_bps >= min_rel
            && m.uptime_bps >= types::min_uptime_bps()
            && m.error_rate_bps <= types::max_error_rate_bps()
    }

    /// Return basic agent info as a tuple:
    ///   (owner, uri, active, created_at, updated_at, agent_type, jurisdiction, lifecycle_state)
    public fun get_agent_info(
        registry: &AgentRegistry,
        agent_id: u64
    ): (address, String, bool, u64, u64, u8, String, u8) {
        assert!(object_table::contains(&registry.agents, agent_id), types::e_agent_not_found());
        let e = object_table::borrow(&registry.agents, agent_id);
        (e.owner, e.agent_uri, e.active, e.created_at, e.updated_at,
         e.agent_type, e.jurisdiction, e.lifecycle_state)
    }

    /// Return the AgentCap's agent_id and registry_id (for cross-module validation)
    public fun cap_agent_id(cap: &AgentCap): u64 { cap.agent_id }
    public fun cap_registry_id(cap: &AgentCap): ID { cap.registry_id }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    fun assert_cap_matches(cap: &AgentCap, registry: &AgentRegistry) {
        assert!(cap.registry_id == object::id(registry), types::e_registry_mismatch());
        assert!(object_table::contains(&registry.agents, cap.agent_id), types::e_agent_not_found());
    }

    // ─── Test-only helpers ────────────────────────────────────────────────────

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        init(IDENTITY_REGISTRY {}, ctx);
    }
}
