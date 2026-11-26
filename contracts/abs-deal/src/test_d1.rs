#![cfg(test)]
//! Tests of the rank engine: priorities of payments other than the reference
//! order, from the same contract. Each test changes the configuration of the
//! base deal (see `fixture.rs`) and checks the figures of a payment date.

extern crate std;

use crate::fixture::*;
use crate::*;
use soroban_sdk::{Env, Symbol};
use Item::{Fee, Interest, Principal, ReserveRefill, Residual};

pub(crate) const SEQ: RankAlloc = RankAlloc::Sequential;
pub(crate) const PARI: RankAlloc = RankAlloc::PariPassu;
pub(crate) const ALL: [Item; 3] = [Principal(0), Principal(1), Principal(2)];

pub(crate) fn on(e: &Env, trigger: &str) -> Cond {
    Cond::Trigger(sym(e, trigger))
}

pub(crate) fn off(e: &Env, trigger: &str) -> Cond {
    Cond::NotTrigger(sym(e, trigger))
}

/// An order from a list of (id, condition, split, items).
pub(crate) fn ranks(e: &Env, list: &[(&str, Cond, RankAlloc, &[Item])]) -> Vec<Rank> {
    let mut order: Vec<Rank> = Vec::new(e);
    for (id, when, alloc, items) in list.iter() {
        let mut list: Vec<Item> = Vec::new(e);
        for item in items.iter() {
            list.push_back(*item);
        }
        order.push_back(Rank { id: sym(e, id), when: when.clone(), alloc: *alloc, items: list });
    }
    order
}

/// The reference normal order, with other principal ranks.
pub(crate) fn normal_with(e: &Env, principal: &[(&str, Cond, RankAlloc, &[Item])]) -> Vec<Rank> {
    let mut list: std::vec::Vec<(&str, Cond, RankAlloc, &[Item])> = std::vec![
        ("fees", Cond::Always, SEQ, &[Fee(0)]),
        ("int_a", Cond::Always, SEQ, &[Interest(0)]),
        ("int_b", Cond::Always, SEQ, &[Interest(1)]),
        ("int_c", Cond::Always, SEQ, &[Interest(2)]),
        ("reserve", Cond::Always, SEQ, &[ReserveRefill]),
    ];
    list.extend(principal.iter().cloned());
    list.push(("residual", Cond::Always, SEQ, &[Residual]));
    ranks(e, &list)
}

pub(crate) fn trigger(e: &Env, id: &str, metric: Metric, op: Op, threshold: i128, latch: bool) -> TriggerTerms {
    TriggerTerms { id: sym(e, id), metric, op, threshold, latch }
}

/// The ids of the ranks that hold a principal line with cash.
fn principal_ranks(period: &Period) -> std::vec::Vec<Symbol> {
    let mut ids = std::vec::Vec::new();
    for line in period.lines.iter() {
        if matches!(line.1, Principal(_)) && line.3 > 0 && !ids.contains(&line.0) {
            ids.push(line.0.clone());
        }
    }
    ids
}

// --- Pro rata principal -----------------------------------------------------

pub(crate) fn pro_rata_deal() -> Fixture {
    build(|e, config, _| {
        config.normal = normal_with(e, &[("principal", Cond::Always, PARI, &ALL)]);
    })
}

#[test]
fn pro_rata_principal_splits_by_outstanding_and_floors_per_note() {
    let fx = pro_rata_deal();
    fx.close();
    let period = fx.run(1, 100_000);

    // Available: 100,000 + 5,000 released. Fees 50, interest 2,340 + 583 +
    // 562, reserve 5,000: 96,465 are left for principal. Pro rata to the
    // outstanding 1,000,000 / 700,000 / 450,000: 44,867 / 31,407 / 20,190,
    // and the unit left goes to Class A: 44,868. Each class then floors per
    // note: 44 per note in every class.
    let e = &fx.e;
    assert_eq!(
        period.lines,
        std::vec![
            line(e, "fees", Fee(0), 50, 50, 0),
            line(e, "int_a", Interest(0), 2_340, 2_000, 340),
            line(e, "int_b", Interest(1), 583, 0, 583),
            line(e, "int_c", Interest(2), 562, 450, 112),
            line(e, "reserve", ReserveRefill, 5_000, 5_000, 0),
            line(e, "principal", Principal(0), 1_000_000, 44_000, 868),
            line(e, "principal", Principal(1), 700_000, 30_800, 607),
            line(e, "principal", Principal(2), 450_000, 19_800, 390),
        ]
    );
    assert_eq!(fx.per_note(), [956, 956, 956]);
    assert_eq!(period.paid, soroban_sdk::vec![e, 2_000 + 44_000, 30_800, 450 + 19_800]);
    assert_eq!(fx.deal.get_reserve(), 5_000);
    assert_eq!(fx.deal.get_carry(), 340 + 583 + 112 + 868 + 607 + 390);
    assert_eq!(fx.balance(&fx.agent.address), 97_050);
    assert!(!period.enforced);

    // The paying agent pays each holder the same principal per note.
    fx.push_all(1);
    for class in 0..3u32 {
        assert_eq!(fx.agent.get_alloc(&1, &class).unwrap().per_note_principal, 44);
    }
    assert_eq!(fx.balance(&fx.investors[1]), 30_800);
}

#[test]
fn pro_rata_repays_every_class_when_the_cash_covers_all() {
    let fx = pro_rata_deal();
    fx.close();
    // Fees, interest, the full face and 123 more: every due fits.
    let period = fx.run(1, 50 + 3_485 + FACE + 123);
    assert_eq!(fx.deal.get_state(), State::Matured);
    assert_eq!(fx.per_note(), [0, 0, 0]);
    assert_eq!(fx.balance(&fx.deal.address), 0);
    // The Seller: the closing proceeds, then the sweep of the residual 123,
    // the reserve 5,000 and the interest dust 1,035.
    assert_eq!(fx.balance(&fx.seller), FACE + 123 + 5_000 + 1_035);
    assert_eq!(period.settled.reserve, 0);
    assert_eq!(period.settled.carry, 0);
}

#[test]
fn enforcement_makes_principal_sequential_whatever_the_normal_order() {
    let fx = pro_rata_deal();
    fx.close();
    fx.deal.set_enforced();
    let period = fx.run(1, 5_000);
    // The enforced order: Class A interest 2,340 then Class A principal with
    // the 7,610 that are left. Classes B and C get nothing.
    assert!(period.enforced);
    assert_eq!(fx.balance(&fx.agent.address), 2_000 + 7_000);
    assert_eq!(fx.shortfalls(), [0, 583, 562]);
    assert_eq!(fx.per_note(), [993, 1_000, 1_000]);
    assert_eq!(fx.deal.get_reserve(), 0);
    assert_eq!(fx.deal.get_carry(), 340 + 610);
}

// --- Triggers ---------------------------------------------------------------

/// Pro rata principal that turns sequential while the trigger `seq` is set.
/// `seq` is set when the reserve is below its required amount.
pub(crate) fn switch_deal(latch: bool) -> Fixture {
    build(move |e, config, _| {
        config.triggers.push_back(trigger(e, "seq", Metric::ReserveShortfall, Op::Gt, 0, latch));
        config.normal = normal_with(
            e,
            &[
                ("prin_pr", off(e, "seq"), PARI, &ALL),
                ("prin_seq", on(e, "seq"), SEQ, &ALL),
            ],
        );
    })
}

#[test]
fn pro_rata_turns_sequential_after_a_latched_trigger_and_stays() {
    let fx = switch_deal(true);
    fx.close();
    let e = &fx.e;

    // Period 1, no collections: the released reserve pays the fees and the
    // interest. Only 1,465 go back to the reserve.
    let first = fx.run(1, 0);
    assert_eq!(fx.deal.get_reserve(), 1_465);
    assert!(first.breached.is_empty());
    assert_eq!(fx.deal.get_triggers(), soroban_sdk::vec![e, false]);

    // Period 2: the opening reserve is 3,535 short, so the trigger is set.
    // Available 100,000 + 1,465 + carry 1,035. After fees, interest and the
    // re-fund, 93,965 pay Class A only: sequential.
    let second = fx.run(2, 100_000);
    assert_eq!(second.breached, std::vec![sym(e, "seq")]);
    assert_eq!(principal_ranks(&second), std::vec![sym(e, "prin_seq")]);
    assert_eq!(fx.per_note(), [907, 1_000, 1_000]);
    assert_eq!(fx.deal.get_reserve(), 5_000);
    assert_eq!(fx.deal.get_carry(), 1_035 + 965);
    assert_eq!(fx.deal.get_triggers(), soroban_sdk::vec![e, true]);

    // Period 3: the reserve is full again, but the trigger is latched.
    // Available 50,000 + 5,000 + 2,000. Class A interest is 2,123 on its
    // 907,000. 48,682 pay Class A only.
    let third = fx.run(3, 50_000);
    assert!(third.breached.is_empty());
    assert_eq!(principal_ranks(&third), std::vec![sym(e, "prin_seq")]);
    assert_eq!(fx.per_note(), [859, 1_000, 1_000]);
    assert_eq!(fx.deal.get_carry(), 123 + 583 + 112 + 682);
    assert_eq!(fx.deal.get_triggers(), soroban_sdk::vec![e, true]);
}

#[test]
fn an_unlatched_trigger_returns_to_pro_rata_when_it_clears() {
    let fx = switch_deal(false);
    fx.close();
    let e = &fx.e;
    fx.run(1, 0);
    let second = fx.run(2, 100_000);
    assert_eq!(second.breached, std::vec![sym(e, "seq")]);
    assert_eq!(fx.per_note(), [907, 1_000, 1_000]);

    // Period 3: the reserve is full, the trigger clears, principal is pro
    // rata again. 48,682 on 907,000 / 700,000 / 450,000: 21,465 / 16,566 /
    // 10,649 and the 2 units left to Class A. Per note: 21 / 23 / 23.
    let third = fx.run(3, 50_000);
    assert!(third.breached.is_empty());
    assert_eq!(principal_ranks(&third), std::vec![sym(e, "prin_pr")]);
    assert_eq!(fx.per_note(), [886, 977, 977]);
    assert_eq!(fx.deal.get_triggers(), soroban_sdk::vec![e, false]);
}

/// Sequential principal that turns pro rata when the Class A factor is at or
/// below `threshold`.
pub(crate) fn factor_deal(op: Op, threshold: i128) -> Fixture {
    build(move |e, config, _| {
        config.triggers.push_back(trigger(e, "amortised", Metric::ClassFactor(0), op, threshold, false));
        config.normal = normal_with(
            e,
            &[
                ("prin_seq", off(e, "amortised"), SEQ, &ALL),
                ("prin_pr", on(e, "amortised"), PARI, &ALL),
            ],
        );
    })
}

#[test]
fn a_trigger_reads_the_opening_state_and_is_published_once() {
    let fx = factor_deal(Op::Le, 9_100_000);
    fx.close();
    let e = &fx.e;
    // Period 1 brings the Class A factor from 100% to 90.4%. The trigger
    // reads the opening factor, 100%: the period is sequential.
    let first = fx.run(1, 100_000);
    assert!(first.breached.is_empty());
    assert_eq!(principal_ranks(&first), std::vec![sym(e, "prin_seq")]);
    assert_eq!(fx.per_note(), [904, 1_000, 1_000]);
    // Period 2 opens at 90.4%: the trigger is set and published.
    let second = fx.run(2, 100_000);
    assert_eq!(second.breached, std::vec![sym(e, "amortised")]);
    assert_eq!(principal_ranks(&second), std::vec![sym(e, "prin_pr")]);
    // Period 3: still set, not published again.
    let third = fx.run(3, 100_000);
    assert!(third.breached.is_empty());
    assert_eq!(principal_ranks(&third), std::vec![sym(e, "prin_pr")]);
    assert_eq!(fx.deal.get_triggers(), soroban_sdk::vec![e, true]);
}

#[test]
fn class_factor_trigger_switches_at_its_threshold() {
    // After period 1 the Class A factor is exactly 904 / 1,000.
    let exact = 904 * FACTOR_SCALE / 1_000;
    let below = factor_deal(Op::Lt, exact);
    below.close();
    below.run(1, 100_000);
    let period = below.run(2, 100_000);
    assert!(period.breached.is_empty(), "the factor is not below its own value");

    let at_or_below = factor_deal(Op::Le, exact);
    at_or_below.close();
    at_or_below.run(1, 100_000);
    let period = at_or_below.run(2, 100_000);
    assert_eq!(period.breached.len(), 1);
}

#[test]
fn notes_factor_and_class_shortfall_triggers_read_the_ledgers() {
    let fx = build(|e, config, _| {
        // `half`: the notes are below 99% of their initial balance.
        // `unpaid`: Class C has unpaid interest above 500.
        config.triggers.push_back(trigger(e, "half", Metric::NotesFactor, Op::Lt, 9_900_000, true));
        config.triggers.push_back(trigger(e, "unpaid", Metric::ClassShortfall(2), Op::Gt, 500, false));
    });
    fx.close();
    let e = &fx.e;
    // Period 1, no cash but the reserve: interest is paid, no shortfall.
    fx.run(1, 0);
    // Period 2, no cash: Class B gets 110 of 583, Class C nothing of 562.
    let second = fx.run(2, 0);
    assert!(second.breached.is_empty());
    assert_eq!(fx.shortfalls(), [0, 473, 562]);
    // Period 3 opens with a Class C shortfall of 562: `unpaid` is set.
    let third = fx.run(3, 60_000);
    assert_eq!(third.breached, std::vec![sym(e, "unpaid")]);
    assert_eq!(fx.shortfalls(), [0, 0, 0]);
    // Period 4 opens below 99% of the notes: `half` is set. The shortfall
    // is paid: `unpaid` clears.
    let fourth = fx.run(4, 0);
    assert_eq!(fourth.breached, std::vec![sym(e, "half")]);
    assert_eq!(fx.deal.get_triggers(), soroban_sdk::vec![e, true, false]);
}

// --- Rank order -------------------------------------------------------------

#[test]
fn junior_interest_ranks_after_senior_principal() {
    let fx = build(|e, config, _| {
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
    });
    fx.close();
    let period = fx.run(1, 100_000);
    // After fees, Class A interest and the re-fund, 97,610 pay Class A
    // principal. Nothing reaches the interest of Classes B and C.
    let e = &fx.e;
    assert_eq!(
        period.lines,
        std::vec![
            line(e, "fees", Fee(0), 50, 50, 0),
            line(e, "int_a", Interest(0), 2_340, 2_000, 340),
            line(e, "reserve", ReserveRefill, 5_000, 5_000, 0),
            line(e, "prin_a", Principal(0), 1_000_000, 97_000, 610),
            line(e, "int_b", Interest(1), 583, 0, 0),
            line(e, "prin_b", Principal(1), 700_000, 0, 0),
            line(e, "int_c", Interest(2), 562, 0, 0),
            line(e, "prin_c", Principal(2), 450_000, 0, 0),
        ]
    );
    assert_eq!(fx.shortfalls(), [0, 583, 562]);
    assert_eq!(fx.per_note(), [903, 1_000, 1_000]);
    assert_eq!(fx.deal.get_carry(), 340 + 610);
}

#[test]
fn junior_interest_is_deferred_only_while_a_trigger_is_set() {
    // Class B interest ranks before the reserve. While the reserve is short
    // (`defer`), it ranks after the Class A principal.
    let fx = build(|e, config, _| {
        config.triggers.push_back(trigger(e, "defer", Metric::ReserveShortfall, Op::Gt, 0, false));
        config.normal = ranks(
            e,
            &[
                ("fees", Cond::Always, SEQ, &[Fee(0)]),
                ("int_a", Cond::Always, SEQ, &[Interest(0)]),
                ("int_b", off(e, "defer"), SEQ, &[Interest(1)]),
                ("reserve", Cond::Always, SEQ, &[ReserveRefill]),
                ("prin_a", Cond::Always, SEQ, &[Principal(0)]),
                ("int_b_late", on(e, "defer"), SEQ, &[Interest(1)]),
                ("prin_b", Cond::Always, SEQ, &[Principal(1)]),
                ("int_c", Cond::Always, SEQ, &[Interest(2)]),
                ("prin_c", Cond::Always, SEQ, &[Principal(2)]),
                ("residual", Cond::Always, SEQ, &[Residual]),
            ],
        );
    });
    fx.close();
    let e = &fx.e;
    let class_b = |period: &Period| -> RankLine {
        period.lines.iter().find(|line| line.1 == Interest(1)).unwrap().clone()
    };

    // Period 1, no collections: Class B is paid before the reserve, which
    // gets 2,027 of its 5,000.
    let first = fx.run(1, 0);
    assert_eq!(class_b(&first), line(e, "int_b", Interest(1), 583, 0, 583));
    assert_eq!(fx.deal.get_reserve(), 2_027);

    // Period 2: the reserve is short, Class B interest is deferred. The
    // 4,560 after Class A interest go to the reserve. Class B gets nothing.
    let second = fx.run(2, 4_000);
    assert_eq!(second.breached, std::vec![sym(e, "defer")]);
    assert_eq!(class_b(&second), line(e, "int_b_late", Interest(1), 583, 0, 0));
    assert_eq!(fx.deal.get_reserve(), 4_560);
    assert_eq!(fx.shortfalls(), [0, 583, 1_124]);

    // Period 3: still deferred. The reserve is full again at its rank.
    let third = fx.run(3, 20_000);
    assert_eq!(class_b(&third), line(e, "int_b_late", Interest(1), 1_166, 0, 0));
    assert_eq!(fx.deal.get_reserve(), 5_000);
    assert_eq!(fx.per_note(), [983, 1_000, 1_000]);

    // Period 4: the trigger clears. Class B takes its interest and its
    // shortfall before the reserve: 583 + 1,166 = 1,749, 2 per note.
    let fourth = fx.run(4, 10_000);
    assert_eq!(class_b(&fourth), line(e, "int_b", Interest(1), 1_749, 1_400, 349));
    assert_eq!(fx.shortfalls()[1], 0);
}

#[test]
fn pari_passu_interest_shares_a_short_amount_by_due() {
    let fx = build(|e, config, _| {
        config.reserve.required = RequiredRule::Fixed(2_000);
        config.normal = ranks(
            e,
            &[
                ("fees", Cond::Always, SEQ, &[Fee(0)]),
                ("interest", Cond::Always, PARI, &[Interest(0), Interest(1), Interest(2)]),
                ("reserve", Cond::Always, SEQ, &[ReserveRefill]),
                ("principal", Cond::Always, SEQ, &ALL),
                ("residual", Cond::Always, SEQ, &[Residual]),
            ],
        );
    });
    fx.close();
    let period = fx.run(1, 0);
    // 2,000 released, fees 50: 1,950 for dues of 2,340 + 583 + 562 = 3,485.
    // In proportion: 1,309 / 326 / 314, and the unit left to Class A.
    let e = &fx.e;
    assert_eq!(
        period.lines[1..4],
        [
            line(e, "interest", Interest(0), 2_340, 1_000, 310),
            line(e, "interest", Interest(1), 583, 0, 326),
            line(e, "interest", Interest(2), 562, 0, 314),
        ]
    );
    assert_eq!(fx.shortfalls(), [2_340 - 1_310, 583 - 326, 562 - 314]);
    assert_eq!(fx.deal.get_reserve(), 0);
    assert_eq!(fx.deal.get_carry(), 310 + 326 + 314);
}

// --- Reserve ----------------------------------------------------------------

pub(crate) fn on_need_deal() -> Fixture {
    build(|e, config, _| {
        config.reserve.release = Release::OnNeed;
        config.reserve.draw_ranks = soroban_sdk::vec![e, sym(e, "fees"), sym(e, "int_a")];
    })
}

#[test]
fn on_need_reserve_covers_only_the_draw_ranks() {
    let fx = on_need_deal();
    fx.close();
    let period = fx.run(1, 0);
    // No cash. The reserve stays in its ledger: nothing is released. The
    // fees draw 50 and Class A interest draws 2,340. Classes B and C are
    // not draw ranks: their interest becomes a shortfall.
    let e = &fx.e;
    assert_eq!(
        period.lines,
        std::vec![
            line(e, "fees", Fee(0), 50, 50, 0),
            line(e, "int_a", Interest(0), 2_340, 2_000, 340),
            line(e, "int_b", Interest(1), 583, 0, 0),
            line(e, "int_c", Interest(2), 562, 0, 0),
            line(e, "reserve", ReserveRefill, 2_390, 0, 0),
            line(e, "principal", Principal(0), 1_000_000, 0, 0),
            line(e, "principal", Principal(1), 700_000, 0, 0),
            line(e, "principal", Principal(2), 450_000, 0, 0),
        ]
    );
    assert_eq!(
        period.settled,
        Settled {
            collections: 0,
            reserve_in: 5_000,
            carry_in: 0,
            drawn: 2_390,
            paid_out: 50 + 2_000,
            reserve: 2_610,
            carry: 340,
            owed: 0,
            balance: 2_950,
            surplus: 0,
        }
    );
    assert_eq!(fx.shortfalls(), [0, 583, 562]);
}

#[test]
fn on_need_reserve_is_refilled_at_its_rank_after_a_draw() {
    let fx = on_need_deal();
    fx.close();
    fx.run(1, 0);
    let period = fx.run(2, 10_000);
    // Available 10,000 + carry 340, nothing released. Fees 50, interest
    // 2,340 / 1,166 / 1,124, then the re-fund of the 2,390 drawn, then 3,270
    // for Class A principal.
    let e = &fx.e;
    assert_eq!(period.settled.drawn, 0);
    assert_eq!(period.lines[4], line(e, "reserve", ReserveRefill, 2_390, 2_390, 0));
    assert_eq!(period.lines[5], line(e, "principal", Principal(0), 1_000_000, 3_000, 270));
    assert_eq!(fx.deal.get_reserve(), 5_000);
    assert_eq!(fx.shortfalls(), [0, 0, 0]);
    assert_eq!(fx.deal.get_carry(), 340 + 466 + 224 + 270);
}

#[test]
fn on_need_reserve_is_released_in_full_once_enforced() {
    let fx = on_need_deal();
    fx.close();
    fx.deal.set_enforced();
    let period = fx.run(1, 5_000);
    // After enforcement the whole reserve joins the available amount.
    assert_eq!(period.settled.drawn, 0);
    assert_eq!(fx.balance(&fx.agent.address), 2_000 + 7_000);
    assert_eq!(fx.deal.get_reserve(), 0);
    assert_eq!(fx.deal.get_required_reserve(), 0);
}

pub(crate) fn pct_deal() -> Fixture {
    build(|e, config, _| {
        // 1% of the notes, with a floor of 15,000.
        config.reserve.required = RequiredRule::PctOfNotes(1_000, 15_000);
        config.reserve.release = Release::OnNeed;
        config.reserve.draw_ranks = soroban_sdk::vec![e, sym(e, "fees"), sym(e, "int_a")];
    })
}

#[test]
fn close_requires_the_sub_loan_of_the_pct_rule() {
    let fx = pct_deal();
    // 1% of 2,150,000.
    assert_eq!(fx.deal.get_required_reserve(), 21_500);
    for (index, investor) in fx.investors.iter().enumerate() {
        fx.deal.subscribe(investor, &(index as u32), &NOTES[index]);
    }
    fx.sac.mint(&fx.seller, &21_500);
    fx.deal.fund_sub_loan(&5_000);
    assert_eq!(fx.deal.try_close(), Err(Ok(DealError::SubLoanShort)));
    fx.deal.fund_sub_loan(&16_500);
    fx.deal.close();
    assert_eq!(fx.deal.get_reserve(), 21_500);
}

#[test]
fn pct_reserve_falls_with_the_notes_and_stops_at_its_floor() {
    let fx = pct_deal();
    fx.close();
    // Period 1: 496,000 of Class A principal. The reserve does not move in
    // the period: its rule reads the opening notes.
    fx.run(1, 500_000);
    assert_eq!(fx.per_note(), [504, 1_000, 1_000]);
    assert_eq!(fx.deal.get_reserve(), 21_500);
    assert_eq!(fx.deal.get_required_reserve(), 16_540);

    // Period 2 opens with 1,654,000 of notes: 16,540 are required, and the
    // excess of 4,960 joins the available amount.
    let second = fx.run(2, 0);
    assert_eq!(second.settled.reserve, 16_540);
    assert_eq!(fx.per_note(), [500, 1_000, 1_000]);
    assert_eq!(fx.deal.get_required_reserve(), 16_500);

    // Period 3: Class A is repaid, Class B starts.
    let third = fx.run(3, 1_000_000);
    assert_eq!(third.settled.reserve, 16_500);
    assert_eq!(fx.per_note(), [0, 288, 1_000]);
    // 1% of 651,600 is 6,516: the floor of 15,000 applies.
    assert_eq!(fx.deal.get_required_reserve(), 15_000);
    let fourth = fx.run(4, 0);
    assert_eq!(fourth.settled.reserve, 15_000);
}

// --- Rates ------------------------------------------------------------------

fn class_a(config: &mut DealConfig, floor: Option<i128>, index_floor: Option<i128>) {
    let terms = config.classes.get(0).unwrap();
    config.classes.set(0, ClassTerms { floor, index_floor, ..terms });
}

#[test]
fn a_positive_floor_lifts_the_floating_rate() {
    // Fixing 2.209% + 0.60% = 2.809%, floored at 3%: 2,500 for the period.
    let fx = build(|_, config, _| class_a(config, Some(3_000), None));
    fx.close();
    let period = fx.run(1, 100_000);
    assert_eq!(period.lines[1], line(&fx.e, "int_a", Interest(0), 2_500, 2_000, 500));
}

#[test]
fn a_negative_rate_without_a_floor_gives_no_interest() {
    let fx = build(|_, config, _| class_a(config, None, None));
    fx.close();
    fx.oracle.set(&-1_000, &T0);
    let period = fx.run(1, 100_000);
    // All-in -0.40%: no Class A interest line, and no negative interest.
    assert!(period.lines.iter().all(|line| line.1 != Interest(0)));
    assert_eq!(fx.shortfalls()[0], 0);
}

#[test]
fn an_index_floor_applies_before_the_spread() {
    // Fixing -1%, floored at 0%, plus 0.60%: 500 for the period.
    let fx = build(|_, config, _| class_a(config, None, Some(0)));
    fx.close();
    fx.oracle.set(&-1_000, &T0);
    let period = fx.run(1, 100_000);
    assert_eq!(period.lines[1], line(&fx.e, "int_a", Interest(0), 500, 0, 500));
}

// --- Fee lines --------------------------------------------------------------

pub(crate) fn two_fee_deal(revocable: bool) -> Fixture {
    build_with(revocable, |e, config, parties| {
        config.fees.push_back(FeeLine {
            recipient: parties.fees_2.clone(),
            amount: FeeAmount::Fixed(30),
        });
        config.normal = ranks(
            e,
            &[
                ("fees", Cond::Always, SEQ, &[Fee(0)]),
                ("int_a", Cond::Always, SEQ, &[Interest(0)]),
                ("int_b", Cond::Always, SEQ, &[Interest(1)]),
                ("int_c", Cond::Always, SEQ, &[Interest(2)]),
                ("sub_fee", Cond::Always, SEQ, &[Fee(1)]),
                ("reserve", Cond::Always, SEQ, &[ReserveRefill]),
                ("principal", Cond::Always, SEQ, &ALL),
                ("residual", Cond::Always, SEQ, &[Residual]),
            ],
        );
        config.enforced = ranks(
            e,
            &[
                ("fees", Cond::Always, SEQ, &[Fee(0)]),
                ("acc_a", Cond::Always, SEQ, &[Interest(0), Principal(0)]),
                ("acc_b", Cond::Always, SEQ, &[Interest(1), Principal(1)]),
                ("acc_c", Cond::Always, SEQ, &[Interest(2), Principal(2)]),
                ("sub_fee", Cond::Always, SEQ, &[Fee(1)]),
                ("residual", Cond::Always, SEQ, &[Residual]),
            ],
        );
    })
}

#[test]
fn two_fee_lines_are_paid_in_rank_order_to_their_recipients() {
    let fx = two_fee_deal(false);
    fx.close();
    // Period 1: the senior fee, the interest, then the subordinated fee.
    fx.run(1, 0);
    assert_eq!(fx.balance(&fx.fees), 50);
    assert_eq!(fx.balance(&fx.fees_2), 30);
    assert_eq!(fx.deal.get_reserve(), 5_000 - 50 - 3_485 - 30);

    // Period 2: 2,470 of cash. The senior fee and Class A interest take
    // 2,390. Class B gets the 80 that are left. The subordinated fee gets
    // nothing, and it is not due again.
    let second = fx.run(2, 0);
    assert_eq!(fx.balance(&fx.fees), 100);
    assert_eq!(fx.balance(&fx.fees_2), 30);
    assert_eq!(second.lines[4], line(&fx.e, "sub_fee", Fee(1), 30, 0, 0));

    // Period 3: the fee is 30, not 60.
    let third = fx.run(3, 50_000);
    assert_eq!(third.lines[4], line(&fx.e, "sub_fee", Fee(1), 30, 30, 0));
    assert_eq!(fx.balance(&fx.fees_2), 60);
}

#[test]
fn a_per_annum_fee_follows_the_outstanding_notes() {
    // 1% per year on the opening notes, for 30 days of 360.
    let fx = build(|e, config, parties| {
        config.fees = soroban_sdk::vec![
            e,
            FeeLine { recipient: parties.fees.clone(), amount: FeeAmount::PerAnnum(1_000) }
        ];
    });
    fx.close();
    // 2,150,000 x 1% x 30 / 360 = 1,791.
    let first = fx.run(1, 100_000);
    assert_eq!(first.lines[0], line(&fx.e, "fees", Fee(0), 1_791, 1_791, 0));
    assert_eq!(fx.per_note(), [906, 1_000, 1_000]);
    // 2,056,000 x 1% x 30 / 360 = 1,713.
    let second = fx.run(2, 100_000);
    assert_eq!(second.lines[0], line(&fx.e, "fees", Fee(0), 1_713, 1_713, 0));
    assert_eq!(fx.balance(&fx.fees), 1_791 + 1_713);
}

#[test]
fn a_frozen_fee_recipient_parks_only_its_own_line() {
    let fx = two_fee_deal(true);
    fx.close();
    fx.sac.set_authorized(&fx.fees_2, &false);
    let period = fx.run(1, 100_000);
    // The senior fee is paid. The subordinated fee stays in the deal, owed
    // to its recipient. The noteholders are paid.
    assert_eq!(fx.balance(&fx.fees), 50);
    assert_eq!(fx.balance(&fx.fees_2), 0);
    assert_eq!(fx.deal.get_owed(&fx.fees_2), 30);
    assert_eq!(period.settled.owed, 30);
    assert!(fx.balance(&fx.agent.address) > 0);
    // The parked fee is in `paid_out`: it left the ledgers of the deal.
    assert_eq!(period.settled.paid_out, 50 + 30 + fx.balance(&fx.agent.address));
    fx.sac.set_authorized(&fx.fees_2, &true);
    assert_eq!(fx.deal.claim_owed(&fx.fees_2), 30);
}
