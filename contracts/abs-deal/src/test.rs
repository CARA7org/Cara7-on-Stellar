#![cfg(test)]

use super::*;
use crate::reference::{reference_config, Reference};
use note_token::NoteToken;
use paying_agent::{PayingAgent, PayingAgentClient};
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{
    contract as mock_contract, contractimpl as mock_contractimpl, token::StellarAssetClient, vec,
    Address, Env, String,
};

const DAY: u64 = 86_400;
const T0: u64 = 1_800_000_000;
const DENOMINATION: i128 = 1_000;
// Classes A/B/C: 1,000 / 700 / 450 notes of 1,000 units = the v3.1 test
// nominals 1,000,000 / 700,000 / 450,000. Fixing 2.209% + 0.60% spread,
// 30-day period, actual/360: period interest A 2,340 / B 583 / C 562.
const NOTES_A: i128 = 1_000;
const NOTES_B: i128 = 700;
const NOTES_C: i128 = 450;

/// Minimal in-test oracle exposing the RateOracle `lastprice` surface.
#[mock_contract]
pub struct MockOracle;

#[mock_contractimpl]
impl MockOracle {
    pub fn set(e: Env, price: i128, timestamp: u64) {
        e.storage().instance().set(&0u32, &PriceData { price, timestamp });
    }
    pub fn lastprice(e: Env) -> Option<PriceData> {
        e.storage().instance().get(&0u32)
    }
    /// The reporter of this oracle is the oracle itself: an address that is
    /// not the admin and not the servicer of a deal.
    pub fn get_reporter(e: Env) -> Address {
        e.current_contract_address()
    }
}

struct Setup {
    e: Env,
    deal: AbsDealClient<'static>,
    agent: PayingAgentClient<'static>,
    notes: Vec<Address>,
    asset: token::Client<'static>,
    asset_admin: StellarAssetClient<'static>,
    oracle: MockOracleClient<'static>,
    admin: Address,
    servicer: Address,
    seller: Address,
    fees_recipient: Address,
    investor_a: Address,
    investor_b: Address,
    investor_c: Address,
}

fn setup() -> Setup {
    let e = Env::default();
    e.ledger().with_mut(|ledger| ledger.timestamp = T0);
    e.mock_all_auths_allowing_non_root_auth();

    let issuer = Address::generate(&e);
    let sac = e.register_stellar_asset_contract_v2(issuer);
    let asset = token::Client::new(&e, &sac.address());
    let asset_admin = StellarAssetClient::new(&e, &sac.address());

    let oracle_id = e.register(MockOracle, ());
    let oracle = MockOracleClient::new(&e, &oracle_id);
    oracle.set(&2209, &T0);

    let admin = Address::generate(&e);
    let servicer = Address::generate(&e);
    let seller = Address::generate(&e);
    let fees_recipient = Address::generate(&e);

    // The reference configuration: fees, interest A/B/C, reserve re-fund,
    // sequential principal, residual.
    let config = reference_config(
        &e,
        Reference {
            admin: &admin,
            asset: &sac.address(),
            oracle: &oracle_id,
            seller: &seller,
            servicer: &servicer,
            fees_recipient: &fees_recipient,
            fees_per_period: 50,
            required_reserve: 5_000,
            days_in_period: 30,
            oracle_max_staleness_secs: 7 * 86_400,
            note_denomination: DENOMINATION,
            round_unit: 1,
            classes: &[
                (RateSpec::Floating(600), NOTES_A),
                (RateSpec::Fixed(1_000), NOTES_B),
                (RateSpec::Fixed(1_500), NOTES_C),
            ],
        },
    );
    let deal_id = e.register(AbsDeal, (config,));
    let deal = AbsDealClient::new(&e, &deal_id);

    let mut notes: Vec<Address> = Vec::new(&e);
    for (name, symbol) in [
        ("CARA7 Class A Senior Note", "CARA7A"),
        ("CARA7 Class B Mezzanine Note", "CARA7B"),
        ("CARA7 Class C Junior Note", "CARA7C"),
    ] {
        let note_id = e.register(
            NoteToken,
            (
                deal_id.clone(),
                String::from_str(&e, name),
                String::from_str(&e, symbol),
                DENOMINATION,
            ),
        );
        notes.push_back(note_id);
    }
    let agent_id = e.register(PayingAgent, (deal_id.clone(), sac.address(), notes.clone()));
    let agent = PayingAgentClient::new(&e, &agent_id);
    deal.set_wiring(&notes, &agent_id);

    let investor_a = Address::generate(&e);
    let investor_b = Address::generate(&e);
    let investor_c = Address::generate(&e);
    deal.set_eligible(
        &vec![&e, investor_a.clone(), investor_b.clone(), investor_c.clone()],
        &true,
    );
    asset_admin.mint(&investor_a, &(NOTES_A * DENOMINATION));
    asset_admin.mint(&investor_b, &(NOTES_B * DENOMINATION));
    asset_admin.mint(&investor_c, &(NOTES_C * DENOMINATION));
    asset_admin.mint(&seller, &5_000);

    Setup {
        e, deal, agent, notes, asset, asset_admin, oracle, admin, servicer, seller,
        fees_recipient, investor_a, investor_b, investor_c,
    }
}

fn subscribe_all(s: &Setup) {
    s.deal.subscribe(&s.investor_a, &0, &NOTES_A);
    s.deal.subscribe(&s.investor_b, &1, &NOTES_B);
    s.deal.subscribe(&s.investor_c, &2, &NOTES_C);
    s.deal.fund_sub_loan(&5_000);
}

fn closed() -> Setup {
    let s = setup();
    subscribe_all(&s);
    s.deal.close();
    s
}

fn distribute(s: &Setup, period: u32, collections: i128) -> Vec<i128> {
    if collections > 0 {
        s.asset_admin.mint(&s.servicer, &collections);
    }
    s.deal.distribute(&period, &collections)
}

// --- Funding & closing ------------------------------------------------------

#[test]
fn subscribe_pulls_eurc_and_caps_at_class_size() {
    let s = setup();
    s.deal.subscribe(&s.investor_a, &0, &600);
    assert_eq!(s.asset.balance(&s.investor_a), 400 * DENOMINATION);
    assert_eq!(s.asset.balance(&s.deal.address), 600 * DENOMINATION);
    assert_eq!(s.deal.get_subscription(&0, &s.investor_a), 600);
    assert_eq!(s.deal.get_sub_totals(), vec![&s.e, 600, 0, 0]);
    // 401 more would overshoot the 1,000-note class.
    assert_eq!(
        s.deal.try_subscribe(&s.investor_a, &0, &401),
        Err(Ok(DealError::ClassFull))
    );
}

#[test]
fn cancel_refunds_before_closing() {
    let s = setup();
    s.deal.subscribe(&s.investor_a, &0, &600);
    s.deal.cancel(&s.investor_a, &0, &250);
    assert_eq!(s.asset.balance(&s.investor_a), 650 * DENOMINATION);
    assert_eq!(s.deal.get_subscription(&0, &s.investor_a), 350);
    assert_eq!(
        s.deal.try_cancel(&s.investor_a, &0, &351),
        Err(Ok(DealError::InsufficientSubscription))
    );
}

#[test]
fn cancel_after_close_is_impossible() {
    let s = closed();
    assert_eq!(
        s.deal.try_cancel(&s.investor_a, &0, &1),
        Err(Ok(DealError::WrongState))
    );
}

#[test]
fn sub_loan_escrow_and_refund() {
    let s = setup();
    s.deal.fund_sub_loan(&3_000);
    assert_eq!(s.deal.get_sub_loan(), 3_000);
    s.deal.refund_sub_loan(&1_000);
    assert_eq!(s.deal.get_sub_loan(), 2_000);
    assert_eq!(s.asset.balance(&s.seller), 3_000);
    assert_eq!(s.deal.try_refund_sub_loan(&2_001), Err(Ok(DealError::InvalidAmount)));
}

#[test]
fn close_requires_full_subscription_and_exact_sub_loan() {
    let s = setup();
    s.deal.subscribe(&s.investor_a, &0, &NOTES_A);
    s.deal.fund_sub_loan(&5_000);
    // B and C not subscribed.
    assert_eq!(s.deal.try_close(), Err(Ok(DealError::NotFullySubscribed)));
    s.deal.subscribe(&s.investor_b, &1, &NOTES_B);
    s.deal.subscribe(&s.investor_c, &2, &NOTES_C);
    s.deal.refund_sub_loan(&1_000);
    assert_eq!(s.deal.try_close(), Err(Ok(DealError::SubLoanShort)));
}

#[test]
fn closing_dvp_is_atomic_and_net_zero() {
    let s = setup();
    subscribe_all(&s);
    let proceeds = (NOTES_A + NOTES_B + NOTES_C) * DENOMINATION;
    s.deal.close();

    // Purchase price to the Seller, reserve = sub-loan, nothing else stays.
    assert_eq!(s.asset.balance(&s.seller), proceeds);
    assert_eq!(s.asset.balance(&s.deal.address), 5_000);
    assert_eq!(s.deal.get_reserve(), 5_000);
    assert_eq!(s.deal.get_sub_loan(), 0);
    assert_eq!(s.deal.get_state(), State::Amortizing);
    assert_eq!(s.deal.get_next_period(), 1);
    // Notes issued at par; transfers open.
    let note_a = note_token::NoteTokenClient::new(&s.e, &s.notes.get(0).unwrap());
    assert_eq!(note_a.balance(&s.investor_a), NOTES_A);
    assert_eq!(note_a.total_supply(), NOTES_A);
    note_a.transfer(&s.investor_a, &s.investor_b, &10);
    assert_eq!(note_a.balance(&s.investor_b), 10);
    // Factors at 100%.
    assert_eq!(
        s.deal.get_note_factors(),
        vec![&s.e, FACTOR_SCALE, FACTOR_SCALE, FACTOR_SCALE]
    );
    assert_eq!(s.deal.try_close(), Err(Ok(DealError::WrongState)));
}

#[test]
fn abort_keeps_exits_open_and_blocks_subscriptions() {
    let s = setup();
    s.deal.subscribe(&s.investor_a, &0, &600);
    s.deal.fund_sub_loan(&2_000);
    s.deal.abort();
    assert_eq!(s.deal.get_state(), State::Aborted);
    assert_eq!(
        s.deal.try_subscribe(&s.investor_b, &1, &1),
        Err(Ok(DealError::WrongState))
    );
    s.deal.cancel(&s.investor_a, &0, &600);
    s.deal.refund_sub_loan(&2_000);
    assert_eq!(s.asset.balance(&s.investor_a), NOTES_A * DENOMINATION);
    assert_eq!(s.asset.balance(&s.deal.address), 0);
}

#[test]
fn wiring_is_one_shot_and_length_checked() {
    let s = setup();
    assert_eq!(
        s.deal.try_set_wiring(&s.notes, &s.agent.address),
        Err(Ok(DealError::AlreadyWired))
    );
    // A fresh deal rejects a wiring with the wrong class count.
    let config = s.deal.get_config();
    let deal2_id = s.e.register(AbsDeal, (config,));
    let deal2 = AbsDealClient::new(&s.e, &deal2_id);
    let short: Vec<Address> = vec![&s.e, s.notes.get(0).unwrap()];
    assert_eq!(
        deal2.try_set_wiring(&short, &s.agent.address),
        Err(Ok(DealError::InvalidConfig))
    );
    // Unwired deals cannot close.
    assert_eq!(deal2.try_close(), Err(Ok(DealError::NotWired)));
}

#[test]
fn distribute_before_close_is_rejected() {
    let s = setup();
    assert_eq!(s.deal.try_distribute(&1, &1_000), Err(Ok(DealError::WrongState)));
}

// --- Waterfall v4 -----------------------------------------------------------

#[test]
fn full_cascade_v4_reserve_full_cycle_and_per_note_rounding() {
    let s = closed();
    let paid = distribute(&s, 1, 100_000);

    // ADA = 100,000 + 5,000 released reserve. Fees 50.
    // Interest (due / per-note paid x notes / dust):
    //   A 2,340 -> 2 x 1,000 = 2,000, dust 340
    //   B   583 -> 0 x   700 =     0, dust 583
    //   C   562 -> 1 x   450 =   450, dust 112
    // Reserve re-funded 5,000. Principal A: 96,465 -> 96 x 1,000 = 96,000,
    // dust 465. Carry = 1,500.
    assert_eq!(s.asset.balance(&s.fees_recipient), 50);
    assert_eq!(paid, vec![&s.e, 2_000 + 96_000, 0, 450]);
    assert_eq!(s.asset.balance(&s.agent.address), 2_000 + 450 + 96_000);
    assert_eq!(s.deal.get_reserve(), 5_000);
    assert_eq!(s.deal.get_carry(), 1_500);
    assert_eq!(s.deal.get_shortfalls(), vec![&s.e, 0, 0, 0]);
    assert_eq!(
        s.deal.get_outstanding(),
        vec![&s.e, 904 * NOTES_A, 1_000 * NOTES_B, 1_000 * NOTES_C]
    );
    // Note factor A = 904/1,000 in FACTOR_SCALE units.
    assert_eq!(
        s.deal.get_note_factors(),
        vec![&s.e, 904 * FACTOR_SCALE / 1_000, FACTOR_SCALE, FACTOR_SCALE]
    );
    // Invariant: deal balance == reserve + carry.
    assert_eq!(s.asset.balance(&s.deal.address), 5_000 + 1_500);
    // Nothing to the seller beyond the closing proceeds.
    assert_eq!(s.asset.balance(&s.seller), (NOTES_A + NOTES_B + NOTES_C) * DENOMINATION);
}

#[test]
fn zero_collections_period_is_legal_reserve_carries_interest() {
    let s = closed();
    distribute(&s, 1, 0);
    // ADA = 5,000 (released) + 0. Fees 50, interest entitled in full
    // (2,340 + 583 + 562), reserve re-fund shorted to the 1,465 leftover.
    assert_eq!(s.deal.get_shortfalls(), vec![&s.e, 0, 0, 0]);
    assert_eq!(s.deal.get_reserve(), 1_465);
    assert_eq!(s.deal.get_carry(), 340 + 583 + 112);
    assert_eq!(s.asset.balance(&s.deal.address), 1_465 + 1_035);
    // No principal moved.
    assert_eq!(s.deal.get_note_factors().get(0).unwrap(), FACTOR_SCALE);
}

#[test]
fn carry_reenters_next_period_ada() {
    let s = closed();
    distribute(&s, 1, 100_000);
    assert_eq!(s.deal.get_carry(), 1_500);
    // Period 2, zero collections: ADA = 5,000 + 1,500 carry. Fees 50.
    // A due on 904,000 = 2,116 -> paid 2,000, dust 116; B 583 -> 0/583;
    // C 562 -> 450/112. Re-fund gets the 3,189 leftover. New carry 811.
    distribute(&s, 2, 0);
    assert_eq!(s.deal.get_reserve(), 3_189);
    assert_eq!(s.deal.get_carry(), 811);
    assert_eq!(s.asset.balance(&s.deal.address), 4_000);
    assert_eq!(s.deal.get_shortfalls(), vec![&s.e, 0, 0, 0]);
}

#[test]
fn iqeq_per_note_rounding_vector() {
    // The real workbook, payment date 2026-02-20, in cents: an entitlement
    // of 954,999.39 EUR over 5,000 notes floors to 190.99/note ->
    // 954,950.00 paid, 49.39 carried forward.
    let (paid, dust) = AbsDeal::round_per_note(95_499_939, 5_000, 1);
    assert_eq!(paid, 95_495_000);
    assert_eq!(paid / 5_000, 19_099); // 190.99 EUR per note
    assert_eq!(dust, 4_939); // 49.39 EUR carry
    // Coarser grain (whole euros): per-note floors to 190.
    let (paid_eur, dust_eur) = AbsDeal::round_per_note(95_499_939, 5_000, 100);
    assert_eq!(paid_eur / 5_000, 19_000);
    assert_eq!(dust_eur, 95_499_939 - 19_000 * 5_000);
}

#[test]
fn shortfall_accrues_without_interest_and_clears() {
    let s = closed();
    distribute(&s, 1, 0); // reserve 1,465, carry 1,035
    distribute(&s, 2, 0);
    // ADA2 = 1,465 + 1,035 = 2,500. Fees 50. A due 2,340 entitled in full
    // (paid 2,000/dust 340), 110 left: B entitled 110 (paid 0/dust 110),
    // shortfall B 473; C entitled 0, shortfall 562.
    assert_eq!(s.deal.get_shortfalls(), vec![&s.e, 0, 473, 562]);
    assert_eq!(s.deal.get_reserve(), 0);
    assert_eq!(s.deal.get_carry(), 450);

    // Period 3: due = fresh accrual + shortfall, NO interest on shortfall.
    // B due = 583 + 473 = 1,056; C due = 562 + 562 = 1,124.
    distribute(&s, 3, 10_000);
    assert_eq!(s.deal.get_shortfalls(), vec![&s.e, 0, 0, 0]);
}

#[test]
fn sequential_principal_then_maturity_sweeps_everything() {
    let s = closed();
    let proceeds = (NOTES_A + NOTES_B + NOTES_C) * DENOMINATION;
    // Enough for fees + interest + full principal + 123 residual; the
    // 5,000 re-funded reserve is released again at maturity.
    let collections = 50 + 3_485 + proceeds + 123;
    distribute(&s, 1, collections);

    assert_eq!(s.deal.get_state(), State::Matured);
    assert_eq!(s.deal.get_outstanding(), vec![&s.e, 0, 0, 0]);
    assert_eq!(s.deal.get_note_factors(), vec![&s.e, 0, 0, 0]);
    assert_eq!(s.deal.get_reserve(), 0);
    assert_eq!(s.deal.get_carry(), 0);
    assert_eq!(s.asset.balance(&s.deal.address), 0);
    // Seller: closing proceeds + wind-down sweep (residual 123 + reserve
    // 5,000 repaying the sub-loan + interest dust carry 1,035).
    assert_eq!(s.asset.balance(&s.seller), proceeds + 123 + 5_000 + 1_035);
    // Agent holds all interest + principal pending pushes.
    assert_eq!(
        s.asset.balance(&s.agent.address),
        2_000 + 0 + 450 + proceeds
    );
    assert_eq!(s.deal.try_distribute(&2, &0), Err(Ok(DealError::WrongState)));
}

#[test]
fn negative_fixing_floors_class_a_at_zero() {
    let s = closed();
    s.oracle.set(&-1_000, &T0); // all-in max(0, -0.40%) = 0
    distribute(&s, 1, 10_000);
    // A due 0; B/C fixed legs unchanged (0/583, 450/112). Reserve refunded
    // 5,000; principal A from the 8,805 leftover: 8 x 1,000, dust 805.
    assert_eq!(s.deal.get_shortfalls(), vec![&s.e, 0, 0, 0]);
    assert_eq!(s.deal.get_outstanding().get(0).unwrap(), 992 * NOTES_A);
    assert_eq!(s.deal.get_carry(), 583 + 112 + 805);
}

#[test]
fn stale_or_missing_oracle_blocks_distribution() {
    let s = closed();
    s.e.ledger().with_mut(|ledger| ledger.timestamp = T0 + 8 * DAY);
    s.asset_admin.mint(&s.servicer, &1_000);
    assert_eq!(s.deal.try_distribute(&1, &1_000), Err(Ok(DealError::RateStale)));
}

#[test]
fn enforcement_flips_to_accelerated_order() {
    let s = closed();
    assert_eq!(s.deal.try_set_enforced(), Ok(Ok(())));
    assert_eq!(s.deal.get_state(), State::Enforced);
    // 5,000 collections + 5,000 released reserve. Fees 50. A interest
    // 2,340 (2,000/340) then A principal 7,610 -> 7 x 1,000, dust 610.
    // B and C get NOTHING - shortfalls accrue. No reserve re-fund.
    distribute(&s, 1, 5_000);
    assert_eq!(s.asset.balance(&s.agent.address), 2_000 + 7_000);
    assert_eq!(s.deal.get_shortfalls(), vec![&s.e, 0, 583, 562]);
    assert_eq!(s.deal.get_outstanding().get(0).unwrap(), 993 * NOTES_A);
    assert_eq!(s.deal.get_reserve(), 0);
    assert_eq!(s.deal.get_carry(), 950);
}

#[test]
fn set_enforced_requires_amortizing() {
    let s = setup();
    assert_eq!(s.deal.try_set_enforced(), Err(Ok(DealError::WrongState)));
}

#[test]
fn period_mismatch_makes_distribute_idempotent() {
    let s = closed();
    s.asset_admin.mint(&s.servicer, &2_000);
    assert_eq!(s.deal.try_distribute(&2, &1_000), Err(Ok(DealError::PeriodMismatch)));
    s.deal.distribute(&1, &1_000);
    assert_eq!(s.deal.try_distribute(&1, &1_000), Err(Ok(DealError::PeriodMismatch)));
    assert_eq!(s.deal.get_next_period(), 2);
}

#[test]
fn distribute_requires_servicer_auth() {
    let s = closed();
    s.asset_admin.mint(&s.servicer, &1_000);
    s.e.set_auths(&[]);
    assert!(s.deal.try_distribute(&1, &1_000).is_err());
}

#[test]
fn eurc_is_conserved_across_periods() {
    let s = closed();
    let minted_at_close = (NOTES_A + NOTES_B + NOTES_C) * DENOMINATION + 5_000;
    let mut minted = minted_at_close;
    for (period, collections) in [(1u32, 40_000i128), (2, 0), (3, 25_000)] {
        distribute(&s, period, collections);
        minted += collections;
        let total = s.asset.balance(&s.deal.address)
            + s.asset.balance(&s.agent.address)
            + s.asset.balance(&s.seller)
            + s.asset.balance(&s.fees_recipient)
            + s.asset.balance(&s.servicer)
            + s.asset.balance(&s.investor_a)
            + s.asset.balance(&s.investor_b)
            + s.asset.balance(&s.investor_c);
        assert_eq!(total, minted);
    }
}

// --- Integration: the whole life with holder pushes -------------------------

#[test]
fn full_lifecycle_with_pushes_and_mid_period_transfer() {
    let s = closed();
    let note_a = note_token::NoteTokenClient::new(&s.e, &s.notes.get(0).unwrap());

    // Period 1.
    distribute(&s, 1, 100_000);
    for class in 0..3u32 {
        loop {
            let state = s.agent.get_alloc(&1, &class).unwrap();
            if state.done {
                break;
            }
            s.agent.push_batch(&1, &class, &10);
        }
    }
    // investor_a holds the full class: gets all A interest + principal.
    assert_eq!(s.asset.balance(&s.investor_a), 2_000 + 96_000);
    assert_eq!(s.asset.balance(&s.investor_c), 450);

    // Mid-period-2 secondary sale: investor_a sells 500 of 1,000 A notes
    // to investor_b at half-period.
    let half = T0 + 15 * DAY;
    s.e.ledger().with_mut(|ledger| ledger.timestamp = half);
    note_a.transfer(&s.investor_a, &s.investor_b, &500);
    s.e.ledger().with_mut(|ledger| ledger.timestamp = T0 + 30 * DAY);
    s.oracle.set(&2209, &(T0 + 30 * DAY));
    let balance_a_before = s.asset.balance(&s.investor_a);
    let balance_b_before = s.asset.balance(&s.investor_b);
    distribute(&s, 2, 50_000);
    for class in 0..3u32 {
        loop {
            let state = s.agent.get_alloc(&2, &class).unwrap();
            if state.done {
                break;
            }
            s.agent.push_batch(&2, &class, &10);
        }
    }
    // Class A period-2 interest pot: paid interest on 904,000 outstanding
    // = 2,116 -> per-note floor 2 x 1,000 = 2,000 into the pot. Weights:
    // a = 1,000 x 15d + 500 x 15d = 22,500 note-days; b = 500 x 15d =
    // 7,500; total 30,000. Interest a = 1,500 / b = 500. Principal per
    // note follows the record balances (500/500).
    let alloc = s.agent.get_alloc(&2, &0).unwrap();
    let per_note_principal = alloc.per_note_principal;
    let interest_a = s.asset.balance(&s.investor_a) - balance_a_before
        - per_note_principal * 500;
    let interest_b = s.asset.balance(&s.investor_b) - balance_b_before
        - per_note_principal * 500;
    assert_eq!(interest_a, 1_500);
    assert_eq!(interest_b, 500);
    // Holder counters reconcile with what actually arrived.
    let totals_a = s.agent.get_holder_totals(&0, &s.investor_a);
    assert_eq!(totals_a.interest_paid, 2_000 + 1_500);
    assert_eq!(totals_a.principal_paid, 96_000 + per_note_principal * 500);
}
