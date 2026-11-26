#![cfg(test)]
//! Test vectors of the rank engine, shared with the TypeScript copy of the
//! engine in `apps/spv-backend`.
//!
//! A vector is one deal and its payment dates: the configuration (XDR), the
//! ledgers before and after each date, the inputs, the events of the deal
//! (XDR and a readable copy), the rank lines and the settlement. The files
//! are in `contracts/abs-deal/vectors/`.
//!
//! - `vectors_match_the_committed_files` builds each vector again and
//!   compares it with its file. It only reads.
//! - `vectors_write` writes the files. It is ignored in a normal test run:
//!   `cargo test -p abs-deal vectors_write -- --ignored`.
//!
//! The TypeScript tests read the same files: the decoder and the encoder of
//! the configuration, the readers of the events, and the copy of the engine
//! must give these figures.

extern crate std;

use crate::fixture::*;
use crate::reference::{reference_enforced, reference_normal};
use crate::test_d1::{off, on, pct_deal, ranks, switch_deal, trigger, two_fee_deal, ALL, PARI, SEQ};
use crate::test_settle::largest;
use crate::*;
use serde_json::{json, Map, Value};
use soroban_sdk::testutils::Events as _;
use soroban_sdk::xdr::{ContractEventBody, Limits, ScAddress, ScVal, ToXdr, WriteXdr};
use soroban_sdk::{Address, Env, TryFromVal, Val};
use std::string::{String as Text, ToString};
use std::vec::Vec as List;
use Item::{Fee, Interest, Principal, ReserveRefill, Residual};

/// One unit of an asset with 7 decimals, and one cent.
const UNIT: i128 = 10_000_000;
const CENT: i128 = UNIT / 100;

/// One step of the life of a deal.
enum Step {
    /// A payment date with these collections.
    Run(i128),
    /// The admin declares the enforcement.
    Enforce,
    /// A new fixing of the oracle.
    Fixing(i128),
    /// A direct transfer of the asset to the deal.
    Surplus(i128),
    /// The issuer of the asset freezes the recipient of the first fee line.
    FreezeFees,
}

struct Case {
    name: &'static str,
    about: &'static str,
    make: fn() -> Fixture,
    steps: &'static [Step],
}

/// Deal S of the testnet runs: the reference order, 4 classes, notes of 10
/// units, rounding to the cent, 90-day periods.
fn deal_s() -> Fixture {
    build(|e, config, _| {
        config.note_denomination = 10 * UNIT;
        config.round_unit = CENT;
        config.days_in_period = 90;
        let class = |rate: RateSpec, notes: i128, floor: Option<i128>| ClassTerms {
            rate,
            total_notes: notes,
            floor,
            index_floor: None,
        };
        config.classes = soroban_sdk::vec![
            e,
            class(RateSpec::Floating(600), 4, Some(0)),
            class(RateSpec::Fixed(1_500), 3, None),
            class(RateSpec::Fixed(2_500), 2, None),
            class(RateSpec::Fixed(4_000), 1, None),
        ];
        let line = config.fees.get(0).unwrap();
        config.fees = soroban_sdk::vec![e, FeeLine { amount: FeeAmount::Fixed(10 * CENT), ..line }];
        config.reserve.required = RequiredRule::Fixed(5 * UNIT);
        config.normal = reference_normal(e, 4);
        config.enforced = reference_enforced(e, 4);
    })
}

/// Deal P of the testnet runs: pro rata principal that turns sequential
/// below 50% of the notes, an on-need reserve of 5% of the notes, two fee
/// lines, an index floor, 3 classes of notes of 100 units, 30-day periods.
fn deal_p() -> Fixture {
    build(|e, config, parties| {
        config.note_denomination = 100 * UNIT;
        config.round_unit = CENT;
        config.days_in_period = 30;
        config.classes = soroban_sdk::vec![
            e,
            ClassTerms { rate: RateSpec::Floating(700), total_notes: 6, floor: None, index_floor: Some(0) },
            ClassTerms { rate: RateSpec::Fixed(2_000), total_notes: 3, floor: None, index_floor: None },
            ClassTerms { rate: RateSpec::Fixed(5_000), total_notes: 1, floor: None, index_floor: None },
        ];
        config.fees = soroban_sdk::vec![
            e,
            FeeLine { recipient: parties.fees.clone(), amount: FeeAmount::Fixed(UNIT) },
            FeeLine { recipient: parties.fees_2.clone(), amount: FeeAmount::PerAnnum(1_000) },
        ];
        config.reserve = ReserveTerms {
            required: RequiredRule::PctOfNotes(5_000, 20 * UNIT),
            release: Release::OnNeed,
            draw_ranks: soroban_sdk::vec![e, sym(e, "fees"), sym(e, "int_a"), sym(e, "int_b")],
        };
        config.triggers = soroban_sdk::vec![e, trigger(e, "seq", Metric::NotesFactor, Op::Lt, FACTOR_SCALE / 2, true)];
        config.normal = ranks(
            e,
            &[
                ("fees", Cond::Always, SEQ, &[Fee(0), Fee(1)]),
                ("int_a", Cond::Always, SEQ, &[Interest(0)]),
                ("int_b", Cond::Always, SEQ, &[Interest(1)]),
                ("reserve", Cond::Always, SEQ, &[ReserveRefill]),
                ("int_c", Cond::Always, SEQ, &[Interest(2)]),
                ("prin_pr", off(e, "seq"), PARI, &ALL),
                ("prin_seq", on(e, "seq"), SEQ, &ALL),
                ("residual", Cond::Always, SEQ, &[Residual]),
            ],
        );
        config.enforced = ranks(
            e,
            &[
                ("fees", Cond::Always, SEQ, &[Fee(0), Fee(1)]),
                ("acc_a", Cond::Always, SEQ, &[Interest(0), Principal(0)]),
                ("acc_b", Cond::Always, SEQ, &[Interest(1), Principal(1)]),
                ("acc_c", Cond::Always, SEQ, &[Interest(2), Principal(2)]),
                ("residual", Cond::Always, SEQ, &[Residual]),
            ],
        );
    })
}

fn cases() -> List<Case> {
    std::vec![
        Case {
            name: "reference",
            about: "The reference order: fees, interest A/B/C, reserve, sequential principal, residual.",
            make: || build(|_, _, _| {}),
            steps: &[Step::Run(100_000), Step::Run(0), Step::Run(25_000), Step::Run(0), Step::Fixing(-1_000), Step::Run(40_000)],
        },
        Case {
            name: "reference-enforced",
            about: "The reference order, then the enforced order to the maturity.",
            make: || build(|_, _, _| {}),
            steps: &[Step::Run(30_000), Step::Enforce, Step::Run(5_000), Step::Run(0), Step::Run(1_200_000), Step::Run(1_200_000)],
        },
        Case {
            name: "pro-rata-then-sequential",
            about: "Pro rata principal that turns sequential when the reserve is short (latched trigger).",
            make: || switch_deal(true),
            steps: &[Step::Run(40_000), Step::Run(0), Step::Run(0), Step::Run(100_000), Step::Run(50_000)],
        },
        Case {
            name: "percent-reserve-on-need",
            about: "A reserve of 1% of the notes with a floor, drawn on need, to the maturity.",
            make: pct_deal,
            steps: &[Step::Run(500_000), Step::Run(0), Step::Run(1_000_000), Step::Run(0), Step::Run(700_000)],
        },
        Case {
            name: "two-fee-lines",
            about: "A senior fee and a subordinated fee, with periods that are short of cash.",
            make: || two_fee_deal(false),
            steps: &[Step::Run(0), Step::Run(0), Step::Run(50_000)],
        },
        Case {
            name: "maturity-with-a-surplus",
            about: "A direct transfer to the deal: the maturity sweep pays the surplus to the Seller.",
            make: || build(|_, _, _| {}),
            steps: &[Step::Surplus(7), Step::Run(50 + 3_485 + FACE + 123)],
        },
        Case {
            name: "parked-fee",
            about: "The issuer froze the fees recipient: its fee is parked, the noteholders are paid.",
            make: || build_with(true, |_, _, _| {}),
            steps: &[Step::FreezeFees, Step::Run(100_000), Step::Run(0)],
        },
        Case {
            name: "largest-structure",
            about: "8 classes, 4 fee lines, 4 triggers, 24 ranks: pari passu interest and principal.",
            make: || build(largest),
            steps: &[Step::Run(20_000), Step::Run(0), Step::Run(30_000), Step::Run(200_000)],
        },
        Case {
            name: "deal-s",
            about: "The terms of testnet deal S: reference order, 4 classes, notes of 10, 90 days.",
            make: deal_s,
            steps: &[Step::Run(35 * UNIT), Step::Run(70 * UNIT)],
        },
        Case {
            name: "deal-p",
            about: "The terms of testnet deal P: pro rata then sequential below 50% of the notes.",
            make: deal_p,
            steps: &[Step::Run(305 * UNIT), Step::Run(305 * UNIT), Step::Run(105 * UNIT), Step::Run(400 * UNIT)],
        },
    ]
}

// --- JSON -------------------------------------------------------------------

fn hex(bytes: &[u8]) -> Text {
    let mut text = Text::new();
    for byte in bytes {
        text.push_str(&std::format!("{byte:02x}"));
    }
    text
}

fn amount(value: i128) -> Value {
    Value::String(value.to_string())
}

fn strkey(address: &Address) -> Text {
    let text = address.to_string();
    let mut buffer = [0u8; 56];
    text.copy_into_slice(&mut buffer);
    Text::from_utf8(buffer.to_vec()).unwrap()
}

/// A readable copy of a contract value: an amount is a decimal string, a
/// symbol is a string, an address is its strkey, a list is a list.
fn readable(e: &Env, value: &ScVal) -> Value {
    match value {
        ScVal::Bool(flag) => json!(flag),
        ScVal::Void => Value::Null,
        ScVal::U32(number) => json!(number),
        ScVal::U64(number) => json!(number.to_string()),
        ScVal::I128(parts) => amount(((parts.hi as i128) << 64) | parts.lo as i128),
        ScVal::Symbol(symbol) => json!(symbol.0.to_utf8_string_lossy()),
        ScVal::Vec(Some(list)) => Value::Array(list.iter().map(|item| readable(e, item)).collect()),
        ScVal::Address(_) => {
            let address = Address::try_from_val(e, &Val::try_from_val(e, value).unwrap()).unwrap();
            json!(strkey(&address))
        }
        other => panic!("no readable form for {other:?}"),
    }
}

fn amounts(values: impl Iterator<Item = i128>) -> Value {
    Value::Array(values.map(amount).collect())
}

/// The ledgers of the deal.
fn ledgers(fx: &Fixture) -> Value {
    let state = match fx.deal.get_state() {
        State::Funding => "Funding",
        State::Amortizing => "Amortizing",
        State::Enforced => "Enforced",
        State::Matured => "Matured",
        State::Aborted => "Aborted",
    };
    json!({
        "state": state,
        "reserve": amount(fx.deal.get_reserve()),
        "carry": amount(fx.deal.get_carry()),
        "owed": amount(fx.deal.get_owed_total()),
        "balance": amount(fx.balance(&fx.deal.address)),
        "per_note": amounts(fx.per_note().into_iter()),
        "shortfall": amounts(fx.shortfalls().into_iter()),
        "triggers": Value::Array(fx.deal.get_triggers().iter().map(|flag| json!(flag)).collect()),
    })
}

const SETTLED_FIELDS: [&str; 10] = [
    "collections", "reserve_in", "carry_in", "drawn", "paid_out", "reserve", "carry", "owed", "balance", "surplus",
];

/// One payment date: the inputs, the events of the deal, the result.
fn payment_date(fx: &Fixture, period: u32, collections: i128) -> Value {
    let e = &fx.e;
    let opening = ledgers(fx);
    let fixing = fx.oracle.lastprice().map(|fixing| amount(fixing.price)).unwrap_or(Value::Null);
    if collections > 0 {
        fx.sac.mint(&fx.servicer, &collections);
    }
    let returned = fx.deal.distribute(&period, &collections);

    // The events of the deal, in their order. Read them before any other call.
    let mut events: List<Value> = List::new();
    let mut lines = Value::Null;
    let mut enforced = Value::Null;
    let mut settled = Value::Null;
    let mut breached: List<Value> = List::new();
    let mut parked: List<Value> = List::new();
    for event in e.events().all().filter_by_contract(&fx.deal.address).events() {
        let ContractEventBody::V0(body) = &event.body;
        let topics: List<Value> = body.topics.iter().map(|topic| readable(e, topic)).collect();
        let data = readable(e, &body.data);
        match topics[0].as_str().unwrap() {
            "rank_lines" => {
                enforced = data[0].clone();
                lines = data[1].clone();
            }
            "period_settled" => {
                let mut fields = Map::new();
                for (index, name) in SETTLED_FIELDS.iter().enumerate() {
                    fields.insert(name.to_string(), data[index].clone());
                }
                settled = Value::Object(fields);
            }
            "trigger_breached" => breached.push(topics[1].clone()),
            "payout_parked" => parked.push(topics[1].clone()),
            _ => {}
        }
        events.push(json!({
            "topics": topics,
            "data": data,
            "xdr": hex(&event.to_xdr(Limits::none()).unwrap()),
        }));
    }
    json!({
        "period": period,
        "collections": amount(collections),
        "fixing": fixing,
        "opening": opening,
        // The recipients whose payout failed: an input of the TypeScript copy.
        "parked": parked,
        "returned": amounts(returned.iter()),
        "enforced": enforced,
        "lines": lines,
        "settled": settled,
        "breached": breached,
        "closing": ledgers(fx),
        "events": events,
    })
}

fn build_vector(case: &Case) -> Text {
    let fx = (case.make)();
    fx.close();
    let e = &fx.e;
    let config = fx.deal.get_config();
    let mut periods: List<Value> = List::new();
    let mut period = 0u32;
    for step in case.steps {
        match step {
            Step::Run(collections) => {
                period += 1;
                periods.push(payment_date(&fx, period, *collections));
            }
            Step::Enforce => {
                fx.deal.set_enforced();
            }
            Step::Fixing(price) => fx.oracle.set(price, &T0),
            Step::Surplus(units) => fx.sac.mint(&fx.deal.address, units),
            Step::FreezeFees => fx.sac.set_authorized(&fx.fees, &false),
        }
    }
    let contract = |address: &Address| json!(strkey(address));
    let config_bytes: List<u8> = config.clone().to_xdr(e).iter().collect();
    let vector = json!({
        "name": case.name,
        "about": case.about,
        "contracts": {
            "deal": contract(&fx.deal.address),
            "paying_agent": contract(&fx.agent.address),
            "asset": contract(&fx.asset.address),
            "oracle": readable(e, &ScVal::Address(ScAddress::try_from(&config.oracle).unwrap())),
        },
        "config_xdr": hex(&config_bytes),
        "periods": periods,
    });
    let mut text = serde_json::to_string_pretty(&vector).unwrap();
    text.push('\n');
    text
}

fn vector_file(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("vectors").join(std::format!("{name}.json"))
}

#[test]
fn vectors_match_the_committed_files() {
    for case in cases() {
        let file = vector_file(case.name);
        let committed = std::fs::read_to_string(&file)
            .unwrap_or_else(|_| panic!("{} is missing. Run: cargo test -p abs-deal vectors_write -- --ignored", file.display()));
        assert!(
            build_vector(&case) == committed,
            "the vector {} differs from its file. If the change is intended, run: cargo test -p abs-deal vectors_write -- --ignored",
            case.name
        );
    }
}

#[test]
#[ignore = "writes the vector files"]
fn vectors_write() {
    std::fs::create_dir_all(vector_file("x").parent().unwrap()).unwrap();
    for case in cases() {
        std::fs::write(vector_file(case.name), build_vector(&case)).unwrap();
    }
}

#[test]
fn the_vector_deals_run_as_their_names_say() {
    // Deal S: sequential. Period 1 pays principal to Class A only, and
    // period 2 brings the deal to its maturity.
    let s = deal_s();
    s.close();
    let first = s.run(1, 35 * UNIT);
    let principal: List<_> = first.lines.iter().filter(|line| matches!(line.1, Principal(_)) && line.3 > 0).collect();
    assert_eq!(principal.len(), 1);
    assert_eq!(principal[0].1, Principal(0));
    s.run(2, 70 * UNIT);
    assert_eq!(s.deal.get_state(), State::Matured);

    // Deal P: pro rata. Periods 1 and 2 pay the same principal for each
    // note of the 3 classes. Period 3 opens below 50% of the notes: the
    // trigger is set and principal goes to Class A only.
    let p = deal_p();
    p.close();
    assert_eq!(p.deal.get_reserve(), 50 * UNIT);
    for period in 1..=2u32 {
        let run = p.run(period, 305 * UNIT);
        assert!(run.breached.is_empty());
        let per_note = p.per_note();
        assert!(per_note[0] == per_note[1] && per_note[1] == per_note[2], "period {period}: {per_note:?}");
    }
    assert!(p.per_note()[0] * 2 < 100 * UNIT);
    let before = p.per_note();
    let third = p.run(3, 105 * UNIT);
    assert_eq!(third.breached, std::vec![sym(&p.e, "seq")]);
    let after = p.per_note();
    assert!(after[0] < before[0]);
    assert_eq!(after[1..], before[1..]);
}
