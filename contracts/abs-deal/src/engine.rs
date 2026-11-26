//! The rank engine: one payment date of a configured priority of payments.
//!
//! The engine is a pure calculation. It reads the configuration and the
//! opening ledgers, and it returns the ordered steps and the closing ledgers.
//! It reads no storage and moves no token: `distribute` replays the steps.
//!
//! One period, step by step:
//!
//! 1. Required reserve: 0 after enforcement or when all notes are at 0. Else
//!    the fixed amount, or a percent of the opening notes with a floor.
//! 2. Triggers, on the opening ledgers only: `now = hit or (latch and
//!    stored)`. No input of the servicer changes a trigger.
//! 3. Dues on the opening ledgers: the interest of each class (accrual plus
//!    its shortfall) and each fee line.
//! 4. Available amount = collections + released reserve + carry. A `Full`
//!    reserve is released in full. An `OnNeed` reserve releases only its
//!    excess over the required amount. After enforcement, the reserve is
//!    always released in full.
//! 5. Ranks, in the configured order. A rank with a false condition does not
//!    run. A draw rank of an `OnNeed` reserve takes its shortfall from the
//!    reserve. If all dues fit, each item gets its due. Else a `Sequential`
//!    rank pays in item order, and a `PariPassu` rank shares the cash in
//!    proportion to the dues, with the units left to the first items.
//! 6. Cash left after the last rank goes to the carry.
//!
//! The split rules of step 5 are the rules of the configurable waterfall
//! specification (section 5, step 8). The arithmetic of a noteholder item is
//! the arithmetic of this contract: per-note rounding down to `round_unit`,
//! with the remainder (the dust) to the carry.

use crate::types::{
    Cond, DealConfig, FeeAmount, Item, Metric, Op, Rank, RankAlloc, RateSpec, Release,
    RequiredRule, ClassTerms, DAY_COUNT_BASE, FACTOR_SCALE, MAX_CLASSES, MAX_FEES,
    MAX_RANK_ITEMS, MAX_TRIGGERS, RATE_SCALE,
};
use soroban_sdk::Symbol;

pub const CLASS_SLOTS: usize = MAX_CLASSES as usize;
pub const FEE_SLOTS: usize = MAX_FEES as usize;
pub const TRIGGER_SLOTS: usize = MAX_TRIGGERS as usize;
const RANK_SLOTS: usize = MAX_RANK_ITEMS as usize;
/// The validation gives each item one running line at most: the fee lines,
/// the interest and the principal of each class, the refill, the residual.
pub const STEP_SLOTS: usize = FEE_SLOTS + 2 * CLASS_SLOTS + 2;

/// The ledgers at the start of the period, and the inputs of the period.
pub struct Opening {
    pub enforced: bool,
    pub collections: i128,
    pub reserve: i128,
    pub carry: i128,
    pub per_note: [i128; CLASS_SLOTS],
    pub shortfall: [i128; CLASS_SLOTS],
    /// The stored trigger flags, in the order of `config.triggers`.
    pub triggers: [bool; TRIGGER_SLOTS],
    /// The index fixing in rate units. The engine reads it for a floating
    /// class only.
    pub fixing: i128,
}

/// One item of one rank that ran.
#[derive(Clone, Copy)]
pub struct Step {
    /// The index of the rank in the order that ran.
    pub rank: u32,
    pub item: Item,
    pub due: i128,
    /// The cash that the item takes from the available amount.
    pub alloc: i128,
    /// The cash that the item pays: `alloc` minus the per-note dust.
    pub paid: i128,
    /// The reserve ledger after a re-fund. 0 for the other items.
    pub balance: i128,
}

/// The result of one period.
pub struct Outcome {
    pub steps: [Step; STEP_SLOTS],
    pub count: usize,
    pub per_note: [i128; CLASS_SLOTS],
    pub shortfall: [i128; CLASS_SLOTS],
    /// Interest and principal for the paying agent, per class.
    pub interest: [i128; CLASS_SLOTS],
    pub principal: [i128; CLASS_SLOTS],
    pub per_note_principal: [i128; CLASS_SLOTS],
    pub required: i128,
    /// The reserve cash that enters the available amount at the top.
    pub released: i128,
    /// The reserve cash that the draw ranks take.
    pub drawn: i128,
    /// The available amount at the top: collections + released + carry.
    pub available: i128,
    pub reserve: i128,
    pub carry: i128,
    /// The cash of the residual rank.
    pub residual: i128,
    /// The trigger flags to store.
    pub triggers: [bool; TRIGGER_SLOTS],
    /// True for a trigger that holds now and did not hold in the stored flags.
    pub breached: [bool; TRIGGER_SLOTS],
}

/// The per-note rounding primitive: floor the per-note amount to
/// `round_unit`, pay it times the note count, carry the dust.
pub fn round_per_note(entitlement: i128, notes: i128, round_unit: i128) -> (i128, i128) {
    let per_note = entitlement / notes / round_unit * round_unit;
    let paid = per_note * notes;
    (paid, entitlement - paid)
}

/// Interest of one period on a nominal amount, on `days_in_period` / 360.
pub fn accrue(nominal: i128, annual_rate: i128, days_in_period: u32) -> i128 {
    if annual_rate <= 0 || nominal <= 0 {
        return 0;
    }
    nominal
        .saturating_mul(annual_rate)
        .saturating_mul(days_in_period as i128)
        / DAY_COUNT_BASE
        / RATE_SCALE
}

/// The annual rate of a class in rate units. A floating class takes the
/// fixing, floored by `index_floor`, plus its spread, floored by `floor`.
pub fn class_rate(terms: &ClassTerms, fixing: i128) -> i128 {
    match terms.rate {
        RateSpec::Fixed(rate) => rate,
        RateSpec::Floating(spread) => {
            let index = match terms.index_floor {
                Some(floor) => fixing.max(floor),
                None => fixing,
            };
            let all_in = index + spread;
            match terms.floor {
                Some(floor) => all_in.max(floor),
                None => all_in,
            }
        }
    }
}

/// True when a class of the deal floats: the deal then reads the oracle.
pub fn has_floating_class(config: &DealConfig) -> bool {
    config
        .classes
        .iter()
        .any(|terms| matches!(terms.rate, RateSpec::Floating(_)))
}

/// The required reserve for an opening balance of the notes.
pub fn required_reserve(config: &DealConfig, enforced: bool, notes_open: i128) -> i128 {
    if enforced || notes_open <= 0 {
        return 0;
    }
    match config.reserve.required {
        RequiredRule::Fixed(amount) => amount,
        RequiredRule::PctOfNotes(pct, floor) => (notes_open * pct / RATE_SCALE).max(floor),
    }
}

/// The position of a trigger in `config.triggers`.
pub fn trigger_index(config: &DealConfig, id: &Symbol) -> Option<usize> {
    config.triggers.iter().position(|terms| terms.id == *id)
}

fn holds(config: &DealConfig, when: &Cond, flags: &[bool; TRIGGER_SLOTS]) -> bool {
    match when {
        Cond::Always => true,
        Cond::Trigger(id) => trigger_index(config, id).map(|index| flags[index]).unwrap_or(false),
        Cond::NotTrigger(id) => {
            !trigger_index(config, id).map(|index| flags[index]).unwrap_or(false)
        }
    }
}

fn compare(value: i128, op: Op, threshold: i128) -> bool {
    match op {
        Op::Gt => value > threshold,
        Op::Ge => value >= threshold,
        Op::Lt => value < threshold,
        Op::Le => value <= threshold,
    }
}

/// Split `available` between the dues of one rank.
fn allocate(
    alloc: RankAlloc,
    dues: &[i128; RANK_SLOTS],
    count: usize,
    total: i128,
    available: i128,
) -> [i128; RANK_SLOTS] {
    if total <= available {
        return *dues;
    }
    let mut out = [0i128; RANK_SLOTS];
    if alloc == RankAlloc::Sequential {
        let mut left = available;
        for index in 0..count {
            out[index] = dues[index].min(left);
            left -= out[index];
        }
        return out;
    }
    // Pari passu: in proportion to the dues, the units left to the first
    // items, each one up to its due.
    let mut given = 0i128;
    for index in 0..count {
        out[index] = available * dues[index] / total;
        given += out[index];
    }
    let mut index = 0;
    while index < count && given < available {
        let add = (dues[index] - out[index]).min(available - given);
        out[index] += add;
        given += add;
        index += 1;
    }
    out
}

/// Run one period.
pub fn run(config: &DealConfig, open: &Opening) -> Outcome {
    let count = config.classes.len() as usize;
    let unit = config.round_unit;
    let days = config.days_in_period;

    let mut out = Outcome {
        steps: [Step { rank: 0, item: Item::Residual, due: 0, alloc: 0, paid: 0, balance: 0 }; STEP_SLOTS],
        count: 0,
        per_note: open.per_note,
        shortfall: [0; CLASS_SLOTS],
        interest: [0; CLASS_SLOTS],
        principal: [0; CLASS_SLOTS],
        per_note_principal: [0; CLASS_SLOTS],
        required: 0,
        released: 0,
        drawn: 0,
        available: 0,
        reserve: 0,
        carry: 0,
        residual: 0,
        triggers: [false; TRIGGER_SLOTS],
        breached: [false; TRIGGER_SLOTS],
    };

    // Class terms and the opening balance of the notes.
    let mut notes = [0i128; CLASS_SLOTS];
    let mut interest_due = [0i128; CLASS_SLOTS];
    let mut notes_open = 0i128;
    let mut notes_initial = 0i128;
    for index in 0..count {
        let terms = config.classes.get(index as u32).unwrap();
        notes[index] = terms.total_notes;
        let nominal = open.per_note[index] * terms.total_notes;
        notes_open += nominal;
        notes_initial += config.note_denomination * terms.total_notes;
        // Interest due = accrued on the outstanding + prior shortfall. The
        // shortfall earns no interest. A due stays a shortfall until an
        // interest line pays it.
        let rate = class_rate(&terms, open.fixing);
        interest_due[index] = accrue(nominal, rate, days) + open.shortfall[index];
        out.shortfall[index] = interest_due[index];
    }

    // 1. Required reserve.
    let required = required_reserve(config, open.enforced, notes_open);
    out.required = required;

    // 2. Triggers, on the opening ledgers.
    for (index, terms) in config.triggers.iter().enumerate() {
        let value = match terms.metric {
            Metric::ClassFactor(class) => {
                open.per_note[class as usize] * FACTOR_SCALE / config.note_denomination
            }
            Metric::NotesFactor => {
                if notes_initial > 0 {
                    notes_open * FACTOR_SCALE / notes_initial
                } else {
                    0
                }
            }
            Metric::ReserveShortfall => (required - open.reserve).max(0),
            Metric::ClassShortfall(class) => open.shortfall[class as usize],
        };
        let hit = compare(value, terms.op, terms.threshold);
        let stored = open.triggers[index];
        let now = hit || (terms.latch && stored);
        out.triggers[index] = now;
        out.breached[index] = now && !stored;
    }

    // 3. Fee dues.
    let mut fee_due = [0i128; FEE_SLOTS];
    for (index, line) in config.fees.iter().enumerate() {
        fee_due[index] = match line.amount {
            FeeAmount::Fixed(amount) => amount,
            FeeAmount::PerAnnum(rate) => accrue(notes_open, rate, days),
        };
    }

    // 4. Available amount.
    let full = open.enforced || config.reserve.release == Release::Full;
    let released = if full { open.reserve } else { (open.reserve - required).max(0) };
    let mut reserve = open.reserve - released;
    let mut available = open.collections + released + open.carry;
    let mut carry = 0i128;
    out.released = released;
    out.available = available;

    // 5. Ranks.
    let order = if open.enforced { &config.enforced } else { &config.normal };
    for (position, rank) in order.iter().enumerate() {
        let rank: Rank = rank;
        if !holds(config, &rank.when, &out.triggers) {
            continue;
        }
        let item_count = rank.items.len() as usize;
        let mut items = [Item::Residual; RANK_SLOTS];
        let mut dues = [0i128; RANK_SLOTS];
        let mut total = 0i128;
        for (index, item) in rank.items.iter().enumerate() {
            let due = match item {
                Item::Fee(line) => fee_due[line as usize],
                Item::Interest(class) => interest_due[class as usize],
                Item::Principal(class) => out.per_note[class as usize] * notes[class as usize],
                Item::ReserveRefill => (required - reserve).max(0),
                Item::Residual => available,
            };
            items[index] = item;
            dues[index] = due;
            total += due;
        }

        // An on-need reserve covers the shortfall of a draw rank.
        if !full
            && total > available
            && reserve > 0
            && config.reserve.draw_ranks.iter().any(|id| id == rank.id)
        {
            let draw = (total - available).min(reserve);
            reserve -= draw;
            available += draw;
            out.drawn += draw;
        }

        let allocs = allocate(rank.alloc, &dues, item_count, total, available);
        for index in 0..item_count {
            let alloc = allocs[index];
            let mut balance = 0i128;
            let paid = match items[index] {
                Item::Fee(_) => alloc,
                Item::Interest(class) => {
                    let class = class as usize;
                    let (paid, dust) = round_per_note(alloc, notes[class], unit);
                    out.shortfall[class] = dues[index] - alloc;
                    out.interest[class] = paid;
                    carry += dust;
                    paid
                }
                Item::Principal(class) => {
                    let class = class as usize;
                    if alloc > 0 {
                        let (paid, dust) = round_per_note(alloc, notes[class], unit);
                        let per_note = paid / notes[class];
                        out.per_note[class] -= per_note;
                        out.principal[class] = paid;
                        out.per_note_principal[class] = per_note;
                        carry += dust;
                        paid
                    } else {
                        0
                    }
                }
                Item::ReserveRefill => {
                    reserve += alloc;
                    balance = reserve;
                    alloc
                }
                Item::Residual => {
                    out.residual += alloc;
                    alloc
                }
            };
            available -= alloc;
            if out.count < STEP_SLOTS {
                out.steps[out.count] = Step {
                    rank: position as u32,
                    item: items[index],
                    due: dues[index],
                    alloc,
                    paid,
                    balance,
                };
                out.count += 1;
            }
        }
    }

    // 6. Cash left after the last rank goes to the carry.
    out.reserve = reserve;
    out.carry = carry + available;
    out
}
