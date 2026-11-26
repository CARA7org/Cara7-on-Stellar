#![cfg(test)]

use super::*;
use note_token::{NoteToken, NoteTokenClient as RealNoteClient};
use soroban_sdk::testutils::{Address as _, IssuerFlags, Ledger, StellarAssetContract as _};
use soroban_sdk::{
    contract as mock_contract, contractimpl as mock_contractimpl, token::StellarAssetClient, vec,
    Address, Env, String,
};

const DAY: u64 = 86_400;
const T0: u64 = 1_800_000_000;

/// The note-token asks its controller (the deal) whether a receiver is on
/// the whitelist. In these tests every holder is eligible.
#[mock_contract]
pub struct MockController;

#[mock_contractimpl]
impl MockController {
    pub fn is_eligible(_e: Env, _holder: Address) -> bool {
        true
    }
}

struct Setup {
    e: Env,
    agent: PayingAgentClient<'static>,
    note: RealNoteClient<'static>,
    asset: token::Client<'static>,
    asset_admin: StellarAssetClient<'static>,
    deal: Address,
    controller: Address,
    alice: Address,
    bob: Address,
}

fn setup() -> Setup {
    let e = Env::default();
    e.ledger().with_mut(|ledger| ledger.timestamp = T0);
    e.mock_all_auths();

    let issuer = Address::generate(&e);
    let sac = e.register_stellar_asset_contract_v2(issuer);
    // Revocable so tests can deauthorize a holder to force a failed push.
    sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    let asset = token::Client::new(&e, &sac.address());
    let asset_admin = StellarAssetClient::new(&e, &sac.address());

    let controller = e.register(MockController, ());
    let note_id = e.register(
        NoteToken,
        (
            controller.clone(),
            String::from_str(&e, "CARA7 Class A Senior Note"),
            String::from_str(&e, "CARA7A"),
            1_000i128,
        ),
    );
    let note = RealNoteClient::new(&e, &note_id);

    let deal = Address::generate(&e);
    let agent_id = e.register(
        PayingAgent,
        (deal.clone(), sac.address(), vec![&e, note_id.clone()]),
    );
    let agent = PayingAgentClient::new(&e, &agent_id);

    let alice = Address::generate(&e);
    let bob = Address::generate(&e);
    Setup { e, agent, note, asset, asset_admin, deal, controller, alice, bob }
}

fn at(s: &Setup, ts: u64) {
    s.e.ledger().with_mut(|ledger| ledger.timestamp = ts);
}

/// Issue alice 60 / bob 40 notes, finalize at T0, close period 1 at T0+3d.
fn one_period(s: &Setup) {
    s.note.issue(&s.alice, &60);
    s.note.issue(&s.bob, &40);
    s.note.finalize_issuance(&T0);
    at(s, T0 + 3 * DAY);
    s.note.roll_period(&(T0 + 3 * DAY));
}

/// Move `interest`+`principal` EURC into the agent and record the split.
fn fund(s: &Setup, period: u32, interest: i128, principal: i128, per_note: i128) {
    s.asset_admin.mint(&s.agent.address, &(interest + principal));
    s.agent.fund_period(
        &period,
        &vec![&s.e, ClassAlloc { interest, principal, per_note_principal: per_note }],
    );
}

#[test]
fn fund_period_is_deal_only() {
    let s = setup();
    one_period(&s);
    s.e.set_auths(&[]);
    let result = s.agent.try_fund_period(
        &1,
        &vec![&s.e, ClassAlloc { interest: 0, principal: 0, per_note_principal: 0 }],
    );
    assert!(result.is_err());
}

#[test]
fn fund_period_rejects_double_funding() {
    let s = setup();
    one_period(&s);
    fund(&s, 1, 1_000, 0, 0);
    let result = s.agent.try_fund_period(
        &1,
        &vec![&s.e, ClassAlloc { interest: 0, principal: 0, per_note_principal: 0 }],
    );
    assert_eq!(result, Err(Ok(AgentError::AlreadyFunded)));
}

#[test]
fn push_splits_interest_by_weight_and_principal_by_record() {
    let s = setup();
    one_period(&s);
    // Full period, no transfers: weights == balances. Interest 1,000 splits
    // 600/400; principal 5 per note -> 300/200.
    fund(&s, 1, 1_000, 500, 5);
    let cursor = s.agent.push_batch(&1, &0, &10);
    assert_eq!(cursor, 2);
    assert_eq!(s.asset.balance(&s.alice), 600 + 300);
    assert_eq!(s.asset.balance(&s.bob), 400 + 200);
    assert_eq!(s.asset.balance(&s.agent.address), 0);
    let totals = s.agent.get_holder_totals(&0, &s.alice);
    assert_eq!(totals.interest_paid, 600);
    assert_eq!(totals.principal_paid, 300);
}

#[test]
fn merkl_mid_period_transfer_splits_the_coupon() {
    let s = setup();
    s.note.issue(&s.alice, &100);
    s.note.finalize_issuance(&T0);
    // Alice sells 50 notes to bob after day 1 of 3.
    at(&s, T0 + DAY);
    s.note.transfer(&s.alice, &s.bob, &50);
    at(&s, T0 + 3 * DAY);
    s.note.roll_period(&(T0 + 3 * DAY));

    // Coupon 3,000: alice weight = 100x1d + 50x2d = 200 note-days of 300
    // -> 2,000; bob = 100 note-days -> 1,000. Principal 4/note by record:
    // alice 200, bob 200.
    fund(&s, 1, 3_000, 400, 4);
    s.agent.push_batch(&1, &0, &10);
    assert_eq!(s.asset.balance(&s.alice), 2_000 + 200);
    assert_eq!(s.asset.balance(&s.bob), 1_000 + 200);
}

#[test]
fn batch_cursor_resumes_across_calls() {
    let s = setup();
    // 25 holders of 4 notes each.
    let mut holders: Vec<Address> = Vec::new(&s.e);
    for _ in 0..25 {
        let holder = Address::generate(&s.e);
        s.note.issue(&holder, &4);
        holders.push_back(holder);
    }
    s.note.finalize_issuance(&T0);
    at(&s, T0 + 3 * DAY);
    s.note.roll_period(&(T0 + 3 * DAY));

    fund(&s, 1, 2_500, 0, 0);
    assert_eq!(s.agent.push_batch(&1, &0, &10), 10);
    assert_eq!(s.agent.push_batch(&1, &0, &10), 20);
    // Requests above the ceiling are clamped to 10.
    assert_eq!(s.agent.push_batch(&1, &0, &99), 25);
    let state = s.agent.get_alloc(&1, &0).unwrap();
    assert!(state.done);
    // 2,500 / 25 holders = 100 each, exact.
    for holder in holders.iter() {
        assert_eq!(s.asset.balance(&holder), 100);
    }
    // Complete batch cannot be re-pushed.
    assert_eq!(s.agent.try_push_batch(&1, &0, &10), Err(Ok(AgentError::BatchComplete)));
}

#[test]
fn failed_push_parks_claimable_then_claim_pays() {
    let s = setup();
    one_period(&s);
    // Deauthorize bob on the asset: the push to him must fail over to a
    // claimable, without poisoning alice's payment.
    s.asset_admin.set_authorized(&s.bob, &false);
    fund(&s, 1, 1_000, 0, 0);
    s.agent.push_batch(&1, &0, &10);
    assert_eq!(s.asset.balance(&s.alice), 600);
    assert_eq!(s.asset.balance(&s.bob), 0);
    let claimable = s.agent.get_claimable(&0, &s.bob);
    assert_eq!(claimable.interest, 400);
    // Totals only count money actually received.
    assert_eq!(s.agent.get_holder_totals(&0, &s.bob).interest_paid, 0);

    s.asset_admin.set_authorized(&s.bob, &true);
    let claimed = s.agent.claim(&s.bob);
    assert_eq!(claimed.interest, 400);
    assert_eq!(s.asset.balance(&s.bob), 400);
    assert_eq!(s.agent.get_holder_totals(&0, &s.bob).interest_paid, 400);
    assert_eq!(s.agent.get_claimable(&0, &s.bob).interest, 0);
}

#[test]
fn claim_with_nothing_rejected() {
    let s = setup();
    one_period(&s);
    assert_eq!(s.agent.try_claim(&s.alice), Err(Ok(AgentError::NothingToClaim)));
}

#[test]
fn totals_accumulate_across_periods() {
    let s = setup();
    one_period(&s);
    fund(&s, 1, 1_000, 500, 5);
    s.agent.push_batch(&1, &0, &10);
    at(&s, T0 + 6 * DAY);
    s.note.roll_period(&(T0 + 6 * DAY));
    fund(&s, 2, 500, 100, 1);
    s.agent.push_batch(&2, &0, &10);

    let totals = s.agent.get_holder_totals(&0, &s.alice);
    assert_eq!(totals.interest_paid, 600 + 300);
    assert_eq!(totals.principal_paid, 300 + 60);
}

#[test]
fn interest_dust_folds_into_next_pot() {
    let s = setup();
    // 3 holders x 1 note: a 1,000 pot floors to 333 each, 1 leftover.
    let carol = Address::generate(&s.e);
    s.note.issue(&s.alice, &1);
    s.note.issue(&s.bob, &1);
    s.note.issue(&carol, &1);
    s.note.finalize_issuance(&T0);
    at(&s, T0 + 3 * DAY);
    s.note.roll_period(&(T0 + 3 * DAY));
    fund(&s, 1, 1_000, 0, 0);
    s.agent.push_batch(&1, &0, &10);
    assert_eq!(s.asset.balance(&s.alice), 333);
    assert_eq!(s.agent.get_dust(&0), 1);

    // Next period's pot = 999 + dust 1 = 1,000 -> 333 with a fresh 1 carry.
    at(&s, T0 + 6 * DAY);
    s.note.roll_period(&(T0 + 6 * DAY));
    fund(&s, 2, 999, 0, 0);
    assert_eq!(s.agent.get_dust(&0), 0); // drained into the pot
    s.agent.push_batch(&2, &0, &10);
    assert_eq!(s.asset.balance(&s.alice), 333 + 333);
    assert_eq!(s.agent.get_dust(&0), 1);
}

#[test]
fn zero_length_period_falls_back_to_record_balance_split() {
    let s = setup();
    s.note.issue(&s.alice, &60);
    s.note.issue(&s.bob, &40);
    s.note.finalize_issuance(&T0);
    // Roll at the same timestamp: total weight is 0.
    s.note.roll_period(&T0);
    fund(&s, 1, 1_000, 0, 0);
    s.agent.push_batch(&1, &0, &10);
    assert_eq!(s.asset.balance(&s.alice), 600);
    assert_eq!(s.asset.balance(&s.bob), 400);
}

#[test]
fn push_unknown_period_rejected() {
    let s = setup();
    one_period(&s);
    assert_eq!(s.agent.try_push_batch(&9, &0, &10), Err(Ok(AgentError::UnknownPeriod)));
    assert_eq!(s.agent.try_push_batch(&1, &7, &10), Err(Ok(AgentError::BadClass)));
}

#[test]
fn agent_balance_invariant_holds_with_open_claims() {
    let s = setup();
    one_period(&s);
    s.asset_admin.set_authorized(&s.bob, &false);
    fund(&s, 1, 1_001, 500, 5);
    s.agent.push_batch(&1, &0, &10);
    // Agent keeps: bob's claimable (interest 400 + principal 200) + the
    // 1-unit pro-rata dust from the 1,001 pot (600/400 floor).
    let claimable = s.agent.get_claimable(&0, &s.bob);
    let expected = claimable.interest + claimable.principal + s.agent.get_dust(&0);
    assert_eq!(s.asset.balance(&s.agent.address), expected);
}
