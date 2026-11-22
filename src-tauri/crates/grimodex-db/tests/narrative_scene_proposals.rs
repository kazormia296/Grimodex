//! SRA/1 R1-R3: the Scene -> Proposals read, against exact cold storage and the
//! Native writers. Fixtures are the real cold databases the retrieval admission
//! tests use (reviewed child, two window, multi window); a private copy is made
//! for every test, and the read itself writes nothing.
use std::io::Read;
use std::path::PathBuf;

use flate2::read::GzDecoder;
use grimodex_db::domain_writes::{tree_node_patch, TreeNodePatchPayload};
use grimodex_db::narrative_extraction::change_feed::NarrativeChangeOrigin;
use grimodex_db::narrative_extraction::{
    effective_scene_proposals_limit, narrative_extraction_append_human_decision,
    narrative_extraction_apply_commit,
    narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization_auto,
    narrative_extraction_list_scene_proposals, narrative_extraction_prepare_commit,
    read_narrative_scene_scope, read_revision_retrieval_eligibility, update_narrative_scene_scope,
    AppendDecisionPayload, ApplyCommitPayload, CommitApplicationRef, CommitOperation,
    CreateHumanDerivedRevisionRequest, ListSceneProposalsPayload, NarrativeAdapterIdentity,
    NarrativeSceneScopeUpdatePayload, PrepareCommitPayload, RevisionEligibilityRead,
    SceneProposalChronicleState, SceneProposalDuplicateSuspicion, SceneProposalItem,
    SceneProposalPage, SceneProposalReviewState, SceneProposalSourceState,
    SCENE_PROPOSALS_PAGE_DEFAULT, SCENE_PROPOSALS_PAGE_MAX,
};
use grimodex_db::{
    load_narrative_runtime_policy_from_db, set_narrative_runtime_policy, Database,
    SetNarrativeRuntimePolicyInput,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

struct Fixture {
    path: PathBuf,
    manifest: Value,
}

impl Fixture {
    fn reviewed_child() -> Self {
        let manifest: Value =
            serde_json::from_str(include_str!("support/nir1-reviewed-child-cold.json"))
                .expect("reviewed child manifest");
        Self::open(
            manifest,
            include_bytes!("support/nir1-reviewed-child-cold.db.gz"),
        )
    }

    /// run 4a2327c6: an unreviewed secret interpretation whose evidence is
    /// `en-distractor-gift`, and an approved child whose evidence is
    /// `en-distractor-rumor-fact`; both READ both scenes.
    fn two_window() -> Self {
        let mut manifest: Value =
            serde_json::from_str(include_str!("support/nir1-two-window-cold.json"))
                .expect("two window manifest");
        manifest["runId"] = json!("4a2327c6-8d14-4234-aae9-72ce858186a0");
        Self::open(
            manifest,
            include_bytes!("support/nir1-two-window-cold.db.gz"),
        )
    }

    /// "Signal fire on the quay" cites mw-scene-1 and mw-scene-3 and reads
    /// mw-scene-2; "Writ delivered to the quay" cites mw-scene-2 only.
    fn multi_window() -> Self {
        let manifest: Value =
            serde_json::from_str(include_str!("support/nir1-multi-window-cold.json"))
                .expect("multi window manifest");
        Self::open(
            manifest,
            include_bytes!("support/nir1-multi-window-cold.db.gz"),
        )
    }

    fn open(manifest: Value, compressed: &[u8]) -> Self {
        assert_eq!(
            hex::encode(Sha256::digest(compressed)),
            manifest["compressedDatabaseSha256"]
        );
        let mut bytes = Vec::new();
        GzDecoder::new(compressed)
            .read_to_end(&mut bytes)
            .expect("exact cold fixture bytes");
        assert_eq!(
            hex::encode(Sha256::digest(&bytes)),
            manifest["uncompressedDatabaseSha256"]
        );
        let path =
            std::env::temp_dir().join(format!("grimodex-scene-proposals-{}.db", Uuid::new_v4()));
        std::fs::write(&path, bytes).expect("private cold fixture copy");
        Self { path, manifest }
    }

    fn db(&self) -> Database {
        let db = Database::new(&self.path).expect("Native private fixture");
        // The older cold copies predate the Scene Scope tables; the product
        // always migrates on open.
        db.migrate().expect("migrate the private copy");
        db
    }
    fn project(&self) -> &str {
        self.manifest["projectId"].as_str().expect("project")
    }
    fn s1(&self) -> &str {
        self.manifest["s1"].as_str().expect("s1")
    }
    fn s2(&self) -> &str {
        self.manifest["s2"].as_str().expect("s2")
    }
    fn run_id(&self) -> &str {
        self.manifest["runId"].as_str().expect("run")
    }
    fn child_revisions(&self) -> Vec<String> {
        self.manifest["revisionIds"]
            .as_array()
            .expect("revision ids")
            .iter()
            .map(|id| id.as_str().expect("id").to_owned())
            .collect()
    }
    fn root_revisions(&self) -> Vec<String> {
        self.manifest["rootRevisionIds"]
            .as_array()
            .expect("root ids")
            .iter()
            .map(|id| id.as_str().expect("id").to_owned())
            .collect()
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

fn list(
    db: &Database,
    project: &str,
    scene: &str,
    cursor: Option<&str>,
    limit: Option<u32>,
) -> SceneProposalPage {
    narrative_extraction_list_scene_proposals(
        db,
        ListSceneProposalsPayload {
            project_id: project.to_owned(),
            scene_id: scene.to_owned(),
            cursor: cursor.map(str::to_owned),
            limit,
        },
    )
    .expect("Scene Proposals read")
}

fn titles(page: &SceneProposalPage) -> Vec<String> {
    let mut titles: Vec<String> = page
        .items
        .iter()
        .map(|item| item.title.clone().expect("proposal title"))
        .collect();
    titles.sort();
    titles
}

fn item_titled<'a>(page: &'a SceneProposalPage, title: &str) -> &'a SceneProposalItem {
    page.items
        .iter()
        .find(|item| item.title.as_deref() == Some(title))
        .unwrap_or_else(|| panic!("no item titled {title}: {:?}", titles(page)))
}

/// (proposal id, current revision id) of the proposal whose current revision has `title`.
fn proposal_titled(db: &Database, title: &str) -> (String, String) {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT p.id, p.current_revision_id FROM narrative_proposals p
               JOIN narrative_proposal_revisions r ON r.id = p.current_revision_id
              WHERE json_extract(r.payload_json, '$.title') = ?1",
            [title],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?)
    })
    .expect("proposal by title")
}

fn row_counts(db: &Database) -> Vec<i64> {
    db.with_conn(|conn| {
        [
            "narrative_proposals",
            "narrative_proposal_revisions",
            "narrative_proposal_decisions",
            "narrative_proposal_applications",
            "narrative_dependency_edges",
            "narrative_consumer_freshness",
        ]
        .iter()
        .map(|table| {
            Ok(
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?,
            )
        })
        .collect()
    })
    .expect("row counts")
}

fn enable_manual_apply(db: &Database) {
    let before = load_narrative_runtime_policy_from_db(db).expect("runtime policy");
    set_narrative_runtime_policy(
        db,
        SetNarrativeRuntimePolicyInput {
            expected_version: before.version,
            runtime_mode: "manual-apply".into(),
            maintenance_enabled: before.maintenance_enabled,
            generic_import_enabled: before.generic_import_enabled,
            background_ai_enabled: before.background_ai_enabled,
        },
    )
    .expect("enable manual-apply");
}

/// The Native operation shape for importing a revision as a Chronicle event
/// (the same assembly the retrieval admission tests use; the secret flag is
/// true until the SRA/1 D4 change).
fn chronicle_apply_operation(conn: &Connection, run_id: &str, revision: &str) -> Value {
    let (payload, envelope): (String, String) = conn
        .query_row(
            "SELECT payload_json, reconciliation_envelope_json
               FROM narrative_proposal_revisions WHERE id = ?1",
            [revision],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("approved revision payload and Envelope");
    let payload: Value = serde_json::from_str(&payload).expect("revision payload");
    let envelope: Value = serde_json::from_str(&envelope).expect("revision Envelope");
    let snapshot: String = conn
        .query_row(
            "SELECT payload_json FROM narrative_extraction_artifacts
              WHERE run_id = ?1 AND artifact_kind = 'source.snapshot@1'",
            [run_id],
            |row| row.get(0),
        )
        .expect("sealed Snapshot artifact");
    let snapshot: Value = serde_json::from_str(&snapshot).expect("Snapshot JSON");
    let documents = snapshot["snapshot"]["documents"]
        .as_array()
        .expect("Snapshot documents");
    let evidence_set = envelope
        .pointer("/effectiveMaterialBasis/evidenceSet")
        .or_else(|| envelope.get("evidenceSet"))
        .and_then(Value::as_array)
        .expect("Envelope evidenceSet");
    let anchors = payload["evidenceAnchorIds"].as_array().expect("anchors");
    let mut links: Vec<Value> = Vec::new();
    for document_ref in payload["evidenceDocumentRefs"]
        .as_array()
        .expect("evidence document refs")
    {
        let document = documents
            .iter()
            .find(|document| document["ref"] == *document_ref)
            .expect("Snapshot document of the evidence ref");
        let anchor_ids: Vec<Value> = anchors
            .iter()
            .filter(|anchor| {
                evidence_set.iter().any(|evidence| {
                    evidence["evidenceRef"] == **anchor && evidence["documentRef"] == *document_ref
                })
            })
            .cloned()
            .collect();
        links.push(json!({
            "sceneId": document["origin"]["nodeId"],
            "expectedSceneVersion": document["origin"]["sourceVersion"],
            "evidenceAnchorIds": anchor_ids,
        }));
    }
    let reveal_ref = &payload["disclosure"]["revealDocumentRef"];
    let reveal_scene = documents
        .iter()
        .find(|document| document["ref"] == *reveal_ref)
        .expect("reveal Snapshot document")["origin"]["nodeId"]
        .clone();
    json!({
        "eventId": payload["eventId"],
        "title": payload["title"],
        "note": payload["note"],
        "kind": "generic",
        "precision": "unknown",
        "placement": { "mode": "append-tail", "afterOrdinal": null },
        "secret": true,
        "revealSceneId": reveal_scene,
        "evidenceSceneLinks": links,
        "detail": null,
        "primaryCodexId": null,
        "locationCodexId": null,
        "participants": [],
        "startTime": null,
        "endTime": null,
        "startGranularity": "none",
        "endGranularity": "none",
    })
}

fn prepare_and_apply_all(db: &Database, fixture: &Fixture, request_id: &str) {
    let revisions = fixture.child_revisions();
    let prepare = db
        .with_conn(|conn| {
            let mut set_id = String::new();
            let mut operations = Vec::new();
            let mut applications = Vec::new();
            for revision in &revisions {
                let (proposal, set): (String, String) = conn.query_row(
                    "SELECT p.id, p.proposal_set_id FROM narrative_proposals p
                       JOIN narrative_proposal_revisions r ON r.proposal_id = p.id
                      WHERE r.id = ?1",
                    [revision],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                set_id = set;
                operations.push(CommitOperation {
                    kind: "chronicle.event.create".to_owned(),
                    payload: chronicle_apply_operation(conn, fixture.run_id(), revision),
                    proposal_id: proposal.clone(),
                    revision_id: revision.clone(),
                });
                applications.push(CommitApplicationRef {
                    proposal_id: proposal,
                    revision_id: revision.clone(),
                });
            }
            Ok(PrepareCommitPayload {
                project_id: fixture.project().to_owned(),
                run_id: fixture.run_id().to_owned(),
                proposal_set_id: set_id,
                request_id: request_id.to_owned(),
                plan_digest: "ignored".to_owned(),
                session_id: format!("session-{request_id}"),
                surface: Some("narrative-extraction".to_owned()),
                operations,
                applications,
                expected_tail_ordinal: None,
                entity_bindings: vec![],
                expected_calendar_version: None,
            })
        })
        .expect("prepare payload");
    let prepared = narrative_extraction_prepare_commit(db, prepare.clone()).expect("prepare");
    narrative_extraction_apply_commit(
        db,
        ApplyCommitPayload {
            project_id: prepare.project_id.clone(),
            prepared_commit_id: prepared["preparedCommitId"]
                .as_str()
                .expect("preparedCommitId")
                .to_owned(),
            request_id: prepare.request_id.clone(),
            session_id: prepare.session_id.clone(),
            expected_version: prepared["version"].as_i64(),
        },
    )
    .expect("apply");
}

fn create_native_child(
    db: &Database,
    fixture: &Fixture,
    parent: &str,
    edit: impl FnOnce(&mut Value),
) -> String {
    let (proposal_id, envelope_digest, payload): (String, String, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT proposal_id, reconciliation_envelope_digest, payload_json
                   FROM narrative_proposal_revisions WHERE id = ?1",
                [parent],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .expect("parent request inputs");
    let mut payload: Value = serde_json::from_str(&payload).expect("parent payload");
    edit(&mut payload);
    let saved =
        narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization_auto(
            db,
            fixture.project(),
            CreateHumanDerivedRevisionRequest {
                proposal_id,
                expected_current_revision_id: parent.to_owned(),
                parent_revision_id: parent.to_owned(),
                expected_parent_envelope_digest: envelope_digest,
                proposal_payload: payload,
                adapter: NarrativeAdapterIdentity {
                    id: "chronicle.scene-event".to_owned(),
                    version: "1".to_owned(),
                },
                surface_id: "chronicle-review".to_owned(),
            },
        )
        .expect("production Native child creation");
    saved["revisionId"].as_str().expect("child id").to_owned()
}

fn patch_scene_content(db: &Database, fixture: &Fixture, scene: &str) {
    let id = Uuid::new_v4().to_string();
    tree_node_patch(
        db,
        TreeNodePatchPayload {
            project_id: fixture.project().to_owned(),
            request_id: format!("scene-proposals-{id}"),
            session_id: "scene-proposals-session".to_owned(),
            event_uid: id,
            node_id: scene.to_owned(),
            patch: json!({"content":"The Native source has changed."})
                .as_object()
                .expect("patch")
                .clone(),
            base_version: None,
            bump_version: true,
            updated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
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
    .expect("production Native Scene patch");
}

// ---------------------------------------------------------------------------

#[test]
fn a_scene_returns_the_current_revisions_of_the_proposals_that_cite_it() {
    let fixture = Fixture::reviewed_child();
    let db = fixture.db();
    let page = list(&db, fixture.project(), fixture.s1(), None, None);
    assert_eq!(page.next_cursor, None);
    assert_eq!(page.limit as usize, SCENE_PROPOSALS_PAGE_DEFAULT);

    let mut revisions: Vec<String> = page.items.iter().map(|i| i.revision_id.clone()).collect();
    revisions.sort();
    let mut expected = fixture.child_revisions();
    expected.sort();
    assert_eq!(
        revisions, expected,
        "the two current children, nothing else"
    );
    assert_eq!(titles(&page), vec!["鐘が鳴った", "門が開いた"]);

    // Older revisions of the same proposals also declared Edges on the Scene;
    // the read must not return them.
    for root in fixture.root_revisions() {
        let edges: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM narrative_dependency_edges
                      WHERE consumer_kind='proposal-revision' AND consumer_key=?1
                        AND source_object_identity=?2",
                    rusqlite::params![root, format!("project:scene:{}", fixture.s1())],
                    |row| row.get(0),
                )?)
            })
            .expect("root edge count");
        assert_eq!(edges, 1, "the historical root did read the Scene");
        assert!(
            page.items.iter().all(|item| item.revision_id != root),
            "a historical revision is never returned"
        );
    }

    for item in &page.items {
        assert!(!item.evidence.is_empty(), "the Scene's own evidence quotes");
        assert!(item.evidence.iter().all(|e| !e.quote.is_empty()));
        assert!(item.other_scene_ids.is_empty());
        assert_eq!(item.review_state, SceneProposalReviewState::Approved);
        assert_eq!(item.source_state, SceneProposalSourceState::Fresh);
        assert_eq!(
            item.chronicle_state,
            SceneProposalChronicleState::NotApplied
        );
        assert!(
            item.related_use.likely && item.related_use.reasons.is_empty(),
            "an approved non-secret current child: {:?}",
            item.related_use
        );
    }

    // The other scene of the fixture is not cited by any proposal.
    assert!(list(&db, fixture.project(), fixture.s2(), None, None)
        .items
        .is_empty());
}

#[test]
fn the_read_writes_nothing() {
    let fixture = Fixture::reviewed_child();
    let db = fixture.db();
    let before = row_counts(&db);
    for scene in [fixture.s1(), fixture.s2()] {
        list(&db, fixture.project(), scene, None, Some(1));
    }
    assert_eq!(row_counts(&db), before);
}

#[test]
fn a_scene_that_was_only_read_is_not_evidence() {
    let fixture = Fixture::two_window();
    let db = fixture.db();
    // "The jeweller" cites the gift scene; "The signed deed" cites the rumor-fact
    // scene; both READ both scenes.
    let gift = list(&db, fixture.project(), "en-distractor-gift", None, None);
    assert_eq!(titles(&gift), vec!["The jeweller"]);
    let rumor = list(
        &db,
        fixture.project(),
        "en-distractor-rumor-fact",
        None,
        None,
    );
    assert_eq!(titles(&rumor), vec!["The signed deed"]);

    // The Edge index does hold the read-only Edges, so the narrowing is real.
    let read_only: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_dependency_edges
                  WHERE consumer_kind='proposal-revision'
                    AND source_object_identity='project:scene:en-distractor-gift'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("edges on the gift scene");
    assert!(read_only > 1, "more Edges than evidence: {read_only}");
}

#[test]
fn a_proposal_that_spans_scenes_is_returned_for_each_scene_it_cites() {
    let fixture = Fixture::multi_window();
    let db = fixture.db();
    let one = list(&db, fixture.project(), "mw-scene-1", None, None);
    let three = list(&db, fixture.project(), "mw-scene-3", None, None);
    let two = list(&db, fixture.project(), "mw-scene-2", None, None);

    let signal_from_one = item_titled(&one, "Signal fire on the quay");
    let signal_from_three = item_titled(&three, "Signal fire on the quay");
    assert_eq!(signal_from_one.proposal_id, signal_from_three.proposal_id);
    assert_eq!(signal_from_one.revision_id, signal_from_three.revision_id);
    assert_eq!(signal_from_one.other_scene_ids, vec!["mw-scene-3"]);
    assert_eq!(signal_from_three.other_scene_ids, vec!["mw-scene-1"]);
    assert!(!signal_from_one.evidence.is_empty() && !signal_from_three.evidence.is_empty());
    assert_ne!(
        signal_from_one.evidence[0].quote, signal_from_three.evidence[0].quote,
        "each scene shows its own quote"
    );

    // It read mw-scene-2 but does not cite it.
    assert_eq!(titles(&two), vec!["Writ delivered to the quay"]);

    // The static reason of a proposal whose evidence spans two scenes (SRA/1 1.4).
    assert!(!signal_from_one.related_use.likely);
    assert!(
        signal_from_one
            .related_use
            .reasons
            .contains(&"evidence-mismatch"),
        "{:?}",
        signal_from_one.related_use
    );
}

#[test]
fn another_projects_unknown_or_non_scene_ids_give_an_empty_page() {
    let fixture = Fixture::reviewed_child();
    let db = fixture.db();
    assert_eq!(
        list(&db, fixture.project(), fixture.s1(), None, None)
            .items
            .len(),
        2
    );
    // The Scene id is real but the project is not its project.
    assert!(list(&db, "some-other-project", fixture.s1(), None, None)
        .items
        .is_empty());
    // Unknown scene id.
    assert!(list(&db, fixture.project(), "no-such-scene", None, None)
        .items
        .is_empty());
    // A node of the project that is not a scene.
    let folder: Option<String> = db
        .with_conn(|conn| {
            use rusqlite::OptionalExtension;
            Ok(conn
                .query_row(
                    "SELECT id FROM tree_nodes WHERE project_id=?1 AND node_type<>'scene' LIMIT 1",
                    [fixture.project()],
                    |row| row.get(0),
                )
                .optional()?)
        })
        .expect("a non-scene node");
    if let Some(folder) = folder {
        assert!(list(&db, fixture.project(), &folder, None, None)
            .items
            .is_empty());
    }

    // A second project holding a scene of its own: the first project's scene id
    // does not resolve there, and the second project's scene does not resolve in
    // the first.
    db.with_conn(|conn| {
        conn.execute("INSERT INTO projects (id) VALUES ('second-project')", [])?;
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type) VALUES ('second-scene', 'second-project', 'scene')",
            [],
        )?;
        Ok(())
    })
    .expect("a second project with its own scene");
    assert!(list(&db, "second-project", fixture.s1(), None, None)
        .items
        .is_empty());
    assert!(list(&db, fixture.project(), "second-scene", None, None)
        .items
        .is_empty());
    assert!(list(&db, "second-project", "second-scene", None, None)
        .items
        .is_empty());
}

#[test]
fn pages_are_keyed_on_the_proposal_and_mark_the_next_page_only_when_one_exists() {
    let fixture = Fixture::multi_window();
    let db = fixture.db();
    // mw-long-scene is cited by exactly two proposals.
    let all = list(&db, fixture.project(), "mw-long-scene", None, Some(10));
    assert_eq!(all.items.len(), 2);
    assert_eq!(all.next_cursor, None);
    assert_eq!(all.limit, 10);

    // N items exist and N are asked for: no next page.
    let exact = list(&db, fixture.project(), "mw-long-scene", None, Some(2));
    assert_eq!(exact.items.len(), 2);
    assert_eq!(exact.next_cursor, None, "N of N is the last page");

    // N+1 items exist and N are asked for: a next page.
    let first = list(&db, fixture.project(), "mw-long-scene", None, Some(1));
    assert_eq!(first.items.len(), 1);
    let cursor = first.next_cursor.clone().expect("a mark for the next page");
    assert_eq!(cursor, first.items[0].proposal_id);

    let second = list(
        &db,
        fixture.project(),
        "mw-long-scene",
        Some(&cursor),
        Some(1),
    );
    assert_eq!(second.items.len(), 1);
    assert_eq!(second.next_cursor, None);
    assert!(second.items[0].proposal_id > first.items[0].proposal_id);

    let mut walked = vec![
        first.items[0].revision_id.clone(),
        second.items[0].revision_id.clone(),
    ];
    walked.sort();
    let mut whole: Vec<String> = all.items.iter().map(|i| i.revision_id.clone()).collect();
    whole.sort();
    assert_eq!(walked, whole, "the pages tile the whole answer");

    // Past the end.
    let past = list(
        &db,
        fixture.project(),
        "mw-long-scene",
        Some(&second.items[0].proposal_id),
        Some(5),
    );
    assert!(past.items.is_empty() && past.next_cursor.is_none());
}

#[test]
fn a_requested_page_size_is_cut_to_the_native_cap() {
    let fixture = Fixture::reviewed_child();
    let db = fixture.db();
    assert_eq!(
        list(&db, fixture.project(), fixture.s1(), None, Some(u32::MAX)).limit as usize,
        SCENE_PROPOSALS_PAGE_MAX
    );
    assert_eq!(
        list(&db, fixture.project(), fixture.s1(), None, Some(1_000)).limit as usize,
        SCENE_PROPOSALS_PAGE_MAX
    );
    assert_eq!(
        list(&db, fixture.project(), fixture.s1(), None, Some(3)).limit,
        3
    );
    assert_eq!(effective_scene_proposals_limit(Some(51)).expect("cut"), 50);
    assert_eq!(SCENE_PROPOSALS_PAGE_MAX, 50);
}

#[test]
fn malformed_input_is_refused_and_reads_nothing() {
    let fixture = Fixture::reviewed_child();
    let db = fixture.db();
    let refused = |project: &str, scene: &str, cursor: Option<&str>, limit: Option<u32>| {
        let error = narrative_extraction_list_scene_proposals(
            &db,
            ListSceneProposalsPayload {
                project_id: project.to_owned(),
                scene_id: scene.to_owned(),
                cursor: cursor.map(str::to_owned),
                limit,
            },
        )
        .expect_err("malformed input is refused");
        assert!(
            format!("{error:#}").contains("NEX_SCENE_PROPOSALS_INPUT_INVALID"),
            "{error:#}"
        );
    };
    refused("", fixture.s1(), None, None);
    refused(fixture.project(), "", None, None);
    refused(" padded", fixture.s1(), None, None);
    refused(fixture.project(), "padded ", None, None);
    refused(fixture.project(), &"s".repeat(257), None, None);
    refused(fixture.project(), fixture.s1(), Some(""), None);
    refused(
        fixture.project(),
        fixture.s1(),
        Some(&"c".repeat(257)),
        None,
    );
    refused(fixture.project(), fixture.s1(), None, Some(0));

    // The wire shape rejects unknown fields.
    let error = serde_json::from_value::<ListSceneProposalsPayload>(
        json!({"projectId":"p","sceneId":"s","extra":1}),
    )
    .expect_err("unknown field");
    assert!(error.to_string().contains("unknown field"), "{error}");
    let ok: ListSceneProposalsPayload =
        serde_json::from_value(json!({"projectId":"p","sceneId":"s"})).expect("minimal payload");
    assert!(ok.cursor.is_none() && ok.limit.is_none());
}

#[test]
fn an_unreviewed_secret_revision_is_returned_with_its_reasons() {
    let fixture = Fixture::two_window();
    let db = fixture.db();
    let page = list(&db, fixture.project(), "en-distractor-gift", None, None);
    let jeweller = item_titled(&page, "The jeweller");
    // SRA/1 1.4: the first interpretation carries the Secret flag, so it is shown
    // with that reason (it would not be used for Related Scenes), not hidden.
    assert_eq!(jeweller.review_state, SceneProposalReviewState::Unreviewed);
    assert!(!jeweller.related_use.likely);
    assert!(
        jeweller.related_use.reasons.contains(&"secret"),
        "{:?}",
        jeweller.related_use
    );
    assert!(
        jeweller.related_use.reasons.contains(&"not-approved"),
        "{:?}",
        jeweller.related_use
    );
    assert_eq!(
        jeweller.chronicle_state,
        SceneProposalChronicleState::NotApplied
    );
    assert_eq!(
        jeweller.probable_duplicate,
        SceneProposalDuplicateSuspicion::None
    );
    assert!(!jeweller.evidence.is_empty());
}

#[test]
fn rejecting_a_proposal_shows_in_its_review_state_and_reasons() {
    let fixture = Fixture::reviewed_child();
    let db = fixture.db();
    let revision = fixture.child_revisions()[0].clone();
    let proposal: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT proposal_id FROM narrative_proposal_revisions WHERE id = ?1",
                [&revision],
                |row| row.get(0),
            )?)
        })
        .expect("proposal");
    narrative_extraction_append_human_decision(
        &db,
        AppendDecisionPayload {
            run_id: fixture.run_id().to_owned(),
            project_id: fixture.project().to_owned(),
            proposal_id: proposal.clone(),
            revision_id: revision.clone(),
            decision: "rejected".to_owned(),
            decision_json: Some(json!({"probableDuplicateChoice":"skip-as-same"})),
            created_by: Some("scene-proposals-test".to_owned()),
        },
    )
    .expect("reject the current revision");
    let page = list(&db, fixture.project(), fixture.s1(), None, None);
    let rejected = page
        .items
        .iter()
        .find(|item| item.proposal_id == proposal)
        .expect("the rejected proposal is still shown");
    assert_eq!(rejected.review_state, SceneProposalReviewState::Rejected);
    assert!(!rejected.related_use.likely);
    assert!(rejected.related_use.reasons.contains(&"not-approved"));
    let other = page
        .items
        .iter()
        .find(|item| item.proposal_id != proposal)
        .expect("the other proposal");
    assert_eq!(other.review_state, SceneProposalReviewState::Approved);
}

#[test]
fn the_chronicle_state_follows_the_import() {
    let fixture = Fixture::reviewed_child();
    let db = fixture.db();
    enable_manual_apply(&db);
    let before = list(&db, fixture.project(), fixture.s1(), None, None);
    assert!(before
        .items
        .iter()
        .all(|item| item.chronicle_state == SceneProposalChronicleState::NotApplied));

    prepare_and_apply_all(&db, &fixture, "scene-proposals-apply");
    let after = list(&db, fixture.project(), fixture.s1(), None, None);
    assert_eq!(after.items.len(), 2);
    for item in &after.items {
        assert_eq!(item.chronicle_state, SceneProposalChronicleState::Applied);
        assert_eq!(item.review_state, SceneProposalReviewState::Approved);
        // An import does not change what the revision's own record says about
        // Related Scenes (SRA/1 1.4: the approved non-secret child stays usable).
        assert!(item.related_use.likely, "{:?}", item.related_use);
    }
}

#[test]
fn a_changed_scene_makes_the_source_state_stale() {
    let fixture = Fixture::reviewed_child();
    let db = fixture.db();
    patch_scene_content(&db, &fixture, fixture.s1());
    let page = list(&db, fixture.project(), fixture.s1(), None, None);
    assert_eq!(page.items.len(), 2);
    for item in &page.items {
        assert_eq!(
            item.source_state,
            SceneProposalSourceState::Stale,
            "{item:?}"
        );
        assert!(!item.related_use.likely);
        assert!(
            item.related_use.reasons.contains(&"source-stale"),
            "{:?}",
            item.related_use
        );
    }
}

#[test]
fn an_edited_title_is_a_probable_duplicate_and_the_new_revision_replaces_the_old() {
    let fixture = Fixture::reviewed_child();
    let db = fixture.db();
    let (proposal, parent) = proposal_titled(&db, "門が開いた");
    let before = list(&db, fixture.project(), fixture.s1(), None, None);
    assert_eq!(
        item_titled(&before, "門が開いた").probable_duplicate,
        SceneProposalDuplicateSuspicion::None
    );

    let child = create_native_child(&db, &fixture, &parent, |payload| {
        payload["title"] = json!("門がゆっくり開いた");
    });
    let after = list(&db, fixture.project(), fixture.s1(), None, None);
    assert_eq!(after.items.len(), 2);
    let edited = item_titled(&after, "門がゆっくり開いた");
    assert_eq!(edited.proposal_id, proposal);
    assert_eq!(
        edited.revision_id, child,
        "the newest revision is the one shown"
    );
    assert_ne!(edited.revision_id, parent);
    assert!(after.items.iter().all(|item| item.revision_id != parent));
    assert_eq!(
        edited.probable_duplicate,
        SceneProposalDuplicateSuspicion::Probable
    );
    // The untouched proposal is unchanged.
    assert_eq!(
        item_titled(&after, "鐘が鳴った").probable_duplicate,
        SceneProposalDuplicateSuspicion::None
    );
}

#[test]
fn wire_shape_is_camel_case_with_kebab_states() {
    let fixture = Fixture::reviewed_child();
    let db = fixture.db();
    let page = list(&db, fixture.project(), fixture.s1(), None, Some(1));
    let wire = serde_json::to_value(&page).expect("wire");
    assert!(wire["nextCursor"].is_string());
    assert_eq!(wire["limit"], 1);
    let item = &wire["items"][0];
    for key in [
        "proposalId",
        "revisionId",
        "title",
        "evidence",
        "evidenceTruncated",
        "otherSceneIds",
        "reviewState",
        "sourceState",
        "chronicleState",
        "probableDuplicate",
        "relatedUse",
    ] {
        assert!(item.get(key).is_some(), "missing {key}: {item}");
    }
    assert_eq!(item["reviewState"], "approved");
    assert_eq!(item["sourceState"], "fresh");
    assert_eq!(item["chronicleState"], "not-applied");
    assert_eq!(item["probableDuplicate"], "none");
    assert_eq!(item["relatedUse"]["likely"], true);
    assert_eq!(item["evidence"][0]["sceneId"], fixture.s1());
    assert!(item["evidence"][0]["quote"].is_string());
    // Only the fields SRA/1 DR-SRA-3 names are returned (H4).
    for key in ["proposalSetId", "runId"] {
        assert!(item.get(key).is_none(), "{key} is not part of the answer");
    }
    assert!(item["evidence"][0].get("evidenceRef").is_none());
    // No scene body, only the sealed quotes and ids.
    assert!(item.get("content").is_none() && item.get("body").is_none());
}

/// Rewrite one Scene's Scope row with `edit` (the Native writer; the marker may
/// go to `unknown` but never back to `legacy-absent`).
fn update_scene_scope(
    db: &Database,
    fixture: &Fixture,
    scene: &str,
    edit: impl FnOnce(&mut Value),
) {
    let current = db
        .with_read_transaction(|conn| read_narrative_scene_scope(conn, fixture.project(), scene))
        .expect("read the Scene Scope");
    let mut scope = json!({
        "schemaVersion": current.binding.schema_version,
        "compatibilityMarker": current.binding.compatibility_marker,
        "queryIdentity": current.binding.query_identity,
        "materialConstraint": current.binding.material_constraint,
        "knowledgeHolder": current.binding.knowledge_holder,
        "audience": current.binding.audience,
    });
    edit(&mut scope);
    let id = Uuid::new_v4().to_string();
    update_narrative_scene_scope(
        db,
        NarrativeSceneScopeUpdatePayload {
            project_id: fixture.project().to_owned(),
            scene_id: scene.to_owned(),
            request_id: format!("scene-proposals-scope-{id}"),
            session_id: "scene-proposals-session".to_owned(),
            event_uid: format!("scene-proposals-scope-{id}-event"),
            base_version: current.binding.version,
            updated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            scope: serde_json::from_value(scope).expect("typed Scene Scope"),
        },
    )
    .expect("Native Scene Scope update");
}

fn query_bound(db: &Database, fixture: &Fixture, revision: &str, query_scene: &str) -> String {
    let project = fixture.project().to_owned();
    let revision = revision.to_owned();
    let query_scene = query_scene.to_owned();
    db.with_conn_mut(|conn| {
        let mut tx = grimodex_db::ScopedTransaction::begin(conn)?;
        Ok(
            match read_revision_retrieval_eligibility(&mut tx, &project, &revision, &query_scene)? {
                RevisionEligibilityRead::Unavailable { reason } => format!("{reason:?}"),
                RevisionEligibilityRead::Eligible(_) => "eligible".to_owned(),
            },
        )
    })
    .expect("query-bound eligibility")
}

/// Append a Human decision to the current revision of the first child.
fn decide(db: &Database, fixture: &Fixture, revision: &str, decision: &str, choice: &str) {
    let proposal: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT proposal_id FROM narrative_proposal_revisions WHERE id = ?1",
                [revision],
                |row| row.get(0),
            )?)
        })
        .expect("proposal");
    narrative_extraction_append_human_decision(
        db,
        AppendDecisionPayload {
            run_id: fixture.run_id().to_owned(),
            project_id: fixture.project().to_owned(),
            proposal_id: proposal,
            revision_id: revision.to_owned(),
            decision: decision.to_owned(),
            decision_json: Some(json!({"probableDuplicateChoice": choice})),
            created_by: Some("scene-proposals-test".to_owned()),
        },
    )
    .expect("Human decision");
}

/// The Scope-derived reasons are decided by the same parts as the query-bound
/// admission reader, so each one is compared with what that reader answers for
/// another Scene. The expected values are literals, not `scene_proposal_reason_code`.
#[test]
fn a_scene_with_an_unset_scope_is_scope_unsupported_like_the_query_bound_reader() {
    let fixture = Fixture::reviewed_child();
    let db = fixture.db();
    // SRA/1 1.4: the Scope of the evidence Scene is unset (`unknown`).
    update_scene_scope(&db, &fixture, fixture.s1(), |scope| {
        scope["compatibilityMarker"] = json!("unknown");
        let unresolved = json!({"kind":"unresolved","reason":"legacy-axis-unknown"});
        for axis in ["timeline", "worldline", "narrativeLayer"] {
            scope["queryIdentity"][axis] = unresolved.clone();
        }
    });
    let page = list(&db, fixture.project(), fixture.s1(), None, None);
    assert_eq!(page.items.len(), 2);
    for item in &page.items {
        assert!(!item.related_use.likely, "{:?}", item.related_use);
        assert!(
            item.related_use.reasons.contains(&"scope-unsupported"),
            "{:?}",
            item.related_use
        );
        assert_eq!(
            query_bound(&db, &fixture, &item.revision_id, fixture.s2()),
            "ScopeUnsupported"
        );
    }
}

#[test]
fn an_unresolved_material_constraint_is_scope_unsupported_like_the_query_bound_reader() {
    let fixture = Fixture::reviewed_child();
    let db = fixture.db();
    update_scene_scope(&db, &fixture, fixture.s1(), |scope| {
        scope["materialConstraint"]["timeline"] = json!({"kind":"unresolved","reason":"x"});
    });
    let page = list(&db, fixture.project(), fixture.s1(), None, None);
    assert_eq!(page.items.len(), 2);
    for item in &page.items {
        assert!(!item.related_use.likely);
        assert!(
            item.related_use.reasons.contains(&"scope-unsupported"),
            "{:?}",
            item.related_use
        );
        assert_eq!(
            query_bound(&db, &fixture, &item.revision_id, fixture.s2()),
            "ScopeUnsupported"
        );
    }
}

#[test]
fn a_scene_without_a_scope_row_is_material_authority_unavailable_like_the_query_bound_reader() {
    let fixture = Fixture::reviewed_child();
    let db = fixture.db();
    db.with_conn(|conn| {
        let removed = conn.execute(
            "DELETE FROM narrative_scene_scope_bindings WHERE project_id = ?1 AND scene_id = ?2",
            rusqlite::params![fixture.project(), fixture.s1()],
        )?;
        assert_eq!(removed, 1, "the Scope row of the evidence Scene");
        Ok(())
    })
    .expect("remove the Scope row");
    let page = list(&db, fixture.project(), fixture.s1(), None, None);
    assert_eq!(page.items.len(), 2);
    for item in &page.items {
        assert!(!item.related_use.likely);
        assert_eq!(
            item.related_use.reasons,
            vec!["material-authority-unavailable"]
        );
        assert_eq!(
            query_bound(&db, &fixture, &item.revision_id, fixture.s2()),
            "MaterialAuthorityUnavailable"
        );
    }
}

#[test]
fn a_missing_freshness_row_is_source_unverified_not_stale() {
    let fixture = Fixture::reviewed_child();
    let db = fixture.db();
    db.with_conn(|conn| {
        conn.execute("DELETE FROM narrative_consumer_freshness", [])?;
        Ok(())
    })
    .expect("remove the Freshness rows");
    let page = list(&db, fixture.project(), fixture.s1(), None, None);
    assert_eq!(page.items.len(), 2);
    for item in &page.items {
        assert_eq!(item.source_state, SceneProposalSourceState::Unknown);
        assert_eq!(item.related_use.reasons, vec!["source-unverified"]);
        assert_eq!(
            query_bound(&db, &fixture, &item.revision_id, fixture.s2()),
            "CanonicalFreshness(CanonicalRowUnavailable)"
        );
    }
}

#[test]
fn held_and_deferred_decisions_show_in_the_review_state_and_reasons() {
    let fixture = Fixture::reviewed_child();
    let db = fixture.db();
    let revisions = fixture.child_revisions();
    decide(&db, &fixture, &revisions[0], "held", "hold");
    decide(&db, &fixture, &revisions[1], "deferred", "hold");
    let page = list(&db, fixture.project(), fixture.s1(), None, None);
    let held = page
        .items
        .iter()
        .find(|item| item.revision_id == revisions[0])
        .expect("held item");
    let deferred = page
        .items
        .iter()
        .find(|item| item.revision_id == revisions[1])
        .expect("deferred item");
    assert_eq!(held.review_state, SceneProposalReviewState::Held);
    assert_eq!(deferred.review_state, SceneProposalReviewState::Deferred);
    for item in [held, deferred] {
        assert!(!item.related_use.likely);
        assert_eq!(item.related_use.reasons, vec!["not-approved"]);
    }
}

#[test]
fn a_revised_proposal_keeps_its_place_between_two_pages() {
    let fixture = Fixture::reviewed_child();
    let db = fixture.db();
    let first = list(&db, fixture.project(), fixture.s1(), None, Some(1));
    let seen = first.items[0].clone();
    let cursor = first.next_cursor.clone().expect("a second page");
    // The proposal of the first page is revised after that page was read.
    create_native_child(&db, &fixture, &seen.revision_id, |payload| {
        payload["title"] = json!("改めた題");
    });
    let second = list(&db, fixture.project(), fixture.s1(), Some(&cursor), Some(1));
    assert_eq!(second.items.len(), 1);
    assert_ne!(
        second.items[0].proposal_id, seen.proposal_id,
        "the revised proposal is not returned a second time"
    );
    assert_eq!(second.next_cursor, None);
}

#[test]
fn the_chronicle_state_is_bound_to_the_current_revision() {
    let fixture = Fixture::reviewed_child();
    let db = fixture.db();
    enable_manual_apply(&db);
    prepare_and_apply_all(&db, &fixture, "scene-proposals-apply-bound");
    let (proposal, imported) = proposal_titled(&db, "門が開いた");
    // The product refuses to revise an imported proposal, so the case "the
    // current revision is not the one that was imported" is set up in storage:
    // the proposal points back at its root revision, which was never imported.
    let root: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT r.id FROM narrative_proposal_revisions r
                  WHERE r.proposal_id = ?1 AND r.id <> ?2",
                rusqlite::params![proposal, imported],
                |row| row.get(0),
            )?)
        })
        .expect("the root revision of the proposal");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_proposals SET current_revision_id = ?2 WHERE id = ?1",
            rusqlite::params![proposal, root],
        )?;
        Ok(())
    })
    .expect("point the proposal at a revision that was not imported");
    let page = list(&db, fixture.project(), fixture.s1(), None, None);
    let revised = page
        .items
        .iter()
        .find(|item| item.proposal_id == proposal)
        .expect("the proposal with another current revision");
    assert_eq!(revised.revision_id, root);
    assert_eq!(
        revised.chronicle_state,
        SceneProposalChronicleState::NotApplied,
        "only the other revision was imported"
    );
    let other = page
        .items
        .iter()
        .find(|item| item.proposal_id != proposal)
        .expect("the untouched proposal");
    assert_eq!(other.chronicle_state, SceneProposalChronicleState::Applied);
}
