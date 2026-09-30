use super::*;

#[test]
fn saved_query_matches_actual_javascript_raw_query_fixtures() {
    let fixtures: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../evals/nir1-retrieval/raw-query-parity.json"
    ))
    .expect("valid fixed JavaScript parity fixtures");
    for fixture in fixtures["cases"].as_array().expect("cases") {
        assert_eq!(
            saved_related_scene_query(fixture["content"].as_str().expect("content")),
            fixture["nativeQuery"].as_str().expect("native query"),
            "fixture {}",
            fixture["id"]
        );
    }
}

#[test]
fn utf16_tail_replaces_only_a_split_surrogate_at_the_existing_wire_boundary() {
    assert_eq!(
        saved_related_scene_query(&format!("😀{}", "x".repeat(499))),
        format!("\u{fffd}{}", "x".repeat(499))
    );
    assert_eq!(
        saved_related_scene_query(&format!("😀{}", "x".repeat(498))),
        format!("😀{}", "x".repeat(498))
    );
}

#[test]
fn ecmascript_trim_does_not_use_the_different_rust_whitespace_set() {
    assert_eq!(
        saved_related_scene_query("\u{feff}\u{0085}text\u{0085}\u{feff}"),
        "\u{0085}text\u{0085}"
    );
}
