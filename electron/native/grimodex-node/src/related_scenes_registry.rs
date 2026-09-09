use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotEligibility {
    pub original_snapshot_usable: bool,
    pub supported_profile: bool,
}

/// The eligibility denominator is captured before work is scheduled. It is
/// never recomputed from a later timeout, cancellation, or invalidation.
pub(crate) struct RelatedScenesLease<T> {
    owner: String,
    expires_at: Instant,
    cancelled: AtomicBool,
    pub snapshot: SnapshotEligibility,
    pub data: T,
}

impl<T> RelatedScenesLease<T> {
    pub fn is_owned_by(&self, owner: &str) -> bool {
        self.owner == owner
    }
    pub fn is_live(&self, now: Instant) -> bool {
        now < self.expires_at && !self.cancelled.load(Ordering::Acquire)
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

/// Request-local Native capabilities only. The registry never opens a DB,
/// trusts a caller-supplied binding, or serializes stored data. Every caller
/// must additionally revalidate the pinned DB/model/context before return.
pub(crate) struct RelatedScenesRegistry<T> {
    entries: HashMap<String, Arc<RelatedScenesLease<T>>>,
    capacity: usize,
    ttl: Duration,
}

impl<T> RelatedScenesRegistry<T> {
    pub fn entries(&self) -> Vec<(String, Arc<RelatedScenesLease<T>>)> {
        self.entries
            .iter()
            .map(|(ticket, lease)| (ticket.clone(), Arc::clone(lease)))
            .collect()
    }

    pub fn invalidate(&mut self, ticket: &str) -> bool {
        if let Some(entry) = self.entries.remove(ticket) {
            entry.cancel();
            true
        } else {
            false
        }
    }
    pub fn new(capacity: usize, ttl: Duration) -> Self {
        Self {
            entries: HashMap::new(),
            capacity,
            ttl,
        }
    }

    pub fn insert(
        &mut self,
        owner: &str,
        snapshot: SnapshotEligibility,
        data: T,
        now: Instant,
    ) -> Option<String> {
        // Expiration must be drained explicitly by the service so it can
        // deliver the invalidation for every issued query binding. A deadline
        // crossed after that drain may temporarily fill capacity; insertion
        // must never silently remove the lease and lose its notification.
        if self.entries.len() >= self.capacity {
            return None;
        }
        let ticket = format!("related-scenes:{}", uuid::Uuid::new_v4());
        self.entries.insert(
            ticket.clone(),
            Arc::new(RelatedScenesLease {
                owner: owner.to_string(),
                expires_at: now + self.ttl,
                cancelled: AtomicBool::new(false),
                snapshot,
                data,
            }),
        );
        Some(ticket)
    }

    #[cfg(test)]
    pub fn get(
        &mut self,
        ticket: &str,
        owner: &str,
        now: Instant,
    ) -> Option<Arc<RelatedScenesLease<T>>> {
        self.prune(now);
        self.entries
            .get(ticket)
            .filter(|entry| entry.owner == owner && entry.is_live(now))
            .map(Arc::clone)
    }

    pub fn release(&mut self, ticket: &str, owner: &str) -> bool {
        if self
            .entries
            .get(ticket)
            .is_none_or(|entry| entry.owner != owner)
        {
            return false;
        }
        if let Some(entry) = self.entries.remove(ticket) {
            entry.cancel();
        }
        true
    }

    pub fn release_owner(&mut self, owner: &str) -> usize {
        let before = self.entries.len();
        self.entries.retain(|_, entry| {
            if entry.owner == owner {
                entry.cancel();
                false
            } else {
                true
            }
        });
        before - self.entries.len()
    }

    #[cfg(test)]
    pub fn prune(&mut self, now: Instant) {
        self.entries.retain(|_, entry| {
            if entry.is_live(now) {
                true
            } else {
                entry.cancel();
                false
            }
        });
    }
}

impl<T> Drop for RelatedScenesRegistry<T> {
    fn drop(&mut self) {
        for entry in self.entries.values() {
            entry.cancel();
        }
    }
}

#[cfg(test)]
#[path = "related_scenes_registry_tests.rs"]
mod tests;
