#![cfg(test)]
//! The fixture of the rank engine tests.
//!
//! The base deal has the terms of `test.rs`: Classes A/B/C of 1,000 / 700 /
//! 450 notes of 1,000 units, a rounding unit of 1, a fixing of 2.209 % with a
//! spread of 0.60 % on Class A, 1.00 % and 1.50 % on Classes B and C, 30-day
//! periods, fees of 50 and a reserve of 5,000. One period of interest is then
//! A 2,340 / B 583 / C 562. A test changes the configuration before the
//! deployment with a closure.

extern crate std;

use crate::reference::{reference_config, Reference};
use crate::*;
use note_token::NoteToken;
use paying_agent::{PayingAgent, PayingAgentClient as AgentClient};
use soroban_sdk::testutils::{Address as _, Events as _, IssuerFlags, Ledger};
use soroban_sdk::xdr::{ContractEventBody, ScVal};
use soroban_sdk::{
    contract as mock_contract, contractimpl as mock_contractimpl, token::StellarAssetClient,
    Address, Env, String, Symbol, TryFromVal, Val,
};

pub const T0: u64 = 1_800_000_000;
pub const DENOMINATION: i128 = 1_000;
pub const NOTES: [i128; 3] = [1_000, 700, 450];
/// The face of the base deal: 2,150,000.
pub const FACE: i128 = 2_150_000;
/// One period of interest of the base deal, on the full face.
pub const INTEREST: [i128; 3] = [2_340, 583, 562];

/// A test oracle: a fixing, and a reporter that a test can set.
#[mock_contract]
pub struct TestOracle;

#[mock_contractimpl]
impl TestOracle {
    pub fn set(e: Env, price: i128, timestamp: u64) {
        e.storage().instance().set(&0u32, &PriceData { price, timestamp });
    }
    pub fn lastprice(e: Env) -> Option<PriceData> {
        e.storage().instance().get(&0u32)
    }
    pub fn set_reporter(e: Env, reporter: Address) {
        e.storage().instance().set(&1u32, &reporter);
    }
    /// The stored reporter. Without one, the oracle itself: an address that
    /// is not the admin and not the servicer of a deal.
    pub fn get_reporter(e: Env) -> Address {
        e.storage().instance().get(&1u32).unwrap_or(e.current_contract_address())
    }
}

pub struct Fixture {
    pub e: Env,
    pub deal: AbsDealClient<'static>,
    pub agent: AgentClient<'static>,
    pub notes: Vec<Address>,
    pub asset: token::Client<'static>,
    pub sac: StellarAssetClient<'static>,
    pub oracle: TestOracleClient<'static>,
    pub admin: Address,
    pub servicer: Address,
    pub seller: Address,
    /// The recipient of the first fee line, and a recipient for a second one.
    pub fees: Address,
    pub fees_2: Address,
    /// One investor per class. Each one holds the whole class.
    pub investors: std::vec::Vec<Address>,
    pub config: DealConfig,
}

/// The settlement figures of one period, from the `period_settled` event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settled {
    pub collections: i128,
    pub reserve_in: i128,
    pub carry_in: i128,
    pub drawn: i128,
    pub paid_out: i128,
    pub reserve: i128,
    pub carry: i128,
    pub owed: i128,
    pub balance: i128,
    pub surplus: i128,
}

/// What one payment date gave: the return value and the new events.
pub struct Period {
    /// Interest plus principal for the paying agent, per class.
    pub paid: Vec<i128>,
    pub enforced: bool,
    pub lines: std::vec::Vec<RankLine>,
    pub settled: Settled,
    /// The ids of the `trigger_breached` events.
    pub breached: std::vec::Vec<Symbol>,
}

pub fn env() -> Env {
    let e = Env::default();
    e.ledger().with_mut(|ledger| ledger.timestamp = T0);
    e.mock_all_auths_allowing_non_root_auth();
    // The limits tests compare with the network limits themselves.
    e.cost_estimate().disable_resource_limits();
    e.cost_estimate().budget().reset_unlimited();
    e
}

pub fn sym(e: &Env, id: &str) -> Symbol {
    Symbol::new(e, id)
}

/// One expected line: rank id, item, due, paid, dust.
pub fn line(e: &Env, rank: &str, item: Item, due: i128, paid: i128, dust: i128) -> RankLine {
    RankLine(sym(e, rank), item, due, paid, dust)
}

/// The base configuration: the reference order with the terms of `test.rs`.
pub fn base_config(e: &Env, f: &Parties) -> DealConfig {
    reference_config(
        e,
        Reference {
            admin: &f.admin,
            asset: &f.asset,
            oracle: &f.oracle,
            seller: &f.seller,
            servicer: &f.servicer,
            fees_recipient: &f.fees,
            fees_per_period: 50,
            required_reserve: 5_000,
            days_in_period: 30,
            oracle_max_staleness_secs: 7 * 86_400,
            note_denomination: DENOMINATION,
            round_unit: 1,
            classes: &[
                (RateSpec::Floating(600), NOTES[0]),
                (RateSpec::Fixed(1_000), NOTES[1]),
                (RateSpec::Fixed(1_500), NOTES[2]),
            ],
        },
    )
}

/// The addresses of a deal, known before its deployment.
pub struct Parties {
    pub admin: Address,
    pub servicer: Address,
    pub seller: Address,
    pub fees: Address,
    pub fees_2: Address,
    pub asset: Address,
    pub oracle: Address,
}

/// Deploy a deal. `edit` changes the base configuration before the
/// deployment. `revocable`: the issuer of the asset can freeze an account.
pub fn build_with(revocable: bool, edit: impl FnOnce(&Env, &mut DealConfig, &Parties)) -> Fixture {
    let e = env();
    let stellar_asset = e.register_stellar_asset_contract_v2(Address::generate(&e));
    if revocable {
        stellar_asset.issuer().set_flag(IssuerFlags::RevocableFlag);
    }
    let asset = token::Client::new(&e, &stellar_asset.address());
    let sac = StellarAssetClient::new(&e, &stellar_asset.address());
    let oracle_id = e.register(TestOracle, ());
    let oracle = TestOracleClient::new(&e, &oracle_id);
    oracle.set(&2209, &T0);

    let parties = Parties {
        admin: Address::generate(&e),
        servicer: Address::generate(&e),
        seller: Address::generate(&e),
        fees: Address::generate(&e),
        fees_2: Address::generate(&e),
        asset: stellar_asset.address(),
        oracle: oracle_id,
    };
    let mut config = base_config(&e, &parties);
    edit(&e, &mut config, &parties);

    let deal_id = e.register(AbsDeal, (config.clone(),));
    let deal = AbsDealClient::new(&e, &deal_id);
    let mut notes: Vec<Address> = Vec::new(&e);
    let mut investors = std::vec::Vec::new();
    let mut listed: Vec<Address> = Vec::new(&e);
    for terms in config.classes.iter() {
        notes.push_back(e.register(
            NoteToken,
            (
                deal_id.clone(),
                String::from_str(&e, "CARA7 D1 Class Note"),
                String::from_str(&e, "CARA7D1"),
                config.note_denomination,
            ),
        ));
        let investor = Address::generate(&e);
        sac.mint(&investor, &(terms.total_notes * config.note_denomination));
        listed.push_back(investor.clone());
        investors.push(investor);
    }
    let agent_id = e.register(PayingAgent, (deal_id.clone(), stellar_asset.address(), notes.clone()));
    let agent = AgentClient::new(&e, &agent_id);
    deal.set_wiring(&notes, &agent_id);
    deal.set_eligible(&listed, &true);

    Fixture {
        e,
        deal,
        agent,
        notes,
        asset,
        sac,
        oracle,
        admin: parties.admin,
        servicer: parties.servicer,
        seller: parties.seller,
        fees: parties.fees,
        fees_2: parties.fees_2,
        investors,
        config,
    }
}

pub fn build(edit: impl FnOnce(&Env, &mut DealConfig, &Parties)) -> Fixture {
    build_with(false, edit)
}

impl Fixture {
    /// Every investor subscribes its class, and the Seller funds the
    /// subordinated loan to the required reserve.
    pub fn subscribe_all(&self) {
        for (index, investor) in self.investors.iter().enumerate() {
            let notes = self.config.classes.get(index as u32).unwrap().total_notes;
            self.deal.subscribe(investor, &(index as u32), &notes);
        }
        let reserve = self.deal.get_required_reserve();
        if reserve > 0 {
            self.sac.mint(&self.seller, &reserve);
            self.deal.fund_sub_loan(&reserve);
        }
    }

    pub fn close(&self) {
        self.subscribe_all();
        self.deal.close();
    }

    /// Run one payment date and read its new events. Each payment date is
    /// checked at once against the two rules of a settlement.
    pub fn run(&self, period: u32, collections: i128) -> Period {
        if collections > 0 {
            self.sac.mint(&self.servicer, &collections);
        }
        let paid = self.deal.distribute(&period, &collections);
        let result = self.read_period(paid);
        self.assert_settled(&result);
        result
    }

    /// The new events of the last call, which must be a `distribute`.
    fn read_period(&self, paid: Vec<i128>) -> Period {
        let e = &self.e;
        let mut lines = std::vec::Vec::new();
        let mut enforced = false;
        let mut settled = None;
        let mut breached = std::vec::Vec::new();
        for event in e.events().all().filter_by_contract(&self.deal.address).events() {
            let ContractEventBody::V0(body) = &event.body;
            let name = match body.topics.first() {
                Some(ScVal::Symbol(name)) => name.0.to_utf8_string_lossy(),
                _ => continue,
            };
            let data = |index: u32| -> Val {
                let all = Vec::<Val>::try_from_val(e, &Val::try_from_val(e, &body.data).unwrap()).unwrap();
                all.get(index).unwrap()
            };
            let amount = |index: u32| -> i128 { i128::try_from_val(e, &data(index)).unwrap() };
            match name.as_str() {
                "rank_lines" => {
                    enforced = bool::try_from_val(e, &data(0)).unwrap();
                    let list = Vec::<RankLine>::try_from_val(e, &data(1)).unwrap();
                    lines = list.iter().collect();
                }
                "period_settled" => {
                    settled = Some(Settled {
                        collections: amount(0),
                        reserve_in: amount(1),
                        carry_in: amount(2),
                        drawn: amount(3),
                        paid_out: amount(4),
                        reserve: amount(5),
                        carry: amount(6),
                        owed: amount(7),
                        balance: amount(8),
                        surplus: amount(9),
                    });
                }
                "trigger_breached" => {
                    let id = Val::try_from_val(e, &body.topics[1]).unwrap();
                    breached.push(Symbol::try_from_val(e, &id).unwrap());
                }
                _ => {}
            }
        }
        Period { paid, enforced, lines, settled: settled.expect("no period_settled event"), breached }
    }

    /// Push every holder payment of a period.
    pub fn push_all(&self, period: u32) {
        for class in 0..self.notes.len() {
            while !self.agent.get_alloc(&period, &class).unwrap().done {
                self.agent.push_batch(&period, &class, &10);
            }
        }
    }

    pub fn per_note(&self) -> std::vec::Vec<i128> {
        self.deal.get_class_states().iter().map(|state| state.per_note_outstanding).collect()
    }

    pub fn shortfalls(&self) -> std::vec::Vec<i128> {
        self.deal.get_shortfalls().iter().collect()
    }

    pub fn balance(&self, holder: &Address) -> i128 {
        self.asset.balance(holder)
    }

    /// The two rules of a settlement, checked on the event alone, then the
    /// event against the ledgers. Valid only right after the payment date.
    fn assert_settled(&self, period: &Period) {
        let s = &period.settled;
        assert_eq!(s.collections + s.reserve_in + s.carry_in, s.paid_out + s.reserve + s.carry, "conservation");
        assert!(s.balance >= s.reserve + s.carry + s.owed, "balance invariant");
        assert_eq!(s.balance, self.asset.balance(&self.deal.address));
        assert_eq!(s.reserve, self.deal.get_reserve());
        assert_eq!(s.carry, self.deal.get_carry());
        assert_eq!(s.owed, self.deal.get_owed_total());
        for line in period.lines.iter() {
            // 0 <= paid, and paid + dust <= due.
            assert!(line.3 >= 0 && line.4 >= 0 && line.3 + line.4 <= line.2, "line bounds");
        }
    }
}
