#![cfg(test)]
//! Tests of `validate`: the configurations that the contract refuses at the
//! construction. Each test changes one point of a valid configuration.

extern crate std;

use crate::fixture::*;
use crate::reference::{reference_config, Reference};
use crate::test_d1::{normal_with, off, on, ranks, trigger, ALL, PARI, SEQ};
use crate::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, Symbol};
use Item::{Fee, Interest, Principal, ReserveRefill, Residual};

fn parties(e: &Env) -> Parties {
    Parties {
        admin: Address::generate(e),
        servicer: Address::generate(e),
        seller: Address::generate(e),
        fees: Address::generate(e),
        fees_2: Address::generate(e),
        asset: Address::generate(e),
        oracle: Address::generate(e),
    }
}

/// The result of `validate` for the base configuration after `edit`.
fn check(edit: impl FnOnce(&Env, &mut DealConfig, &Parties)) -> Result<(), DealError> {
    let e = Env::default();
    let parties = parties(&e);
    let mut config = base_config(&e, &parties);
    edit(&e, &mut config, &parties);
    validate(&config)
}

const REFUSED: Result<(), DealError> = Err(DealError::InvalidConfig);

/// Replace one rank of an order.
fn replace(e: &Env, order: &Vec<Rank>, id: &str, rank: Rank) -> Vec<Rank> {
    let mut out: Vec<Rank> = Vec::new(e);
    for current in order.iter() {
        out.push_back(if current.id == sym(e, id) { rank.clone() } else { current });
    }
    out
}

/// Remove one rank of an order.
fn without(e: &Env, order: &Vec<Rank>, id: &str) -> Vec<Rank> {
    let mut out: Vec<Rank> = Vec::new(e);
    for current in order.iter() {
        if current.id != sym(e, id) {
            out.push_back(current);
        }
    }
    out
}

fn one(e: &Env, id: &str, when: Cond, alloc: RankAlloc, items: &[Item]) -> Rank {
    ranks(e, &[(id, when, alloc, items)]).get(0).unwrap()
}

#[test]
fn the_reference_configuration_is_valid_for_1_to_8_classes() {
    let e = Env::default();
    let parties = parties(&e);
    for count in 1..=8usize {
        let classes: std::vec::Vec<(RateSpec, i128)> =
            (0..count).map(|index| (RateSpec::Fixed(1_000 + index as i128), 10)).collect();
        let config = reference_config(
            &e,
            Reference {
                admin: &parties.admin,
                asset: &parties.asset,
                oracle: &parties.oracle,
                seller: &parties.seller,
                servicer: &parties.servicer,
                fees_recipient: &parties.fees,
                fees_per_period: 50,
                required_reserve: 5_000,
                days_in_period: 30,
                oracle_max_staleness_secs: 7 * 86_400,
                note_denomination: DENOMINATION,
                round_unit: 1,
                classes: &classes,
            },
        );
        assert_eq!(validate(&config), Ok(()), "{count} classes");
        // Fees, one interest rank per class, reserve, principal, residual.
        assert_eq!(config.normal.len() as usize, count + 4);
        assert_eq!(config.enforced.len() as usize, count + 2);
    }
    assert_eq!(check(|_, _, _| {}), Ok(()));
}

#[test]
fn validation_keeps_the_checks_of_the_terms() {
    assert_eq!(check(|e, config, _| config.classes = Vec::new(e)), REFUSED);
    assert_eq!(check(|_, config, _| config.note_denomination = 0), REFUSED);
    assert_eq!(check(|_, config, _| config.round_unit = 0), REFUSED);
    // A denomination of 1,000 is not a whole multiple of 300.
    assert_eq!(check(|_, config, _| config.round_unit = 300), REFUSED);
    assert_eq!(
        check(|_, config, _| {
            let terms = config.classes.get(1).unwrap();
            config.classes.set(1, ClassTerms { total_notes: 0, ..terms });
        }),
        REFUSED
    );
}

#[test]
fn validation_refuses_a_bad_fee_or_reserve_amount() {
    let fee = |amount: FeeAmount| {
        check(move |e, config, parties| {
            config.fees = soroban_sdk::vec![e, FeeLine { recipient: parties.fees.clone(), amount }];
        })
    };
    assert_eq!(fee(FeeAmount::Fixed(-1)), REFUSED);
    assert_eq!(fee(FeeAmount::PerAnnum(-1)), REFUSED);
    // More than 100% per year.
    assert_eq!(fee(FeeAmount::PerAnnum(RATE_SCALE + 1)), REFUSED);
    assert_eq!(fee(FeeAmount::PerAnnum(RATE_SCALE)), Ok(()));

    let reserve = |required: RequiredRule| check(move |_, config, _| config.reserve.required = required);
    assert_eq!(reserve(RequiredRule::Fixed(-1)), REFUSED);
    assert_eq!(reserve(RequiredRule::PctOfNotes(RATE_SCALE + 1, 0)), REFUSED);
    assert_eq!(reserve(RequiredRule::PctOfNotes(1_000, -1)), REFUSED);
    assert_eq!(reserve(RequiredRule::PctOfNotes(1_000, 0)), Ok(()));
}

#[test]
fn validation_refuses_out_of_range_class_fee_and_trigger_references() {
    // The base deal has 3 classes and 1 fee line.
    assert_eq!(
        check(|e, config, _| {
            config.normal = replace(e, &config.normal, "int_c", one(e, "int_c", Cond::Always, SEQ, &[Interest(3)]));
        }),
        REFUSED
    );
    assert_eq!(
        check(|e, config, _| {
            config.normal = replace(e, &config.normal, "fees", one(e, "fees", Cond::Always, SEQ, &[Fee(1)]));
        }),
        REFUSED
    );
    // A condition on a trigger that the configuration does not have.
    assert_eq!(
        check(|e, config, _| {
            config.normal = normal_with(e, &[("prin_pr", off(e, "seq"), PARI, &ALL), ("prin_seq", on(e, "seq"), SEQ, &ALL)]);
        }),
        REFUSED
    );
    // A metric on a class that the deal does not have.
    assert_eq!(
        check(|e, config, _| {
            config.triggers.push_back(trigger(e, "t", Metric::ClassFactor(3), Op::Lt, 1, false));
        }),
        REFUSED
    );
    assert_eq!(
        check(|e, config, _| {
            config.triggers.push_back(trigger(e, "t", Metric::ClassShortfall(8), Op::Gt, 1, false));
        }),
        REFUSED
    );
    assert_eq!(
        check(|e, config, _| {
            config.triggers.push_back(trigger(e, "t", Metric::NotesFactor, Op::Lt, -1, false));
        }),
        REFUSED
    );
}

#[test]
fn validation_refuses_duplicate_rank_and_trigger_ids() {
    assert_eq!(
        check(|e, config, _| {
            config.normal = replace(e, &config.normal, "int_b", one(e, "int_a", Cond::Always, SEQ, &[Interest(1)]));
        }),
        REFUSED
    );
    assert_eq!(
        check(|e, config, _| {
            config.triggers.push_back(trigger(e, "t", Metric::NotesFactor, Op::Lt, 1, false));
            config.triggers.push_back(trigger(e, "t", Metric::ReserveShortfall, Op::Gt, 0, true));
        }),
        REFUSED
    );
    // The same id in the two orders is not a duplicate: `fees`, `residual`.
    assert_eq!(check(|_, _, _| {}), Ok(()));
}

/// The base deal with two principal ranks and the conditions `first` and
/// `second`, on the triggers `x` and `y`.
fn two_principal_ranks(first: fn(&Env) -> Cond, second: fn(&Env) -> Cond) -> Result<(), DealError> {
    check(move |e, config, _| {
        config.triggers.push_back(trigger(e, "x", Metric::NotesFactor, Op::Lt, 1, false));
        config.triggers.push_back(trigger(e, "y", Metric::ReserveShortfall, Op::Gt, 0, false));
        config.normal = normal_with(e, &[("prin_1", first(e), PARI, &ALL), ("prin_2", second(e), SEQ, &ALL)]);
    })
}

#[test]
fn validation_refuses_an_item_in_two_ranks_that_can_both_run() {
    // Two ranks that always run: principal would be paid twice.
    assert_eq!(two_principal_ranks(|_| Cond::Always, |_| Cond::Always), REFUSED);
    // One rank always, one under a condition.
    assert_eq!(two_principal_ranks(|_| Cond::Always, |e| on(e, "x")), REFUSED);
    // The same condition twice.
    assert_eq!(two_principal_ranks(|e| on(e, "x"), |e| on(e, "x")), REFUSED);
    // Conditions on two different triggers: both can hold, or none.
    assert_eq!(two_principal_ranks(|e| on(e, "x"), |e| off(e, "y")), REFUSED);
}

#[test]
fn validation_accepts_an_item_in_two_ranks_with_opposite_conditions() {
    assert_eq!(two_principal_ranks(|e| off(e, "x"), |e| on(e, "x")), Ok(()));
    assert_eq!(two_principal_ranks(|e| on(e, "y"), |e| off(e, "y")), Ok(()));
    // A third rank for the same item is refused, whatever its condition.
    assert_eq!(
        check(|e, config, _| {
            config.triggers.push_back(trigger(e, "x", Metric::NotesFactor, Op::Lt, 1, false));
            config.normal = normal_with(
                e,
                &[
                    ("prin_1", off(e, "x"), PARI, &ALL),
                    ("prin_2", on(e, "x"), SEQ, &ALL),
                    ("prin_3", off(e, "x"), SEQ, &ALL),
                ],
            );
        }),
        REFUSED
    );
}

#[test]
fn validation_refuses_a_line_that_runs_only_under_a_condition() {
    // Class C interest in one conditional rank: nothing pays it when the
    // trigger is not set.
    assert_eq!(
        check(|e, config, _| {
            config.triggers.push_back(trigger(e, "x", Metric::NotesFactor, Op::Lt, 1, false));
            config.normal = replace(e, &config.normal, "int_c", one(e, "int_c", on(e, "x"), SEQ, &[Interest(2)]));
        }),
        REFUSED
    );
}

#[test]
fn validation_refuses_a_class_or_a_fee_without_its_line() {
    // No interest line for Class C in the normal order.
    assert_eq!(check(|e, config, _| config.normal = without(e, &config.normal, "int_c")), REFUSED);
    // No principal line for Class C.
    assert_eq!(
        check(|e, config, _| {
            config.normal = normal_with(e, &[("principal", Cond::Always, SEQ, &[Principal(0), Principal(1)])]);
        }),
        REFUSED
    );
    // The enforced order must be complete too.
    assert_eq!(check(|e, config, _| config.enforced = without(e, &config.enforced, "acc_b")), REFUSED);
    // A fee line that no rank pays.
    assert_eq!(check(|e, config, _| config.normal = without(e, &config.normal, "fees")), REFUSED);
    assert_eq!(check(|e, config, _| config.enforced = without(e, &config.enforced, "fees")), REFUSED);
    // An empty order.
    assert_eq!(check(|e, config, _| config.normal = Vec::new(e)), REFUSED);
    assert_eq!(check(|e, config, _| config.enforced = Vec::new(e)), REFUSED);
}

#[test]
fn validation_refuses_principal_ranked_before_the_interest_of_its_class() {
    // Class B principal, then Class B interest.
    assert_eq!(
        check(|e, config, _| {
            config.normal = ranks(
                e,
                &[
                    ("fees", Cond::Always, SEQ, &[Fee(0)]),
                    ("int_a", Cond::Always, SEQ, &[Interest(0)]),
                    ("int_c", Cond::Always, SEQ, &[Interest(2)]),
                    ("reserve", Cond::Always, SEQ, &[ReserveRefill]),
                    ("principal", Cond::Always, SEQ, &ALL),
                    ("int_b", Cond::Always, SEQ, &[Interest(1)]),
                    ("residual", Cond::Always, SEQ, &[Residual]),
                ],
            );
        }),
        REFUSED
    );
    // In one rank: the principal item before the interest item.
    assert_eq!(
        check(|e, config, _| {
            config.enforced =
                replace(e, &config.enforced, "acc_a", one(e, "acc_a", Cond::Always, SEQ, &[Principal(0), Interest(0)]));
        }),
        REFUSED
    );
    // Junior interest after senior principal is a valid order.
    assert_eq!(
        check(|e, config, _| {
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
        }),
        Ok(())
    );
}

#[test]
fn validation_refuses_a_residual_that_is_not_alone_last_and_unconditional() {
    // No residual rank.
    assert_eq!(check(|e, config, _| config.normal = without(e, &config.normal, "residual")), REFUSED);
    // The residual shares its rank.
    assert_eq!(
        check(|e, config, _| {
            let mut order = without(e, &config.normal, "residual");
            order = without(e, &order, "reserve");
            order.push_back(one(e, "last", Cond::Always, SEQ, &[ReserveRefill, Residual]));
            config.normal = order;
        }),
        REFUSED
    );
    // The residual is not the last rank.
    assert_eq!(
        check(|e, config, _| {
            let mut order: Vec<Rank> = Vec::new(e);
            order.push_back(one(e, "residual", Cond::Always, SEQ, &[Residual]));
            for rank in without(e, &config.normal, "residual").iter() {
                order.push_back(rank);
            }
            config.normal = order;
        }),
        REFUSED
    );
    // The residual has a condition.
    assert_eq!(
        check(|e, config, _| {
            config.triggers.push_back(trigger(e, "x", Metric::NotesFactor, Op::Lt, 1, false));
            config.normal = replace(e, &config.normal, "residual", one(e, "residual", on(e, "x"), SEQ, &[Residual]));
        }),
        REFUSED
    );
}

#[test]
fn validation_refuses_a_pari_passu_rank_with_items_of_different_kinds() {
    assert_eq!(
        check(|e, config, _| {
            config.enforced =
                replace(e, &config.enforced, "acc_a", one(e, "acc_a", Cond::Always, PARI, &[Interest(0), Principal(0)]));
        }),
        REFUSED
    );
    assert_eq!(
        check(|e, config, _| {
            config.normal = replace(e, &config.normal, "reserve", one(e, "reserve", Cond::Always, PARI, &[ReserveRefill]));
        }),
        REFUSED
    );
    // Interest of all classes in one pari passu rank is valid.
    assert_eq!(
        check(|e, config, _| {
            config.normal = ranks(
                e,
                &[
                    ("fees", Cond::Always, SEQ, &[Fee(0)]),
                    ("interest", Cond::Always, PARI, &[Interest(0), Interest(1), Interest(2)]),
                    ("reserve", Cond::Always, SEQ, &[ReserveRefill]),
                    ("principal", Cond::Always, PARI, &ALL),
                    ("residual", Cond::Always, SEQ, &[Residual]),
                ],
            );
        }),
        Ok(())
    );
}

#[test]
fn validation_refuses_a_draw_rank_that_is_unknown_or_holds_principal() {
    let draw = |ids: &'static [&'static str], release: Release| {
        check(move |e, config, _| {
            config.reserve.release = release;
            let mut list: Vec<Symbol> = Vec::new(e);
            for id in ids.iter() {
                list.push_back(sym(e, id));
            }
            config.reserve.draw_ranks = list;
        })
    };
    assert_eq!(draw(&["fees", "int_a", "int_b"], Release::OnNeed), Ok(()));
    assert_eq!(draw(&[], Release::OnNeed), Ok(()));
    // The reserve never pays principal.
    assert_eq!(draw(&["fees", "principal"], Release::OnNeed), REFUSED);
    // Not a fee or an interest rank.
    assert_eq!(draw(&["reserve"], Release::OnNeed), REFUSED);
    assert_eq!(draw(&["residual"], Release::OnNeed), REFUSED);
    // Not a rank of the normal order.
    assert_eq!(draw(&["acc_a"], Release::OnNeed), REFUSED);
    assert_eq!(draw(&["nowhere"], Release::OnNeed), REFUSED);
    // A reserve released in full has no draw rank.
    assert_eq!(draw(&["fees"], Release::Full), REFUSED);
}

#[test]
fn validation_refuses_a_reserve_without_a_refill_rank() {
    assert_eq!(check(|e, config, _| config.normal = without(e, &config.normal, "reserve")), REFUSED);
    // A deal with no reserve needs no refill rank.
    assert_eq!(
        check(|e, config, _| {
            config.reserve.required = RequiredRule::Fixed(0);
            config.normal = without(e, &config.normal, "reserve");
        }),
        Ok(())
    );
    // A percent rule with a floor is a reserve.
    assert_eq!(
        check(|e, config, _| {
            config.reserve.required = RequiredRule::PctOfNotes(0, 1);
            config.normal = without(e, &config.normal, "reserve");
        }),
        REFUSED
    );
    // Two refill ranks that can both run.
    assert_eq!(
        check(|e, config, _| {
            let mut order = without(e, &config.normal, "residual");
            order.push_back(one(e, "reserve_2", Cond::Always, SEQ, &[ReserveRefill]));
            order.push_back(one(e, "residual", Cond::Always, SEQ, &[Residual]));
            config.normal = order;
        }),
        REFUSED
    );
}

#[test]
fn validation_refuses_more_than_the_limits() {
    // 5 fee lines.
    assert_eq!(
        check(|_, config, parties| {
            for _ in 0..4 {
                config.fees.push_back(FeeLine { recipient: parties.fees_2.clone(), amount: FeeAmount::Fixed(1) });
            }
        }),
        REFUSED
    );
    // 5 triggers.
    assert_eq!(
        check(|e, config, _| {
            for id in ["a", "b", "c", "d", "e"] {
                config.triggers.push_back(trigger(e, id, Metric::NotesFactor, Op::Lt, 1, false));
            }
        }),
        REFUSED
    );
    assert_eq!(
        check(|e, config, _| {
            for id in ["a", "b", "c", "d"] {
                config.triggers.push_back(trigger(e, id, Metric::NotesFactor, Op::Lt, 1, false));
            }
        }),
        Ok(())
    );
    // A rank with no item.
    assert_eq!(
        check(|e, config, _| {
            config.normal = replace(e, &config.normal, "reserve", one(e, "reserve", Cond::Always, SEQ, &[]));
        }),
        REFUSED
    );
    // A rank with 9 items: the principal of the 3 classes, 3 times.
    assert_eq!(
        check(|e, config, _| {
            let items = [ALL, ALL, ALL].concat();
            config.normal = normal_with(e, &[("principal", Cond::Always, SEQ, &items)]);
        }),
        REFUSED
    );
}

#[test]
fn validation_refuses_the_same_address_as_admin_and_servicer() {
    assert_eq!(
        check(|_, config, _| config.servicer = config.admin.clone()),
        Err(DealError::RoleConflict)
    );
}

#[test]
#[should_panic]
fn the_constructor_refuses_an_invalid_configuration() {
    // The contract is not deployed when `validate` refuses its configuration.
    build(|e, config, _| config.normal = without(e, &config.normal, "int_c"));
}

#[test]
#[should_panic]
fn the_constructor_refuses_the_same_admin_and_servicer() {
    build(|_, config, _| config.servicer = config.admin.clone());
}
