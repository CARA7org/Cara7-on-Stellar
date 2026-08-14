#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, Env};

fn setup(max_staleness: u64, max_deviation_bps: u32) -> (Env, RateOracleClient<'static>, Address) {
    let e = Env::default();
    e.ledger().with_mut(|ledger| ledger.timestamp = 1_800_000_000);
    let admin = Address::generate(&e);
    let reporter = Address::generate(&e);
    let contract_id = e.register(
        RateOracle,
        (admin, reporter.clone(), max_staleness, max_deviation_bps),
    );
    (e.clone(), RateOracleClient::new(&e, &contract_id), reporter)
}

#[test]
fn set_and_read_fixing() {
    let (e, client, _) = setup(86_400, 50);
    e.mock_all_auths();

    // 2.209% on 2026-07-31 style fixing.
    client.set_rate(&2209, &(1_800_000_000 - 3_600));
    let last = client.lastprice().unwrap();
    assert_eq!(last.price, 2209);
    assert_eq!(last.timestamp, 1_800_000_000 - 3_600);
}

#[test]
fn negative_rates_are_representable() {
    let (e, client, _) = setup(86_400, 500);
    e.mock_all_auths();
    client.set_rate(&-570, &1_800_000_000); // -0.570%, 2020-style EURIBOR
    assert_eq!(client.lastprice().unwrap().price, -570);
}

#[test]
fn rejects_stale_and_future_fixings() {
    let (e, client, _) = setup(3_600, 50);
    e.mock_all_auths();

    let too_old = client.try_set_rate(&2209, &(1_800_000_000 - 7_200));
    assert!(too_old.is_err());
    let in_future = client.try_set_rate(&2209, &(1_800_000_000 + 1_000));
    assert!(in_future.is_err());
}

#[test]
fn rejects_deviation_from_recent_mean() {
    let (e, client, _) = setup(86_400, 50); // 50 bps = 0.50% allowed drift
    e.mock_all_auths();

    client.set_rate(&2209, &1_800_000_000);
    client.set_rate(&2215, &1_800_000_000); // small drift: fine
    // 3.00% vs ~2.21% mean = ~0.79% jump > 0.50% allowed.
    let jump = client.try_set_rate(&3000, &1_800_000_000);
    assert!(jump.is_err());
}

#[test]
fn history_is_returned_most_recent_last() {
    let (e, client, _) = setup(86_400, 5_000);
    e.mock_all_auths();
    client.set_rate(&2200, &1_800_000_000);
    client.set_rate(&2210, &1_800_000_000);
    client.set_rate(&2220, &1_800_000_000);

    let prices = client.prices(&2).unwrap();
    assert_eq!(prices.len(), 2);
    assert_eq!(prices.get(0).unwrap().price, 2210);
    assert_eq!(prices.get(1).unwrap().price, 2220);
}

#[test]
fn set_rate_requires_reporter_auth() {
    let (_e, client, _) = setup(86_400, 50);
    // No auth mocked: require_auth must abort.
    let result = client.try_set_rate(&2209, &1_800_000_000);
    assert!(result.is_err());
}

#[test]
fn rejects_absurd_rates() {
    let (e, client, _) = setup(86_400, 50);
    e.mock_all_auths();
    let absurd = client.try_set_rate(&25_000, &1_800_000_000); // 25%
    assert!(absurd.is_err());
}
