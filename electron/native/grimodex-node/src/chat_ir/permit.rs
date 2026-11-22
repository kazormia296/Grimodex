//! The in-flight limit of the one-shot, held by the blocking task until it has
//! really returned (DR-CHATIR-S1-4, DR-CHATIR-S1-19). A permit is taken on the
//! async side without waiting and moved into the task, so a task that is still
//! queued behind a saturated blocking pool counts, and a caller timeout or a
//! settled Promise never gives it back.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

pub(crate) struct PermitPool {
    max: usize,
    in_flight: AtomicUsize,
}

pub(crate) struct Permit {
    pool: Arc<PermitPool>,
}

impl PermitPool {
    pub(crate) fn new(max: usize) -> Arc<Self> {
        Arc::new(Self {
            max,
            in_flight: AtomicUsize::new(0),
        })
    }

    /// Never waits: `None` is `busy`.
    pub(crate) fn try_acquire(self: &Arc<Self>) -> Option<Permit> {
        let mut current = self.in_flight.load(Ordering::SeqCst);
        loop {
            if current >= self.max {
                return None;
            }
            match self.in_flight.compare_exchange(
                current,
                current + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => {
                    return Some(Permit {
                        pool: Arc::clone(self),
                    })
                }
                Err(actual) => current = actual,
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::SeqCst)
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.pool.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}
