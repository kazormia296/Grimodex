use super::audited_query::prepare_query_with;
use super::*;
use crate::audit::{ModelArtifactIdentity, TokenizerIdentity};
use crate::spec::{SPEC_EN, SPEC_JA};
use grimodex_db::WorkspaceAuthority;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

struct QuietEvents;
impl EventSink for QuietEvents {
    fn emit(&self, _: &str, _: serde_json::Value) {}
}

fn fixture() -> (SemanticRuntime, SemanticRequest) {
    let database = Database::new(Path::new(":memory:")).expect("create test DB");
    database.migrate().expect("migrate test DB");
    database
        .with_conn(|connection| {
            connection.execute(
                "INSERT INTO projects (id,title,language) VALUES ('project','test','ja')",
                [],
            )?;
            Ok(())
        })
        .expect("project fixture");
    let pinned = WorkspaceAuthority::from_database_for_test(
        database,
        std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()),
    )
    .expect("pinned test workspace");
    let runtime = SemanticRuntime::new(
        SemanticPaths {
            models_root: std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()),
            resource_semantic_root: std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()),
        },
        Arc::new(QuietEvents),
    );
    let request = runtime
        .pin_request(|| Ok::<_, anyhow::Error>(Arc::clone(&pinned)))
        .expect("pin semantic request");
    (runtime, request)
}

fn identities() -> (ModelArtifactIdentity, TokenizerIdentity) {
    (
        ModelArtifactIdentity {
            identity_version: 1,
            fingerprint_algorithm: "sha256",
            file_name: "model_int8.onnx".into(),
            sha256: SPEC_JA.artifact_sha256.into(),
            byte_length: SPEC_JA.artifact_size,
        },
        TokenizerIdentity::from_bytes("tokenizer.json", b"test-only immutable tokenizer identity"),
    )
}

fn query(
    runtime: &SemanticRuntime,
    request: &SemanticRequest,
    calls: &AtomicUsize,
) -> AuditedSemanticQuery {
    let (model, tokenizer) = identities();
    prepare_query_with(
        runtime,
        request,
        "project",
        "崩れた橋",
        30,
        &SPEC_JA,
        model,
        tokenizer,
        || {
            calls.fetch_add(1, Ordering::Relaxed);
            let mut vector = vec![0.0; SPEC_JA.embedding_dim];
            vector[0] = 1.0;
            Ok(vector)
        },
    )
    .expect("one successful audited query embedding")
}

fn vector_bytes(dim: usize) -> Vec<u8> {
    let mut vector = vec![0.0_f32; dim];
    vector[0] = 1.0;
    vector.into_iter().flat_map(f32::to_le_bytes).collect()
}

#[test]
fn raw_and_ir_share_one_durable_query_execution_without_loading_another_model() {
    let (runtime, request) = fixture();
    let calls = AtomicUsize::new(0);
    let query = query(&runtime, &request, &calls);
    assert!(runtime
        .semantic_search_with_query(&query, 30, None, Some(false))
        .expect("Raw search")
        .is_empty());
    let vector = vector_bytes(SPEC_JA.embedding_dim);
    assert_eq!(
        runtime
            .score_accepted_documents(&query, query.model_identity(), &[vector.as_slice()])
            .expect("IR score"),
        vec![1.0]
    );
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    let audit = request
        .db()
        .read_ai_audit_snapshot("project", None, None, None)
        .expect("durable audit");
    let prepared: Vec<_> = audit
        .events
        .iter()
        .filter(|event| event.event_type == "request.prepared")
        .collect();
    assert_eq!(prepared.len(), 1);
    assert_eq!(prepared[0].execution_id, query.audit_binding().execution_id);
    assert!(audit.events.iter().any(|event| event.execution_id
        == query.audit_binding().execution_id
        && event.event_type == "execution.succeeded"));
}

#[test]
fn shared_query_rejects_workspace_epoch_change_before_raw_or_ir_consumption() {
    let (runtime, request) = fixture();
    let query = query(&runtime, &request, &AtomicUsize::new(0));
    runtime.rotate_workspace_epoch();
    assert!(runtime
        .semantic_search_with_query(&query, 30, None, None)
        .is_err());
    assert!(runtime
        .score_accepted_documents(&query, query.model_identity(), &[])
        .is_err());
}

#[test]
fn shared_query_rejects_an_unrelated_runtime_with_the_same_numeric_epoch() {
    let (runtime, request) = fixture();
    let query = query(&runtime, &request, &AtomicUsize::new(0));
    let (other, _) = fixture();
    assert!(other
        .semantic_search_with_query(&query, 30, None, None)
        .is_err());
}

#[test]
fn shared_query_rejects_project_language_change_after_inference() {
    let (runtime, request) = fixture();
    let query = query(&runtime, &request, &AtomicUsize::new(0));
    request
        .db()
        .with_conn(|connection| {
            connection.execute("UPDATE projects SET language='en' WHERE id='project'", [])?;
            Ok(())
        })
        .expect("change project language");
    assert!(runtime
        .semantic_search_with_query(&query, 30, None, None)
        .is_err());
    assert!(runtime
        .score_accepted_documents(&query, query.model_identity(), &[])
        .is_err());
}

#[test]
fn shared_query_never_treats_a_deleted_project_as_default_japanese() {
    let (runtime, request) = fixture();
    let query = query(&runtime, &request, &AtomicUsize::new(0));
    request
        .db()
        .with_conn(|connection| {
            connection.execute("DELETE FROM projects WHERE id='project'", [])?;
            Ok(())
        })
        .expect("delete project after query capture");
    assert!(runtime
        .semantic_search_with_query(&query, 30, None, None)
        .is_err());
    assert!(runtime
        .score_accepted_documents(&query, query.model_identity(), &[])
        .is_err());
}

#[test]
fn shared_query_discards_a_result_if_its_epoch_changes_during_inference() {
    let (runtime, request) = fixture();
    let (model, tokenizer) = identities();
    let result = prepare_query_with(
        &runtime,
        &request,
        "project",
        "query",
        30,
        &SPEC_JA,
        model,
        tokenizer,
        || {
            runtime.rotate_workspace_epoch();
            Ok(vec![1.0; SPEC_JA.embedding_dim])
        },
    );
    assert!(result.is_err());
}

#[test]
fn shared_query_rejects_mismatched_model_tokenizer_dimension_and_nonfinite_vectors() {
    let (runtime, request) = fixture();
    let query = query(&runtime, &request, &AtomicUsize::new(0));
    let vector = vector_bytes(SPEC_JA.embedding_dim);
    let mut wrong = query.model_identity().clone();
    wrong.model_id = SPEC_EN.full_model_id();
    assert!(runtime
        .score_accepted_documents(&query, &wrong, &[&vector])
        .is_err());
    let mut wrong = query.model_identity().clone();
    wrong.tokenizer_sha256 = "other-tokenizer".into();
    assert!(runtime
        .score_accepted_documents(&query, &wrong, &[&vector])
        .is_err());
    assert!(runtime
        .score_accepted_documents(&query, query.model_identity(), &[&vector[..4]])
        .is_err());
    let mut corrupt = vector.clone();
    corrupt[..4].copy_from_slice(&f32::NAN.to_le_bytes());
    assert!(runtime
        .score_accepted_documents(&query, query.model_identity(), &[&corrupt])
        .is_err());
}

#[test]
fn shared_query_does_not_enter_inference_when_initial_audit_append_fails() {
    let (runtime, request) = fixture();
    let (model, tokenizer) = identities();
    let calls = AtomicUsize::new(0);
    request.db().with_conn(|connection| { connection.execute_batch("CREATE TRIGGER fail_query_audit BEFORE INSERT ON ai_audit_events BEGIN SELECT RAISE(FAIL, 'synthetic audit denial'); END;")?;Ok(()) }).expect("audit failure fixture");
    let result = prepare_query_with(
        &runtime,
        &request,
        "project",
        "query",
        30,
        &SPEC_JA,
        model,
        tokenizer,
        || {
            calls.fetch_add(1, Ordering::Relaxed);
            Ok(vec![1.0; SPEC_JA.embedding_dim])
        },
    );
    assert!(result.is_err());
    assert_eq!(calls.load(Ordering::Relaxed), 0);
}
