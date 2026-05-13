#[test_only]
module sui_a2a_registry::reputation_tests {
    use std::string;
    use sui::test_scenario::{Self};
    use sui::clock::{Self};
    use sui_a2a_registry::identity_registry::{Self, AgentRegistry};
    use sui_a2a_registry::reputation_registry::{Self, ReputationRegistry};

    const OWNER: address = @0xA1;
    const CLIENT1: address = @0xB1;
    const CLIENT2: address = @0xB2;

    fun clock_at(ms: u64, ctx: &mut TxContext): clock::Clock {
        let mut c = clock::create_for_testing(ctx);
        clock::set_for_testing(&mut c, ms);
        c
    }

    // ─── Tests ────────────────────────────────────────────────────────────────

    #[test]
    fun test_give_feedback_basic() {
        let mut s = test_scenario::begin(OWNER);
        {
            identity_registry::init_for_testing(test_scenario::ctx(&mut s));
            reputation_registry::init_for_testing(test_scenario::ctx(&mut s));
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

        // Link reputation registry
        test_scenario::next_tx(&mut s, OWNER);
        {
            let id_reg = test_scenario::take_shared<AgentRegistry>(&s);
            let mut rep_reg = test_scenario::take_shared<ReputationRegistry>(&s);
            reputation_registry::initialize(&mut rep_reg, &id_reg, test_scenario::ctx(&mut s));
            test_scenario::return_shared(id_reg);
            test_scenario::return_shared(rep_reg);
        };

        // CLIENT1 gives feedback score = +87 (no decimals = whole number)
        test_scenario::next_tx(&mut s, CLIENT1);
        {
            let id_reg = test_scenario::take_shared<AgentRegistry>(&s);
            let mut rep_reg = test_scenario::take_shared<ReputationRegistry>(&s);
            let clock = clock_at(2000, test_scenario::ctx(&mut s));
            reputation_registry::give_feedback(
                &mut rep_reg, &id_reg,
                0,           // agent_id
                false,       // not negative
                87,          // magnitude
                0,           // decimals
                string::utf8(b"starred"),
                string::utf8(b""),
                string::utf8(b""),
                string::utf8(b""),
                vector[],
                &clock,
                test_scenario::ctx(&mut s),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(id_reg);
            test_scenario::return_shared(rep_reg);
        };

        // Verify feedback index = 1
        test_scenario::next_tx(&mut s, CLIENT1);
        {
            let rep_reg = test_scenario::take_shared<ReputationRegistry>(&s);
            let last = reputation_registry::get_last_index(&rep_reg, 0, CLIENT1);
            assert!(last == 1, 0);

            let (neg, mag, dec, tag1, tag2, revoked) = reputation_registry::read_feedback(&rep_reg, 0, CLIENT1, 1);
            assert!(!neg, 1);
            assert!(mag == 87, 2);
            assert!(dec == 0, 3);
            assert!(tag1 == string::utf8(b"starred"), 4);
            assert!(tag2 == string::utf8(b""), 5);
            assert!(!revoked, 6);

            test_scenario::return_shared(rep_reg);
        };
        test_scenario::end(s);
    }

    #[test]
    #[expected_failure(abort_code = sui_a2a_registry::types::ESelfFeedback, location = sui_a2a_registry::reputation_registry)]
    fun test_self_feedback_aborts() {
        let mut s = test_scenario::begin(OWNER);
        {
            identity_registry::init_for_testing(test_scenario::ctx(&mut s));
            reputation_registry::init_for_testing(test_scenario::ctx(&mut s));
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
            let mut rep_reg = test_scenario::take_shared<ReputationRegistry>(&s);
            reputation_registry::initialize(&mut rep_reg, &id_reg, test_scenario::ctx(&mut s));
            test_scenario::return_shared(id_reg);
            test_scenario::return_shared(rep_reg);
        };

        // OWNER tries to rate their own agent — should abort
        test_scenario::next_tx(&mut s, OWNER);
        {
            let id_reg = test_scenario::take_shared<AgentRegistry>(&s);
            let mut rep_reg = test_scenario::take_shared<ReputationRegistry>(&s);
            let clock = clock_at(2000, test_scenario::ctx(&mut s));
            reputation_registry::give_feedback(
                &mut rep_reg, &id_reg, 0, false, 100, 0,
                string::utf8(b""), string::utf8(b""),
                string::utf8(b""), string::utf8(b""),
                vector[], &clock, test_scenario::ctx(&mut s),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(id_reg);
            test_scenario::return_shared(rep_reg);
        };
        test_scenario::end(s);
    }

    #[test]
    fun test_revoke_feedback() {
        let mut s = test_scenario::begin(OWNER);
        {
            identity_registry::init_for_testing(test_scenario::ctx(&mut s));
            reputation_registry::init_for_testing(test_scenario::ctx(&mut s));
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
            let mut rep_reg = test_scenario::take_shared<ReputationRegistry>(&s);
            reputation_registry::initialize(&mut rep_reg, &id_reg, test_scenario::ctx(&mut s));
            test_scenario::return_shared(id_reg);
            test_scenario::return_shared(rep_reg);
        };

        test_scenario::next_tx(&mut s, CLIENT1);
        {
            let id_reg = test_scenario::take_shared<AgentRegistry>(&s);
            let mut rep_reg = test_scenario::take_shared<ReputationRegistry>(&s);
            let clock = clock_at(2000, test_scenario::ctx(&mut s));
            reputation_registry::give_feedback(
                &mut rep_reg, &id_reg, 0, false, 50, 0,
                string::utf8(b""), string::utf8(b""),
                string::utf8(b""), string::utf8(b""),
                vector[], &clock, test_scenario::ctx(&mut s),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(id_reg);
            test_scenario::return_shared(rep_reg);
        };

        test_scenario::next_tx(&mut s, CLIENT1);
        {
            let mut rep_reg = test_scenario::take_shared<ReputationRegistry>(&s);
            reputation_registry::revoke_feedback(&mut rep_reg, 0, 1, test_scenario::ctx(&mut s));
            let (_, _, _, _, _, revoked) = reputation_registry::read_feedback(&rep_reg, 0, CLIENT1, 1);
            assert!(revoked, 0);
            test_scenario::return_shared(rep_reg);
        };
        test_scenario::end(s);
    }

    #[test]
    fun test_summary_multiple_clients() {
        let mut s = test_scenario::begin(OWNER);
        {
            identity_registry::init_for_testing(test_scenario::ctx(&mut s));
            reputation_registry::init_for_testing(test_scenario::ctx(&mut s));
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
            let mut rep_reg = test_scenario::take_shared<ReputationRegistry>(&s);
            reputation_registry::initialize(&mut rep_reg, &id_reg, test_scenario::ctx(&mut s));
            test_scenario::return_shared(id_reg);
            test_scenario::return_shared(rep_reg);
        };

        // CLIENT1 gives +80
        test_scenario::next_tx(&mut s, CLIENT1);
        {
            let id_reg = test_scenario::take_shared<AgentRegistry>(&s);
            let mut rep_reg = test_scenario::take_shared<ReputationRegistry>(&s);
            let clock = clock_at(2000, test_scenario::ctx(&mut s));
            reputation_registry::give_feedback(
                &mut rep_reg, &id_reg, 0, false, 80, 0,
                string::utf8(b""), string::utf8(b""),
                string::utf8(b""), string::utf8(b""),
                vector[], &clock, test_scenario::ctx(&mut s),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(id_reg);
            test_scenario::return_shared(rep_reg);
        };

        // CLIENT2 gives +60
        test_scenario::next_tx(&mut s, CLIENT2);
        {
            let id_reg = test_scenario::take_shared<AgentRegistry>(&s);
            let mut rep_reg = test_scenario::take_shared<ReputationRegistry>(&s);
            let clock = clock_at(3000, test_scenario::ctx(&mut s));
            reputation_registry::give_feedback(
                &mut rep_reg, &id_reg, 0, false, 60, 0,
                string::utf8(b""), string::utf8(b""),
                string::utf8(b""), string::utf8(b""),
                vector[], &clock, test_scenario::ctx(&mut s),
            );
            clock::destroy_for_testing(clock);
            test_scenario::return_shared(id_reg);
            test_scenario::return_shared(rep_reg);
        };

        test_scenario::next_tx(&mut s, OWNER);
        {
            let rep_reg = test_scenario::take_shared<ReputationRegistry>(&s);
            let (count, pos, neg) = reputation_registry::get_summary(
                &rep_reg, 0,
                vector[CLIENT1, CLIENT2],
                string::utf8(b""),
                string::utf8(b""),
            );
            assert!(count == 2, 0);
            assert!(pos == 140, 1); // 80 + 60
            assert!(neg == 0, 2);

            let clients = reputation_registry::get_clients(&rep_reg, 0);
            assert!(clients.length() == 2, 3);
            test_scenario::return_shared(rep_reg);
        };
        test_scenario::end(s);
    }

    #[test]
    fun test_get_clients_empty() {
        let mut s = test_scenario::begin(OWNER);
        {
            reputation_registry::init_for_testing(test_scenario::ctx(&mut s));
        };
        test_scenario::next_tx(&mut s, OWNER);
        {
            let rep_reg = test_scenario::take_shared<ReputationRegistry>(&s);
            let clients = reputation_registry::get_clients(&rep_reg, 999);
            assert!(clients.length() == 0, 0);
            test_scenario::return_shared(rep_reg);
        };
        test_scenario::end(s);
    }
}
