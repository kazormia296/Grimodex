//! DEV-ONLY (branch `claude/irb-prepare-timing`, never merged): process-wide
//! stage timers for the related-scenes IR build's prepare.
//!
//! Each stage records a call count and the cumulative wall time. Stages are
//! INCLUSIVE and may nest (for example `preflight.membership` contains
//! `root_material`, which contains `hydrate_receipts`, which contains
//! `validate_receipt_lifecycle_binding`), so the stage times must not be
//! summed. The recording never changes control flow or results.
#![allow(dead_code)]

use std::{
    collections::BTreeMap,
    sync::Mutex,
    time::{Duration, Instant},
};

static STAGES: Mutex<BTreeMap<&'static str, (u64, u128)>> = Mutex::new(BTreeMap::new());

fn stages() -> std::sync::MutexGuard<'static, BTreeMap<&'static str, (u64, u128)>> {
    STAGES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn record(name: &'static str, elapsed: Duration) {
    let mut guard = stages();
    let entry = guard.entry(name).or_insert((0, 0));
    entry.0 += 1;
    entry.1 += elapsed.as_nanos();
}

/// Records a plain counter (a size, not a duration) under `name`: `calls`
/// accumulates the number of records and `total_ns` the summed value.
pub(crate) fn record_count(name: &'static str, value: u64) {
    let mut guard = stages();
    let entry = guard.entry(name).or_insert((0, 0));
    entry.0 += 1;
    entry.1 += u128::from(value);
}

/// Records the elapsed time of the guard's scope under `name`.
pub(crate) struct Span {
    name: &'static str,
    started: Instant,
}

impl Drop for Span {
    fn drop(&mut self) {
        record(self.name, self.started.elapsed());
    }
}

#[must_use]
pub(crate) fn span(name: &'static str) -> Span {
    Span {
        name,
        started: Instant::now(),
    }
}

/// Runs `body` and records its wall time under `name` (also on `Err`).
pub(crate) fn time<T>(name: &'static str, body: impl FnOnce() -> T) -> T {
    let _span = span(name);
    body()
}

pub(crate) fn reset() {
    stages().clear();
}

/// `(name, calls, total_ns)` sorted by name.
pub(crate) fn snapshot() -> Vec<(&'static str, u64, u128)> {
    stages()
        .iter()
        .map(|(name, (calls, nanos))| (*name, *calls, *nanos))
        .collect()
}
