use grimodex_db::import::{
    create_capture, get_capture, seal_capture, update_selection, CaptureEntryInput, CreateCaptureInput,
    UpdateCaptureSelectionInput,
};
use grimodex_db::Database;
use serde_json::json;

fn migrated_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db
}

fn create_fixture_capture(db: &Database, entries: Vec<CaptureEntryInput>) -> String {
    let capture = create_capture(
        db,
        CreateCaptureInput {
            capture_id: Some("capture-1".to_string()),
            source_kind: "folder".to_string(),
            budget_json: json!({ "maxFiles": 10_000 }),
            entries,
        },
    )
    .expect("create capture");
    capture["captureId"]
        .as_str()
        .expect("capture id")
        .to_string()
}

fn entry(id: &str, path: &str, digest: Option<&str>) -> CaptureEntryInput {
    CaptureEntryInput {
        entry_id: id.to_string(),
        resource_key: path.to_string(),
        parent_resource_key: None,
        relative_path: path.to_string(),
        kind: "file".to_string(),
        byte_length: 12,
        extension: Some("md".to_string()),
        capture_status: "included".to_string(),
        raw_digest: digest.map(str::to_string),
        blob_ref: None,
    }
}

#[test]
fn sealing_selected_entries_persists_a_stable_capture_digest() {
    let db = migrated_db();
    let capture_id = create_fixture_capture(
        &db,
        vec![
            entry("entry-a", "chapter-a.md", Some("digest-a")),
            entry("entry-b", "chapter-b.md", Some("digest-b")),
        ],
    );

    update_selection(
        &db,
        UpdateCaptureSelectionInput {
            capture_id: capture_id.clone(),
            selected_entry_ids: vec!["entry-b".to_string()],
        },
    )
    .expect("select entry");
    let sealed = seal_capture(&db, capture_id).expect("seal capture");

    assert_eq!(sealed["state"], "sealed");
    assert!(sealed["sealedDigest"].as_str().is_some_and(|value| !value.is_empty()));
    let loaded = get_capture(&db, "capture-1".to_string()).expect("load capture");
    assert_eq!(loaded["entries"].as_array().expect("entries").len(), 2);
}

#[test]
fn capture_rejects_parent_directory_paths() {
    let db = migrated_db();
    let error = create_capture(
        &db,
        CreateCaptureInput {
            capture_id: Some("invalid-capture".to_string()),
            source_kind: "folder".to_string(),
            budget_json: json!({}),
            entries: vec![entry("entry-invalid", "../escape.md", Some("digest"))],
        },
    )
    .expect_err("parent traversal must be rejected");

    assert!(error.to_string().contains("parent-directory"));
}

#[test]
fn capture_cannot_seal_when_a_selected_entry_lacks_digest() {
    let db = migrated_db();
    let capture_id = create_fixture_capture(&db, vec![entry("entry-a", "chapter.md", None)]);

    let error = seal_capture(&db, capture_id).expect_err("missing digest must block sealing");

    assert!(error.to_string().contains("raw_digest"));
}
