use super::nir1_documents::{embed_document_with, Nir1DocumentPipeline};
use super::*;
use crate::audit::{sha256_hex, ModelArtifactIdentity, TokenizerIdentity};
use crate::embedding::DocumentTokenLimit;
use crate::spec::SPEC_EN;
use grimodex_db::WorkspaceAuthority;
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

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
    let (model, tokenizer) = identities();
    embed_document_with(
        runtime, request, "p", input, &SPEC_EN, model, tokenizer, pipeline,
    )
}

fn identities() -> (ModelArtifactIdentity, TokenizerIdentity) {
    (
        ModelArtifactIdentity {
            identity_version: 1,
            fingerprint_algorithm: "sha256",
            file_name: "model_int8.onnx".into(),
            sha256: SPEC_EN.artifact_sha256.into(),
            byte_length: SPEC_EN.artifact_size,
        },
        TokenizerIdentity::from_bytes("tokenizer.json", b"synthetic tokenizer identity"),
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

#[test]
fn nir1_document_batch_yields_to_audited_raw_query_between_documents() {
    let (runtime, request) = fixture();
    let documents: Vec<_> = (1..=3)
        .map(|index| Nir1EmbeddingDocument {
            revision_id: format!("revision-{index}"),
            ..input()
        })
        .collect();
    let entries = Mutex::new(Vec::new());
    let (first_done, first_ready) = mpsc::channel();
    let (resume, resumed) = mpsc::channel();
    let runtime = &runtime;
    let request = &request;
    let entries = &entries;
    let documents = &documents;

    let (outcomes, query) = std::thread::scope(|scope| {
        let background = scope.spawn(move || {
            let mut pipeline = Pipeline {
                request: request.clone(),
                tokenize_calls: 0,
                inference_calls: 0,
                skip: false,
                fail_terminal: false,
            };
            let outcomes = runtime
                .embed_nir1_documents_with(request, "p", documents, |document, spec| {
                    assert_eq!(spec.dir_name, SPEC_EN.dir_name);
                    entries
                        .lock()
                        .expect("entries")
                        .push(document.revision_id.clone());
                    let outcome = run(runtime, request, document, &mut pipeline)?;
                    if document.revision_id == "revision-1" {
                        first_done.send(()).expect("first document completed");
                        resumed
                            .recv_timeout(Duration::from_secs(5))
                            .expect("release document");
                    }
                    Ok(outcome)
                })
                .expect("all documents indexed");
            assert_eq!(pipeline.inference_calls, 3);
            outcomes
        });
        first_ready
            .recv_timeout(Duration::from_secs(5))
            .expect("first document");
        let foreground = scope.spawn(move || {
            runtime
                .embedder_admission
                .foreground(|| {
                    let (model, tokenizer) = identities();
                    super::audited_query::prepare_query_with(
                        runtime,
                        request,
                        "p",
                        "collapsed bridge",
                        30,
                        &SPEC_EN,
                        model,
                        tokenizer,
                        || {
                            entries.lock().expect("entries").push("raw-query".into());
                            let mut vector = vec![0.0; SPEC_EN.embedding_dim];
                            vector[0] = 1.0;
                            Ok(vector)
                        },
                    )
                })
                .expect("audited Raw query")
        });
        assert!(runtime.embedder_admission.wait_for_foreground_waiters(1));
        resume.send(()).expect("release first document");
        (
            background.join().expect("background"),
            foreground.join().expect("foreground"),
        )
    });

    assert_eq!(
        *entries.lock().expect("entries"),
        ["revision-1", "raw-query", "revision-2", "revision-3"]
    );
    let revisions: Vec<_> = outcomes
        .iter()
        .map(|outcome| match outcome {
            Nir1DocumentEmbeddingOutcome::Indexed { document, .. } => document.revision_id.as_str(),
            _ => panic!("expected complete document result"),
        })
        .collect();
    assert_eq!(revisions, ["revision-1", "revision-2", "revision-3"]);
    assert!(runtime
        .semantic_search_with_query(&query, 30, None, Some(false))
        .expect("Raw search")
        .is_empty());
    let audit = request
        .db()
        .read_ai_audit_snapshot("p", None, None, None)
        .expect("audit");
    assert_eq!(
        audit
            .events
            .iter()
            .filter(|event| event.event_type == "request.prepared")
            .count(),
        4
    );
    assert_eq!(
        audit
            .events
            .iter()
            .filter(|event| event.event_type == "execution.succeeded")
            .count(),
        4
    );
    assert!(audit
        .events
        .iter()
        .any(|event| event.event_type == "execution.succeeded"
            && event.execution_id == query.audit_binding().execution_id));
}

#[test]
fn queued_nir1_document_and_raw_query_recheck_epoch_and_model_before_inference() {
    for change in ["epoch", "model"] {
        let (runtime, request) = fixture();
        let documents = [
            input(),
            Nir1EmbeddingDocument {
                revision_id: "revision-2".into(),
                ..input()
            },
        ];
        let (first_done, first_ready) = mpsc::channel();
        let (resume, resumed) = mpsc::channel();
        let runtime = &runtime;
        let request = &request;
        let documents = &documents;

        std::thread::scope(|scope| {
            let background = scope.spawn(move || {
                let mut pipeline = Pipeline {
                    request: request.clone(),
                    tokenize_calls: 0,
                    inference_calls: 0,
                    skip: false,
                    fail_terminal: false,
                };
                let result =
                    runtime.embed_nir1_documents_with(request, "p", documents, |document, _| {
                        let outcome = run(runtime, request, document, &mut pipeline)?;
                        if document.revision_id == "revision-1" {
                            first_done.send(()).expect("first document completed");
                            resumed
                                .recv_timeout(Duration::from_secs(5))
                                .expect("release document");
                        }
                        Ok(outcome)
                    });
                let error = result.err().expect("entire batch is rejected");
                assert!(error.to_string().contains(if change == "epoch" {
                    "SEMANTIC_QUERY_STALE"
                } else {
                    "SEMANTIC_QUERY_MODEL_CHANGED"
                }));
                assert_eq!(pipeline.tokenize_calls, 1);
                assert_eq!(pipeline.inference_calls, 1);
            });
            first_ready
                .recv_timeout(Duration::from_secs(5))
                .expect("first document");
            let foreground = scope.spawn(move || {
                runtime
                    .embedder_admission
                    .foreground(|| {
                        let (model, tokenizer) = identities();
                        super::audited_query::prepare_query_with(
                            runtime,
                            request,
                            "p",
                            "collapsed bridge",
                            30,
                            &SPEC_EN,
                            model,
                            tokenizer,
                            || panic!("stale queued query must not infer"),
                        )
                    })
                    .err()
                    .expect("stale Raw query is rejected")
            });
            assert!(runtime.embedder_admission.wait_for_foreground_waiters(1));
            if change == "epoch" {
                runtime.rotate_workspace_epoch();
            } else {
                request
                    .db()
                    .with_conn(|connection| {
                        connection.execute("UPDATE projects SET language='ja' WHERE id='p'", [])?;
                        Ok(())
                    })
                    .expect("change model while queued");
            }
            resume.send(()).expect("release document");
            background.join().expect("background");
            let query_error = foreground.join().expect("foreground");
            assert!(query_error.to_string().contains(if change == "epoch" {
                "IPC_DERIVED_CANCELLED"
            } else {
                "SEMANTIC_QUERY_MODEL_CHANGED"
            }));
        });
        let audit = request
            .db()
            .read_ai_audit_snapshot("p", None, None, None)
            .expect("audit");
        assert_eq!(
            audit
                .events
                .iter()
                .filter(|event| event.event_type == "request.prepared")
                .count(),
            1
        );
        assert_eq!(
            audit
                .events
                .iter()
                .filter(|event| event.event_type == "execution.succeeded")
                .count(),
            1
        );
    }
}
