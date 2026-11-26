#![cfg(test)]
//! Tests of the generalized deal: other class counts, another denomination
//! and rounding unit, assets with the EURC and EURCV issuer rules, the
//! whitelist, the parked payouts, the balance checks with a surplus or a
//! deficit, the wiring checks and the network resource limits.

extern crate std;

use super::*;
use crate::reference::{reference_config, Reference};
use note_token::{NoteError, NoteToken, NoteTokenClient as NoteClient};
use paying_agent::{PayingAgent, PayingAgentClient as AgentClient};
use soroban_sdk::testutils::{Address as _, IssuerFlags, Ledger, StellarAssetContract as _};
use soroban_sdk::{
    contract as mock_contract, contractimpl as mock_contractimpl, token::StellarAssetClient, vec,
    Address, Env, String,
};

const T0: u64 = 1_800_000_000;
const DAY: u64 = 86_400;
/// One unit of an asset with 7 decimals, like EURC and EURCV.
const UNIT: i128 = 10_000_000;
const CENT: i128 = UNIT / 100;

/// Network limits of one transaction, read from mainnet and testnet on
/// 2026-11-17 (the same values). The SDK enforces older, lower values, so
/// these tests disable its check and compare with these values.
const TX_MAX_WRITE_ENTRIES: u32 = 200;
const TX_MAX_READ_ENTRIES: u32 = 200;
const TX_MAX_FOOTPRINT_ENTRIES: u32 = 400;
const TX_MAX_EVENTS_BYTES: u32 = 16_384;

#[mock_contract]
pub struct D2Oracle;

#[mock_contractimpl]
impl D2Oracle {
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

/// The issuer rules of the settlement asset.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    /// No issuer flag.
    Plain,
    /// The issuer can freeze an account (Circle EURC on mainnet).
    Revocable,
    /// Authorization required, freeze and clawback (SG-FORGE EURCV).
    EurcvLike,
}

struct Spec {
    classes: std::vec::Vec<(RateSpec, i128)>,
    denomination: i128,
    round_unit: i128,
    fees: i128,
    reserve: i128,
    kind: Kind,
    /// For `EurcvLike`: authorize the deal and the paying agent at setup.
    authorize_contracts: bool,
}

impl Spec {
    /// `count` classes: class A floats, the others are fixed. Notes of 10
    /// units, rounding to the cent, like the D2 demo deal.
    fn shape(count: u32, kind: Kind) -> Spec {
        let mut classes = std::vec::Vec::new();
        for index in 0..count as i128 {
            let rate = if index == 0 {
                RateSpec::Floating(600)
            } else {
                RateSpec::Fixed(1_000 + 500 * index)
            };
            classes.push((rate, (10 - index).max(2)));
        }
        Spec {
            classes,
            denomination: 10 * UNIT,
            round_unit: CENT,
            fees: CENT * 50,
            reserve: 5 * UNIT,
            kind,
            authorize_contracts: true,
        }
    }
}

struct D2 {
    e: Env,
    deal: AbsDealClient<'static>,
    agent: AgentClient<'static>,
    notes: Vec<Address>,
    asset: token::Client<'static>,
    sac: StellarAssetClient<'static>,
    oracle: D2OracleClient<'static>,
    admin: Address,
    servicer: Address,
    seller: Address,
    fees: Address,
    /// One investor per class; each holds the whole class.
    investors: std::vec::Vec<Address>,
    spec: Spec,
}

fn env() -> Env {
    let e = Env::default();
    e.ledger().with_mut(|ledger| ledger.timestamp = T0);
    e.mock_all_auths_allowing_non_root_auth();
    // The resource tests below check the real network limits themselves.
    e.cost_estimate().disable_resource_limits();
    e.cost_estimate().budget().reset_unlimited();
    e
}

/// Fail when the last invocation exceeds the network limits.
fn assert_fits_network(e: &Env, what: &str) {
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
}

fn asset(e: &Env, kind: Kind) -> (token::Client<'static>, StellarAssetClient<'static>) {
    let sac = e.register_stellar_asset_contract_v2(Address::generate(e));
    match kind {
        Kind::Plain => {}
        Kind::Revocable => sac.issuer().set_flag(IssuerFlags::RevocableFlag),
        Kind::EurcvLike => {
            sac.issuer().set_flag(IssuerFlags::RequiredFlag);
            sac.issuer().set_flag(IssuerFlags::RevocableFlag);
            sac.issuer().set_flag(IssuerFlags::ClawbackEnabledFlag);
        }
    }
    (token::Client::new(e, &sac.address()), StellarAssetClient::new(e, &sac.address()))
}

fn config(e: &Env, spec: &Spec, asset: &Address, oracle: &Address, roles: [&Address; 4]) -> DealConfig {
    // The reference order, for the class count of the spec.
    reference_config(
        e,
        Reference {
            admin: roles[0],
            asset,
            oracle,
            seller: roles[2],
            servicer: roles[1],
            fees_recipient: roles[3],
            fees_per_period: spec.fees,
            required_reserve: spec.reserve,
            days_in_period: 90,
            oracle_max_staleness_secs: 7 * DAY,
            note_denomination: spec.denomination,
            round_unit: spec.round_unit,
            classes: &spec.classes,
        },
    )
}

/// A note token of class `_index` for `deal`.
fn note(e: &Env, deal: &Address, _index: u32, denomination: i128) -> Address {
    e.register(
        NoteToken,
        (
            deal.clone(),
            String::from_str(e, "CARA7 D2 Class Note"),
            String::from_str(e, "CARA7D2"),
            denomination,
        ),
    )
}

fn build(spec: Spec) -> D2 {
    let e = env();
    let (asset, sac) = asset(&e, spec.kind);
    let oracle_id = e.register(D2Oracle, ());
    let oracle = D2OracleClient::new(&e, &oracle_id);
    oracle.set(&2209, &T0);
    let admin = Address::generate(&e);
    let servicer = Address::generate(&e);
    let seller = Address::generate(&e);
    let fees = Address::generate(&e);
    let deal_config = config(&e, &spec, &asset.address, &oracle_id, [&admin, &servicer, &seller, &fees]);
    let deal_id = e.register(AbsDeal, (deal_config,));
    let deal = AbsDealClient::new(&e, &deal_id);
    let mut notes: Vec<Address> = Vec::new(&e);
    for index in 0..spec.classes.len() as u32 {
        notes.push_back(note(&e, &deal_id, index, spec.denomination));
    }
    let agent_id = e.register(PayingAgent, (deal_id.clone(), asset.address.clone(), notes.clone()));
    let agent = AgentClient::new(&e, &agent_id);
    deal.set_wiring(&notes, &agent_id);

    let mut investors = std::vec::Vec::new();
    let mut listed: Vec<Address> = Vec::new(&e);
    for _ in 0..spec.classes.len() {
        let investor = Address::generate(&e);
        listed.push_back(investor.clone());
        investors.push(investor);
    }
    deal.set_eligible(&listed, &true);

    if spec.kind == Kind::EurcvLike {
        // The issuer must authorize every holder of the asset.
        for holder in investors.iter().chain([&servicer, &seller, &fees]) {
            sac.set_authorized(holder, &true);
        }
        if spec.authorize_contracts {
            sac.set_authorized(&deal_id, &true);
            sac.set_authorized(&agent_id, &true);
        }
    }
    for (index, investor) in investors.iter().enumerate() {
        sac.mint(investor, &(spec.classes[index].1 * spec.denomination));
    }
    sac.mint(&seller, &spec.reserve);

    D2 {
        e, deal, agent, notes, asset, sac, oracle, admin, servicer, seller, fees, investors,
        spec,
    }
}

fn subscribe_all(s: &D2) {
    for (index, investor) in s.investors.iter().enumerate() {
        s.deal.subscribe(investor, &(index as u32), &s.spec.classes[index].1);
    }
    if s.spec.reserve > 0 {
        s.deal.fund_sub_loan(&s.spec.reserve);
    }
}

fn closed(spec: Spec) -> D2 {
    let s = build(spec);
    subscribe_all(&s);
    s.deal.close();
    s
}

/// Advance 90 days, refresh the fixing, run the period with `collections`.
fn period(s: &D2, period: u32, collections: i128) -> Vec<i128> {
    let now = T0 + period as u64 * 90 * DAY;
    s.e.ledger().with_mut(|ledger| ledger.timestamp = now);
    s.oracle.set(&2209, &now);
    if collections > 0 {
        s.sac.mint(&s.servicer, &collections);
    }
    s.deal.distribute(&period, &collections)
}

fn push_all(s: &D2, period: u32) {
    for class in 0..s.notes.len() {
        while !s.agent.get_alloc(&period, &class).unwrap().done {
            s.agent.push_batch(&period, &class, &10);
        }
    }
}

fn face_total(s: &D2) -> i128 {
    s.spec.classes.iter().map(|(_, notes)| notes * s.spec.denomination).sum()
}

/// The deal invariant: balance >= reserve + carry + amounts owed.
fn assert_deal_covered(s: &D2) {
    let balance = s.asset.balance(&s.deal.address);
    assert!(balance >= s.deal.get_reserve() + s.deal.get_carry() + s.deal.get_owed_total());
}

// --- Shapes ---------------------------------------------------------------

#[test]
fn shapes_of_1_2_4_and_8_classes_run_a_full_life() {
    for count in [1u32, 2, 4, 8] {
        let s = closed(Spec::shape(count, Kind::Plain));
        let face = face_total(&s);
        let minted = face + s.spec.reserve;

        // Period 1: one third of the face. Period 2: enough to repay all.
        period(&s, 1, face / 3);
        push_all(&s, 1);
        assert_deal_covered(&s);
        period(&s, 2, face);
        push_all(&s, 2);
        assert_eq!(s.deal.get_state(), State::Matured, "{count} classes");
        assert_eq!(s.asset.balance(&s.deal.address), 0, "{count} classes");

        // Every holder got its full principal, and its counters match what
        // arrived in its account.
        for (index, investor) in s.investors.iter().enumerate() {
            let class = index as u32;
            let totals = s.agent.get_holder_totals(&class, investor);
            assert_eq!(totals.principal_paid, s.spec.classes[index].1 * s.spec.denomination);
            assert_eq!(s.asset.balance(investor), totals.interest_paid + totals.principal_paid);
            assert!(totals.interest_paid > 0, "{count} classes, class {class}");
        }

        // Conservation: no unit created or lost.
        let collections = face / 3 + face;
        let mut total = s.asset.balance(&s.deal.address)
            + s.asset.balance(&s.agent.address)
            + s.asset.balance(&s.seller)
            + s.asset.balance(&s.fees)
            + s.asset.balance(&s.servicer);
        for investor in s.investors.iter() {
            total += s.asset.balance(investor);
        }
        assert_eq!(total, minted + collections, "{count} classes");
    }
}

#[test]
#[should_panic]
fn nine_classes_are_rejected() {
    build(Spec::shape(9, Kind::Plain));
}

#[test]
fn denomination_of_1000_rounds_each_note_to_the_cent() {
    let s = closed(Spec {
        classes: std::vec![(RateSpec::Fixed(1_234), 7)],
        denomination: 1_000 * UNIT,
        round_unit: CENT,
        fees: 0,
        reserve: 0,
        kind: Kind::Plain,
        authorize_contracts: true,
    });
    // Due = 7,000 x 1.234 % x 90 / 360 = 21.595 per class, 3.085 per note.
    let due = 7 * 1_000 * UNIT * 1_234 * 90 / 360 / RATE_SCALE;
    assert_eq!(due, 215_950_000);
    let paid = period(&s, 1, due);
    // 3.085 per note floors to 3.08: 7 x 3.08 = 21.56, the 0.035 goes to carry.
    assert_eq!(paid, vec![&s.e, 7 * 308 * CENT]);
    assert_eq!(s.deal.get_carry(), due - 7 * 308 * CENT);
    let alloc = s.agent.get_alloc(&1, &0).unwrap();
    assert_eq!(alloc.interest_pot % (7 * CENT), 0);
}

// --- Whitelist --------------------------------------------------------------

#[test]
fn whitelist_gates_subscriptions_and_note_transfers() {
    let s = build(Spec::shape(2, Kind::Plain));
    let outsider = Address::generate(&s.e);
    s.sac.mint(&outsider, &(10 * UNIT));
    assert!(!s.deal.is_eligible(&outsider));
    assert_eq!(s.deal.try_subscribe(&outsider, &0, &1), Err(Ok(DealError::NotEligible)));

    subscribe_all(&s);
    s.deal.close();
    let note_a = NoteClient::new(&s.e, &s.notes.get(0).unwrap());
    let holder = s.investors[0].clone();
    let other = s.investors[1].clone();
    assert_eq!(note_a.try_transfer(&holder, &outsider, &1), Err(Ok(NoteError::NotEligible)));

    // A removed holder keeps its notes, is still paid, and sells only to a
    // listed holder.
    s.deal.set_eligible(&vec![&s.e, holder.clone()], &false);
    assert!(!s.deal.is_eligible(&holder));
    let before = s.asset.balance(&holder);
    period(&s, 1, face_total(&s) / 3);
    push_all(&s, 1);
    assert!(s.asset.balance(&holder) > before);
    note_a.transfer(&holder, &other, &1);
    assert_eq!(note_a.balance(&other), 1);
    assert_eq!(note_a.try_transfer(&other, &holder, &1), Err(Ok(NoteError::NotEligible)));
}

#[test]
fn only_the_admin_sets_the_whitelist() {
    let s = build(Spec::shape(1, Kind::Plain));
    let investor = Address::generate(&s.e);
    s.deal.set_eligible(&vec![&s.e, investor.clone()], &true);
    assert_eq!(s.e.auths()[0].0, s.admin);
    s.e.set_auths(&[]);
    assert!(s.deal.try_set_eligible(&vec![&s.e, investor], &false).is_err());
}

// --- Balance checks and parked payouts ---------------------------------------

#[test]
fn a_stroop_sent_to_the_deal_blocks_nothing() {
    let s = build(Spec::shape(2, Kind::Plain));
    subscribe_all(&s);
    s.sac.mint(&s.deal.address, &1);
    s.deal.close();
    s.sac.mint(&s.deal.address, &1);
    period(&s, 1, face_total(&s) / 3);
    push_all(&s, 1);
    period(&s, 2, face_total(&s));
    push_all(&s, 2);
    // The maturity sweep pays the surplus to the seller; nothing stays.
    assert_eq!(s.deal.get_state(), State::Matured);
    assert_eq!(s.asset.balance(&s.deal.address), 0);
}

#[test]
fn a_frozen_fees_recipient_or_seller_does_not_block_the_noteholders() {
    let s = closed(Spec::shape(2, Kind::Revocable));
    s.sac.set_authorized(&s.fees, &false);
    s.sac.set_authorized(&s.seller, &false);

    period(&s, 1, face_total(&s) / 3);
    push_all(&s, 1);
    assert_eq!(s.deal.get_owed(&s.fees), s.spec.fees);
    assert!(s.asset.balance(&s.investors[0]) > 0);
    assert_deal_covered(&s);

    period(&s, 2, face_total(&s));
    push_all(&s, 2);
    assert_eq!(s.deal.get_state(), State::Matured);
    let fees_owed = s.deal.get_owed(&s.fees);
    let seller_owed = s.deal.get_owed(&s.seller);
    assert_eq!(fees_owed, 2 * s.spec.fees);
    assert!(seller_owed > 0);
    assert_eq!(s.deal.get_owed_total(), fees_owed + seller_owed);
    assert_eq!(s.asset.balance(&s.deal.address), fees_owed + seller_owed);

    // A frozen recipient cannot take its payout yet.
    assert!(s.deal.try_claim_owed(&s.fees).is_err());
    s.sac.set_authorized(&s.fees, &true);
    s.sac.set_authorized(&s.seller, &true);
    assert_eq!(s.deal.claim_owed(&s.fees), fees_owed);
    assert_eq!(s.deal.claim_owed(&s.seller), seller_owed);
    assert_eq!(s.deal.try_claim_owed(&s.fees), Err(Ok(DealError::NothingOwed)));
    assert_eq!(s.asset.balance(&s.deal.address), 0);
    assert_eq!(s.deal.get_owed_total(), 0);
}

#[test]
fn a_clawback_stops_the_period_until_a_top_up() {
    let s = closed(Spec::shape(2, Kind::EurcvLike));
    s.sac.clawback(&s.deal.address, &1);
    let now = T0 + 90 * DAY;
    s.e.ledger().with_mut(|ledger| ledger.timestamp = now);
    s.oracle.set(&2209, &now);
    s.sac.mint(&s.servicer, &(face_total(&s) / 3));
    assert!(s.deal.try_distribute(&1, &(face_total(&s) / 3)).is_err());
    assert_eq!(s.deal.get_next_period(), 1);
    // Anyone can top up the missing unit; then the period runs.
    s.sac.mint(&s.deal.address, &1);
    s.deal.distribute(&1, &(face_total(&s) / 3));
    push_all(&s, 1);
    assert_deal_covered(&s);
}

#[test]
fn an_eurcv_like_asset_needs_the_deal_authorized_by_the_issuer() {
    let mut spec = Spec::shape(1, Kind::EurcvLike);
    spec.authorize_contracts = false;
    let s = build(spec);
    let investor = s.investors[0].clone();
    assert!(s.deal.try_subscribe(&investor, &0, &1).is_err());
    s.sac.set_authorized(&s.deal.address, &true);
    s.deal.subscribe(&investor, &0, &1);
    assert_eq!(s.deal.get_subscription(&0, &investor), 1);
}

#[test]
fn a_frozen_holder_is_paid_later_through_the_paying_agent() {
    let s = closed(Spec::shape(2, Kind::EurcvLike));
    let holder = s.investors[1].clone();
    s.sac.set_authorized(&holder, &false);
    period(&s, 1, face_total(&s) / 3);
    push_all(&s, 1);
    let claimable = s.agent.get_claimable(&1, &holder);
    assert!(claimable.interest > 0);
    s.sac.set_authorized(&holder, &true);
    s.agent.claim(&holder);
    assert_eq!(s.asset.balance(&holder), claimable.interest + claimable.principal);
}

// --- Wiring -----------------------------------------------------------------

struct Unwired {
    e: Env,
    deal: AbsDealClient<'static>,
    deal_id: Address,
    asset: Address,
    notes: Vec<Address>,
}

fn unwired() -> Unwired {
    let e = env();
    let spec = Spec::shape(2, Kind::Plain);
    let (asset, _) = asset(&e, Kind::Plain);
    let oracle = e.register(D2Oracle, ());
    let roles = [
        Address::generate(&e),
        Address::generate(&e),
        Address::generate(&e),
        Address::generate(&e),
    ];
    let deal_config = config(&e, &spec, &asset.address, &oracle, [&roles[0], &roles[1], &roles[2], &roles[3]]);
    let deal_id = e.register(AbsDeal, (deal_config,));
    let deal = AbsDealClient::new(&e, &deal_id);
    let notes = vec![
        &e,
        note(&e, &deal_id, 0, spec.denomination),
        note(&e, &deal_id, 1, spec.denomination),
    ];
    Unwired { e, deal, deal_id, asset: asset.address, notes }
}

fn agent_for(u: &Unwired, deal: &Address, asset: &Address, notes: &Vec<Address>) -> Address {
    u.e.register(PayingAgent, (deal.clone(), asset.clone(), notes.clone()))
}

#[test]
fn wiring_rejects_a_note_with_another_denomination() {
    let u = unwired();
    let wrong = vec![&u.e, u.notes.get(0).unwrap(), note(&u.e, &u.deal_id, 1, 11 * UNIT)];
    let agent = agent_for(&u, &u.deal_id, &u.asset, &wrong);
    assert_eq!(u.deal.try_set_wiring(&wrong, &agent), Err(Ok(DealError::WiringMismatch)));
}

#[test]
fn wiring_rejects_a_note_of_another_controller() {
    let u = unwired();
    let other_deal = Address::generate(&u.e);
    let wrong = vec![&u.e, u.notes.get(0).unwrap(), note(&u.e, &other_deal, 1, 10 * UNIT)];
    let agent = agent_for(&u, &u.deal_id, &u.asset, &wrong);
    assert_eq!(u.deal.try_set_wiring(&wrong, &agent), Err(Ok(DealError::WiringMismatch)));
}

#[test]
fn wiring_rejects_a_paying_agent_in_another_asset_or_for_another_deal() {
    let u = unwired();
    let (other_asset, _) = asset(&u.e, Kind::Plain);
    let agent = agent_for(&u, &u.deal_id, &other_asset.address, &u.notes);
    assert_eq!(u.deal.try_set_wiring(&u.notes, &agent), Err(Ok(DealError::WiringMismatch)));
    let agent = agent_for(&u, &Address::generate(&u.e), &u.asset, &u.notes);
    assert_eq!(u.deal.try_set_wiring(&u.notes, &agent), Err(Ok(DealError::WiringMismatch)));
}

#[test]
fn wiring_rejects_another_order_and_a_duplicate() {
    let u = unwired();
    let swapped = vec![&u.e, u.notes.get(1).unwrap(), u.notes.get(0).unwrap()];
    let agent = agent_for(&u, &u.deal_id, &u.asset, &u.notes);
    assert_eq!(u.deal.try_set_wiring(&swapped, &agent), Err(Ok(DealError::WiringMismatch)));
    let twice = vec![&u.e, u.notes.get(0).unwrap(), u.notes.get(0).unwrap()];
    let agent = agent_for(&u, &u.deal_id, &u.asset, &twice);
    assert_eq!(u.deal.try_set_wiring(&twice, &agent), Err(Ok(DealError::WiringMismatch)));
    // The right wiring passes.
    let agent = agent_for(&u, &u.deal_id, &u.asset, &u.notes);
    u.deal.set_wiring(&u.notes, &agent);
    assert_eq!(u.deal.get_wiring().unwrap().paying_agent, agent);
}

// --- Network resource limits --------------------------------------------------

/// A deal of `classes` classes of `notes_per_class` notes, and `count` new
/// listed investors with 1 note each, spread over the classes.
fn crowd(classes: u32, notes_per_class: i128, count: u32) -> (D2, std::vec::Vec<(u32, Address)>) {
    let mut spec = Spec::shape(classes, Kind::Plain);
    for class in spec.classes.iter_mut() {
        class.1 = notes_per_class;
    }
    let s = build(spec);
    let mut listed: Vec<Address> = Vec::new(&s.e);
    let mut crowd = std::vec::Vec::new();
    for index in 0..count {
        let investor = Address::generate(&s.e);
        s.sac.mint(&investor, &(2 * s.spec.denomination));
        listed.push_back(investor.clone());
        crowd.push((index % classes, investor));
    }
    s.deal.set_eligible(&listed, &true);
    (s, crowd)
}

#[test]
fn closing_with_the_maximum_of_subscriptions_fits_the_network_limits() {
    // 4 classes of 25 notes, 100 investors with 1 note each.
    let (s, crowd) = crowd(4, 25, MAX_SUBSCRIPTIONS);
    for (class, investor) in crowd.iter() {
        s.deal.subscribe(investor, class, &1);
    }
    assert_eq!(s.deal.get_subscription_count(), MAX_SUBSCRIPTIONS);
    s.deal.fund_sub_loan(&s.spec.reserve);
    s.deal.close();
    assert_fits_network(&s.e, "close, 100 subscriptions");
}

#[test]
fn distribute_with_8_classes_fits_the_network_limits() {
    let s = closed(Spec::shape(8, Kind::Plain));
    period(&s, 1, face_total(&s) / 3);
    assert_fits_network(&s.e, "distribute, 8 classes");
}

#[test]
fn subscriptions_stop_at_the_maximum_and_a_full_cancel_frees_a_place() {
    let (s, crowd) = crowd(2, 60, MAX_SUBSCRIPTIONS + 1);
    for (class, investor) in crowd.iter().take(MAX_SUBSCRIPTIONS as usize) {
        s.deal.subscribe(investor, class, &1);
    }
    let (last_class, last) = crowd.last().unwrap().clone();
    assert_eq!(
        s.deal.try_subscribe(&last, &last_class, &1),
        Err(Ok(DealError::TooManySubscriptions))
    );
    // A subscriber can add notes to its own subscription.
    let (first_class, first) = crowd[0].clone();
    s.deal.subscribe(&first, &first_class, &1);
    // A full cancel frees a place.
    s.deal.cancel(&first, &first_class, &2);
    assert_eq!(s.deal.get_subscription_count(), MAX_SUBSCRIPTIONS - 1);
    s.deal.subscribe(&last, &last_class, &1);
    assert_eq!(s.deal.get_subscription_count(), MAX_SUBSCRIPTIONS);
}

#[test]
fn a_full_cancel_then_a_new_subscription_issues_the_notes_once() {
    let s = build(Spec::shape(1, Kind::Plain));
    let investor = s.investors[0].clone();
    let notes = s.spec.classes[0].1;
    s.deal.subscribe(&investor, &0, &2);
    s.deal.cancel(&investor, &0, &2);
    s.deal.subscribe(&investor, &0, &notes);
    assert_eq!(s.deal.get_subscription_count(), 1);
    s.deal.fund_sub_loan(&s.spec.reserve);
    s.deal.close();
    let note_a = NoteClient::new(&s.e, &s.notes.get(0).unwrap());
    assert_eq!(note_a.balance(&investor), notes);
    assert_eq!(note_a.total_supply(), notes);
}
