/// Validation Registry — SUI equivalent of the ERC-8004 Validation Registry.
///
/// Agents request third-party validation of their work by calling
/// `validation_request`. The designated validator responds with a 0–100 score
/// via `validation_response`. Multiple responses to the same request are allowed,
/// enabling progressive finality (e.g. "soft" vs "hard" finality via `tag`).
///
/// Validator incentives/slashing are handled by the specific validation protocol
/// (e.g. stake-secured re-execution, zkML verifiers, TEE oracles) and are
/// out of scope for this registry, matching ERC-8004 §Validation Registry.
module sui_a2a_registry::validation_registry {

    use std::string::String;
    use sui::event;
    use sui::table::{Self, Table};
    use sui::clock::{Self, Clock};
    use sui_a2a_registry::types;
    use sui_a2a_registry::identity_registry::{Self, AgentRegistry, AgentCap};

    // ─── Core objects ─────────────────────────────────────────────────────────

    /// Singleton shared object deployed alongside the Identity Registry.
    public struct ValidationRegistry has key {
        id: UID,
        /// Object ID of the linked Identity Registry
        identity_registry_id: ID,
        /// request_hash → ValidationEntry (latest response for that hash)
        validations: Table<vector<u8>, ValidationEntry>,
        /// agent_id → list of request_hashes for that agent
        agent_validations: Table<u64, vector<vector<u8>>>,
        /// validator_address → list of request_hashes they have been asked to validate
        validator_requests: Table<address, vector<vector<u8>>>,
    }

    /// Stores the latest validation state for a given request_hash.
    /// `validation_response` can overwrite this record to update the state.
    public struct ValidationEntry has store, drop {
        validator_address: address,
        agent_id: u64,
        /// 0 = failed/absent, 100 = passed, intermediate = partial
        response: u8,
        /// sha3_256 hash of the response_uri content (empty = not set)
        response_hash: vector<u8>,
        /// Optional categorization or additional data
        tag: String,
        last_update: u64,
        /// true once at least one `validation_response` has been recorded
        responded: bool,
    }

    /// One-time witness
    public struct VALIDATION_REGISTRY has drop {}

    // ─── Events ───────────────────────────────────────────────────────────────

    public struct ValidationRequested has copy, drop {
        validator_address: address,
        agent_id: u64,
        request_uri: String,
        request_hash: vector<u8>,
        registry_id: ID,
    }

    public struct ValidationResponded has copy, drop {
        validator_address: address,
        agent_id: u64,
        request_hash: vector<u8>,
        response: u8,
        response_uri: String,
        response_hash: vector<u8>,
        tag: String,
        registry_id: ID,
    }

    // ─── Module initialiser ───────────────────────────────────────────────────

    fun init(_witness: VALIDATION_REGISTRY, ctx: &mut TxContext) {
        let registry = ValidationRegistry {
            id: object::new(ctx),
            identity_registry_id: object::id_from_address(@0x0),
            validations: table::new(ctx),
            agent_validations: table::new(ctx),
            validator_requests: table::new(ctx),
        };
        transfer::share_object(registry);
    }

    /// One-time setup: link this Validation Registry to an Identity Registry.
    public fun initialize(
        val_registry: &mut ValidationRegistry,
        identity_registry: &AgentRegistry,
        _ctx: &mut TxContext,
    ) {
        val_registry.identity_registry_id = object::id(identity_registry);
    }

    // ─── Public entry functions ───────────────────────────────────────────────

    /// Request validation from a specific validator.
    ///
    /// - `validator_address` — the address of the validator contract/wallet.
    /// - `request_uri`       — off-chain URI with inputs/outputs for the validator.
    /// - `request_hash`      — sha3_256 commitment to the request payload (keccak256 in ERC-8004).
    ///
    /// MUST be called by the owner (via AgentCap) of the agent being validated.
    public fun validation_request(
        val_registry: &mut ValidationRegistry,
        identity_registry: &AgentRegistry,
        cap: &AgentCap,
        validator_address: address,
        request_uri: String,
        request_hash: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        // Verify cap matches the linked identity registry
        assert!(
            val_registry.identity_registry_id == object::id(identity_registry),
            types::e_registry_mismatch()
        );
        assert!(
            identity_registry::cap_registry_id(cap) == object::id(identity_registry),
            types::e_registry_mismatch()
        );

        let agent_id = identity_registry::cap_agent_id(cap);
        assert!(identity_registry::agent_exists(identity_registry, agent_id), types::e_agent_not_found());
        assert!(identity_registry::is_active(identity_registry, agent_id), types::e_agent_inactive());

        let _ = ctx;

        // Record pending validation entry (response = 0, responded = false)
        let entry = ValidationEntry {
            validator_address,
            agent_id,
            response: 0,
            response_hash: vector[],
            tag: std::string::utf8(b""),
            last_update: clock::timestamp_ms(clock),
            responded: false,
        };

        if (!table::contains(&val_registry.validations, request_hash)) {
            // Track per-agent and per-validator
            if (!table::contains(&val_registry.agent_validations, agent_id)) {
                table::add(&mut val_registry.agent_validations, agent_id, vector[]);
            };
            let agent_hashes = table::borrow_mut(&mut val_registry.agent_validations, agent_id);
            agent_hashes.push_back(request_hash);

            if (!table::contains(&val_registry.validator_requests, validator_address)) {
                table::add(&mut val_registry.validator_requests, validator_address, vector[]);
            };
            let v_hashes = table::borrow_mut(&mut val_registry.validator_requests, validator_address);
            v_hashes.push_back(request_hash);

            table::add(&mut val_registry.validations, request_hash, entry);
        } else {
            // Overwrite to re-request (re-opens the request for a new response)
            let existing = table::borrow_mut(&mut val_registry.validations, request_hash);
            *existing = entry;
        };

        event::emit(ValidationRequested {
            validator_address,
            agent_id,
            request_uri,
            request_hash,
            registry_id: object::id(val_registry),
        });
    }

    /// Submit or update a validation response.
    ///
    /// - `response`      — 0 (fail) to 100 (pass); intermediate values allowed.
    /// - `response_uri`  — optional off-chain evidence URI.
    /// - `response_hash` — sha3_256 of response_uri content.
    /// - `tag`           — optional categorisation (e.g. "soft-finality", "hard-finality").
    ///
    /// MUST be called by the `validator_address` that was designated in the request.
    /// May be called multiple times to update the validation state.
    public fun validation_response(
        val_registry: &mut ValidationRegistry,
        request_hash: vector<u8>,
        response: u8,
        response_uri: String,
        response_hash: vector<u8>,
        tag: String,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(response <= 100, types::e_invalid_response());
        assert!(table::contains(&val_registry.validations, request_hash), types::e_validation_not_found());

        let caller = tx_context::sender(ctx);
        let entry = table::borrow_mut(&mut val_registry.validations, request_hash);

        assert!(entry.validator_address == caller, types::e_wrong_validator());

        let agent_id = entry.agent_id;
        entry.response = response;
        entry.response_hash = response_hash;
        entry.tag = tag;
        entry.last_update = clock::timestamp_ms(clock);
        entry.responded = true;

        event::emit(ValidationResponded {
            validator_address: caller,
            agent_id,
            request_hash,
            response,
            response_uri,
            response_hash,
            tag,
            registry_id: object::id(val_registry),
        });
    }

    // ─── Read-only view functions ─────────────────────────────────────────────

    /// Return the linked identity registry ID.
    public fun get_identity_registry(val: &ValidationRegistry): ID {
        val.identity_registry_id
    }

    /// Get validation status for a request_hash.
    /// Returns (validator_address, agent_id, response, response_hash, tag, last_update, responded)
    public fun get_validation_status(
        val: &ValidationRegistry,
        request_hash: vector<u8>,
    ): (address, u64, u8, vector<u8>, String, u64, bool) {
        assert!(table::contains(&val.validations, request_hash), types::e_validation_not_found());
        let e = table::borrow(&val.validations, request_hash);
        (e.validator_address, e.agent_id, e.response, e.response_hash, e.tag, e.last_update, e.responded)
    }

    /// Return all request_hashes for a given agent.
    public fun get_agent_validations(val: &ValidationRegistry, agent_id: u64): vector<vector<u8>> {
        if (!table::contains(&val.agent_validations, agent_id)) { return vector[] };
        *table::borrow(&val.agent_validations, agent_id)
    }

    /// Return all request_hashes that a given validator has been asked to validate.
    public fun get_validator_requests(val: &ValidationRegistry, validator_address: address): vector<vector<u8>> {
        if (!table::contains(&val.validator_requests, validator_address)) { return vector[] };
        *table::borrow(&val.validator_requests, validator_address)
    }

    /// Aggregate validation summary for an agent.
    /// Returns (count, average_response) across all responded validations.
    /// Optional `filter_validator` (zero address = no filter) and `filter_tag`.
    public fun get_summary(
        val: &ValidationRegistry,
        agent_id: u64,
        filter_validator: address,
        filter_tag: String,
    ): (u64, u8) {
        let no_validator_filter = filter_validator == @0x0;
        let no_tag_filter = filter_tag.is_empty();

        let hashes = get_agent_validations(val, agent_id);
        let mut count: u64 = 0;
        let mut total: u64 = 0;

        let mut i = 0;
        while (i < hashes.length()) {
            let hash = hashes[i];
            if (table::contains(&val.validations, hash)) {
                let e = table::borrow(&val.validations, hash);
                if (e.responded) {
                    let validator_ok = no_validator_filter || e.validator_address == filter_validator;
                    let tag_ok = no_tag_filter || e.tag == filter_tag;
                    if (validator_ok && tag_ok) {
                        count = count + 1;
                        total = total + (e.response as u64);
                    };
                };
            };
            i = i + 1;
        };

        if (count == 0) {
            (0, 0)
        } else {
            (count, ((total / count) as u8))
        }
    }

    // ─── Test-only helpers ────────────────────────────────────────────────────

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        init(VALIDATION_REGISTRY {}, ctx);
    }
}
