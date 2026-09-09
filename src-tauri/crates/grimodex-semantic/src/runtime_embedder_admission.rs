use anyhow::Result;
use std::sync::{Condvar, Mutex};

#[derive(Default)]
struct AdmissionState {
    active: bool,
    foreground_waiters: usize,
}

/// NIR1 document batches yield to queued foreground work between documents.
/// The embedder map still owns and serializes the actual model sessions.
#[derive(Default)]
pub(super) struct EmbedderAdmission {
    state: Mutex<AdmissionState>,
    ready: Condvar,
}

impl EmbedderAdmission {
    pub(super) fn foreground<T>(&self, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        let _permit = self.acquire(true);
        operation()
    }

    pub(super) fn map_background<I, O>(
        &self,
        inputs: &[I],
        mut operation: impl FnMut(&I) -> Result<O>,
    ) -> Result<Vec<O>> {
        inputs
            .iter()
            .map(|input| {
                let _permit = self.acquire(false);
                operation(input)
            })
            .collect()
    }

    fn acquire(&self, foreground: bool) -> AdmissionPermit<'_> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if foreground {
            state.foreground_waiters += 1;
            #[cfg(test)]
            self.ready.notify_all();
        }
        while state.active || (!foreground && state.foreground_waiters > 0) {
            state = self
                .ready
                .wait(state)
                .unwrap_or_else(|poison| poison.into_inner());
        }
        if foreground {
            state.foreground_waiters -= 1;
        }
        state.active = true;
        AdmissionPermit { admission: self }
    }

    #[cfg(test)]
    pub(super) fn wait_for_foreground_waiters(&self, count: usize) -> bool {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let (state, _) = self
            .ready
            .wait_timeout_while(state, std::time::Duration::from_secs(5), |state| {
                state.foreground_waiters < count
            })
            .unwrap_or_else(|poison| poison.into_inner());
        state.foreground_waiters >= count
    }
}

struct AdmissionPermit<'a> {
    admission: &'a EmbedderAdmission,
}

impl Drop for AdmissionPermit<'_> {
    fn drop(&mut self) {
        let mut state = self
            .admission
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        state.active = false;
        self.admission.ready.notify_all();
    }
}

#[cfg(test)]
#[path = "runtime_embedder_admission_tests.rs"]
mod tests;
