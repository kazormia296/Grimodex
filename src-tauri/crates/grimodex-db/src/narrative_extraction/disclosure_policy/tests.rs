use super::*;
fn input() -> Value {
    json!({"project":"p1","authorityProject":"p1","axis":"reading","querySceneRef":"scene:s2","queryRank":2,
      "materials":[{"sourceKey":"project:scene:s1","sceneRef":"scene:s1","readingRank":1}],
      "scope":{"schemaVersion":2,"registryVersion":"narrative-scope/2","scene":{"kind":"exact","ref":"scene:s1"},
      "audience":{"kind":"any"},"knowledgeHolder":{"kind":"any"},"narrativeLayer":{"kind":"any"},"readingOrder":{"kind":"any"},"storyTime":{"kind":"any"},"timeline":{"kind":"any"},"viewpoint":{"kind":"any"},"worldline":{"kind":"any"}},
      "evidenceSources":["project:scene:s1"],"secret":false,"bindingValid":true,"approved":true})
}
#[test]
fn historical_reference_preserves_exact_scene_and_query() {
    let i = input();
    let before = i.clone();
    let r = evaluate(&i);
    assert_eq!(r["materialAdmission"]["status"], "admitted");
    assert_eq!(r["candidateAdmission"]["status"], "admitted");
    assert_eq!(i, before);
}
#[test]
fn all_materials_must_be_mapped_same_project_and_strictly_before() {
    for (pointer, value) in [
        ("/materials/0/readingRank", json!(2)),
        ("/materials/0/readingRank", json!(3)),
        ("/materials/0/readingRank", Value::Null),
        ("/materials/0/sceneRef", Value::Null),
        ("/authorityProject", json!("other")),
        ("/materials", json!([])),
    ] {
        let mut i = input();
        *i.pointer_mut(pointer).expect("test pointer") = value;
        assert_ne!(
            evaluate(&i)["materialAdmission"]["status"],
            "admitted",
            "{pointer}"
        );
    }
    let mut i = input();
    i["materials"].as_array_mut().expect("array").push(json!({"sourceKey":"project:scene:future","sceneRef":"scene:future","readingRank":3,"kind":"context"}));
    assert_eq!(evaluate(&i)["materialAdmission"]["status"], "denied");
}
#[test]
fn story_axis_is_not_reinterpreted() {
    let mut i = input();
    i["axis"] = json!("story");
    assert_eq!(evaluate(&i)["materialAdmission"]["status"], "unsupported");
    assert_eq!(evaluate(&i)["candidateAdmission"]["status"], "unsupported");
}
#[test]
fn material_admission_cannot_rescue_candidate() {
    for (pointer, value) in [
        (
            "/scope/scene",
            json!({"kind":"unresolved","reason":"unknown"}),
        ),
        ("/scope/scene/ref", json!("scene:other")),
        ("/secret", json!(true)),
        ("/approved", json!(false)),
        ("/bindingValid", json!(false)),
        ("/evidenceSources", json!(["project:scene:other"])),
        (
            "/scope/viewpoint",
            json!({"kind":"exact","ref":"character:someone"}),
        ),
        (
            "/scope/readingOrder",
            json!({"kind":"exact","ref":"reading:1"}),
        ),
    ] {
        let mut i = input();
        *i.pointer_mut(pointer).expect("pointer") = value;
        let r = evaluate(&i);
        assert_eq!(r["materialAdmission"]["status"], "admitted");
        assert_ne!(r["candidateAdmission"]["status"], "admitted", "{pointer}");
    }
}
#[test]
fn reader_identity_is_the_only_supported_constrained_non_scene_axis() {
    let mut i = input();
    i["scope"]["audience"] = json!({"kind":"exact","ref":"reader"});
    assert_eq!(evaluate(&i)["candidateAdmission"]["status"], "admitted");
    i["scope"]["audience"] = json!({"kind":"exact","ref":"audience:other"});
    assert_ne!(evaluate(&i)["candidateAdmission"]["status"], "admitted");
}
#[test]
fn static_classification_is_content_version_and_digest_bound() {
    let contracts: Value =
        serde_json::from_str(include_str!("../material_roster/contracts.json")).expect("contracts");
    let stages = [
        ("narrative_observation_extract", OBSERVATION_DIGEST),
        ("narrative_event_synthesize", SYNTHESIS_DIGEST),
    ];
    for (stage, digest) in stages {
        assert!(known_static_contract(stage, digest, &contracts[stage]).expect("digest"));
        let mut changed = contracts[stage].clone();
        changed["instruction"] = json!("story secret");
        assert!(!known_static_contract(stage, digest, &changed).expect("digest"));
        assert!(
            !known_static_contract(stage, "sha256:unknown", &contracts[stage]).expect("digest")
        );
        changed = contracts[stage].clone();
        changed["contractVersion"] = json!("unknown");
        assert!(!known_static_contract(stage, digest, &changed).expect("digest"));
    }
    assert!(!known_static_contract(
        "unknown",
        OBSERVATION_DIGEST,
        &contracts["narrative_observation_extract"]
    )
    .expect("digest"));
}
