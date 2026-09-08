use grimodex_core::narrative_project_scope_authority::{
    build_narrative_project_scope_authority_v1,
    NarrativeProjectScopeAuthoritySceneInputV1 as Scene, NarrativeProjectScopeAuthorityV1,
};
use grimodex_core::narrative_scope_dependency_projection::{
    projection_revision, ScopeDependencyIdentity,
};

fn authority(order: &[(&str, &str)]) -> NarrativeProjectScopeAuthorityV1 {
    build_narrative_project_scope_authority_v1(
        "p",
        &order
            .iter()
            .map(|(id, key)| Scene {
                scene_id: (*id).into(),
                raw_story_key: Some((*key).into()),
            })
            .collect::<Vec<_>>(),
    )
    .expect("authority")
}
fn identity(secret: bool) -> ScopeDependencyIdentity {
    ScopeDependencyIdentity {
        project_id: "p".into(),
        run_id: "run:1".into(),
        anchor_document_ref: "D000001".into(),
        anchor_scene_ref: "scene:a".into(),
        reveal_document_ref: "D000002".into(),
        reveal_scene_ref: "scene:b".into(),
        secret,
    }
}

#[test]
fn unrelated_reading_change_preserves_nonsecret_but_revises_secret_dependency() {
    let before = authority(&[("a", "10"), ("b", "20"), ("c", "30")]);
    let after = authority(&[("c", "30"), ("a", "10"), ("b", "20")]);
    assert_ne!(before.source.revision_token, after.source.revision_token);
    assert_eq!(
        projection_revision(&identity(false), &before).expect("before"),
        projection_revision(&identity(false), &after).expect("after")
    );
    assert_ne!(
        projection_revision(&identity(true), &before).expect("before"),
        projection_revision(&identity(true), &after).expect("after")
    );
}

#[test]
fn another_scene_can_make_secret_reveal_story_ambiguous_without_changing_reveal_row() {
    let before = authority(&[("a", "10"), ("b", "20"), ("c", "30")]);
    let after = authority(&[("a", "10"), ("b", "20"), ("c", "20")]);
    assert_ne!(
        projection_revision(&identity(true), &before).expect("before"),
        projection_revision(&identity(true), &after).expect("ambiguous")
    );
    assert_eq!(
        projection_revision(&identity(false), &before).expect("before"),
        projection_revision(&identity(false), &after).expect("unused story")
    );
}

#[test]
fn required_reference_absence_ambiguity_and_foreign_project_fail_closed() {
    let valid = authority(&[("a", "10"), ("b", "20")]);
    for secret in [false, true] {
        for missing in ["a", "b"] {
            let mut changed = valid.clone();
            changed
                .mappings
                .retain(|m| m.scene_ref != format!("scene:{missing}"));
            assert!(projection_revision(&identity(secret), &changed).is_err());
        }
        let mut changed = valid.clone();
        changed.mappings.push(changed.mappings[1].clone());
        assert!(projection_revision(&identity(secret), &changed).is_err());
        let mut changed = valid.clone();
        changed.project_id = "other".into();
        assert!(projection_revision(&identity(secret), &changed).is_err());
    }
}

#[test]
fn keys_bind_all_input_identity_and_reject_aliases() {
    let original = identity(false);
    let key = original.source_key().expect("key");
    assert_eq!(
        ScopeDependencyIdentity::from_source_key(&key).expect("round trip"),
        original
    );
    let mut changed = original.clone();
    changed.run_id = "run:2".into();
    assert_ne!(key, changed.source_key().expect("key"));
    assert!(ScopeDependencyIdentity::from_source_key(&format!("{key}00")).is_err());
    assert!(ScopeDependencyIdentity::from_source_key("scope-dependency:v1:zz").is_err());
    let live = authority(&[("a", "10"), ("b", "20")]);
    assert_ne!(
        projection_revision(&original, &live).expect("original"),
        projection_revision(&changed, &live).expect("other Run")
    );
}
