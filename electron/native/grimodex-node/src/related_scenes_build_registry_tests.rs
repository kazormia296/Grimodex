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
