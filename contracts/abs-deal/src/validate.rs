//! The checks of a deal configuration, made once at the construction.
//!
//! The rules give the engine three guarantees:
//!
//! - each fee line, each class interest, each class principal and the
//!   residual have exactly one line that runs in a period. An item is in one
//!   rank that always runs, or in two ranks with the conditions `Trigger(X)`
//!   and `NotTrigger(X)`. So no item is paid twice, and no item is skipped;
//! - the interest of a class ranks before its principal. A class that is
//!   repaid then has no unpaid interest, so the maturity sweep never pays the
//!   Seller before the noteholders;
//! - the reserve can cover a fee or an interest shortfall only, never
//!   principal.

use crate::engine::{trigger_index, CLASS_SLOTS, FEE_SLOTS};
use crate::types::{
    Cond, DealConfig, DealError, FeeAmount, Item, Metric, Rank, RankAlloc, Release,
    RequiredRule, MAX_CLASSES, MAX_FEES, MAX_ORDER_ITEMS, MAX_RANKS, MAX_RANK_ITEMS,
    MAX_TRIGGERS, RATE_SCALE,
};
use soroban_sdk::Vec;

const KEY_REFILL: usize = FEE_SLOTS + 2 * CLASS_SLOTS;
const KEY_RESIDUAL: usize = KEY_REFILL + 1;
const KEYS: usize = KEY_RESIDUAL + 1;

const ALWAYS: u32 = 0;
const WHEN_SET: u32 = 1;
const WHEN_NOT_SET: u32 = 2;

/// Where an item sits in one order.
#[derive(Clone, Copy)]
struct Seen {
    count: u32,
    /// The condition of the first rank: `ALWAYS`, `WHEN_SET` or `WHEN_NOT_SET`.
    when: u32,
    /// The trigger of the first rank, when it has a condition.
    trigger: u32,
    /// True when the two ranks have opposite conditions on one trigger.
    paired: bool,
    first: u32,
    last: u32,
}

fn key(item: &Item) -> usize {
    match item {
        Item::Fee(line) => *line as usize,
        Item::Interest(class) => FEE_SLOTS + *class as usize,
        Item::Principal(class) => FEE_SLOTS + CLASS_SLOTS + *class as usize,
        Item::ReserveRefill => KEY_REFILL,
        Item::Residual => KEY_RESIDUAL,
    }
}

/// 0 for a fee, 1 for interest, 2 for principal, 3 for the other items.
fn kind(item: &Item) -> u32 {
    match item {
        Item::Fee(_) => 0,
        Item::Interest(_) => 1,
        Item::Principal(_) => 2,
        Item::ReserveRefill | Item::Residual => 3,
    }
}

fn condition(config: &DealConfig, when: &Cond) -> Result<(u32, u32), DealError> {
    match when {
        Cond::Always => Ok((ALWAYS, 0)),
        Cond::Trigger(id) => {
            let index = trigger_index(config, id).ok_or(DealError::InvalidConfig)?;
            Ok((WHEN_SET, index as u32))
        }
        Cond::NotTrigger(id) => {
            let index = trigger_index(config, id).ok_or(DealError::InvalidConfig)?;
            Ok((WHEN_NOT_SET, index as u32))
        }
    }
}

/// True when the reserve can hold cash: the order then needs a refill rank.
fn has_reserve(config: &DealConfig) -> bool {
    match config.reserve.required {
        RequiredRule::Fixed(amount) => amount > 0,
        RequiredRule::PctOfNotes(pct, floor) => pct > 0 || floor > 0,
    }
}

fn validate_order(config: &DealConfig, order: &Vec<Rank>, normal: bool) -> Result<(), DealError> {
    let classes = config.classes.len();
    let fees = config.fees.len();
    if order.is_empty() || order.len() > MAX_RANKS {
        return Err(DealError::InvalidConfig);
    }
    let mut seen = [Seen { count: 0, when: ALWAYS, trigger: 0, paired: false, first: 0, last: 0 }; KEYS];
    let mut items_total = 0u32;
    let last_rank = order.len() - 1;

    for position in 0..order.len() {
        let rank = order.get(position).unwrap();
        for earlier in 0..position {
            if order.get(earlier).unwrap().id == rank.id {
                return Err(DealError::InvalidConfig);
            }
        }
        let (when, trigger) = condition(config, &rank.when)?;
        let count = rank.items.len();
        if count == 0 || count > MAX_RANK_ITEMS {
            return Err(DealError::InvalidConfig);
        }
        items_total += count;
        let first_kind = kind(&rank.items.get(0).unwrap());
        for index in 0..count {
            let item = rank.items.get(index).unwrap();
            let in_range = match item {
                Item::Fee(line) => line < fees,
                Item::Interest(class) | Item::Principal(class) => class < classes,
                Item::ReserveRefill | Item::Residual => true,
            };
            if !in_range {
                return Err(DealError::InvalidConfig);
            }
            // A pari passu rank shares cash between items of one kind.
            if rank.alloc == RankAlloc::PariPassu && (kind(&item) == 3 || kind(&item) != first_kind) {
                return Err(DealError::InvalidConfig);
            }
            // The residual takes all the cash that is left: alone, last, always.
            if item == Item::Residual && (count != 1 || position != last_rank || when != ALWAYS) {
                return Err(DealError::InvalidConfig);
            }
            let place = position * MAX_RANK_ITEMS + index;
            let entry = &mut seen[key(&item)];
            match entry.count {
                0 => {
                    *entry = Seen { count: 1, when, trigger, paired: false, first: place, last: place };
                }
                1 => {
                    let opposite = entry.when != ALWAYS
                        && when != ALWAYS
                        && entry.when != when
                        && entry.trigger == trigger;
                    if !opposite {
                        return Err(DealError::InvalidConfig);
                    }
                    entry.count = 2;
                    entry.paired = true;
                    entry.last = place;
                }
                _ => return Err(DealError::InvalidConfig),
            }
        }
    }
    if items_total > MAX_ORDER_ITEMS {
        return Err(DealError::InvalidConfig);
    }

    // One line that runs: one rank that always runs, or a pair of ranks.
    let runs_once = |entry: &Seen| (entry.count == 1 && entry.when == ALWAYS) || entry.paired;
    for entry in seen.iter().take(fees as usize) {
        if !runs_once(entry) {
            return Err(DealError::InvalidConfig);
        }
    }
    for class in 0..classes as usize {
        let interest = seen[FEE_SLOTS + class];
        let principal = seen[FEE_SLOTS + CLASS_SLOTS + class];
        if !runs_once(&interest) || !runs_once(&principal) || interest.last >= principal.first {
            return Err(DealError::InvalidConfig);
        }
    }
    if !runs_once(&seen[KEY_RESIDUAL]) {
        return Err(DealError::InvalidConfig);
    }
    let refill = seen[KEY_REFILL];
    if refill.count > 0 && !runs_once(&refill) {
        return Err(DealError::InvalidConfig);
    }
    if normal && has_reserve(config) && refill.count == 0 {
        return Err(DealError::InvalidConfig);
    }
    Ok(())
}

/// Check a deal configuration. `InvalidConfig` for a shape that the engine
/// cannot run, `RoleConflict` when one address holds two roles.
pub fn validate(config: &DealConfig) -> Result<(), DealError> {
    let classes = config.classes.len();
    if classes == 0
        || classes > MAX_CLASSES
        || config.note_denomination <= 0
        || config.round_unit <= 0
        || config.note_denomination % config.round_unit != 0
    {
        return Err(DealError::InvalidConfig);
    }
    for terms in config.classes.iter() {
        if terms.total_notes <= 0 {
            return Err(DealError::InvalidConfig);
        }
    }

    if config.fees.len() > MAX_FEES {
        return Err(DealError::InvalidConfig);
    }
    for line in config.fees.iter() {
        let valid = match line.amount {
            FeeAmount::Fixed(amount) => amount >= 0,
            FeeAmount::PerAnnum(rate) => (0..=RATE_SCALE).contains(&rate),
        };
        if !valid {
            return Err(DealError::InvalidConfig);
        }
    }

    let valid_reserve = match config.reserve.required {
        RequiredRule::Fixed(amount) => amount >= 0,
        RequiredRule::PctOfNotes(pct, floor) => (0..=RATE_SCALE).contains(&pct) && floor >= 0,
    };
    if !valid_reserve {
        return Err(DealError::InvalidConfig);
    }

    if config.triggers.len() > MAX_TRIGGERS {
        return Err(DealError::InvalidConfig);
    }
    for index in 0..config.triggers.len() {
        let terms = config.triggers.get(index).unwrap();
        for earlier in 0..index {
            if config.triggers.get(earlier).unwrap().id == terms.id {
                return Err(DealError::InvalidConfig);
            }
        }
        let known_class = match terms.metric {
            Metric::ClassFactor(class) | Metric::ClassShortfall(class) => class < classes,
            Metric::NotesFactor | Metric::ReserveShortfall => true,
        };
        if !known_class || terms.threshold < 0 {
            return Err(DealError::InvalidConfig);
        }
    }

    validate_order(config, &config.normal, true)?;
    validate_order(config, &config.enforced, false)?;

    // A draw rank is a rank of the normal order with fee and interest items
    // only. The reserve never pays principal. After enforcement the reserve
    // is released in full, so the enforced order has no draw rank.
    if config.reserve.release == Release::Full && !config.reserve.draw_ranks.is_empty() {
        return Err(DealError::InvalidConfig);
    }
    for id in config.reserve.draw_ranks.iter() {
        let rank = config
            .normal
            .iter()
            .find(|rank| rank.id == id)
            .ok_or(DealError::InvalidConfig)?;
        if rank.items.iter().any(|item| kind(&item) > 1) {
            return Err(DealError::InvalidConfig);
        }
    }

    // The role that triggers a payment date and the role that settles an
    // issuance are two addresses.
    if config.admin == config.servicer {
        return Err(DealError::RoleConflict);
    }
    Ok(())
}
