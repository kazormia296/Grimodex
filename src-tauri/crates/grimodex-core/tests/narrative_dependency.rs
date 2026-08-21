use grimodex_core::narrative_dependency::{
    aggregate_dependency_build_actions, canonicalize_dependency_selector,
    canonicalize_dependency_set, compute_dependency_key, compute_dependency_set_digest,
    evaluate_dependency_effect, load_dependency_role_registry, validate_dependency_selector,
    ActionRequirement, BuildAction, DependencyEffect, DependencyEffectInput, DependencySelector,
    DependencySetDigestEntry, EvidenceFreshness,
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
fn shared_utf16_dependency_canonicalization_goldens_match() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../../policies/narrative/fixtures/dependency-role-contract.json"
    ))
    .expect("dependency role fixture parses");
    let selector_case = fixture
        .cases
        .iter()
        .find(|case| case["id"] == "utf16-object-identity-order-golden")
        .expect("UTF-16 selector golden");
    let selector: DependencySelector =
        serde_json::from_value(selector_case["selector"].clone()).expect("selector");
    assert_eq!(
        canonicalize_dependency_selector(&selector).expect("selector canonicalizes"),
        selector_case["canonicalSelector"]
            .as_str()
            .expect("canonical selector")
    );
    assert_eq!(
        compute_dependency_key(selector_case["role"].as_str().expect("role"), &selector,)
            .expect("dependency key computes"),
        selector_case["dependencyKey"]
            .as_str()
            .expect("dependency key")
    );

    let set_case = fixture
        .cases
        .iter()
        .find(|case| case["id"] == "utf16-dependency-set-tuple-order-golden")
        .expect("UTF-16 dependency set golden");
    let entries: Vec<DependencySetDigestEntry> =
        serde_json::from_value(set_case["entries"].clone()).expect("dependency set entries");
    assert_eq!(
        canonicalize_dependency_set(&entries).expect("dependency set canonicalizes"),
        set_case["canonicalDependencySet"]
            .as_str()
            .expect("canonical dependency set")
    );
    assert_eq!(
        compute_dependency_set_digest(&entries).expect("dependency set digest computes"),
        set_case["dependencySetDigest"]
            .as_str()
            .expect("dependency set digest")
    );
}

#[test]
fn rejects_dependency_text_ranges_beyond_javascript_safe_integer() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../../policies/narrative/fixtures/dependency-role-contract.json"
    ))
    .expect("dependency role fixture parses");
    let case = fixture
        .cases
        .iter()
        .find(|case| case["id"] == "utf16-range-rejects-unsafe-integer")
        .expect("safe integer boundary golden");
    let selector: DependencySelector =
        serde_json::from_value(case["selector"].clone()).expect("text range selector");
    assert!(validate_dependency_selector(&selector, None).is_err());
}

#[test]
fn rejects_dependency_text_ranges_with_whitespace_normalizer_version() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../../policies/narrative/fixtures/dependency-role-contract.json"
    ))
    .expect("dependency role fixture parses");
    let case = fixture
        .cases
        .iter()
        .find(|case| case["id"] == "utf16-range-rejects-whitespace-normalizer")
        .expect("trimmed normalizer version golden");
    let selector: DependencySelector =
        serde_json::from_value(case["selector"].clone()).expect("text range selector");
    assert!(validate_dependency_selector(&selector, None).is_err());
}

#[test]
fn normalizer_version_uses_shared_ascii_token_grammar() {
    let fixture: Fixture = serde_json::from_str(include_str!(
        "../../../../policies/narrative/fixtures/dependency-role-contract.json"
    ))
    .expect("dependency role fixture parses");
    for (id, expected_valid) in [
        ("utf16-range-rejects-feff-normalizer", false),
        ("utf16-range-rejects-next-line-normalizer", false),
        ("utf16-range-accepts-ascii-normalizer", true),
    ] {
        let case = fixture
            .cases
            .iter()
            .find(|case| case["id"] == id)
            .expect("normalizer token golden");
        let selector: DependencySelector =
            serde_json::from_value(case["selector"].clone()).expect("text range selector");
        assert_eq!(
            validate_dependency_selector(&selector, None).is_ok(),
            expected_valid,
            "{id}"
        );
    }
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

#[test]
fn malformed_required_refresh_available_fails_closed_to_manual() {
    let summary = aggregate_dependency_build_actions(&[DependencyEffect {
        freshness: EvidenceFreshness::Stale,
        reason_code: Some("source-revision-changed".to_string()),
        build_action: BuildAction::RefreshAvailable,
        action_requirement: ActionRequirement::Required,
    }]);
    assert_eq!(summary.required_actions, vec![BuildAction::Manual]);
    assert!(summary.advisory_actions.is_empty());
    assert_eq!(summary.compatibility_primary_action, BuildAction::Manual);
}
