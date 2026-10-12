use std::alloc::{GlobalAlloc, Layout, System};
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

// This wrapper is linked only into opt-in diagnostic binaries. It delegates
// every operation to the system allocator and counts requested live bytes.
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

pub fn snapshot() -> (u64, u64) {
    let current = RUST_HEAP_CURRENT.load(Ordering::Relaxed);
    (current, RUST_HEAP_PEAK.load(Ordering::Relaxed).max(current))
}

pub fn begin_window() -> u64 {
    let current = RUST_HEAP_CURRENT.load(Ordering::Relaxed);
    RUST_HEAP_PEAK.store(current, Ordering::Relaxed);
    current
}
