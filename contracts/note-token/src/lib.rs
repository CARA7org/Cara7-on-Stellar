//! ABS note token - the "Senior/Mezzanine/Junior Tokens" boxes of the CARA7
//! Data Spec Book. One instance per class.
//!
//! A note is NOT a fund share: the token has a fixed original face (discrete
//! note units of `denomination` EURC, decimals 0), no burn, no mint after
//! issuance is finalized, and no deposit/withdraw/redeem surface. Amortization
//! never touches balances - the deal contract tracks the declining per-note
//! outstanding and the derived note factor (BBVA prospectus: notes are
//! "amortised in an equal amount by reducing the face amount of each of the
//! Notes").
//!
//! Besides the SEP-41 surface, the token keeps the payment-period bookkeeping
//! the paying agent needs (the chart's "Interest service MERKL" box):
//! - a holder registry (append-only),
//! - a lazy day-weight ledger: every transfer settles note-seconds for both
//!   parties, so a mid-period transfer splits the next coupon pro rata
//!   temporis between seller and buyer,
//! - end-of-period balance snapshots: principal follows the holder of record
//!   at the payment date (there is no record date in domestic-CSD deals).
//!
//! The invariant that keeps the views O(1): for any holder and any CLOSED
//! period P, either the holder's accrual is still parked at a period <= P
//! (their balance has not changed since, so `balance x period length` is
//! exact) or a transfer has frozen `FinalWeight/FinalBalance` for P.
//! Transfers freeze every intervening closed period, so a later period can
//! never shadow an unfrozen earlier one.

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, String, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum NoteError {
    NotController = 1,
    AlreadyFinalized = 2,
    NotFinalized = 3,
    InvalidAmount = 4,
    InsufficientBalance = 5,
    InsufficientAllowance = 6,
    BadPeriod = 8,
}

#[contracttype]
#[derive(Clone)]
pub struct TokenConfig {
    /// The abs-deal contract: sole issuer, sole period roller.
    pub controller: Address,
    pub name: String,
    pub symbol: String,
    /// Original face of one note in asset base units (POC: 100 EURC).
    pub denomination: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PeriodInfo {
    pub id: u32,
    pub start_ts: u64,
}

/// Day-weight accrual state of one holder, parked at the last period a
/// transfer touched them.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Accrual {
    pub period_id: u32,
    /// Note-seconds accrued inside `period_id` up to `last_ts`.
    pub weight: i128,
    pub last_ts: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllowanceData {
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    // instance
    Config,
    Issued, // bool - finalize_issuance flips it
    TotalNotes,
    Period,  // PeriodInfo - the OPEN period
    Holders, // Vec<Address>, append-only
    // persistent
    Balance(Address),
    Allowance(Address, Address),
    Accrual(Address),
    FinalWeight(u32, Address),
    FinalBalance(u32, Address),
    PeriodEnd(u32), // set by roll_period; PeriodEnd(0) = issuance start_ts
}

const PERSISTENT_BUMP: u32 = 30 * 24 * 60 * 12; // ~30 days of ledgers
const PERSISTENT_LIFETIME: u32 = PERSISTENT_BUMP - 1;

fn bump_persistent(e: &Env, key: &DataKey) {
    e.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_LIFETIME, PERSISTENT_BUMP);
}

// --- events -----------------------------------------------------------------

#[contractevent(data_format = "single-value")]
pub struct Issue {
    #[topic]
    pub to: Address,
    pub notes: i128,
}

/// SEP-41 shape: topics `[transfer, from, to]`, data = amount.
#[contractevent(data_format = "single-value")]
pub struct Transfer {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub notes: i128,
}

#[contractevent(data_format = "vec")]
pub struct Approve {
    #[topic]
    pub from: Address,
    #[topic]
    pub spender: Address,
    pub notes: i128,
    pub expiration_ledger: u32,
}

#[contractevent(data_format = "vec")]
pub struct PeriodRolled {
    pub id: u32,
    pub start_ts: u64,
    pub end_ts: u64,
}

/// Trace of a lazy freeze: the day-weight and balance a closed period settled
/// at when a later transfer touched the holder (the indexer's coupon-split
/// evidence).
#[contractevent(data_format = "vec")]
pub struct WeightFrozen {
    #[topic]
    pub holder: Address,
    pub period: u32,
    pub weight: i128,
    pub balance: i128,
}

#[contract]
pub struct NoteToken;

#[contractimpl]
impl NoteToken {
    pub fn __constructor(
        e: Env,
        controller: Address,
        name: String,
        symbol: String,
        denomination: i128,
    ) {
        if denomination <= 0 {
            panic!("invalid denomination");
        }
        e.storage().instance().set(
            &DataKey::Config,
            &TokenConfig { controller, name, symbol, denomination },
        );
        e.storage().instance().set(&DataKey::Issued, &false);
        e.storage().instance().set(&DataKey::TotalNotes, &0i128);
        e.storage().instance().set(&DataKey::Holders, &Vec::<Address>::new(&e));
    }

    // --- issuance (controller = abs-deal, invoker-authed) -------------------

    /// Credit `notes` to a subscriber. Only before `finalize_issuance`.
    pub fn issue(e: Env, to: Address, notes: i128) -> Result<(), NoteError> {
        let config = Self::config(&e);
        config.controller.require_auth();
        if Self::issued(&e) {
            return Err(NoteError::AlreadyFinalized);
        }
        if notes <= 0 {
            return Err(NoteError::InvalidAmount);
        }
        let balance = Self::read_balance(&e, &to);
        Self::write_balance(&e, &to, balance + notes);
        if balance == 0 {
            Self::register_holder(&e, &to);
        }
        let total: i128 = e.storage().instance().get(&DataKey::TotalNotes).unwrap();
        e.storage().instance().set(&DataKey::TotalNotes, &(total + notes));
        Issue { to, notes }.publish(&e);
        Ok(())
    }

    /// Freeze supply, enable transfers, open payment period 1 at `start_ts`.
    pub fn finalize_issuance(e: Env, start_ts: u64) -> Result<(), NoteError> {
        let config = Self::config(&e);
        config.controller.require_auth();
        if Self::issued(&e) {
            return Err(NoteError::AlreadyFinalized);
        }
        e.storage().instance().set(&DataKey::Issued, &true);
        e.storage().instance().set(&DataKey::Period, &PeriodInfo { id: 1, start_ts });
        let key = DataKey::PeriodEnd(0);
        e.storage().persistent().set(&key, &start_ts);
        bump_persistent(&e, &key);
        Ok(())
    }

    // --- SEP-41 surface (no burn, no mint) ----------------------------------

    pub fn balance(e: Env, id: Address) -> i128 {
        Self::read_balance(&e, &id)
    }

    pub fn total_supply(e: Env) -> i128 {
        e.storage().instance().get(&DataKey::TotalNotes).unwrap()
    }

    pub fn name(e: Env) -> String {
        Self::config(&e).name
    }

    pub fn symbol(e: Env) -> String {
        Self::config(&e).symbol
    }

    /// Discrete note units - one token = one note of `denomination` face.
    pub fn decimals(_e: Env) -> u32 {
        0
    }

    pub fn denomination(e: Env) -> i128 {
        Self::config(&e).denomination
    }

    pub fn transfer(e: Env, from: Address, to: Address, notes: i128) -> Result<(), NoteError> {
        from.require_auth();
        Self::do_transfer(&e, &from, &to, notes)
    }

    pub fn approve(
        e: Env,
        from: Address,
        spender: Address,
        notes: i128,
        expiration_ledger: u32,
    ) -> Result<(), NoteError> {
        from.require_auth();
        if notes < 0 {
            return Err(NoteError::InvalidAmount);
        }
        let key = DataKey::Allowance(from.clone(), spender.clone());
        e.storage()
            .persistent()
            .set(&key, &AllowanceData { amount: notes, expiration_ledger });
        bump_persistent(&e, &key);
        Approve { from, spender, notes, expiration_ledger }.publish(&e);
        Ok(())
    }

    pub fn allowance(e: Env, from: Address, spender: Address) -> i128 {
        Self::read_allowance(&e, &from, &spender).amount
    }

    pub fn transfer_from(
        e: Env,
        spender: Address,
        from: Address,
        to: Address,
        notes: i128,
    ) -> Result<(), NoteError> {
        spender.require_auth();
        let allowance = Self::read_allowance(&e, &from, &spender);
        if allowance.amount < notes {
            return Err(NoteError::InsufficientAllowance);
        }
        let key = DataKey::Allowance(from.clone(), spender);
        e.storage().persistent().set(
            &key,
            &AllowanceData {
                amount: allowance.amount - notes,
                expiration_ledger: allowance.expiration_ledger,
            },
        );
        bump_persistent(&e, &key);
        Self::do_transfer(&e, &from, &to, notes)
    }

    // --- payment periods ----------------------------------------------------

    /// Close the open period at `end_ts` and open the next. Controller only.
    /// Returns the closed period id.
    pub fn roll_period(e: Env, end_ts: u64) -> Result<u32, NoteError> {
        let config = Self::config(&e);
        config.controller.require_auth();
        if !Self::issued(&e) {
            return Err(NoteError::NotFinalized);
        }
        let period: PeriodInfo = e.storage().instance().get(&DataKey::Period).unwrap();
        if end_ts < period.start_ts {
            return Err(NoteError::BadPeriod);
        }
        let key = DataKey::PeriodEnd(period.id);
        e.storage().persistent().set(&key, &end_ts);
        bump_persistent(&e, &key);
        e.storage()
            .instance()
            .set(&DataKey::Period, &PeriodInfo { id: period.id + 1, start_ts: end_ts });
        PeriodRolled { id: period.id, start_ts: period.start_ts, end_ts }.publish(&e);
        Ok(period.id)
    }

    pub fn current_period(e: Env) -> PeriodInfo {
        e.storage().instance().get(&DataKey::Period).unwrap()
    }

    pub fn holders(e: Env) -> Vec<Address> {
        e.storage().instance().get(&DataKey::Holders).unwrap()
    }

    /// Note-seconds held by `holder` during CLOSED period `period`.
    pub fn weight_of(e: Env, period: u32, holder: Address) -> Result<i128, NoteError> {
        let (start, end) = Self::closed_period_bounds(&e, period)?;
        let frozen_key = DataKey::FinalWeight(period, holder.clone());
        if let Some(weight) = e.storage().persistent().get::<DataKey, i128>(&frozen_key) {
            return Ok(weight);
        }
        let balance = Self::read_balance(&e, &holder);
        match Self::read_accrual(&e, &holder) {
            Some(accrual) if accrual.period_id == period => {
                Ok(accrual.weight + balance * (end - accrual.last_ts) as i128)
            }
            Some(accrual) if accrual.period_id > period => {
                // No FinalWeight and parked past `period`: the holder held 0
                // for the whole period (transfers freeze every intervening
                // period they slept through with a nonzero balance).
                Ok(0)
            }
            // Parked before the period (or never touched): balance unchanged
            // across the whole period.
            _ => Ok(balance * (end - start) as i128),
        }
    }

    /// Balance of `holder` at the close of CLOSED period `period` (the
    /// holder of record for principal).
    pub fn balance_at_end(e: Env, period: u32, holder: Address) -> Result<i128, NoteError> {
        Self::closed_period_bounds(&e, period)?;
        let key = DataKey::FinalBalance(period, holder.clone());
        if let Some(balance) = e.storage().persistent().get::<DataKey, i128>(&key) {
            return Ok(balance);
        }
        match Self::read_accrual(&e, &holder) {
            // Parked past the period with no frozen balance: held 0 then.
            Some(accrual) if accrual.period_id > period => Ok(0),
            // Untouched since the period closed: the current balance is it.
            _ => Ok(Self::read_balance(&e, &holder)),
        }
    }

    /// Total note-seconds of CLOSED period `period` (supply is constant
    /// after issuance).
    pub fn total_weight(e: Env, period: u32) -> Result<i128, NoteError> {
        let (start, end) = Self::closed_period_bounds(&e, period)?;
        let total: i128 = e.storage().instance().get(&DataKey::TotalNotes).unwrap();
        Ok(total * (end - start) as i128)
    }

    // --- internals ----------------------------------------------------------

    fn config(e: &Env) -> TokenConfig {
        e.storage().instance().get(&DataKey::Config).unwrap()
    }

    fn issued(e: &Env) -> bool {
        e.storage().instance().get(&DataKey::Issued).unwrap()
    }

    fn read_balance(e: &Env, addr: &Address) -> i128 {
        let key = DataKey::Balance(addr.clone());
        let balance = e.storage().persistent().get(&key).unwrap_or(0);
        if balance > 0 {
            bump_persistent(e, &key);
        }
        balance
    }

    fn write_balance(e: &Env, addr: &Address, amount: i128) {
        let key = DataKey::Balance(addr.clone());
        e.storage().persistent().set(&key, &amount);
        bump_persistent(e, &key);
    }

    fn read_allowance(e: &Env, owner: &Address, spender: &Address) -> AllowanceData {
        let key = DataKey::Allowance(owner.clone(), spender.clone());
        match e.storage().persistent().get::<DataKey, AllowanceData>(&key) {
            Some(allowance) if allowance.expiration_ledger >= e.ledger().sequence() => allowance,
            _ => AllowanceData { amount: 0, expiration_ledger: 0 },
        }
    }

    fn read_accrual(e: &Env, addr: &Address) -> Option<Accrual> {
        e.storage().persistent().get(&DataKey::Accrual(addr.clone()))
    }

    fn register_holder(e: &Env, addr: &Address) {
        let mut holders: Vec<Address> = e.storage().instance().get(&DataKey::Holders).unwrap();
        for existing in holders.iter() {
            if existing == *addr {
                return;
            }
        }
        holders.push_back(addr.clone());
        e.storage().instance().set(&DataKey::Holders, &holders);
    }

    fn closed_period_bounds(e: &Env, period: u32) -> Result<(u64, u64), NoteError> {
        if period == 0 || !Self::issued(e) {
            return Err(NoteError::BadPeriod);
        }
        let current: PeriodInfo = e.storage().instance().get(&DataKey::Period).unwrap();
        if period >= current.id {
            return Err(NoteError::BadPeriod);
        }
        let start: u64 = e
            .storage()
            .persistent()
            .get(&DataKey::PeriodEnd(period - 1))
            .ok_or(NoteError::BadPeriod)?;
        let end: u64 = e
            .storage()
            .persistent()
            .get(&DataKey::PeriodEnd(period))
            .ok_or(NoteError::BadPeriod)?;
        Ok((start, end))
    }

    fn do_transfer(e: &Env, from: &Address, to: &Address, notes: i128) -> Result<(), NoteError> {
        if !Self::issued(e) {
            return Err(NoteError::NotFinalized);
        }
        if notes <= 0 {
            return Err(NoteError::InvalidAmount);
        }
        let from_balance = Self::read_balance(e, from);
        if from_balance < notes {
            return Err(NoteError::InsufficientBalance);
        }
        if from == to {
            return Ok(()); // self-transfer: no balance or weight effect
        }
        // Settle day-weights on the PRE-transfer balances.
        Self::settle(e, from, from_balance);
        let to_balance = Self::read_balance(e, to);
        Self::settle(e, to, to_balance);

        Self::write_balance(e, from, from_balance - notes);
        Self::write_balance(e, to, to_balance + notes);
        if to_balance == 0 {
            Self::register_holder(e, to);
        }
        Transfer { from: from.clone(), to: to.clone(), notes }.publish(e);
        Ok(())
    }

    /// Bring `holder`'s accrual up to `now` inside the open period, freezing
    /// every closed period the holder slept through at their (unchanged)
    /// balance.
    fn settle(e: &Env, holder: &Address, balance: i128) {
        let current: PeriodInfo = e.storage().instance().get(&DataKey::Period).unwrap();
        let now = e.ledger().timestamp();
        let accrual = Self::read_accrual(e, holder).unwrap_or(Accrual {
            period_id: 0,
            weight: 0,
            last_ts: 0,
        });

        if accrual.period_id < current.id {
            // Freeze the period the accrual was parked in (if it is a real,
            // closed period)...
            if accrual.period_id > 0 {
                let end: u64 = e
                    .storage()
                    .persistent()
                    .get(&DataKey::PeriodEnd(accrual.period_id))
                    .unwrap();
                let weight = accrual.weight + balance * (end - accrual.last_ts) as i128;
                Self::freeze(e, accrual.period_id, holder, weight, balance);
            }
            // ...and every closed period slept through since, at the same
            // balance. A zero balance needs no freeze: the missing-FinalWeight
            // view already answers 0 for a holder parked later.
            if balance > 0 {
                let first_untouched =
                    if accrual.period_id == 0 { 1 } else { accrual.period_id + 1 };
                for period in first_untouched..current.id {
                    let start: u64 =
                        e.storage().persistent().get(&DataKey::PeriodEnd(period - 1)).unwrap();
                    let end: u64 =
                        e.storage().persistent().get(&DataKey::PeriodEnd(period)).unwrap();
                    Self::freeze(e, period, holder, balance * (end - start) as i128, balance);
                }
            }
            let key = DataKey::Accrual(holder.clone());
            e.storage().persistent().set(
                &key,
                &Accrual {
                    period_id: current.id,
                    weight: balance * (now - current.start_ts) as i128,
                    last_ts: now,
                },
            );
            bump_persistent(e, &key);
        } else {
            // Already parked in the open period: extend to now.
            let key = DataKey::Accrual(holder.clone());
            e.storage().persistent().set(
                &key,
                &Accrual {
                    period_id: current.id,
                    weight: accrual.weight + balance * (now - accrual.last_ts) as i128,
                    last_ts: now,
                },
            );
            bump_persistent(e, &key);
        }
    }

    fn freeze(e: &Env, period: u32, holder: &Address, weight: i128, balance: i128) {
        let weight_key = DataKey::FinalWeight(period, holder.clone());
        if e.storage().persistent().has(&weight_key) {
            return;
        }
        e.storage().persistent().set(&weight_key, &weight);
        bump_persistent(e, &weight_key);
        let balance_key = DataKey::FinalBalance(period, holder.clone());
        e.storage().persistent().set(&balance_key, &balance);
        bump_persistent(e, &balance_key);
        WeightFrozen { holder: holder.clone(), period, weight, balance }.publish(e);
    }
}

#[cfg(test)]
mod test;
