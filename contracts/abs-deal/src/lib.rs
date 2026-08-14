//! ABS deal contract - the SPV of the CARA7 Data Spec Book: funding escrow,
//! closing DvP, and the waterfall v4 Priority of Payments engine.
//!
//! Lifecycle (Bavarian Sky French Auto Leases 5 mechanics, POC-compressed):
//!
//! - FUNDING: investors `subscribe` EURC against note units (cancellable at
//!   any time before closing - the only moment a "withdraw" exists, per the
//!   Goldfinch pre-lock semantics); the Seller escrows the subordinated loan
//!   that will fund the cash reserve.
//! - `close()` - the closing DvP, one atomic transaction: the subordinated
//!   loan becomes the cash reserve, the FULL subscription proceeds go to the
//!   Seller as the receivables purchase price (net proceeds retained by the
//!   SPV = 0 - BBVA prospectus verbatim), the notes are issued at par and
//!   transfers open. From here there is NO deposit and NO withdraw:
//!   noteholders are repaid only through the priority of payments.
//! - AMORTIZING: each period the servicer's `distribute(period, collections)`
//!   runs the pre-enforcement PoP on the Available Distribution Amount =
//!   collections + the FULL cash reserve released at the top (full-cycle,
//!   re-funded at its rank - the IQ EQ workbook mechanic, NOT a deficit
//!   draw) + the rounding-dust carry from last period. Ranks: (1) fees,
//!   (2-4) interest A/B/C on outstanding nominal (Class A = EURIBOR 1M +
//!   spread floored at 0 from the RateOracle; unpaid interest defers as a
//!   shortfall, no interest on shortfalls), (5) reserve re-fund, (6)
//!   sequential principal A -> B -> C, (7) residual to the Seller.
//! - ENFORCED (`set_enforced`, irreversible): accelerated order - per class
//!   interest then principal, Class A in full before B before C, no reserve
//!   re-fund.
//! - MATURED (automatic when every class's outstanding hits 0): reserve
//!   (= subordinated loan repayment) + carry swept to the Seller; the
//!   contract's asset balance ends at exactly 0.
//!
//! Noteholder ranks use PER-NOTE rounding: entitlement / note count, floored
//! to `round_unit`, times the note count - the remainder is the dust carry
//! that re-enters next period's ADA (the workbook's 49.39 carried forward).
//! Interest AND principal both leave through the PAYING AGENT contract, as
//! the Data Spec Book draws it - nothing is ever paid into the note tokens.
//!
//! Invariant after every distribute: contract asset balance == reserve + carry.

#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, token,
    Address, Env, Vec,
};

/// 100% in rate units (percent x 1_000) - shared with the RateOracle.
pub const RATE_SCALE: i128 = 100_000;
/// 100% in note-factor units (7 dp, close to A-BEST's 8 dp Principal Factor).
pub const FACTOR_SCALE: i128 = 10_000_000;
const DAY_COUNT_BASE: i128 = 360;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum DealError {
    WrongState = 1,
    NotWired = 2,
    AlreadyWired = 3,
    InvalidAmount = 4,
    InvalidConfig = 5,
    RateUnavailable = 6,
    RateStale = 7,
    ClassFull = 8,
    NotFullySubscribed = 9,
    SubLoanShort = 10,
    PeriodMismatch = 11,
    BadClass = 12,
    InsufficientSubscription = 13,
}

/// Rate terms of one class: Class A floats over the oracle fixing (all-in
/// floored at 0%), Classes B/C carry fixed rates per the prospectus.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RateSpec {
    /// Spread over EURIBOR 1M in 0.001% units; all-in floored at 0%.
    Floating(i128),
    /// Fixed annual rate in 0.001% units.
    Fixed(i128),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClassTerms {
    pub rate: RateSpec,
    pub total_notes: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct DealConfig {
    pub admin: Address,
    pub asset: Address,
    pub oracle: Address,
    pub seller: Address,
    pub servicer: Address,
    pub fees_recipient: Address,
    pub fees_per_period: i128,
    /// Required cash reserve == the Seller's subordinated loan amount.
    pub required_reserve: i128,
    pub days_in_period: u32,
    pub oracle_max_staleness_secs: u64,
    /// Original face of one note in asset base units (POC: 100 EURC).
    pub note_denomination: i128,
    /// Per-note rounding grain in asset base units (POC: 1 stroop).
    pub round_unit: i128,
    /// Senior first: A, B, C.
    pub classes: Vec<ClassTerms>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum State {
    Funding,
    Amortizing,
    Enforced,
    Matured,
    Aborted,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Wiring {
    pub note_tokens: Vec<Address>,
    pub paying_agent: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClassState {
    /// Authoritative outstanding per note, in asset base units. The class
    /// outstanding is `per_note_outstanding x total_notes`, drift-free.
    pub per_note_outstanding: i128,
    /// Deferred unpaid interest (accrues no interest of its own).
    pub shortfall: i128,
}

/// Per-class allocation handed to the paying agent each period.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClassAlloc {
    pub interest: i128,
    pub principal: i128,
    pub per_note_principal: i128,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    // instance
    Config,
    State,
    Wiring,
    ClassStates, // Vec<ClassState>
    Reserve,     // i128 cash reserve ledger
    Carry,       // i128 rounding-dust carry, re-enters next ADA
    SubLoan,     // i128 escrowed subordinated loan (Funding only)
    SubTotals,   // Vec<i128> subscribed notes per class
    NextPeriod,  // u32, 1 after closing
    // persistent
    Subscription(u32, Address), // notes escrowed by investor per class
    Subscribers(u32),           // Vec<Address> per class (closing iteration)
}

const PERSISTENT_BUMP: u32 = 30 * 24 * 60 * 12;
const PERSISTENT_LIFETIME: u32 = PERSISTENT_BUMP - 1;

fn bump_persistent(e: &Env, key: &DataKey) {
    e.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_LIFETIME, PERSISTENT_BUMP);
}

/// Oracle fixing as stored by the rate-oracle crate.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[allow(dead_code)]
#[contractclient(name = "RateOracleClient")]
pub trait RateOracleInterface {
    fn lastprice(e: Env) -> Option<PriceData>;
}

#[allow(dead_code)]
#[contractclient(name = "NoteTokenClient")]
pub trait NoteTokenInterface {
    fn issue(e: Env, to: Address, notes: i128);
    fn finalize_issuance(e: Env, start_ts: u64);
    fn roll_period(e: Env, end_ts: u64) -> u32;
    fn total_supply(e: Env) -> i128;
}

#[allow(dead_code)]
#[contractclient(name = "PayingAgentClient")]
pub trait PayingAgentInterface {
    fn fund_period(e: Env, period: u32, allocs: Vec<ClassAlloc>);
}

// --- events -----------------------------------------------------------------

#[contractevent(data_format = "vec")]
pub struct Subscribed {
    #[topic]
    pub investor: Address,
    pub class: u32,
    pub notes: i128,
    pub amount: i128,
}

#[contractevent(data_format = "vec")]
pub struct SubCancelled {
    #[topic]
    pub investor: Address,
    pub class: u32,
    pub notes: i128,
    pub amount: i128,
}

#[contractevent(data_format = "vec")]
pub struct SubLoanFunded {
    #[topic]
    pub seller: Address,
    pub amount: i128,
    pub total: i128,
}

#[contractevent(data_format = "vec")]
pub struct SubLoanRefunded {
    #[topic]
    pub seller: Address,
    pub amount: i128,
    pub total: i128,
}

/// The closing DvP: proceeds out, reserve funded, notes issued.
#[contractevent(data_format = "vec")]
pub struct DealClosed {
    pub proceeds_to_seller: i128,
    pub reserve: i128,
    pub period_start_ts: u64,
}

#[contractevent(data_format = "vec")]
pub struct DealAborted {}

/// One waterfall run. `ada` = collections + reserve released + carry in.
#[contractevent(data_format = "vec")]
pub struct Distribution {
    #[topic]
    pub period: u32,
    pub collections: i128,
    pub reserve_released: i128,
    pub carry_in: i128,
    pub ada: i128,
}

#[contractevent(data_format = "vec")]
pub struct FeesPaid {
    #[topic]
    pub recipient: Address,
    pub amount: i128,
}

#[contractevent(data_format = "vec")]
pub struct InterestPaid {
    #[topic]
    pub class: u32,
    pub period: u32,
    pub due: i128,
    pub paid: i128,
    pub shortfall: i128,
    pub dust: i128,
}

#[contractevent(data_format = "vec")]
pub struct PrincipalPaid {
    #[topic]
    pub class: u32,
    pub period: u32,
    pub paid: i128,
    pub per_note: i128,
    pub outstanding_after: i128,
}

#[contractevent(data_format = "vec")]
pub struct FactorUpdated {
    #[topic]
    pub class: u32,
    pub period: u32,
    pub factor: i128,
    pub per_note_outstanding: i128,
}

#[contractevent(data_format = "vec")]
pub struct ReserveReleased {
    pub amount: i128,
}

#[contractevent(data_format = "vec")]
pub struct ReserveRefunded {
    pub amount: i128,
    pub balance: i128,
}

#[contractevent(data_format = "vec")]
pub struct CarryUpdated {
    pub period: u32,
    pub carry: i128,
}

#[contractevent(data_format = "vec")]
pub struct ResidualPaid {
    #[topic]
    pub seller: Address,
    pub amount: i128,
}

#[contractevent(data_format = "vec")]
pub struct Enforced {
    pub period: u32,
}

#[contractevent(data_format = "vec")]
pub struct Matured {
    pub period: u32,
}

#[contract]
pub struct AbsDeal;

#[contractimpl]
impl AbsDeal {
    pub fn __constructor(e: Env, config: DealConfig) {
        if config.classes.is_empty()
            || config.fees_per_period < 0
            || config.required_reserve < 0
            || config.note_denomination <= 0
            || config.round_unit <= 0
            || config.note_denomination % config.round_unit != 0
        {
            panic!("invalid config");
        }
        let mut sub_totals: Vec<i128> = Vec::new(&e);
        for class in config.classes.iter() {
            if class.total_notes <= 0 {
                panic!("invalid class");
            }
            sub_totals.push_back(0);
        }
        e.storage().instance().set(&DataKey::Config, &config);
        e.storage().instance().set(&DataKey::State, &State::Funding);
        e.storage().instance().set(&DataKey::SubTotals, &sub_totals);
        e.storage().instance().set(&DataKey::Reserve, &0i128);
        e.storage().instance().set(&DataKey::Carry, &0i128);
        e.storage().instance().set(&DataKey::SubLoan, &0i128);
    }

    /// One-shot wiring of the note tokens + paying agent (deployed after this
    /// contract, since they reference its address as controller).
    pub fn set_wiring(
        e: Env,
        note_tokens: Vec<Address>,
        paying_agent: Address,
    ) -> Result<(), DealError> {
        let config = Self::read_config(&e);
        config.admin.require_auth();
        if e.storage().instance().has(&DataKey::Wiring) {
            return Err(DealError::AlreadyWired);
        }
        if note_tokens.len() != config.classes.len() {
            return Err(DealError::InvalidConfig);
        }
        e.storage()
            .instance()
            .set(&DataKey::Wiring, &Wiring { note_tokens, paying_agent });
        Ok(())
    }

    // --- Funding phase ------------------------------------------------------

    /// Escrow `notes x denomination` EURC against future notes of `class`.
    pub fn subscribe(e: Env, investor: Address, class: u32, notes: i128) -> Result<(), DealError> {
        investor.require_auth();
        Self::require_state(&e, State::Funding)?;
        let config = Self::read_config(&e);
        let terms = config.classes.get(class).ok_or(DealError::BadClass)?;
        if notes <= 0 {
            return Err(DealError::InvalidAmount);
        }
        let mut sub_totals: Vec<i128> = e.storage().instance().get(&DataKey::SubTotals).unwrap();
        let subscribed = sub_totals.get(class).unwrap();
        if subscribed + notes > terms.total_notes {
            return Err(DealError::ClassFull);
        }
        let amount = notes * config.note_denomination;
        token::Client::new(&e, &config.asset).transfer(
            &investor,
            &e.current_contract_address(),
            &amount,
        );
        let key = DataKey::Subscription(class, investor.clone());
        let existing: i128 = e.storage().persistent().get(&key).unwrap_or(0);
        if existing == 0 {
            let list_key = DataKey::Subscribers(class);
            let mut subscribers: Vec<Address> =
                e.storage().persistent().get(&list_key).unwrap_or(Vec::new(&e));
            subscribers.push_back(investor.clone());
            e.storage().persistent().set(&list_key, &subscribers);
            bump_persistent(&e, &list_key);
        }
        e.storage().persistent().set(&key, &(existing + notes));
        bump_persistent(&e, &key);
        sub_totals.set(class, subscribed + notes);
        e.storage().instance().set(&DataKey::SubTotals, &sub_totals);
        Subscribed { investor, class, notes, amount }.publish(&e);
        Ok(())
    }

    /// Refund part or all of a pending subscription. Funding/Aborted only -
    /// the pre-closing exit; after closing there is no way out but the
    /// waterfall.
    pub fn cancel(e: Env, investor: Address, class: u32, notes: i128) -> Result<(), DealError> {
        investor.require_auth();
        let state = Self::read_state(&e);
        if state != State::Funding && state != State::Aborted {
            return Err(DealError::WrongState);
        }
        let config = Self::read_config(&e);
        if notes <= 0 {
            return Err(DealError::InvalidAmount);
        }
        if class >= config.classes.len() {
            return Err(DealError::BadClass);
        }
        let key = DataKey::Subscription(class, investor.clone());
        let existing: i128 = e.storage().persistent().get(&key).unwrap_or(0);
        if existing < notes {
            return Err(DealError::InsufficientSubscription);
        }
        e.storage().persistent().set(&key, &(existing - notes));
        bump_persistent(&e, &key);
        let mut sub_totals: Vec<i128> = e.storage().instance().get(&DataKey::SubTotals).unwrap();
        sub_totals.set(class, sub_totals.get(class).unwrap() - notes);
        e.storage().instance().set(&DataKey::SubTotals, &sub_totals);
        let amount = notes * config.note_denomination;
        token::Client::new(&e, &config.asset).transfer(
            &e.current_contract_address(),
            &investor,
            &amount,
        );
        SubCancelled { investor, class, notes, amount }.publish(&e);
        Ok(())
    }

    /// Seller escrows the subordinated loan that will become the cash
    /// reserve at closing (BMW: EUR 5,150,000 credited to the Cash Reserve
    /// Ledger on the Issue Date).
    pub fn fund_sub_loan(e: Env, amount: i128) -> Result<(), DealError> {
        Self::require_state(&e, State::Funding)?;
        let config = Self::read_config(&e);
        config.seller.require_auth();
        if amount <= 0 {
            return Err(DealError::InvalidAmount);
        }
        token::Client::new(&e, &config.asset).transfer(
            &config.seller,
            &e.current_contract_address(),
            &amount,
        );
        let total: i128 = e.storage().instance().get(&DataKey::SubLoan).unwrap();
        let next = total + amount;
        e.storage().instance().set(&DataKey::SubLoan, &next);
        SubLoanFunded { seller: config.seller, amount, total: next }.publish(&e);
        Ok(())
    }

    pub fn refund_sub_loan(e: Env, amount: i128) -> Result<(), DealError> {
        let state = Self::read_state(&e);
        if state != State::Funding && state != State::Aborted {
            return Err(DealError::WrongState);
        }
        let config = Self::read_config(&e);
        config.seller.require_auth();
        let total: i128 = e.storage().instance().get(&DataKey::SubLoan).unwrap();
        if amount <= 0 || amount > total {
            return Err(DealError::InvalidAmount);
        }
        let next = total - amount;
        e.storage().instance().set(&DataKey::SubLoan, &next);
        token::Client::new(&e, &config.asset).transfer(
            &e.current_contract_address(),
            &config.seller,
            &amount,
        );
        SubLoanRefunded { seller: config.seller, amount, total: next }.publish(&e);
        Ok(())
    }

    /// Funding -> Aborted: subscriptions and the sub-loan stay refundable,
    /// nothing else ever happens.
    pub fn abort(e: Env) -> Result<(), DealError> {
        Self::require_state(&e, State::Funding)?;
        let config = Self::read_config(&e);
        config.admin.require_auth();
        e.storage().instance().set(&DataKey::State, &State::Aborted);
        DealAborted {}.publish(&e);
        Ok(())
    }

    // --- Closing DvP --------------------------------------------------------

    /// The closing: requires every class fully subscribed and the sub-loan
    /// at exactly the required reserve. Atomically converts the sub-loan
    /// into the cash reserve, pays the full subscription proceeds to the
    /// Seller (purchase price of the receivables - net retained = 0), issues
    /// the notes at par and opens payment period 1.
    pub fn close(e: Env) -> Result<(), DealError> {
        Self::require_state(&e, State::Funding)?;
        let config = Self::read_config(&e);
        config.admin.require_auth();
        let wiring = Self::read_wiring(&e)?;
        let sub_totals: Vec<i128> = e.storage().instance().get(&DataKey::SubTotals).unwrap();
        let mut proceeds: i128 = 0;
        for index in 0..config.classes.len() {
            let terms = config.classes.get(index).unwrap();
            if sub_totals.get(index).unwrap() != terms.total_notes {
                return Err(DealError::NotFullySubscribed);
            }
            proceeds += terms.total_notes * config.note_denomination;
        }
        let sub_loan: i128 = e.storage().instance().get(&DataKey::SubLoan).unwrap();
        if sub_loan != config.required_reserve {
            return Err(DealError::SubLoanShort);
        }

        // 1. Subordinated loan becomes the cash reserve ledger.
        e.storage().instance().set(&DataKey::Reserve, &sub_loan);
        e.storage().instance().set(&DataKey::SubLoan, &0i128);

        // 2. Purchase price to the Seller, same value date.
        token::Client::new(&e, &config.asset).transfer(
            &e.current_contract_address(),
            &config.seller,
            &proceeds,
        );

        // 3. Issue the notes and open period 1.
        let now = e.ledger().timestamp();
        for index in 0..config.classes.len() {
            let note_token = NoteTokenClient::new(&e, &wiring.note_tokens.get(index).unwrap());
            let subscribers: Vec<Address> = e
                .storage()
                .persistent()
                .get(&DataKey::Subscribers(index))
                .unwrap_or(Vec::new(&e));
            for subscriber in subscribers.iter() {
                let notes: i128 = e
                    .storage()
                    .persistent()
                    .get(&DataKey::Subscription(index, subscriber.clone()))
                    .unwrap_or(0);
                if notes > 0 {
                    note_token.issue(&subscriber, &notes);
                }
            }
            note_token.finalize_issuance(&now);
        }

        // 4. Initialize amortization state.
        let mut class_states: Vec<ClassState> = Vec::new(&e);
        for _ in 0..config.classes.len() {
            class_states.push_back(ClassState {
                per_note_outstanding: config.note_denomination,
                shortfall: 0,
            });
        }
        e.storage().instance().set(&DataKey::ClassStates, &class_states);
        e.storage().instance().set(&DataKey::NextPeriod, &1u32);
        e.storage().instance().set(&DataKey::State, &State::Amortizing);

        // Net proceeds retained by the SPV = 0: only the reserve stays.
        let balance = token::Client::new(&e, &config.asset).balance(&e.current_contract_address());
        if balance != sub_loan {
            panic!("closing balance invariant");
        }
        DealClosed { proceeds_to_seller: proceeds, reserve: sub_loan, period_start_ts: now }
            .publish(&e);
        Ok(())
    }

    // --- Amortizing / Enforced ----------------------------------------------

    /// Run one waterfall period. Servicer-authed; `period` must equal the
    /// expected next period (idempotency). Zero collections are legal - the
    /// released reserve then carries the senior interest.
    pub fn distribute(e: Env, period: u32, collections: i128) -> Result<Vec<i128>, DealError> {
        let state = Self::read_state(&e);
        if state != State::Amortizing && state != State::Enforced {
            return Err(DealError::WrongState);
        }
        let config = Self::read_config(&e);
        config.servicer.require_auth();
        if collections < 0 {
            return Err(DealError::InvalidAmount);
        }
        let next_period: u32 = e.storage().instance().get(&DataKey::NextPeriod).unwrap();
        if period != next_period {
            return Err(DealError::PeriodMismatch);
        }
        let wiring = Self::read_wiring(&e)?;
        let client = token::Client::new(&e, &config.asset);
        let this = e.current_contract_address();
        if collections > 0 {
            client.transfer(&config.servicer, &this, &collections);
        }

        let mut class_states: Vec<ClassState> =
            e.storage().instance().get(&DataKey::ClassStates).unwrap();
        let count = config.classes.len();

        // ADA = collections + FULL reserve released + carry (both zeroed).
        let reserve_released: i128 = e.storage().instance().get(&DataKey::Reserve).unwrap();
        let carry_in: i128 = e.storage().instance().get(&DataKey::Carry).unwrap();
        let mut ada = collections + reserve_released + carry_in;
        let mut reserve: i128 = 0;
        let mut carry: i128 = 0;
        if reserve_released > 0 {
            ReserveReleased { amount: reserve_released }.publish(&e);
        }
        Distribution { period, collections, reserve_released, carry_in, ada }.publish(&e);

        // Interest due per class = accrued on outstanding + prior shortfall.
        let mut interest_due: Vec<i128> = Vec::new(&e);
        for index in 0..count {
            let terms = config.classes.get(index).unwrap();
            let outstanding =
                class_states.get(index).unwrap().per_note_outstanding * terms.total_notes;
            let accrued = Self::period_interest(&e, &config, outstanding, &terms.rate)?;
            interest_due.push_back(accrued + class_states.get(index).unwrap().shortfall);
        }

        // Rank 1 - fees.
        let fees = config.fees_per_period.min(ada);
        if fees > 0 {
            client.transfer(&this, &config.fees_recipient, &fees);
            ada -= fees;
            FeesPaid { recipient: config.fees_recipient.clone(), amount: fees }.publish(&e);
        }

        let mut allocs: Vec<ClassAlloc> = Vec::new(&e);
        for _ in 0..count {
            allocs.push_back(ClassAlloc { interest: 0, principal: 0, per_note_principal: 0 });
        }

        let enforced = state == State::Enforced;
        if enforced {
            // Accelerated order: per class interest then principal, A fully
            // before B before C. No reserve re-fund.
            for index in 0..count {
                let terms = config.classes.get(index).unwrap();
                let mut class_state = class_states.get(index).unwrap();
                let mut alloc = allocs.get(index).unwrap();

                Self::pay_interest(
                    &e,
                    &config,
                    period,
                    index,
                    interest_due.get(index).unwrap(),
                    terms.total_notes,
                    &mut ada,
                    &mut carry,
                    &mut class_state,
                    &mut alloc,
                );
                Self::pay_principal(
                    &e,
                    &config,
                    period,
                    index,
                    terms.total_notes,
                    &mut ada,
                    &mut carry,
                    &mut class_state,
                    &mut alloc,
                );
                class_states.set(index, class_state);
                allocs.set(index, alloc);
            }
        } else {
            // Ranks 2-4 - interest, senior to junior.
            for index in 0..count {
                let terms = config.classes.get(index).unwrap();
                let mut class_state = class_states.get(index).unwrap();
                let mut alloc = allocs.get(index).unwrap();
                Self::pay_interest(
                    &e,
                    &config,
                    period,
                    index,
                    interest_due.get(index).unwrap(),
                    terms.total_notes,
                    &mut ada,
                    &mut carry,
                    &mut class_state,
                    &mut alloc,
                );
                class_states.set(index, class_state);
                allocs.set(index, alloc);
            }
            // Rank 5 - reserve re-fund to the required amount.
            let refund = config.required_reserve.min(ada);
            if refund > 0 {
                reserve = refund;
                ada -= refund;
                ReserveRefunded { amount: refund, balance: reserve }.publish(&e);
            }
            // Rank 6 - sequential principal A -> B -> C.
            for index in 0..count {
                let terms = config.classes.get(index).unwrap();
                let mut class_state = class_states.get(index).unwrap();
                let mut alloc = allocs.get(index).unwrap();
                Self::pay_principal(
                    &e,
                    &config,
                    period,
                    index,
                    terms.total_notes,
                    &mut ada,
                    &mut carry,
                    &mut class_state,
                    &mut alloc,
                );
                class_states.set(index, class_state);
                allocs.set(index, alloc);
            }
        }

        // Hand the noteholder money - interest AND principal - to the paying
        // agent contract, then let it know the period's split.
        let mut agent_total: i128 = 0;
        let mut paid_totals: Vec<i128> = Vec::new(&e);
        for index in 0..count {
            let alloc = allocs.get(index).unwrap();
            agent_total += alloc.interest + alloc.principal;
            paid_totals.push_back(alloc.interest + alloc.principal);
        }
        if agent_total > 0 {
            client.transfer(&this, &wiring.paying_agent, &agent_total);
        }
        PayingAgentClient::new(&e, &wiring.paying_agent).fund_period(&period, &allocs);

        // Close the payment period on every note token (freezes the
        // day-weight reads the paying agent uses).
        let now = e.ledger().timestamp();
        for index in 0..count {
            NoteTokenClient::new(&e, &wiring.note_tokens.get(index).unwrap()).roll_period(&now);
        }

        // Rank 7 - residual to the Seller.
        let mut outstanding_total: i128 = 0;
        for index in 0..count {
            outstanding_total += class_states.get(index).unwrap().per_note_outstanding;
        }
        let matured = outstanding_total == 0;
        if matured {
            // Wind-down sweep: the released (never re-funded) reserve is the
            // subordinated-loan repayment; carry and residual go with it.
            let sweep = ada + reserve + carry;
            reserve = 0;
            carry = 0;
            ada = 0;
            if sweep > 0 {
                client.transfer(&this, &config.seller, &sweep);
                ResidualPaid { seller: config.seller.clone(), amount: sweep }.publish(&e);
            }
            e.storage().instance().set(&DataKey::State, &State::Matured);
            Matured { period }.publish(&e);
        } else if ada > 0 {
            client.transfer(&this, &config.seller, &ada);
            ResidualPaid { seller: config.seller.clone(), amount: ada }.publish(&e);
            ada = 0;
        }

        e.storage().instance().set(&DataKey::ClassStates, &class_states);
        e.storage().instance().set(&DataKey::Reserve, &reserve);
        e.storage().instance().set(&DataKey::Carry, &carry);
        e.storage().instance().set(&DataKey::NextPeriod, &(period + 1));
        CarryUpdated { period, carry }.publish(&e);

        // The invariant that makes the SPV auditable at a glance.
        let balance = client.balance(&this);
        if balance != reserve + carry {
            panic!("distribute balance invariant");
        }
        let _ = ada;
        Ok(paid_totals)
    }

    /// Irreversible switch to the accelerated priority of payments
    /// (Enforcement Event, admin-attested).
    pub fn set_enforced(e: Env) -> Result<(), DealError> {
        Self::require_state(&e, State::Amortizing)?;
        let config = Self::read_config(&e);
        config.admin.require_auth();
        e.storage().instance().set(&DataKey::State, &State::Enforced);
        let period: u32 = e.storage().instance().get(&DataKey::NextPeriod).unwrap();
        Enforced { period }.publish(&e);
        Ok(())
    }

    pub fn set_servicer(e: Env, servicer: Address) -> Result<(), DealError> {
        let mut config = Self::read_config(&e);
        config.admin.require_auth();
        config.servicer = servicer;
        e.storage().instance().set(&DataKey::Config, &config);
        Ok(())
    }

    // --- Views --------------------------------------------------------------

    pub fn get_state(e: Env) -> State {
        Self::read_state(&e)
    }

    pub fn get_config(e: Env) -> DealConfig {
        Self::read_config(&e)
    }

    pub fn get_wiring(e: Env) -> Option<Wiring> {
        e.storage().instance().get(&DataKey::Wiring)
    }

    pub fn get_class_states(e: Env) -> Vec<ClassState> {
        e.storage()
            .instance()
            .get(&DataKey::ClassStates)
            .unwrap_or(Vec::new(&e))
    }

    /// Class outstanding = per-note outstanding x note count.
    pub fn get_outstanding(e: Env) -> Vec<i128> {
        let config = Self::read_config(&e);
        let class_states = Self::get_class_states(e.clone());
        let mut outstanding: Vec<i128> = Vec::new(&e);
        for index in 0..config.classes.len() {
            let notes = config.classes.get(index).unwrap().total_notes;
            let per_note = if index < class_states.len() {
                class_states.get(index).unwrap().per_note_outstanding
            } else {
                config.note_denomination
            };
            outstanding.push_back(per_note * notes);
        }
        outstanding
    }

    /// Note factor per class in FACTOR_SCALE units (10_000_000 = 100%).
    pub fn get_note_factors(e: Env) -> Vec<i128> {
        let config = Self::read_config(&e);
        let class_states = Self::get_class_states(e.clone());
        let mut factors: Vec<i128> = Vec::new(&e);
        for index in 0..config.classes.len() {
            let per_note = if index < class_states.len() {
                class_states.get(index).unwrap().per_note_outstanding
            } else {
                config.note_denomination
            };
            factors.push_back(per_note.saturating_mul(FACTOR_SCALE) / config.note_denomination);
        }
        factors
    }

    pub fn get_shortfalls(e: Env) -> Vec<i128> {
        let config = Self::read_config(&e);
        let class_states = Self::get_class_states(e.clone());
        let mut shortfalls: Vec<i128> = Vec::new(&e);
        for index in 0..config.classes.len() {
            let shortfall = if index < class_states.len() {
                class_states.get(index).unwrap().shortfall
            } else {
                0
            };
            shortfalls.push_back(shortfall);
        }
        shortfalls
    }

    pub fn get_reserve(e: Env) -> i128 {
        e.storage().instance().get(&DataKey::Reserve).unwrap()
    }

    pub fn get_carry(e: Env) -> i128 {
        e.storage().instance().get(&DataKey::Carry).unwrap()
    }

    pub fn get_sub_loan(e: Env) -> i128 {
        e.storage().instance().get(&DataKey::SubLoan).unwrap()
    }

    pub fn get_sub_totals(e: Env) -> Vec<i128> {
        e.storage().instance().get(&DataKey::SubTotals).unwrap()
    }

    pub fn get_subscription(e: Env, class: u32, investor: Address) -> i128 {
        e.storage()
            .persistent()
            .get(&DataKey::Subscription(class, investor))
            .unwrap_or(0)
    }

    pub fn get_next_period(e: Env) -> u32 {
        e.storage().instance().get(&DataKey::NextPeriod).unwrap_or(0)
    }

    // --- internals ----------------------------------------------------------

    fn read_config(e: &Env) -> DealConfig {
        e.storage().instance().get(&DataKey::Config).unwrap()
    }

    fn read_state(e: &Env) -> State {
        e.storage().instance().get(&DataKey::State).unwrap()
    }

    fn read_wiring(e: &Env) -> Result<Wiring, DealError> {
        e.storage().instance().get(&DataKey::Wiring).ok_or(DealError::NotWired)
    }

    fn require_state(e: &Env, expected: State) -> Result<(), DealError> {
        if Self::read_state(e) != expected {
            return Err(DealError::WrongState);
        }
        Ok(())
    }

    /// The per-note rounding primitive: floor the per-note amount to
    /// `round_unit`, pay it times the note count, carry the dust.
    fn round_per_note(entitlement: i128, notes: i128, round_unit: i128) -> (i128, i128) {
        let per_note = entitlement / notes / round_unit * round_unit;
        let paid = per_note * notes;
        (paid, entitlement - paid)
    }

    #[allow(clippy::too_many_arguments)]
    fn pay_interest(
        e: &Env,
        config: &DealConfig,
        period: u32,
        class: u32,
        due: i128,
        notes: i128,
        ada: &mut i128,
        carry: &mut i128,
        class_state: &mut ClassState,
        alloc: &mut ClassAlloc,
    ) {
        let entitlement = due.min(*ada);
        let (paid, dust) = Self::round_per_note(entitlement, notes, config.round_unit);
        class_state.shortfall = due - entitlement;
        *carry += dust;
        *ada -= entitlement;
        alloc.interest = paid;
        if due > 0 {
            InterestPaid {
                class,
                period,
                due,
                paid,
                shortfall: class_state.shortfall,
                dust,
            }
            .publish(e);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn pay_principal(
        e: &Env,
        config: &DealConfig,
        period: u32,
        class: u32,
        notes: i128,
        ada: &mut i128,
        carry: &mut i128,
        class_state: &mut ClassState,
        alloc: &mut ClassAlloc,
    ) {
        let outstanding = class_state.per_note_outstanding * notes;
        let entitlement = outstanding.min(*ada);
        if entitlement <= 0 {
            return;
        }
        let (paid, dust) = Self::round_per_note(entitlement, notes, config.round_unit);
        let per_note = paid / notes;
        class_state.per_note_outstanding -= per_note;
        *carry += dust;
        *ada -= entitlement;
        alloc.principal = paid;
        alloc.per_note_principal = per_note;
        if paid > 0 {
            PrincipalPaid {
                class,
                period,
                paid,
                per_note,
                outstanding_after: class_state.per_note_outstanding * notes,
            }
            .publish(e);
            FactorUpdated {
                class,
                period,
                factor: class_state
                    .per_note_outstanding
                    .saturating_mul(FACTOR_SCALE)
                    / config.note_denomination,
                per_note_outstanding: class_state.per_note_outstanding,
            }
            .publish(e);
        }
    }

    /// Period interest on an outstanding nominal, actual/360. Floating legs
    /// read the oracle (staleness-checked) and floor the all-in at 0%.
    fn period_interest(
        e: &Env,
        config: &DealConfig,
        nominal: i128,
        rate: &RateSpec,
    ) -> Result<i128, DealError> {
        let annual_rate = match rate {
            RateSpec::Fixed(rate_units) => *rate_units,
            RateSpec::Floating(spread_units) => {
                let oracle = RateOracleClient::new(e, &config.oracle);
                let fixing = oracle.lastprice().ok_or(DealError::RateUnavailable)?;
                let now = e.ledger().timestamp();
                if now.saturating_sub(fixing.timestamp) > config.oracle_max_staleness_secs {
                    return Err(DealError::RateStale);
                }
                // The prospectus 0% floor - Class A only, applied to the all-in.
                (fixing.price + spread_units).max(0)
            }
        };
        if annual_rate <= 0 || nominal <= 0 {
            return Ok(0);
        }
        Ok(nominal
            .saturating_mul(annual_rate)
            .saturating_mul(config.days_in_period as i128)
            / DAY_COUNT_BASE
            / RATE_SCALE)
    }
}

#[cfg(test)]
mod test;
