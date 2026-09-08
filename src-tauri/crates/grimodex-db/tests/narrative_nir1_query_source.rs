//! Saved query-source and typed IR context contracts on the normal UI fixture.
//! Raw-query conversion belongs to its existing adapter; these readers return
//! complete persisted storage and independently bound canonical source text.
use std::io::Read;
use std::path::PathBuf;

use flate2::read::GzDecoder;
use grimodex_db::domain_writes::{
    project_patch, tree_node_patch, ProjectPatchPayload, TreeNodePatchPayload,
};
use grimodex_db::narrative_extraction::change_feed::NarrativeChangeOrigin;
use grimodex_db::narrative_extraction::{
    read_retrieval_query_context, read_retrieval_scene_source, QueryIdentityState,
    RetrievalQueryContext, RetrievalQueryContextRead, RetrievalSceneSource,
    RetrievalSceneSourceRead, RevisionEligibilityReason,
};
use grimodex_db::Database;
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const COLD_QUERY_TEXT: &str = "NIR1_S2_MUST_NOT_ENTER_REQUEST";
const COLD_QUERY_STORAGE: &str = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"NIR1_S2_MUST_NOT_ENTER_REQUEST"}]}]}"#;
const COLD_QUERY_UPDATED_AT: &str = "2026-09-08T05:15:06.055605704+00:00";

struct Fixture {
    path: PathBuf,
    manifest: Value,
}

impl Fixture {
    fn new() -> Self {
        let manifest: Value =
            serde_json::from_str(include_str!("support/nir1-reviewed-child-cold.json"))
                .expect("normal UI cold fixture manifest");
        let compressed = include_bytes!("support/nir1-reviewed-child-cold.db.gz");
        assert_eq!(
            hex::encode(Sha256::digest(compressed)),
            manifest["compressedDatabaseSha256"]
        );
        let mut bytes = Vec::new();
        GzDecoder::new(compressed.as_slice())
            .read_to_end(&mut bytes)
            .expect("exact cold fixture bytes");
        assert_eq!(
            hex::encode(Sha256::digest(&bytes)),
            manifest["uncompressedDatabaseSha256"]
        );
        let path =
            std::env::temp_dir().join(format!("grimodex-nir1-query-source-{}.db", Uuid::new_v4()));
        std::fs::write(&path, bytes).expect("private exact cold fixture copy");
        Self { path, manifest }
    }

    fn project(&self) -> &str {
        self.manifest["projectId"].as_str().expect("project")
    }

    fn scene(&self, key: &str) -> &str {
        self.manifest[key].as_str().expect("fixture Scene")
    }

    fn read_only(&self) -> Connection {
        Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("read-only cold fixture")
    }

    fn database_digest(&self) -> String {
        sha256(&std::fs::read(&self.path).expect("whole persisted DB bytes"))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        for suffix in ["-wal", "-shm"] {
            let mut path = self.path.as_os_str().to_os_string();
            path.push(suffix);
            let _ = std::fs::remove_file(PathBuf::from(path));
        }
    }
}

fn sha256(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn source(conn: &Connection, fixture: &Fixture) -> RetrievalSceneSource {
    match read_retrieval_scene_source(conn, fixture.project(), fixture.scene("s2"))
        .expect("typed saved Scene source read")
    {
        RetrievalSceneSourceRead::Available(source) => source,
        other => panic!("saved query source must be available: {other:?}"),
    }
}

fn context(conn: &Connection, fixture: &Fixture) -> RetrievalQueryContext {
    match read_retrieval_query_context(conn, fixture.project(), fixture.scene("s2"))
        .expect("typed query context read")
    {
        RetrievalQueryContextRead::Available(context) => context,
        other => panic!("reading query context must be available: {other:?}"),
    }
}

fn assert_persisted_source(
    conn: &Connection,
    fixture: &Fixture,
    source: &RetrievalSceneSource,
    expected_canonical_text: &str,
) {
    let (content, version, updated_at, mode, archived): (String, i64, String, String, bool) = conn
        .query_row(
            "SELECT t.content,t.version,t.updated_at,p.phase_resolution_mode,
                    t.archived_at IS NOT NULL
               FROM tree_nodes t JOIN projects p ON p.id=t.project_id
              WHERE t.project_id=?1 AND t.id=?2",
            params![fixture.project(), fixture.scene("s2")],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .expect("independent persisted source coordinates");
    assert_eq!(source.project_id, fixture.project());
    assert_eq!(source.scene_id, fixture.scene("s2"));
    assert_eq!(source.phase_resolution_mode, mode);
    assert_eq!(source.archived, archived);
    assert_eq!(source.saved_content_json, content);
    assert_eq!(source.canonical_source_text, expected_canonical_text);
    assert_eq!(
        source.query_source.source_key,
        format!("project:scene:{}", fixture.scene("s2"))
    );
    assert_eq!(source.query_source.source_version, version);
    assert_eq!(
        source.query_source.revision_token,
        format!("v{version}@{updated_at}")
    );
    assert_eq!(
        source.query_source.normalizer_version,
        "gdx-canonical-text/1"
    );
    assert_eq!(
        source.query_source.storage_digest,
        sha256(content.as_bytes())
    );
    assert_eq!(
        source.query_source.canonical_text_digest,
        sha256(expected_canonical_text.as_bytes())
    );
    assert_eq!(
        source.query_source.canonical_utf16_length,
        expected_canonical_text.encode_utf16().count()
    );
}

fn assert_context_source(context: &RetrievalQueryContext, source: &RetrievalSceneSource) {
    assert_eq!(context.project_id, source.project_id);
    assert_eq!(context.query_scene_id, source.scene_id);
    assert_eq!(context.phase_resolution_mode, source.phase_resolution_mode);
    assert_eq!(context.query_source, source.query_source);
    assert_eq!(context.saved_content_json, source.saved_content_json);
    assert_eq!(context.canonical_source_text, source.canonical_source_text);
}

fn native_patch_node(db: &Database, fixture: &Fixture, scene: &str, patch: Value) {
    let version: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT version FROM tree_nodes WHERE id=?1",
                [scene],
                |row| row.get(0),
            )?)
        })
        .expect("Native node OCC token");
    let id = Uuid::new_v4().to_string();
    tree_node_patch(
        db,
        TreeNodePatchPayload {
            project_id: fixture.project().to_owned(),
            request_id: format!("nir1-query-source-{id}"),
            session_id: "nir1-query-source-session".to_owned(),
            event_uid: id,
            node_id: scene.to_owned(),
            patch: patch.as_object().expect("Native node patch").clone(),
            base_version: Some(version),
            bump_version: true,
            updated_at: format!("2026-09-09T09:00:{:02}.000Z", version + 1),
            change_event: None,
            timelapse_doc_step_coverage: None,
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            source_domain: None,
            op_type: None,
            canonical_payload: None,
        },
    )
    .expect("production Native saved Scene mutation");
}

fn native_set_mode(db: &Database, fixture: &Fixture, mode: &str) {
    let (current_mode, base_updated_at): (String, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT phase_resolution_mode,updated_at FROM projects WHERE id=?1",
                [fixture.project()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("Native project OCC token");
    if current_mode == mode {
        return;
    }
    let id = Uuid::new_v4().to_string();
    project_patch(
        db,
        ProjectPatchPayload {
            project_id: fixture.project().to_owned(),
            request_id: format!("nir1-query-mode-{id}"),
            session_id: "nir1-query-source-session".to_owned(),
            event_uid: id,
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            base_updated_at,
            updated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            patch: json!({"phaseResolutionMode":mode})
                .as_object()
                .expect("Native mode patch")
                .clone(),
        },
    )
    .expect("production Native project mode mutation");
}

#[test]
fn exact_normal_ui_query_source_and_context_bind_persisted_bytes_without_writes() {
    let fixture = Fixture::new();
    let before = fixture.database_digest();
    {
        let conn = fixture.read_only();
        let tx = conn.unchecked_transaction().expect("caller read snapshot");
        let source = source(&tx, &fixture);
        assert_eq!(source.saved_content_json, COLD_QUERY_STORAGE);
        assert_eq!(source.canonical_source_text, COLD_QUERY_TEXT);
        assert_eq!(source.query_source.source_version, 0);
        assert_eq!(
            source.query_source.revision_token,
            format!("v0@{COLD_QUERY_UPDATED_AT}")
        );
        assert!(!source.archived);
        assert_persisted_source(&tx, &fixture, &source, COLD_QUERY_TEXT);
        assert_context_source(&context(&tx, &fixture), &source);
        assert_eq!(
            tx.query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0))
                .expect("reader write counter"),
            0
        );
        tx.commit().expect("close read transaction without changes");
    }
    assert_eq!(fixture.database_digest(), before);
    assert_eq!(
        before,
        format!(
            "sha256:{}",
            fixture.manifest["uncompressedDatabaseSha256"]
                .as_str()
                .expect("manifest whole DB digest")
        )
    );
}

#[test]
fn reading_context_exposes_each_a2_identity_state_without_inventing_authority() {
    let fixture = Fixture::new();
    let conn = fixture.read_only();
    let tx = conn.unchecked_transaction().expect("identity snapshot");
    let context = context(&tx, &fixture);
    assert_eq!(
        context.query_scene_ref,
        format!("scene:{}", fixture.scene("s2"))
    );
    assert_eq!(context.query_reading_rank, 1);
    assert_eq!(context.phase_resolution_mode, "auto");
    assert_eq!(context.effective_axis, "reading");
    assert_eq!(
        context.axis_fallback_reason.as_deref(),
        Some("auto-incomplete-story-coverage")
    );
    assert_eq!(
        context.audience,
        QueryIdentityState::Resolved("reader".into())
    );
    assert_eq!(
        context.viewpoint,
        QueryIdentityState::NotApplicable {
            reason: "reader-reference-purpose"
        }
    );
    assert_eq!(
        context.knowledge_holder,
        QueryIdentityState::NotApplicable {
            reason: "reader-reference-purpose"
        }
    );
    assert_eq!(
        context.timeline,
        QueryIdentityState::Unavailable {
            reason: "query-scene-has-no-timeline-authority"
        }
    );
    assert_eq!(
        context.worldline,
        QueryIdentityState::Unavailable {
            reason: "query-scene-has-no-worldline-authority"
        }
    );
    assert_eq!(
        context.narrative_layer,
        QueryIdentityState::Unavailable {
            reason: "query-scene-has-no-layer-authority"
        }
    );
    assert_eq!(
        context.reading_order,
        QueryIdentityState::Resolved(format!("reading:{}", fixture.scene("s2")))
    );
    assert_eq!(
        context.story_time,
        QueryIdentityState::Unavailable {
            reason: "initial-reading-profile"
        }
    );
    assert!(!context.allow_secrets);
    assert_eq!(
        context.scope_authority_source_key,
        format!("project:scope-authority:{}", fixture.project())
    );
    assert!(context
        .scope_authority_revision_token
        .starts_with("sha256:"));
    assert_ne!(
        context.scope_authority_revision_token,
        context.query_source.revision_token
    );
}

#[test]
fn native_body_edit_rebinds_storage_canonical_unicode_length_and_revision_coordinates() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let before = db
        .with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            Ok(source(&tx, &fixture))
        })
        .expect("before Native body update");
    let storage = json!({"type":"doc","content":[
        {"type":"paragraph","content":[
            {"type":"text","text":"  桜😀\r\n朝\r夕  "},
            {"type":"hardBreak"},
            {"type":"text","text":"終"}
        ]},
        {"type":"paragraph","content":[{"type":"text","text":"後段"}]}
    ]})
    .to_string();
    let expected = "  桜😀\n朝\n夕  \n終\n後段";
    native_patch_node(
        &db,
        &fixture,
        fixture.scene("s2"),
        json!({"content":storage}),
    );
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let after = source(&tx, &fixture);
        assert_persisted_source(&tx, &fixture, &after, expected);
        assert_eq!(after.saved_content_json, storage);
        assert_eq!(after.query_source.canonical_utf16_length, 16);
        assert_eq!(
            after.query_source.source_version,
            before.query_source.source_version + 1
        );
        assert_ne!(
            after.query_source.revision_token,
            before.query_source.revision_token
        );
        assert_ne!(
            after.query_source.storage_digest,
            before.query_source.storage_digest
        );
        assert_ne!(
            after.query_source.canonical_text_digest,
            before.query_source.canonical_text_digest
        );
        assert_ne!(
            after.query_source.storage_digest,
            after.query_source.canonical_text_digest
        );
        assert_context_source(&context(&tx, &fixture), &after);
        Ok(())
    })
    .expect("Native body storage and canonical evidence stay independently bound");
}

#[test]
fn native_long_query_source_is_returned_whole_with_its_saved_edge_whitespace() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let expected = format!("  {}😀  ", "界".repeat(700));
    let storage = json!({"type":"doc","content":[
        {"type":"paragraph","content":[{"type":"text","text":expected}]}
    ]})
    .to_string();
    native_patch_node(
        &db,
        &fixture,
        fixture.scene("s2"),
        json!({"content":storage}),
    );
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let source = source(&tx, &fixture);
        assert_persisted_source(&tx, &fixture, &source, &expected);
        assert_eq!(source.saved_content_json, storage);
        assert_eq!(source.query_source.canonical_utf16_length, 706);
        assert_context_source(&context(&tx, &fixture), &source);
        Ok(())
    })
    .expect("source readers preserve the full saved input for the existing Raw adapter");
}

#[test]
fn native_storage_format_change_changes_storage_digest_without_changing_canonical_text() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let before = db
        .with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            Ok(source(&tx, &fixture))
        })
        .expect("before formatting-only Native save");
    let value: Value = serde_json::from_str(&before.saved_content_json).expect("saved document");
    let pretty =
        serde_json::to_string_pretty(&value).expect("equivalent saved document formatting");
    assert_ne!(pretty, before.saved_content_json);
    native_patch_node(
        &db,
        &fixture,
        fixture.scene("s2"),
        json!({"content":pretty}),
    );
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let after = source(&tx, &fixture);
        assert_persisted_source(&tx, &fixture, &after, COLD_QUERY_TEXT);
        assert_eq!(after.saved_content_json, pretty);
        assert_eq!(after.canonical_source_text, before.canonical_source_text);
        assert_eq!(
            after.query_source.canonical_text_digest,
            before.query_source.canonical_text_digest
        );
        assert_eq!(
            after.query_source.canonical_utf16_length,
            before.query_source.canonical_utf16_length
        );
        assert_ne!(
            after.query_source.storage_digest,
            before.query_source.storage_digest
        );
        assert_ne!(
            after.query_source.revision_token,
            before.query_source.revision_token
        );
        assert_context_source(&context(&tx, &fixture), &after);
        Ok(())
    })
    .expect("storage identity is not conflated with canonical text identity");
}

#[test]
fn native_scope_only_changes_refresh_scope_authority_without_fabricating_body_digest_changes() {
    for patch in [json!({"storyTimeOrder":"a1"}), json!({"sortOrder":"Zz"})] {
        let fixture = Fixture::new();
        let db = Database::new(&fixture.path).expect("Native private fixture");
        let before = db
            .with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                Ok(context(&tx, &fixture))
            })
            .expect("before Native Scope mutation");
        native_patch_node(&db, &fixture, fixture.scene("s2"), patch.clone());
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let source = source(&tx, &fixture);
            let after = context(&tx, &fixture);
            assert_persisted_source(&tx, &fixture, &source, COLD_QUERY_TEXT);
            assert_context_source(&after, &source);
            assert_eq!(after.saved_content_json, before.saved_content_json);
            assert_eq!(
                after.query_source.storage_digest,
                before.query_source.storage_digest
            );
            assert_eq!(
                after.query_source.canonical_text_digest,
                before.query_source.canonical_text_digest
            );
            assert_eq!(
                after.query_source.canonical_utf16_length,
                before.query_source.canonical_utf16_length
            );
            assert_ne!(
                after.scope_authority_revision_token,
                before.scope_authority_revision_token
            );
            assert_ne!(
                after.query_source.revision_token,
                before.query_source.revision_token
            );
            assert_eq!(
                after.query_source.source_version,
                before.query_source.source_version + 1
            );
            if patch.get("sortOrder").is_some() {
                assert_eq!(after.query_reading_rank, 0);
                assert_ne!(after.query_reading_rank, before.query_reading_rank);
            }
            Ok(())
        })
        .expect("Native node metadata can change its token without changing saved body content");
    }
}

#[test]
fn native_mode_only_change_preserves_every_saved_body_coordinate() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    let before = db
        .with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            Ok(source(&tx, &fixture))
        })
        .expect("before Native mode mutation");
    native_set_mode(&db, &fixture, "reading");
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let after = source(&tx, &fixture);
        let context = context(&tx, &fixture);
        assert_persisted_source(&tx, &fixture, &after, COLD_QUERY_TEXT);
        assert_eq!(after.phase_resolution_mode, "reading");
        assert_eq!(after.query_source, before.query_source);
        assert_eq!(after.saved_content_json, before.saved_content_json);
        assert_eq!(after.canonical_source_text, before.canonical_source_text);
        assert_context_source(&context, &after);
        assert_eq!(context.effective_axis, "reading");
        assert_eq!(context.axis_fallback_reason, None);
        Ok(())
    })
    .expect("project mode does not invent a new Scene body identity");
}

#[test]
fn native_archived_query_keeps_raw_source_available_and_denies_ir_context() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    native_patch_node(
        &db,
        &fixture,
        fixture.scene("s2"),
        json!({
            "archivedAt":"2026-09-09T10:00:00.000Z"
        }),
    );
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let source = source(&tx, &fixture);
        assert!(source.archived);
        assert_persisted_source(&tx, &fixture, &source, COLD_QUERY_TEXT);
        assert!(matches!(
            read_retrieval_query_context(&tx, fixture.project(), fixture.scene("s2"))?,
            RetrievalQueryContextRead::Unavailable {
                reason: RevisionEligibilityReason::QueryContextUnavailable
            }
        ));
        Ok(())
    })
    .expect("archived persisted source remains usable by its existing Raw path");
}

#[test]
fn native_effective_story_modes_keep_raw_source_available_and_deny_ir_context() {
    for mode in ["story", "auto"] {
        let fixture = Fixture::new();
        let db = Database::new(&fixture.path).expect("Native private fixture");
        native_patch_node(
            &db,
            &fixture,
            fixture.scene("s1"),
            json!({"storyTimeOrder":"a0"}),
        );
        native_patch_node(
            &db,
            &fixture,
            fixture.scene("s2"),
            json!({"storyTimeOrder":"a1"}),
        );
        native_set_mode(&db, &fixture, mode);
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let source = source(&tx, &fixture);
            assert_eq!(source.phase_resolution_mode, mode);
            assert!(!source.archived);
            assert_persisted_source(&tx, &fixture, &source, COLD_QUERY_TEXT);
            assert_eq!(
                tx.query_row(
                    "SELECT COUNT(*) FROM tree_nodes WHERE project_id=?1 AND node_type='scene'
                  AND archived_at IS NULL AND story_time_order IS NOT NULL",
                    [fixture.project()],
                    |row| row.get::<_, i64>(0)
                )?,
                2,
                "Native complete explicit story coverage"
            );
            assert!(matches!(
                read_retrieval_query_context(&tx, fixture.project(), fixture.scene("s2"))?,
                RetrievalQueryContextRead::Unavailable {
                    reason: RevisionEligibilityReason::UnsupportedQueryAxis
                }
            ));
            Ok(())
        })
        .expect("effective story only prevents admission to the initial IR reading profile");
    }
}

#[test]
fn story_mode_with_no_resolved_story_time_retains_its_supported_reading_fallback() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native private fixture");
    native_set_mode(&db, &fixture, "story");
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let source = source(&tx, &fixture);
        let context = context(&tx, &fixture);
        assert_eq!(source.phase_resolution_mode, "story");
        assert_context_source(&context, &source);
        assert_eq!(context.effective_axis, "reading");
        assert_eq!(
            context.axis_fallback_reason.as_deref(),
            Some("story-current-unresolved")
        );
        Ok(())
    })
    .expect("configured story mode is distinguished from the effective query axis");
}

#[test]
fn private_unknown_mode_copy_keeps_raw_source_available_and_denies_ir_context() {
    let fixture = Fixture::new();
    let conn = Connection::open(&fixture.path).expect("private invalid-mode copy");
    // The production schema and Native writer reject this value; this is only
    // a malformed stored-mode negative, never a Native lineage positive.
    conn.execute_batch("PRAGMA ignore_check_constraints=ON;")
        .expect("disable checks only on the private corruption copy");
    assert_eq!(
        conn.execute(
            "UPDATE projects SET phase_resolution_mode='unknown-mode' WHERE id=?1",
            [fixture.project()]
        )
        .expect("private unknown project mode"),
        1
    );
    conn.execute_batch("PRAGMA ignore_check_constraints=OFF;")
        .expect("restore private connection checks");
    let tx = conn
        .unchecked_transaction()
        .expect("malformed mode snapshot");
    let source = source(&tx, &fixture);
    assert_eq!(source.phase_resolution_mode, "unknown-mode");
    assert_persisted_source(&tx, &fixture, &source, COLD_QUERY_TEXT);
    assert!(matches!(
        read_retrieval_query_context(&tx, fixture.project(), fixture.scene("s2"))
            .expect("unknown mode is a typed context denial"),
        RetrievalQueryContextRead::Unavailable {
            reason: RevisionEligibilityReason::QueryContextUnavailable
        }
    ));
}

#[test]
fn missing_foreign_empty_and_non_scene_queries_are_typed_unavailable() {
    let fixture = Fixture::new();
    let conn = fixture.read_only();
    let tx = conn
        .unchecked_transaction()
        .expect("query identity snapshot");
    let folder: String = tx
        .query_row(
            "SELECT parent_id FROM tree_nodes WHERE id=?1",
            [fixture.scene("s1")],
            |row| row.get(0),
        )
        .expect("existing folder must not count as a Scene");
    for (project, scene) in [
        (fixture.project(), "missing-scene"),
        ("foreign-project", fixture.scene("s2")),
        ("", fixture.scene("s2")),
        ("  ", fixture.scene("s2")),
        (fixture.project(), ""),
        (fixture.project(), " \t\n"),
        (fixture.project(), folder.as_str()),
    ] {
        assert!(
            matches!(
                read_retrieval_scene_source(&tx, project, scene)
                    .expect("typed missing Scene source"),
                RetrievalSceneSourceRead::Unavailable {
                    reason: RevisionEligibilityReason::QueryContextUnavailable
                }
            ),
            "project={project:?} scene={scene:?}"
        );
        assert!(
            matches!(
                read_retrieval_query_context(&tx, project, scene)
                    .expect("typed missing query context"),
                RetrievalQueryContextRead::Unavailable {
                    reason: RevisionEligibilityReason::QueryContextUnavailable
                }
            ),
            "project={project:?} scene={scene:?}"
        );
    }
}

#[test]
fn both_public_readers_require_a_caller_owned_read_transaction() {
    let fixture = Fixture::new();
    let conn = fixture.read_only();
    assert!(conn.is_autocommit());
    let source_error = read_retrieval_scene_source(&conn, fixture.project(), fixture.scene("s2"))
        .expect_err("source must not silently open an independent snapshot");
    let context_error = read_retrieval_query_context(&conn, fixture.project(), fixture.scene("s2"))
        .expect_err("context must not silently open an independent snapshot");
    assert!(source_error.to_string().contains("read transaction"));
    assert!(context_error.to_string().contains("read transaction"));
    assert!(conn.is_autocommit());
}

#[test]
fn missing_sql_tables_remain_errors_instead_of_typed_absence() {
    for table in ["tree_nodes", "projects"] {
        let fixture = Fixture::new();
        let conn = Connection::open(&fixture.path).expect("private missing-schema copy");
        conn.execute_batch(&format!("DROP TABLE {table};"))
            .expect("remove a table only on the private SQL-error copy");
        let tx = conn.unchecked_transaction().expect("SQL-error snapshot");
        let source_error = read_retrieval_scene_source(&tx, fixture.project(), fixture.scene("s2"))
            .expect_err("SQL failures cannot be downgraded to a missing source");
        let context_error =
            read_retrieval_query_context(&tx, fixture.project(), fixture.scene("s2"))
                .expect_err("SQL failures cannot be downgraded to an unavailable IR profile");
        assert!(
            source_error.downcast_ref::<rusqlite::Error>().is_some(),
            "{source_error:#}"
        );
        assert!(
            context_error.downcast_ref::<rusqlite::Error>().is_some(),
            "{context_error:#}"
        );
    }
}

#[test]
fn wal_reader_keeps_body_mode_and_scope_on_one_snapshot_across_native_commits() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("Native writer connection");
    let reader = fixture.read_only();
    assert_eq!(
        reader
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .expect("WAL snapshot precondition"),
        "wal"
    );
    let tx = reader
        .unchecked_transaction()
        .expect("original reader transaction");
    let before = source(&tx, &fixture); // This first read pins the SQLite snapshot.
    let before_context = context(&tx, &fixture);
    let updated_storage = json!({"type":"doc","content":[
        {"type":"paragraph","content":[{"type":"text","text":"A later saved query 😀"}]}
    ]})
    .to_string();
    native_patch_node(
        &db,
        &fixture,
        fixture.scene("s2"),
        json!({"content":updated_storage}),
    );
    native_patch_node(
        &db,
        &fixture,
        fixture.scene("s2"),
        json!({"sortOrder":"Zz"}),
    );
    native_set_mode(&db, &fixture, "reading");

    let pinned = source(&tx, &fixture);
    let pinned_context = context(&tx, &fixture);
    assert_persisted_source(&tx, &fixture, &pinned, COLD_QUERY_TEXT);
    assert_eq!(pinned.query_source, before.query_source);
    assert_eq!(pinned.saved_content_json, before.saved_content_json);
    assert_eq!(pinned.phase_resolution_mode, "auto");
    assert_context_source(&pinned_context, &pinned);
    assert_eq!(
        pinned_context.query_reading_rank,
        before_context.query_reading_rank
    );
    assert_eq!(
        pinned_context.scope_authority_revision_token,
        before_context.scope_authority_revision_token
    );
    assert_eq!(
        pinned_context.axis_fallback_reason,
        before_context.axis_fallback_reason
    );
    tx.commit().expect("release original read snapshot");

    let next = reader
        .unchecked_transaction()
        .expect("fresh reader transaction");
    let latest = source(&next, &fixture);
    let latest_context = context(&next, &fixture);
    assert_persisted_source(&next, &fixture, &latest, "A later saved query 😀");
    assert_eq!(latest.saved_content_json, updated_storage);
    assert_eq!(latest.phase_resolution_mode, "reading");
    assert_ne!(
        latest.query_source.revision_token,
        before.query_source.revision_token
    );
    assert_ne!(
        latest.query_source.canonical_text_digest,
        before.query_source.canonical_text_digest
    );
    assert_context_source(&latest_context, &latest);
    assert_eq!(latest_context.query_reading_rank, 0);
    assert_ne!(
        latest_context.scope_authority_revision_token,
        before_context.scope_authority_revision_token
    );
    assert_eq!(latest_context.axis_fallback_reason, None);
    assert_eq!(
        next.query_row("SELECT total_changes()", [], |row| row.get::<_, i64>(0))
            .expect("read-only connection stayed immutable across snapshots"),
        0
    );
}
