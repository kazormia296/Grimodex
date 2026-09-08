use super::nir1_documents::{embed_document_with, Nir1DocumentPipeline};
use super::*;
use crate::audit::{sha256_hex, ModelArtifactIdentity, TokenizerIdentity};
use crate::embedding::DocumentTokenLimit;
use crate::spec::SPEC_EN;
use grimodex_db::WorkspaceAuthority;
use std::path::Path;

struct QuietEvents;
impl EventSink for QuietEvents {
    fn emit(&self, _: &str, _: serde_json::Value) {}
}

fn fixture() -> (SemanticRuntime, SemanticRequest) {
    let db = Database::new(Path::new(":memory:")).expect("test DB");
    db.migrate().expect("migrate");
    db.with_conn(|connection| {
        connection.execute(
            "INSERT INTO projects (id,title,language) VALUES ('p','test','en')",
            [],
        )?;
        Ok(())
    })
    .expect("project");
    let pinned = WorkspaceAuthority::from_database_for_test(
        db,
        std::env::temp_dir().join(uuid::Uuid::new_v4().to_string()),
    )
    .expect("workspace");
    let runtime = SemanticRuntime::new(
        SemanticPaths {
            models_root: "unused".into(),
            resource_semantic_root: "unused".into(),
        },
        Arc::new(QuietEvents),
    );
    let request = runtime
        .pin_request(|| Ok::<_, anyhow::Error>(Arc::clone(&pinned)))
        .expect("pin");
    (runtime, request)
}

fn input() -> Nir1EmbeddingDocument {
    let statement = r#"{"summary":"The bridge collapsed.","actuality":"actual","attribution":"narrator","narrativeFrame":"story-world"}"#.to_string();
    Nir1EmbeddingDocument {
        revision_id: "revision-1".into(),
        envelope_digest: format!("sha256:{}", "a".repeat(64)),
        serializer_ref: "chronicle-semantic-retrieval/1".into(),
        serialized_statement_digest: format!("sha256:{}", sha256_hex(statement.as_bytes())),
        serialized_statement: statement,
    }
}

struct Pipeline {
    request: SemanticRequest,
    tokenize_calls: usize,
    inference_calls: usize,
    skip: bool,
    fail_terminal: bool,
}

impl Nir1DocumentPipeline for Pipeline {
    type Prepared = usize;
    fn prepare(&mut self, _: &str) -> Result<usize> {
        self.tokenize_calls += 1;
        let audit = self
            .request
            .db()
            .read_ai_audit_snapshot("p", None, None, None)?;
        assert!(
            audit
                .events
                .iter()
                .any(|event| event.event_type == "request.prepared"),
            "exact input must be durable before tokenization"
        );
        if self.fail_terminal {
            self.request.db().with_conn(|connection| {
                connection.execute_batch("CREATE TRIGGER fail_terminal BEFORE INSERT ON ai_audit_events BEGIN SELECT RAISE(FAIL, 'terminal audit failure'); END;")?;
                Ok(())
            })?;
        }
        if self.skip {
            return Err(DocumentTokenLimit {
                actual_tokens: 513,
                maximum_tokens: 512,
            }
            .into());
        }
        Ok(1234)
    }
    fn embed(&mut self, prepared: usize) -> Result<Vec<f32>> {
        assert_eq!(prepared, 1234, "same checked encoding is consumed");
        self.inference_calls += 1;
        let mut vector = vec![0.0; SPEC_EN.embedding_dim];
        vector[0] = 1.0;
        Ok(vector)
    }
}

fn run(
    runtime: &SemanticRuntime,
    request: &SemanticRequest,
    input: &Nir1EmbeddingDocument,
    pipeline: &mut impl Nir1DocumentPipeline,
) -> Result<Nir1DocumentEmbeddingOutcome> {
    embed_document_with(
        runtime,
        request,
        "p",
        input,
        &SPEC_EN,
        ModelArtifactIdentity {
            identity_version: 1,
            fingerprint_algorithm: "sha256",
            file_name: "model_int8.onnx".into(),
            sha256: SPEC_EN.artifact_sha256.into(),
            byte_length: SPEC_EN.artifact_size,
        },
        TokenizerIdentity::from_bytes("tokenizer.json", b"synthetic tokenizer identity"),
        pipeline,
    )
}

#[test]
fn nir1_document_tokenizer_failure_is_terminal_before_dispatch() {
    struct BrokenTokenizer;
    impl Nir1DocumentPipeline for BrokenTokenizer {
        type Prepared = ();
        fn prepare(&mut self, _: &str) -> Result<()> {
            Err(anyhow!("synthetic tokenizer failure"))
        }
        fn embed(&mut self, _: ()) -> Result<Vec<f32>> {
            panic!("must not enter ORT")
        }
    }
    let (runtime, request) = fixture();
    assert!(run(&runtime, &request, &input(), &mut BrokenTokenizer).is_err());
    let audit = request
        .db()
        .read_ai_audit_snapshot("p", None, None, None)
        .expect("audit");
    assert!(audit
        .events
        .iter()
        .any(|event| event.event_type == "execution.failed"));
    assert!(!audit
        .events
        .iter()
        .any(|event| event.event_type == "request.dispatched"));
}

#[test]
fn nir1_document_exact_input_and_result_remain_bound_to_one_durable_execution() {
    let (runtime, request) = fixture();
    let input = input();
    let mut pipeline = Pipeline {
        request: request.clone(),
        tokenize_calls: 0,
        inference_calls: 0,
        skip: false,
        fail_terminal: false,
    };
    let output = run(&runtime, &request, &input, &mut pipeline).expect("indexed");
    let Nir1DocumentEmbeddingOutcome::Indexed {
        document,
        embedding,
        identity,
        audit_binding,
    } = output
    else {
        panic!("expected vector")
    };
    assert_eq!(document, input);
    assert_eq!(embedding.len(), SPEC_EN.embedding_dim * 4);
    assert_eq!(identity.model_id, SPEC_EN.full_model_id());
    assert_eq!(pipeline.tokenize_calls, 1);
    assert_eq!(pipeline.inference_calls, 1);
    let audit = request
        .db()
        .read_ai_audit_snapshot("p", None, None, None)
        .expect("audit");
    let prepared = audit
        .events
        .iter()
        .find(|event| event.event_type == "request.prepared")
        .expect("prepared");
    assert_eq!(prepared.execution_id, audit_binding.execution_id);
    assert_eq!(
        prepared.payload["input"]["rawText"],
        input.serialized_statement
    );
    assert!(prepared.payload["input"]["tokenizerMayTruncateAt"].is_null());
    assert!(audit
        .events
        .iter()
        .any(|event| event.event_type == "execution.succeeded"
            && event.execution_id == audit_binding.execution_id));
}

#[test]
fn nir1_document_token_limit_is_typed_durable_skip_without_inference() {
    let (runtime, request) = fixture();
    let mut pipeline = Pipeline {
        request: request.clone(),
        tokenize_calls: 0,
        inference_calls: 0,
        skip: true,
        fail_terminal: false,
    };
    let output = run(&runtime, &request, &input(), &mut pipeline).expect("durable typed skip");
    assert!(matches!(
        output,
        Nir1DocumentEmbeddingOutcome::SkippedTokenLimit {
            limit: DocumentTokenLimit {
                actual_tokens: 513,
                maximum_tokens: 512
            },
            ..
        }
    ));
    assert_eq!(pipeline.inference_calls, 0);
    let audit = request
        .db()
        .read_ai_audit_snapshot("p", None, None, None)
        .expect("audit");
    assert!(audit
        .events
        .iter()
        .any(|event| event.event_type == "execution.skipped"));
    assert!(!audit
        .events
        .iter()
        .any(|event| event.event_type == "execution.succeeded"));
}

#[test]
fn nir1_document_terminal_audit_failure_is_an_error_for_skip_and_vector() {
    for skip in [true, false] {
        let (runtime, request) = fixture();
        let mut pipeline = Pipeline {
            request: request.clone(),
            tokenize_calls: 0,
            inference_calls: 0,
            skip,
            fail_terminal: true,
        };
        assert!(run(&runtime, &request, &input(), &mut pipeline).is_err());
    }
}

#[test]
fn nir1_document_rejects_wrong_digest_order_extra_keys_and_mutable_substitutes_before_tokenization()
{
    for change in ["digest", "order", "extra", "mutable", "serializer"] {
        let (runtime, request) = fixture();
        let mut doc = input();
        match change {
            "digest" => doc.serialized_statement_digest = "sha256:wrong".into(),
            "order" => doc.serialized_statement = r#"{"actuality":"actual","summary":"bridge","attribution":"narrator","narrativeFrame":"story-world"}"#.into(),
            "extra" => doc.serialized_statement = r#"{"summary":"bridge","actuality":"actual","attribution":"narrator","narrativeFrame":"story-world","note":"mutable"}"#.into(),
            "mutable" => doc.serialized_statement = r#"{"title":"bridge","actuality":"actual","attribution":"narrator","narrativeFrame":"story-world"}"#.into(),
            "serializer" => doc.serializer_ref = "future/2".into(),
            _ => unreachable!(),
        }
        if change != "digest" {
            doc.serialized_statement_digest =
                format!("sha256:{}", sha256_hex(doc.serialized_statement.as_bytes()));
        }
        let mut pipeline = Pipeline {
            request: request.clone(),
            tokenize_calls: 0,
            inference_calls: 0,
            skip: false,
            fail_terminal: false,
        };
        assert!(run(&runtime, &request, &doc, &mut pipeline).is_err());
        assert_eq!(pipeline.tokenize_calls, 0);
        assert_eq!(pipeline.inference_calls, 0);
    }
}
