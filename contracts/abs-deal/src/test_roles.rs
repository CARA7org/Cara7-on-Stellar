#![cfg(test)]
//! Tests of the role separation.
//!
//! Three roles are separate, so that each one can have its own signing
//! policy:
//!
//! | Role | Contract | Operations |
//! |---|---|---|
//! | admin (the operator) | abs-deal | `set_wiring`, `set_eligible`, `abort`, `close`, `set_enforced`, `set_servicer` |
//! | servicer | abs-deal | `distribute` |
//! | reporter | rate-oracle | `set_rate` |
//!
//! The matrix test signs each operation with each role, one signer and one
//! call at a time. A role passes on its own operations, and the contract
//! refuses it on the operations of the two other roles.

extern crate std;

use crate::fixture::*;
use crate::*;
use core::cell::RefCell;
use paying_agent::PayingAgent;
use rate_oracle::{RateOracle, RateOracleClient as OracleClient};
use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
use soroban_sdk::{
    contract as mock_contract, contractimpl as mock_contractimpl, Address, Env, IntoVal,
    InvokeError, String, Val,
};

/// A deal on the real rate oracle, with its reporter and its oracle admin.
struct Roles {
    fx: Fixture,
    oracle: OracleClient<'static>,
    reporter: Address,
    oracle_admin: Address,
}

fn roles_deal() -> Roles {
    let created: RefCell<Option<(Address, Address, Address)>> = RefCell::new(None);
    let fx = build(|e, config, _| {
        let oracle_admin = Address::generate(e);
        let reporter = Address::generate(e);
        // Fixings of 7 days at most, 500 bps of deviation at most.
        let oracle = e.register(RateOracle, (oracle_admin.clone(), reporter.clone(), 7 * 86_400u64, 500u32));
        config.oracle = oracle.clone();
        *created.borrow_mut() = Some((oracle, reporter, oracle_admin));
    });
    let (oracle_id, reporter, oracle_admin) = created.into_inner().unwrap();
    let oracle = OracleClient::new(&fx.e, &oracle_id);
    oracle.set_rate(&2209, &T0);
    Roles { fx, oracle, reporter, oracle_admin }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Role {
    Admin,
    Servicer,
    Reporter,
    /// An address with no role.
    Stranger,
}

const ROLES: [Role; 4] = [Role::Admin, Role::Servicer, Role::Reporter, Role::Stranger];

#[derive(Clone, Copy, Debug, PartialEq)]
enum Operation {
    SetWiring,
    SetEligible,
    Abort,
    Close,
    SetEnforced,
    SetServicer,
    Distribute,
    SetRate,
}

const OPERATIONS: [Operation; 8] = [
    Operation::SetWiring,
    Operation::SetEligible,
    Operation::Abort,
    Operation::Close,
    Operation::SetEnforced,
    Operation::SetServicer,
    Operation::Distribute,
    Operation::SetRate,
];

/// The role that each operation belongs to.
fn owner(operation: Operation) -> Role {
    match operation {
        Operation::Distribute => Role::Servicer,
        Operation::SetRate => Role::Reporter,
        _ => Role::Admin,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Answer {
    Passed,
    /// The contract found no authorization of the role that it requires.
    Refused,
    /// Another error: the test itself is wrong.
    Failed,
}

macro_rules! answer {
    ($result:expr) => {
        match $result {
            Ok(Ok(_)) => Answer::Passed,
            Err(Err(InvokeError::Abort)) => Answer::Refused,
            _ => Answer::Failed,
        }
    };
}

/// Give the next call one authorization only: `signer`, for one call of
/// `fn_name` on `contract` with `args`.
fn sign_one_call(e: &Env, signer: &Address, contract: &Address, fn_name: &str, args: soroban_sdk::Vec<Val>) {
    e.mock_auths(&[MockAuth {
        address: signer,
        invoke: &MockAuthInvoke { contract, fn_name, args, sub_invokes: &[] },
    }]);
}

/// Sign `operation` with `role` on a new deal, in the state that the
/// operation needs.
fn attempt(operation: Operation, role: Role) -> Answer {
    let r = roles_deal();
    let fx = &r.fx;
    let e = &fx.e;
    let deal = &fx.deal.address;
    let signer = match role {
        Role::Admin => fx.admin.clone(),
        Role::Servicer => fx.servicer.clone(),
        Role::Reporter => r.reporter.clone(),
        Role::Stranger => Address::generate(e),
    };
    match operation {
        Operation::SetWiring => {
            // A second deal with the same roles, not wired yet.
            let other = e.register(AbsDeal, (fx.config.clone(),));
            let mut notes: Vec<Address> = Vec::new(e);
            for _ in fx.config.classes.iter() {
                notes.push_back(e.register(
                    note_token::NoteToken,
                    (other.clone(), String::from_str(e, "Note"), String::from_str(e, "NOTE"), DENOMINATION),
                ));
            }
            let agent = e.register(PayingAgent, (other.clone(), fx.asset.address.clone(), notes.clone()));
            sign_one_call(e, &signer, &other, "set_wiring", (notes.clone(), agent.clone()).into_val(e));
            answer!(AbsDealClient::new(e, &other).try_set_wiring(&notes, &agent))
        }
        Operation::SetEligible => {
            let holders = soroban_sdk::vec![e, Address::generate(e)];
            sign_one_call(e, &signer, deal, "set_eligible", (holders.clone(), true).into_val(e));
            answer!(fx.deal.try_set_eligible(&holders, &true))
        }
        Operation::Abort => {
            sign_one_call(e, &signer, deal, "abort", ().into_val(e));
            answer!(fx.deal.try_abort())
        }
        Operation::Close => {
            fx.subscribe_all();
            sign_one_call(e, &signer, deal, "close", ().into_val(e));
            answer!(fx.deal.try_close())
        }
        Operation::SetEnforced => {
            fx.close();
            sign_one_call(e, &signer, deal, "set_enforced", ().into_val(e));
            answer!(fx.deal.try_set_enforced())
        }
        Operation::SetServicer => {
            let next = Address::generate(e);
            sign_one_call(e, &signer, deal, "set_servicer", (next.clone(),).into_val(e));
            answer!(fx.deal.try_set_servicer(&next))
        }
        Operation::Distribute => {
            fx.close();
            // No collections: the payment date pulls no token of the signer.
            sign_one_call(e, &signer, deal, "distribute", (1u32, 0i128).into_val(e));
            answer!(fx.deal.try_distribute(&1, &0))
        }
        Operation::SetRate => {
            let oracle = &r.oracle.address;
            sign_one_call(e, &signer, oracle, "set_rate", (2_300i128, T0).into_val(e));
            answer!(r.oracle.try_set_rate(&2_300, &T0))
        }
    }
}

#[test]
fn each_role_passes_on_its_own_operations_and_is_refused_on_the_others() {
    for operation in OPERATIONS {
        for role in ROLES {
            let expected = if role == owner(operation) { Answer::Passed } else { Answer::Refused };
            assert_eq!(attempt(operation, role), expected, "{operation:?} signed by the {role:?}");
        }
    }
}

#[test]
fn the_roles_of_the_deal_cannot_replace_the_reporter_of_the_oracle() {
    // `set_reporter` belongs to the admin of the oracle, a fourth address.
    for role in ROLES {
        let r = roles_deal();
        let e = &r.fx.e;
        let signer = match role {
            Role::Admin => r.fx.admin.clone(),
            Role::Servicer => r.fx.servicer.clone(),
            Role::Reporter => r.reporter.clone(),
            Role::Stranger => Address::generate(e),
        };
        let next = Address::generate(e);
        sign_one_call(e, &signer, &r.oracle.address, "set_reporter", (next.clone(),).into_val(e));
        assert!(r.oracle.try_set_reporter(&next).is_err(), "set_reporter signed by the {role:?}");
        assert_eq!(r.oracle.get_reporter(), r.reporter);
    }
    let r = roles_deal();
    let e = &r.fx.e;
    let next = Address::generate(e);
    sign_one_call(e, &r.oracle_admin, &r.oracle.address, "set_reporter", (next.clone(),).into_val(e));
    r.oracle.set_reporter(&next);
    assert_eq!(r.oracle.get_reporter(), next);
}

#[test]
fn the_signature_of_one_role_is_not_valid_for_another_call() {
    // The admin signs `close`. The signature does not authorize `abort`.
    let r = roles_deal();
    let fx = &r.fx;
    fx.subscribe_all();
    sign_one_call(&fx.e, &fx.admin, &fx.deal.address, "close", ().into_val(&fx.e));
    assert_eq!(answer!(fx.deal.try_abort()), Answer::Refused);
    assert_eq!(fx.deal.get_state(), State::Funding);
}

#[test]
fn set_servicer_refuses_the_admin() {
    let fx = build(|_, _, _| {});
    assert_eq!(fx.deal.try_set_servicer(&fx.admin), Err(Ok(DealError::RoleConflict)));
    assert_eq!(fx.deal.get_config().servicer, fx.servicer);
    // Another address is accepted, and it is then the only servicer.
    let next = Address::generate(&fx.e);
    fx.deal.set_servicer(&next);
    assert_eq!(fx.deal.get_config().servicer, next);
}

#[test]
fn a_replaced_servicer_cannot_trigger_a_payment_date() {
    let r = roles_deal();
    let fx = &r.fx;
    let e = &fx.e;
    fx.close();
    let next = Address::generate(e);
    fx.deal.set_servicer(&next);
    sign_one_call(e, &fx.servicer, &fx.deal.address, "distribute", (1u32, 0i128).into_val(e));
    assert_eq!(answer!(fx.deal.try_distribute(&1, &0)), Answer::Refused);
    sign_one_call(e, &next, &fx.deal.address, "distribute", (1u32, 0i128).into_val(e));
    assert_eq!(answer!(fx.deal.try_distribute(&1, &0)), Answer::Passed);
}

#[test]
fn close_is_refused_when_the_reporter_is_the_admin_or_the_servicer() {
    for conflict in [Role::Admin, Role::Servicer] {
        let fx = build(|_, _, _| {});
        fx.subscribe_all();
        let reporter = if conflict == Role::Admin { fx.admin.clone() } else { fx.servicer.clone() };
        fx.oracle.set_reporter(&reporter);
        assert_eq!(fx.deal.try_close(), Err(Ok(DealError::RoleConflict)), "reporter = {conflict:?}");
        assert_eq!(fx.deal.get_state(), State::Funding);
        // A reporter with no role in the deal: the closing passes.
        fx.oracle.set_reporter(&Address::generate(&fx.e));
        fx.deal.close();
        assert_eq!(fx.deal.get_state(), State::Amortizing);
    }
}

#[test]
fn distribute_is_refused_when_the_reporter_becomes_the_admin_or_the_servicer() {
    for conflict in [Role::Admin, Role::Servicer] {
        let fx = build(|_, _, _| {});
        fx.close();
        fx.run(1, 10_000);
        // The admin of the oracle names a reporter that has a role in the deal.
        let reporter = if conflict == Role::Admin { fx.admin.clone() } else { fx.servicer.clone() };
        fx.oracle.set_reporter(&reporter);
        fx.sac.mint(&fx.servicer, &10_000);
        assert_eq!(fx.deal.try_distribute(&2, &10_000), Err(Ok(DealError::RoleConflict)), "reporter = {conflict:?}");
        assert_eq!(fx.deal.get_next_period(), 2);
        assert_eq!(fx.balance(&fx.servicer), 10_000);
        fx.oracle.set_reporter(&Address::generate(&fx.e));
        fx.deal.distribute(&2, &10_000);
        assert_eq!(fx.deal.get_next_period(), 3);
    }
}

/// An oracle that gives a fixing but does not name its reporter.
#[mock_contract]
pub struct SilentOracle;

#[mock_contractimpl]
impl SilentOracle {
    pub fn lastprice(_e: Env) -> Option<PriceData> {
        Some(PriceData { price: 2209, timestamp: T0 })
    }
}

#[test]
fn a_floating_deal_needs_an_oracle_that_names_its_reporter() {
    let fx = build(|e, config, _| config.oracle = e.register(SilentOracle, ()));
    fx.subscribe_all();
    assert_eq!(fx.deal.try_close(), Err(Ok(DealError::RoleConflict)));
}

#[test]
fn a_deal_with_fixed_rates_only_does_not_read_the_oracle() {
    // No contract is at the oracle address of this deal.
    let fx = build(|e, config, _| {
        let terms = config.classes.get(0).unwrap();
        config.classes.set(0, ClassTerms { rate: RateSpec::Fixed(2_809), floor: None, ..terms });
        config.oracle = Address::generate(e);
    });
    fx.close();
    let period = fx.run(1, 100_000);
    // The same interest as the floating Class A at 2.809%.
    assert_eq!(period.lines[1].2, INTEREST[0]);
    assert_eq!(fx.per_note(), [904, 1_000, 1_000]);
}
