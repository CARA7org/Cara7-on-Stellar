//! Paying agent contract - the "Paying Agent Interest & Principal" box of the
//! CARA7 Data Spec Book "Onchain" lane: `Waterfall --Stablecoin--> Paying
//! Agent --Stablecoins--> Investor Wallet`.
//!
//! Each period the deal contract transfers the noteholder money - interest
//! AND principal, per class - and calls `fund_period` with the split. Anyone
//! may then crank `push_batch` (a keeper in practice): it walks the note
//! token's holder registry and PUSHES EURC to every holder, at most 10
//! transfers per call (the Spiko batch ceiling), resumable by cursor,
//! double-pay-proof by per-holder markers.
//!
//! Entitlements per holder (the chart's "Interest service MERKL"):
//! - interest is split by DAY-WEIGHT (note-seconds held during the period,
//!   read from the note token) - a mid-period buyer and seller each get
//!   their pro-rata temporis share of the coupon;
//! - principal follows the HOLDER OF RECORD at the period close
//!   (`balance_at_end`) - the no-record-date semantics of domestic-CSD
//!   deals.
//!
//! A failed push (missing trustline, frozen account...) never blocks the
//! batch: the amount becomes claimable and the holder pulls it later with
//! `claim`. Per-holder cumulative interest/principal counters (the Goldfinch
//! `interestRedeemed`/`principalRedeemed` pattern) make every position fully
//! reconstructible. Sub-stroop remainders of the pro-rata interest split
//! accumulate per class and fold into that class's next interest pot.
//!
//! Invariant: the contract's asset balance always equals unpushed
//! allocations + open claimables + the dust pots.

#![no_std]

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, token,
    Address, Env, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AgentError {
    NotDeal = 1,
    UnknownPeriod = 2,
    AlreadyFunded = 3,
    BadClass = 4,
    NothingToClaim = 5,
    BatchComplete = 6,
    InvalidAmount = 7,
}

#[contracttype]
#[derive(Clone)]
pub struct AgentConfig {
    pub deal: Address,
    pub asset: Address,
    pub note_tokens: Vec<Address>,
}

/// Per-class allocation received from the deal (XDR-compatible with the
/// abs-deal `ClassAlloc`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClassAlloc {
    pub interest: i128,
    pub principal: i128,
    pub per_note_principal: i128,
}

/// Payout state of one (period, class).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllocState {
    /// Interest pot for the day-weight split (period interest + prior dust).
    pub interest_pot: i128,
    pub principal: i128,
    pub per_note_principal: i128,
    /// Interest actually attributed to holders so far (pushed or claimable).
    pub allocated_interest: i128,
    pub cursor: u32,
    pub holder_count: u32,
    pub done: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Claimable {
    pub interest: i128,
    pub principal: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HolderTotals {
    pub interest_paid: i128,
    pub principal_paid: i128,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    // instance
    Config,
    // persistent
    Alloc(u32, u32),            // (period, class)
    Claimable(u32, Address),    // (class, holder)
    HolderTotals(u32, Address), // (class, holder)
    Dust(u32),                  // per-class sub-stroop interest remainder
    HolderDone(u32, u32, Address), // (period, class, holder) paid marker
}

const PERSISTENT_BUMP: u32 = 30 * 24 * 60 * 12;
const PERSISTENT_LIFETIME: u32 = PERSISTENT_BUMP - 1;
/// The Spiko-validated per-transaction transfer ceiling.
const MAX_BATCH: u32 = 10;

fn bump_persistent(e: &Env, key: &DataKey) {
    e.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_LIFETIME, PERSISTENT_BUMP);
}

#[allow(dead_code)]
#[contractclient(name = "NoteTokenClient")]
pub trait NoteTokenInterface {
    fn holders(e: Env) -> Vec<Address>;
    fn total_supply(e: Env) -> i128;
    fn weight_of(e: Env, period: u32, holder: Address) -> i128;
    fn balance_at_end(e: Env, period: u32, holder: Address) -> i128;
    fn total_weight(e: Env, period: u32) -> i128;
}

// --- events -----------------------------------------------------------------

#[contractevent(data_format = "vec")]
pub struct PeriodFunded {
    #[topic]
    pub period: u32,
    pub class: u32,
    pub interest: i128,
    pub principal: i128,
    pub per_note_principal: i128,
}

#[contractevent(data_format = "vec")]
pub struct HolderPaid {
    #[topic]
    pub holder: Address,
    pub period: u32,
    pub class: u32,
    pub interest: i128,
    pub principal: i128,
}

/// Push could not settle (e.g. missing trustline): amount parked as
/// claimable.
#[contractevent(data_format = "vec")]
pub struct PushFailed {
    #[topic]
    pub holder: Address,
    pub period: u32,
    pub class: u32,
    pub amount: i128,
}

/// One event per class drained by a `claim` (class-attributable for the
/// indexer's per-holder counters).
#[contractevent(data_format = "vec")]
pub struct Claimed {
    #[topic]
    pub holder: Address,
    pub class: u32,
    pub interest: i128,
    pub principal: i128,
}

#[contractevent(data_format = "vec")]
pub struct BatchDone {
    #[topic]
    pub period: u32,
    pub class: u32,
    pub cursor: u32,
    pub complete: bool,
}

#[contract]
pub struct PayingAgent;

#[contractimpl]
impl PayingAgent {
    pub fn __constructor(e: Env, deal: Address, asset: Address, note_tokens: Vec<Address>) {
        if note_tokens.is_empty() {
            panic!("no note tokens");
        }
        e.storage()
            .instance()
            .set(&DataKey::Config, &AgentConfig { deal, asset, note_tokens });
    }

    /// Record a period's per-class split. Deal-only (invoker auth); the EURC
    /// arrives in the same transaction from `distribute`. Prior interest
    /// dust folds into each class's pot.
    pub fn fund_period(e: Env, period: u32, allocs: Vec<ClassAlloc>) -> Result<(), AgentError> {
        let config = Self::config(&e);
        config.deal.require_auth();
        if allocs.len() != config.note_tokens.len() {
            return Err(AgentError::BadClass);
        }
        for class in 0..allocs.len() {
            let key = DataKey::Alloc(period, class);
            if e.storage().persistent().has(&key) {
                return Err(AgentError::AlreadyFunded);
            }
            let alloc = allocs.get(class).unwrap();
            if alloc.interest < 0 || alloc.principal < 0 || alloc.per_note_principal < 0 {
                return Err(AgentError::InvalidAmount);
            }
            let dust_key = DataKey::Dust(class);
            let dust: i128 = e.storage().persistent().get(&dust_key).unwrap_or(0);
            if dust > 0 {
                e.storage().persistent().set(&dust_key, &0i128);
            }
            let note_token =
                NoteTokenClient::new(&e, &config.note_tokens.get(class).unwrap());
            let holder_count = note_token.holders().len();
            let state = AllocState {
                interest_pot: alloc.interest + dust,
                principal: alloc.principal,
                per_note_principal: alloc.per_note_principal,
                allocated_interest: 0,
                cursor: 0,
                holder_count,
                done: false,
            };
            e.storage().persistent().set(&key, &state);
            bump_persistent(&e, &key);
            PeriodFunded {
                period,
                class,
                interest: alloc.interest,
                principal: alloc.principal,
                per_note_principal: alloc.per_note_principal,
            }
            .publish(&e);
        }
        Ok(())
    }

    /// Push up to `max_count` (clamped to 10) holder payments for one
    /// (period, class). PERMISSIONLESS - it can only pay what is owed.
    /// Resumable: the cursor persists; re-running continues where it
    /// stopped, and per-holder markers make double-pay impossible.
    /// Returns the new cursor.
    pub fn push_batch(
        e: Env,
        period: u32,
        class: u32,
        max_count: u32,
    ) -> Result<u32, AgentError> {
        let config = Self::config(&e);
        if class >= config.note_tokens.len() {
            return Err(AgentError::BadClass);
        }
        let key = DataKey::Alloc(period, class);
        let mut state: AllocState =
            e.storage().persistent().get(&key).ok_or(AgentError::UnknownPeriod)?;
        if state.done {
            return Err(AgentError::BatchComplete);
        }
        let note_token = NoteTokenClient::new(&e, &config.note_tokens.get(class).unwrap());
        let holders = note_token.holders();
        let total_weight = note_token.total_weight(&period);
        let total_supply = note_token.total_supply();
        let asset = token::Client::new(&e, &config.asset);
        let this = e.current_contract_address();

        let batch = max_count.min(MAX_BATCH).max(1);
        let end = (state.cursor + batch).min(state.holder_count);
        for index in state.cursor..end {
            let holder = holders.get(index).unwrap();
            let done_key = DataKey::HolderDone(period, class, holder.clone());
            if e.storage().temporary().has(&done_key) {
                continue;
            }
            // Interest: day-weighted share of the pot. Zero-length periods
            // (total weight 0) fall back to the end-of-period balance split.
            let interest = if state.interest_pot > 0 {
                if total_weight > 0 {
                    let weight = note_token.weight_of(&period, &holder);
                    state.interest_pot * weight / total_weight
                } else if total_supply > 0 {
                    let balance = note_token.balance_at_end(&period, &holder);
                    state.interest_pot * balance / total_supply
                } else {
                    0
                }
            } else {
                0
            };
            // Principal: exact per-note amount to the holder of record.
            let principal = if state.per_note_principal > 0 {
                state.per_note_principal * note_token.balance_at_end(&period, &holder)
            } else {
                0
            };
            state.allocated_interest += interest;
            let amount = interest + principal;
            if amount > 0 {
                match asset.try_transfer(&this, &holder, &amount) {
                    Ok(Ok(())) => {
                        Self::credit_totals(&e, class, &holder, interest, principal);
                        HolderPaid { holder: holder.clone(), period, class, interest, principal }
                            .publish(&e);
                    }
                    _ => {
                        let claim_key = DataKey::Claimable(class, holder.clone());
                        let mut claimable: Claimable = e
                            .storage()
                            .persistent()
                            .get(&claim_key)
                            .unwrap_or(Claimable { interest: 0, principal: 0 });
                        claimable.interest += interest;
                        claimable.principal += principal;
                        e.storage().persistent().set(&claim_key, &claimable);
                        bump_persistent(&e, &claim_key);
                        PushFailed { holder: holder.clone(), period, class, amount }.publish(&e);
                    }
                }
            }
            e.storage().temporary().set(&done_key, &true);
        }
        state.cursor = end;
        if state.cursor >= state.holder_count {
            state.done = true;
            // Whatever the floor'd pro-rata split left over becomes next
            // period's interest dust for this class.
            let leftover = state.interest_pot - state.allocated_interest;
            if leftover > 0 {
                let dust_key = DataKey::Dust(class);
                let dust: i128 = e.storage().persistent().get(&dust_key).unwrap_or(0);
                e.storage().persistent().set(&dust_key, &(dust + leftover));
                bump_persistent(&e, &dust_key);
            }
        }
        e.storage().persistent().set(&key, &state);
        bump_persistent(&e, &key);
        BatchDone { period, class, cursor: state.cursor, complete: state.done }.publish(&e);
        Ok(state.cursor)
    }

    /// Pull payments that could not be pushed (after fixing the trustline).
    pub fn claim(e: Env, holder: Address) -> Result<Claimable, AgentError> {
        holder.require_auth();
        let config = Self::config(&e);
        let mut total = Claimable { interest: 0, principal: 0 };
        for class in 0..config.note_tokens.len() {
            let key = DataKey::Claimable(class, holder.clone());
            if let Some(claimable) = e.storage().persistent().get::<DataKey, Claimable>(&key) {
                if claimable.interest > 0 || claimable.principal > 0 {
                    Self::credit_totals(&e, class, &holder, claimable.interest, claimable.principal);
                    total.interest += claimable.interest;
                    total.principal += claimable.principal;
                    e.storage()
                        .persistent()
                        .set(&key, &Claimable { interest: 0, principal: 0 });
                    Claimed {
                        holder: holder.clone(),
                        class,
                        interest: claimable.interest,
                        principal: claimable.principal,
                    }
                    .publish(&e);
                }
            }
        }
        let amount = total.interest + total.principal;
        if amount == 0 {
            return Err(AgentError::NothingToClaim);
        }
        token::Client::new(&e, &config.asset).transfer(
            &e.current_contract_address(),
            &holder,
            &amount,
        );
        Ok(total)
    }

    // --- Views --------------------------------------------------------------

    pub fn get_config(e: Env) -> AgentConfig {
        Self::config(&e)
    }

    pub fn get_claimable(e: Env, class: u32, holder: Address) -> Claimable {
        e.storage()
            .persistent()
            .get(&DataKey::Claimable(class, holder))
            .unwrap_or(Claimable { interest: 0, principal: 0 })
    }

    pub fn get_holder_totals(e: Env, class: u32, holder: Address) -> HolderTotals {
        e.storage()
            .persistent()
            .get(&DataKey::HolderTotals(class, holder))
            .unwrap_or(HolderTotals { interest_paid: 0, principal_paid: 0 })
    }

    pub fn get_alloc(e: Env, period: u32, class: u32) -> Option<AllocState> {
        e.storage().persistent().get(&DataKey::Alloc(period, class))
    }

    pub fn get_dust(e: Env, class: u32) -> i128 {
        e.storage().persistent().get(&DataKey::Dust(class)).unwrap_or(0)
    }

    // --- internals ----------------------------------------------------------

    fn config(e: &Env) -> AgentConfig {
        e.storage().instance().get(&DataKey::Config).unwrap()
    }

    fn credit_totals(e: &Env, class: u32, holder: &Address, interest: i128, principal: i128) {
        let key = DataKey::HolderTotals(class, holder.clone());
        let mut totals: HolderTotals = e
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(HolderTotals { interest_paid: 0, principal_paid: 0 });
        totals.interest_paid += interest;
        totals.principal_paid += principal;
        e.storage().persistent().set(&key, &totals);
        bump_persistent(e, &key);
    }
}

#[cfg(test)]
mod test;
