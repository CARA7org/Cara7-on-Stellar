#![cfg(test)]
//! The reference configuration, for the tests.
//!
//! It is the priority of payments of the reference deal (Bavarian Sky French
//! Auto Leases 5, compressed), for any class count:
//!
//! - normal order: `fees`, one interest rank for each class (`int_a`,
//!   `int_b`, ...), `reserve` (the re-fund), `principal` (sequential, senior
//!   first), `residual`;
//! - enforced order: `fees`, one rank for each class with its interest then
//!   its principal (`acc_a`, `acc_b`, ...), `residual`;
//! - one fixed fee line, a fixed reserve released in full, no trigger, and a
//!   floor of 0 on the all-in rate of a floating class.

use crate::types::{
    ClassTerms, Cond, DealConfig, FeeAmount, FeeLine, Item, Rank, RankAlloc, RateSpec, Release,
    RequiredRule, ReserveTerms,
};
use soroban_sdk::{vec, Address, Env, Symbol, Vec};

const LETTERS: [&str; 8] = ["a", "b", "c", "d", "e", "f", "g", "h"];

/// The terms of a reference deal.
pub struct Reference<'a> {
    pub admin: &'a Address,
    pub asset: &'a Address,
    pub oracle: &'a Address,
    pub seller: &'a Address,
    pub servicer: &'a Address,
    pub fees_recipient: &'a Address,
    pub fees_per_period: i128,
    pub required_reserve: i128,
    pub days_in_period: u32,
    pub oracle_max_staleness_secs: u64,
    pub note_denomination: i128,
    pub round_unit: i128,
    /// The rate and the note count of each class, senior first.
    pub classes: &'a [(RateSpec, i128)],
}

/// The id of a rank of one class: `int_a`, `acc_b`, ...
pub fn class_rank(e: &Env, prefix: &str, class: usize) -> Symbol {
    let mut bytes = [0u8; 8];
    let prefix = prefix.as_bytes();
    let letter = LETTERS[class].as_bytes();
    bytes[..prefix.len()].copy_from_slice(prefix);
    bytes[prefix.len()] = b'_';
    bytes[prefix.len() + 1] = letter[0];
    Symbol::new(e, core::str::from_utf8(&bytes[..prefix.len() + 2]).unwrap())
}

/// A rank that always runs, with a sequential split.
pub fn rank(e: &Env, id: &str, items: Vec<Item>) -> Rank {
    Rank { id: Symbol::new(e, id), when: Cond::Always, alloc: RankAlloc::Sequential, items }
}

/// The classes with the floors of the reference deal.
pub fn reference_classes(e: &Env, classes: &[(RateSpec, i128)]) -> Vec<ClassTerms> {
    let mut terms: Vec<ClassTerms> = Vec::new(e);
    for (rate, notes) in classes.iter() {
        let floor = match rate {
            RateSpec::Floating(_) => Some(0),
            RateSpec::Fixed(_) => None,
        };
        terms.push_back(ClassTerms { rate: rate.clone(), total_notes: *notes, floor, index_floor: None });
    }
    terms
}

/// The normal order of the reference deal for `count` classes.
pub fn reference_normal(e: &Env, count: usize) -> Vec<Rank> {
    let mut order: Vec<Rank> = Vec::new(e);
    order.push_back(rank(e, "fees", vec![e, Item::Fee(0)]));
    let mut principal: Vec<Item> = Vec::new(e);
    for class in 0..count {
        let id = class_rank(e, "int", class);
        order.push_back(Rank {
            id,
            when: Cond::Always,
            alloc: RankAlloc::Sequential,
            items: vec![e, Item::Interest(class as u32)],
        });
        principal.push_back(Item::Principal(class as u32));
    }
    order.push_back(rank(e, "reserve", vec![e, Item::ReserveRefill]));
    order.push_back(rank(e, "principal", principal));
    order.push_back(rank(e, "residual", vec![e, Item::Residual]));
    order
}

/// The enforced order of the reference deal for `count` classes.
pub fn reference_enforced(e: &Env, count: usize) -> Vec<Rank> {
    let mut order: Vec<Rank> = Vec::new(e);
    order.push_back(rank(e, "fees", vec![e, Item::Fee(0)]));
    for class in 0..count {
        order.push_back(Rank {
            id: class_rank(e, "acc", class),
            when: Cond::Always,
            alloc: RankAlloc::Sequential,
            items: vec![e, Item::Interest(class as u32), Item::Principal(class as u32)],
        });
    }
    order.push_back(rank(e, "residual", vec![e, Item::Residual]));
    order
}

/// The configuration of a reference deal.
pub fn reference_config(e: &Env, terms: Reference) -> DealConfig {
    let count = terms.classes.len();
    DealConfig {
        admin: terms.admin.clone(),
        asset: terms.asset.clone(),
        oracle: terms.oracle.clone(),
        seller: terms.seller.clone(),
        servicer: terms.servicer.clone(),
        days_in_period: terms.days_in_period,
        oracle_max_staleness_secs: terms.oracle_max_staleness_secs,
        note_denomination: terms.note_denomination,
        round_unit: terms.round_unit,
        classes: reference_classes(e, terms.classes),
        fees: vec![
            e,
            FeeLine {
                recipient: terms.fees_recipient.clone(),
                amount: FeeAmount::Fixed(terms.fees_per_period),
            },
        ],
        reserve: ReserveTerms {
            required: RequiredRule::Fixed(terms.required_reserve),
            release: Release::Full,
            draw_ranks: Vec::new(e),
        },
        triggers: Vec::new(e),
        // More than 8 classes: the orders name the first 8 only, and the
        // validation refuses the class count.
        normal: reference_normal(e, count.min(LETTERS.len())),
        enforced: reference_enforced(e, count.min(LETTERS.len())),
    }
}
