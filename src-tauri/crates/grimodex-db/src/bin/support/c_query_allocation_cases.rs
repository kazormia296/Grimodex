//! Closed, data-free allocation cases for the isolated Linux diagnostic.
//!
//! Test builds exercise only fixed parsing/layout derivation; these allocation
//! entrypoints are called only by the opt-in binary after its own hook setup.

use std::{
    alloc::{alloc, alloc_zeroed, dealloc, realloc, Layout},
    ffi::c_void,
    ptr,
};

use anyhow::{ensure, Result};
use rusqlite::ffi;

use crate::c_query_allocator::{
    raw_layout_charge_bytes, snapshot, sqlite_roundup_bytes, AllocatorSnapshot,
    CONTROL_STORAGE_BYTES, SHARED_LIMIT_BYTES, SQLITE_CALLBACK_ALIGNMENT,
};
use crate::c_query_probe_frame::AllocationCaseObservation;

const CASE_LAYOUT: u16 = 100;
const CASE_SHARED_LIMIT: u16 = 101;
const CASE_REALLOC: u16 = 102;
const CASE_RUST_LIMIT: u16 = 103;
const SQLITE_BASELINE_BYTES: usize = 1_024;
const RUST_LIMIT_PAYLOAD_BYTES: usize = 131_072;
const RUST_LIMIT_ALIGNMENT: usize = 64;
const SQLITE_LIMIT_PAYLOAD_BYTES: u64 = 16_384;
const SQLITE_GROW_PAYLOAD_BYTES: u64 = 32_768;

// Frame assertion bits by case: layout baseline-credit/alignment/zeroing/Rust-copy/
// SQLite-copy/actual-free; limit exact-fill/NULL-denial/content/current/free-floor;
// realloc baseline-charge/exact-fill/failure-preservation/retry-copy/overlap/shrink-regrow/free.
const LAYOUT_ASSERTIONS: u16 = 0b00_0011_1111;
const LIMIT_ASSERTIONS: u16 = 0b00_0001_1111;
const REALLOC_ASSERTIONS: u16 = 0b00_0111_1111;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FixedAllocatorCase {
    Layout,
    SharedLimit,
    Realloc,
    RustLimit,
}

impl FixedAllocatorCase {
    pub fn code(self) -> u16 {
        match self {
            Self::Layout => CASE_LAYOUT,
            Self::SharedLimit => CASE_SHARED_LIMIT,
            Self::Realloc => CASE_REALLOC,
            Self::RustLimit => CASE_RUST_LIMIT,
        }
    }

    pub fn argv(self) -> &'static str {
        match self {
            Self::Layout => "alloc-layout",
            Self::SharedLimit => "alloc-shared-limit",
            Self::Realloc => "alloc-realloc",
            Self::RustLimit => "alloc-rust-limit",
        }
    }
}

pub fn parse_case(value: &str) -> Option<FixedAllocatorCase> {
    match value {
        "alloc-layout" => Some(FixedAllocatorCase::Layout),
        "alloc-shared-limit" => Some(FixedAllocatorCase::SharedLimit),
        "alloc-realloc" => Some(FixedAllocatorCase::Realloc),
        "alloc-rust-limit" => Some(FixedAllocatorCase::RustLimit),
        _ => None,
    }
}

pub struct CaseBaseline {
    case: FixedAllocatorCase,
    rust: Option<RustBlock>,
    sqlite: Option<SqliteBlock>,
}

impl CaseBaseline {
    /// Initialize SQLite and prepare only the fixed baseline blocks required by
    /// this case. The caller must already have installed the SQLite methods.
    pub fn prepare(case: FixedAllocatorCase) -> Result<Self> {
        // SAFETY: this isolated executable installs the callback table before
        // the first SQLite call and never shuts SQLite down or reconfigures it.
        let status = unsafe { ffi::sqlite3_initialize() };
        ensure!(status == ffi::SQLITE_OK, "SQLite initialization failed");
        let mut baseline = Self {
            case,
            rust: None,
            sqlite: None,
        };
        match case {
            FixedAllocatorCase::Layout => {
                let layout = Layout::from_size_align(SQLITE_BASELINE_BYTES, 16)?;
                baseline.rust = Some(RustBlock::allocate(layout, false)?);
                baseline.sqlite = Some(SqliteBlock::allocate(SQLITE_BASELINE_BYTES as u64)?);
                if let Some(rust) = baseline.rust.as_mut() {
                    rust.fill(0x71);
                }
                if let Some(sqlite) = baseline.sqlite.as_mut() {
                    sqlite.fill(0x72);
                }
            }
            FixedAllocatorCase::Realloc => {
                baseline.sqlite = Some(SqliteBlock::allocate(SQLITE_BASELINE_BYTES as u64)?);
                if let Some(sqlite) = baseline.sqlite.as_mut() {
                    sqlite.fill(0x73);
                }
            }
            FixedAllocatorCase::SharedLimit | FixedAllocatorCase::RustLimit => {}
        }
        Ok(baseline)
    }
}

#[derive(Default)]
struct CaseAccounting {
    payload: u64,
    admitted_raw: u64,
    rejected_payload: u64,
    rejected_raw: u64,
}

impl CaseAccounting {
    fn admitted(&mut self, payload: usize, raw: u64) -> Result<()> {
        self.payload = self
            .payload
            .checked_add(payload as u64)
            .ok_or_else(|| anyhow::anyhow!("case payload overflow"))?;
        self.admitted_raw = self
            .admitted_raw
            .checked_add(raw)
            .ok_or_else(|| anyhow::anyhow!("case charge overflow"))?;
        Ok(())
    }

    fn rejected(&mut self, payload: usize, raw: u64) -> Result<()> {
        self.rejected_payload = self
            .rejected_payload
            .checked_add(payload as u64)
            .ok_or_else(|| anyhow::anyhow!("rejected payload overflow"))?;
        self.rejected_raw = self
            .rejected_raw
            .checked_add(raw)
            .ok_or_else(|| anyhow::anyhow!("rejected charge overflow"))?;
        Ok(())
    }
}

/// Run one successful framed data-free case after the ARMED/CONTINUE handshake
/// and irreversible epoch transition. Case 103 has its separate no-frame path.
pub fn run_framed_case(
    case: FixedAllocatorCase,
    mut baseline: CaseBaseline,
    at_epoch: AllocatorSnapshot,
) -> Result<AllocationCaseObservation> {
    ensure!(
        case != FixedAllocatorCase::RustLimit,
        "case 103 has no frame"
    );
    ensure!(baseline.case == case, "baseline case mismatch");
    ensure!(
        at_epoch.query_pending_bytes == 0,
        "pending query reservation at epoch start"
    );
    ensure!(
        at_epoch.query_charged_bytes == CONTROL_STORAGE_BYTES,
        "unexpected epoch-start query charge"
    );

    let mut accounting = CaseAccounting::default();
    let assertion_mask = match case {
        FixedAllocatorCase::Layout => run_layout(&mut baseline, at_epoch, &mut accounting)?,
        FixedAllocatorCase::SharedLimit => run_shared_limit(&mut accounting)?,
        FixedAllocatorCase::Realloc => run_realloc(&mut baseline, at_epoch, &mut accounting)?,
        FixedAllocatorCase::RustLimit => anyhow::bail!("case 103 has no framed operation"),
    };
    let after_case = snapshot();
    ensure!(
        after_case.query_pending_bytes == 0,
        "pending query reservation after case"
    );
    ensure!(
        after_case.query_charged_bytes == CONTROL_STORAGE_BYTES,
        "query allocations were not actually freed"
    );
    ensure!(assertion_mask != 0, "case assertions missing");
    Ok(AllocationCaseObservation {
        case_code: case.code(),
        case_payload_requested_bytes: accounting.payload,
        case_admitted_raw_charge_bytes: accounting.admitted_raw,
        case_rejected_payload_bytes: accounting.rejected_payload,
        case_rejected_raw_charge_bytes: accounting.rejected_raw,
        assertion_mask,
        at_epoch,
        after_case,
    })
}

/// Fatal-exit case 103. No allocating error construction is allowed once the
/// SQLite fill can saturate quota; only the intended Box may produce exit 90.
pub fn run_rust_limit_case(baseline: CaseBaseline, at_epoch: AllocatorSnapshot) -> ! {
    let start = snapshot();
    if baseline.case != FixedAllocatorCase::RustLimit
        || at_epoch.query_pending_bytes != 0
        || at_epoch.query_charged_bytes != CONTROL_STORAGE_BYTES
        || start.query_pending_bytes != 0
        || start.query_charged_bytes != CONTROL_STORAGE_BYTES
    {
        reject_fault_case();
    }
    // Fallible sizing and the partial Rust block are prepared with headroom.
    let Ok((rust_layout, sqlite_payload)) = shared_limit_layouts(start.query_charged_bytes) else {
        reject_fault_case();
    };
    let Ok(mut rust) = RustBlock::allocate(rust_layout, false) else {
        reject_fault_case();
    };
    rust.fill(0x51);
    // From this allocation onward, even a failed check must not allocate an
    // anyhow error and accidentally impersonate the intended quota rejection.
    let Some(mut sqlite) = SqliteBlock::try_allocate(sqlite_payload as u64) else {
        reject_fault_case();
    };
    sqlite.fill(0x52);
    let full = snapshot();
    if !fault_fill_is_exact(
        full.query_charged_bytes,
        full.query_pending_bytes,
        full.query_high_water_bytes,
    ) {
        reject_fault_case();
    }
    std::hint::black_box(&rust);
    std::hint::black_box(&sqlite);
    let witness = Box::new(0x5a_u8);
    std::hint::black_box(&witness);
    reject_fault_case();
}

fn reject_fault_case() -> ! {
    // SAFETY: fixed, allocation-free, non-unwinding failure. Both invalid
    // preconditions and an unexpectedly returned Box are distinct from 90.
    unsafe { libc::_exit(93) }
}

fn fault_fill_is_exact(charge: u64, pending: u64, peak: u64) -> bool {
    charge == SHARED_LIMIT_BYTES && pending == 0 && peak == SHARED_LIMIT_BYTES
}

fn fresh_overlap_observed(current: u64, prior_peak: u64, replacement: u64, peak: u64) -> bool {
    current.checked_add(replacement).is_some_and(|overlap| {
        prior_peak < overlap && overlap <= SHARED_LIMIT_BYTES && peak == overlap
    })
}

fn run_layout(
    baseline: &mut CaseBaseline,
    at_epoch: AllocatorSnapshot,
    accounting: &mut CaseAccounting,
) -> Result<u16> {
    ensure!(
        baseline.rust.is_some() && baseline.sqlite.is_some(),
        "baseline Rust/SQLite blocks missing"
    );
    let before_baseline_free = snapshot();
    let rust_baseline_charge = raw_layout_charge_bytes(Layout::from_size_align(1_024, 16)?)
        .ok_or_else(|| anyhow::anyhow!("baseline Rust charge overflow"))?;
    let sqlite_baseline_charge = sqlite_charge(SQLITE_BASELINE_BYTES as u64)?;
    drop(baseline.rust.take());
    drop(baseline.sqlite.take());
    let after_baseline_free = snapshot();
    ensure!(
        after_baseline_free.query_charged_bytes == at_epoch.query_charged_bytes,
        "baseline free credited query charge"
    );
    ensure!(
        after_baseline_free
            .baseline_charged_bytes
            .checked_add(rust_baseline_charge + sqlite_baseline_charge)
            == Some(before_baseline_free.baseline_charged_bytes),
        "baseline frees did not release their raw charge"
    );
    ensure!(
        after_baseline_free
            .rust_requested_live_bytes
            .checked_add(1_024)
            == Some(before_baseline_free.rust_requested_live_bytes),
        "baseline Rust free did not release requested-live bytes"
    );

    let mut assertions = 1 << 0;
    for alignment in [1, 8, 16, 64, 4_096] {
        for payload in [128usize, 512] {
            let layout = Layout::from_size_align(payload, alignment)?;
            let charge = raw_layout_charge_bytes(layout)
                .ok_or_else(|| anyhow::anyhow!("Rust layout charge overflow"))?;
            let mut rust = RustBlock::allocate(layout, true)?;
            accounting.admitted(payload, charge)?;
            ensure!(rust.is_aligned(), "Rust requested alignment not preserved");
            ensure!(
                rust.all_bytes(0),
                "Rust zeroed allocation contains nonzero byte"
            );
            rust.fill(0x31);
            assertions |= 1 << 1;
            assertions |= 1 << 2;
            let grown_size = payload + 32;
            let grown_layout = Layout::from_size_align(grown_size, alignment)?;
            let grown_charge = raw_layout_charge_bytes(grown_layout)
                .ok_or_else(|| anyhow::anyhow!("Rust realloc charge overflow"))?;
            rust.grow(grown_size)?;
            accounting.admitted(grown_size, grown_charge)?;
            ensure!(
                rust.all_bytes_prefix(payload, 0x31),
                "Rust realloc did not preserve old bytes"
            );
            assertions |= 1 << 3;
            drop(rust);
        }
    }
    for payload in [128u64, 512] {
        let mut sqlite = SqliteBlock::allocate(payload)?;
        accounting.admitted(payload as usize, sqlite_charge(payload)?)?;
        ensure!(
            sqlite.is_aligned(),
            "SQLite callback alignment not preserved"
        );
        sqlite.fill(0x42);
        let grown = payload + 32;
        sqlite.grow(grown)?;
        accounting.admitted(grown as usize, sqlite_charge(grown)?)?;
        ensure!(
            sqlite.all_bytes_prefix(payload as usize, 0x42),
            "SQLite realloc did not preserve old bytes"
        );
        assertions |= 1 << 4;
        drop(sqlite);
    }
    let after_frees = snapshot();
    ensure!(
        after_frees.query_charged_bytes == at_epoch.query_charged_bytes,
        "real frees did not credit query charge"
    );
    ensure!(
        after_frees.query_high_water_bytes > at_epoch.query_high_water_bytes,
        "allocation peak was not observed"
    );
    assertions |= 1 << 5;
    ensure!(
        assertions == LAYOUT_ASSERTIONS,
        "layout assertion mask incomplete"
    );
    Ok(assertions)
}

fn run_shared_limit(accounting: &mut CaseAccounting) -> Result<u16> {
    let (rust, sqlite, sqlite_payload) = allocate_exact_shared_limit()?;
    let full = snapshot();
    ensure!(
        full.query_charged_bytes == SHARED_LIMIT_BYTES,
        "shared charge did not exactly reach quota"
    );
    ensure!(
        full.query_pending_bytes == 0,
        "shared quota has pending reservation"
    );
    ensure!(
        rust.is_aligned() && rust.all_bytes(0x51),
        "Rust fill block invalid"
    );
    ensure!(sqlite.all_bytes(0x52), "SQLite fill block invalid");

    let rejected_payload = 1usize;
    let rejected_layout = sqlite_layout(rejected_payload)?;
    let rejected_charge = raw_layout_charge_bytes(rejected_layout)
        .ok_or_else(|| anyhow::anyhow!("rejected layout charge overflow"))?;
    let denied = unsafe { ffi::sqlite3_malloc64(rejected_payload as u64) };
    ensure!(
        denied.is_null(),
        "SQLite request unexpectedly crossed full quota"
    );
    ensure!(
        rust.all_bytes(0x51) && sqlite.all_bytes(0x52),
        "denied request changed admitted blocks"
    );
    let after_denial = snapshot();
    ensure!(
        after_denial.query_charged_bytes == SHARED_LIMIT_BYTES
            && after_denial.query_pending_bytes == 0,
        "rejected allocation changed shared charge"
    );
    accounting.admitted(RUST_LIMIT_PAYLOAD_BYTES, rust_charge()?)?;
    accounting.admitted(sqlite_payload, sqlite_charge(sqlite_payload as u64)?)?;
    accounting.rejected(rejected_payload, rejected_charge)?;

    drop(sqlite);
    drop(rust);
    let after_free = snapshot();
    ensure!(
        after_free.query_charged_bytes == CONTROL_STORAGE_BYTES,
        "real frees did not return to control-state charge"
    );
    ensure!(
        after_free.query_pending_bytes == 0,
        "pending reservation remains after frees"
    );
    Ok(LIMIT_ASSERTIONS)
}

fn run_realloc(
    baseline: &mut CaseBaseline,
    at_epoch: AllocatorSnapshot,
    accounting: &mut CaseAccounting,
) -> Result<u16> {
    let mut assertions = 0u16;
    let mut baseline_sqlite = baseline
        .sqlite
        .take()
        .ok_or_else(|| anyhow::anyhow!("baseline SQLite block missing"))?;
    let before_realloc = snapshot();
    baseline_sqlite.ensure_prefix(SQLITE_BASELINE_BYTES, 0x73)?;
    let baseline_realloc_size = 2_048usize;
    let baseline_old_charge = sqlite_charge(SQLITE_BASELINE_BYTES as u64)?;
    let baseline_realloc_charge = sqlite_charge(baseline_realloc_size as u64)?;
    baseline_sqlite.grow(baseline_realloc_size as u64)?;
    accounting.admitted(baseline_realloc_size, baseline_realloc_charge)?;
    let after_baseline_realloc = snapshot();
    ensure!(
        after_baseline_realloc.query_charged_bytes
            == before_realloc.query_charged_bytes + baseline_realloc_charge,
        "baseline realloc was not fully query charged"
    );
    ensure!(
        after_baseline_realloc
            .baseline_charged_bytes
            .checked_add(baseline_old_charge)
            == Some(before_realloc.baseline_charged_bytes),
        "baseline realloc did not actually free its baseline block"
    );
    baseline_sqlite.ensure_prefix(SQLITE_BASELINE_BYTES, 0x73)?;
    assertions |= 1 << 0;
    drop(baseline_sqlite);
    ensure!(
        snapshot().query_charged_bytes == at_epoch.query_charged_bytes,
        "baseline realloc replacement not actually freed"
    );

    let sqlite_payload = SQLITE_LIMIT_PAYLOAD_BYTES as usize;
    let sqlite_raw_charge = sqlite_charge(SQLITE_LIMIT_PAYLOAD_BYTES)?;
    let grow_size = SQLITE_GROW_PAYLOAD_BYTES;
    let failed_charge = sqlite_charge(grow_size)?;
    // Observe old+replacement charge before exact-fill raises the lifetime peak.
    // A peak already reached by another operation cannot prove this overlap.
    let mut overlap_probe = SqliteBlock::allocate(SQLITE_LIMIT_PAYLOAD_BYTES)?;
    accounting.admitted(sqlite_payload, sqlite_raw_charge)?;
    overlap_probe.fill(0x39);
    let before_overlap = snapshot();
    overlap_probe.grow(grow_size)?;
    accounting.admitted(grow_size as usize, failed_charge)?;
    let after_overlap = snapshot();
    ensure!(
        fresh_overlap_observed(
            before_overlap.query_charged_bytes,
            before_overlap.query_high_water_bytes,
            failed_charge,
            after_overlap.query_high_water_bytes,
        ) && after_overlap.query_pending_bytes == 0
            && after_overlap.query_charged_bytes
                == before_overlap.query_charged_bytes - sqlite_raw_charge + failed_charge,
        "successful realloc did not produce a fresh old-plus-replacement peak"
    );
    overlap_probe.ensure_prefix(sqlite_payload, 0x39)?;
    drop(overlap_probe);
    ensure!(
        snapshot().query_charged_bytes == at_epoch.query_charged_bytes,
        "overlap probe replacement not actually freed"
    );
    assertions |= 1 << 4;

    let before_fill = snapshot();
    let remaining = SHARED_LIMIT_BYTES
        .checked_sub(before_fill.query_charged_bytes)
        .and_then(|value| value.checked_sub(sqlite_raw_charge))
        .ok_or_else(|| anyhow::anyhow!("SQLite fill exceeds remaining quota"))?;
    let guard_layout = exact_rust_layout(remaining, 1)?;
    let guard_charge = raw_layout_charge_bytes(guard_layout)
        .ok_or_else(|| anyhow::anyhow!("Rust guard charge overflow"))?;
    let mut sqlite = SqliteBlock::allocate(SQLITE_LIMIT_PAYLOAD_BYTES)?;
    accounting.admitted(sqlite_payload, sqlite_raw_charge)?;
    sqlite.fill(0x39);
    let mut guard = RustBlock::allocate(guard_layout, false)?;
    accounting.admitted(guard_layout.size(), guard_charge)?;
    guard.fill(0x5b);
    let full = snapshot();
    ensure!(
        full.query_charged_bytes == SHARED_LIMIT_BYTES && full.query_pending_bytes == 0,
        "realloc case did not exactly fill quota"
    );
    assertions |= 1 << 1;
    ensure!(
        !sqlite.try_grow(grow_size),
        "SQLite growth unexpectedly crossed full quota"
    );
    accounting.rejected(grow_size as usize, failed_charge)?;
    ensure!(
        sqlite.all_bytes(0x39),
        "failed SQLite growth changed old content"
    );
    let after_failure = snapshot();
    ensure!(
        after_failure.query_charged_bytes == SHARED_LIMIT_BYTES
            && after_failure.query_pending_bytes == 0,
        "failed growth changed admitted charge"
    );
    assertions |= 1 << 2;

    drop(guard);
    let after_guard_free = snapshot();
    ensure!(
        after_guard_free.query_charged_bytes == SHARED_LIMIT_BYTES - guard_charge,
        "Rust guard free did not credit charge"
    );
    ensure!(
        sqlite.try_grow(grow_size),
        "prescribed SQLite growth retry failed after freeing guard"
    );
    accounting.admitted(grow_size as usize, failed_charge)?;
    ensure!(
        sqlite.all_bytes_prefix(sqlite_payload, 0x39),
        "successful growth lost old content"
    );
    let after_growth = snapshot();
    ensure!(
        after_growth.query_pending_bytes == 0
            && after_growth.query_charged_bytes
                == after_guard_free.query_charged_bytes - sqlite_raw_charge + failed_charge,
        "successful retry did not replace the old charge"
    );
    sqlite.fill(0x39);
    assertions |= 1 << 3;

    let grown_capacity = sqlite.capacity();
    let before_shrink = snapshot();
    ensure!(
        sqlite.try_grow(sqlite_payload as u64),
        "SQLite conservative shrink failed"
    );
    ensure!(
        sqlite.capacity() == grown_capacity,
        "SQLite shrink did not retain advertised capacity"
    );
    ensure!(
        snapshot().query_charged_bytes == before_shrink.query_charged_bytes,
        "SQLite conservative shrink credited charge"
    );
    ensure!(
        sqlite.all_bytes_prefix(grown_capacity as usize, 0x39),
        "SQLite shrink lost retained capacity contents"
    );
    ensure!(
        sqlite.try_grow(grown_capacity),
        "SQLite retained-capacity regrow failed"
    );
    ensure!(
        sqlite.all_bytes_prefix(grown_capacity as usize, 0x39),
        "SQLite regrow failed to preserve xSize-advertised old bytes"
    );
    ensure!(
        snapshot().query_charged_bytes == before_shrink.query_charged_bytes,
        "SQLite retained-capacity regrow changed charge"
    );
    assertions |= 1 << 5;
    drop(sqlite);
    ensure!(
        snapshot().query_charged_bytes == at_epoch.query_charged_bytes,
        "SQLite actual free did not credit query charge"
    );
    assertions |= 1 << 6;
    ensure!(
        assertions == REALLOC_ASSERTIONS,
        "realloc assertion mask incomplete"
    );
    Ok(assertions)
}

fn shared_limit_layouts(current_charge: u64) -> Result<(Layout, usize)> {
    let rust_layout = Layout::from_size_align(RUST_LIMIT_PAYLOAD_BYTES, RUST_LIMIT_ALIGNMENT)?;
    let rust_raw = raw_layout_charge_bytes(rust_layout)
        .ok_or_else(|| anyhow::anyhow!("Rust fill charge overflow"))?;
    let remaining = SHARED_LIMIT_BYTES
        .checked_sub(current_charge)
        .and_then(|value| value.checked_sub(rust_raw))
        .ok_or_else(|| anyhow::anyhow!("Rust fill exceeds remaining quota"))?;
    Ok((rust_layout, exact_sqlite_payload(remaining)?))
}

fn allocate_exact_shared_limit() -> Result<(RustBlock, SqliteBlock, usize)> {
    let (rust_layout, sqlite_payload) = shared_limit_layouts(snapshot().query_charged_bytes)?;
    let mut rust = RustBlock::allocate(rust_layout, false)?;
    rust.fill(0x51);
    let mut sqlite = SqliteBlock::allocate(sqlite_payload as u64)?;
    sqlite.fill(0x52);
    Ok((rust, sqlite, sqlite_payload))
}

fn exact_sqlite_payload(raw_charge: u64) -> Result<usize> {
    let empty_layout = Layout::from_size_align(0, SQLITE_CALLBACK_ALIGNMENT)?;
    let overhead = raw_layout_charge_bytes(empty_layout)
        .ok_or_else(|| anyhow::anyhow!("SQLite empty layout charge overflow"))?;
    let payload = raw_charge
        .checked_sub(overhead)
        .ok_or_else(|| anyhow::anyhow!("quota cannot fit SQLite header"))?;
    let payload = usize::try_from(payload)?;
    ensure!(payload > 0, "SQLite fill has no payload");
    ensure!(
        sqlite_roundup_bytes(payload) == Some(payload),
        "exact SQLite fill is not representable after xRoundup"
    );
    ensure!(
        raw_layout_charge_bytes(sqlite_layout(payload)?) == Some(raw_charge),
        "SQLite fill does not equal exact raw charge"
    );
    Ok(payload)
}

fn exact_rust_layout(raw_charge: u64, alignment: usize) -> Result<Layout> {
    let empty = Layout::from_size_align(0, alignment)?;
    let overhead = raw_layout_charge_bytes(empty)
        .ok_or_else(|| anyhow::anyhow!("Rust empty layout charge overflow"))?;
    let payload = usize::try_from(
        raw_charge
            .checked_sub(overhead)
            .ok_or_else(|| anyhow::anyhow!("quota cannot fit Rust header"))?,
    )?;
    let layout = Layout::from_size_align(payload, alignment)?;
    ensure!(
        raw_layout_charge_bytes(layout) == Some(raw_charge),
        "exact Rust fill is not representable"
    );
    Ok(layout)
}

fn rust_charge() -> Result<u64> {
    raw_layout_charge_bytes(Layout::from_size_align(
        RUST_LIMIT_PAYLOAD_BYTES,
        RUST_LIMIT_ALIGNMENT,
    )?)
    .ok_or_else(|| anyhow::anyhow!("Rust fill charge overflow"))
}

fn sqlite_layout(payload: usize) -> Result<Layout> {
    let rounded =
        sqlite_roundup_bytes(payload).ok_or_else(|| anyhow::anyhow!("SQLite roundup overflow"))?;
    Layout::from_size_align(rounded, SQLITE_CALLBACK_ALIGNMENT).map_err(Into::into)
}

fn sqlite_charge(payload: u64) -> Result<u64> {
    let payload = usize::try_from(payload)?;
    raw_layout_charge_bytes(sqlite_layout(payload)?)
        .ok_or_else(|| anyhow::anyhow!("SQLite layout charge overflow"))
}

struct RustBlock {
    pointer: ptr::NonNull<u8>,
    layout: Layout,
}

impl RustBlock {
    fn allocate(layout: Layout, zeroed: bool) -> Result<Self> {
        // SAFETY: Layout is validated; returned pointer is owned until Drop.
        let raw = unsafe {
            if zeroed {
                alloc_zeroed(layout)
            } else {
                alloc(layout)
            }
        };
        let pointer = ptr::NonNull::new(raw)
            .ok_or_else(|| anyhow::anyhow!("Rust allocation returned NULL"))?;
        Ok(Self { pointer, layout })
    }

    fn is_aligned(&self) -> bool {
        self.pointer.as_ptr() as usize % self.layout.align() == 0
    }

    fn fill(&mut self, value: u8) {
        // SAFETY: this block owns at least layout.size() writable bytes.
        unsafe { ptr::write_bytes(self.pointer.as_ptr(), value, self.layout.size()) };
    }

    fn all_bytes(&self, expected: u8) -> bool {
        // SAFETY: this block owns layout.size() readable bytes.
        unsafe { std::slice::from_raw_parts(self.pointer.as_ptr(), self.layout.size()) }
            .iter()
            .all(|value| *value == expected)
    }

    fn all_bytes_prefix(&self, length: usize, expected: u8) -> bool {
        if length > self.layout.size() {
            return false;
        }
        // SAFETY: prefix is within the owned allocation.
        unsafe { std::slice::from_raw_parts(self.pointer.as_ptr(), length) }
            .iter()
            .all(|value| *value == expected)
    }

    fn grow(&mut self, new_size: usize) -> Result<()> {
        let new_layout = Layout::from_size_align(new_size, self.layout.align())?;
        // SAFETY: pointer/layout are the owned old allocation and new_size is nonzero.
        let raw = unsafe { realloc(self.pointer.as_ptr(), self.layout, new_size) };
        let pointer =
            ptr::NonNull::new(raw).ok_or_else(|| anyhow::anyhow!("Rust realloc returned NULL"))?;
        self.pointer = pointer;
        self.layout = new_layout;
        Ok(())
    }
}

impl Drop for RustBlock {
    fn drop(&mut self) {
        // SAFETY: pointer was allocated with this exact layout and is owned once.
        unsafe { dealloc(self.pointer.as_ptr(), self.layout) };
    }
}

struct SqliteBlock {
    pointer: ptr::NonNull<c_void>,
}

impl SqliteBlock {
    fn try_allocate(payload: u64) -> Option<Self> {
        // SAFETY: SQLite callbacks were installed before sqlite3_initialize.
        let raw = unsafe { ffi::sqlite3_malloc64(payload) };
        ptr::NonNull::new(raw).map(|pointer| Self { pointer })
    }

    fn allocate(payload: u64) -> Result<Self> {
        Self::try_allocate(payload)
            .ok_or_else(|| anyhow::anyhow!("SQLite allocation returned NULL"))
    }

    fn grow(&mut self, payload: u64) -> Result<()> {
        ensure!(self.try_grow(payload), "SQLite realloc returned NULL");
        Ok(())
    }

    fn try_grow(&mut self, payload: u64) -> bool {
        // SAFETY: pointer is a live block returned by SQLite and remains valid on failure.
        let raw = unsafe { ffi::sqlite3_realloc64(self.pointer.as_ptr(), payload) };
        if let Some(pointer) = ptr::NonNull::new(raw) {
            self.pointer = pointer;
            true
        } else {
            false
        }
    }

    fn capacity(&self) -> u64 {
        // SAFETY: pointer is a live SQLite allocation.
        unsafe { ffi::sqlite3_msize(self.pointer.as_ptr()) }
    }

    fn is_aligned(&self) -> bool {
        self.pointer.as_ptr() as usize % SQLITE_CALLBACK_ALIGNMENT == 0
    }

    fn fill(&mut self, value: u8) {
        // SAFETY: SQLite's xSize reports the usable capacity of this live block.
        let length = self.capacity() as usize;
        unsafe { ptr::write_bytes(self.pointer.as_ptr().cast::<u8>(), value, length) };
    }

    fn all_bytes(&self, expected: u8) -> bool {
        self.all_bytes_prefix(self.capacity() as usize, expected)
    }

    fn all_bytes_prefix(&self, length: usize, expected: u8) -> bool {
        if length as u64 > self.capacity() {
            return false;
        }
        // SAFETY: prefix is within the capacity reported by SQLite xSize.
        unsafe { std::slice::from_raw_parts(self.pointer.as_ptr().cast::<u8>(), length) }
            .iter()
            .all(|value| *value == expected)
    }

    fn ensure_prefix(&self, length: usize, expected: u8) -> Result<()> {
        ensure!(
            self.all_bytes_prefix(length, expected),
            "SQLite baseline realloc lost old content"
        );
        Ok(())
    }
}

impl Drop for SqliteBlock {
    fn drop(&mut self) {
        // SAFETY: pointer was returned by SQLite and is owned exactly once.
        unsafe { ffi::sqlite3_free(self.pointer.as_ptr()) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_argv_cases_are_closed_and_have_approved_codes() {
        for (name, case, code) in [
            ("alloc-layout", FixedAllocatorCase::Layout, 100),
            ("alloc-shared-limit", FixedAllocatorCase::SharedLimit, 101),
            ("alloc-realloc", FixedAllocatorCase::Realloc, 102),
            ("alloc-rust-limit", FixedAllocatorCase::RustLimit, 103),
        ] {
            assert_eq!(parse_case(name), Some(case));
            assert_eq!(case.argv(), name);
            assert_eq!(case.code(), code);
        }
        assert_eq!(parse_case("alloc-layout/128"), None);
        assert_eq!(parse_case("Q2/R1/D0-local"), None);
        assert_eq!(parse_case(""), None);
    }

    #[test]
    fn fixed_layout_and_exact_fill_arithmetic_is_checked_without_allocating() {
        for alignment in [1, 8, 16, 64, 4_096] {
            for payload in [128, 512] {
                let layout =
                    Layout::from_size_align(payload, alignment).expect("fixed valid layout");
                assert!(raw_layout_charge_bytes(layout).is_some());
            }
        }
        let rust = raw_layout_charge_bytes(
            Layout::from_size_align(RUST_LIMIT_PAYLOAD_BYTES, RUST_LIMIT_ALIGNMENT)
                .expect("fixed valid Rust layout"),
        )
        .expect("checked Rust charge");
        let remaining = SHARED_LIMIT_BYTES - CONTROL_STORAGE_BYTES - rust;
        let sqlite_payload = exact_sqlite_payload(remaining).expect("exact fixed SQLite fill");
        assert_eq!(
            raw_layout_charge_bytes(sqlite_layout(sqlite_payload).expect("SQLite layout")),
            Some(remaining)
        );
        let sqlite_fill = sqlite_charge(SQLITE_LIMIT_PAYLOAD_BYTES).expect("SQLite case charge");
        let rust_guard_charge = SHARED_LIMIT_BYTES - CONTROL_STORAGE_BYTES - sqlite_fill;
        let rust_guard = exact_rust_layout(rust_guard_charge, 1).expect("exact fixed Rust guard");
        assert_eq!(raw_layout_charge_bytes(rust_guard), Some(rust_guard_charge));
        assert_eq!(sqlite_roundup_bytes(usize::MAX), None);
    }

    #[test]
    fn fault_fill_guard_rejects_partial_pending_or_inconsistent_charge() {
        assert!(fault_fill_is_exact(
            SHARED_LIMIT_BYTES,
            0,
            SHARED_LIMIT_BYTES
        ));
        assert!(!fault_fill_is_exact(
            SHARED_LIMIT_BYTES - 1,
            0,
            SHARED_LIMIT_BYTES
        ));
        assert!(!fault_fill_is_exact(
            SHARED_LIMIT_BYTES,
            1,
            SHARED_LIMIT_BYTES
        ));
        assert!(!fault_fill_is_exact(
            SHARED_LIMIT_BYTES,
            0,
            SHARED_LIMIT_BYTES - 1
        ));
    }

    #[test]
    fn overlap_requires_a_fresh_peak_not_a_previous_saturation() {
        assert!(fresh_overlap_observed(128, 128, 256, 384));
        assert!(!fresh_overlap_observed(128, 384, 256, 384));
        assert!(!fresh_overlap_observed(
            128,
            SHARED_LIMIT_BYTES,
            256,
            SHARED_LIMIT_BYTES
        ));
        assert!(!fresh_overlap_observed(128, 128, 256, 256));
        assert!(!fresh_overlap_observed(u64::MAX, 0, 1, 0));
        assert!(!fresh_overlap_observed(
            SHARED_LIMIT_BYTES,
            0,
            1,
            SHARED_LIMIT_BYTES + 1
        ));
    }
}
