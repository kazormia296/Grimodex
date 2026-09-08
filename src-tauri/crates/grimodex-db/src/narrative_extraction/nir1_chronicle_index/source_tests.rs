use std::{io::Read, path::PathBuf};

use flate2::read::GzDecoder;
use rusqlite::Connection;
use serde_json::Value;

use super::source::read_eligibility_source;

struct Fixture {
    conn: Connection,
    path: PathBuf,
    manifest: Value,
}

impl Fixture {
    fn new() -> Self {
        let mut bytes = Vec::new();
        GzDecoder::new(
            include_bytes!("../../../tests/support/nir1-reviewed-child-cold.db.gz").as_slice(),
        )
        .read_to_end(&mut bytes)
        .expect("normal UI cold fixture");
        let path = std::env::temp_dir().join(format!("nir1-source-{}.db", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).expect("private fixture copy");
        Self {
            conn: Connection::open(&path).expect("private fixture"),
            path,
            manifest: serde_json::from_str(include_str!(
                "../../../tests/support/nir1-reviewed-child-cold.json"
            ))
            .expect("normal UI provenance"),
        }
    }

    fn project(&self) -> &str {
        self.manifest["projectId"].as_str().expect("project")
    }

    fn token(&self) -> String {
        let tx = self.conn.unchecked_transaction().expect("Source snapshot");
        read_eligibility_source(&tx, self.project())
            .expect("Source digest")
            .digest
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[test]
fn nir1_eligibility_source_is_deterministic_and_not_freshness_authority() {
    let f = Fixture::new();
    let token = f.token();
    assert_eq!(token, f.token());
    assert!(token.starts_with("sha256:") && token.len() == 71);
    // Negative private-copy mutation: changing canonical status must not
    // invent a second Freshness authority in this logical Source digest.
    f.conn.execute("UPDATE narrative_consumer_freshness SET evidence_freshness='unknown',build_action='manual'", []).expect("private freshness change");
    assert_eq!(token, f.token());
}

#[test]
fn nir1_eligibility_source_tracks_current_own_decision_identity_and_authority() {
    let f = Fixture::new();
    let token = f.token();
    let child = f.manifest["revisionIds"][0].as_str().expect("child");
    f.conn
        .execute(
            "UPDATE narrative_proposal_decisions SET actor_id='wrong-actor' WHERE revision_id=?1",
            [child],
        )
        .expect("private negative actor mutation");
    assert_ne!(token, f.token());
    let actor_changed = f.token();
    f.conn
        .execute(
            "UPDATE narrative_proposal_decisions SET id=id || '-replaced' WHERE revision_id=?1",
            [child],
        )
        .expect("private negative identity mutation");
    assert_ne!(actor_changed, f.token());
}

#[test]
fn nir1_eligibility_source_keeps_unapproved_current_roster_and_detects_withdrawal() {
    let f = Fixture::new();
    let token = f.token();
    f.conn
        .execute("UPDATE narrative_proposals SET status='rejected'", [])
        .expect("private withdrawal-shaped state");
    assert_ne!(token, f.token());
    let tx = f.conn.unchecked_transaction().expect("Source snapshot");
    let source = read_eligibility_source(&tx, f.project()).expect("unapproved roster");
    assert_eq!(
        source.revisions.len(),
        2,
        "unapproved identities must not disappear from Source dependencies"
    );
}

#[test]
fn nir1_eligibility_source_does_not_treat_a_missing_project_as_usable_empty() {
    let f = Fixture::new();
    let tx = f.conn.unchecked_transaction().expect("Source snapshot");
    assert!(read_eligibility_source(&tx, "missing-project").is_err());
    assert!(read_eligibility_source(&tx, "").is_err());
}

#[test]
fn nir1_eligibility_source_requires_one_caller_owned_snapshot() {
    let f = Fixture::new();
    assert!(read_eligibility_source(&f.conn, f.project()).is_err());
}

#[test]
fn nir1_compact_build_admission_matches_the_cold_reader_for_each_scene() {
    use crate::narrative_extraction::{
        project_scope_authority::load_live_project_scope_authority,
        retrieval_admission::{
            build::read_build_candidate, read_retrieval_query_context,
            read_revision_retrieval_eligibility, RetrievalQueryContextRead,
            RevisionEligibilityRead,
        },
    };
    let f = Fixture::new();
    let tx = f.conn.unchecked_transaction().expect("one snapshot");
    let authority = load_live_project_scope_authority(
        &tx,
        f.project(),
        &format!("project:scope-authority:{}", f.project()),
    )
    .expect("live scope");
    let revisions = read_eligibility_source(&tx, f.project())
        .expect("roster")
        .revisions;
    let scenes = tx
        .prepare("SELECT id FROM tree_nodes WHERE project_id=?1 AND node_type='scene' ORDER BY id")
        .expect("scenes")
        .query_map([f.project()], |row| row.get::<_, String>(0))
        .expect("scene rows")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("scene ids");
    let mut admitted = 0;
    let mut denied = 0;
    for revision in revisions {
        let candidate = read_build_candidate(&tx, f.project(), &revision, &authority)
            .expect("cold build")
            .expect("normal approved child");
        for scene in &scenes {
            let compact =
                match read_retrieval_query_context(&tx, f.project(), scene).expect("query") {
                    RetrievalQueryContextRead::Available(query) => candidate.admits(&query),
                    RetrievalQueryContextRead::Unavailable { .. } => false,
                };
            let cold = read_revision_retrieval_eligibility(&tx, f.project(), &revision, scene)
                .expect("cold admission");
            assert_eq!(
                compact,
                matches!(cold, RevisionEligibilityRead::Eligible(_)),
                "{revision} at {scene}"
            );
            if let RevisionEligibilityRead::Eligible(value) = cold {
                assert_eq!(value.document, candidate.document);
                assert_eq!(value.evidence, candidate.evidence);
                assert_eq!(value.current_decision_id, candidate.current_decision_id);
                admitted += 1;
            } else {
                denied += 1;
            }
        }
    }
    assert!(
        admitted > 0 && denied > 0,
        "both admission boundaries must be exercised"
    );
}
