use super::*;

#[test]
fn model_rotation_replaces_the_watch_before_the_old_job_exits() {
    let mut registry = RelatedScenesBuildRegistry::new(1);
    let key = (7, "project".into());
    assert!(registry.reserve(key.clone(), 10));
    assert!(!registry.reserve(key.clone(), 10));
    assert!(registry.reserve(key.clone(), 11));
    registry.release(&key, 10);
    assert!(!registry.reserve(key.clone(), 11));
    registry.release(&key, 11);
    assert!(registry.reserve(key, 11));
}

#[test]
fn obsolete_requests_cannot_replace_current_reservations_even_after_release() {
    let mut registry = RelatedScenesBuildRegistry::new(1);
    let key = (7, "project".into());
    assert!(registry.reserve(key.clone(), 11));
    assert!(!registry.reserve(key.clone(), 10));
    registry.release(&key, 11);
    assert!(!registry.reserve(key.clone(), 10));
    assert!(registry.reserve(key, 11));
}

#[test]
fn workspace_rotation_reclaims_old_capacity_without_evicting_current_jobs() {
    let mut registry = RelatedScenesBuildRegistry::new(1);
    let old = (7, "old-project".into());
    let current = (8, "new-project".into());
    let another = (8, "another-project".into());
    assert!(registry.reserve(old.clone(), 10));
    assert!(!registry.reserve(another.clone(), 10));
    assert!(registry.reserve(current.clone(), 11));
    registry.release(&old, 10);
    assert!(!registry.reserve(another.clone(), 11));
    registry.release(&current, 11);
    assert!(registry.reserve(another, 11));
}

#[test]
fn a_foreground_request_is_consumed_once_and_only_for_the_reserved_key_and_generation() {
    let mut registry = RelatedScenesBuildRegistry::new(4);
    let key: BuildKey = (7, "project".into());
    // Nothing reserved: the request is dropped, not remembered.
    registry.request_foreground(&key, 10);
    assert!(!registry.take_foreground(&key, 10));
    assert!(registry.reserve(key.clone(), 10));
    assert!(!registry.take_foreground(&key, 10), "no request yet");
    registry.request_foreground(&key, 10);
    registry.request_foreground(&key, 10);
    assert!(registry.take_foreground(&key, 10));
    assert!(!registry.take_foreground(&key, 10), "consumed by one take");
}

#[test]
fn a_foreground_request_of_another_generation_is_ignored_or_cleared() {
    let mut registry = RelatedScenesBuildRegistry::new(4);
    let key: BuildKey = (7, "project".into());
    assert!(registry.reserve(key.clone(), 10));
    // A request made under an older generation than the registry's is ignored.
    registry.request_foreground(&key, 9);
    assert!(!registry.take_foreground(&key, 10));
    // A request pending when the generation rotates is cleared with the keys,
    // and the old task cannot take it under either generation.
    registry.request_foreground(&key, 10);
    assert!(registry.reserve(key.clone(), 11));
    assert!(!registry.take_foreground(&key, 10));
    assert!(!registry.take_foreground(&key, 11));
    // A release clears a pending request as well.
    registry.request_foreground(&key, 11);
    registry.release(&key, 11);
    assert!(registry.reserve(key.clone(), 11));
    assert!(!registry.take_foreground(&key, 11));
}
