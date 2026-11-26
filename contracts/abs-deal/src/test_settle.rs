#![cfg(test)]
//! Tests of the events of a payment date, of the two rules of a settlement
//! over several structures, and of the network limits.
//!
//! `Fixture::run` checks each payment date at once: conservation and the
//! balance invariant from the `period_settled` event alone, then the event
//! against the ledgers.

extern crate std;

use crate::fixture::*;
use crate::test_d1::{
    factor_deal, on_need_deal, pct_deal, pro_rata_deal, ranks, switch_deal, two_fee_deal, PARI, SEQ,
};
use crate::*;
use soroban_sdk::testutils::{Address as _, Events as _};
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{Address, Env, Event};
use Item::{Fee, Interest, Principal, ReserveRefill, Residual};

/// Network limits of one transaction and of one ledger entry, read from
/// mainnet and testnet on 2026-11-17.
const TX_MAX_WRITE_ENTRIES: u32 = 200;
const TX_MAX_READ_ENTRIES: u32 = 200;
const TX_MAX_FOOTPRINT_ENTRIES: u32 = 400;
const TX_MAX_EVENTS_BYTES: u32 = 16_384;
const ENTRY_MAX_BYTES: u32 = 65_536;

fn reference_deal() -> Fixture {
    build(|_, _, _| {})
}

/// Junior interest after senior principal.
fn junior_deal() -> Fixture {
    build(|e, config, _| {
        config.normal = ranks(
            e,
            &[
                ("fees", Cond::Always, SEQ, &[Fee(0)]),
                ("int_a", Cond::Always, SEQ, &[Interest(0)]),
                ("reserve", Cond::Always, SEQ, &[ReserveRefill]),
                ("prin_a", Cond::Always, SEQ, &[Principal(0)]),
                ("int_b", Cond::Always, SEQ, &[Interest(1)]),
                ("prin_b", Cond::Always, SEQ, &[Principal(1)]),
                ("int_c", Cond::Always, SEQ, &[Interest(2)]),
                ("prin_c", Cond::Always, SEQ, &[Principal(2)]),
                ("residual", Cond::Always, SEQ, &[Residual]),
            ],
        );
    })
}

/// Structurally different priorities of payments, all from one contract.
fn structures() -> std::vec::Vec<(&'static str, fn() -> Fixture)> {
    std::vec![
        ("reference", reference_deal as fn() -> Fixture),
        ("pro rata", pro_rata_deal),
        ("pro rata then sequential", || switch_deal(true)),
        ("sequential then pro rata", || factor_deal(Op::Le, 9_100_000)),
        ("junior interest after senior principal", junior_deal),
        ("on-need reserve", on_need_deal),
        ("percent reserve", pct_deal),
        ("two fee lines", || two_fee_deal(false)),
    ]
}

/// The asset in every account that a deal can pay.
fn asset_total(fx: &Fixture) -> i128 {
    let mut total = fx.balance(&fx.deal.address)
        + fx.balance(&fx.agent.address)
        + fx.balance(&fx.seller)
        + fx.balance(&fx.fees)
        + fx.balance(&fx.fees_2)
        + fx.balance(&fx.servicer);
    for investor in fx.investors.iter() {
        total += fx.balance(investor);
    }
    total
}

// --- Events -----------------------------------------------------------------

#[test]
fn rank_lines_list_each_item_in_execution_order() {
    let fx = reference_deal();
    fx.close();
    let period = fx.run(1, 100_000);
    let e = &fx.e;
    // The reference order, rank by rank. A line gives the due, the amount
    // paid and the per-note dust that goes to the carry.
    assert_eq!(
        period.lines,
        std::vec![
            line(e, "fees", Fee(0), 50, 50, 0),
            line(e, "int_a", Interest(0), 2_340, 2_000, 340),
            line(e, "int_b", Interest(1), 583, 0, 583),
            line(e, "int_c", Interest(2), 562, 450, 112),
            line(e, "reserve", ReserveRefill, 5_000, 5_000, 0),
            line(e, "principal", Principal(0), 1_000_000, 96_000, 465),
            line(e, "principal", Principal(1), 700_000, 0, 0),
            line(e, "principal", Principal(2), 450_000, 0, 0),
        ]
    );
    assert!(!period.enforced);
    assert_eq!(
        period.settled,
        Settled {
            collections: 100_000,
            reserve_in: 5_000,
            carry_in: 0,
            drawn: 0,
            paid_out: 50 + 2_000 + 450 + 96_000,
            reserve: 5_000,
            carry: 1_500,
            owed: 0,
            balance: 6_500,
            surplus: 0,
        }
    );
    // The next period opens with the ledgers of this one.
    let next = fx.run(2, 0);
    assert_eq!(next.settled.reserve_in, 5_000);
    assert_eq!(next.settled.carry_in, 1_500);
}

#[test]
fn the_events_of_the_reference_order_keep_their_topics_and_data() {
    let fx = reference_deal();
    fx.close();
    fx.sac.mint(&fx.servicer, &100_000);
    fx.deal.distribute(&1, &100_000);
    let e = &fx.e;
    let deal = &fx.deal.address;
    // The events that the indexer reads, in their order, then the two new
    // events of the rank engine.
    let expected = std::vec![
        ReserveReleased { amount: 5_000 }.to_xdr(e, deal),
        Distribution { period: 1, collections: 100_000, reserve_released: 5_000, carry_in: 0, ada: 105_000 }
            .to_xdr(e, deal),
        FeesPaid { recipient: fx.fees.clone(), amount: 50 }.to_xdr(e, deal),
        InterestPaid { class: 0, period: 1, due: 2_340, paid: 2_000, shortfall: 0, dust: 340 }.to_xdr(e, deal),
        InterestPaid { class: 1, period: 1, due: 583, paid: 0, shortfall: 0, dust: 583 }.to_xdr(e, deal),
        InterestPaid { class: 2, period: 1, due: 562, paid: 450, shortfall: 0, dust: 112 }.to_xdr(e, deal),
        ReserveRefunded { amount: 5_000, balance: 5_000 }.to_xdr(e, deal),
        PrincipalPaid { class: 0, period: 1, paid: 96_000, per_note: 96, outstanding_after: 904_000 }
            .to_xdr(e, deal),
        FactorUpdated { class: 0, period: 1, factor: 9_040_000, per_note_outstanding: 904 }.to_xdr(e, deal),
        CarryUpdated { period: 1, carry: 1_500 }.to_xdr(e, deal),
        RankLines {
            period: 1,
            enforced: false,
            lines: soroban_sdk::vec![
                e,
                line(e, "fees", Fee(0), 50, 50, 0),
                line(e, "int_a", Interest(0), 2_340, 2_000, 340),
                line(e, "int_b", Interest(1), 583, 0, 583),
                line(e, "int_c", Interest(2), 562, 450, 112),
                line(e, "reserve", ReserveRefill, 5_000, 5_000, 0),
                line(e, "principal", Principal(0), 1_000_000, 96_000, 465),
                line(e, "principal", Principal(1), 700_000, 0, 0),
                line(e, "principal", Principal(2), 450_000, 0, 0),
            ],
        }
        .to_xdr(e, deal),
        PeriodSettled {
            period: 1,
            collections: 100_000,
            reserve_in: 5_000,
            carry_in: 0,
            drawn: 0,
            paid_out: 98_500,
            reserve: 5_000,
            carry: 1_500,
            owed: 0,
            balance: 6_500,
            surplus: 0,
        }
        .to_xdr(e, deal),
    ];
    assert_eq!(e.events().all().filter_by_contract(deal), expected);
}

#[test]
fn a_trigger_is_published_after_the_events_of_the_ranks() {
    let fx = switch_deal(true);
    fx.close();
    fx.run(1, 0);
    fx.sac.mint(&fx.servicer, &100_000);
    fx.deal.distribute(&2, &100_000);
    let e = &fx.e;
    let deal = &fx.deal.address;
    let events = e.events().all().filter_by_contract(deal);
    let list = events.events();
    // ... carry_updated, trigger_breached, rank_lines, period_settled.
    let breached = TriggerBreached { id: sym(e, "seq"), period: 2 }.to_xdr(e, deal);
    let carry = CarryUpdated { period: 2, carry: 2_000 }.to_xdr(e, deal);
    assert_eq!(list[list.len() - 4], carry);
    assert_eq!(list[list.len() - 3], breached);
}

#[test]
fn period_settled_reports_the_surplus_of_the_maturity_sweep() {
    let fx = reference_deal();
    fx.close();
    // A direct transfer to the deal: a surplus, outside the ledgers.
    fx.sac.mint(&fx.deal.address, &7);
    let period = fx.run(1, 50 + 3_485 + FACE + 123);
    assert_eq!(fx.deal.get_state(), State::Matured);
    // The Seller takes the residual 123, the reserve 5,000, the carry 1,035,
    // and the surplus 7.
    assert_eq!(
        period.settled,
        Settled {
            collections: 50 + 3_485 + FACE + 123,
            reserve_in: 5_000,
            carry_in: 0,
            drawn: 0,
            paid_out: 50 + (2_000 + 450 + FACE) + (123 + 5_000 + 1_035),
            reserve: 0,
            carry: 0,
            owed: 0,
            balance: 0,
            surplus: 7,
        }
    );
    assert_eq!(fx.balance(&fx.seller), FACE + 123 + 5_000 + 1_035 + 7);
}

#[test]
fn a_surplus_stays_idle_before_the_maturity() {
    let fx = reference_deal();
    fx.close();
    fx.sac.mint(&fx.deal.address, &7);
    let period = fx.run(1, 100_000);
    // The surplus is in the balance, not in a ledger: the balance is above
    // the reserve, the carry and the amounts owed.
    assert_eq!(period.settled.surplus, 0);
    assert_eq!(period.settled.balance, period.settled.reserve + period.settled.carry + 7);
}

#[test]
fn payout_parked_keeps_its_rank_codes() {
    // The issuer of the asset froze the fees recipient and the Seller.
    let fx = build_with(true, |_, _, _| {});
    fx.close();
    fx.sac.set_authorized(&fx.fees, &false);
    fx.sac.set_authorized(&fx.seller, &false);
    fx.sac.mint(&fx.servicer, &(50 + 3_485 + FACE + 123));
    fx.deal.distribute(&1, &(50 + 3_485 + FACE + 123));
    let e = &fx.e;
    let deal = &fx.deal.address;
    let events = e.events().all().filter_by_contract(deal);
    // Code 1 for a fee line, code 7 for the residual: the codes of the
    // deals that run the earlier code.
    let fee = PayoutParked { recipient: fx.fees.clone(), period: 1, rank: 1, amount: 50 }.to_xdr(e, deal);
    let residual =
        PayoutParked { recipient: fx.seller.clone(), period: 1, rank: 7, amount: 123 + 5_000 + 1_035 }.to_xdr(e, deal);
    assert!(events.events().contains(&fee));
    assert!(events.events().contains(&residual));
    // A parked payout left the ledgers: it is in `paid_out` and in `owed`.
    let settled = PeriodSettled {
        period: 1,
        collections: 50 + 3_485 + FACE + 123,
        reserve_in: 5_000,
        carry_in: 0,
        drawn: 0,
        paid_out: 50 + (2_000 + 450 + FACE) + (123 + 5_000 + 1_035),
        reserve: 0,
        carry: 0,
        owed: 50 + 123 + 5_000 + 1_035,
        balance: 50 + 123 + 5_000 + 1_035,
        surplus: 0,
    }
    .to_xdr(e, deal);
    assert!(events.events().contains(&settled));
    assert_eq!(fx.deal.get_state(), State::Matured);
}

// --- The two rules, over several structures -----------------------------------

#[test]
fn the_ledgers_balance_each_period_for_each_structure() {
    for (name, make) in structures() {
        let fx = make();
        fx.close();
        let mut minted = FACE + fx.deal.get_reserve();
        assert_eq!(asset_total(&fx), minted, "{name}, closing");
        // Periods with cash, with no cash, and with almost no cash. `run`
        // checks conservation and the balance invariant on each one.
        for (index, collections) in [40_000i128, 0, 250_000, 0, 5, 600_000].iter().enumerate() {
            let number = index as u32 + 1;
            let period = fx.run(number, *collections);
            minted += collections;
            // No unit of the asset is created or lost.
            assert_eq!(asset_total(&fx), minted, "{name}, period {number}");
            // The cash of the paying agent is the cash of the noteholder lines.
            let mut noteholders = 0i128;
            for line in period.lines.iter() {
                if matches!(line.1, Interest(_) | Principal(_)) {
                    noteholders += line.3;
                }
            }
            let mut paid = 0i128;
            for amount in period.paid.iter() {
                paid += amount;
            }
            assert_eq!(paid, noteholders, "{name}, period {number}");
            assert_eq!(fx.deal.get_state(), State::Amortizing, "{name}, period {number}");
        }
    }
}

#[test]
fn each_structure_runs_to_maturity_and_leaves_nothing() {
    for (name, make) in structures() {
        let fx = make();
        fx.close();
        let mut number = 0u32;
        while fx.deal.get_state() != State::Matured {
            number += 1;
            assert!(number <= 12, "{name} does not mature");
            fx.run(number, 400_000);
            fx.push_all(number);
        }
        assert_eq!(fx.balance(&fx.deal.address), 0, "{name}");
        assert_eq!(fx.deal.get_reserve(), 0, "{name}");
        assert_eq!(fx.deal.get_carry(), 0, "{name}");
        assert_eq!(fx.per_note(), [0, 0, 0], "{name}");
        // A repaid class has no unpaid interest.
        assert_eq!(fx.shortfalls(), [0, 0, 0], "{name}");
        // Every holder got its full principal, and its counters match what
        // arrived in its account.
        for (class, investor) in fx.investors.iter().enumerate() {
            let totals = fx.agent.get_holder_totals(&(class as u32), investor);
            assert_eq!(totals.principal_paid, NOTES[class] * DENOMINATION, "{name}, class {class}");
            assert_eq!(fx.balance(investor), totals.interest_paid + totals.principal_paid, "{name}");
        }
        // Classes A and C got interest. The interest of Class B is below 1
        // unit for each note in this deal: it all went to the carry.
        assert!(fx.balance(&fx.investors[0]) > NOTES[0] * DENOMINATION, "{name}");
        assert!(fx.balance(&fx.investors[2]) > NOTES[2] * DENOMINATION, "{name}");
    }
}

// --- Network limits -----------------------------------------------------------

/// An id of 32 characters, the longest Symbol.
fn long_id(e: &Env, number: u32) -> soroban_sdk::Symbol {
    sym(e, &std::format!("rank_with_a_long_identifier_{number:04}"))
}

/// The largest structure that `validate` accepts: 8 classes, 4 fee lines, 4
/// triggers, a normal order of 24 ranks and 39 items with ids of 32
/// characters. Interest and principal each have a pari passu rank and a
/// rank-per-class variant, on opposite conditions.
pub(crate) fn largest(e: &Env, config: &mut DealConfig, parties: &Parties) {
    let mut classes: Vec<ClassTerms> = Vec::new(e);
    for index in 0..8i128 {
        let rate = if index == 0 { RateSpec::Floating(600) } else { RateSpec::Fixed(1_000 + 250 * index) };
        classes.push_back(ClassTerms { rate, total_notes: 10, floor: Some(0), index_floor: Some(0) });
    }
    config.classes = classes;
    config.fees = Vec::new(e);
    for (index, recipient) in
        [parties.fees.clone(), parties.fees_2.clone(), Address::generate(e), Address::generate(e)].iter().enumerate()
    {
        let amount = if index % 2 == 0 { FeeAmount::Fixed(10) } else { FeeAmount::PerAnnum(500) };
        config.fees.push_back(FeeLine { recipient: recipient.clone(), amount });
    }
    // Four triggers that are set from the first period.
    config.triggers = soroban_sdk::vec![
        e,
        TriggerTerms { id: long_id(e, 9001), metric: Metric::NotesFactor, op: Op::Le, threshold: FACTOR_SCALE, latch: true },
        TriggerTerms { id: long_id(e, 9002), metric: Metric::ClassFactor(7), op: Op::Le, threshold: FACTOR_SCALE, latch: true },
        TriggerTerms { id: long_id(e, 9003), metric: Metric::ReserveShortfall, op: Op::Ge, threshold: 0, latch: false },
        TriggerTerms { id: long_id(e, 9004), metric: Metric::ClassShortfall(3), op: Op::Ge, threshold: 0, latch: false },
    ];
    let set = |id: u32| Cond::Trigger(long_id(e, id));
    let unset = |id: u32| Cond::NotTrigger(long_id(e, id));
    let rank = |number: u32, when: Cond, alloc: RankAlloc, items: Vec<Item>| Rank { id: long_id(e, number), when, alloc, items };
    let all = |make: fn(u32) -> Item| {
        let mut items: Vec<Item> = Vec::new(e);
        for class in 0..8u32 {
            items.push_back(make(class));
        }
        items
    };

    let mut normal: Vec<Rank> = Vec::new(e);
    normal.push_back(rank(1, Cond::Always, SEQ, soroban_sdk::vec![e, Fee(0), Fee(1)]));
    normal.push_back(rank(2, Cond::Always, SEQ, soroban_sdk::vec![e, Fee(2)]));
    normal.push_back(rank(3, Cond::Always, SEQ, soroban_sdk::vec![e, Fee(3)]));
    for class in 0..8u32 {
        normal.push_back(rank(10 + class, unset(9001), SEQ, soroban_sdk::vec![e, Interest(class)]));
    }
    normal.push_back(rank(20, set(9001), PARI, all(Interest)));
    normal.push_back(rank(21, unset(9003), SEQ, soroban_sdk::vec![e, ReserveRefill]));
    normal.push_back(rank(22, set(9003), SEQ, soroban_sdk::vec![e, ReserveRefill]));
    for class in 0..8u32 {
        normal.push_back(rank(30 + class, unset(9002), SEQ, soroban_sdk::vec![e, Principal(class)]));
    }
    normal.push_back(rank(40, set(9002), PARI, all(Principal)));
    normal.push_back(rank(50, Cond::Always, SEQ, soroban_sdk::vec![e, Residual]));
    config.normal = normal;

    let mut enforced: Vec<Rank> = Vec::new(e);
    enforced.push_back(rank(1, Cond::Always, SEQ, soroban_sdk::vec![e, Fee(0), Fee(1), Fee(2), Fee(3)]));
    for class in 0..8u32 {
        enforced.push_back(rank(60 + class, Cond::Always, SEQ, soroban_sdk::vec![e, Interest(class), Principal(class)]));
    }
    enforced.push_back(rank(50, Cond::Always, SEQ, soroban_sdk::vec![e, Residual]));
    config.enforced = enforced;
    config.reserve = ReserveTerms {
        required: RequiredRule::PctOfNotes(5_000, 100),
        release: Release::Full,
        draw_ranks: Vec::new(e),
    };
}

/// Fail when the last invocation exceeds the network limits of a transaction.
fn assert_fits_network(e: &Env, what: &str) -> u32 {
    let used = e.cost_estimate().resources();
    let footprint = used.disk_read_entries + used.memory_read_entries + used.write_entries;
    std::println!(
        "{what}: write_entries {} disk_read_entries {} footprint {} events_bytes {}",
        used.write_entries, used.disk_read_entries, footprint, used.contract_events_size_bytes
    );
    assert!(used.write_entries <= TX_MAX_WRITE_ENTRIES, "{what}: write entries");
    assert!(used.disk_read_entries <= TX_MAX_READ_ENTRIES, "{what}: read entries");
    assert!(footprint <= TX_MAX_FOOTPRINT_ENTRIES, "{what}: footprint");
    assert!(used.contract_events_size_bytes <= TX_MAX_EVENTS_BYTES, "{what}: events");
    used.contract_events_size_bytes
}

#[test]
fn the_largest_structure_is_valid_and_one_more_rank_or_item_is_refused() {
    let fx = build(largest);
    assert_eq!(fx.config.normal.len(), MAX_RANKS);
    let mut items = 0u32;
    for rank in fx.config.normal.iter() {
        items += rank.items.len();
    }
    assert_eq!(items, 39);
    assert_eq!(validate(&fx.config), Ok(()));

    // A 25th rank.
    let e = &fx.e;
    let mut config = fx.config.clone();
    let mut order: Vec<Rank> = Vec::new(e);
    for (position, rank) in config.normal.iter().enumerate() {
        if position == 0 {
            // Split the first fee rank in two ranks.
            order.push_back(Rank { id: long_id(e, 1), when: Cond::Always, alloc: SEQ, items: soroban_sdk::vec![e, Fee(0)] });
            order.push_back(Rank { id: long_id(e, 4), when: Cond::Always, alloc: SEQ, items: soroban_sdk::vec![e, Fee(1)] });
        } else {
            order.push_back(rank);
        }
    }
    config.normal = order;
    assert_eq!(config.normal.len(), MAX_RANKS + 1);
    assert_eq!(validate(&config), Err(DealError::InvalidConfig));

    // 43 items in 23 ranks: each fee line in two ranks, on opposite conditions.
    let mut config = fx.config.clone();
    let mut order: Vec<Rank> = Vec::new(e);
    let fees = soroban_sdk::vec![e, Fee(0), Fee(1), Fee(2), Fee(3)];
    order.push_back(Rank { id: long_id(e, 1), when: off_id(e, 9004), alloc: SEQ, items: fees.clone() });
    order.push_back(Rank { id: long_id(e, 2), when: on_id(e, 9004), alloc: PARI, items: fees });
    for (position, rank) in config.normal.iter().enumerate() {
        if position >= 3 {
            order.push_back(rank);
        }
    }
    config.normal = order;
    assert_eq!(config.normal.len(), 23);
    assert_eq!(validate(&config), Err(DealError::InvalidConfig));
}

fn on_id(e: &Env, number: u32) -> Cond {
    Cond::Trigger(long_id(e, number))
}

fn off_id(e: &Env, number: u32) -> Cond {
    Cond::NotTrigger(long_id(e, number))
}

#[test]
fn the_largest_configuration_fits_one_ledger_entry() {
    let fx = build(largest);
    // The instance entry of the deal holds the configuration and the small
    // ledgers. The configuration is the large part.
    let bytes = fx.config.clone().to_xdr(&fx.e).len();
    std::println!("largest configuration: {bytes} bytes of {ENTRY_MAX_BYTES}");
    assert!(bytes * 2 <= ENTRY_MAX_BYTES, "the configuration leaves half of the entry free");
}

#[test]
fn a_payment_date_of_the_largest_structure_fits_the_network_limits() {
    let fx = build(largest);
    fx.close();
    // Period 1: every due is paid and the deal matures. This is the period
    // with the most events: 4 fee payments, the interest and the principal
    // of 8 classes, the re-fund, the residual, 4 triggers, 22 rank lines.
    let face = 8 * 10 * DENOMINATION;
    fx.sac.mint(&fx.servicer, &(2 * face));
    fx.deal.distribute(&1, &(2 * face));
    let bytes = assert_fits_network(&fx.e, "distribute, the largest structure, maturity");
    assert_eq!(fx.deal.get_state(), State::Matured);
    assert_eq!(fx.deal.get_triggers(), soroban_sdk::vec![&fx.e, true, true, true, true]);
    // A margin of 2,000 bytes at least.
    assert!(bytes + 2_000 <= TX_MAX_EVENTS_BYTES, "{bytes} bytes of events");
}

#[test]
fn a_payment_date_of_the_largest_structure_runs_the_other_ranks_when_enforced() {
    let fx = build(largest);
    fx.close();
    fx.deal.set_enforced();
    let period = fx.run(1, 30_000);
    assert!(period.enforced);
    // Sequential by class: Classes A, B and C are repaid, Class D in part.
    assert_eq!(fx.per_note()[..3], [0, 0, 0]);
    assert!(fx.per_note()[3] > 0 && fx.per_note()[3] < DENOMINATION);
    assert_eq!(fx.per_note()[4..], [DENOMINATION; 4]);
}

#[test]
fn the_largest_structure_runs_its_pari_passu_ranks_while_its_triggers_are_set() {
    // With the triggers set, the pari passu ranks run. The lines name them.
    let fx = build(largest);
    fx.close();
    let period = fx.run(1, 20_000);
    let e = &fx.e;
    let interest: std::vec::Vec<_> =
        period.lines.iter().filter(|line| matches!(line.1, Interest(_))).map(|line| line.0.clone()).collect();
    let principal: std::vec::Vec<_> =
        period.lines.iter().filter(|line| matches!(line.1, Principal(_))).map(|line| line.0.clone()).collect();
    assert_eq!(interest, std::vec![long_id(e, 20); 8]);
    assert_eq!(principal, std::vec![long_id(e, 40); 8]);
    assert_eq!(period.breached.len(), 4);
    // Pro rata principal: the same amount per note in every class.
    let per_note = fx.per_note();
    assert!(per_note.iter().all(|value| *value == per_note[0]));
    assert!(per_note[0] < DENOMINATION);
}
