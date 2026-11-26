#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{
    contract as mock_contract, contractimpl as mock_contractimpl, Address, Env, String,
};

const DAY: u64 = 86_400;
const T0: u64 = 1_800_000_000;
const DENOMINATION: i128 = 1_000; // 100 EURC at 1dp for readable numbers

/// A minimal controller. Every holder is eligible, except the holders that
/// `deny` puts on its deny list.
#[mock_contract]
pub struct MockController;

#[mock_contractimpl]
impl MockController {
    pub fn deny(e: Env, holder: Address) {
        e.storage().instance().set(&holder, &true);
    }
    pub fn is_eligible(e: Env, holder: Address) -> bool {
        !e.storage().instance().has(&holder)
    }
}

struct Setup {
    e: Env,
    token: NoteTokenClient<'static>,
    controller: Address,
    alice: Address,
    bob: Address,
}

fn setup() -> Setup {
    let e = Env::default();
    e.ledger().with_mut(|ledger| ledger.timestamp = T0);
    e.mock_all_auths();
    let controller = e.register(MockController, ());
    let token_id = e.register(
        NoteToken,
        (
            controller.clone(),
            String::from_str(&e, "CARA7 Class A Senior Note"),
            String::from_str(&e, "CARA7A"),
            DENOMINATION,
        ),
    );
    let token = NoteTokenClient::new(&e, &token_id);
    let alice = Address::generate(&e);
    let bob = Address::generate(&e);
    Setup { e, token, controller, alice, bob }
}

/// Issue 100 notes to alice, finalize at T0.
fn issued() -> Setup {
    let s = setup();
    s.token.issue(&s.alice, &100);
    s.token.finalize_issuance(&T0);
    s
}

fn at(s: &Setup, ts: u64) {
    s.e.ledger().with_mut(|ledger| ledger.timestamp = ts);
}

#[test]
fn metadata_and_decimals_zero() {
    let s = setup();
    assert_eq!(s.token.decimals(), 0);
    assert_eq!(s.token.denomination(), DENOMINATION);
    assert_eq!(s.token.symbol(), String::from_str(&s.e, "CARA7A"));
    assert_eq!(s.token.total_supply(), 0);
}

#[test]
fn issue_then_finalize_freezes_supply() {
    let s = setup();
    s.token.issue(&s.alice, &60);
    s.token.issue(&s.bob, &40);
    assert_eq!(s.token.total_supply(), 100);
    s.token.finalize_issuance(&T0);
    assert!(s.token.try_issue(&s.alice, &1).is_err());
    assert!(s.token.try_finalize_issuance(&T0).is_err());
    assert_eq!(s.token.balance(&s.alice), 60);
    assert_eq!(s.token.balance(&s.bob), 40);
}

#[test]
fn controller_view_returns_the_controller() {
    let s = setup();
    assert_eq!(s.token.controller(), s.controller);
}

#[test]
fn transfer_to_a_receiver_off_the_whitelist_is_rejected() {
    let s = issued();
    MockControllerClient::new(&s.e, &s.controller).deny(&s.bob);
    assert_eq!(
        s.token.try_transfer(&s.alice, &s.bob, &10),
        Err(Ok(NoteError::NotEligible))
    );
    assert_eq!(s.token.balance(&s.alice), 100);
    assert_eq!(s.token.balance(&s.bob), 0);
    assert_eq!(s.token.holders().len(), 1);
}

#[test]
fn holder_removed_from_the_whitelist_can_still_sell_to_an_eligible_holder() {
    let s = issued();
    MockControllerClient::new(&s.e, &s.controller).deny(&s.alice);
    s.token.transfer(&s.alice, &s.bob, &30);
    assert_eq!(s.token.balance(&s.alice), 70);
    assert_eq!(s.token.balance(&s.bob), 30);
    // The removed holder cannot receive notes back.
    assert_eq!(
        s.token.try_transfer(&s.bob, &s.alice, &1),
        Err(Ok(NoteError::NotEligible))
    );
}

#[test]
fn transfer_blocked_before_finalize() {
    let s = setup();
    s.token.issue(&s.alice, &100);
    assert!(s.token.try_transfer(&s.alice, &s.bob, &10).is_err());
}

#[test]
fn holder_registry_appends_once() {
    let s = setup();
    s.token.issue(&s.alice, &50);
    s.token.issue(&s.alice, &50); // second issue, same holder
    s.token.finalize_issuance(&T0);
    assert_eq!(s.token.holders().len(), 1);
    s.token.transfer(&s.alice, &s.bob, &10);
    s.token.transfer(&s.alice, &s.bob, &10);
    let holders = s.token.holders();
    assert_eq!(holders.len(), 2);
    assert_eq!(holders.get(1).unwrap(), s.bob);
}

#[test]
fn controller_only_issue_and_roll() {
    let s = issued();
    s.e.set_auths(&[]);
    assert!(s.token.try_roll_period(&(T0 + DAY)).is_err());
    let s2 = setup();
    s2.e.set_auths(&[]);
    assert!(s2.token.try_issue(&s2.alice, &1).is_err());
}

#[test]
fn full_period_weight_equals_balance_times_length() {
    let s = issued();
    at(&s, T0 + 3 * DAY);
    let closed = s.token.roll_period(&(T0 + 3 * DAY));
    assert_eq!(closed, 1);
    assert_eq!(s.token.weight_of(&1, &s.alice), 100 * (3 * DAY) as i128);
    assert_eq!(s.token.total_weight(&1), 100 * (3 * DAY) as i128);
    assert_eq!(s.token.balance_at_end(&1, &s.alice), 100);
}

#[test]
fn mid_period_transfer_splits_weight_pro_rata_temporis() {
    let s = issued();
    // Day 1 of 3: alice sells half to bob.
    at(&s, T0 + DAY);
    s.token.transfer(&s.alice, &s.bob, &50);
    at(&s, T0 + 3 * DAY);
    s.token.roll_period(&(T0 + 3 * DAY));

    let alice_weight = 100 * DAY as i128 + 50 * (2 * DAY) as i128;
    let bob_weight = 50 * (2 * DAY) as i128;
    assert_eq!(s.token.weight_of(&1, &s.alice), alice_weight);
    assert_eq!(s.token.weight_of(&1, &s.bob), bob_weight);
    // The split is exact: weights sum to the total.
    assert_eq!(alice_weight + bob_weight, s.token.total_weight(&1));
    // Principal follows the holder of record at the period close.
    assert_eq!(s.token.balance_at_end(&1, &s.alice), 50);
    assert_eq!(s.token.balance_at_end(&1, &s.bob), 50);
}

#[test]
fn multiple_transfers_accumulate_weight() {
    let s = issued();
    at(&s, T0 + DAY);
    s.token.transfer(&s.alice, &s.bob, &30);
    at(&s, T0 + 2 * DAY);
    s.token.transfer(&s.bob, &s.alice, &10);
    at(&s, T0 + 3 * DAY);
    s.token.roll_period(&(T0 + 3 * DAY));

    let alice = 100 * DAY as i128 + 70 * DAY as i128 + 80 * DAY as i128;
    let bob = 30 * DAY as i128 + 20 * DAY as i128;
    assert_eq!(s.token.weight_of(&1, &s.alice), alice);
    assert_eq!(s.token.weight_of(&1, &s.bob), bob);
    assert_eq!(alice + bob, s.token.total_weight(&1));
}

#[test]
fn transfer_after_roll_freezes_prior_period_views() {
    let s = issued();
    at(&s, T0 + 3 * DAY);
    s.token.roll_period(&(T0 + 3 * DAY));
    // Period 2 open; alice transfers mid-period-2. Period 1 reads must keep
    // the pre-transfer figures.
    at(&s, T0 + 4 * DAY);
    s.token.transfer(&s.alice, &s.bob, &80);
    assert_eq!(s.token.weight_of(&1, &s.alice), 100 * (3 * DAY) as i128);
    assert_eq!(s.token.balance_at_end(&1, &s.alice), 100);
    assert_eq!(s.token.weight_of(&1, &s.bob), 0);
    assert_eq!(s.token.balance_at_end(&1, &s.bob), 0);
    // And period 2 splits day-weighted around the transfer.
    at(&s, T0 + 6 * DAY);
    s.token.roll_period(&(T0 + 6 * DAY));
    assert_eq!(
        s.token.weight_of(&2, &s.alice),
        100 * DAY as i128 + 20 * (2 * DAY) as i128
    );
    assert_eq!(s.token.weight_of(&2, &s.bob), 80 * (2 * DAY) as i128);
}

#[test]
fn idle_periods_fall_through_without_storage() {
    let s = issued();
    for period in 1..=4u32 {
        at(&s, T0 + (3 * period as u64) * DAY);
        s.token.roll_period(&(T0 + (3 * period as u64) * DAY));
    }
    // alice never transferred: every closed period reads balance x length.
    for period in 1..=4u32 {
        assert_eq!(s.token.weight_of(&period, &s.alice), 100 * (3 * DAY) as i128);
        assert_eq!(s.token.balance_at_end(&period, &s.alice), 100);
    }
    // A transfer in period 5 freezes all four slept-through periods.
    at(&s, T0 + 13 * DAY);
    s.token.transfer(&s.alice, &s.bob, &100);
    for period in 1..=4u32 {
        assert_eq!(s.token.weight_of(&period, &s.alice), 100 * (3 * DAY) as i128);
        assert_eq!(s.token.balance_at_end(&period, &s.alice), 100);
    }
}

#[test]
fn new_holder_reads_zero_for_periods_before_entry() {
    let s = issued();
    at(&s, T0 + 3 * DAY);
    s.token.roll_period(&(T0 + 3 * DAY));
    at(&s, T0 + 4 * DAY);
    s.token.transfer(&s.alice, &s.bob, &40);
    assert_eq!(s.token.weight_of(&1, &s.bob), 0);
    assert_eq!(s.token.balance_at_end(&1, &s.bob), 0);
}

#[test]
fn seller_out_completely_keeps_partial_weight_then_zero() {
    let s = issued();
    at(&s, T0 + DAY);
    s.token.transfer(&s.alice, &s.bob, &100); // alice fully out on day 1
    at(&s, T0 + 3 * DAY);
    s.token.roll_period(&(T0 + 3 * DAY));
    assert_eq!(s.token.weight_of(&1, &s.alice), 100 * DAY as i128);
    assert_eq!(s.token.balance_at_end(&1, &s.alice), 0);
    at(&s, T0 + 6 * DAY);
    s.token.roll_period(&(T0 + 6 * DAY));
    assert_eq!(s.token.weight_of(&2, &s.alice), 0);
    assert_eq!(s.token.weight_of(&2, &s.bob), 100 * (3 * DAY) as i128);
}

#[test]
fn self_transfer_is_a_no_op() {
    let s = issued();
    at(&s, T0 + DAY);
    s.token.transfer(&s.alice, &s.alice, &50);
    assert_eq!(s.token.balance(&s.alice), 100);
    at(&s, T0 + 3 * DAY);
    s.token.roll_period(&(T0 + 3 * DAY));
    assert_eq!(s.token.weight_of(&1, &s.alice), 100 * (3 * DAY) as i128);
}

#[test]
fn allowance_and_transfer_from() {
    let s = issued();
    let spender = Address::generate(&s.e);
    s.token.approve(&s.alice, &spender, &30, &1_000);
    assert_eq!(s.token.allowance(&s.alice, &spender), 30);
    s.token.transfer_from(&spender, &s.alice, &s.bob, &20);
    assert_eq!(s.token.balance(&s.bob), 20);
    assert_eq!(s.token.allowance(&s.alice, &spender), 10);
    assert!(s.token.try_transfer_from(&spender, &s.alice, &s.bob, &11).is_err());
}

#[test]
fn views_reject_open_or_unknown_periods() {
    let s = issued();
    assert!(s.token.try_weight_of(&1, &s.alice).is_err()); // period 1 still open
    assert!(s.token.try_total_weight(&0).is_err());
    at(&s, T0 + 3 * DAY);
    s.token.roll_period(&(T0 + 3 * DAY));
    assert!(s.token.try_weight_of(&2, &s.alice).is_err()); // now open
    assert!(s.token.try_balance_at_end(&7, &s.alice).is_err());
}

#[test]
fn insufficient_balance_rejected() {
    let s = issued();
    assert!(s.token.try_transfer(&s.alice, &s.bob, &101).is_err());
    assert!(s.token.try_transfer(&s.alice, &s.bob, &0).is_err());
}
