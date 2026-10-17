use super::*;
use serde_json::Value;

const VECTORS: &str = include_str!("decision_vectors.json");
const PRESETS: [&str; 5] = ["full", "assist-off", "review-only", "off", "custom"];

fn vectors() -> Vec<Value> {
    let root: Value = serde_json::from_str(VECTORS).expect("vector file");
    root["vectors"].as_array().expect("vectors").clone()
}

fn expect_decision(label: &str, purpose: Nir1LocalSendPurpose, raw: Option<&str>, want: &Value) {
    let got = decide(raw, purpose);
    let allow = want["allow"].as_bool().expect("allow");
    match got {
        Nir1LocalSendPolicyDecision::Allowed(basis) => {
            assert!(allow, "{label} {purpose:?}: allowed but expected denial");
            assert_eq!(
                basis.source.as_str(),
                want["source"].as_str().expect("source"),
                "{label} {purpose:?} source"
            );
            assert_eq!(basis.purpose, purpose, "{label}");
            let names = purpose.required_items();
            assert_eq!(basis.items[0].name, names[0], "{label}");
            assert_eq!(basis.items[1].name, names[1], "{label}");
            assert!(
                basis.items.iter().all(|item| item.value),
                "{label} {purpose:?}: an allowed basis holds only true items"
            );
        }
        Nir1LocalSendPolicyDecision::Denied(denial) => {
            assert!(
                !allow,
                "{label} {purpose:?}: denied ({denial:?}) but expected allow"
            );
            assert_eq!(
                denial.code(),
                want["code"].as_str().expect("code"),
                "{label} {purpose:?}"
            );
            assert_eq!(
                denial.item(),
                want["item"].as_str(),
                "{label} {purpose:?} item"
            );
        }
    }
}

#[test]
fn every_vector_decides_as_pinned_for_both_purposes() {
    let vectors = vectors();
    assert!(vectors.len() >= 100, "the vector file is not truncated");
    let mut labels = std::collections::BTreeSet::new();
    for vector in &vectors {
        let label = vector["label"].as_str().expect("label");
        assert!(labels.insert(label.to_owned()), "duplicate label {label}");
        let raw = vector["raw"].as_str();
        expect_decision(
            label,
            Nir1LocalSendPurpose::Writing,
            raw,
            &vector["writing"],
        );
        expect_decision(label, Nir1LocalSendPurpose::Review, raw, &vector["review"]);
    }
}

/// The five presets times the eight chat/bodyWrite/analysis combinations are all
/// present, for both purposes, and the allowed set is exactly the rule in the
/// draft (Writing: chat and bodyWrite; Review: chat and analysis). The preset
/// does not change the outcome: the stored toggles decide.
#[test]
fn matrix_covers_five_presets_by_eight_toggle_combinations() {
    let vectors = vectors();
    for preset in PRESETS {
        for bits in 0u8..8 {
            let (chat, body, analysis) = (bits & 1 != 0, bits & 2 != 0, bits & 4 != 0);
            let label = format!("matrix-{preset}-chat={chat}-bodyWrite={body}-analysis={analysis}");
            let vector = vectors
                .iter()
                .find(|vector| vector["label"] == label.as_str())
                .unwrap_or_else(|| panic!("missing matrix vector {label}"));
            assert_eq!(vector["writing"]["allow"], chat && body, "{label} writing");
            assert_eq!(
                vector["review"]["allow"],
                chat && analysis,
                "{label} review"
            );
        }
    }
    let matrix = vectors
        .iter()
        .filter(|vector| {
            vector["label"]
                .as_str()
                .is_some_and(|l| l.starts_with("matrix-"))
        })
        .count();
    assert_eq!(matrix, 40);
}

#[test]
fn absent_input_is_the_documented_default_and_allows_both_purposes() {
    for purpose in [Nir1LocalSendPurpose::Writing, Nir1LocalSendPurpose::Review] {
        let Nir1LocalSendPolicyDecision::Allowed(basis) = decide(None, purpose) else {
            panic!("None must allow {purpose:?}");
        };
        assert_eq!(basis.source, Nir1LocalSendPolicySource::DefaultUnset);
        assert!(basis.items.iter().all(|item| item.value));
    }
}

/// The absent input is only `None`. The JSON text `null` is a stored value that
/// is not an object and denies.
#[test]
fn json_null_text_is_not_the_absent_input() {
    for purpose in [Nir1LocalSendPurpose::Writing, Nir1LocalSendPurpose::Review] {
        assert_eq!(
            decide(Some("null"), purpose),
            Nir1LocalSendPolicyDecision::Denied(Nir1LocalSendPolicyDenial::NotObject)
        );
    }
}

#[test]
fn every_unreadable_vector_denies_both_purposes() {
    let unreadable: Vec<_> = vectors()
        .into_iter()
        .filter(|vector| {
            vector["label"]
                .as_str()
                .is_some_and(|l| l.starts_with("unreadable-"))
        })
        .collect();
    assert!(unreadable.len() >= 50, "{}", unreadable.len());
    for vector in unreadable {
        let raw = vector["raw"]
            .as_str()
            .expect("an unreadable vector has text");
        for purpose in [Nir1LocalSendPurpose::Writing, Nir1LocalSendPurpose::Review] {
            let decision = decide(Some(raw), purpose);
            let Nir1LocalSendPolicyDecision::Denied(denial) = decision else {
                panic!("{} must deny {purpose:?}", vector["label"]);
            };
            assert!(denial.is_unreadable(), "{}", vector["label"]);
        }
    }
}

/// `structureWrite` and `knowledgeWrite` are never read: missing, false,
/// non-boolean and nested values give the same result as the plain matrix row
/// with the same chat/bodyWrite/analysis.
#[test]
fn structure_and_knowledge_toggles_never_change_the_result() {
    let vectors = vectors();
    let extras: Vec<_> = vectors
        .iter()
        .filter(|vector| {
            vector["label"]
                .as_str()
                .is_some_and(|l| l.starts_with("extra-"))
        })
        .collect();
    assert_eq!(extras.len(), 6 * 8);
    for extra in extras {
        let raw = extra["raw"].as_str().expect("raw");
        let parsed: Value = serde_json::from_str(raw).expect("json");
        let toggles = &parsed["toggles"];
        let (chat, body, analysis) = (
            toggles["chat"].as_bool().expect("chat"),
            toggles["bodyWrite"].as_bool().expect("bodyWrite"),
            toggles["analysis"].as_bool().expect("analysis"),
        );
        let reference = format!("{{\"preset\":\"custom\",\"toggles\":{{\"chat\":{chat},\"bodyWrite\":{body},\"analysis\":{analysis},\"structureWrite\":true,\"knowledgeWrite\":true}}}}");
        for purpose in [Nir1LocalSendPurpose::Writing, Nir1LocalSendPurpose::Review] {
            assert_eq!(
                decide(Some(raw), purpose),
                decide(Some(&reference), purpose),
                "{} {purpose:?}",
                extra["label"]
            );
        }
    }
}

#[test]
fn only_the_purposes_own_items_are_recorded_and_checked() {
    let raw = r#"{"preset":"custom","toggles":{"chat":true,"bodyWrite":true,"analysis":false}}"#;
    let Nir1LocalSendPolicyDecision::Allowed(basis) =
        decide(Some(raw), Nir1LocalSendPurpose::Writing)
    else {
        panic!("Writing does not look at analysis");
    };
    assert_eq!(
        serde_json::to_value(basis).expect("basis"),
        serde_json::json!({
            "purpose": "writing",
            "source": "stored",
            "items": [
                {"name": "chat", "value": true},
                {"name": "bodyWrite", "value": true}
            ]
        })
    );
    assert_eq!(
        decide(Some(raw), Nir1LocalSendPurpose::Review),
        Nir1LocalSendPolicyDecision::Denied(Nir1LocalSendPolicyDenial::ItemDisabled("analysis"))
    );
}

#[test]
fn oversize_text_denies_before_it_is_parsed() {
    let padding = "x".repeat(NIR1_LOCAL_SEND_POLICY_MAX_BYTES);
    let raw = format!(
        r#"{{"preset":"full","toggles":{{"chat":true,"bodyWrite":true,"analysis":true}},"pad":"{padding}"}}"#
    );
    assert!(raw.len() > NIR1_LOCAL_SEND_POLICY_MAX_BYTES);
    for purpose in [Nir1LocalSendPurpose::Writing, Nir1LocalSendPurpose::Review] {
        assert_eq!(
            decide(Some(&raw), purpose),
            Nir1LocalSendPolicyDecision::Denied(Nir1LocalSendPolicyDenial::TooLarge)
        );
    }
    // A readable policy exactly at the limit still reads.
    let at_limit_padding = "x".repeat(
        NIR1_LOCAL_SEND_POLICY_MAX_BYTES
            - r#"{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true},"pad":""}"#
                .len(),
    );
    let at_limit = format!(
        r#"{{"preset":"full","toggles":{{"chat":true,"bodyWrite":true,"analysis":true}},"pad":"{at_limit_padding}"}}"#
    );
    assert_eq!(at_limit.len(), NIR1_LOCAL_SEND_POLICY_MAX_BYTES);
    assert!(decide(Some(&at_limit), Nir1LocalSendPurpose::Writing).is_allowed());
}

#[test]
fn deeply_nested_json_denies_instead_of_overflowing() {
    let depth = 10_000;
    let raw = format!("{}{}", "[".repeat(depth), "]".repeat(depth));
    assert!(raw.len() < NIR1_LOCAL_SEND_POLICY_MAX_BYTES);
    assert_eq!(
        decide(Some(&raw), Nir1LocalSendPurpose::Writing),
        Nir1LocalSendPolicyDecision::Denied(Nir1LocalSendPolicyDenial::NotJson)
    );
}

/// The check is independent of the existing parser: input the existing parser
/// turns into full, this check denies, and the existing parser is untouched.
#[test]
fn the_existing_parser_still_falls_back_to_full_where_this_check_denies() {
    for raw in [
        "not-json",
        r#"{"preset":"bogus","toggles":{"chat":false}}"#,
        "[]",
    ] {
        let legacy = crate::policy::parse_policy_json(raw).expect("legacy parser");
        assert!(legacy.chat && legacy.body_write && legacy.analysis, "{raw}");
        assert!(
            !decide(Some(raw), Nir1LocalSendPurpose::Writing).is_allowed(),
            "{raw}"
        );
        assert!(
            !decide(Some(raw), Nir1LocalSendPurpose::Review).is_allowed(),
            "{raw}"
        );
    }
}
