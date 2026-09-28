//! Product worker only. Two disjoint, statically backed Talc 5.1.1 Manual
//! heaps; no System source and no hook in the Native/renderer process.
use super::WORKER_ALLOCATOR;
use rusqlite::ffi;
use std::{
    alloc::{GlobalAlloc, Layout},
    cell::UnsafeCell,
    ffi::{c_int, c_void},
    mem::size_of,
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Once,
    },
};
use talc::{lock_api::RawMutex, source::Manual, TalcLock};

pub const QUERY_BYTES: usize = 1_572_864;
const BASELINE_BYTES: usize = 64 * 1024 * 1024;
const BEFORE: u8 = 0;
const ACTIVE: u8 = 2;

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
// The backing can only be mutated by Talc behind its lock. It is claimed once
// and is never resized; Rust allocation and SQLite callbacks share this lock.
unsafe impl<const N: usize> Sync for Region<N> {}
impl<const N: usize> Region<N> {
    const fn new() -> Self {
        Self {
            heap: Heap::new(Manual),
            backing: UnsafeCell::new([0; N]),
        }
    }
    fn claim(&self) -> bool {
        // SAFETY: one-shot Once, exclusive static backing, valid until process exit.
        unsafe {
            self.heap
                .lock()
                .claim((*self.backing.get()).as_mut_ptr(), N)
                .is_some()
        }
    }
    fn contains(&self, ptr: *mut u8) -> bool {
        let start = self.backing.get() as usize;
        (start..start + N).contains(&(ptr as usize))
    }
}

// Leave enough room for BOTH Talc locks, one-shot flags, active state, all
// alignment padding, and Talc's in-band chunk/bin metadata. These compile-time
// checks count the entire static object, not just user payloads.
const BASE_DATA: usize = BASELINE_BYTES - size_of::<Region<0>>() - 16;
const QUERY_DATA: usize =
    QUERY_BYTES - size_of::<Region<0>>() - size_of::<Once>() * 2 - size_of::<AtomicU8>() - 64;
pub struct WorkerAllocator {
    baseline: Region<BASE_DATA>,
    query: Region<QUERY_DATA>,
    baseline_once: Once,
    query_once: Once,
    phase: AtomicU8,
}
const _: () = assert!(size_of::<WorkerAllocator>() - size_of::<Region<BASE_DATA>>() <= QUERY_BYTES);
const _: () = assert!(size_of::<Region<BASE_DATA>>() <= BASELINE_BYTES);
impl WorkerAllocator {
    pub const fn new() -> Self {
        Self {
            baseline: Region::new(),
            query: Region::new(),
            baseline_once: Once::new(),
            query_once: Once::new(),
            phase: AtomicU8::new(BEFORE),
        }
    }
    fn init_baseline(&self) {
        self.baseline_once.call_once(|| {
            if !self.baseline.claim() {
                std::process::abort();
            }
        });
    }
    pub fn activate(&self) -> bool {
        self.init_baseline();
        if self
            .phase
            .compare_exchange(BEFORE, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }
        self.query_once.call_once(|| {
            if !self.query.claim() {
                std::process::abort();
            }
        });
        self.phase.store(ACTIVE, Ordering::Release);
        true
    }
    fn origin(&self, ptr: *mut u8) -> Option<&Heap> {
        if self.query.contains(ptr) {
            Some(&self.query.heap)
        } else if self.baseline.contains(ptr) {
            Some(&self.baseline.heap)
        } else {
            None
        }
    }
}

unsafe impl GlobalAlloc for WorkerAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        self.init_baseline();
        if self.phase.load(Ordering::Acquire) == ACTIVE {
            self.query.heap.alloc(layout)
        } else {
            self.baseline.heap.alloc(layout)
        }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        match self.origin(ptr) {
            Some(heap) => heap.dealloc(ptr, layout),
            None => std::process::abort(),
        }
    }
    unsafe fn realloc(&self, ptr: *mut u8, old: Layout, size: usize) -> *mut u8 {
        let Some(origin) = self.origin(ptr) else {
            std::process::abort()
        };
        if self.phase.load(Ordering::Acquire) != ACTIVE || self.query.contains(ptr) {
            return origin.realloc(ptr, old, size);
        }
        // A baseline block may NOT grow in place after admission: the entire
        // replacement and the overlap must fit in the query region first.
        let Ok(new) = Layout::from_size_align(size, old.align()) else {
            return ptr::null_mut();
        };
        let replacement = self.query.heap.alloc(new);
        if !replacement.is_null() {
            ptr::copy_nonoverlapping(ptr, replacement, old.size().min(size));
            origin.dealloc(ptr, old);
        }
        replacement
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
    if n <= 0 {
        return ptr::null_mut();
    }
    let Some(layout) = sql_layout(n as usize) else {
        return ptr::null_mut();
    };
    let raw = allocator.alloc(layout);
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
    let cap = raw.cast::<SqliteHeader>().read().capacity;
    let Some(layout) = sql_layout(cap) else {
        std::process::abort()
    };
    allocator.dealloc(raw, layout);
}
unsafe extern "C" fn x_size(ptr: *mut c_void) -> c_int {
    sqlite_size(ptr)
}

unsafe fn sqlite_size(ptr: *mut c_void) -> c_int {
    if ptr.is_null() {
        return 0;
    }
    let raw = ptr.cast::<u8>().sub(size_of::<SqliteHeader>());
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
        return sqlite_malloc(allocator, n);
    }
    let raw = ptr.cast::<u8>().sub(size_of::<SqliteHeader>());
    let old = raw.cast::<SqliteHeader>().read().capacity;
    if n as usize <= old {
        return ptr;
    } // xSize still advertises full old capacity.
    let (Some(old_layout), Some(new_layout)) = (sql_layout(old), sql_layout(n as usize)) else {
        return ptr::null_mut();
    };
    let new = allocator.realloc(raw, old_layout, new_layout.size());
    if new.is_null() {
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
    fn shared_query_region_bounds_rust_and_sqlite_allocations() {
        let old_layout = Layout::from_size_align(16, 8).unwrap();
        let old = unsafe { TEST_ALLOCATOR.alloc(old_layout) };
        assert!(!old.is_null());
        unsafe { ptr::write_bytes(old, 0x5a, old_layout.size()) };
        assert!(TEST_ALLOCATOR.baseline.contains(old));

        assert!(TEST_ALLOCATOR.activate());
        let moved = unsafe { TEST_ALLOCATOR.realloc(old, old_layout, 32) };
        assert!(!moved.is_null());
        assert!(TEST_ALLOCATOR.query.contains(moved));
        assert!((0..old_layout.size()).all(|offset| unsafe { moved.add(offset).read() == 0x5a }));

        let too_large = Layout::from_size_align(QUERY_BYTES, 8).unwrap();
        assert!(unsafe { TEST_ALLOCATOR.alloc(too_large) }.is_null());

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
        let pointer = unsafe { sqlite_malloc(&TEST_ALLOCATOR, c_int::try_from(low).unwrap()) };
        assert!(!pointer.is_null(), "N SQLite payload must fit with header");
        assert!(TEST_ALLOCATOR.query.contains(pointer.cast()));
        assert_eq!(unsafe { sqlite_size(pointer) }, low as c_int);
        unsafe {
            pointer.cast::<u8>().write(0x31);
            pointer.cast::<u8>().add(low - 1).write(0x7b);
        }

        let static_bytes = size_of::<WorkerAllocator>() - size_of::<Region<BASE_DATA>>();
        assert!(static_bytes <= QUERY_BYTES);
        assert!(static_bytes >= QUERY_DATA);
        assert_eq!(
            sql_layout(low).unwrap().size(),
            low + size_of::<SqliteHeader>(),
            "SQLite header is part of the actual worker allocator request"
        );

        let grown =
            unsafe { sqlite_realloc(&TEST_ALLOCATOR, pointer, c_int::try_from(low + 1).unwrap()) };
        assert!(grown.is_null(), "overlapping N+1 realloc must fail closed");
        assert_eq!(unsafe { sqlite_size(pointer) }, low as c_int);
        assert_eq!(unsafe { pointer.cast::<u8>().read() }, 0x31);
        assert_eq!(unsafe { pointer.cast::<u8>().add(low - 1).read() }, 0x7b);
        unsafe { sqlite_free(&TEST_ALLOCATOR, pointer) };
        assert!(
            unsafe { sqlite_malloc(&TEST_ALLOCATOR, c_int::try_from(low + 1).unwrap()) }.is_null(),
            "N+1 SQLite payload must not fit even after freeing N"
        );

        assert!(size_of::<WorkerAllocator>() - size_of::<Region<BASE_DATA>>() <= QUERY_BYTES);
        eprintln!(
            "worker Talc boundary: SQLite payload N={low}, N+1 rejected; SQLite Layout N={} B (header included), static query allocator footprint={} B, Rust live=32 B",
            sql_layout(low).unwrap().size(),
            size_of::<WorkerAllocator>() - size_of::<Region<BASE_DATA>>(),
        );
        unsafe { TEST_ALLOCATOR.dealloc(moved, Layout::from_size_align(32, 8).unwrap()) };
    }
}
