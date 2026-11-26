//! The types of the deal contract: the scales, the limits, the errors, the
//! configuration and the ledgers.

use soroban_sdk::{contracterror, contracttype, Address, Symbol, Vec};

/// 100% in rate units (percent x 1_000) - shared with the RateOracle.
pub const RATE_SCALE: i128 = 100_000;
/// 100% in note-factor units (7 dp, close to A-BEST's 8 dp Principal Factor).
pub const FACTOR_SCALE: i128 = 10_000_000;
/// Upper limit of the class count. `distribute` touches every class in one
/// transaction, and the network limits the resources of a transaction.
pub const MAX_CLASSES: u32 = 8;
/// Upper limit of the open subscriptions (one per investor and class). The
/// closing issues the notes of every subscription in one transaction, and
/// each issue emits an event: the network limits the event size of a
/// transaction to 16 KB, about 120 issues. 100 keeps a margin.
pub const MAX_SUBSCRIPTIONS: u32 = 100;
/// Upper limit of the fee lines.
pub const MAX_FEES: u32 = 4;
/// Upper limit of the triggers.
pub const MAX_TRIGGERS: u32 = 4;
/// Upper limit of the ranks of one order.
pub const MAX_RANKS: u32 = 24;
/// Upper limit of the items of one rank.
pub const MAX_RANK_ITEMS: u32 = 8;
/// Upper limit of the items of one order.
pub const MAX_ORDER_ITEMS: u32 = 40;
pub(crate) const DAY_COUNT_BASE: i128 = 360;

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
    /// A note token or the paying agent does not belong to this deal.
    WiringMismatch = 14,
    /// The investor is not on the deal whitelist.
    NotEligible = 15,
    /// `claim_owed` found no amount owed to the recipient.
    NothingOwed = 16,
    /// The deal already has `MAX_SUBSCRIPTIONS` open subscriptions.
    TooManySubscriptions = 17,
    /// One address holds two of the three separate roles: the admin, the
    /// servicer and the reporter of the rate oracle. Also given when the
    /// oracle of a floating deal does not name its reporter.
    RoleConflict = 18,
}

/// Rate of one class: a spread over the oracle fixing, or a fixed rate.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RateSpec {
    /// Spread over the index (EURIBOR 1M) in 0.001% units.
    Floating(i128),
    /// Fixed annual rate in 0.001% units.
    Fixed(i128),
}

/// Terms of one class. The floors apply to a floating rate only.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClassTerms {
    pub rate: RateSpec,
    pub total_notes: i128,
    /// Floor of the all-in rate (index + spread), in 0.001% units. The
    /// reference deal has a floor of 0. Without a floor, a negative all-in
    /// rate gives no interest.
    pub floor: Option<i128>,
    /// Floor of the index before the spread, in 0.001% units.
    pub index_floor: Option<i128>,
}

/// Amount of one fee line for one period.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FeeAmount {
    /// A fixed amount per period, in asset base units.
    Fixed(i128),
    /// An annual rate in 0.001% units, on the opening balance of the notes,
    /// for `days_in_period` / 360.
    PerAnnum(i128),
}

/// One fee line. A fee that the cash does not cover is not due again.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeLine {
    pub recipient: Address,
    pub amount: FeeAmount,
}

/// The required amount of the cash reserve.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RequiredRule {
    /// A fixed amount, in asset base units.
    Fixed(i128),
    /// A percent of the opening balance of the notes (in 0.001% units), and
    /// a floor (in asset base units).
    PctOfNotes(i128, i128),
}

/// How the reserve enters the available amount of a period.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Release {
    /// The whole reserve is released at the top, then re-funded at its rank.
    Full,
    /// The reserve stays in its ledger. A draw rank takes its shortfall from
    /// the reserve. The excess over the required amount is released at the
    /// top.
    OnNeed,
}

/// The cash reserve. The Seller funds it with the subordinated loan, to the
/// required amount at the closing.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReserveTerms {
    pub required: RequiredRule,
    pub release: Release,
    /// With `OnNeed`: the ids of the ranks of the normal order that the
    /// reserve covers. A draw rank holds fee and interest items only.
    pub draw_ranks: Vec<Symbol>,
}

/// The figure that a trigger compares with its threshold. Each metric reads
/// the ledgers at the start of the period.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Metric {
    /// Outstanding per note of a class / denomination, in `FACTOR_SCALE` units.
    ClassFactor(u32),
    /// Outstanding of all notes / initial balance, in `FACTOR_SCALE` units.
    NotesFactor,
    /// Required reserve minus the reserve, floor 0, in asset base units.
    ReserveShortfall,
    /// Unpaid interest of a class, in asset base units.
    ClassShortfall(u32),
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Op {
    Gt,
    Ge,
    Lt,
    Le,
}

/// A trigger: `metric op threshold`. A latched trigger stays set.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TriggerTerms {
    pub id: Symbol,
    pub metric: Metric,
    pub op: Op,
    pub threshold: i128,
    pub latch: bool,
}

/// The condition of a rank.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Cond {
    Always,
    /// The rank runs when the trigger is set.
    Trigger(Symbol),
    /// The rank runs when the trigger is not set.
    NotTrigger(Symbol),
}

/// How a rank splits its cash when the cash does not cover its dues.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RankAlloc {
    /// In item order.
    Sequential,
    /// In proportion to the dues. With principal items, this is pro rata
    /// principal.
    PariPassu,
}

/// One item of a rank. A number is the index of a fee line or of a class.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Item {
    /// A fee line: due = its amount for the period.
    Fee(u32),
    /// Interest of a class: due = accrual + shortfall.
    Interest(u32),
    /// Principal of a class: due = its outstanding balance.
    Principal(u32),
    /// Reserve re-fund: due = required amount minus the reserve.
    ReserveRefill,
    /// All the cash that is left, to the Seller.
    Residual,
}

/// One rank of an order.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rank {
    pub id: Symbol,
    pub when: Cond,
    pub alloc: RankAlloc,
    pub items: Vec<Item>,
}

/// One line of the `rank_lines` event: the rank id, the item, the due, the
/// amount paid, and the per-note dust that goes to the carry.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RankLine(pub Symbol, pub Item, pub i128, pub i128, pub i128);

/// The configuration of a deal, given once at the deployment. It holds the
/// terms and the priority of payments: a new prospectus is a new
/// configuration, not a new contract.
#[contracttype]
#[derive(Clone)]
pub struct DealConfig {
    /// The operator of the deal (the management company): wiring, whitelist,
    /// closing, enforcement.
    pub admin: Address,
    pub asset: Address,
    pub oracle: Address,
    pub seller: Address,
    /// The servicer: reports the collections and triggers a payment date.
    pub servicer: Address,
    pub days_in_period: u32,
    pub oracle_max_staleness_secs: u64,
    /// Original face of one note in asset base units.
    pub note_denomination: i128,
    /// Per-note rounding grain in asset base units.
    pub round_unit: i128,
    /// Senior first: A, B, C.
    pub classes: Vec<ClassTerms>,
    pub fees: Vec<FeeLine>,
    pub reserve: ReserveTerms,
    pub triggers: Vec<TriggerTerms>,
    /// The priority of payments before enforcement.
    pub normal: Vec<Rank>,
    /// The priority of payments after enforcement.
    pub enforced: Vec<Rank>,
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

/// Oracle fixing as stored by the rate-oracle crate.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

/// The paying agent configuration, as its `get_config` returns it
/// (XDR-compatible with the paying-agent `AgentConfig`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentConfig {
    pub deal: Address,
    pub asset: Address,
    pub note_tokens: Vec<Address>,
}
