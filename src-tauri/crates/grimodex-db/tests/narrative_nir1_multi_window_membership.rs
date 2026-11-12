//! Three or more windows (MW/1). `support/nir1-multi-window-cold.db.gz` was
//! persisted by the unchanged production planner and extraction path and the
//! Human review UI (`electron/scripts/nir1-multi-window-cold-fixture.mjs`,
//! synthetic prose, the deterministic Journey provider supplying response
//! text). It holds two Runs: the folder `mw-folder-long` (one scene cut into
//! three windows) and the folder `mw-folder-three` (three scenes, one window
//! each). In each, one cluster folds observations of two different windows into
//! one proposal. Mutations are confined to disposable copies of the cold bytes.
use flate2::read::GzDecoder;
use grimodex_core::canonical_json_digest;
use grimodex_db::narrative_extraction::{
    read_revision_material_membership, read_revision_retrieval_eligibility, MaterialMembershipRead,
    RevisionEligibilityRead, RevisionEligibilityReason,
};
use rusqlite::{params, Connection, OpenFlags};
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
            serde_json::from_str(include_str!("support/nir1-multi-window-cold.json"))
                .expect("manifest");
        let compressed = include_bytes!("support/nir1-multi-window-cold.db.gz");
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
        let path = std::env::temp_dir().join(format!("nir1-multi-window-{}.db", Uuid::new_v4()));
        std::fs::write(&path, bytes).expect("private copy");
        Self { path, manifest }
    }
    fn project(&self) -> &str {
        self.manifest["projectId"].as_str().expect("project")
    }
    fn run(&self, shape: &str) -> &Value {
        &self.manifest["runs"][shape]
    }
    fn run_id(&self, shape: &str) -> &str {
        self.run(shape)["runId"].as_str().expect("run id")
    }
    fn scene(&self, key: &str) -> &str {
        self.manifest["scenes"][key].as_str().expect("scene id")
    }
    fn three(&self, index: usize) -> &str {
        self.manifest["scenes"]["three"][index]
            .as_str()
            .expect("scene id")
    }
    /// (title, root revision, current approved child) of every proposal.
    fn proposals(&self, shape: &str) -> Vec<(String, String, String)> {
        self.run(shape)["proposals"]
            .as_array()
            .expect("proposals")
            .iter()
            .map(|p| {
                (
                    p["title"].as_str().expect("title").to_owned(),
                    p["rootRevisionId"].as_str().expect("root").to_owned(),
                    p["revisionId"].as_str().expect("child").to_owned(),
                )
            })
            .collect()
    }
    /// The proposal whose cluster folds observations of two windows.
    fn crossing(&self, shape: &str) -> (String, String, String) {
        let title = match shape {
            "long" => "Ledger seals at the gate",
            _ => "Signal fire on the quay",
        };
        self.proposals(shape)
            .into_iter()
            .find(|p| p.0 == title)
            .expect("crossing proposal")
    }
    fn read_only(&self) -> Connection {
        Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("read only")
    }
    fn digest(&self) -> String {
        hex::encode(Sha256::digest(std::fs::read(&self.path).expect("bytes")))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let mut path = self.path.as_os_str().to_os_string();
            path.push(suffix);
            let _ = std::fs::remove_file(PathBuf::from(path));
        }
    }
}

fn golden(shape: &str) -> Value {
    let text = match shape {
        "long" => include_str!(
            "../src/narrative_extraction/material_roster/production-multi-window-long-golden.json"
        ),
        _ => include_str!(
            "../src/narrative_extraction/material_roster/production-multi-window-folder-golden.json"
        ),
    };
    serde_json::from_str(text).expect("independent TS golden")
}

#[test]
fn the_goldens_are_the_bytes_recorded_with_the_cold_database() {
    let fixture = Fixture::new();
    for (shape, key, text) in [
        (
            "long",
            "long",
            include_str!(
                "../src/narrative_extraction/material_roster/production-multi-window-long-golden.json"
            ),
        ),
        (
            "folder",
            "three",
            include_str!(
                "../src/narrative_extraction/material_roster/production-multi-window-folder-golden.json"
            ),
        ),
    ] {
        assert_eq!(
            hex::encode(Sha256::digest(text.as_bytes())),
            fixture.run(key)["goldenSha256"],
            "{shape}"
        );
        let g = golden(shape);
        assert_eq!(
            g["snapshot"]["snapshot"]["documents"][0]["sourceKey"].as_str(),
            Some(format!("project:scene:{}", {
                if key == "long" { fixture.scene("long") } else { fixture.three(0) }
            }).as_str()),
            "{shape}: the golden is the Run of this database"
        );
    }
}

fn read(conn: &Connection, fixture: &Fixture, revision: &str) -> MaterialMembershipRead {
    let tx = conn.unchecked_transaction().expect("snapshot");
    read_revision_material_membership(&tx, fixture.project(), revision).expect("typed read")
}

#[test]
fn every_proposal_of_a_three_window_run_replays_with_every_window_and_request_seal() {
    let fixture = Fixture::new();
    let before = fixture.digest();
    let conn = fixture.read_only();
    for shape in ["long", "folder"] {
        let key = if shape == "long" { "long" } else { "three" };
        let g = golden(shape);
        let documents = g["snapshot"]["snapshot"]["documents"]
            .as_array()
            .expect("documents");
        assert_eq!(
            g["plan"]["windows"].as_array().expect("windows").len(),
            3,
            "{shape}: three windows"
        );
        for (title, root, child) in fixture.proposals(key) {
            for revision in [&root, &child] {
                let MaterialMembershipRead::Complete(m) = read(&conn, &fixture, revision) else {
                    panic!("{shape} {title}: a normal three-window proposal must be complete")
                };
                assert_eq!(m.run_id, fixture.run_id(key));
                assert_eq!(m.root_revision_id, root);
                assert_eq!(
                    m.replayed_requests.len(),
                    4,
                    "{shape} {title}: three observation requests and the synthesis"
                );
                for proof in &m.replayed_requests {
                    assert_eq!(proof.reconstructed, proof.persisted);
                }
                // Every window is material, selected or not.
                let windows: std::collections::BTreeSet<_> =
                    m.materials.iter().map(|s| s.context_id.clone()).collect();
                assert_eq!(windows.len(), 3, "{shape} {title}: {windows:?}");
                // Per document the materials tile the whole canonical text: no
                // omitted unselected span and no omitted context.
                for document in documents {
                    let text: Vec<u16> = document["canonical"]["text"]
                        .as_str()
                        .expect("text")
                        .encode_utf16()
                        .collect();
                    let segments: Vec<_> = m
                        .materials
                        .iter()
                        .filter(|s| s.document_ref == document["ref"])
                        .collect();
                    let range = |s: &&grimodex_db::narrative_extraction::Material| {
                        (
                            s.canonical_range["start"].as_u64().expect("start") as usize,
                            s.canonical_range["end"].as_u64().expect("end") as usize,
                        )
                    };
                    for segment in &segments {
                        let (start, end) = range(segment);
                        let body = String::from_utf16(&text[start..end]).expect("UTF-16 slice");
                        assert_eq!(
                            segment.content_digest,
                            canonical_json_digest(&json!(body)).expect("digest")
                        );
                    }
                    // A window's own segments tile its source view, and the
                    // windows together (their contexts overlap the
                    // neighbours' owned text) cover the whole canonical text.
                    let mut by_window: std::collections::BTreeMap<&str, Vec<(usize, usize)>> =
                        Default::default();
                    for segment in &segments {
                        by_window
                            .entry(segment.context_id.as_str())
                            .or_default()
                            .push(range(segment));
                    }
                    for (window, mut ranges) in by_window {
                        ranges.sort();
                        assert!(
                            ranges.windows(2).all(|w| w[0].1 == w[1].0),
                            "{shape} {title} {window}: gap or overlap inside one window"
                        );
                    }
                    let mut all: Vec<_> = segments.iter().map(range).collect();
                    all.sort();
                    let mut cursor = 0;
                    for (start, end) in all {
                        assert!(start <= cursor, "{shape} {title}: gap at {cursor}");
                        cursor = cursor.max(end);
                    }
                    assert_eq!(cursor, text.len(), "{shape} {title}: whole text covered");
                }
                let sources: std::collections::BTreeSet<_> =
                    m.materials.iter().map(|s| s.source_key.clone()).collect();
                assert_eq!(
                    sources.len(),
                    documents.len(),
                    "{shape} {title}: every declared scene is material"
                );
                let envelope: String = conn
                    .query_row(
                        "SELECT reconciliation_envelope_json FROM narrative_proposal_revisions WHERE id=?1",
                        [revision],
                        |r| r.get(0),
                    )
                    .expect("sealed revision");
                let envelope: Value = serde_json::from_str(&envelope).expect("envelope");
                assert_eq!(
                    serde_json::to_value(&m.material_basis).expect("basis"),
                    envelope["effectiveMaterialBasis"],
                    "the reader never shrinks the sealed basis"
                );
            }
        }
        // The crossing proposal really folds two windows: its own contexts name
        // observations of window 1 and window 3.
        let (_, _, child) = fixture.crossing(key);
        let envelope: String = conn
            .query_row(
                "SELECT reconciliation_envelope_json FROM narrative_proposal_revisions WHERE id=?1",
                [&child],
                |r| r.get(0),
            )
            .expect("sealed child");
        for window in ["window-001", "window-003"] {
            assert!(
                envelope.contains(&format!("event-observation:{window}:")),
                "{shape}: the crossing proposal cites {window}"
            );
        }
    }
    drop(conn);
    assert_eq!(fixture.digest(), before, "reads write nothing");
}

#[test]
fn a_changed_missing_or_foreign_window_receipt_rejects_the_whole_three_window_membership() {
    for shape in ["long", "three"] {
        for window in 0..3 {
            for corruption in ["missing", "cross-run", "wrong-attempt", "request-seal"] {
                let fixture = Fixture::new();
                let conn = Connection::open(&fixture.path).expect("private corruption copy");
                let run = fixture.run_id(shape).to_owned();
                let (id, payload): (String, String) = conn
                    .query_row(
                        "SELECT id,receipt_json FROM narrative_extraction_stage_receipts
                          WHERE run_id=?1 AND json_extract(receipt_json,'$.stageExecution.stageId')='narrative_observation_extract'
                          ORDER BY id LIMIT 1 OFFSET ?2",
                        params![run, window],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .expect("observation receipt of one window");
                match corruption {
                    "missing" => {
                        conn.execute(
                            "DELETE FROM narrative_extraction_stage_receipts WHERE id=?1",
                            [&id],
                        )
                        .expect("remove receipt");
                    }
                    "cross-run" => {
                        conn.execute(
                            "UPDATE narrative_extraction_stage_receipts SET run_id='different-run' WHERE id=?1",
                            [&id],
                        )
                        .expect("cross-run row");
                    }
                    "wrong-attempt" => {
                        conn.execute(
                            "UPDATE narrative_extraction_stage_receipts SET attempt_id='different-attempt' WHERE id=?1",
                            [&id],
                        )
                        .expect("wrong attempt");
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
                for (title, _, child) in fixture.proposals(shape) {
                    assert!(
                        matches!(
                            read(&conn, &fixture, &child),
                            MaterialMembershipRead::Unavailable { .. }
                        ),
                        "{shape} window {window} {corruption}: {title} must reject all materials"
                    );
                }
            }
        }
    }
}

#[test]
fn a_missing_or_duplicated_window_in_a_resealed_plan_rejects_the_membership() {
    for shape in ["long", "three"] {
        for duplicate in [true, false] {
            let fixture = Fixture::new();
            let conn = Connection::open(&fixture.path).expect("private corruption copy");
            let (id, payload): (String, String) = conn
                .query_row(
                    "SELECT id,payload_json FROM narrative_extraction_artifacts WHERE run_id=?1 AND artifact_kind='source.window-plan@1'",
                    [fixture.run_id(shape)],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .expect("plan");
            let mut plan: Value = serde_json::from_str(&payload).expect("plan JSON");
            if duplicate {
                plan["windows"][2] = plan["windows"][1].clone();
            } else {
                plan["windows"].as_array_mut().expect("windows").remove(1);
            }
            conn.execute(
                "UPDATE narrative_extraction_artifacts SET payload_json=?2,payload_digest=?3 WHERE id=?1",
                params![
                    id,
                    plan.to_string(),
                    canonical_json_digest(&plan).expect("digest")
                ],
            )
            .expect("reseal the corrupted artifact only");
            for (title, _, child) in fixture.proposals(shape) {
                assert!(
                    matches!(
                        read(&conn, &fixture, &child),
                        MaterialMembershipRead::Unavailable { .. }
                    ),
                    "{shape} duplicate={duplicate}: {title}"
                );
            }
        }
    }
}

fn reason(read: &RevisionEligibilityRead) -> Option<&RevisionEligibilityReason> {
    match read {
        RevisionEligibilityRead::Unavailable { reason } => Some(reason),
        RevisionEligibilityRead::Eligible(_) => None,
    }
}

/// A proposal is shown only to a scene that comes after every scene of its
/// material. Folder `mw-folder-long` precedes `mw-folder-three`, which
/// precedes `mw-after`; `mw-before` precedes both.
#[test]
fn a_three_window_proposal_is_eligible_only_after_the_last_scene_of_its_material() {
    let fixture = Fixture::new();
    let conn = fixture.read_only();
    let before = fixture.digest();
    let verdict = |revision: &str, query: &str| {
        let tx = conn.unchecked_transaction().expect("snapshot");
        read_revision_retrieval_eligibility(&tx, fixture.project(), revision, query)
            .expect("public Rust retrieval admission")
    };
    let after = fixture.scene("after").to_owned();
    // (query scene, eligible for the one-scene folder's proposals, for the
    // three-scene folder's proposals that cite one scene)
    let matrix = [
        (after.clone(), true, true),
        (fixture.scene("before").to_owned(), false, false),
        // The scene itself and its own folder are not "after" the material.
        (fixture.scene("long").to_owned(), false, false),
        // The three-scene folder follows the long scene's folder.
        (fixture.three(0).to_owned(), true, false),
        // Inside the folder: the material's later scenes do not precede it.
        (fixture.three(1).to_owned(), true, false),
        (fixture.three(2).to_owned(), true, false),
    ];
    for (query, long_eligible, three_eligible) in matrix {
        for (shape, expected) in [("long", long_eligible), ("three", three_eligible)] {
            for (title, _, child) in fixture.proposals(shape) {
                let actual = verdict(&child, &query);
                if title == "Signal fire on the quay" {
                    // Its evidence is in two scenes: no related scene ever
                    // shows it (unchanged by the window count).
                    assert!(
                        reason(&actual).is_some(),
                        "{shape} {title} from {query}: {actual:?}"
                    );
                    if query == after {
                        assert!(
                            matches!(
                                reason(&actual),
                                Some(RevisionEligibilityReason::EvidenceMismatch)
                            ),
                            "{shape} {title}: {actual:?}"
                        );
                    }
                } else if expected {
                    assert!(
                        matches!(actual, RevisionEligibilityRead::Eligible(_)),
                        "{shape} {title} from {query}: {actual:?}"
                    );
                } else {
                    assert!(
                        matches!(
                            reason(&actual),
                            Some(RevisionEligibilityReason::SourceNotBeforeQuery)
                        ),
                        "{shape} {title} from {query}: only the disclosure order may refuse: {actual:?}"
                    );
                }
            }
        }
    }
    // The historical root is not the current approved child, whatever the
    // query: the verdict does not depend on the window count.
    for shape in ["long", "three"] {
        for (_, root, _) in fixture.proposals(shape) {
            let actual = verdict(&root, &after);
            assert!(
                matches!(
                    reason(&actual),
                    Some(RevisionEligibilityReason::RevisionNotCurrentHumanApproved)
                ),
                "{shape} root: {actual:?}"
            );
        }
    }
    drop(conn);
    assert_eq!(fixture.digest(), before, "admission writes nothing");
}

#[test]
fn normal_scope_dependencies_of_the_three_window_runs_are_healthy_in_project_verify() {
    let fixture = Fixture::new();
    let db = grimodex_db::Database::new(&fixture.path).expect("open the disposable fixture");
    db.migrate()
        .expect("migrate and backfill the disposable fixture");
    drop(db);
    let conn = fixture.read_only();
    let tx = conn
        .unchecked_transaction()
        .expect("coherent Verify snapshot");
    let report = grimodex_db::narrative_extraction::verify_narrative_dependency_graph_for_project(
        &tx,
        fixture.project(),
    )
    .expect("production graph Verify");
    assert!(report.edge_ids_with_missing_source.is_empty(), "{report:?}");
    assert!(report.edge_ids_with_unresolvable_consumer_scope.is_empty());
    assert!(report.is_consistent(), "{report:?}");
}
