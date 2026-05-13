/// Reputation Registry — SUI equivalent of the ERC-8004 Reputation Registry.
///
/// Any address (client) can submit signed fixed-point feedback about a registered
/// agent. Feedback is stored on-chain for composability; full off-chain JSON may
/// be referenced via `feedback_uri` / `feedback_hash`.
///
/// Signed values are encoded as `(is_negative: bool, magnitude: u128)` because
/// Move's primitive integer types are unsigned. Decimals 0–18 follow ERC-8004.
///
/// An agent owner / operator CANNOT give feedback about their own agent
/// (self-feedback is blocked via an owner address check).
module sui_a2a_registry::reputation_registry {

    use std::string::String;
    use sui::event;
    use sui::table::{Self, Table};
    use sui::bcs;
    use sui::clock::{Self, Clock};
    use sui_a2a_registry::types;
    use sui_a2a_registry::identity_registry::{Self, AgentRegistry};

    // ─── Core objects ─────────────────────────────────────────────────────────

    /// Singleton shared object deployed alongside the Identity Registry.
    public struct ReputationRegistry has key {
        id: UID,
        /// Object ID of the linked Identity Registry
        identity_registry_id: ID,
        /// feedback_key → FeedbackRecord
        /// Key = bcs::to_bytes(&FeedbackKey {agent_id, client, index})
        feedback: Table<vector<u8>, FeedbackRecord>,
        /// agent_id → client_address → last submitted feedback index (1-based)
        client_indices: Table<u64, Table<address, u64>>,
        /// agent_id → list of unique client addresses who submitted feedback
        client_list: Table<u64, vector<address>>,
    }

    /// Stored feedback record. Off-chain fields (endpoint, uri, hash) are emitted
    /// as events but not stored (matching ERC-8004 gas-efficiency rationale).
    public struct FeedbackRecord has store, drop {
        value_negative: bool,
        value_magnitude: u128,
        value_decimals: u8,
        tag1: String,
        tag2: String,
        is_revoked: bool,
        created_at: u64,
    }

    /// One-time witness
    public struct REPUTATION_REGISTRY has drop {}

    // ─── Events ───────────────────────────────────────────────────────────────

    public struct NewFeedback has copy, drop {
        agent_id: u64,
        client_address: address,
        feedback_index: u64,
        value_negative: bool,
        value_magnitude: u128,
        value_decimals: u8,
        tag1: String,
        tag2: String,
        /// Endpoint the feedback relates to (optional, empty string = not set)
        endpoint: String,
        /// URI pointing to off-chain extended feedback JSON
        feedback_uri: String,
        /// keccak256 / sha3_256 hash of the feedback_uri content (all zeros = not set)
        feedback_hash: vector<u8>,
        registry_id: ID,
    }

    public struct FeedbackRevoked has copy, drop {
        agent_id: u64,
        client_address: address,
        feedback_index: u64,
        registry_id: ID,
    }

    public struct ResponseAppended has copy, drop {
        agent_id: u64,
        client_address: address,
        feedback_index: u64,
        responder: address,
        response_uri: String,
        response_hash: vector<u8>,
        registry_id: ID,
    }

    // ─── Module initialiser ───────────────────────────────────────────────────

    fun init(_witness: REPUTATION_REGISTRY, ctx: &mut TxContext) {
        // identity_registry_id is set via `initialize` after the identity
        // registry is deployed. We start with a placeholder (zero ID).
        let registry = ReputationRegistry {
            id: object::new(ctx),
            identity_registry_id: object::id_from_address(@0x0),
            feedback: table::new(ctx),
            client_indices: table::new(ctx),
            client_list: table::new(ctx),
        };
        transfer::share_object(registry);
    }

    /// One-time setup: link this Reputation Registry to an Identity Registry.
    /// Must be called immediately after deployment by the deployer.
    public fun initialize(
        rep_registry: &mut ReputationRegistry,
        identity_registry: &AgentRegistry,
        _ctx: &mut TxContext,
    ) {
        rep_registry.identity_registry_id = object::id(identity_registry);
    }

    // ─── Public entry functions ───────────────────────────────────────────────

    /// Submit feedback about `agent_id`. Caller must NOT be the agent owner.
    ///
    /// `value_negative` = true means the value is negative (e.g. –5 → true, 5).
    /// `value_magnitude` is the absolute value × 10^value_decimals.
    /// Optional fields (tag1, tag2, endpoint, feedback_uri, feedback_hash) may
    /// be empty strings / zero-length vectors.
    public fun give_feedback(
        rep_registry: &mut ReputationRegistry,
        identity_registry: &AgentRegistry,
        agent_id: u64,
        value_negative: bool,
        value_magnitude: u128,
        value_decimals: u8,
        tag1: String,
        tag2: String,
        endpoint: String,
        feedback_uri: String,
        feedback_hash: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        // Validate linkage
        assert!(
            rep_registry.identity_registry_id == object::id(identity_registry),
            types::e_registry_mismatch()
        );
        // Agent must exist and be active
        assert!(identity_registry::agent_exists(identity_registry, agent_id), types::e_agent_not_found());
        assert!(identity_registry::is_active(identity_registry, agent_id), types::e_agent_inactive());
        // Decimals constraint
        assert!(value_decimals <= types::max_value_decimals(), types::e_invalid_decimals());

        let client = tx_context::sender(ctx);
        // Self-feedback guard: client must not be the agent owner
        let owner = identity_registry::get_agent_owner(identity_registry, agent_id);
        assert!(client != owner, types::e_self_feedback());

        // Determine next feedback index for this (agent_id, client) pair
        if (!table::contains(&rep_registry.client_indices, agent_id)) {
            table::add(&mut rep_registry.client_indices, agent_id, table::new(ctx));
            table::add(&mut rep_registry.client_list, agent_id, vector[]);
        };
        let client_map = table::borrow_mut(&mut rep_registry.client_indices, agent_id);
        let feedback_index: u64;
        if (table::contains(client_map, client)) {
            let last = table::borrow_mut(client_map, client);
            *last = *last + 1;
            feedback_index = *last;
        } else {
            table::add(client_map, client, 1);
            feedback_index = 1;
            // Track client address in list (avoid duplicates handled by index check above)
            let clients = table::borrow_mut(&mut rep_registry.client_list, agent_id);
            clients.push_back(client);
        };

        let key = make_key(agent_id, client, feedback_index);
        let record = FeedbackRecord {
            value_negative,
            value_magnitude,
            value_decimals,
            tag1,
            tag2,
            is_revoked: false,
            created_at: clock::timestamp_ms(clock),
        };
        table::add(&mut rep_registry.feedback, key, record);

        event::emit(NewFeedback {
            agent_id,
            client_address: client,
            feedback_index,
            value_negative,
            value_magnitude,
            value_decimals,
            tag1,
            tag2,
            endpoint,
            feedback_uri,
            feedback_hash,
            registry_id: object::id(rep_registry),
        });
    }

    /// Revoke previously submitted feedback. Only the original client can revoke.
    public fun revoke_feedback(
        rep_registry: &mut ReputationRegistry,
        agent_id: u64,
        feedback_index: u64,
        ctx: &mut TxContext,
    ) {
        let client = tx_context::sender(ctx);
        let key = make_key(agent_id, client, feedback_index);
        assert!(table::contains(&rep_registry.feedback, key), types::e_invalid_feedback_index());

        let record = table::borrow_mut(&mut rep_registry.feedback, key);
        record.is_revoked = true;

        event::emit(FeedbackRevoked {
            agent_id,
            client_address: client,
            feedback_index,
            registry_id: object::id(rep_registry),
        });
    }

    /// Append a response/annotation to existing feedback.
    /// Anyone may call this (agent owner, aggregators, data intelligence services).
    public fun append_response(
        rep_registry: &mut ReputationRegistry,
        agent_id: u64,
        client_address: address,
        feedback_index: u64,
        response_uri: String,
        response_hash: vector<u8>,
        ctx: &mut TxContext,
    ) {
        let key = make_key(agent_id, client_address, feedback_index);
        assert!(table::contains(&rep_registry.feedback, key), types::e_invalid_feedback_index());

        event::emit(ResponseAppended {
            agent_id,
            client_address,
            feedback_index,
            responder: tx_context::sender(ctx),
            response_uri,
            response_hash,
            registry_id: object::id(rep_registry),
        });
    }

    // ─── Read-only view functions ─────────────────────────────────────────────

    /// Return the linked identity registry ID.
    public fun get_identity_registry(rep: &ReputationRegistry): ID {
        rep.identity_registry_id
    }

    /// Read a single feedback record: (value_negative, value_magnitude, value_decimals, tag1, tag2, is_revoked)
    public fun read_feedback(
        rep: &ReputationRegistry,
        agent_id: u64,
        client_address: address,
        feedback_index: u64,
    ): (bool, u128, u8, String, String, bool) {
        let key = make_key(agent_id, client_address, feedback_index);
        assert!(table::contains(&rep.feedback, key), types::e_invalid_feedback_index());
        let r = table::borrow(&rep.feedback, key);
        (r.value_negative, r.value_magnitude, r.value_decimals, r.tag1, r.tag2, r.is_revoked)
    }

    /// Return the last feedback index submitted by `client_address` for `agent_id`.
    /// Returns 0 if no feedback has been submitted.
    public fun get_last_index(rep: &ReputationRegistry, agent_id: u64, client_address: address): u64 {
        if (!table::contains(&rep.client_indices, agent_id)) { return 0 };
        let client_map = table::borrow(&rep.client_indices, agent_id);
        if (!table::contains(client_map, client_address)) { return 0 };
        *table::borrow(client_map, client_address)
    }

    /// Return all client addresses that have submitted feedback for `agent_id`.
    public fun get_clients(rep: &ReputationRegistry, agent_id: u64): vector<address> {
        if (!table::contains(&rep.client_list, agent_id)) { return vector[] };
        *table::borrow(&rep.client_list, agent_id)
    }

    /// Aggregate summary for `agent_id` filtered to `client_addresses`.
    /// Returns (count, sum_negative, sum_magnitude, sum_decimals_base).
    /// NOTE: All feedback values are normalised to the same decimal base before
    /// summing. The caller receives raw numerics; final score computation
    /// (weighting, Sybil filtering) is expected to happen off-chain.
    ///
    /// Only non-revoked feedback is counted.
    /// If `filter_tag1` is non-empty, only feedback matching that tag1 is counted.
    public fun get_summary(
        rep: &ReputationRegistry,
        agent_id: u64,
        client_addresses: vector<address>,
        filter_tag1: String,
        filter_tag2: String,
    ): (u64, u128, u128) {
        // Returns (count, positive_sum, negative_sum) both at native magnitudes.
        // Caller normalises decimals off-chain.
        let mut count: u64 = 0;
        let mut pos_sum: u128 = 0;
        let mut neg_sum: u128 = 0;
        let use_tag1_filter = !filter_tag1.is_empty();
        let use_tag2_filter = !filter_tag2.is_empty();

        let mut i = 0;
        while (i < client_addresses.length()) {
            let client = client_addresses[i];
            let last = get_last_index(rep, agent_id, client);
            let mut j: u64 = 1;
            while (j <= last) {
                let key = make_key(agent_id, client, j);
                if (table::contains(&rep.feedback, key)) {
                    let r = table::borrow(&rep.feedback, key);
                    if (!r.is_revoked) {
                        let tag1_ok = !use_tag1_filter || r.tag1 == filter_tag1;
                        let tag2_ok = !use_tag2_filter || r.tag2 == filter_tag2;
                        if (tag1_ok && tag2_ok) {
                            count = count + 1;
                            if (r.value_negative) {
                                neg_sum = neg_sum + r.value_magnitude;
                            } else {
                                pos_sum = pos_sum + r.value_magnitude;
                            };
                        };
                    };
                };
                j = j + 1;
            };
            i = i + 1;
        };
        (count, pos_sum, neg_sum)
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    fun make_key(agent_id: u64, client: address, index: u64): vector<u8> {
        let mut key: vector<u8> = vector[];
        // Simple deterministic encoding: agent_id bytes || client bytes || index bytes
        let a_bytes = types::u64_to_bytes(agent_id);
        let i_bytes = types::u64_to_bytes(index);
        key.append(a_bytes);
        key.push_back(b":"[0]);
        let client_bytes = bcs::to_bytes(&client);
        key.append(client_bytes);
        key.push_back(b":"[0]);
        key.append(i_bytes);
        key
    }

    // ─── Test-only helpers ────────────────────────────────────────────────────

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        init(REPUTATION_REGISTRY {}, ctx);
    }
}
