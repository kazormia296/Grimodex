use std::io::Read;

use flate2::read::GzDecoder;
use grimodex_db::narrative_extraction::{
    read_revision_retrieval_eligibility, RevisionEligibilityRead,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[test]
fn retrieval_statement_is_ordered_immutable_assertion_text_with_exact_bindings() {
    let manifest: Value =
        serde_json::from_str(include_str!("support/nir1-reviewed-child-cold.json"))
            .expect("normal UI fixture manifest");
    let mut bytes = vec![];
    GzDecoder::new(include_bytes!("support/nir1-reviewed-child-cold.db.gz").as_slice())
        .read_to_end(&mut bytes)
        .expect("cold fixture");
    let before = hex::encode(Sha256::digest(&bytes));
    assert_eq!(before, manifest["uncompressedDatabaseSha256"]);
    let path = std::env::temp_dir().join(format!("nir1-statement-{}.db", uuid::Uuid::new_v4()));
    std::fs::write(&path, bytes).expect("private fixture copy");
    {
        let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("read-only DB");
        let tx = conn.unchecked_transaction().expect("one read snapshot");
        let project = manifest["projectId"].as_str().expect("project");
        let query = manifest["s2"].as_str().expect("S2");
        for revision in manifest["revisionIds"].as_array().expect("children") {
            let revision = revision.as_str().expect("revision");
            let RevisionEligibilityRead::Eligible(snapshot) =
                read_revision_retrieval_eligibility(&tx, project, revision, query)
                    .expect("complete normal UI child")
            else {
                panic!("normal approved child must be eligible");
            };
            let (envelope, digest): (String, String) = tx.query_row(
                "SELECT reconciliation_envelope_json,reconciliation_envelope_digest FROM narrative_proposal_revisions WHERE id=?1",
                [revision], |row| Ok((row.get(0)?, row.get(1)?)),
            ).expect("immutable envelope");
            let envelope: Value = serde_json::from_str(&envelope).expect("envelope JSON");
            let payload = &envelope["assertion"]["payload"];
            let expected = format!(
                "{{\"summary\":{},\"actuality\":{},\"attribution\":{},\"narrativeFrame\":{}}}",
                payload["summary"],
                payload["actuality"],
                payload["attribution"],
                payload["narrativeFrame"]
            );
            assert_eq!(snapshot.revision_id, revision);
            assert_eq!(snapshot.owning_run_id, manifest["runId"]);
            assert_eq!(snapshot.envelope_digest, digest);
            assert_eq!(snapshot.document.revision_id, revision);
            assert_eq!(snapshot.document.envelope_digest, digest);
            assert_eq!(
                snapshot.document.serializer_ref,
                "chronicle-semantic-retrieval/1"
            );
            assert_eq!(snapshot.document.serialized_statement, expected);
            assert_eq!(
                snapshot.document.serialized_statement_digest,
                format!(
                    "sha256:{}",
                    hex::encode(Sha256::digest(expected.as_bytes()))
                )
            );
            assert_eq!(snapshot.canonical_freshness.revision_id, revision);
            assert!(!snapshot.current_decision_id.is_empty());
            assert!(!snapshot.evidence.is_empty());
            assert_eq!(
                serde_json::to_value(&snapshot.evidence).expect("evidence"),
                envelope["effectiveMaterialBasis"]["evidenceSet"]
            );
            assert_eq!(
                snapshot.query_context.audience,
                grimodex_db::narrative_extraction::QueryIdentityState::Resolved("reader".into())
            );
            assert!(!snapshot.query_context.allow_secrets);
            let parsed: Value = serde_json::from_str(&snapshot.document.serialized_statement)
                .expect("statement JSON");
            assert_eq!(parsed.as_object().expect("object").len(), 4);
            assert_eq!(parsed["actuality"], json!(payload["actuality"]));
        }
    }
    assert_eq!(
        hex::encode(Sha256::digest(std::fs::read(&path).expect("DB bytes"))),
        before
    );
    std::fs::remove_file(path).expect("remove private copy");
}
