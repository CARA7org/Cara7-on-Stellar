//! ABS deal contract - the SPV of the CARA7 Data Spec Book: funding escrow,
//! closing DvP, and a configurable Priority of Payments engine.
//!
//! Lifecycle:
//!
//! - FUNDING: investors `subscribe` the settlement asset against note units.
//!   A subscription is cancellable until the closing: this is the only
//!   moment a "withdraw" exists. The Seller escrows the subordinated loan
//!   that funds the cash reserve.
//! - `close()` - the closing DvP, one atomic transaction: the subordinated
//!   loan becomes the cash reserve, the FULL subscription proceeds go to the
//!   Seller as the receivables purchase price (net proceeds retained by the
//!   SPV = 0), the notes are issued at par and transfers open. From here
//!   there is NO deposit and NO withdraw: noteholders are repaid only through
//!   the priority of payments.
//! - AMORTIZING: each period the servicer's `distribute(period, collections)`
//!   runs the `normal` order of the configuration.
//! - ENFORCED (`set_enforced`, irreversible): `distribute` runs the
//!   `enforced` order. The reserve is released in full and not re-funded.
//! - MATURED (automatic when every class's outstanding hits 0): reserve
//!   (= subordinated loan repayment) + carry swept to the Seller.
//!
//! The priority of payments is a configuration, not code. `DealConfig`
//! (`types.rs`) gives the classes and their rates (fixed, or the oracle
//! fixing plus a spread, with floors), the fee lines, the reserve rule, the
//! triggers, and two rank lists: the `normal` order and the `enforced`
//! order. A rank holds items (a fee line, the interest or the principal of a
//! class, the reserve re-fund, the residual), a condition on a trigger, and
//! a split rule: sequential or pari passu. `engine.rs` runs one period.
//! `validate.rs` checks a configuration at the construction.
//!
//! The reference deal (Bavarian Sky French Auto Leases 5, compressed) is one
//! configuration: (1) fees, (2-4) interest A/B/C on the outstanding nominal
//! (Class A = EURIBOR 1M + spread floored at 0, unpaid interest defers as a
//! shortfall, no interest on shortfalls), (5) reserve re-fund, (6) sequential
//! principal A -> B -> C, (7) residual to the Seller. After enforcement:
//! per class interest then principal, Class A in full before B before C.
//!
//! The available amount of a period = collections + the cash reserve
//! released at the top + the rounding-dust carry from last period. Noteholder
//! ranks use PER-NOTE rounding: entitlement / note count, floored to
//! `round_unit`, times the note count - the remainder is the dust carry
//! that re-enters next period's available amount. Interest AND principal
//! both leave through the PAYING AGENT contract - nothing is ever paid into
//! the note tokens.
//!
//! Roles. Three roles are separate, so that each one can have its own
//! signing policy:
//!
//! - the admin is the operator of the deal (the management company). It
//!   settles the issuance (`close`) and holds the lifecycle: wiring,
//!   whitelist, abort, enforcement, replacement of the servicer;
//! - the servicer triggers a payment date (`distribute`). It reports the
//!   collections. It cannot change an amount or the order of the ranks;
//! - the reporter of the rate oracle publishes the reference rate.
//!
//! The contract refuses a deal where the admin is the servicer. `close` and
//! `distribute` of a deal with a floating class refuse an oracle reporter
//! that is the admin or the servicer (`RoleConflict`).
//!
//! Settlement asset: any SEP-41 token set at deployment, in practice EURC
//! or EURCV through their Stellar Asset Contract. The issuer of the asset
//! can freeze an account or claw back funds, so:
//!
//! - a payout to a fees recipient or to the Seller that fails is parked as
//!   an amount owed to that recipient, who takes it later with
//!   `claim_owed`. A frozen recipient never blocks the payment date of the
//!   noteholders;
//! - the balance checks accept a surplus (anyone can transfer the asset to
//!   the deal) and stop on a deficit (a clawback). A surplus stays idle
//!   until the maturity sweep pays it to the Seller.
//!
//! Whitelist: only an investor on the deal whitelist can subscribe, and the
//! note tokens ask `is_eligible` before each transfer. The admin keeps the
//! list. A holder removed from the list keeps its notes and is still paid.
//!
//! `set_wiring` checks that each note token belongs to this deal and has its
//! denomination, and that the paying agent pays this deal's notes in this
//! deal's asset. A deal has at most `MAX_CLASSES` classes.
//!
//! Two rules hold after every `distribute`, and the `period_settled` event
//! carries the figures of both:
//!
//! - conservation: collections + opening reserve + opening carry = cash paid
//!   out + closing reserve + closing carry;
//! - the balance invariant: contract asset balance >= reserve + carry +
//!   amounts owed.

#![no_std]

mod engine;
mod events;
mod types;
mod validate;

pub use events::*;
pub use types::*;
pub use validate::validate;

use engine::{Opening, CLASS_SLOTS, TRIGGER_SLOTS};
use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, panic_with_error, token, Address, Env,
    Vec,
};

/// Payout codes named in `PayoutParked`: a fee line, the residual.
const RANK_FEES: u32 = 1;
const RANK_RESIDUAL: u32 = 7;

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
    OwedTotal,   // i128 sum of the parked payouts not claimed yet
    SubscriptionCount, // u32 open subscriptions (entries of all Subscribers lists)
    Triggers,    // Vec<bool> stored trigger flags, in the order of the config
    // persistent
    Subscription(u32, Address), // notes escrowed by investor per class
    Subscribers(u32),           // Vec<Address> per class (closing iteration)
    Owed(Address),              // i128 parked payout of one recipient
    Eligible(Address),          // present = the holder is on the whitelist
}

const PERSISTENT_BUMP: u32 = 30 * 24 * 60 * 12;
const PERSISTENT_LIFETIME: u32 = PERSISTENT_BUMP - 1;

fn bump_persistent(e: &Env, key: &DataKey) {
    e.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_LIFETIME, PERSISTENT_BUMP);
}

#[allow(dead_code)]
#[contractclient(name = "RateOracleClient")]
pub trait RateOracleInterface {
    fn lastprice(e: Env) -> Option<PriceData>;
    fn get_reporter(e: Env) -> Address;
}

#[allow(dead_code)]
#[contractclient(name = "NoteTokenClient")]
pub trait NoteTokenInterface {
    fn issue(e: Env, to: Address, notes: i128);
    fn finalize_issuance(e: Env, start_ts: u64);
    fn roll_period(e: Env, end_ts: u64) -> u32;
    fn total_supply(e: Env) -> i128;
    fn controller(e: Env) -> Address;
    fn denomination(e: Env) -> i128;
}

#[allow(dead_code)]
#[contractclient(name = "PayingAgentClient")]
pub trait PayingAgentInterface {
    fn fund_period(e: Env, period: u32, allocs: Vec<ClassAlloc>);
    fn get_config(e: Env) -> AgentConfig;
}

#[contract]
pub struct AbsDeal;

#[contractimpl]
impl AbsDeal {
    /// Store the configuration of the deal. `validate` refuses a
    /// configuration that the engine cannot run, and a deal where the admin
    /// is the servicer.
    pub fn __constructor(e: Env, config: DealConfig) {
        if let Err(error) = validate(&config) {
            panic_with_error!(&e, error);
        }
        let mut sub_totals: Vec<i128> = Vec::new(&e);
        for _ in config.classes.iter() {
            sub_totals.push_back(0);
        }
        e.storage().instance().set(&DataKey::Config, &config);
        e.storage().instance().set(&DataKey::State, &State::Funding);
        e.storage().instance().set(&DataKey::SubTotals, &sub_totals);
        e.storage().instance().set(&DataKey::Reserve, &0i128);
        e.storage().instance().set(&DataKey::Carry, &0i128);
        e.storage().instance().set(&DataKey::SubLoan, &0i128);
        e.storage().instance().set(&DataKey::OwedTotal, &0i128);
        e.storage().instance().set(&DataKey::SubscriptionCount, &0u32);
    }

    /// One-shot wiring of the note tokens + paying agent (deployed after this
    /// contract, since they reference its address as controller).
    ///
    /// The wiring is checked: one distinct note token per class, each
    /// controlled by this deal and with the deal's denomination, and a paying
    /// agent for this deal, in this deal's asset, with the same note tokens in
    /// the same order. Any difference gives `WiringMismatch`.
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
        let this = e.current_contract_address();
        for index in 0..note_tokens.len() {
            let note = note_tokens.get(index).unwrap();
            for earlier in 0..index {
                if note_tokens.get(earlier).unwrap() == note {
                    return Err(DealError::WiringMismatch);
                }
            }
            let client = NoteTokenClient::new(&e, &note);
            match (client.try_controller(), client.try_denomination()) {
                (Ok(Ok(controller)), Ok(Ok(denomination)))
                    if controller == this && denomination == config.note_denomination => {}
                _ => return Err(DealError::WiringMismatch),
            }
        }
        match PayingAgentClient::new(&e, &paying_agent).try_get_config() {
            Ok(Ok(agent))
                if agent.deal == this
                    && agent.asset == config.asset
                    && agent.note_tokens == note_tokens => {}
            _ => return Err(DealError::WiringMismatch),
        }
        e.storage()
            .instance()
            .set(&DataKey::Wiring, &Wiring { note_tokens, paying_agent });
        Ok(())
    }

    // --- Funding phase ------------------------------------------------------

    /// Escrow `notes x denomination` of the asset against future notes of
    /// `class`. Only an investor on the deal whitelist can subscribe.
    pub fn subscribe(e: Env, investor: Address, class: u32, notes: i128) -> Result<(), DealError> {
        investor.require_auth();
        Self::require_state(&e, State::Funding)?;
        if !Self::eligible(&e, &investor) {
            return Err(DealError::NotEligible);
        }
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
        let key = DataKey::Subscription(class, investor.clone());
        let existing: i128 = e.storage().persistent().get(&key).unwrap_or(0);
        if existing == 0 {
            // A new subscription. The investor is not in the list: `cancel`
            // removes a subscription that goes to 0. The closing issues the
            // notes of every subscription in one transaction, so their
            // number is limited.
            let count: u32 = e.storage().instance().get(&DataKey::SubscriptionCount).unwrap_or(0);
            if count >= MAX_SUBSCRIPTIONS {
                return Err(DealError::TooManySubscriptions);
            }
            let list_key = DataKey::Subscribers(class);
            let mut subscribers: Vec<Address> =
                e.storage().persistent().get(&list_key).unwrap_or(Vec::new(&e));
            subscribers.push_back(investor.clone());
            e.storage().persistent().set(&list_key, &subscribers);
            bump_persistent(&e, &list_key);
            e.storage().instance().set(&DataKey::SubscriptionCount, &(count + 1));
        }
        let amount = notes * config.note_denomination;
        token::Client::new(&e, &config.asset).transfer(
            &investor,
            &e.current_contract_address(),
            &amount,
        );
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
        if existing == notes {
            // The subscription goes to 0: remove the investor from the
            // closing list. Without this, a new subscription would add the
            // investor a second time and the closing would issue its notes
            // twice.
            let list_key = DataKey::Subscribers(class);
            let mut subscribers: Vec<Address> =
                e.storage().persistent().get(&list_key).unwrap_or(Vec::new(&e));
            if let Some(index) = subscribers.first_index_of(&investor) {
                subscribers.remove(index);
                e.storage().persistent().set(&list_key, &subscribers);
                bump_persistent(&e, &list_key);
                let count: u32 =
                    e.storage().instance().get(&DataKey::SubscriptionCount).unwrap_or(0);
                e.storage().instance().set(&DataKey::SubscriptionCount, &count.saturating_sub(1));
            }
        }
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
    ///
    /// The admin settles the issuance. A deal with a floating class refuses
    /// the closing when the reporter of its oracle is the admin or the
    /// servicer.
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
        // The required reserve at the closing, on the initial notes.
        let sub_loan: i128 = e.storage().instance().get(&DataKey::SubLoan).unwrap();
        if sub_loan != engine::required_reserve(&config, false, proceeds) {
            return Err(DealError::SubLoanShort);
        }
        Self::require_separate_reporter(&e, &config)?;

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

        // Net proceeds retained by the SPV = 0: only the reserve stays. A
        // surplus (a direct transfer to the deal) is accepted and stays idle;
        // a deficit (a clawback) stops the closing.
        let balance = token::Client::new(&e, &config.asset).balance(&e.current_contract_address());
        if balance < sub_loan {
            panic!("closing balance invariant");
        }
        DealClosed { proceeds_to_seller: proceeds, reserve: sub_loan, period_start_ts: now }
            .publish(&e);
        Ok(())
    }

    // --- Amortizing / Enforced ----------------------------------------------

    /// Run one payment date. Servicer-authed; `period` must equal the
    /// expected next period (idempotency). Zero collections are legal.
    ///
    /// The engine computes every rank from the configuration and the
    /// ledgers. The only input of the servicer is the collections figure:
    /// the servicer cannot change an amount or the order of the ranks.
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
        Self::require_separate_reporter(&e, &config)?;
        let client = token::Client::new(&e, &config.asset);
        let this = e.current_contract_address();
        if collections > 0 {
            client.transfer(&config.servicer, &this, &collections);
        }

        // The opening ledgers.
        let opening_states: Vec<ClassState> =
            e.storage().instance().get(&DataKey::ClassStates).unwrap();
        let count = config.classes.len();
        let enforced = state == State::Enforced;
        let reserve_in: i128 = e.storage().instance().get(&DataKey::Reserve).unwrap();
        let carry_in: i128 = e.storage().instance().get(&DataKey::Carry).unwrap();
        let mut opening = Opening {
            enforced,
            collections,
            reserve: reserve_in,
            carry: carry_in,
            per_note: [0; CLASS_SLOTS],
            shortfall: [0; CLASS_SLOTS],
            triggers: [false; TRIGGER_SLOTS],
            fixing: 0,
        };
        for index in 0..count {
            let class_state = opening_states.get(index).unwrap();
            opening.per_note[index as usize] = class_state.per_note_outstanding;
            opening.shortfall[index as usize] = class_state.shortfall;
        }
        let stored = Self::read_triggers(&e);
        for index in 0..config.triggers.len() {
            opening.triggers[index as usize] = stored.get(index).unwrap_or(false);
        }
        if engine::has_floating_class(&config) {
            opening.fixing = Self::read_fixing(&e, &config)?;
        }

        // The engine computes the period: every rank, in the configured order.
        let outcome = engine::run(&config, &opening);

        if outcome.released > 0 {
            ReserveReleased { amount: outcome.released }.publish(&e);
        }
        Distribution {
            period,
            collections,
            reserve_released: outcome.released,
            carry_in,
            ada: outcome.available,
        }
        .publish(&e);

        // Replay the steps in rank order: pay the fee lines, publish the
        // events of each item, and collect the lines of the period.
        let order = if enforced { &config.enforced } else { &config.normal };
        let mut owed_total: i128 = e.storage().instance().get(&DataKey::OwedTotal).unwrap_or(0);
        let mut fees_out: i128 = 0;
        let mut lines: Vec<RankLine> = Vec::new(&e);
        for step in outcome.steps.iter().take(outcome.count) {
            match step.item {
                Item::Fee(line) => {
                    // A frozen fees recipient does not block the period: the
                    // fee then stays in the deal, owed to the recipient.
                    if step.alloc > 0 {
                        let recipient = config.fees.get(line).unwrap().recipient;
                        fees_out += step.alloc;
                        if Self::pay_or_park(&e, &client, &recipient, step.alloc, period, RANK_FEES, &mut owed_total) {
                            FeesPaid { recipient, amount: step.alloc }.publish(&e);
                        }
                    }
                }
                Item::Interest(class) => {
                    if step.due > 0 {
                        InterestPaid {
                            class,
                            period,
                            due: step.due,
                            paid: step.paid,
                            shortfall: step.due - step.alloc,
                            dust: step.alloc - step.paid,
                        }
                        .publish(&e);
                    }
                }
                Item::Principal(class) => {
                    if step.paid > 0 {
                        let notes = config.classes.get(class).unwrap().total_notes;
                        let per_note_outstanding = outcome.per_note[class as usize];
                        PrincipalPaid {
                            class,
                            period,
                            paid: step.paid,
                            per_note: step.paid / notes,
                            outstanding_after: per_note_outstanding * notes,
                        }
                        .publish(&e);
                        FactorUpdated {
                            class,
                            period,
                            factor: per_note_outstanding.saturating_mul(FACTOR_SCALE)
                                / config.note_denomination,
                            per_note_outstanding,
                        }
                        .publish(&e);
                    }
                }
                Item::ReserveRefill => {
                    if step.alloc > 0 {
                        ReserveRefunded { amount: step.alloc, balance: step.balance }.publish(&e);
                    }
                }
                // The Seller is paid after the noteholders, below.
                Item::Residual => {}
            }
            if step.due > 0 {
                lines.push_back(RankLine(
                    order.get(step.rank).unwrap().id,
                    step.item,
                    step.due,
                    step.paid,
                    step.alloc - step.paid,
                ));
            }
        }

        // Hand the noteholder money - interest AND principal - to the paying
        // agent contract, then let it know the period's split.
        let mut allocs: Vec<ClassAlloc> = Vec::new(&e);
        let mut paid_totals: Vec<i128> = Vec::new(&e);
        let mut class_states: Vec<ClassState> = Vec::new(&e);
        let mut agent_total: i128 = 0;
        let mut outstanding_total: i128 = 0;
        for index in 0..count as usize {
            let alloc = ClassAlloc {
                interest: outcome.interest[index],
                principal: outcome.principal[index],
                per_note_principal: outcome.per_note_principal[index],
            };
            agent_total += alloc.interest + alloc.principal;
            paid_totals.push_back(alloc.interest + alloc.principal);
            allocs.push_back(alloc);
            outstanding_total += outcome.per_note[index];
            class_states.push_back(ClassState {
                per_note_outstanding: outcome.per_note[index],
                shortfall: outcome.shortfall[index],
            });
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

        // The residual to the Seller.
        let mut reserve = outcome.reserve;
        let mut carry = outcome.carry;
        let mut residual_out = outcome.residual;
        let mut surplus: i128 = 0;
        if outstanding_total == 0 {
            // Wind-down sweep: the reserve is the subordinated-loan
            // repayment; carry and residual go with it, and so does any
            // surplus. The amounts owed stay. On a deficit, the sweep keeps
            // its ledger value, the transfer fails and the balance check
            // below stops the period.
            let ledgers = outcome.residual + reserve + carry;
            let sweep = ledgers.max(client.balance(&this) - owed_total);
            residual_out = ledgers;
            surplus = sweep - ledgers;
            reserve = 0;
            carry = 0;
            if sweep > 0
                && Self::pay_or_park(&e, &client, &config.seller, sweep, period, RANK_RESIDUAL, &mut owed_total)
            {
                ResidualPaid { seller: config.seller.clone(), amount: sweep }.publish(&e);
            }
            e.storage().instance().set(&DataKey::State, &State::Matured);
            Matured { period }.publish(&e);
        } else if outcome.residual > 0
            && Self::pay_or_park(&e, &client, &config.seller, outcome.residual, period, RANK_RESIDUAL, &mut owed_total)
        {
            ResidualPaid { seller: config.seller.clone(), amount: outcome.residual }.publish(&e);
        }

        e.storage().instance().set(&DataKey::ClassStates, &class_states);
        e.storage().instance().set(&DataKey::Reserve, &reserve);
        e.storage().instance().set(&DataKey::Carry, &carry);
        e.storage().instance().set(&DataKey::OwedTotal, &owed_total);
        e.storage().instance().set(&DataKey::NextPeriod, &(period + 1));
        CarryUpdated { period, carry }.publish(&e);

        // The trigger flags of the period.
        if !config.triggers.is_empty() {
            let mut flags: Vec<bool> = Vec::new(&e);
            for index in 0..config.triggers.len() {
                flags.push_back(outcome.triggers[index as usize]);
                if outcome.breached[index as usize] {
                    TriggerBreached { id: config.triggers.get(index).unwrap().id, period }.publish(&e);
                }
            }
            e.storage().instance().set(&DataKey::Triggers, &flags);
        }

        // The two rules that make the SPV auditable at a glance. A surplus
        // is accepted; a deficit (a clawback) stops the period.
        let balance = client.balance(&this);
        if balance < reserve + carry + owed_total {
            panic!("distribute balance invariant");
        }
        let paid_out = fees_out + agent_total + residual_out;
        if collections + reserve_in + carry_in != paid_out + reserve + carry {
            panic!("distribute conservation");
        }
        RankLines { period, enforced, lines }.publish(&e);
        PeriodSettled {
            period,
            collections,
            reserve_in,
            carry_in,
            drawn: outcome.drawn,
            paid_out,
            reserve,
            carry,
            owed: owed_total,
            balance,
            surplus,
        }
        .publish(&e);
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

    /// Replace the servicer. Admin only. The admin cannot become the
    /// servicer: the two roles stay separate.
    pub fn set_servicer(e: Env, servicer: Address) -> Result<(), DealError> {
        let mut config = Self::read_config(&e);
        config.admin.require_auth();
        if servicer == config.admin {
            return Err(DealError::RoleConflict);
        }
        config.servicer = servicer;
        e.storage().instance().set(&DataKey::Config, &config);
        Ok(())
    }

    /// The recipient takes all its parked payouts (fees or residual that a
    /// freeze of the recipient blocked). Any state.
    pub fn claim_owed(e: Env, recipient: Address) -> Result<i128, DealError> {
        recipient.require_auth();
        let key = DataKey::Owed(recipient.clone());
        let owed: i128 = e.storage().persistent().get(&key).unwrap_or(0);
        if owed <= 0 {
            return Err(DealError::NothingOwed);
        }
        e.storage().persistent().remove(&key);
        let total: i128 = e.storage().instance().get(&DataKey::OwedTotal).unwrap_or(0);
        e.storage().instance().set(&DataKey::OwedTotal, &(total - owed));
        let config = Self::read_config(&e);
        token::Client::new(&e, &config.asset).transfer(
            &e.current_contract_address(),
            &recipient,
            &owed,
        );
        OwedClaimed { recipient, amount: owed }.publish(&e);
        Ok(owed)
    }

    // --- Whitelist ----------------------------------------------------------

    /// Add holders to the deal whitelist (`eligible` true) or remove them
    /// (false). Admin only. Only a listed investor can subscribe, and a note
    /// transfer needs a listed receiver. A removed holder keeps its notes
    /// and is still paid.
    pub fn set_eligible(e: Env, holders: Vec<Address>, eligible: bool) -> Result<(), DealError> {
        let config = Self::read_config(&e);
        config.admin.require_auth();
        for holder in holders.iter() {
            let key = DataKey::Eligible(holder.clone());
            if eligible {
                e.storage().persistent().set(&key, &true);
                bump_persistent(&e, &key);
            } else {
                e.storage().persistent().remove(&key);
            }
            EligibilitySet { holder, eligible }.publish(&e);
        }
        Ok(())
    }

    /// True when `holder` is on the deal whitelist. The note tokens call it
    /// before each transfer.
    pub fn is_eligible(e: Env, holder: Address) -> bool {
        Self::eligible(&e, &holder)
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

    /// The open subscriptions (at most `MAX_SUBSCRIPTIONS`).
    pub fn get_subscription_count(e: Env) -> u32 {
        e.storage().instance().get(&DataKey::SubscriptionCount).unwrap_or(0)
    }

    /// The parked payouts owed to `recipient`.
    pub fn get_owed(e: Env, recipient: Address) -> i128 {
        e.storage().persistent().get(&DataKey::Owed(recipient)).unwrap_or(0)
    }

    /// The sum of all parked payouts not claimed yet.
    pub fn get_owed_total(e: Env) -> i128 {
        e.storage().instance().get(&DataKey::OwedTotal).unwrap_or(0)
    }

    /// The required reserve for the current balance of the notes. Before the
    /// closing, it is the subordinated loan that the Seller must fund.
    pub fn get_required_reserve(e: Env) -> i128 {
        let config = Self::read_config(&e);
        let enforced = Self::read_state(&e) == State::Enforced;
        let mut notes_open: i128 = 0;
        for outstanding in Self::get_outstanding(e.clone()).iter() {
            notes_open += outstanding;
        }
        engine::required_reserve(&config, enforced, notes_open)
    }

    /// The stored trigger flags, in the order of the triggers of the
    /// configuration. A flag is true when its trigger held at the last
    /// payment date.
    pub fn get_triggers(e: Env) -> Vec<bool> {
        let config = Self::read_config(&e);
        let stored = Self::read_triggers(&e);
        let mut flags: Vec<bool> = Vec::new(&e);
        for index in 0..config.triggers.len() {
            flags.push_back(stored.get(index).unwrap_or(false));
        }
        flags
    }

    // --- internals ----------------------------------------------------------

    fn eligible(e: &Env, holder: &Address) -> bool {
        let key = DataKey::Eligible(holder.clone());
        if e.storage().persistent().has(&key) {
            bump_persistent(e, &key);
            true
        } else {
            false
        }
    }

    /// Pay `amount` to `recipient`. When the transfer fails (for example the
    /// asset issuer froze the recipient), park the amount as owed to the
    /// recipient and return false.
    fn pay_or_park(
        e: &Env,
        client: &token::Client,
        recipient: &Address,
        amount: i128,
        period: u32,
        rank: u32,
        owed_total: &mut i128,
    ) -> bool {
        if let Ok(Ok(())) = client.try_transfer(&e.current_contract_address(), recipient, &amount) {
            return true;
        }
        let key = DataKey::Owed(recipient.clone());
        let owed: i128 = e.storage().persistent().get(&key).unwrap_or(0);
        e.storage().persistent().set(&key, &(owed + amount));
        bump_persistent(e, &key);
        *owed_total += amount;
        PayoutParked { recipient: recipient.clone(), period, rank, amount }.publish(e);
        false
    }

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

    #[cfg(test)]
    fn round_per_note(entitlement: i128, notes: i128, round_unit: i128) -> (i128, i128) {
        engine::round_per_note(entitlement, notes, round_unit)
    }

    fn read_triggers(e: &Env) -> Vec<bool> {
        e.storage().instance().get(&DataKey::Triggers).unwrap_or(Vec::new(e))
    }

    /// The fixing of the rate oracle, in rate units. A missing fixing or a
    /// fixing older than `oracle_max_staleness_secs` stops the payment date.
    fn read_fixing(e: &Env, config: &DealConfig) -> Result<i128, DealError> {
        let oracle = RateOracleClient::new(e, &config.oracle);
        let fixing = oracle.lastprice().ok_or(DealError::RateUnavailable)?;
        let now = e.ledger().timestamp();
        if now.saturating_sub(fixing.timestamp) > config.oracle_max_staleness_secs {
            return Err(DealError::RateStale);
        }
        Ok(fixing.price)
    }

    /// The role that publishes the reference rate is separate from the two
    /// roles of the deal. A deal with a floating class asks its oracle for
    /// the reporter. It refuses a reporter that is the admin or the
    /// servicer, and an oracle that does not name its reporter. A deal with
    /// fixed rates only does not read the oracle.
    fn require_separate_reporter(e: &Env, config: &DealConfig) -> Result<(), DealError> {
        if !engine::has_floating_class(config) {
            return Ok(());
        }
        match RateOracleClient::new(e, &config.oracle).try_get_reporter() {
            Ok(Ok(reporter)) if reporter != config.admin && reporter != config.servicer => Ok(()),
            _ => Err(DealError::RoleConflict),
        }
    }
}

#[cfg(test)]
mod fixture;
#[cfg(test)]
mod reference;
#[cfg(test)]
mod test;
#[cfg(test)]
mod test_d1;
#[cfg(test)]
mod test_d2;
#[cfg(test)]
mod test_roles;
#[cfg(test)]
mod test_settle;
#[cfg(test)]
mod test_validate;
#[cfg(test)]
mod test_vectors;
