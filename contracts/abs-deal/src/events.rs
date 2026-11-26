//! The events of the deal contract. The indexer reads them.

use crate::types::RankLine;
use soroban_sdk::{contractevent, Address, Symbol, Vec};

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

/// The admin added a holder to the whitelist (`eligible` true) or removed it.
#[contractevent(data_format = "vec")]
pub struct EligibilitySet {
    #[topic]
    pub holder: Address,
    pub eligible: bool,
}

/// A payout to a fees recipient (rank code 1) or to the Seller (rank code 7)
/// failed, for example because the asset issuer froze the recipient. The
/// amount stays in the deal, owed to the recipient.
#[contractevent(data_format = "vec")]
pub struct PayoutParked {
    #[topic]
    pub recipient: Address,
    pub period: u32,
    pub rank: u32,
    pub amount: i128,
}

/// A recipient took its parked payouts with `claim_owed`.
#[contractevent(data_format = "vec")]
pub struct OwedClaimed {
    #[topic]
    pub recipient: Address,
    pub amount: i128,
}

/// The rank-by-rank allocation of one period: one line for each item that
/// ran with a due above 0, in the order of execution. `enforced` tells which
/// order ran.
#[contractevent(data_format = "vec")]
pub struct RankLines {
    #[topic]
    pub period: u32,
    pub enforced: bool,
    pub lines: Vec<RankLine>,
}

/// The settlement of one period. A reader can check two rules with this
/// event alone:
///
/// - conservation: `collections + reserve_in + carry_in == paid_out + reserve + carry`;
/// - the balance invariant: `balance >= reserve + carry + owed`.
///
/// `paid_out` is the cash that leaves the ledgers: the fee lines, the cash
/// of the paying agent and the cash of the Seller. A parked payout is in
/// `paid_out` and in `owed`. `drawn` is the reserve cash that the draw ranks
/// took. `surplus` is cash above the ledgers that the maturity sweep pays to
/// the Seller.
#[contractevent(data_format = "vec")]
pub struct PeriodSettled {
    #[topic]
    pub period: u32,
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

/// A trigger is set in this period and was not set before.
#[contractevent(data_format = "vec")]
pub struct TriggerBreached {
    #[topic]
    pub id: Symbol,
    pub period: u32,
}
