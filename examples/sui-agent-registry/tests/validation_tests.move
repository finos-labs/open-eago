#[test_only]
module sui_a2a_registry::validation_tests {
    use std::string;
    use sui::test_scenario::{Self};
    use sui::clock::{Self};
    use sui_a2a_registry::identity_registry::{Self, AgentRegistry, AgentCap};
    use sui_a2a_registry::validation_registry::{Self, ValidationRegistry};

    const OWNER: address = @0xA1;
    const VALIDATOR: address = @0xC1;
    const OTHER: address = @0xC2;

    fun clock_at(ms: u64, ctx: &mut TxContext): clock::Clock {
        let mut c = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut c, ms);
        c
    }

    #[test]
    fun test_validation_request_and_response() {
        let mut s = test_scenario::begin(OWNER);
        {
            identity_registry::init_for_testing(test_scenario::ctx(&mut s));
            validation_registry::init_for_testing(test_scenario::ctx(&mut s));
        };

        // Register agent
        test_scenario::next_tx(&mut s, OWNER);
        {
            let mut id_reg = test_scenario::take_shared<AgentRegistry>(&s);
            let clock = clock_at(1000, test_scenario::ctx(&mut s));
            identity_registry::register(&mut id_reg, string::utf8(b"uri"), &clock, test_scenario::ctx(&mut s));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(id_reg);
        };

        // Link validation registry
        test_scenario::next_tx(&mut s, OWNER);
        {
            let id_reg = test_scenario::take_shared<AgentRegistry>(&s);
            let mut val_reg = test_scenario::take_shared<ValidationRegistry>(&s);
            validation_registry::initialize(&mut val_reg, &id_reg, test_scenario::ctx(&mut s));
            test_scenario::return_shared(id_reg);
            test_scenario::return_shared(val_reg);
        };

        // Request validation
        test_scenario::next_tx(&mut s, OWNER);
        {
            let id_reg = test_scenario::take_shared<AgentRegistry>(&s);
            let mut val_reg = test_scenario::take_shared<ValidationRegistry>(&s);
            let cap = test_scenario::take_from_address<AgentCap>(&s, OWNER);
            let clock = clock_at(2000, test_scenario::ctx(&mut s));

            validation_registry::validation_request(
                &mut val_reg, &id_reg, &cap,
                VALIDATOR,
                string::utf8(b"https://evidence.example.com/req1.json"),
                b"sha3_abc123",
                &clock,
                test_scenario::ctx(&mut s),
            );

            // Verify pending entry exists
            let (val_addr, a_id, resp, _resp_hash, _tag, _lu, responded) =
                validation_registry::get_validation_status(&val_reg, b"sha3_abc123");
            assert!(val_addr == VALIDATOR, 0);
            assert!(a_id == 0, 1);
            assert!(resp == 0, 2);
            assert!(!responded, 3);

            clock::destroy_for_testing(clock);
            test_scenario::return_to_address(OWNER, cap);
            test_scenario::return_shared(id_reg);
            test_scenario::return_shared(val_reg);
        };

        // Validator responds
        test_scenario::next_tx(&mut s, VALIDATOR);
        {
            let mut val_reg = test_scenario::take_shared<ValidationRegistry>(&s);
            let clock = clock_at(3000, test_scenario::ctx(&mut s));

            validation_registry::validation_response(
                &mut val_reg,
                b"sha3_abc123",
                100,  // passed
                string::utf8(b"https://evidence.example.com/resp1.json"),
                b"hash_of_response",
                string::utf8(b"hard-finality"),
                &clock,
                test_scenario::ctx(&mut s),
            );

            let (_, _, resp, _, tag, _, responded) =
                validation_registry::get_validation_status(&val_reg, b"sha3_abc123");
            assert!(resp == 100, 4);
            assert!(tag == string::utf8(b"hard-finality"), 5);
            assert!(responded, 6);

            clock::destroy_for_testing(clock);
            test_scenario::return_shared(val_reg);
        };

        // Summary: (count=1, average=100)
        test_scenario::next_tx(&mut s, OWNER);
        {
            let val_reg = test_scenario::take_shared<ValidationRegistry>(&s);
            let (count, avg) = validation_registry::get_summary(
                &val_reg, 0, @0x0, string::utf8(b"")
            );
            assert!(count == 1, 7);
            assert!(avg == 100, 8);
            test_scenario::return_shared(val_reg);
        };
        test_scenario::end(s);
    }

    #[test]
    #[expected_failure(abort_code = sui_a2a_registry::types::EWrongValidator, location = sui_a2a_registry::validation_registry)]
    fun test_wrong_validator_aborts() {
        let mut s = test_scenario::begin(OWNER);
        {
            identity_registry::init_for_testing(test_scenario::ctx(&mut s));
            validation_registry::init_for_testing(test_scenario::ctx(&mut s));
        };

        test_scenario::next_tx(&mut s, OWNER);
        {
            let mut id_reg = test_scenario::take_shared<AgentRegistry>(&s);
            let clock = clock_at(1000, test_scenario::ctx(&mut s));
            identity_registry::register(&mut id_reg, string::utf8(b"uri"), &clock, test_scenario::ctx(&mut s));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(id_reg);
        };

        test_scenario::next_tx(&mut s, OWNER);
        {
            let id_reg = test_scenario::take_shared<AgentRegistry>(&s);
            let mut val_reg = test_scenario::take_shared<ValidationRegistry>(&s);
            validation_registry::initialize(&mut val_reg, &id_reg, test_scenario::ctx(&mut s));
            test_scenario::return_shared(id_reg);
            test_scenario::return_shared(val_reg);
        };

        test_scenario::next_tx(&mut s, OWNER);
        {
            let id_reg = test_scenario::take_shared<AgentRegistry>(&s);
            let mut val_reg = test_scenario::take_shared<ValidationRegistry>(&s);
            let cap = test_scenario::take_from_address<AgentCap>(&s, OWNER);
            let clock = clock_at(2000, test_scenario::ctx(&mut s));
            validation_registry::validation_request(
                &mut val_reg, &id_reg, &cap,
                VALIDATOR,
                string::utf8(b"uri"),
                b"hash_xyz",
                &clock,
                test_scenario::ctx(&mut s),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_to_address(OWNER, cap);
            test_scenario::return_shared(id_reg);
            test_scenario::return_shared(val_reg);
        };

        // OTHER tries to respond — should abort
        test_scenario::next_tx(&mut s, OTHER);
        {
            let mut val_reg = test_scenario::take_shared<ValidationRegistry>(&s);
            let clock = clock_at(3000, test_scenario::ctx(&mut s));
            validation_registry::validation_response(
                &mut val_reg, b"hash_xyz", 100,
                string::utf8(b""), vector[],
                string::utf8(b""),
                &clock, test_scenario::ctx(&mut s),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(val_reg);
        };
        test_scenario::end(s);
    }

    #[test]
    fun test_progressive_response() {
        let mut s = test_scenario::begin(OWNER);
        {
            identity_registry::init_for_testing(test_scenario::ctx(&mut s));
            validation_registry::init_for_testing(test_scenario::ctx(&mut s));
        };

        test_scenario::next_tx(&mut s, OWNER);
        {
            let mut id_reg = test_scenario::take_shared<AgentRegistry>(&s);
            let clock = clock_at(1000, test_scenario::ctx(&mut s));
            identity_registry::register(&mut id_reg, string::utf8(b"uri"), &clock, test_scenario::ctx(&mut s));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(id_reg);
        };

        test_scenario::next_tx(&mut s, OWNER);
        {
            let id_reg = test_scenario::take_shared<AgentRegistry>(&s);
            let mut val_reg = test_scenario::take_shared<ValidationRegistry>(&s);
            validation_registry::initialize(&mut val_reg, &id_reg, test_scenario::ctx(&mut s));
            test_scenario::return_shared(id_reg);
            test_scenario::return_shared(val_reg);
        };

        test_scenario::next_tx(&mut s, OWNER);
        {
            let id_reg = test_scenario::take_shared<AgentRegistry>(&s);
            let mut val_reg = test_scenario::take_shared<ValidationRegistry>(&s);
            let cap = test_scenario::take_from_address<AgentCap>(&s, OWNER);
            let clock = clock_at(2000, test_scenario::ctx(&mut s));
            validation_registry::validation_request(
                &mut val_reg, &id_reg, &cap, VALIDATOR,
                string::utf8(b"uri"), b"hash_prog",
                &clock, test_scenario::ctx(&mut s),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_to_address(OWNER, cap);
            test_scenario::return_shared(id_reg);
            test_scenario::return_shared(val_reg);
        };

        // First response: soft finality (50)
        test_scenario::next_tx(&mut s, VALIDATOR);
        {
            let mut val_reg = test_scenario::take_shared<ValidationRegistry>(&s);
            let clock = clock_at(3000, test_scenario::ctx(&mut s));
            validation_registry::validation_response(
                &mut val_reg, b"hash_prog", 50,
                string::utf8(b""), vector[],
                string::utf8(b"soft-finality"),
                &clock, test_scenario::ctx(&mut s),
            );
            let (_, _, resp, _, tag, _, _) = validation_registry::get_validation_status(&val_reg, b"hash_prog");
            assert!(resp == 50, 0);
            assert!(tag == string::utf8(b"soft-finality"), 1);
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(val_reg);
        };

        // Second response: hard finality (100)
        test_scenario::next_tx(&mut s, VALIDATOR);
        {
            let mut val_reg = test_scenario::take_shared<ValidationRegistry>(&s);
            let clock = clock_at(4000, test_scenario::ctx(&mut s));
            validation_registry::validation_response(
                &mut val_reg, b"hash_prog", 100,
                string::utf8(b""), vector[],
                string::utf8(b"hard-finality"),
                &clock, test_scenario::ctx(&mut s),
            );
            let (_, _, resp, _, tag, _, _) = validation_registry::get_validation_status(&val_reg, b"hash_prog");
            assert!(resp == 100, 2);
            assert!(tag == string::utf8(b"hard-finality"), 3);
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(val_reg);
        };
        test_scenario::end(s);
    }

    #[test]
    fun test_get_agent_validations() {
        let mut s = test_scenario::begin(OWNER);
        {
            identity_registry::init_for_testing(test_scenario::ctx(&mut s));
            validation_registry::init_for_testing(test_scenario::ctx(&mut s));
        };

        test_scenario::next_tx(&mut s, OWNER);
        {
            let mut id_reg = test_scenario::take_shared<AgentRegistry>(&s);
            let clock = clock_at(1000, test_scenario::ctx(&mut s));
            identity_registry::register(&mut id_reg, string::utf8(b"uri"), &clock, test_scenario::ctx(&mut s));
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(id_reg);
        };

        test_scenario::next_tx(&mut s, OWNER);
        {
            let id_reg = test_scenario::take_shared<AgentRegistry>(&s);
            let mut val_reg = test_scenario::take_shared<ValidationRegistry>(&s);
            validation_registry::initialize(&mut val_reg, &id_reg, test_scenario::ctx(&mut s));
            test_scenario::return_shared(id_reg);
            test_scenario::return_shared(val_reg);
        };

        // Two requests with different hashes
        test_scenario::next_tx(&mut s, OWNER);
        {
            let id_reg = test_scenario::take_shared<AgentRegistry>(&s);
            let mut val_reg = test_scenario::take_shared<ValidationRegistry>(&s);
            let cap = test_scenario::take_from_address<AgentCap>(&s, OWNER);
            let clock = clock_at(2000, test_scenario::ctx(&mut s));
            validation_registry::validation_request(
                &mut val_reg, &id_reg, &cap, VALIDATOR,
                string::utf8(b"uri"), b"hash_1",
                &clock, test_scenario::ctx(&mut s),
            );
            validation_registry::validation_request(
                &mut val_reg, &id_reg, &cap, VALIDATOR,
                string::utf8(b"uri"), b"hash_2",
                &clock, test_scenario::ctx(&mut s),
            );
            let hashes = validation_registry::get_agent_validations(&val_reg, 0);
            assert!(hashes.length() == 2, 0);

            let vr = validation_registry::get_validator_requests(&val_reg, VALIDATOR);
            assert!(vr.length() == 2, 1);

            clock::destroy_for_testing(clock);
            test_scenario::return_to_address(OWNER, cap);
            test_scenario::return_shared(id_reg);
            test_scenario::return_shared(val_reg);
        };
        test_scenario::end(s);
    }
}
