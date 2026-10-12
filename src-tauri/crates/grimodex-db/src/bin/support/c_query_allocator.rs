//! Admission core for the isolated Linux C-query diagnostic only.
//!
//! No allocator hook or SQLite configuration is activated merely by including
//! this module. The isolated Linux probe installs SQLite's table before SQLite
//! initialization, registers [`SharedAllocator`] only in that binary, and calls
//! [`begin_epoch`] once after its approved baseline preparation.

use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::UnsafeCell,
    ffi::{c_int, c_void},
    hint::spin_loop,
    mem::{align_of, size_of},
    ptr::{self, NonNull},
    sync::atomic::{AtomicBool, Ordering},
};

use rusqlite::ffi;

pub const SHARED_LIMIT_BYTES: u64 = 2_097_152;
pub const SQLITE_CALLBACK_ALIGNMENT: usize = align_of::<u64>();
const SQLITE_ALIGNMENT: usize = SQLITE_CALLBACK_ALIGNMENT;

const EPOCH_BEFORE: u8 = 0;
const EPOCH_STARTING: u8 = 1;
const EPOCH_ACTIVE: u8 = 2;
const EPOCH_FAILED: u8 = 3;

const INSTALL_NOT_ATTEMPTED: u8 = 0;
const INSTALL_IN_PROGRESS: u8 = 1;
const INSTALL_SUCCEEDED: u8 = 2;
const INSTALL_FAILED: u8 = 3;

const ORIGIN_BASELINE: u8 = 1;
const ORIGIN_QUERY: u8 = 2;
const CLIENT_RUST: u8 = 1;
const CLIENT_SQLITE: u8 = 2;
const HEADER_MAGIC: u64 = 0x4351_414c_4c4f_4331;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AllocatorSnapshot {
    /// System-requested raw bytes for live baseline-origin blocks.
    pub baseline_charged_bytes: u64,
    /// Baseline raw bytes admitted but not yet completed by System.
    pub baseline_pending_bytes: u64,
    pub baseline_high_water_bytes: u64,
    /// Shared query charge: control reserve, live query blocks, and pending
    /// query reservations. This is not a physical-memory measurement.
    pub query_charged_bytes: u64,
    /// Subset of query charge reserved while the corresponding System call is
    /// pending. It is not a live-allocation or physical-memory measurement.
    pub query_pending_bytes: u64,
    /// High-water of admitted shared charge, including pending reservations.
    pub query_high_water_bytes: u64,
    /// Rust caller-requested bytes for completed live Rust allocations only.
    pub rust_requested_live_bytes: u64,
    /// Rust caller-requested bytes pending System allocation; not live bytes.
    pub rust_requested_pending_bytes: u64,
    /// High-water requested-live Rust bytes since the epoch began.
    pub rust_requested_peak_bytes: u64,
    /// Rust requested-live bytes captured at the epoch boundary.
    pub rust_baseline_requested_live_bytes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BeginEpochError {
    SqliteAllocatorNotInstalled,
    AlreadyStarted,
    ControlStorageExceedsLimit,
    AccountingInvariant,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SqliteInstallError {
    EpochAlreadyStarted,
    AlreadyAttempted,
    Configuration(c_int),
    AccountingInvariant,
}

/// Build-derived fixed process-local admission state reserved at epoch start.
pub const CONTROL_STORAGE_BYTES: u64 = size_of::<Control>() as u64;

/// Opt-in Rust allocator adapter. It is intentionally not registered here.
pub struct SharedAllocator;

unsafe impl GlobalAlloc for SharedAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        match try_allocate(&CONTROL, CLIENT_RUST, layout, false) {
            Ok(pointer) => pointer.as_ptr(),
            Err(error) => fatal_rust(error),
        }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        match try_allocate(&CONTROL, CLIENT_RUST, layout, true) {
            Ok(pointer) => pointer.as_ptr(),
            Err(error) => fatal_rust(error),
        }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        if try_deallocate(&CONTROL, pointer, CLIENT_RUST, Some(layout)).is_err() {
            fatal_rust(AllocationFailure::Invariant);
        }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        match try_reallocate(&CONTROL, pointer, CLIENT_RUST, Some(layout), new_size) {
            Ok(pointer) => pointer.as_ptr(),
            Err(error) => fatal_rust(error),
        }
    }
}

static CONTROL: Control = Control::new();

/// Installs this process's SQLite callbacks. SQLite itself rejects late
/// configuration; this function never shuts down an active SQLite instance or
/// retries a failed/previous installation.
pub fn install_sqlite_allocator() -> Result<(), SqliteInstallError> {
    {
        let mut guard = CONTROL.lock();
        let state = guard.state();
        if state.epoch_state != EPOCH_BEFORE {
            return Err(SqliteInstallError::EpochAlreadyStarted);
        }
        if state.install_state != INSTALL_NOT_ATTEMPTED {
            return Err(SqliteInstallError::AlreadyAttempted);
        }
        state.install_state = INSTALL_IN_PROGRESS;
    }

    let methods = sqlite_mem_methods();
    // SAFETY: SQLite copies sqlite3_mem_methods during this call. Every callback
    // uses process-local state and the supplied table remains valid for the call.
    let result = unsafe {
        ffi::sqlite3_config(
            ffi::SQLITE_CONFIG_MALLOC,
            &methods as *const ffi::sqlite3_mem_methods,
        )
    };

    let mut guard = CONTROL.lock();
    let state = guard.state();
    if state.install_state != INSTALL_IN_PROGRESS {
        return Err(SqliteInstallError::AccountingInvariant);
    }
    if result == ffi::SQLITE_OK {
        state.install_state = INSTALL_SUCCEEDED;
        Ok(())
    } else {
        state.install_state = INSTALL_FAILED;
        Err(SqliteInstallError::Configuration(result))
    }
}

/// Begins the one irreversible shared-admission epoch after SQLite callback
/// installation and baseline preparation. Returns the Rust requested-live
/// baseline used by the managed observer.
pub fn begin_epoch() -> Result<u64, BeginEpochError> {
    CONTROL.begin_epoch(true)
}

pub fn snapshot() -> AllocatorSnapshot {
    CONTROL.snapshot()
}

/// Exact raw System-layout charge, including wrapper header and alignment pad.
pub fn raw_layout_charge_bytes(layout: Layout) -> Option<u64> {
    let (raw, _) = checked_raw_layout(layout)?;
    u64::try_from(raw.size()).ok()
}

/// The installed SQLite xRoundup size rule, exposed for fixed exact-fill cases.
pub fn sqlite_roundup_bytes(requested: usize) -> Option<usize> {
    sqlite_roundup_size(requested)
}

fn sqlite_mem_methods() -> ffi::sqlite3_mem_methods {
    ffi::sqlite3_mem_methods {
        xMalloc: Some(sqlite_x_malloc),
        xFree: Some(sqlite_x_free),
        xRealloc: Some(sqlite_x_realloc),
        xSize: Some(sqlite_x_size),
        xRoundup: Some(sqlite_x_roundup),
        xInit: Some(sqlite_x_init),
        xShutdown: Some(sqlite_x_shutdown),
        pAppData: ptr::null_mut(),
    }
}

unsafe extern "C" fn sqlite_x_malloc(n_bytes: c_int) -> *mut c_void {
    if n_bytes <= 0 {
        return ptr::null_mut();
    }
    let layout = match Layout::from_size_align(n_bytes as usize, SQLITE_ALIGNMENT) {
        Ok(layout) => layout,
        Err(_) => fatal_invariant(),
    };
    match try_allocate(&CONTROL, CLIENT_SQLITE, layout, false) {
        Ok(pointer) => pointer.as_ptr().cast(),
        Err(AllocationFailure::Quota | AllocationFailure::System) => ptr::null_mut(),
        Err(AllocationFailure::Invariant) => fatal_invariant(),
    }
}

unsafe extern "C" fn sqlite_x_free(pointer: *mut c_void) {
    if pointer.is_null() {
        return;
    }
    if try_deallocate(&CONTROL, pointer.cast(), CLIENT_SQLITE, None).is_err() {
        fatal_invariant();
    }
}

unsafe extern "C" fn sqlite_x_realloc(pointer: *mut c_void, n_bytes: c_int) -> *mut c_void {
    if n_bytes <= 0 {
        if !pointer.is_null() {
            unsafe { sqlite_x_free(pointer) };
        }
        return ptr::null_mut();
    }
    if pointer.is_null() {
        return unsafe { sqlite_x_malloc(n_bytes) };
    }
    match try_reallocate(
        &CONTROL,
        pointer.cast(),
        CLIENT_SQLITE,
        None,
        n_bytes as usize,
    ) {
        Ok(pointer) => pointer.as_ptr().cast(),
        Err(AllocationFailure::Quota | AllocationFailure::System) => ptr::null_mut(),
        Err(AllocationFailure::Invariant) => fatal_invariant(),
    }
}

unsafe extern "C" fn sqlite_x_size(pointer: *mut c_void) -> c_int {
    if pointer.is_null() {
        return 0;
    }
    match block_capacity(&CONTROL, pointer.cast(), CLIENT_SQLITE) {
        Ok(size) => match c_int::try_from(size) {
            Ok(size) => size,
            Err(_) => fatal_invariant(),
        },
        Err(_) => fatal_invariant(),
    }
}

unsafe extern "C" fn sqlite_x_roundup(n_bytes: c_int) -> c_int {
    if n_bytes <= 0 {
        return 0;
    }
    match sqlite_roundup_size(n_bytes as usize) {
        Some(size) => match c_int::try_from(size) {
            Ok(size) => size,
            Err(_) => n_bytes,
        },
        None => n_bytes,
    }
}

unsafe extern "C" fn sqlite_x_init(_app_data: *mut c_void) -> c_int {
    ffi::SQLITE_OK
}

unsafe extern "C" fn sqlite_x_shutdown(_app_data: *mut c_void) {}

fn sqlite_roundup_size(n_bytes: usize) -> Option<usize> {
    if n_bytes == 0 {
        Some(0)
    } else {
        checked_round_up(n_bytes, SQLITE_ALIGNMENT)
    }
}

#[cold]
fn fatal_rust(error: AllocationFailure) -> ! {
    match error {
        AllocationFailure::Quota => fatal_exit(90),
        AllocationFailure::System => fatal_exit(91),
        AllocationFailure::Invariant => fatal_exit(92),
    }
}

#[cold]
fn fatal_invariant() -> ! {
    fatal_exit(92)
}

#[cold]
fn fatal_exit(code: c_int) -> ! {
    // SAFETY: _exit is the required non-unwinding terminal path and performs no
    // Rust formatting, allocation, destructor, or panic work.
    unsafe { libc::_exit(code) }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AllocationFailure {
    Quota,
    System,
    Invariant,
}

#[derive(Clone, Copy)]
struct Header {
    magic: u64,
    raw_size: usize,
    raw_align: usize,
    offset: usize,
    capacity: usize,
    /// Rust's logical size; SQLite retains this at the advertised capacity.
    requested_size: usize,
    requested_align: usize,
    origin: u8,
    client: u8,
    reserved: [u8; 6],
}

// ponytail: one process-wide admission lock; split per client only if isolated-probe contention is measured.
struct Control {
    held: AtomicBool,
    counters: UnsafeCell<Counters>,
}

// All Counters access is serialized by held; the lock is never held while a
// System allocation is pending. System deallocation stays under the lock so a
// concurrent reservation or epoch snapshot cannot observe credit before free.
unsafe impl Sync for Control {}

impl Control {
    const fn new() -> Self {
        Self {
            held: AtomicBool::new(false),
            counters: UnsafeCell::new(Counters::new()),
        }
    }

    fn lock(&self) -> ControlGuard<'_> {
        while self
            .held
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            spin_loop();
        }
        ControlGuard { control: self }
    }

    fn snapshot(&self) -> AllocatorSnapshot {
        let mut guard = self.lock();
        let counters = guard.state();
        AllocatorSnapshot {
            baseline_charged_bytes: counters.baseline_charged,
            baseline_pending_bytes: counters.baseline_pending,
            baseline_high_water_bytes: counters.baseline_high_water,
            query_charged_bytes: counters.query_charged,
            query_pending_bytes: counters.query_pending,
            query_high_water_bytes: counters.query_high_water,
            rust_requested_live_bytes: counters.rust_live,
            rust_requested_pending_bytes: counters.rust_pending,
            rust_requested_peak_bytes: counters.rust_peak.max(counters.rust_live),
            rust_baseline_requested_live_bytes: counters.rust_baseline,
        }
    }

    fn begin_epoch(&self, require_sqlite_installed: bool) -> Result<u64, BeginEpochError> {
        {
            let mut guard = self.lock();
            let counters = guard.state();
            if counters.epoch_state != EPOCH_BEFORE {
                return Err(BeginEpochError::AlreadyStarted);
            }
            if require_sqlite_installed && counters.install_state != INSTALL_SUCCEEDED {
                return Err(BeginEpochError::SqliteAllocatorNotInstalled);
            }
            counters.epoch_state = EPOCH_STARTING;
        }

        loop {
            let mut guard = self.lock();
            let counters = guard.state();
            if counters.epoch_state != EPOCH_STARTING {
                return Err(BeginEpochError::AccountingInvariant);
            }
            if counters.baseline_pending == 0 {
                if CONTROL_STORAGE_BYTES > SHARED_LIMIT_BYTES {
                    counters.epoch_state = EPOCH_FAILED;
                    return Err(BeginEpochError::ControlStorageExceedsLimit);
                }
                counters.query_charged = CONTROL_STORAGE_BYTES;
                counters.query_pending = 0;
                counters.query_high_water = CONTROL_STORAGE_BYTES;
                counters.rust_baseline = counters.rust_live;
                counters.rust_peak = counters.rust_live;
                counters.epoch_state = EPOCH_ACTIVE;
                return Ok(counters.rust_baseline);
            }
            drop(guard);
            spin_loop();
        }
    }
}

struct Counters {
    epoch_state: u8,
    install_state: u8,
    baseline_charged: u64,
    baseline_pending: u64,
    baseline_high_water: u64,
    query_charged: u64,
    query_pending: u64,
    query_high_water: u64,
    rust_live: u64,
    rust_pending: u64,
    rust_peak: u64,
    rust_baseline: u64,
}

impl Counters {
    const fn new() -> Self {
        Self {
            epoch_state: EPOCH_BEFORE,
            install_state: INSTALL_NOT_ATTEMPTED,
            baseline_charged: 0,
            baseline_pending: 0,
            baseline_high_water: 0,
            query_charged: 0,
            query_pending: 0,
            query_high_water: 0,
            rust_live: 0,
            rust_pending: 0,
            rust_peak: 0,
            rust_baseline: 0,
        }
    }
}

struct ControlGuard<'a> {
    control: &'a Control,
}

impl ControlGuard<'_> {
    fn state(&mut self) -> &mut Counters {
        // SAFETY: this guard exclusively owns Control::held until Drop.
        unsafe { &mut *self.control.counters.get() }
    }
}

impl Drop for ControlGuard<'_> {
    fn drop(&mut self) {
        self.control.held.store(false, Ordering::Release);
    }
}

fn try_allocate(
    control: &Control,
    client: u8,
    layout: Layout,
    zeroed: bool,
) -> Result<NonNull<u8>, AllocationFailure> {
    if !matches!(client, CLIENT_RUST | CLIENT_SQLITE) {
        return Err(AllocationFailure::Invariant);
    }
    let (raw_layout, offset) = checked_raw_layout(layout).ok_or(AllocationFailure::Invariant)?;
    let charge = u64::try_from(raw_layout.size()).map_err(|_| AllocationFailure::Invariant)?;
    let origin = reserve(control, client, charge, layout.size())?;

    // SAFETY: raw_layout is a valid non-zero layout containing the header and
    // requested payload; System is also the allocator used for matching frees.
    let raw = unsafe {
        if zeroed {
            System.alloc_zeroed(raw_layout)
        } else {
            System.alloc(raw_layout)
        }
    };
    let Some(raw) = NonNull::new(raw) else {
        finish_reservation(control, origin, client, charge, layout.size(), false)?;
        return Err(AllocationFailure::System);
    };
    // SAFETY: System returned raw_layout-aligned storage of raw_layout.size().
    let payload = unsafe { raw.as_ptr().add(offset) };
    if payload as usize % layout.align() != 0 {
        // SAFETY: raw is the live allocation returned above with raw_layout.
        unsafe { System.dealloc(raw.as_ptr(), raw_layout) };
        finish_reservation(control, origin, client, charge, layout.size(), false)?;
        return Err(AllocationFailure::Invariant);
    }
    let header = Header {
        magic: HEADER_MAGIC,
        raw_size: raw_layout.size(),
        raw_align: raw_layout.align(),
        offset,
        capacity: layout.size(),
        requested_size: layout.size(),
        requested_align: layout.align(),
        origin,
        client,
        reserved: [0; 6],
    };
    // SAFETY: offset is at least HEADER_SIZE and header address is aligned by
    // checked_raw_layout; it lies wholly within the raw System allocation.
    unsafe { ptr::write(payload.sub(size_of::<Header>()).cast::<Header>(), header) };
    finish_reservation(control, origin, client, charge, layout.size(), true)?;
    // SAFETY: System gave non-null, aligned storage and offset lies in its layout.
    Ok(unsafe { NonNull::new_unchecked(payload) })
}

fn reserve(
    control: &Control,
    client: u8,
    charge: u64,
    rust_bytes: usize,
) -> Result<u8, AllocationFailure> {
    loop {
        let mut guard = control.lock();
        let counters = guard.state();
        match counters.epoch_state {
            EPOCH_BEFORE => {
                let next_baseline_pending = counters
                    .baseline_pending
                    .checked_add(charge)
                    .and_then(|pending| counters.baseline_charged.checked_add(pending))
                    .ok_or(AllocationFailure::Invariant)?;
                let next_rust_pending = checked_rust_pending(counters, client, rust_bytes)?;
                counters.baseline_pending = next_baseline_pending - counters.baseline_charged;
                counters.rust_pending = next_rust_pending;
                return Ok(ORIGIN_BASELINE);
            }
            EPOCH_STARTING => {
                drop(guard);
                spin_loop();
            }
            EPOCH_ACTIVE => {
                let next_query = counters
                    .query_charged
                    .checked_add(charge)
                    .ok_or(AllocationFailure::Invariant)?;
                if next_query > SHARED_LIMIT_BYTES {
                    return Err(AllocationFailure::Quota);
                }
                let next_query_pending = counters
                    .query_pending
                    .checked_add(charge)
                    .ok_or(AllocationFailure::Invariant)?;
                let next_rust_pending = checked_rust_pending(counters, client, rust_bytes)?;
                counters.query_charged = next_query;
                counters.query_pending = next_query_pending;
                counters.query_high_water = counters.query_high_water.max(next_query);
                counters.rust_pending = next_rust_pending;
                return Ok(ORIGIN_QUERY);
            }
            _ => return Err(AllocationFailure::Invariant),
        }
    }
}

fn checked_rust_pending(
    counters: &Counters,
    client: u8,
    rust_bytes: usize,
) -> Result<u64, AllocationFailure> {
    if client != CLIENT_RUST {
        return Ok(counters.rust_pending);
    }
    let bytes = u64::try_from(rust_bytes).map_err(|_| AllocationFailure::Invariant)?;
    counters
        .rust_live
        .checked_add(counters.rust_pending)
        .and_then(|value| value.checked_add(bytes))
        .ok_or(AllocationFailure::Invariant)?;
    counters
        .rust_pending
        .checked_add(bytes)
        .ok_or(AllocationFailure::Invariant)
}

fn finish_reservation(
    control: &Control,
    origin: u8,
    client: u8,
    charge: u64,
    rust_bytes: usize,
    succeeded: bool,
) -> Result<(), AllocationFailure> {
    let rust_bytes = u64::try_from(rust_bytes).map_err(|_| AllocationFailure::Invariant)?;
    let mut guard = control.lock();
    let counters = guard.state();

    let next_rust_pending = if client == CLIENT_RUST {
        Some(
            counters
                .rust_pending
                .checked_sub(rust_bytes)
                .ok_or(AllocationFailure::Invariant)?,
        )
    } else {
        None
    };
    let (next_baseline_pending, next_baseline_charged) = if origin == ORIGIN_BASELINE {
        let pending = counters
            .baseline_pending
            .checked_sub(charge)
            .ok_or(AllocationFailure::Invariant)?;
        let charged = if succeeded {
            counters
                .baseline_charged
                .checked_add(charge)
                .ok_or(AllocationFailure::Invariant)?
        } else {
            counters.baseline_charged
        };
        (Some(pending), Some(charged))
    } else if origin == ORIGIN_QUERY {
        (None, None)
    } else {
        return Err(AllocationFailure::Invariant);
    };
    let (next_query_pending, next_query_charged) = if origin == ORIGIN_QUERY {
        let pending = counters
            .query_pending
            .checked_sub(charge)
            .ok_or(AllocationFailure::Invariant)?;
        let charged = if succeeded {
            counters.query_charged
        } else {
            counters
                .query_charged
                .checked_sub(charge)
                .ok_or(AllocationFailure::Invariant)?
        };
        if succeeded && charged < CONTROL_STORAGE_BYTES {
            return Err(AllocationFailure::Invariant);
        }
        (Some(pending), Some(charged))
    } else {
        (None, None)
    };
    let next_rust_live = if client == CLIENT_RUST && succeeded {
        Some(
            counters
                .rust_live
                .checked_add(rust_bytes)
                .ok_or(AllocationFailure::Invariant)?,
        )
    } else {
        None
    };

    if let Some(value) = next_baseline_pending {
        counters.baseline_pending = value;
    }
    if let Some(value) = next_baseline_charged {
        counters.baseline_charged = value;
        counters.baseline_high_water = counters.baseline_high_water.max(value);
    }
    if let Some(value) = next_query_pending {
        counters.query_pending = value;
    }
    if let Some(value) = next_query_charged {
        counters.query_charged = value;
    }
    if let Some(value) = next_rust_pending {
        counters.rust_pending = value;
    }
    if let Some(value) = next_rust_live {
        counters.rust_live = value;
        counters.rust_peak = counters.rust_peak.max(value);
    }
    Ok(())
}

fn try_deallocate(
    control: &Control,
    pointer: *mut u8,
    client: u8,
    rust_layout: Option<Layout>,
) -> Result<(), AllocationFailure> {
    let (header, raw, raw_layout) = inspect_block(control, pointer, client)?;
    if let Some(layout) = rust_layout {
        if layout.size() != header.requested_size || layout.align() != header.requested_align {
            return Err(AllocationFailure::Invariant);
        }
    }
    release_block(control, header, raw, raw_layout)
}

fn release_block(
    control: &Control,
    header: Header,
    raw: *mut u8,
    raw_layout: Layout,
) -> Result<(), AllocationFailure> {
    let mut guard = control.lock();
    let counters = guard.state();
    let (next_baseline, next_query) = match header.origin {
        ORIGIN_BASELINE => (
            Some(
                counters
                    .baseline_charged
                    .checked_sub(raw_layout.size() as u64)
                    .ok_or(AllocationFailure::Invariant)?,
            ),
            None,
        ),
        ORIGIN_QUERY => {
            if counters.epoch_state != EPOCH_ACTIVE {
                return Err(AllocationFailure::Invariant);
            }
            let query = counters
                .query_charged
                .checked_sub(raw_layout.size() as u64)
                .ok_or(AllocationFailure::Invariant)?;
            if query < CONTROL_STORAGE_BYTES {
                return Err(AllocationFailure::Invariant);
            }
            (None, Some(query))
        }
        _ => return Err(AllocationFailure::Invariant),
    };
    let next_rust_live = if header.client == CLIENT_RUST {
        Some(
            counters
                .rust_live
                .checked_sub(header.requested_size as u64)
                .ok_or(AllocationFailure::Invariant)?,
        )
    } else {
        None
    };

    // SAFETY: raw/raw_layout came from inspect_block for this live block.
    unsafe { System.dealloc(raw, raw_layout) };
    if let Some(value) = next_baseline {
        counters.baseline_charged = value;
    }
    if let Some(value) = next_query {
        counters.query_charged = value;
    }
    if let Some(value) = next_rust_live {
        counters.rust_live = value;
    }
    Ok(())
}

fn try_reallocate(
    control: &Control,
    pointer: *mut u8,
    client: u8,
    rust_layout: Option<Layout>,
    new_size: usize,
) -> Result<NonNull<u8>, AllocationFailure> {
    let (old, _raw, _raw_layout) = inspect_block(control, pointer, client)?;
    if let Some(layout) = rust_layout {
        if layout.size() != old.requested_size || layout.align() != old.requested_align {
            return Err(AllocationFailure::Invariant);
        }
    }
    if client == CLIENT_SQLITE && new_size <= old.capacity {
        // SQLite xSize exposes retained capacity as usable allocation size. Keep
        // requested_size at that capacity so later growth preserves the full
        // extent SQLite can legally still use; no new System block is needed.
        return NonNull::new(pointer).ok_or(AllocationFailure::Invariant);
    }
    if new_size <= old.requested_size {
        let decrease = old.requested_size - new_size;
        let mut guard = control.lock();
        let counters = guard.state();
        let next_rust_live = if client == CLIENT_RUST {
            Some(
                counters
                    .rust_live
                    .checked_sub(decrease as u64)
                    .ok_or(AllocationFailure::Invariant)?,
            )
        } else {
            None
        };
        let mut shrunk = old;
        shrunk.requested_size = new_size;
        // SAFETY: inspect_block validated the in-place header and its exclusive
        // owner may mutate it during realloc. Charge/capacity are unchanged.
        unsafe { ptr::write(pointer.sub(size_of::<Header>()).cast::<Header>(), shrunk) };
        if let Some(value) = next_rust_live {
            counters.rust_live = value;
        }
        return NonNull::new(pointer).ok_or(AllocationFailure::Invariant);
    }

    let new_layout = Layout::from_size_align(new_size, old.requested_align)
        .map_err(|_| AllocationFailure::Invariant)?;
    let replacement = try_allocate(control, client, new_layout, false)?;
    // SAFETY: the replacement is distinct while the original remains live;
    // both are valid for at least old.requested_size bytes.
    unsafe {
        ptr::copy_nonoverlapping(pointer, replacement.as_ptr(), old.requested_size);
    }
    let old_layout = Layout::from_size_align(old.requested_size, old.requested_align)
        .map_err(|_| AllocationFailure::Invariant)?;
    if let Err(error) = try_deallocate(
        control,
        pointer,
        client,
        (client == CLIENT_RUST).then_some(old_layout),
    ) {
        let _ = try_deallocate(
            control,
            replacement.as_ptr(),
            client,
            (client == CLIENT_RUST).then_some(new_layout),
        );
        return Err(error);
    }
    Ok(replacement)
}

fn block_capacity(
    control: &Control,
    pointer: *mut u8,
    client: u8,
) -> Result<usize, AllocationFailure> {
    inspect_block(control, pointer, client).map(|(header, _, _)| header.capacity)
}

fn inspect_block(
    control: &Control,
    pointer: *mut u8,
    client: u8,
) -> Result<(Header, *mut u8, Layout), AllocationFailure> {
    if pointer.is_null() || !matches!(client, CLIENT_RUST | CLIENT_SQLITE) {
        return Err(AllocationFailure::Invariant);
    }
    // SAFETY: callers pass a live pointer returned by this allocator. The
    // immediately preceding header is inside its original System allocation.
    let header_pointer = unsafe { pointer.sub(size_of::<Header>()).cast::<Header>() };
    if header_pointer as usize % align_of::<Header>() != 0 {
        return Err(AllocationFailure::Invariant);
    }
    // SAFETY: the allocation path initialized every Header field at this address.
    let header = unsafe { ptr::read(header_pointer) };
    if header.magic != HEADER_MAGIC
        || header.client != client
        || !matches!(header.origin, ORIGIN_BASELINE | ORIGIN_QUERY)
        || header.requested_align == 0
        || !header.requested_align.is_power_of_two()
        || header.capacity < header.requested_size
        || header.reserved != [0; 6]
    {
        return Err(AllocationFailure::Invariant);
    }
    let (expected_raw, expected_offset) = checked_raw_layout(
        Layout::from_size_align(header.requested_size, header.requested_align)
            .map_err(|_| AllocationFailure::Invariant)?,
    )
    .ok_or(AllocationFailure::Invariant)?;
    if header.offset != expected_offset
        || header.raw_size
            != expected_offset
                .checked_add(header.capacity)
                .ok_or(AllocationFailure::Invariant)?
        || header.raw_align != expected_raw.align()
        || header.raw_size > isize::MAX as usize
    {
        return Err(AllocationFailure::Invariant);
    }
    let raw_layout = Layout::from_size_align(header.raw_size, header.raw_align)
        .map_err(|_| AllocationFailure::Invariant)?;
    if raw_layout.size() != header.raw_size {
        return Err(AllocationFailure::Invariant);
    }
    // SAFETY: header.offset was checked against the valid raw layout shape.
    let raw = unsafe { pointer.sub(header.offset) };
    if raw as usize % header.raw_align != 0
        || pointer as usize % header.requested_align != 0
        || (header_pointer as usize) % align_of::<Header>() != 0
    {
        return Err(AllocationFailure::Invariant);
    }
    let mut guard = control.lock();
    let counters = guard.state();
    if header.origin == ORIGIN_QUERY && counters.epoch_state != EPOCH_ACTIVE {
        return Err(AllocationFailure::Invariant);
    }
    Ok((header, raw, raw_layout))
}

fn checked_raw_layout(layout: Layout) -> Option<(Layout, usize)> {
    let offset = checked_round_up(size_of::<Header>(), layout.align())?;
    let size = offset.checked_add(layout.size())?;
    let alignment = layout.align().max(align_of::<Header>());
    let raw = Layout::from_size_align(size, alignment).ok()?;
    Some((raw, offset))
}

fn checked_round_up(value: usize, alignment: usize) -> Option<usize> {
    if alignment == 0 || !alignment.is_power_of_two() {
        return None;
    }
    value
        .checked_add(alignment - 1)
        .map(|sum| sum & !(alignment - 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout_for_charge(charge: u64, alignment: usize) -> Layout {
        let header_offset = checked_round_up(size_of::<Header>(), alignment).unwrap();
        let payload = usize::try_from(charge).unwrap() - header_offset;
        let layout = Layout::from_size_align(payload, alignment).unwrap();
        assert_eq!(checked_raw_layout(layout).unwrap().0.size() as u64, charge);
        layout
    }

    fn allocate_rust(control: &Control, layout: Layout, zeroed: bool) -> NonNull<u8> {
        try_allocate(control, CLIENT_RUST, layout, zeroed).unwrap()
    }

    fn allocate_sqlite(control: &Control, layout: Layout) -> NonNull<u8> {
        try_allocate(control, CLIENT_SQLITE, layout, false).unwrap()
    }

    fn free_rust(control: &Control, pointer: NonNull<u8>, layout: Layout) {
        try_deallocate(control, pointer.as_ptr(), CLIENT_RUST, Some(layout)).unwrap();
    }

    fn free_sqlite(control: &Control, pointer: NonNull<u8>) {
        try_deallocate(control, pointer.as_ptr(), CLIENT_SQLITE, None).unwrap();
    }

    #[test]
    fn layout_alignment_zeroing_and_actual_free_credit() {
        let control = Control::new();
        for alignment in [1, 8, 16, 64, 4096] {
            for size in [128, 512] {
                let layout = Layout::from_size_align(size, alignment).unwrap();
                let pointer = allocate_rust(&control, layout, true);
                assert_eq!(pointer.as_ptr() as usize % alignment, 0);
                // SAFETY: this test allocated exactly layout.size() zeroed bytes.
                let bytes = unsafe { std::slice::from_raw_parts(pointer.as_ptr(), size) };
                assert!(bytes.iter().all(|byte| *byte == 0));
                // SAFETY: exclusively owned payload; initialize for realloc copy check.
                unsafe { ptr::write_bytes(pointer.as_ptr(), 0x5a, size) };
                let grown = try_reallocate(
                    &control,
                    pointer.as_ptr(),
                    CLIENT_RUST,
                    Some(layout),
                    size + 32,
                )
                .unwrap();
                assert_eq!(grown.as_ptr() as usize % alignment, 0);
                // SAFETY: realloc copied the original size into the larger allocation.
                let copied = unsafe { std::slice::from_raw_parts(grown.as_ptr(), size) };
                assert!(copied.iter().all(|byte| *byte == 0x5a));
                let new_layout = Layout::from_size_align(size + 32, alignment).unwrap();
                free_rust(&control, grown, new_layout);
                assert_eq!(control.snapshot().baseline_charged_bytes, 0);
            }
        }

        let sqlite_layout = Layout::from_size_align(128, SQLITE_ALIGNMENT).unwrap();
        let sqlite_pointer = allocate_sqlite(&control, sqlite_layout);
        assert_eq!(
            block_capacity(&control, sqlite_pointer.as_ptr(), CLIENT_SQLITE),
            Ok(128)
        );
        assert_eq!(sqlite_roundup_size(0), Some(0));
        assert_eq!(
            sqlite_roundup_size(17),
            Some(checked_round_up(17, SQLITE_ALIGNMENT).unwrap())
        );
        // SAFETY: these callback branches do not touch SQLite's global state.
        assert!(unsafe { sqlite_x_malloc(0) }.is_null());
        assert!(unsafe { sqlite_x_realloc(ptr::null_mut(), 0) }.is_null());
        assert_eq!(unsafe { sqlite_x_roundup(0) }, 0);
        assert_eq!(unsafe { sqlite_x_init(ptr::null_mut()) }, ffi::SQLITE_OK);
        // SAFETY: shutdown is a no-op with no acquired allocator resources.
        unsafe { sqlite_x_shutdown(ptr::null_mut()) };
        free_sqlite(&control, sqlite_pointer);
        assert_eq!(control.snapshot().baseline_charged_bytes, 0);
    }

    #[test]
    fn baseline_allocations_freed_during_epoch_receive_no_query_credit() {
        let control = Control::new();
        let rust_layout = Layout::from_size_align(1024, 16).unwrap();
        let sqlite_layout = Layout::from_size_align(1024, SQLITE_ALIGNMENT).unwrap();
        let rust = allocate_rust(&control, rust_layout, false);
        let sqlite = allocate_sqlite(&control, sqlite_layout);
        let baseline = control.snapshot();
        assert!(baseline.baseline_charged_bytes > 2_048);
        assert_eq!(baseline.rust_requested_live_bytes, 1024);
        assert_eq!(control.begin_epoch(false), Ok(1024));
        free_rust(&control, rust, rust_layout);
        free_sqlite(&control, sqlite);
        let after = control.snapshot();
        assert_eq!(after.baseline_charged_bytes, 0);
        assert_eq!(after.query_charged_bytes, CONTROL_STORAGE_BYTES);
        assert_eq!(after.query_pending_bytes, 0);
        assert_eq!(after.rust_requested_live_bytes, 0);
    }

    #[test]
    fn simulated_system_null_rolls_back_only_its_reservation() {
        for origin in [ORIGIN_BASELINE, ORIGIN_QUERY] {
            for failed_client in [CLIENT_RUST, CLIENT_SQLITE] {
                let control = Control::new();
                if origin == ORIGIN_QUERY {
                    assert_eq!(control.begin_epoch(false), Ok(0));
                }
                let rust_layout = Layout::from_size_align(128, 16).unwrap();
                let sqlite_layout = Layout::from_size_align(128, SQLITE_ALIGNMENT).unwrap();
                let rust = allocate_rust(&control, rust_layout, false);
                let sqlite = allocate_sqlite(&control, sqlite_layout);
                // SAFETY: these two live blocks are retained throughout rollback checks.
                unsafe {
                    ptr::write_bytes(rust.as_ptr(), 0x35, rust_layout.size());
                    ptr::write_bytes(sqlite.as_ptr(), 0x53, sqlite_layout.size());
                }
                let live = control.snapshot();

                let pending_client = if failed_client == CLIENT_RUST {
                    CLIENT_SQLITE
                } else {
                    CLIENT_RUST
                };
                let alignment = if pending_client == CLIENT_RUST {
                    16
                } else {
                    SQLITE_ALIGNMENT
                };
                let pending_layout = Layout::from_size_align(96, alignment).unwrap();
                let pending_charge = checked_raw_layout(pending_layout).unwrap().0.size() as u64;
                let pending_origin = reserve(
                    &control,
                    pending_client,
                    pending_charge,
                    pending_layout.size(),
                )
                .unwrap();
                assert_eq!(pending_origin, origin);

                let before_failure = control.snapshot();
                let failed_layout = Layout::from_size_align(
                    48,
                    if failed_client == CLIENT_RUST {
                        16
                    } else {
                        SQLITE_ALIGNMENT
                    },
                )
                .unwrap();
                let failed_charge = checked_raw_layout(failed_layout).unwrap().0.size() as u64;
                let failed_origin =
                    reserve(&control, failed_client, failed_charge, failed_layout.size()).unwrap();
                assert_eq!(failed_origin, origin);
                let during_system_call = control.snapshot();
                if origin == ORIGIN_BASELINE {
                    assert_eq!(
                        during_system_call.baseline_pending_bytes,
                        before_failure.baseline_pending_bytes + failed_charge
                    );
                } else {
                    assert_eq!(
                        during_system_call.query_pending_bytes,
                        before_failure.query_pending_bytes + failed_charge
                    );
                    assert_eq!(
                        during_system_call.query_charged_bytes,
                        before_failure.query_charged_bytes + failed_charge
                    );
                }
                // before_failure already includes the other pending reservation.
                let expected_rust_pending = before_failure.rust_requested_pending_bytes
                    + if failed_client == CLIENT_RUST {
                        failed_layout.size() as u64
                    } else {
                        0
                    };
                assert_eq!(
                    during_system_call.rust_requested_pending_bytes,
                    expected_rust_pending
                );
                // Simulate System returning NULL: roll back only this pending request.
                finish_reservation(
                    &control,
                    failed_origin,
                    failed_client,
                    failed_charge,
                    failed_layout.size(),
                    false,
                )
                .unwrap();

                let after_failure = control.snapshot();
                assert_eq!(
                    after_failure.baseline_charged_bytes,
                    before_failure.baseline_charged_bytes
                );
                assert_eq!(
                    after_failure.baseline_pending_bytes,
                    before_failure.baseline_pending_bytes
                );
                assert_eq!(
                    after_failure.query_charged_bytes,
                    before_failure.query_charged_bytes
                );
                assert_eq!(
                    after_failure.query_pending_bytes,
                    before_failure.query_pending_bytes
                );
                assert_eq!(
                    after_failure.rust_requested_live_bytes,
                    before_failure.rust_requested_live_bytes
                );
                assert_eq!(
                    after_failure.rust_requested_pending_bytes,
                    before_failure.rust_requested_pending_bytes
                );
                assert_eq!(
                    after_failure.rust_requested_peak_bytes,
                    before_failure.rust_requested_peak_bytes
                );
                assert_eq!(
                    after_failure.baseline_high_water_bytes,
                    before_failure.baseline_high_water_bytes
                );
                if origin == ORIGIN_QUERY {
                    assert!(
                        before_failure.query_charged_bytes + failed_charge <= SHARED_LIMIT_BYTES
                    );
                    assert_eq!(
                        after_failure.query_high_water_bytes,
                        before_failure
                            .query_high_water_bytes
                            .max(before_failure.query_charged_bytes + failed_charge)
                    );
                } else {
                    assert_eq!(
                        after_failure.query_high_water_bytes,
                        before_failure.query_high_water_bytes
                    );
                }
                // SAFETY: simulated NULL did not replace or free either existing block.
                assert_eq!(unsafe { *rust.as_ptr() }, 0x35);
                // SAFETY: simulated NULL did not replace or free either existing block.
                assert_eq!(unsafe { *sqlite.as_ptr() }, 0x53);

                finish_reservation(
                    &control,
                    pending_origin,
                    pending_client,
                    pending_charge,
                    pending_layout.size(),
                    false,
                )
                .unwrap();
                let after_pending_rollback = control.snapshot();
                assert_eq!(after_pending_rollback.baseline_pending_bytes, 0);
                assert_eq!(after_pending_rollback.query_pending_bytes, 0);
                assert_eq!(
                    after_pending_rollback.baseline_charged_bytes,
                    live.baseline_charged_bytes
                );
                assert_eq!(
                    after_pending_rollback.query_charged_bytes,
                    live.query_charged_bytes
                );
                assert_eq!(
                    after_pending_rollback.rust_requested_live_bytes,
                    live.rust_requested_live_bytes
                );
                assert_eq!(
                    after_pending_rollback.rust_requested_pending_bytes,
                    live.rust_requested_pending_bytes
                );
                assert_eq!(
                    after_pending_rollback.rust_requested_peak_bytes,
                    after_failure.rust_requested_peak_bytes
                );
                assert_eq!(
                    after_pending_rollback.query_high_water_bytes,
                    after_failure.query_high_water_bytes
                );

                free_rust(&control, rust, rust_layout);
                free_sqlite(&control, sqlite);
                let final_snapshot = control.snapshot();
                assert_eq!(final_snapshot.baseline_charged_bytes, 0);
                assert_eq!(
                    final_snapshot.query_charged_bytes,
                    if origin == ORIGIN_QUERY {
                        CONTROL_STORAGE_BYTES
                    } else {
                        0
                    }
                );
                assert_eq!(final_snapshot.rust_requested_live_bytes, 0);
            }
        }
    }

    #[test]
    fn shared_limit_rejects_before_system_and_preserves_admitted_blocks() {
        let control = Control::new();
        assert_eq!(control.begin_epoch(false), Ok(0));
        let rust_layout = Layout::from_size_align(131_072, 64).unwrap();
        let rust = allocate_rust(&control, rust_layout, false);
        // SAFETY: initialize this admitted payload for the rejection-preservation check.
        unsafe { ptr::write_bytes(rust.as_ptr(), 0x31, rust_layout.size()) };
        let remaining = SHARED_LIMIT_BYTES
            - CONTROL_STORAGE_BYTES
            - checked_raw_layout(rust_layout).unwrap().0.size() as u64;
        let sqlite_layout = layout_for_charge(remaining, SQLITE_ALIGNMENT);
        let sqlite = allocate_sqlite(&control, sqlite_layout);
        // SAFETY: initialize this admitted payload for the rejection-preservation check.
        unsafe { ptr::write_bytes(sqlite.as_ptr(), 0x62, sqlite_layout.size()) };
        let full = control.snapshot();
        assert_eq!(full.query_charged_bytes, SHARED_LIMIT_BYTES);
        assert_eq!(full.query_pending_bytes, 0);

        let refused_layout = Layout::from_size_align(1, SQLITE_ALIGNMENT).unwrap();
        assert_eq!(
            try_allocate(&control, CLIENT_SQLITE, refused_layout, false),
            Err(AllocationFailure::Quota)
        );
        let refused = control.snapshot();
        assert_eq!(refused.query_charged_bytes, SHARED_LIMIT_BYTES);
        assert_eq!(refused.query_pending_bytes, 0);
        // SAFETY: both pointers remain live after quota refusal.
        assert_eq!(unsafe { *rust.as_ptr() }, 0x31);
        // SAFETY: both pointers remain live after quota refusal.
        assert_eq!(unsafe { *sqlite.as_ptr() }, 0x62);

        free_rust(&control, rust, rust_layout);
        free_sqlite(&control, sqlite);
        assert_eq!(
            control.snapshot().query_charged_bytes,
            CONTROL_STORAGE_BYTES
        );
    }

    #[test]
    fn realloc_overlap_failure_preservation_and_conservative_shrink() {
        let control = Control::new();
        assert_eq!(control.begin_epoch(false), Ok(0));
        let sqlite_layout = Layout::from_size_align(16_384, SQLITE_ALIGNMENT).unwrap();
        let sqlite = allocate_sqlite(&control, sqlite_layout);
        // SAFETY: initialize a small prefix of this live SQLite-owned allocation.
        unsafe { ptr::write_bytes(sqlite.as_ptr(), 0x73, 64) };
        let remaining = SHARED_LIMIT_BYTES - control.snapshot().query_charged_bytes;
        let guard_layout = layout_for_charge(remaining, 1);
        let guard = allocate_rust(&control, guard_layout, false);
        assert_eq!(control.snapshot().query_charged_bytes, SHARED_LIMIT_BYTES);

        let grown_layout = Layout::from_size_align(32_768, SQLITE_ALIGNMENT).unwrap();
        assert_eq!(
            try_reallocate(
                &control,
                sqlite.as_ptr(),
                CLIENT_SQLITE,
                None,
                grown_layout.size(),
            ),
            Err(AllocationFailure::Quota)
        );
        assert_eq!(control.snapshot().query_charged_bytes, SHARED_LIMIT_BYTES);
        // SAFETY: failed realloc leaves the original allocation and bytes intact.
        assert!((0..64).all(|index| unsafe { *sqlite.as_ptr().add(index) } == 0x73));

        free_rust(&control, guard, guard_layout);
        let grown = try_reallocate(
            &control,
            sqlite.as_ptr(),
            CLIENT_SQLITE,
            None,
            grown_layout.size(),
        )
        .unwrap();
        // SAFETY: successful realloc preserves the old payload prefix.
        assert!((0..64).all(|index| unsafe { *grown.as_ptr().add(index) } == 0x73));
        let after_grow = control.snapshot();
        assert_eq!(
            after_grow.query_charged_bytes,
            CONTROL_STORAGE_BYTES + checked_raw_layout(grown_layout).unwrap().0.size() as u64
        );
        assert!(after_grow.query_high_water_bytes >= SHARED_LIMIT_BYTES);

        let shrink = try_reallocate(&control, grown.as_ptr(), CLIENT_SQLITE, None, 4096).unwrap();
        assert_eq!(shrink, grown);
        assert_eq!(
            control.snapshot().query_charged_bytes,
            after_grow.query_charged_bytes
        );
        assert_eq!(
            block_capacity(&control, shrink.as_ptr(), CLIENT_SQLITE),
            Ok(32_768)
        );
        free_sqlite(&control, shrink);
        assert_eq!(
            control.snapshot().query_charged_bytes,
            CONTROL_STORAGE_BYTES
        );
    }

    #[test]
    fn sqlite_shrink_regrow_preserves_advertised_capacity_bytes() {
        let control = Control::new();
        assert_eq!(control.begin_epoch(false), Ok(0));
        let old_layout = Layout::from_size_align(256, SQLITE_ALIGNMENT).unwrap();
        let old = allocate_sqlite(&control, old_layout);
        for index in 0..old_layout.size() {
            // SAFETY: the test owns the full 256-byte SQLite payload.
            unsafe { old.as_ptr().add(index).write(index as u8) };
        }
        let initial_charge = checked_raw_layout(old_layout).unwrap().0.size() as u64;

        let shrunk = try_reallocate(&control, old.as_ptr(), CLIENT_SQLITE, None, 64).unwrap();
        assert_eq!(
            block_capacity(&control, shrunk.as_ptr(), CLIENT_SQLITE),
            Ok(256)
        );
        assert_eq!(
            control.snapshot().query_charged_bytes,
            CONTROL_STORAGE_BYTES + initial_charge
        );

        let regrown = try_reallocate(&control, shrunk.as_ptr(), CLIENT_SQLITE, None, 128).unwrap();
        assert_eq!(
            block_capacity(&control, regrown.as_ptr(), CLIENT_SQLITE),
            Ok(256)
        );
        for index in 0..128 {
            // SAFETY: xSize-advertised capacity is retained across this regrow.
            assert_eq!(unsafe { *regrown.as_ptr().add(index) }, index as u8);
        }

        let replacement_layout = Layout::from_size_align(512, SQLITE_ALIGNMENT).unwrap();
        let replacement = try_reallocate(
            &control,
            regrown.as_ptr(),
            CLIENT_SQLITE,
            None,
            replacement_layout.size(),
        )
        .unwrap();
        assert_eq!(
            block_capacity(&control, replacement.as_ptr(), CLIENT_SQLITE),
            Ok(512)
        );
        for index in 0..256 {
            // SAFETY: growth copied the complete previously advertised capacity.
            assert_eq!(unsafe { *replacement.as_ptr().add(index) }, index as u8);
        }
        let snapshot = control.snapshot();
        assert_eq!(
            snapshot.query_charged_bytes,
            CONTROL_STORAGE_BYTES + checked_raw_layout(replacement_layout).unwrap().0.size() as u64
        );
        assert!(
            snapshot.query_high_water_bytes
                >= CONTROL_STORAGE_BYTES
                    + initial_charge
                    + checked_raw_layout(replacement_layout).unwrap().0.size() as u64
        );
        free_sqlite(&control, replacement);
        assert_eq!(
            control.snapshot().query_charged_bytes,
            CONTROL_STORAGE_BYTES
        );
    }

    #[test]
    fn baseline_to_query_realloc_is_fully_charged() {
        let control = Control::new();
        let old_layout = Layout::from_size_align(128, 16).unwrap();
        let old = allocate_rust(&control, old_layout, false);
        // SAFETY: initialize this live allocation for copy verification.
        unsafe { ptr::write_bytes(old.as_ptr(), 0x4d, old_layout.size()) };
        assert_eq!(control.begin_epoch(false), Ok(128));

        let new_layout = Layout::from_size_align(256, 16).unwrap();
        let new = try_reallocate(
            &control,
            old.as_ptr(),
            CLIENT_RUST,
            Some(old_layout),
            new_layout.size(),
        )
        .unwrap();
        // SAFETY: successful realloc copied all 128 old bytes.
        assert!((0..128).all(|index| unsafe { *new.as_ptr().add(index) } == 0x4d));
        let raw_charge = checked_raw_layout(new_layout).unwrap().0.size() as u64;
        let after = control.snapshot();
        assert_eq!(after.baseline_charged_bytes, 0);
        assert_eq!(
            after.query_charged_bytes,
            CONTROL_STORAGE_BYTES + raw_charge
        );
        assert_eq!(after.rust_requested_live_bytes, 256);
        assert!(after.rust_requested_peak_bytes >= 384);
        free_rust(&control, new, new_layout);
        assert_eq!(
            control.snapshot().query_charged_bytes,
            CONTROL_STORAGE_BYTES
        );
    }

    #[test]
    fn concurrent_reservations_stay_within_the_shared_limit() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };

        const WORKERS: usize = 4;
        let control = Arc::new(Control::new());
        assert_eq!(control.begin_epoch(false), Ok(0));
        let start = Arc::new(AtomicBool::new(false));
        let release = Arc::new(AtomicBool::new(false));
        let attempted = Arc::new(AtomicUsize::new(0));
        let layout = Layout::from_size_align(600_000, 64).unwrap();
        let mut workers = Vec::with_capacity(WORKERS);

        for _ in 0..WORKERS {
            let control = Arc::clone(&control);
            let worker_start = Arc::clone(&start);
            let worker_release = Arc::clone(&release);
            let attempted = Arc::clone(&attempted);
            match std::thread::Builder::new().spawn(move || {
                while !worker_start.load(Ordering::Acquire) {
                    spin_loop();
                }
                let allocation = try_allocate(&control, CLIENT_RUST, layout, false);
                attempted.fetch_add(1, Ordering::Release);
                while !worker_release.load(Ordering::Acquire) {
                    spin_loop();
                }
                match allocation {
                    Ok(pointer) => {
                        try_deallocate(&control, pointer.as_ptr(), CLIENT_RUST, Some(layout))
                            .unwrap();
                        Ok(true)
                    }
                    Err(AllocationFailure::Quota) => Ok(false),
                    Err(error) => Err(error),
                }
            }) {
                Ok(worker) => workers.push(worker),
                Err(_) => {
                    start.store(true, Ordering::Release);
                    release.store(true, Ordering::Release);
                    for worker in workers {
                        let _ = worker.join();
                    }
                    panic!("could not start concurrent allocator test thread");
                }
            }
        }

        start.store(true, Ordering::Release);
        while attempted.load(Ordering::Acquire) != WORKERS {
            spin_loop();
        }
        let held = control.snapshot();
        release.store(true, Ordering::Release);
        assert!(held.query_charged_bytes <= SHARED_LIMIT_BYTES);
        assert_eq!(held.query_pending_bytes, 0);
        let mut successes = 0;
        let mut rejections = 0;
        for worker in workers {
            match worker.join().unwrap() {
                Ok(true) => successes += 1,
                Ok(false) => rejections += 1,
                Err(error) => panic!("unexpected allocation failure: {error:?}"),
            }
        }
        assert!(successes > 0);
        assert!(rejections > 0);
        assert_eq!(
            control.snapshot().query_charged_bytes,
            CONTROL_STORAGE_BYTES
        );
    }

    #[test]
    fn checked_layout_arithmetic_rejects_overflow_without_allocating() {
        assert_eq!(checked_round_up(usize::MAX, 4096), None);
        assert_eq!(checked_round_up(1, 0), None);
        assert_eq!(checked_round_up(1, 3), None);
        let enormous = Layout::from_size_align(isize::MAX as usize, 1).unwrap();
        assert_eq!(checked_raw_layout(enormous), None);
        assert_eq!(sqlite_roundup_size(usize::MAX), None);
    }
}
