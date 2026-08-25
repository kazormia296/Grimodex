use grimodex_core::canonical_json_digest;
use grimodex_core::narrative_project_scope_authority::{
    build_narrative_project_scope_authority_v1, canonical_project_reading_order_revision_input,
    canonical_project_scope_authority_revision_input,
    canonical_project_scope_registry_revision_input,
    canonical_project_story_time_order_revision_input, NarrativeProjectScopeAuthoritySceneInputV1,
};
use grimodex_core::narrative_scope_authority_basis::{
    NarrativeScopeAuthorityStoryTimeOrderV2, NarrativeScopeAuthorityUnresolvedReasonV2,
};
use serde::Serialize;
use serde_json::json;

fn scene(
    scene_id: &str,
    raw_story_key: Option<&str>,
) -> NarrativeProjectScopeAuthoritySceneInputV1 {
    NarrativeProjectScopeAuthoritySceneInputV1 {
        scene_id: scene_id.to_owned(),
        raw_story_key: raw_story_key.map(str::to_owned),
    }
}

fn digest<T: Serialize>(value: &T) -> String {
    canonical_json_digest(&serde_json::to_value(value).expect("projection serializes"))
        .expect("projection canonicalizes")
}

#[test]
fn builds_the_fixed_project_source_identity_and_typed_revision_domain() {
    // The caller supplies only the live, non-archived Scene projection in
    // persisted Reading DFS order. Tree traversal and SQL stay outside Core;
    // title/content/version/timestamps/storyTimeLabel/Chronicle fields cannot
    // enter this typed digest boundary.
    let authority = build_narrative_project_scope_authority_v1(
        "project-a",
        &[
            scene("scene-b", Some("20")),
            scene("scene-a", None),
            scene("scene-c", Some("10")),
        ],
    )
    .expect("build live project authority");

    assert_eq!(authority.project_id, "project-a");
    assert_eq!(authority.source.source_kind, "project-scope-authority");
    assert_eq!(
        authority.source.source_key,
        "project:scope-authority:project-a"
    );
    assert_eq!(authority.scope_registry.reserved_audience_refs, ["reader"]);
    assert_eq!(authority.mappings[0].source_key, "project:scene:scene-b");
    assert_eq!(authority.mappings[0].scene_ref, "scene:scene-b");
    assert_eq!(authority.mappings[0].reading_order_ref, "reading:scene-b");
    assert_eq!(authority.mappings[0].story_time_ref, "story:scene-b");
    assert_eq!(authority.mappings[0].reading_rank, 0);
    assert_eq!(
        authority.source.revision_token,
        digest(&canonical_project_scope_authority_revision_input(
            &authority
        ))
    );
    assert_eq!(
        canonical_project_scope_authority_revision_input(&authority).contract_id,
        "narrative-project-scope-authority-revision/1"
    );
    assert_eq!(
        serde_json::to_value(canonical_project_scope_authority_revision_input(&authority,))
            .expect("revision input serializes"),
        json!({
            "contractId": "narrative-project-scope-authority-revision/1",
            "projectId": "project-a",
            "source": {
                "sourceKind": "project-scope-authority",
                "sourceKey": "project:scope-authority:project-a"
            },
            "scopeRegistryRevision": authority.digests.scope_registry_revision,
            "readingOrderRevision": authority.digests.reading_order_revision,
            "storyTimeOrderRevision": authority.digests.story_time_order_revision
        })
    );
    assert!(authority.source.revision_token.starts_with("sha256:"));
}

#[test]
fn reading_and_story_changes_are_sealed_in_independent_axis_revisions() {
    let base = build_narrative_project_scope_authority_v1(
        "project-a",
        &[scene("scene-a", Some("10")), scene("scene-b", Some("20"))],
    )
    .expect("base authority");
    let reordered = build_narrative_project_scope_authority_v1(
        "project-a",
        &[scene("scene-b", Some("20")), scene("scene-a", Some("10"))],
    )
    .expect("Reading DFS reorder");
    let story_changed = build_narrative_project_scope_authority_v1(
        "project-a",
        &[scene("scene-a", Some("30")), scene("scene-b", Some("20"))],
    )
    .expect("Story projection change");

    assert_eq!(
        base.digests.scope_registry_revision,
        reordered.digests.scope_registry_revision
    );
    assert_ne!(
        base.digests.reading_order_revision,
        reordered.digests.reading_order_revision
    );
    assert_eq!(
        base.digests.story_time_order_revision,
        reordered.digests.story_time_order_revision
    );
    assert_ne!(base.source.revision_token, reordered.source.revision_token);

    assert_eq!(
        base.digests.scope_registry_revision,
        story_changed.digests.scope_registry_revision
    );
    assert_eq!(
        base.digests.reading_order_revision,
        story_changed.digests.reading_order_revision
    );
    assert_ne!(
        base.digests.story_time_order_revision,
        story_changed.digests.story_time_order_revision
    );
    assert_ne!(
        base.source.revision_token,
        story_changed.source.revision_token
    );

    assert_eq!(
        base.digests.scope_registry_revision,
        digest(&canonical_project_scope_registry_revision_input(&base))
    );
    assert_eq!(
        base.digests.reading_order_revision,
        digest(&canonical_project_reading_order_revision_input(&base))
    );
    assert_eq!(
        base.digests.story_time_order_revision,
        digest(&canonical_project_story_time_order_revision_input(&base))
    );
}

#[test]
fn null_and_duplicate_story_keys_remain_axis_unresolved_without_reading_fallback() {
    let authority = build_narrative_project_scope_authority_v1(
        "project-a",
        &[
            scene("scene-first", None),
            scene("scene-second", Some("duplicate")),
            scene("scene-third", Some("duplicate")),
            scene("scene-fourth", Some("unique")),
        ],
    )
    .expect("authority with unresolved Story entries");

    assert!(matches!(
        &authority.mappings[0].story_time_order,
        NarrativeScopeAuthorityStoryTimeOrderV2::Unresolved {
            reason: NarrativeScopeAuthorityUnresolvedReasonV2::NotProvided,
            ..
        }
    ));
    for mapping in &authority.mappings[1..=2] {
        assert!(matches!(
            &mapping.story_time_order,
            NarrativeScopeAuthorityStoryTimeOrderV2::Unresolved {
                reason: NarrativeScopeAuthorityUnresolvedReasonV2::Ambiguous,
                ..
            }
        ));
    }
    assert!(matches!(
        &authority.mappings[3].story_time_order,
        NarrativeScopeAuthorityStoryTimeOrderV2::Resolved { story_rank: 0, .. }
    ));

    let mappings = serde_json::to_value(&authority.mappings).expect("mappings serialize");
    assert_eq!(
        mappings[0]["storyTimeOrder"],
        json!({
            "status": "unresolved",
            "reason": "not-provided",
            "rawStoryKey": null
        })
    );
    assert_eq!(
        mappings[1]["storyTimeOrder"],
        json!({
            "status": "unresolved",
            "reason": "ambiguous",
            "rawStoryKey": "duplicate"
        })
    );
    assert_eq!(authority.mappings[0].reading_rank, 0);
    assert_eq!(authority.mappings[1].reading_rank, 1);
    assert_eq!(authority.mappings[2].reading_rank, 2);
    assert_eq!(authority.mappings[3].reading_rank, 3);
}

#[test]
fn registry_membership_is_order_independent_and_invalid_typed_inputs_fail_closed() {
    let left = build_narrative_project_scope_authority_v1(
        "project-a",
        &[
            scene("\u{e000}", Some("\u{e000}")),
            scene("\u{1f600}", Some("\u{1f600}")),
        ],
    )
    .expect("left authority");
    let right = build_narrative_project_scope_authority_v1(
        "project-a",
        &[
            scene("\u{1f600}", Some("\u{1f600}")),
            scene("\u{e000}", Some("\u{e000}")),
        ],
    )
    .expect("right authority");
    assert_eq!(
        left.digests.scope_registry_revision,
        right.digests.scope_registry_revision
    );
    assert_ne!(
        left.digests.reading_order_revision,
        right.digests.reading_order_revision
    );
    assert_eq!(
        left.digests.story_time_order_revision,
        right.digests.story_time_order_revision
    );

    assert!(build_narrative_project_scope_authority_v1(" project-a", &[]).is_err());
    assert!(build_narrative_project_scope_authority_v1(
        "project-a",
        &[scene("scene-a", None), scene("scene-a", Some("10"))]
    )
    .is_err());
    assert!(
        build_narrative_project_scope_authority_v1("project-a", &[scene("scene-a", Some(""))])
            .is_err()
    );

    // A live project can legitimately have no Scene yet. Its aggregate still
    // has a deterministic project-scoped identity and revision token.
    let empty = build_narrative_project_scope_authority_v1("project-empty", &[])
        .expect("empty project authority");
    assert!(empty.mappings.is_empty());
    assert_eq!(
        empty.source.source_key,
        "project:scope-authority:project-empty"
    );
}
