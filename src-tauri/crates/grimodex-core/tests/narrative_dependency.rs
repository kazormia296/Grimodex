use grimodex_core::narrative_dependency::{
    aggregate_dependency_build_actions, canonicalize_dependency_selector, compute_dependency_key,
    evaluate_dependency_effect, load_dependency_role_registry, ActionRequirement, BuildAction,
    DependencyEffect, DependencyEffectInput, DependencySelector, EvidenceFreshness,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Fixture {
    cases: Vec<serde_json::Value>,
}

#[test]
fn shared_effect_fixtures_match_the_pure_rust_evaluator() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../../policies/narrative/fixtures/dependency-role-contract.json"
    ))
    .expect("dependency role fixture parses");
    let registry = load_dependency_role_registry().expect("dependency role policy parses");

    for case in fixture
        .cases
        .iter()
        .filter(|case| case["kind"] == "effect-evaluation" && case["expected"] != "reject")
    {
        let input = &case["input"];
        let result = evaluate_dependency_effect(
            &registry,
            DependencyEffectInput {
                role: input["role"].as_str().expect("role"),
                consumer_kind: input["consumerKind"].as_str().expect("consumer kind"),
                change_class: input["changeClass"].as_str().expect("change class"),
            },
        )
        .expect("registered effect");
        assert_eq!(
            serde_json::to_value(result).expect("effect serializes"),
            case["expected"]
        );
    }
}

#[test]
fn unknown_role_and_combination_fail_closed() {
    let registry = load_dependency_role_registry().expect("dependency role policy parses");
    let unknown_role = evaluate_dependency_effect(
        &registry,
        DependencyEffectInput {
            role: "future-role",
            consumer_kind: "proposal-revision",
            change_class: "source-content-changed",
        },
    )
    .expect_err("unknown role must be rejected");
    assert!(unknown_role.to_string().contains("unknown dependency role"));

    let unknown_combination = evaluate_dependency_effect(
        &registry,
        DependencyEffectInput {
            role: "direct-evidence",
            consumer_kind: "semantic-index",
            change_class: "source-content-changed",
        },
    )
    .expect_err("undefined combination must be rejected");
    assert!(unknown_combination.to_string().contains("no effect rule"));
}

#[test]
fn selector_and_dependency_key_match_the_shared_golden() {
    let selector = DependencySelector::WholeSource;
    assert_eq!(
        canonicalize_dependency_selector(&selector).expect("selector canonicalizes"),
        r#"{"kind":"whole-source"}"#
    );
    assert_eq!(
        compute_dependency_key("direct-evidence", &selector).expect("key computes"),
        "sha256:dc5ae15ade6f6ce31c7dece2a1ec161caed32628ae27e1c70f88bf035b54fc0c"
    );
}

#[test]
fn required_and_advisory_actions_are_aggregated_independently() {
    let effects = vec![
        DependencyEffect {
            freshness: EvidenceFreshness::Fresh,
            reason_code: None,
            build_action: BuildAction::RefreshAvailable,
            action_requirement: ActionRequirement::Advisory,
        },
        DependencyEffect {
            freshness: EvidenceFreshness::Stale,
            reason_code: Some("source-revision-changed".to_string()),
            build_action: BuildAction::ResolveOnly,
            action_requirement: ActionRequirement::Required,
        },
    ];
    let summary = aggregate_dependency_build_actions(&effects);
    assert_eq!(summary.required_actions, vec![BuildAction::ResolveOnly]);
    assert_eq!(
        summary.advisory_actions,
        vec![BuildAction::RefreshAvailable]
    );
    assert_eq!(
        summary.compatibility_primary_action,
        BuildAction::ResolveOnly
    );
}
