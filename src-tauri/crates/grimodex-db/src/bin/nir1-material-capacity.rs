//! Opt-in NIR-1 whole-project capacity diagnostic.
//!
//! This binary runs the writeful Graph prepare/publish/restore lifecycle on a
//! disposable child database and reports the current A2 reader boundary plus
//! process/resource observations. The preseed source database is expected to
//! remain closed, checkpointed, and immutable; only the disposable child may
//! be mutated. It never claims a supported Graph build capacity.

use anyhow::{ensure, Result};
use grimodex_db::narrative_extraction::nir1_capacity_diagnostics::{
    measure_capacity_interruptions, measure_capacity_mode, CapacityDiagnosticMode,
};
use grimodex_db::narrative_extraction::nir1_capacity_fixtures::build_fixture_from_manifest;
use std::alloc::{GlobalAlloc, Layout, System};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

struct CapacityAllocator;

static RUST_HEAP_CURRENT: AtomicU64 = AtomicU64::new(0);
static RUST_HEAP_PEAK: AtomicU64 = AtomicU64::new(0);

fn allocation_bytes(size: usize) -> u64 {
    u64::try_from(size).unwrap_or(u64::MAX)
}

fn record_allocation(size: usize) {
    let current = RUST_HEAP_CURRENT
        .fetch_add(allocation_bytes(size), Ordering::Relaxed)
        .saturating_add(allocation_bytes(size));
    RUST_HEAP_PEAK.fetch_max(current, Ordering::Relaxed);
}

fn record_deallocation(size: usize) {
    let bytes = allocation_bytes(size);
    let _ = RUST_HEAP_CURRENT.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
        Some(current.saturating_sub(bytes))
    });
}

// The wrapper is linked only into this opt-in diagnostic binary. It delegates
// every operation to the standard system allocator and records requested
// bytes without changing allocation ownership or layout.
unsafe impl GlobalAlloc for CapacityAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the layout is forwarded unchanged to the system allocator.
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            record_allocation(layout.size());
        }
        pointer
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the layout is forwarded unchanged to the system allocator.
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            record_allocation(layout.size());
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        record_deallocation(layout.size());
        // SAFETY: pointer and layout come from the corresponding delegated
        // allocation and are forwarded unchanged.
        unsafe { System.dealloc(pointer, layout) };
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: pointer, old layout, and requested size are forwarded to the
        // same allocator that created the allocation.
        let replacement = unsafe { System.realloc(pointer, layout, new_size) };
        if !replacement.is_null() {
            if new_size >= layout.size() {
                record_allocation(new_size - layout.size());
            } else {
                record_deallocation(layout.size() - new_size);
            }
        }
        replacement
    }
}

#[global_allocator]
static CAPACITY_ALLOCATOR: CapacityAllocator = CapacityAllocator;

fn rust_heap_snapshot() -> (u64, u64) {
    let current = RUST_HEAP_CURRENT.load(Ordering::Relaxed);
    (current, RUST_HEAP_PEAK.load(Ordering::Relaxed).max(current))
}

fn main() -> Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
    if args.get(1).is_some_and(|arg| arg == "fixture") {
        ensure!(
            args.len() == 5,
            "usage: nir1-material-capacity fixture <manifest> <case-id> <output.db>"
        );
        let result =
            build_fixture_from_manifest(Path::new(&args[2]), &args[3], Path::new(&args[4]))?;
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }
    ensure!(
        args.len() >= 3,
        "usage: nir1-material-capacity <database> <fixture-id> [project-id] [--mode <mode>]"
    );
    let mut positionals = Vec::new();
    let mut mode = CapacityDiagnosticMode::FullBuild;
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--mode" => {
                ensure!(
                    index + 1 < args.len(),
                    "--mode requires one of full-build, source-reresolution, complete-registration, coverage, restore, cold-reopen"
                );
                mode = CapacityDiagnosticMode::parse(&args[index + 1])?;
                index += 2;
            }
            value if value.starts_with("--mode=") => {
                mode = CapacityDiagnosticMode::parse(value.trim_start_matches("--mode="))?;
                index += 1;
            }
            value => {
                positionals.push(value.to_owned());
                index += 1;
            }
        }
    }
    ensure!(
        (2..=3).contains(&positionals.len()),
        "usage: nir1-material-capacity <database> <fixture-id> [project-id] [--mode <mode>]"
    );
    let mut observation = measure_capacity_mode(
        Path::new(&positionals[0]),
        &positionals[1],
        positionals.get(2).map(String::as_str),
        mode,
    )?;
    let (current_requested_bytes, peak_requested_bytes) = rust_heap_snapshot();
    observation.record_rust_heap_measurement(current_requested_bytes, peak_requested_bytes);
    let interruptions = measure_capacity_interruptions(
        Path::new(&positionals[0]),
        positionals.get(2).map(String::as_str),
        mode,
    )?;
    observation.record_interruption_measurements(interruptions);
    println!("{}", serde_json::to_string_pretty(&observation)?);
    Ok(())
}
