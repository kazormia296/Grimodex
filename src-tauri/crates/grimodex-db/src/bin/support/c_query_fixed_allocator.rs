//! Product worker only. Disjoint, statically backed Talc 5.1.1 Manual heaps;
//! Q is the Rust/SQLite default, and S is available only in an explicit scope.
use super::WORKER_ALLOCATOR;
use rusqlite::ffi;
use std::{
    alloc::{GlobalAlloc, Layout},
    cell::{Cell, UnsafeCell},
    ffi::{c_int, c_void},
    mem::size_of,
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
        Once,
    },
};
use talc::{lock_api::RawMutex, source::Manual, TalcLock};

pub const QUERY_BYTES: usize = 1_572_864;
pub const SCRATCH_BYTES: usize = 64 * 1024 * 1024;
const SCRATCH_OPEN: u8 = 0;
const SCRATCH_ACTIVE: u8 = 1;
const SCRATCH_SEALING: u8 = 2;
const SCRATCH_SEALED: u8 = 3;

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SqliteAllocationKind {
    XMalloc = 1,
    XRealloc = 2,
}

#[cfg_attr(not(feature = "nir1-c-query-test-seam"), allow(dead_code))]
#[derive(Clone, Copy)]
struct SqliteAllocationRequest {
    kind: SqliteAllocationKind,
    requested: usize,
    old_capacity: usize,
}

#[cfg(feature = "nir1-c-query-test-seam")]
const FAILURE_EMPTY: u8 = 0;
#[cfg(feature = "nir1-c-query-test-seam")]
const FAILURE_WRITING: u8 = 1;
#[cfg(feature = "nir1-c-query-test-seam")]
const FAILURE_READY: u8 = 2;

#[cfg(feature = "nir1-c-query-test-seam")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SqliteAllocationFailureReceipt {
    pub kind: SqliteAllocationKind,
    pub requested: usize,
    pub old_capacity: usize,
    pub claimed: usize,
    pub available: usize,
}

#[cfg(feature = "nir1-c-query-test-seam")]
struct FirstSqliteAllocationFailure {
    enabled: AtomicBool,
    state: AtomicU8,
    kind: AtomicU8,
    requested: AtomicUsize,
    old_capacity: AtomicUsize,
    claimed: AtomicUsize,
    available: AtomicUsize,
}

#[cfg(feature = "nir1-c-query-test-seam")]
impl FirstSqliteAllocationFailure {
    const fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            state: AtomicU8::new(FAILURE_EMPTY),
            kind: AtomicU8::new(0),
            requested: AtomicUsize::new(0),
            old_capacity: AtomicUsize::new(0),
            claimed: AtomicUsize::new(0),
            available: AtomicUsize::new(0),
        }
    }
}

#[cfg(feature = "nir1-c-query-test-seam")]
const _: () = assert!(size_of::<FirstSqliteAllocationFailure>() <= 64);

thread_local! {
    static SCRATCH_SCOPE: Cell<*const WorkerAllocator> = const { Cell::new(ptr::null()) };
}

struct Spin(AtomicBool);
unsafe impl RawMutex for Spin {
    const INIT: Self = Self(AtomicBool::new(false));
    type GuardMarker = talc::lock_api::GuardSend;
    fn lock(&self) {
        while self
            .0
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            std::hint::spin_loop();
        }
    }
    fn try_lock(&self) -> bool {
        self.0
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_ok()
    }
    unsafe fn unlock(&self) {
        self.0.store(false, Ordering::Release);
    }
}

type Heap = TalcLock<Spin, Manual>;
#[repr(C, align(16))]
struct Region<const N: usize> {
    heap: Heap,
    backing: UnsafeCell<[u8; N]>,
}
// Talc mutates the claimed backing only while holding its lock.
unsafe impl<const N: usize> Sync for Region<N> {}
impl<const N: usize> Region<N> {
    const fn new() -> Self {
        Self {
            heap: Heap::new(Manual),
            backing: UnsafeCell::new([0; N]),
        }
    }
    fn claim(&self) -> bool {
        // SAFETY: each region is claimed once and remains static until process exit.
        unsafe {
            self.heap
                .lock()
                .claim((*self.backing.get()).as_mut_ptr(), N)
                .is_some()
        }
    }
    fn contains(&self, ptr: *mut u8) -> bool {
        let start = self.backing.get() as usize;
        let address = ptr as usize;
        address >= start && address - start < N
    }
}

// Count Talc controls and allocator state against Q; the fixed 64-byte reserve
// also covers the opt-in receipt. The TLS owner pointer is included; S stays in S.
const QUERY_DATA: usize = QUERY_BYTES
    - size_of::<Region<0>>()
    - size_of::<Once>() * 2
    - size_of::<AtomicU8>()
    - size_of::<AtomicUsize>()
    - size_of::<*const WorkerAllocator>()
    - 64;
const SCRATCH_DATA: usize = SCRATCH_BYTES - size_of::<Region<0>>() - 64;

pub struct WorkerAllocator {
    query: Region<QUERY_DATA>,
    scratch: Region<SCRATCH_DATA>,
    query_once: Once,
    scratch_once: Once,
    scratch_state: AtomicU8,
    scratch_live: AtomicUsize,
    #[cfg(feature = "nir1-c-query-test-seam")]
    sqlite_failure_receipt: FirstSqliteAllocationFailure,
}
const _: () = assert!(
    size_of::<WorkerAllocator>() - size_of::<Region<SCRATCH_DATA>>()
        + size_of::<*const WorkerAllocator>()
        <= QUERY_BYTES
);
const _: () = assert!(size_of::<Region<SCRATCH_DATA>>() <= SCRATCH_BYTES);

#[allow(dead_code)] // Registration callsites opt into this only at proven temporary-owner boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScratchScopeError {
    AlreadyActive,
    Sealed,
}

struct ScratchScopeGuard<'a>(&'a WorkerAllocator);
impl Drop for ScratchScopeGuard<'_> {
    fn drop(&mut self) {
        SCRATCH_SCOPE.with(|scope| scope.set(ptr::null()));
        self.0.scratch_state.store(SCRATCH_OPEN, Ordering::Release);
    }
}

impl WorkerAllocator {
    pub const fn new() -> Self {
        Self {
            query: Region::new(),
            scratch: Region::new(),
            query_once: Once::new(),
            scratch_once: Once::new(),
            scratch_state: AtomicU8::new(SCRATCH_OPEN),
            scratch_live: AtomicUsize::new(0),
            #[cfg(feature = "nir1-c-query-test-seam")]
            sqlite_failure_receipt: FirstSqliteAllocationFailure::new(),
        }
    }

    fn init_query(&self) {
        self.query_once.call_once(|| {
            if !self.query.claim() {
                std::process::abort();
            }
        });
    }

    fn init_scratch(&self) {
        self.scratch_once.call_once(|| {
            if !self.scratch.claim() {
                std::process::abort();
            }
        });
    }

    fn query_alloc(&self, layout: Layout) -> *mut u8 {
        self.query_alloc_with_sqlite_failure(layout, None)
    }

    fn query_alloc_for_sqlite(&self, layout: Layout, failure: SqliteAllocationRequest) -> *mut u8 {
        self.query_alloc_with_sqlite_failure(layout, Some(failure))
    }

    fn query_alloc_with_sqlite_failure(
        &self,
        layout: Layout,
        failure: Option<SqliteAllocationRequest>,
    ) -> *mut u8 {
        #[cfg(not(feature = "nir1-c-query-test-seam"))]
        let _ = failure;
        if layout.size() > QUERY_BYTES {
            #[cfg(feature = "nir1-c-query-test-seam")]
            if let Some(failure) = failure {
                if self.sqlite_failure_receipt_enabled() {
                    let heap = self.query.heap.lock();
                    let counters = heap.counters();
                    self.record_sqlite_allocation_failure(
                        failure,
                        counters.claimed_bytes,
                        counters.available_bytes,
                    );
                }
            }
            return ptr::null_mut();
        }
        self.init_query();
        // SAFETY: Talc owns the claimed Q region and serializes heap mutation.
        let allocation = unsafe { self.query.heap.alloc(layout) };
        #[cfg(feature = "nir1-c-query-test-seam")]
        if allocation.is_null() && self.sqlite_failure_receipt_enabled() {
            if let Some(failure) = failure {
                let (claimed, available) = {
                    let heap = self.query.heap.lock();
                    let counters = heap.counters();
                    (counters.claimed_bytes, counters.available_bytes)
                };
                self.record_sqlite_allocation_failure(failure, claimed, available);
            }
        }
        allocation
    }

    #[cfg(feature = "nir1-c-query-test-seam")]
    pub fn enable_sqlite_failure_receipt(&self, enabled: bool) {
        self.sqlite_failure_receipt
            .enabled
            .store(enabled, Ordering::Release);
    }

    #[cfg(feature = "nir1-c-query-test-seam")]
    fn sqlite_failure_receipt_enabled(&self) -> bool {
        self.sqlite_failure_receipt.enabled.load(Ordering::Acquire)
    }

    #[cfg(feature = "nir1-c-query-test-seam")]
    fn record_sqlite_allocation_failure(
        &self,
        failure: SqliteAllocationRequest,
        claimed: usize,
        available: usize,
    ) {
        let receipt = &self.sqlite_failure_receipt;
        if !receipt.enabled.load(Ordering::Acquire)
            || receipt
                .state
                .compare_exchange(
                    FAILURE_EMPTY,
                    FAILURE_WRITING,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_err()
        {
            return;
        }
        receipt.kind.store(failure.kind as u8, Ordering::Relaxed);
        receipt
            .requested
            .store(failure.requested, Ordering::Relaxed);
        receipt
            .old_capacity
            .store(failure.old_capacity, Ordering::Relaxed);
        receipt.claimed.store(claimed, Ordering::Relaxed);
        receipt.available.store(available, Ordering::Relaxed);
        receipt.state.store(FAILURE_READY, Ordering::Release);
    }

    #[cfg(feature = "nir1-c-query-test-seam")]
    pub fn sqlite_failure_receipt(&self) -> Option<SqliteAllocationFailureReceipt> {
        let receipt = &self.sqlite_failure_receipt;
        if receipt.state.load(Ordering::Acquire) != FAILURE_READY {
            return None;
        }
        let kind = match receipt.kind.load(Ordering::Relaxed) {
            value if value == SqliteAllocationKind::XMalloc as u8 => SqliteAllocationKind::XMalloc,
            value if value == SqliteAllocationKind::XRealloc as u8 => {
                SqliteAllocationKind::XRealloc
            }
            _ => return None,
        };
        Some(SqliteAllocationFailureReceipt {
            kind,
            requested: receipt.requested.load(Ordering::Relaxed),
            old_capacity: receipt.old_capacity.load(Ordering::Relaxed),
            claimed: receipt.claimed.load(Ordering::Relaxed),
            available: receipt.available.load(Ordering::Relaxed),
        })
    }

    #[cfg(feature = "nir1-c-query-test-seam")]
    fn record_sqlite_allocation_failure_without_talc_attempt(
        &self,
        failure: SqliteAllocationRequest,
    ) {
        if !self.sqlite_failure_receipt_enabled() {
            return;
        }
        let heap = self.query.heap.lock();
        let counters = heap.counters();
        self.record_sqlite_allocation_failure(
            failure,
            counters.claimed_bytes,
            counters.available_bytes,
        );
    }

    fn scratch_scope_is_current(&self) -> bool {
        SCRATCH_SCOPE.with(|scope| scope.get() == self as *const Self)
    }

    fn scratch_alloc(&self, layout: Layout) -> *mut u8 {
        if layout.size() > SCRATCH_BYTES
            || self.scratch_state.load(Ordering::Acquire) != SCRATCH_ACTIVE
            || !self.scratch_scope_is_current()
        {
            return ptr::null_mut();
        }
        self.init_scratch();
        // SAFETY: this thread owns the explicit S scope; Talc serializes the heap.
        let allocation = unsafe { self.scratch.heap.alloc(layout) };
        if !allocation.is_null()
            && self
                .scratch_live
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |live| {
                    live.checked_add(1)
                })
                .is_err()
        {
            // The count cannot overflow for a 64 MiB heap; still fail closed.
            unsafe { self.scratch.heap.dealloc(allocation, layout) };
            return ptr::null_mut();
        }
        allocation
    }

    /// Run one synchronous, non-nested Rust allocation scope on S.
    /// SQLite callbacks bypass this selector and always allocate in Q.
    #[allow(dead_code)] // The shared library receives this only through the worker callback.
    pub fn with_scratch_scope<R>(
        &self,
        operation: impl FnOnce() -> R,
    ) -> Result<R, ScratchScopeError> {
        if SCRATCH_SCOPE.with(|scope| !scope.get().is_null()) {
            return Err(ScratchScopeError::AlreadyActive);
        }
        if self.scratch_state.load(Ordering::Acquire) != SCRATCH_OPEN {
            return Err(ScratchScopeError::Sealed);
        }
        self.init_scratch();
        if let Err(state) = self.scratch_state.compare_exchange(
            SCRATCH_OPEN,
            SCRATCH_ACTIVE,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            return Err(if state == SCRATCH_ACTIVE {
                ScratchScopeError::AlreadyActive
            } else {
                ScratchScopeError::Sealed
            });
        }
        SCRATCH_SCOPE.with(|scope| scope.set(self as *const Self));
        let guard = ScratchScopeGuard(self);
        let value = operation();
        drop(guard);
        Ok(value)
    }

    /// Permanently disable S, but only when no scope or S allocation remains.
    pub fn seal_scratch(&self) -> bool {
        match self.scratch_state.compare_exchange(
            SCRATCH_OPEN,
            SCRATCH_SEALING,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => {}
            Err(SCRATCH_SEALED) => return self.scratch_live.load(Ordering::Acquire) == 0,
            Err(_) => return false,
        }
        if self.scratch_live.load(Ordering::Acquire) != 0 {
            self.scratch_state.store(SCRATCH_OPEN, Ordering::Release);
            return false;
        }
        self.scratch_state.store(SCRATCH_SEALED, Ordering::Release);
        true
    }

    fn origin(&self, ptr: *mut u8) -> Option<(&Heap, bool)> {
        if self.query.contains(ptr) {
            Some((&self.query.heap, false))
        } else if self.scratch.contains(ptr) {
            Some((&self.scratch.heap, true))
        } else {
            None
        }
    }
}

unsafe impl GlobalAlloc for WorkerAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if self.scratch_scope_is_current() {
            self.scratch_alloc(layout)
        } else {
            self.query_alloc(layout)
        }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        match self.origin(ptr) {
            Some((heap, scratch)) => {
                unsafe { heap.dealloc(ptr, layout) };
                if scratch
                    && self
                        .scratch_live
                        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |live| {
                            live.checked_sub(1)
                        })
                        .is_err()
                {
                    std::process::abort();
                }
            }
            None => std::process::abort(),
        }
    }

    unsafe fn realloc(&self, ptr: *mut u8, old: Layout, size: usize) -> *mut u8 {
        let Some((heap, scratch)) = self.origin(ptr) else {
            std::process::abort();
        };
        if scratch
            && (self.scratch_state.load(Ordering::Acquire) != SCRATCH_ACTIVE
                || !self.scratch_scope_is_current())
        {
            return ptr::null_mut();
        }
        // Origin, not the current scope, selects the heap. Talc preserves `ptr`
        // on failure; neither Q nor S may fall back to the other region.
        unsafe { heap.realloc(ptr, old, size) }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct SqliteHeader {
    capacity: usize,
}
const SQL_ALIGN: usize = std::mem::align_of::<SqliteHeader>();
fn sql_layout(size: usize) -> Option<Layout> {
    Layout::from_size_align(size.checked_add(size_of::<SqliteHeader>())?, SQL_ALIGN).ok()
}
unsafe extern "C" fn x_malloc(n: c_int) -> *mut c_void {
    sqlite_malloc(&WORKER_ALLOCATOR, n)
}

unsafe fn sqlite_malloc(allocator: &WorkerAllocator, n: c_int) -> *mut c_void {
    sqlite_malloc_with_context(allocator, n, SqliteAllocationKind::XMalloc, 0)
}

unsafe fn sqlite_malloc_with_context(
    allocator: &WorkerAllocator,
    n: c_int,
    kind: SqliteAllocationKind,
    old_capacity: usize,
) -> *mut c_void {
    if n <= 0 {
        return ptr::null_mut();
    }
    let failure = SqliteAllocationRequest {
        kind,
        requested: n as usize,
        old_capacity,
    };
    let Some(layout) = sql_layout(n as usize) else {
        #[cfg(feature = "nir1-c-query-test-seam")]
        allocator.record_sqlite_allocation_failure_without_talc_attempt(failure);
        return ptr::null_mut();
    };
    let raw = allocator.query_alloc_for_sqlite(layout, failure);
    if raw.is_null() {
        return ptr::null_mut();
    }
    raw.cast::<SqliteHeader>().write(SqliteHeader {
        capacity: n as usize,
    });
    raw.add(size_of::<SqliteHeader>()).cast()
}
unsafe extern "C" fn x_free(ptr: *mut c_void) {
    sqlite_free(&WORKER_ALLOCATOR, ptr);
}

unsafe fn sqlite_free(allocator: &WorkerAllocator, ptr: *mut c_void) {
    if ptr.is_null() {
        return;
    }
    let raw = ptr.cast::<u8>().sub(size_of::<SqliteHeader>());
    if !allocator.query.contains(raw) {
        std::process::abort();
    }
    let cap = raw.cast::<SqliteHeader>().read().capacity;
    let Some(layout) = sql_layout(cap) else {
        std::process::abort()
    };
    unsafe { allocator.query.heap.dealloc(raw, layout) };
}
unsafe extern "C" fn x_size(ptr: *mut c_void) -> c_int {
    sqlite_size(&WORKER_ALLOCATOR, ptr)
}

unsafe fn sqlite_size(allocator: &WorkerAllocator, ptr: *mut c_void) -> c_int {
    if ptr.is_null() {
        return 0;
    }
    let raw = ptr.cast::<u8>().sub(size_of::<SqliteHeader>());
    if !allocator.query.contains(raw) {
        std::process::abort();
    }
    let cap = raw.cast::<SqliteHeader>().read().capacity;
    c_int::try_from(cap).unwrap_or_else(|_| std::process::abort())
}
unsafe extern "C" fn x_realloc(ptr: *mut c_void, n: c_int) -> *mut c_void {
    sqlite_realloc(&WORKER_ALLOCATOR, ptr, n)
}

unsafe fn sqlite_realloc(allocator: &WorkerAllocator, ptr: *mut c_void, n: c_int) -> *mut c_void {
    if n <= 0 {
        sqlite_free(allocator, ptr);
        return ptr::null_mut();
    }
    if ptr.is_null() {
        return sqlite_malloc_with_context(allocator, n, SqliteAllocationKind::XRealloc, 0);
    }
    let raw = ptr.cast::<u8>().sub(size_of::<SqliteHeader>());
    if !allocator.query.contains(raw) {
        std::process::abort();
    }
    let old = raw.cast::<SqliteHeader>().read().capacity;
    if n as usize <= old {
        return ptr;
    } // xSize still advertises full old capacity.
    let (Some(old_layout), Some(new_layout)) = (sql_layout(old), sql_layout(n as usize)) else {
        #[cfg(feature = "nir1-c-query-test-seam")]
        allocator.record_sqlite_allocation_failure_without_talc_attempt(SqliteAllocationRequest {
            kind: SqliteAllocationKind::XRealloc,
            requested: n as usize,
            old_capacity: old,
        });
        return ptr::null_mut();
    };
    // SQLite's pointer is required to originate in Q; S is never a callback heap.
    let new = unsafe {
        allocator
            .query
            .heap
            .realloc(raw, old_layout, new_layout.size())
    };
    if new.is_null() {
        #[cfg(feature = "nir1-c-query-test-seam")]
        {
            if !allocator.sqlite_failure_receipt_enabled() {
                return ptr::null_mut();
            }
            let (claimed, available) = {
                let heap = allocator.query.heap.lock();
                let counters = heap.counters();
                (counters.claimed_bytes, counters.available_bytes)
            };
            allocator.record_sqlite_allocation_failure(
                SqliteAllocationRequest {
                    kind: SqliteAllocationKind::XRealloc,
                    requested: n as usize,
                    old_capacity: old,
                },
                claimed,
                available,
            );
        }
        return ptr::null_mut();
    } // old block remains live on failure.
    new.cast::<SqliteHeader>().write(SqliteHeader {
        capacity: n as usize,
    });
    new.add(size_of::<SqliteHeader>()).cast()
}
unsafe extern "C" fn x_roundup(n: c_int) -> c_int {
    if n <= 0 {
        return 0;
    }
    n.checked_add((SQL_ALIGN - (n as usize % SQL_ALIGN)) as c_int % SQL_ALIGN as c_int)
        .unwrap_or(n)
}
unsafe extern "C" fn x_init(_: *mut c_void) -> c_int {
    ffi::SQLITE_OK
}
unsafe extern "C" fn x_shutdown(_: *mut c_void) {}

/// Must precede *every* SQLite init in this one-query process; no shutdown/retry.
pub fn install_sqlite() -> bool {
    let methods = ffi::sqlite3_mem_methods {
        xMalloc: Some(x_malloc),
        xFree: Some(x_free),
        xRealloc: Some(x_realloc),
        xSize: Some(x_size),
        xRoundup: Some(x_roundup),
        xInit: Some(x_init),
        xShutdown: Some(x_shutdown),
        pAppData: ptr::null_mut(),
    };
    // SAFETY: SQLite copies the table. Both configs occur before sqlite3_initialize.
    unsafe {
        ffi::sqlite3_config(ffi::SQLITE_CONFIG_MALLOC, &methods) == ffi::SQLITE_OK
            // This isolated worker never reads SQLite's optional memory statistics.
            && ffi::sqlite3_config(ffi::SQLITE_CONFIG_MEMSTATUS, 0 as c_int) == ffi::SQLITE_OK
            && ffi::sqlite3_config(ffi::SQLITE_CONFIG_LOOKASIDE, 0, 0) == ffi::SQLITE_OK
            && ffi::sqlite3_initialize() == ffi::SQLITE_OK
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::alloc::GlobalAlloc;

    static TEST_ALLOCATOR: WorkerAllocator = WorkerAllocator::new();

    #[test]
    fn q_s_origins_no_fallback_failed_realloc_and_zero_live_seal() {
        let small = Layout::from_size_align(16, 8).unwrap();
        let q = unsafe { TEST_ALLOCATOR.alloc(small) };
        assert!(!q.is_null());
        assert!(TEST_ALLOCATOR.query.contains(q));
        assert!(!TEST_ALLOCATOR.scratch.contains(q));
        unsafe { ptr::write_bytes(q, 0x5a, small.size()) };

        let mut expected =
            std::collections::BTreeMap::<&str, std::collections::BTreeSet<&str>>::new();
        WORKER_ALLOCATOR
            .with_scratch_scope(|| {
                expected.entry("codex:e1").or_default().insert("token-1");
            })
            .unwrap();
        assert!(WORKER_ALLOCATOR.scratch_live.load(Ordering::Acquire) > 0);
        assert!(expected
            .get("codex:e1")
            .is_some_and(|tokens| tokens.contains("token-1")));
        drop(expected);
        assert_eq!(WORKER_ALLOCATOR.scratch_live.load(Ordering::Acquire), 0);

        let failed_q_realloc = unsafe { TEST_ALLOCATOR.realloc(q, small, QUERY_BYTES) };
        assert!(
            failed_q_realloc.is_null(),
            "Q realloc must not fall back to S"
        );
        assert!((0..small.size()).all(|i| unsafe { q.add(i).read() == 0x5a }));
        let query_before = TEST_ALLOCATOR.query.heap.lock().counters().allocated_bytes;
        let too_large_query = Layout::from_size_align(QUERY_BYTES, 8).unwrap();
        assert!(unsafe { TEST_ALLOCATOR.alloc(too_large_query) }.is_null());
        assert_eq!(
            TEST_ALLOCATOR.query.heap.lock().counters().allocated_bytes,
            query_before,
            "Q exhaustion must not fall back to S"
        );

        let mut escaped_scratch = ptr::null_mut();
        TEST_ALLOCATOR
            .with_scratch_scope(|| {
                assert_eq!(
                    TEST_ALLOCATOR.with_scratch_scope(|| ()),
                    Err(ScratchScopeError::AlreadyActive)
                );
                let moving = unsafe { TEST_ALLOCATOR.alloc(small) };
                assert!(!moving.is_null());
                unsafe { ptr::write_bytes(moving, 0x42, small.size()) };
                let grown_layout = Layout::from_size_align(32, 8).unwrap();
                let grown = unsafe { TEST_ALLOCATOR.realloc(moving, small, grown_layout.size()) };
                assert!(!grown.is_null());
                assert!(TEST_ALLOCATOR.scratch.contains(grown));
                assert!((0..small.size()).all(|i| unsafe { grown.add(i).read() == 0x42 }));
                unsafe { TEST_ALLOCATOR.dealloc(grown, grown_layout) };
                assert_eq!(TEST_ALLOCATOR.scratch_live.load(Ordering::Acquire), 0);

                let s = unsafe { TEST_ALLOCATOR.alloc(small) };
                assert!(!s.is_null());
                assert!(TEST_ALLOCATOR.scratch.contains(s));
                assert!(!TEST_ALLOCATOR.query.contains(s));
                unsafe { ptr::write_bytes(s, 0x31, small.size()) };
                assert_eq!(TEST_ALLOCATOR.scratch_live.load(Ordering::Acquire), 1);

                // A Q-origin realloc stays in Q even while this thread selects S.
                let q_grown = unsafe { TEST_ALLOCATOR.realloc(q, small, 32) };
                assert!(!q_grown.is_null());
                assert!(TEST_ALLOCATOR.query.contains(q_grown));
                assert!((0..small.size()).all(|i| unsafe { q_grown.add(i).read() == 0x5a }));
                unsafe { TEST_ALLOCATOR.dealloc(q_grown, Layout::from_size_align(32, 8).unwrap()) };

                // SQLite allocation/reallocation bypass the thread-local S selector.
                let sqlite = unsafe { sqlite_malloc(&TEST_ALLOCATOR, 64) };
                assert!(!sqlite.is_null());
                assert!(TEST_ALLOCATOR.query.contains(sqlite.cast()));
                assert!(!TEST_ALLOCATOR.scratch.contains(sqlite.cast()));
                let sqlite = unsafe { sqlite_realloc(&TEST_ALLOCATOR, sqlite, 128) };
                assert!(!sqlite.is_null());
                assert!(TEST_ALLOCATOR.query.contains(sqlite.cast()));
                assert_eq!(unsafe { sqlite_size(&TEST_ALLOCATOR, sqlite) }, 128);
                unsafe { sqlite_free(&TEST_ALLOCATOR, sqlite) };

                // Fill S near its real Talc limit, then request a size Q could
                // satisfy. Failure proves there is no S-to-Q fallback.
                let mut low = 0usize;
                let mut high = SCRATCH_BYTES;
                while low < high {
                    let candidate = low + (high - low + 1) / 2;
                    let layout = Layout::from_size_align(candidate, 8).unwrap();
                    let allocation = unsafe { TEST_ALLOCATOR.alloc(layout) };
                    if allocation.is_null() {
                        high = candidate - 1;
                    } else {
                        unsafe { TEST_ALLOCATOR.dealloc(allocation, layout) };
                        low = candidate;
                    }
                }
                let max_s_layout = Layout::from_size_align(low, 8).unwrap();
                let max_s = unsafe { TEST_ALLOCATOR.alloc(max_s_layout) };
                assert!(!max_s.is_null());
                let fallback_size = QUERY_BYTES / 2;
                let fallback_layout = Layout::from_size_align(fallback_size, 8).unwrap();
                let query_before = TEST_ALLOCATOR.query.heap.lock().counters().allocated_bytes;
                assert!(unsafe { TEST_ALLOCATOR.alloc(fallback_layout) }.is_null());
                assert_eq!(
                    TEST_ALLOCATOR.query.heap.lock().counters().allocated_bytes,
                    query_before,
                    "S exhaustion must not fall back to Q"
                );
                assert_eq!(TEST_ALLOCATOR.scratch_live.load(Ordering::Acquire), 2);

                // Failed S realloc also cannot migrate to available Q space.
                assert!(
                    unsafe { TEST_ALLOCATOR.realloc(s, small, fallback_layout.size()) }.is_null()
                );
                assert!((0..small.size()).all(|i| unsafe { s.add(i).read() == 0x31 }));
                assert_eq!(TEST_ALLOCATOR.scratch_live.load(Ordering::Acquire), 2);
                unsafe { TEST_ALLOCATOR.dealloc(max_s, max_s_layout) };
                assert_eq!(TEST_ALLOCATOR.scratch_live.load(Ordering::Acquire), 1);
                assert!(
                    !TEST_ALLOCATOR.seal_scratch(),
                    "cannot seal an active scope"
                );
                escaped_scratch = s;
            })
            .unwrap();

        assert!(!escaped_scratch.is_null());
        assert_eq!(TEST_ALLOCATOR.scratch_live.load(Ordering::Acquire), 1);
        assert!(unsafe { TEST_ALLOCATOR.realloc(escaped_scratch, small, 32) }.is_null());
        assert!((0..small.size()).all(|i| unsafe { escaped_scratch.add(i).read() == 0x31 }));
        assert!(!TEST_ALLOCATOR.seal_scratch(), "cannot seal a live S block");
        // Origin is sufficient for free even after the explicit scope closes.
        unsafe { TEST_ALLOCATOR.dealloc(escaped_scratch, small) };
        assert_eq!(TEST_ALLOCATOR.scratch_live.load(Ordering::Acquire), 0);

        assert!(TEST_ALLOCATOR
            .with_scratch_scope(|| {
                let s = unsafe { TEST_ALLOCATOR.alloc(small) };
                assert!(!s.is_null());
                assert!(TEST_ALLOCATOR.scratch.contains(s));
                unsafe { TEST_ALLOCATOR.dealloc(s, small) };
            })
            .is_ok());
        assert!(TEST_ALLOCATOR.seal_scratch());
        assert!(
            TEST_ALLOCATOR.seal_scratch(),
            "seal is irreversible/idempotent"
        );
        assert_eq!(
            TEST_ALLOCATOR.with_scratch_scope(|| ()),
            Err(ScratchScopeError::Sealed)
        );

        let after_seal = unsafe { TEST_ALLOCATOR.alloc(small) };
        assert!(!after_seal.is_null());
        assert!(TEST_ALLOCATOR.query.contains(after_seal));
        unsafe { TEST_ALLOCATOR.dealloc(after_seal, small) };

        // Preserve the existing allocator-only SQLite N/N+1 boundary proof.
        let mut low = 0usize;
        let mut high = QUERY_BYTES;
        while low < high {
            let candidate = low + (high - low + 1) / 2;
            let allocation =
                unsafe { sqlite_malloc(&TEST_ALLOCATOR, c_int::try_from(candidate).unwrap()) };
            if allocation.is_null() {
                high = candidate - 1;
            } else {
                unsafe { sqlite_free(&TEST_ALLOCATOR, allocation) };
                low = candidate;
            }
        }
        assert!(low > 0);
        let sqlite = unsafe { sqlite_malloc(&TEST_ALLOCATOR, c_int::try_from(low).unwrap()) };
        assert!(!sqlite.is_null(), "N SQLite payload fits with its header");
        assert!(TEST_ALLOCATOR.query.contains(sqlite.cast()));
        unsafe {
            sqlite.cast::<u8>().write(0x71);
            sqlite.cast::<u8>().add(low - 1).write(0x7b);
        }
        #[cfg(feature = "nir1-c-query-test-seam")]
        {
            assert!(TEST_ALLOCATOR.sqlite_failure_receipt().is_none());
            assert!(unsafe {
                sqlite_malloc(&TEST_ALLOCATOR, c_int::try_from(QUERY_BYTES).unwrap())
            }
            .is_null());
            assert!(TEST_ALLOCATOR.sqlite_failure_receipt().is_none());

            TEST_ALLOCATOR.enable_sqlite_failure_receipt(true);
            assert!(unsafe {
                sqlite_malloc(&TEST_ALLOCATOR, c_int::try_from(QUERY_BYTES).unwrap())
            }
            .is_null());
            let receipt = TEST_ALLOCATOR
                .sqlite_failure_receipt()
                .expect("opt-in records the first xMalloc failure");
            assert!(matches!(receipt.kind, SqliteAllocationKind::XMalloc));
            assert_eq!(receipt.requested, QUERY_BYTES);
            assert_eq!(receipt.old_capacity, 0);
            assert!(receipt.available <= receipt.claimed);
            TEST_ALLOCATOR
                .sqlite_failure_receipt
                .state
                .store(FAILURE_EMPTY, Ordering::Release);
        }
        let failed =
            unsafe { sqlite_realloc(&TEST_ALLOCATOR, sqlite, c_int::try_from(low + 1).unwrap()) };
        assert!(failed.is_null(), "overlapping N+1 realloc must fail closed");
        #[cfg(feature = "nir1-c-query-test-seam")]
        let first_receipt = {
            let receipt = TEST_ALLOCATOR
                .sqlite_failure_receipt()
                .expect("first SQLite allocation failure is recorded");
            assert!(matches!(receipt.kind, SqliteAllocationKind::XRealloc));
            assert_eq!(receipt.requested, low + 1);
            assert_eq!(receipt.old_capacity, low);
            assert!(receipt.available <= receipt.claimed);
            receipt
        };
        assert_eq!(
            unsafe { sqlite_size(&TEST_ALLOCATOR, sqlite) },
            low as c_int
        );
        assert_eq!(unsafe { sqlite.cast::<u8>().read() }, 0x71);
        assert_eq!(unsafe { sqlite.cast::<u8>().add(low - 1).read() }, 0x7b);
        unsafe { sqlite_free(&TEST_ALLOCATOR, sqlite) };
        assert!(
            unsafe { sqlite_malloc(&TEST_ALLOCATOR, c_int::try_from(low + 1).unwrap()) }.is_null()
        );
        #[cfg(feature = "nir1-c-query-test-seam")]
        assert_eq!(TEST_ALLOCATOR.sqlite_failure_receipt(), Some(first_receipt));

        let q_footprint = size_of::<WorkerAllocator>() - size_of::<Region<SCRATCH_DATA>>()
            + size_of::<*const WorkerAllocator>();
        assert!(q_footprint <= QUERY_BYTES);
        eprintln!(
            "Q/S Talc boundary: SQLite Q payload N={low}, N+1 rejected; Q static footprint={q_footprint} B; S sealed at zero live allocations"
        );
    }
}
