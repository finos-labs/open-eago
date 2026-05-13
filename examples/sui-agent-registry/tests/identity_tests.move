#[test_only]
module sui_a2a_registry::identity_tests {
    use std::string;
    use sui::test_scenario::{Self, Scenario};
    use sui::clock::{Self};
    use sui_a2a_registry::identity_registry::{
        Self, AgentRegistry, AgentCap
    };

    const OWNER: address = @0xA1;

    // ─── Helpers ──────────────────────────────────────────────────────────────

    fun setup(): Scenario {
        let mut s = test_scenario::begin(OWNER);
        {
            identity_registry::init_for_testing(test_scenario::ctx(&mut s));
        };
        s
    }

    fun clock_ms(s: &mut Scenario, ms: u64): clock::Clock {
        let mut c = clock::create_for_testing(test_scenario::ctx(s));
        clock::set_for_testing(&mut c, ms);
        c
    }

    // ─── Tests ────────────────────────────────────────────────────────────────

    #[test]
    fun test_register_basic() {
        let mut s = setup();
        test_scenario::next_tx(&mut s, OWNER);
        {
            let mut registry = test_scenario::take_shared<AgentRegistry>(&s);
            let clock = clock_ms(&mut s, 1000);

            identity_registry::register(
                &mut registry,
                string::utf8(b"https://example.com/agent.json"),
                &clock,
                test_scenario::ctx(&mut s),
            );

            assert!(identity_registry::agent_count(&registry) == 1, 0);
            assert!(identity_registry::agent_exists(&registry, 0), 1);
            assert!(identity_registry::is_active(&registry, 0), 2);

            let uri = identity_registry::get_agent_uri(&registry, 0);
            assert!(uri == string::utf8(b"https://example.com/agent.json"), 3);

            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
        };

        // Cap should have been transferred to OWNER
        test_scenario::next_tx(&mut s, OWNER);
        {
            assert!(test_scenario::has_most_recent_for_address<AgentCap>(OWNER), 4);
        };
        test_scenario::end(s);
    }

    #[test]
    fun test_register_empty_then_set_uri() {
        let mut s = setup();
        test_scenario::next_tx(&mut s, OWNER);
        {
            let mut registry = test_scenario::take_shared<AgentRegistry>(&s);
            let clock = clock_ms(&mut s, 1000);
            identity_registry::register_empty(&mut registry, &clock, test_scenario::ctx(&mut s));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
        };

        test_scenario::next_tx(&mut s, OWNER);
        {
            let mut registry = test_scenario::take_shared<AgentRegistry>(&s);
            let cap = test_scenario::take_from_address<AgentCap>(&s, OWNER);
            let clock = clock_ms(&mut s, 2000);

            identity_registry::set_agent_uri(
                &mut registry,
                &cap,
                string::utf8(b"ipfs://Qm123"),
                &clock,
                test_scenario::ctx(&mut s),
            );

            let uri = identity_registry::get_agent_uri(&registry, 0);
            assert!(uri == string::utf8(b"ipfs://Qm123"), 0);

            clock::destroy_for_testing(clock);
            test_scenario::return_to_address(OWNER, cap);
            test_scenario::return_shared(registry);
        };
        test_scenario::end(s);
    }

    #[test]
    fun test_set_agent_wallet() {
        let mut s = setup();
        test_scenario::next_tx(&mut s, OWNER);
        {
            let mut registry = test_scenario::take_shared<AgentRegistry>(&s);
            let clock = clock_ms(&mut s, 1000);
            identity_registry::register(&mut registry, string::utf8(b"uri"), &clock, test_scenario::ctx(&mut s));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
        };

        test_scenario::next_tx(&mut s, OWNER);
        {
            let mut registry = test_scenario::take_shared<AgentRegistry>(&s);
            let cap = test_scenario::take_from_address<AgentCap>(&s, OWNER);
            let clock = clock_ms(&mut s, 2000);

            identity_registry::set_agent_wallet(&mut registry, &cap, @0xBEEF, &clock, test_scenario::ctx(&mut s));
            let wallet = identity_registry::get_agent_wallet(&registry, 0);
            assert!(wallet == option::some(@0xBEEF), 0);

            identity_registry::unset_agent_wallet(&mut registry, &cap, &clock, test_scenario::ctx(&mut s));
            let wallet2 = identity_registry::get_agent_wallet(&registry, 0);
            assert!(option::is_none(&wallet2), 1);

            clock::destroy_for_testing(clock);
            test_scenario::return_to_address(OWNER, cap);
            test_scenario::return_shared(registry);
        };
        test_scenario::end(s);
    }

    #[test]
    fun test_set_metadata() {
        let mut s = setup();
        test_scenario::next_tx(&mut s, OWNER);
        {
            let mut registry = test_scenario::take_shared<AgentRegistry>(&s);
            let clock = clock_ms(&mut s, 1000);
            identity_registry::register(&mut registry, string::utf8(b"uri"), &clock, test_scenario::ctx(&mut s));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
        };

        test_scenario::next_tx(&mut s, OWNER);
        {
            let mut registry = test_scenario::take_shared<AgentRegistry>(&s);
            let cap = test_scenario::take_from_address<AgentCap>(&s, OWNER);
            let clock = clock_ms(&mut s, 2000);

            identity_registry::set_metadata(
                &mut registry, &cap,
                string::utf8(b"capabilities"),
                b"[\"text-generation\",\"code-review\"]",
                &clock,
                test_scenario::ctx(&mut s),
            );

            let meta = identity_registry::get_metadata(&registry, 0, string::utf8(b"capabilities"));
            assert!(option::is_some(&meta), 0);
            assert!(*option::borrow(&meta) == b"[\"text-generation\",\"code-review\"]", 1);

            // Non-existent key returns none
            let missing = identity_registry::get_metadata(&registry, 0, string::utf8(b"nonexistent"));
            assert!(option::is_none(&missing), 2);

            clock::destroy_for_testing(clock);
            test_scenario::return_to_address(OWNER, cap);
            test_scenario::return_shared(registry);
        };
        test_scenario::end(s);
    }

    #[test]
    #[expected_failure(abort_code = sui_a2a_registry::types::EReservedKey, location = sui_a2a_registry::identity_registry)]
    fun test_set_metadata_reserved_key_aborts() {
        let mut s = setup();
        test_scenario::next_tx(&mut s, OWNER);
        {
            let mut registry = test_scenario::take_shared<AgentRegistry>(&s);
            let clock = clock_ms(&mut s, 1000);
            identity_registry::register(&mut registry, string::utf8(b"uri"), &clock, test_scenario::ctx(&mut s));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
        };

        test_scenario::next_tx(&mut s, OWNER);
        {
            let mut registry = test_scenario::take_shared<AgentRegistry>(&s);
            let cap = test_scenario::take_from_address<AgentCap>(&s, OWNER);
            let clock = clock_ms(&mut s, 2000);

            // Should abort with EReservedKey
            identity_registry::set_metadata(
                &mut registry, &cap,
                string::utf8(b"agentWallet"), // reserved!
                b"0xdeadbeef",
                &clock,
                test_scenario::ctx(&mut s),
            );

            clock::destroy_for_testing(clock);
            test_scenario::return_to_address(OWNER, cap);
            test_scenario::return_shared(registry);
        };
        test_scenario::end(s);
    }

    #[test]
    #[expected_failure(abort_code = sui_a2a_registry::types::ERegistryMismatch, location = sui_a2a_registry::identity_registry)]
    fun test_wrong_registry_cap_aborts() {
        // Only registry A exists at this point.
        let mut s = setup();

        // Capture registry A's ID before registry B exists.
        test_scenario::next_tx(&mut s, OWNER);
        let registry_a_id = {
            let reg_a = test_scenario::take_shared<AgentRegistry>(&s);
            let id = object::id(&reg_a);
            test_scenario::return_shared(reg_a);
            id
        };

        // Register in registry A -> capA.registry_id = id(A).
        test_scenario::next_tx(&mut s, OWNER);
        {
            let mut reg_a = test_scenario::take_shared_by_id<AgentRegistry>(&s, registry_a_id);
            let clock = clock_ms(&mut s, 1000);
            identity_registry::register(&mut reg_a, string::utf8(b"uri"), &clock, test_scenario::ctx(&mut s));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(reg_a);
        };

        // Create registry B.
        test_scenario::next_tx(&mut s, OWNER);
        {
            identity_registry::init_for_testing(test_scenario::ctx(&mut s));
        };

        // Use capA (registry_id=A) against registry B -> abort ERegistryMismatch.
        test_scenario::next_tx(&mut s, OWNER);
        {
            let cap_a = test_scenario::take_from_sender<AgentCap>(&s);
            // Remove A from contention so the next take_shared returns B.
            let reg_a_temp = test_scenario::take_shared_by_id<AgentRegistry>(&s, registry_a_id);
            let mut reg_b = test_scenario::take_shared<AgentRegistry>(&s);
            let clock = clock_ms(&mut s, 2000);
            // capA.registry_id (A) != object::id(reg_b) -> aborts here
            identity_registry::set_agent_uri(
                &mut reg_b,
                &cap_a,
                string::utf8(b"new-uri"),
                &clock,
                test_scenario::ctx(&mut s),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(reg_a_temp);
            test_scenario::return_shared(reg_b);
            test_scenario::return_to_sender(&s, cap_a);
        };
        test_scenario::end(s);
    }

    #[test]
    fun test_multiple_agents() {
        let mut s = setup();
        test_scenario::next_tx(&mut s, OWNER);
        {
            let mut registry = test_scenario::take_shared<AgentRegistry>(&s);
            let clock = clock_ms(&mut s, 1000);
            identity_registry::register(&mut registry, string::utf8(b"uri0"), &clock, test_scenario::ctx(&mut s));
            identity_registry::register(&mut registry, string::utf8(b"uri1"), &clock, test_scenario::ctx(&mut s));
            identity_registry::register(&mut registry, string::utf8(b"uri2"), &clock, test_scenario::ctx(&mut s));
            assert!(identity_registry::agent_count(&registry) == 3, 0);
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
        };
        test_scenario::end(s);
    }

    #[test]
    fun test_deactivate() {
        let mut s = setup();
        test_scenario::next_tx(&mut s, OWNER);
        {
            let mut registry = test_scenario::take_shared<AgentRegistry>(&s);
            let clock = clock_ms(&mut s, 1000);
            identity_registry::register(&mut registry, string::utf8(b"uri"), &clock, test_scenario::ctx(&mut s));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(registry);
        };

        test_scenario::next_tx(&mut s, OWNER);
        {
            let mut registry = test_scenario::take_shared<AgentRegistry>(&s);
            let cap = test_scenario::take_from_address<AgentCap>(&s, OWNER);
            let clock = clock_ms(&mut s, 2000);
            assert!(identity_registry::is_active(&registry, 0), 0);
            identity_registry::deactivate(&mut registry, &cap, &clock, test_scenario::ctx(&mut s));
            assert!(!identity_registry::is_active(&registry, 0), 1);
            clock::destroy_for_testing(clock);
            test_scenario::return_to_address(OWNER, cap);
            test_scenario::return_shared(registry);
        };
        test_scenario::end(s);
    }
}
