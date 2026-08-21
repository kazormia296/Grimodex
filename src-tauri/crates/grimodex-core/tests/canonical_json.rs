use grimodex_core::{canonical_json_digest, canonical_json_string};
use serde_json::json;

#[test]
fn sorts_nested_object_keys_and_keeps_array_order() {
    let value = json!({
        "z": 1,
        "nested": { "日本語": "値", "a": true },
        "array": [{ "b": 2, "a": 1 }, "x"],
    });

    assert_eq!(
        canonical_json_string(&value).expect("canonical JSON"),
        r#"{"array":[{"a":1,"b":2},"x"],"nested":{"a":true,"日本語":"値"},"z":1}"#
    );
}

#[test]
fn emits_sha256_prefixed_digest_for_canonical_bytes() {
    let value = json!({ "b": 2, "a": 1 });

    assert_eq!(
        canonical_json_digest(&value).expect("canonical digest"),
        "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
    );
}
