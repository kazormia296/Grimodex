use super::*;
use std::time::Duration;

fn snapshot() -> SnapshotEligibility {
    SnapshotEligibility {
        original_snapshot_usable: true,
        supported_profile: true,
    }
}

#[test]
fn caller_cannot_transfer_or_release_another_owner_ticket() {
    let now = Instant::now();
    let mut registry = RelatedScenesRegistry::new(2, Duration::from_secs(30));
    let ticket = registry
        .insert("owner-a", snapshot(), "private-vector", now)
        .expect("room");
    assert!(registry.get(&ticket, "owner-b", now).is_none());
    assert!(!registry.release(&ticket, "owner-b"));
    assert_eq!(
        registry.get(&ticket, "owner-a", now).expect("owned").data,
        "private-vector"
    );
}

#[test]
fn release_revokes_already_borrowed_work_and_preserves_the_snapshot_copy() {
    let now = Instant::now();
    let mut registry = RelatedScenesRegistry::new(2, Duration::from_secs(30));
    let ticket = registry.insert("owner", snapshot(), 42, now).expect("room");
    let in_flight = registry.get(&ticket, "owner", now).expect("owned");
    let eligibility = in_flight.snapshot;
    assert!(in_flight.is_live(now));
    assert!(registry.release(&ticket, "owner"));
    assert!(!in_flight.is_live(now));
    assert_eq!(eligibility, snapshot());
    assert!(!registry.release(&ticket, "owner"));
}

#[test]
fn capacity_never_evicts_live_owners_and_expiry_releases_the_exact_entry() {
    let now = Instant::now();
    let ttl = Duration::from_secs(30);
    let mut registry = RelatedScenesRegistry::new(1, ttl);
    let first = registry.insert("one", snapshot(), 1, now).expect("room");
    let in_flight = registry.get(&first, "one", now).expect("owned");
    assert!(registry.insert("two", snapshot(), 2, now).is_none());
    assert!(registry.get(&first, "one", now + ttl).is_none());
    assert!(!in_flight.is_live(now + ttl));
    let second = registry
        .insert("two", snapshot(), 2, now + ttl)
        .expect("expired room");
    assert_ne!(first, second);
    assert_eq!(
        registry.get(&second, "two", now + ttl).expect("new").data,
        2
    );
}

#[test]
fn owner_close_revokes_only_that_owners_operations() {
    let now = Instant::now();
    let mut registry = RelatedScenesRegistry::new(3, Duration::from_secs(30));
    let a = registry.insert("one", snapshot(), 1, now).expect("room");
    let b = registry.insert("one", snapshot(), 2, now).expect("room");
    let c = registry.insert("two", snapshot(), 3, now).expect("room");
    let old = registry.get(&a, "one", now).expect("owned");
    assert_eq!(registry.release_owner("one"), 2);
    assert!(!old.is_live(now));
    assert!(registry.get(&b, "one", now).is_none());
    assert!(registry.get(&c, "two", now).is_some());
}

#[test]
fn insertion_retains_expired_binding_until_explicit_invalidation() {
    let now = Instant::now();
    let ttl = Duration::from_secs(1);
    let mut registry = RelatedScenesRegistry::new(1, ttl);
    let first = registry.insert("one", snapshot(), 1, now).expect("room");
    // The service just enumerated live entries, then the deadline crossed
    // before allocation. Preserve the old binding for its event delivery.
    assert!(registry.insert("two", snapshot(), 2, now + ttl).is_none());
    assert_eq!(registry.entries()[0].0, first);
    assert!(registry.invalidate(&first));
    assert!(!registry.invalidate(&first));
    assert!(registry.insert("two", snapshot(), 2, now + ttl).is_some());
}
