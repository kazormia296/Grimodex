//! Private deterministic storage/audit contract fixtures. These vectors are
//! deliberately synthetic and are never retrieval-quality or model evidence.
use std::{io::Read, path::PathBuf};

use flate2::read::GzDecoder;
use serde_json::{json, Value};

use super::{super::retrieval_admission::ChronicleRetrievalDocument, *};
use crate::{ai_audit::AppendAiAuditEvent, Database};

pub(super) struct Fixture {
    pub db: Database,
    pub runtime: NirChronicleIndexRuntime,
    pub manifest: Value,
    path: PathBuf,
}

impl Fixture {
    pub fn new() -> Self {
        Self::open(
            include_bytes!("../../../tests/support/nir1-reviewed-child-cold.db.gz"),
            include_str!("../../../tests/support/nir1-reviewed-child-cold.json"),
        )
    }

    /// The three-window cold workspace (MW/1): two Runs, four approved
    /// current proposals, each with a secret unapproved Root.
    pub fn multi_window() -> Self {
        Self::open(
            include_bytes!("../../../tests/support/nir1-multi-window-cold.db.gz"),
            include_str!("../../../tests/support/nir1-multi-window-cold.json"),
        )
    }

    fn open(compressed: &[u8], manifest: &str) -> Self {
        let mut bytes = Vec::new();
        GzDecoder::new(compressed)
            .read_to_end(&mut bytes)
            .expect("cold workspace");
        let path = std::env::temp_dir().join(format!("nir1-index-{}.db", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).expect("private workspace");
        let db = Database::new(&path).expect("fixture connection");
        db.migrate().expect("schema upgrade");
        let runtime = NirChronicleIndexRuntime::new(&db, 1);
        let manifest = serde_json::from_str(manifest).expect("provenance");
        Self {
            db,
            runtime,
            manifest,
            path,
        }
    }

    /// The workspace file, for a second connection (DR-CP4-V-1 tests).
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    pub fn project(&self) -> &str {
        self.manifest["projectId"].as_str().expect("project")
    }

    pub fn prepare(&self) -> (NirIndexBuildPlan, Vec<ChronicleRetrievalDocument>) {
        self.db
            .with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                match prepare_chronicle_index_build(&tx, &self.runtime, self.project())? {
                    NirIndexBuildRead::Ready { plan, documents } => Ok((plan, documents)),
                    NirIndexBuildRead::Unavailable { reason } => {
                        anyhow::bail!("unexpected preparation {reason:?}")
                    }
                    NirIndexBuildRead::AlreadyUsable => anyhow::bail!("unexpected reusable proof"),
                }
            })
            .expect("prepare full current pool")
    }

    pub fn outcomes(&self, docs: Vec<ChronicleRetrievalDocument>) -> Vec<NirEmbeddedDocument> {
        docs.into_iter()
            .map(|doc| self.outcome(doc, false))
            .collect()
    }

    /// The five-event embedding audit of `document` (`skip`: the token-limit
    /// shape), with the bindings it names.
    pub fn outcome_audit(
        &self,
        document: &ChronicleRetrievalDocument,
        skip: bool,
    ) -> (
        Vec<AppendAiAuditEvent>,
        String,
        String,
        NirEmbeddingIdentity,
        Vec<u8>,
    ) {
        super::outcome_audit::outcome_audit(document, skip)
    }

    pub fn outcome(&self, document: ChronicleRetrievalDocument, skip: bool) -> NirEmbeddedDocument {
        let (events, execution_id, operation_id, identity, embedding) =
            self.outcome_audit(&document, skip);
        self.db
            .append_ai_audit_events(self.project(), &events)
            .expect("normal durable audit append");
        let audit_binding = NirEmbeddingAuditBinding {
            operation_id,
            execution_id,
        };
        if skip {
            NirEmbeddedDocument::SkippedTokenLimit {
                document,
                identity,
                audit_binding,
                actual_tokens: 513,
                maximum_tokens: 512,
            }
        } else {
            NirEmbeddedDocument::Indexed {
                document,
                embedding,
                identity,
                audit_binding,
            }
        }
    }

    pub fn published_count(&self) -> i64 {
        self.db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM narrative_nir1_chronicle_vectors WHERE project_id=?1",
                    [self.project()],
                    |r| r.get(0),
                )?)
            })
            .expect("derived row count")
    }

    pub fn hold(&self, revision: &str) {
        use crate::narrative_extraction::{
            narrative_extraction_append_human_decision, AppendDecisionPayload,
        };
        let proposal = self
            .db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT proposal_id FROM narrative_proposal_revisions WHERE id=?1",
                    [revision],
                    |r| r.get::<_, String>(0),
                )?)
            })
            .expect("current proposal");
        narrative_extraction_append_human_decision(
            &self.db,
            AppendDecisionPayload {
                run_id: self.manifest["runId"]
                    .as_str()
                    .expect("original run")
                    .into(),
                project_id: self.project().into(),
                proposal_id: proposal,
                revision_id: revision.into(),
                decision: "held".into(),
                decision_json: Some(json!({"probableDuplicateChoice":"hold"})),
                created_by: None,
            },
        )
        .expect("Native Human withdrawal");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Deterministic interruption inside a requested stage, after work has begun.
pub(super) struct StopAt(pub super::super::GraphWorkStage);

impl super::super::GraphWorkControl for StopAt {
    fn check(&mut self, stage: super::super::GraphWorkStage) -> anyhow::Result<()> {
        if stage == self.0 {
            return Err(super::super::validation_terminated(
                super::super::ValidationTerminationReason::Cancelled,
                "test Chronicle owner stopped",
            ));
        }
        Ok(())
    }

    fn allows_full_eligibility(&self) -> bool {
        true
    }
}

pub(super) fn assert_stopped<T>(result: anyhow::Result<T>) {
    let error = result.err().expect("controlled work must observe stop");
    assert_eq!(
        error
            .downcast_ref::<super::super::ValidationTerminated>()
            .map(|error| error.reason),
        Some(super::super::ValidationTerminationReason::Cancelled),
        "stop must not become unavailable, stale, or Source missing: {error:#}"
    );
}
