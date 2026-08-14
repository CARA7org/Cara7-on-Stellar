//! RateOracle - the Data Spec Book's EURIBOR feed on Soroban.
//!
//! Chainlink has no native Stellar/Soroban integration (Data Feeds, Functions
//! and CCIP target EVM chains), so the reference architecture is a RELAY: an
//! off-chain job obtains the EURIBOR 1M fixing (Chainlink Function in
//! production, an EMMI mirror for the POC), signs it with the authorized
//! reporter key and pushes it here. The interface mirrors the Reflector
//! (SEP-40) pattern already used by the tranche vaults
//! (`strategy-vault/src/oracle.rs`): `lastprice`/`prices` plus the same two
//! on-chain safety checks - staleness and deviation - applied at WRITE time
//! (consumers re-check staleness at read time with their own budget).
//!
//! Rate unit: signed thousandths of a percent (0.001% = 1 unit), so the
//! 31 Jul 2026 fixing of 2.209% is stored as `2209` and a negative-rate
//! regime (EURIBOR was below zero for years) is representable. Any floor
//! (e.g. the Class A 0% floor of the prospectus) is applied by the CONSUMER,
//! never here - the oracle reports the market, the waterfall applies terms.

#![no_std]

use soroban_sdk::{contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, Vec};

/// 1.0 (100%) in rate units: value = percent * 1_000.
pub const RATE_SCALE: i128 = 100_000;

/// Sanity bound: |rate| above 20% is rejected as a relay error.
const MAX_ABS_RATE: i128 = 20_000;

/// How many past fixings are kept for the deviation reference.
const HISTORY_CAP: u32 = 12;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum RateOracleError {
    FixingInFuture = 1,
    FixingTooOld = 2,
    Deviation = 3,
    RateOutOfRange = 4,
    NoFixing = 5,
}

/// One fixing: rate in 0.001% units, publication timestamp (unix seconds).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Reporter,
    MaxStaleness,    // u64 seconds - freshness required of an incoming fixing
    MaxDeviationBps, // u32 - allowed drift vs the mean of recent fixings
    History,         // Vec<PriceData>, most recent last
}

/// `rate_set` - topics `[rate_set]`, data `[price, timestamp]`.
#[contractevent(data_format = "vec")]
pub struct RateSet {
    pub price: i128,
    pub timestamp: u64,
}

#[contract]
pub struct RateOracle;

#[contractimpl]
impl RateOracle {
    pub fn __constructor(
        e: Env,
        admin: Address,
        reporter: Address,
        max_staleness_secs: u64,
        max_deviation_bps: u32,
    ) {
        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(&DataKey::Reporter, &reporter);
        e.storage().instance().set(&DataKey::MaxStaleness, &max_staleness_secs);
        e.storage().instance().set(&DataKey::MaxDeviationBps, &max_deviation_bps);
        e.storage()
            .instance()
            .set(&DataKey::History, &Vec::<PriceData>::new(&e));
    }

    /// Push a fixing (reporter only). Rejects future-dated or stale fixings
    /// and values deviating too far from the recent mean - the same circuit
    /// breakers as the Reflector integration, protecting the waterfall from
    /// a broken relay.
    pub fn set_rate(e: Env, price: i128, timestamp: u64) -> Result<(), RateOracleError> {
        let reporter: Address = e.storage().instance().get(&DataKey::Reporter).unwrap();
        reporter.require_auth();

        if price.checked_abs().unwrap_or(i128::MAX) > MAX_ABS_RATE {
            return Err(RateOracleError::RateOutOfRange);
        }
        let now = e.ledger().timestamp();
        // 5 min of clock skew tolerated between relay and ledger.
        if timestamp > now + 300 {
            return Err(RateOracleError::FixingInFuture);
        }
        let max_staleness: u64 = e.storage().instance().get(&DataKey::MaxStaleness).unwrap();
        if now.saturating_sub(timestamp) > max_staleness {
            return Err(RateOracleError::FixingTooOld);
        }

        let mut history: Vec<PriceData> =
            e.storage().instance().get(&DataKey::History).unwrap();
        Self::check_deviation(&e, &history, price)?;

        if history.len() >= HISTORY_CAP {
            history.remove(0);
        }
        history.push_back(PriceData { price, timestamp });
        e.storage().instance().set(&DataKey::History, &history);

        RateSet { price, timestamp }.publish(&e);
        Ok(())
    }

    /// Latest fixing, SEP-40 style. None until the first push.
    pub fn lastprice(e: Env) -> Option<PriceData> {
        let history: Vec<PriceData> = e.storage().instance().get(&DataKey::History)?;
        history.last()
    }

    /// Up to `records` most recent fixings, most recent last.
    pub fn prices(e: Env, records: u32) -> Option<Vec<PriceData>> {
        let history: Vec<PriceData> = e.storage().instance().get(&DataKey::History)?;
        let len = history.len();
        if len == 0 {
            return None;
        }
        let take = records.min(len);
        let mut out: Vec<PriceData> = Vec::new(&e);
        for index in (len - take)..len {
            out.push_back(history.get(index).unwrap());
        }
        Some(out)
    }

    pub fn set_reporter(e: Env, reporter: Address) {
        let admin: Address = e.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        e.storage().instance().set(&DataKey::Reporter, &reporter);
    }

    pub fn get_admin(e: Env) -> Address {
        e.storage().instance().get(&DataKey::Admin).unwrap()
    }

    pub fn get_reporter(e: Env) -> Address {
        e.storage().instance().get(&DataKey::Reporter).unwrap()
    }

    /// Deviation breaker vs the mean of stored fixings; skipped while the
    /// history is empty (bootstrap) - staleness still applies.
    fn check_deviation(
        e: &Env,
        history: &Vec<PriceData>,
        price: i128,
    ) -> Result<(), RateOracleError> {
        let n = history.len();
        if n == 0 {
            return Ok(());
        }
        let mut sum: i128 = 0;
        for fixing in history.iter() {
            sum = sum.saturating_add(fixing.price);
        }
        let mean = sum / n as i128;
        // Deviation measured against RATE_SCALE (absolute rate points), not
        // relatively: EURIBOR near zero would make a relative check explode.
        let max_deviation_bps: u32 =
            e.storage().instance().get(&DataKey::MaxDeviationBps).unwrap();
        // 1 bps = 0.01% = 10 rate units.
        let allowed = (max_deviation_bps as i128).saturating_mul(10);
        if (price - mean).checked_abs().unwrap_or(i128::MAX) > allowed {
            return Err(RateOracleError::Deviation);
        }
        Ok(())
    }
}

#[cfg(test)]
mod test;
