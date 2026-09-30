//! An unchanged production planner persisted this fixture before two-window replay.
//! Mutations are confined to disposable corruption copies of the cold database.
use flate2::read::GzDecoder;
use grimodex_core::canonical_json_digest;
use grimodex_db::narrative_extraction::{
    read_revision_material_membership, MaterialMembershipRead,
};
use grimodex_db::Database;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{io::Read, path::PathBuf};
use uuid::Uuid;

struct Fixture {
    path: PathBuf,
    manifest: Value,
}
impl Fixture {
    fn new() -> Self {
        let manifest: Value =
            serde_json::from_str(include_str!("support/nir1-two-window-cold.json"))
                .expect("manifest");
        let compressed = include_bytes!("support/nir1-two-window-cold.db.gz");
        assert_eq!(
            hex::encode(Sha256::digest(compressed)),
            manifest["compressedDatabaseSha256"]
        );
        let mut bytes = vec![];
        GzDecoder::new(compressed.as_slice())
            .read_to_end(&mut bytes)
            .expect("exact cold bytes");
        assert_eq!(
            hex::encode(Sha256::digest(&bytes)),
            manifest["uncompressedDatabaseSha256"]
        );
        let path = std::env::temp_dir().join(format!("nir1-two-window-{}.db", Uuid::new_v4()));
        std::fs::write(&path, bytes).expect("private copy");
        Self { path, manifest }
    }
    fn target(&self) -> &Value {
        self.manifest["normalApprovedChildren"]
            .as_array()
            .expect("children")
            .iter()
            .find(|c| c["sceneId"] == self.manifest["targetSceneId"])
            .expect("target")
    }
    fn project(&self) -> &str {
        self.manifest["projectId"].as_str().expect("project")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[test]
fn two_window_child_retains_declared_unselected_window_and_every_request_seal() {
    let fixture = Fixture::new();
    let conn =
        Connection::open_with_flags(&fixture.path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("read only");
    let tx = conn.unchecked_transaction().expect("snapshot");
    let target = fixture.target();
    let child = target["revisionId"].as_str().expect("child");
    let read =
        read_revision_material_membership(&tx, fixture.project(), child).expect("typed read");
    let MaterialMembershipRead::Complete(m) = read else {
        panic!("normal two-window child must be complete: {read:?}")
    };
    assert_eq!(m.root_revision_id, target["rootRevisionId"]);
    assert_eq!(m.lineage.len(), 2);
    assert_eq!(
        m.replayed_requests.len(),
        3,
        "two observation requests and the selected synthesis"
    );
    for proof in &m.replayed_requests {
        assert_eq!(proof.reconstructed, proof.persisted);
    }
    let envelope: String = tx
        .query_row(
            "SELECT reconciliation_envelope_json FROM narrative_proposal_revisions WHERE id=?1",
            [child],
            |r| r.get(0),
        )
        .expect("sealed child");
    let envelope: Value = serde_json::from_str(&envelope).expect("envelope");
    assert_eq!(
        serde_json::to_value(&m.material_basis).expect("basis"),
        envelope["effectiveMaterialBasis"],
        "reader never shrinks the sealed basis"
    );
    let extra = format!(
        "project:scene:{}",
        fixture.manifest["extraSceneId"].as_str().expect("extra")
    );
    assert!(
        m.material_basis
            .evidence_set
            .iter()
            .all(|e| e.source_key != extra),
        "additional window is unselected Evidence"
    );
    assert!(m
        .material_basis
        .dependency_set
        .iter()
        .any(|d| d.input_ref == extra));
    assert!(
        m.materials.iter().any(|s| s.source_key == extra),
        "its effective declaration still requires complete materials"
    );
    let golden: Value = serde_json::from_str(include_str!(
        "../src/narrative_extraction/material_roster/production-two-window-golden.json"
    ))
    .expect("independent TS golden");
    for document in golden["snapshot"]["snapshot"]["documents"]
        .as_array()
        .expect("documents")
    {
        let text: Vec<_> = document["canonical"]["text"]
            .as_str()
            .expect("text")
            .encode_utf16()
            .collect();
        let mut segments: Vec<_> = m
            .materials
            .iter()
            .filter(|s| s.document_ref == document["ref"])
            .collect();
        segments.sort_by_key(|s| s.canonical_range["start"].as_u64().expect("start"));
        let mut cursor = 0;
        for segment in segments {
            let start = segment.canonical_range["start"].as_u64().expect("start") as usize;
            let end = segment.canonical_range["end"].as_u64().expect("end") as usize;
            assert_eq!(start, cursor, "no omitted unselected span or context");
            let body = String::from_utf16(&text[start..end]).expect("UTF16 slice");
            assert_eq!(
                segment.content_digest,
                canonical_json_digest(&json!(body)).expect("digest")
            );
            cursor = end;
        }
        assert_eq!(cursor, text.len(), "full declared window covered");
    }
    drop(tx);
    drop(conn);
    assert_eq!(
        hex::encode(Sha256::digest(
            std::fs::read(&fixture.path).expect("cold bytes")
        )),
        fixture.manifest["uncompressedDatabaseSha256"]
    );
}

#[test]
fn two_window_missing_or_swapped_input_artifacts_never_publish_membership() {
    for kind in [
        "source.window-plan@1",
        "chronicle.raw-observations@1",
        "chronicle.stage-synthesis-outputs@1",
    ] {
        let fixture = Fixture::new();
        let conn = Connection::open(&fixture.path).expect("private corrupt copy");
        let run = fixture.target()["runId"].as_str().expect("run");
        assert_eq!(
            conn.execute(
                "DELETE FROM narrative_extraction_artifacts WHERE run_id=?1 AND artifact_kind=?2",
                params![run, kind]
            )
            .expect("remove required input in private copy"),
            1
        );
        let tx = conn.unchecked_transaction().expect("snapshot");
        assert!(
            matches!(
                read_revision_material_membership(
                    &tx,
                    fixture.project(),
                    fixture.target()["revisionId"].as_str().expect("child")
                )
                .expect("typed read"),
                MaterialMembershipRead::Unavailable { .. }
            ),
            "missing {kind}"
        );
    }
}

#[test]
fn missing_cross_run_or_wrong_attempt_receipts_reject_the_entire_two_window_membership() {
    for corruption in ["missing", "cross-run", "wrong-attempt", "request-seal"] {
        let fixture = Fixture::new();
        let conn = Connection::open(&fixture.path).expect("private corruption copy");
        let run = fixture.target()["runId"].as_str().expect("run");
        let (id, payload): (String, String) = conn.query_row(
            "SELECT id,receipt_json FROM narrative_extraction_stage_receipts WHERE run_id=?1 AND json_extract(receipt_json,'$.stageExecution.stageId')='narrative_observation_extract' ORDER BY id LIMIT 1",
            [run], |r| Ok((r.get(0)?,r.get(1)?))).expect("required observation receipt");
        match corruption {
            "missing" => {
                conn.execute(
                    "DELETE FROM narrative_extraction_stage_receipts WHERE id=?1",
                    [&id],
                )
                .expect("remove receipt");
            }
            "cross-run" => {
                conn.execute("UPDATE narrative_extraction_stage_receipts SET run_id='different-run' WHERE id=?1", [&id]).expect("cross-run row");
            }
            "wrong-attempt" => {
                conn.execute("UPDATE narrative_extraction_stage_receipts SET attempt_id='different-attempt' WHERE id=?1", [&id]).expect("wrong attempt");
            }
            _ => {
                let mut receipt: Value = serde_json::from_str(&payload).expect("receipt");
                receipt["finalRequestDigest"] = json!(format!("sha256:{}", "0".repeat(64)));
                conn.execute(
                    "UPDATE narrative_extraction_stage_receipts SET receipt_json=?2 WHERE id=?1",
                    params![id, receipt.to_string()],
                )
                .expect("changed request seal");
            }
        }
        let tx = conn.unchecked_transaction().expect("snapshot");
        assert!(
            matches!(
                read_revision_material_membership(
                    &tx,
                    fixture.project(),
                    fixture.target()["revisionId"].as_str().expect("child")
                )
                .expect("typed rejection"),
                MaterialMembershipRead::Unavailable { .. }
            ),
            "{corruption} receipt must reject all materials"
        );
    }
}

#[test]
fn duplicate_window_in_resealed_plan_rejects_two_window_membership() {
    let fixture = Fixture::new();
    let conn = Connection::open(&fixture.path).expect("private corruption copy");
    let (id, payload): (String, String) = conn.query_row("SELECT id,payload_json FROM narrative_extraction_artifacts WHERE run_id=?1 AND artifact_kind='source.window-plan@1'", [fixture.target()["runId"].as_str().expect("run")], |r| Ok((r.get(0)?, r.get(1)?))).expect("plan");
    let mut plan: Value = serde_json::from_str(&payload).expect("plan JSON");
    plan["windows"][1] = plan["windows"][0].clone();
    conn.execute(
        "UPDATE narrative_extraction_artifacts SET payload_json=?2,payload_digest=?3 WHERE id=?1",
        params![
            id,
            plan.to_string(),
            canonical_json_digest(&plan).expect("digest")
        ],
    )
    .expect("reseal corrupted artifact only");
    let tx = conn.unchecked_transaction().expect("snapshot");
    assert!(matches!(
        read_revision_material_membership(
            &tx,
            fixture.project(),
            fixture.target()["revisionId"].as_str().expect("child")
        )
        .expect("typed rejection"),
        MaterialMembershipRead::Unavailable { .. }
    ));
}

#[test]
fn normal_scope_dependencies_are_healthy_in_project_verify_before_canonical_cutover() {
    let fixture = Fixture::new();
    let db = Database::new(&fixture.path).expect("open disposable fixture through Database");
    db.migrate().expect("migrate and backfill disposable fixture");
    drop(db);
    let conn =
        Connection::open_with_flags(&fixture.path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("read only");
    let tx = conn
        .unchecked_transaction()
        .expect("coherent Verify snapshot");
    let report = grimodex_db::narrative_extraction::verify_narrative_dependency_graph_for_project(
        &tx,
        fixture.project(),
    )
    .expect("production graph Verify");
    assert!(
        report.edge_ids_with_missing_source.is_empty(),
        "valid Scope dependency must resolve with its own Run: {report:?}"
    );
    assert!(report.edge_ids_with_unresolvable_consumer_scope.is_empty());
    assert!(
        report.is_consistent(),
        "normal durable graph remains consistent"
    );
}

#[test]
fn graph_verify_rejects_scope_dependency_with_missing_or_other_run_owner() {
    for missing in [true, false] {
        let fixture = Fixture::new();
        let conn = Connection::open(&fixture.path).expect("private corruption copy");
        let child = fixture.target()["revisionId"].as_str().expect("target");
        let id: String = conn.query_row("SELECT id FROM narrative_dependency_edges WHERE consumer_key=?1 AND source_object_identity LIKE 'scope-dependency:v1:%'", [child], |r|r.get(0)).expect("scope edge");
        let other_run: String = conn
            .query_row(
                "SELECT id FROM narrative_extraction_runs WHERE id!=?1 ORDER BY id LIMIT 1",
                [fixture.target()["runId"].as_str().expect("run")],
                |r| r.get(0),
            )
            .expect("other persisted run");
        conn.execute(
            "UPDATE narrative_dependency_edges SET owning_run_id=?2 WHERE id=?1",
            params![id, if missing { None } else { Some(other_run) }],
        )
        .expect("corrupt edge provenance");
        let tx = conn.unchecked_transaction().expect("Verify snapshot");
        let report =
            grimodex_db::narrative_extraction::verify_narrative_dependency_graph_for_project(
                &tx,
                fixture.project(),
            )
            .expect("Verify report");
        assert!(report
            .edge_ids_with_unresolvable_consumer_scope
            .contains(&id));
        assert!(
            !report.edge_ids_with_missing_source.contains(&id),
            "untrusted Run provenance is not a missing Source verdict"
        );
    }
}
