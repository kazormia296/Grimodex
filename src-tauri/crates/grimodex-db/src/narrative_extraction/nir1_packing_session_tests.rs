//! HC1-4: the session history run, end to end (K4/3 sections 3, 6, 8, 10).
//!
//! Every attempt here is made by the product writers: a Human input is
//! accepted by `accept_current_human_chat_input` (which supersedes the
//! session's earlier capture), the D-final read builds the inputs, the
//! qualification rows and the history slot, `create_attempt_for_capture_bounded`
//! stores the attempt, `claim_attempt_bounded` and `finish_attempt_bounded`
//! write its receipt and generated output. The fixture sets the target Scene's
//! story-time key and POV (through `tree_node_patch`) before the Revisions are
//! approved, so that all nine axes of the current turn are available.
//! History adoption is DI-1b's; the only thing added to a D-final output here
//! is the rows of the adopted past Human and generated inputs, built the way
//! the table of K4/3 section 3 says. The test-support writers (`create_attempt`)
//! are used only for the shapes the product writers cannot make: a second
//! attempt of one Human, an attempt with no history slot, and a legacy row.

use super::*;
use crate::domain_writes::{
    project_patch, tree_node_create, tree_node_delete, ProjectPatchPayload, TreeNodeCreatePayload,
    TreeNodeDeletePayload,
};
use crate::narrative_extraction::change_feed::NarrativeChangeOrigin;
use crate::narrative_extraction::incremental_freshness::run_incremental_freshness_cycle;
use crate::narrative_extraction::nir1_entity_relation::create_nir1_entity_relation_revision;
use crate::narrative_extraction::nir1_entity_relation::tests::{
    approve_typed_revision, create_typed_run, prepare_a3_scope_fixture, rebind_scope_tokens,
    request_for_run, seed_run_and_catalog,
};
use crate::narrative_extraction::nir1_entity_relation::{
    evaluate_nir1_entity_relation_disclosure, Nir1EntityRelationDisclosureRead,
};
use crate::narrative_extraction::scope_storage_authority_tests::{patch, project_token, save_body};
use crate::narrative_maintenance_connection::ParticipantSqlControl;
use crate::nir1_generation::history_context::HistoryContextGateReason;
use crate::nir1_generation::{
    accept_current_human_chat_input, cancel_current_human_chat_input, claim_attempt_bounded,
    create_attempt, create_attempt_for_capture_bounded, finish_attempt_bounded,
    finish_pretransport_attempt_bounded, read_attempt, read_attempt_scene_binding_in_tx,
    AcceptedChatInputCapture, AttemptBinding, AttemptBindingVersion, AttemptCallerBinding,
    ChatInputCaptureOwner, GenerationHistoryReadBudget, GenerationHistorySnapshotCancellation,
    GenerationHistorySnapshotSqlBudget, GenerationHistorySqlLedger, GenerationPurpose, NewAttempt,
    NewChatInputSubmission, NewMessageBody, Nir1AdmissionSqlBudget, Nir1ClaimOutcome,
    Nir1ExpectedAttempt, Nir1ExpectedClaim, Nir1PinnedSqlBudget, Nir1ZeroSendCompletion,
    ReadBudget,
};
use crate::nir1_generation_history::{
    reauthorize_session_history, reauthorize_session_history_in_tx, CandidateDisposition,
    ContextMismatch, CurrentContextUnavailable, CurrentHistoryContext, Failure, HistoryAxisName,
    HistoryRange, HumanLineageReason, IncompleteReason, IneligibleReason, NoHistory,
    RequalificationReason, SessionCandidateKind, SessionCandidateResult, SessionHistoryOutcome,
    SessionHistoryRequest,
};
use crate::test_support::current_schema_memory;
use grimodex_core::narrative_nir1::ScopeValue;
use grimodex_core::narrative_nir1_receipt::{
    Completion, OutputChannel, OutputObserver, ProviderTerminal,
};
use rusqlite::params;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::tests::{prepared_sql_budget, PreparedWorkspace, RAW_SOURCE_PROJECT, RAW_SOURCE_SCENE};

const SESSION: &str = "hc1-session";
const PROJECT: &str = RAW_SOURCE_PROJECT;
const SCENE: &str = RAW_SOURCE_SCENE;
/// The Scene the fixture's two Revisions are anchored to.
const ANCHOR: &str = "nir1";
/// The Scene the third Revision is anchored to.
const OTHER_ANCHOR: &str = "a3-source";

fn digest_of(value: &str) -> String {
    canonical_json_digest(&json!(value)).expect("digest")
}

fn wall_clock_ms() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_millis(),
    )
    .expect("clock fits")
}

/// What a turn left behind.
#[derive(Clone)]
struct Turn {
    attempt_id: String,
    capture: AcceptedChatInputCapture,
    human_message_id: String,
    human_version_id: String,
    human_digest: String,
    /// The generated output (message id, version id, body digest), when the
    /// turn succeeded.
    output: Option<(String, String, String)>,
}

/// Something a later turn adopts as history.
#[derive(Clone, Debug)]
enum Adopt {
    Human {
        version_id: String,
        digest: String,
    },
    Output {
        version_id: String,
        digest: String,
        parent_attempt_id: String,
    },
}

impl Adopt {
    fn human(turn: &Turn) -> Self {
        Self::Human {
            version_id: turn.human_version_id.clone(),
            digest: turn.human_digest.clone(),
        }
    }

    fn output(turn: &Turn) -> Self {
        let (_, version_id, digest) = turn.output.clone().expect("the turn succeeded");
        Self::Output {
            version_id,
            digest,
            parent_attempt_id: turn.attempt_id.clone(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Writer {
    /// `create_attempt_for_capture_bounded`.
    Product,
    /// `create_attempt` (a shape the product writer cannot make).
    TestSupport { null_slot: bool },
}

/// A change to the qualification rows of a turn, made after D-final.
type RowMutation = Box<dyn FnOnce(&mut Vec<QualificationReference>)>;

/// One turn to make.
struct TurnSpec {
    text: String,
    adopt: Vec<Adopt>,
    reply: Option<String>,
    revisions: Option<Vec<String>>,
    purpose: GenerationPurpose,
    created_at_ms: Option<i64>,
    capture: Option<(AcceptedChatInputCapture, String)>,
    writer: Writer,
    mutate: Option<RowMutation>,
    /// Read D-final with the Native selection and a Graph (DI-1a).
    graph: bool,
    /// The create's read budget; `SessionFixture::read_budget()` when `None`.
    create_budget: Option<ReadBudget>,
    /// DI1B-3: ask D-final for the turn's own history instead of adopting
    /// `adopt` by hand.
    history: Option<NativeNir1HistoryRequest>,
    /// The selector's context budget in tokens.
    context_budget: usize,
}

impl TurnSpec {
    fn new(text: &str) -> Self {
        Self {
            text: text.to_owned(),
            adopt: Vec::new(),
            reply: None,
            revisions: None,
            purpose: GenerationPurpose::Writing,
            created_at_ms: None,
            capture: None,
            writer: Writer::Product,
            mutate: None,
            graph: false,
            create_budget: None,
            history: None,
            context_budget: 100_000,
        }
    }

    /// A turn whose D-final input carries Graph-derived inputs.
    fn with_graph(mut self) -> Self {
        self.graph = true;
        self
    }

    /// Let D-final adopt the turn's history (the Native clock's `now_ms` and
    /// the envelope of a chat message).
    fn native_history(mut self, now_ms: i64, message_envelope_tokens: usize) -> Self {
        self.history = Some(NativeNir1HistoryRequest {
            now_ms,
            message_envelope_tokens,
        });
        self
    }

    /// Create the attempt with this read budget (the Native one for a test
    /// that sizes a history window against the create).
    fn create_budget(mut self, budget: ReadBudget) -> Self {
        self.create_budget = Some(budget);
        self
    }

    fn adopt(mut self, items: &[Adopt]) -> Self {
        self.adopt = items.to_vec();
        self
    }

    fn reply(mut self, reply: &str) -> Self {
        self.reply = Some(reply.to_owned());
        self
    }

    fn revisions(mut self, revisions: &[String]) -> Self {
        self.revisions = Some(revisions.to_vec());
        self
    }

    fn purpose(mut self, purpose: GenerationPurpose) -> Self {
        self.purpose = purpose;
        self
    }

    fn created_at(mut self, created_at_ms: i64) -> Self {
        self.created_at_ms = Some(created_at_ms);
        self
    }

    fn writer(mut self, writer: Writer) -> Self {
        self.writer = writer;
        self
    }

    fn mutate(mut self, mutate: impl FnOnce(&mut Vec<QualificationReference>) + 'static) -> Self {
        self.mutate = Some(Box::new(mutate));
        self
    }

    fn capture(mut self, capture: AcceptedChatInputCapture, message_id: String) -> Self {
        self.capture = Some((capture, message_id));
        self
    }
}

struct SessionFixture {
    _workspace: PreparedWorkspace,
    snapshot: crate::state::ActiveWorkspaceSnapshot,
    /// The two Revisions anchored at `ANCHOR`.
    revisions: Vec<String>,
    /// The Revision anchored at `OTHER_ANCHOR`.
    other_revision: String,
    /// Attempts are created at `clock_base + turn * 1000` ms.
    clock_base: i64,
    turns: usize,
}

/// A new approved Revision of the seed Entities whose readings all name
/// `anchor`, bound to that Scene's projection.
fn approve_anchored(db: &Database, anchor: &str, proposal_key: &str) -> Result<String> {
    approve_anchored_in(db, "hc1-other-run", anchor, proposal_key)
}

fn approve_anchored_in(
    db: &Database,
    run_id: &str,
    anchor: &str,
    proposal_key: &str,
) -> Result<String> {
    let mut typed = request_for_run(db, run_id, proposal_key);
    for entity in typed.bundle.entities.iter_mut() {
        entity.scope.reading = ScopeValue::Exact {
            value: format!("scene:{anchor}"),
        };
        entity.scope.phase = "draft".into();
    }
    rebind_scope_tokens(db, &mut typed)?;
    let created = create_nir1_entity_relation_revision(db, typed)?;
    approve_typed_revision(db, run_id, &created)?;
    Ok(created["revisionId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("typed revision id missing"))?
        .to_owned())
}

/// A new approved Revision that names one Entity only, anchored at `anchor`.
/// Two such Revisions of different Entities have disjoint disclosure
/// dependencies, so a change to one Entity retires only the outputs that hold
/// its Revision.
fn approve_single_entity_revision(
    db: &Database,
    run_id: &str,
    anchor: &str,
    proposal_key: &str,
    entity_id: &str,
) -> Result<String> {
    create_typed_run(db, run_id)?;
    let mut typed = request_for_run(db, run_id, proposal_key);
    typed
        .bundle
        .entities
        .retain(|entity| entity.entity_id == entity_id);
    typed.bundle.relations.clear();
    for entity in typed.bundle.entities.iter_mut() {
        entity.scope.reading = ScopeValue::Exact {
            value: format!("scene:{anchor}"),
        };
        entity.scope.phase = "draft".into();
    }
    rebind_scope_tokens(db, &mut typed)?;
    let created = create_nir1_entity_relation_revision(db, typed)?;
    approve_typed_revision(db, run_id, &created)?;
    Ok(created["revisionId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("typed revision id missing"))?
        .to_owned())
}

/// The product's narrative commit pipeline (proposal set, human approval,
/// prepare, apply) creates a secret foreshadow that has a setup and no payoff
/// and is linked to `entity_id`. Its reveal state is then "not disclosed" for
/// every Scene, so the A3 evaluation of any Revision that names the Entity
/// stops being Eligible, while neither a Scene's Scope binding nor the
/// Revision's Source, Decision or bundle changes.
fn create_secret_foreshadow_linked_to(db: &Database, entity_id: &str, tag: &str) -> Result<()> {
    use crate::narrative_extraction::{
        narrative_extraction_apply_commit, narrative_extraction_prepare_commit,
        narrative_extraction_save_proposal_set, AppendDecisionPayload, ApplyCommitPayload,
        CommitApplicationRef, CommitOperation, CreateRunPayload, CreateTaskSeed,
        PrepareCommitPayload, ProposalSeed, SaveProposalSetPayload,
    };

    let run_id = format!("hc1-fs-run-{tag}");
    let set_id = format!("hc1-fs-set-{tag}");
    let source_key = format!("snapshot:{run_id}");
    let read_set = json!([{
        "inputRef": source_key,
        "kind": "snapshot-document",
        "revisionToken": "revision-1"
    }]);
    let envelope = json!({
        "schemaVersion": 1, "runId": run_id, "taskId": format!("{run_id}-task"),
        "reconcilerId": "test.reconciler", "reconcilerVersion": "1.0.0",
        "proposalSchemaId": "narrative.test", "proposalSchemaVersion": "1",
        "sourceBasis": [{"sourceKind":"snapshot-document","sourceKey":source_key,"revisionToken":"revision-1"}],
        "evidenceSet": [], "readSet": read_set,
        "readSetDigest": format!("sha256:{}", crate::narrative_extraction::digest_plan(&read_set)),
        "changeKind": "add"
    });
    let payload = json!({
        "foreshadowId": format!("hc1-fs-{tag}"),
        "hypothesisId": format!("foreshadow-thread:hc1-{tag}"),
        "title": "A secret that is not yet paid off",
        "intent": "Hide the secret until its payoff.",
        "mechanism": "object-use",
        "secret": true,
        "setups": [{
            "setupId": format!("hc1-fs-setup-{tag}"),
            "sceneId": "a3-source",
            "fromPos": 0,
            "toPos": 10,
            "role": "plant",
            "kind": "designated_existing",
            "aiStrength": null,
            "rationale": "The secret is planted.",
            "semanticKey": format!("hc1-plant-{tag}")
        }],
        "payoffs": [],
        "supportEdges": [],
        "codexEntryIds": [entity_id]
    });
    crate::narrative_extraction::narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.clone()),
            project_id: PROJECT.to_owned(),
            surface_path_id: "foreshadow.extract".to_owned(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "foreshadow" }),
            spec_digest: "spec".to_owned(),
            snapshot_digest: Some("revision-1".to_owned()),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some(format!("{run_id}-task")),
                task_kind: "extract_window".to_owned(),
                input_json: None,
                priority: None,
            }],
        },
    )?;
    let saved = narrative_extraction_save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: run_id.clone(),
            project_id: PROJECT.to_owned(),
            proposal_set_id: Some(set_id.clone()),
            set_kind: "foreshadow.extract.review@1".to_owned(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some(format!("{run_id}-prop")),
                proposal_key: format!("{run_id}-key"),
                kind: "foreshadow.aggregate.create".to_owned(),
                payload_json: payload.clone(),
                reconciliation_envelope: Some(envelope),
            }],
        },
    )?;
    let proposal = saved["proposals"]
        .as_array()
        .and_then(|proposals| proposals.first())
        .ok_or_else(|| anyhow::anyhow!("foreshadow proposal missing"))?;
    let proposal_id = proposal["proposalId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("foreshadow proposal id missing"))?
        .to_owned();
    let revision_id = proposal["revisionId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("foreshadow revision id missing"))?
        .to_owned();
    crate::narrative_extraction::narrative_extraction_append_human_decision(
        db,
        AppendDecisionPayload {
            run_id: run_id.clone(),
            project_id: PROJECT.to_owned(),
            proposal_id: proposal_id.clone(),
            revision_id: revision_id.clone(),
            decision: "approved".to_owned(),
            decision_json: None,
            created_by: Some("hc1-test".to_owned()),
        },
    )?;
    let before = crate::load_narrative_runtime_policy_from_db(db)?;
    crate::set_narrative_runtime_policy(
        db,
        crate::SetNarrativeRuntimePolicyInput {
            expected_version: before.version,
            runtime_mode: "manual-apply".into(),
            maintenance_enabled: false,
            generic_import_enabled: false,
            background_ai_enabled: false,
        },
    )?;
    let request_id = format!("hc1-fs-request-{tag}");
    let prepared = narrative_extraction_prepare_commit(
        db,
        PrepareCommitPayload {
            project_id: PROJECT.to_owned(),
            run_id: run_id.clone(),
            proposal_set_id: set_id,
            request_id: request_id.clone(),
            plan_digest: format!("hc1-fs-digest-{tag}"),
            session_id: "hc1-fs-session".to_owned(),
            surface: Some("narrative-extraction".to_owned()),
            operations: vec![CommitOperation {
                kind: "foreshadow.aggregate.create".to_owned(),
                payload,
                proposal_id: proposal_id.clone(),
                revision_id: revision_id.clone(),
            }],
            applications: vec![CommitApplicationRef {
                proposal_id,
                revision_id,
            }],
            expected_tail_ordinal: None,
            entity_bindings: vec![],
            expected_calendar_version: None,
        },
    )?;
    narrative_extraction_apply_commit(
        db,
        ApplyCommitPayload {
            project_id: PROJECT.to_owned(),
            prepared_commit_id: prepared["preparedCommitId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("prepared commit id missing"))?
                .to_owned(),
            request_id,
            session_id: "hc1-fs-session".to_owned(),
            expected_version: prepared["version"].as_i64(),
        },
    )?;
    Ok(())
}

impl SessionFixture {
    fn new() -> Result<Self> {
        Self::new_in(current_schema_memory()?)
    }

    /// The same fixture on a database file, so that it can be reopened.
    fn new_on_file(path: &std::path::Path) -> Result<Self> {
        let db = Database::new(path)?;
        db.migrate()?;
        Self::new_in(db)
    }

    /// Close the workspace and open the same database file again: a new
    /// authority instance, a new live binding, and none of the process-local
    /// values the attempts recorded (a cold reopen).
    fn reopen(self, path: &std::path::Path) -> Result<Self> {
        let Self {
            _workspace,
            snapshot,
            revisions,
            other_revision,
            clock_base,
            turns,
        } = self;
        drop(snapshot);
        drop(_workspace);
        let workspace = PreparedWorkspace::new(Database::new(path)?)?;
        let snapshot = workspace.snapshot()?;
        Ok(Self {
            _workspace: workspace,
            snapshot,
            revisions,
            other_revision,
            clock_base,
            turns,
        })
    }

    fn new_in(db: Database) -> Result<Self> {
        seed_run_and_catalog(&db)?;
        prepare_a3_scope_fixture(&db)?;
        // The target Scene gets a body, a unique story-time key and a POV
        // through the product writer, before the Revisions are approved.
        save_body(&db, SCENE, "hc1-body", "2026-10-18T00:00:00.000Z")?;
        for (index, scene) in ["a3-source", "nir1", SCENE].into_iter().enumerate() {
            patch(
                &db,
                scene,
                &format!("hc1-story-{index}"),
                "storyTimeOrder",
                json!(format!("k-{}", index + 1)),
                true,
                "2026-10-18T00:01:00.000Z",
            )?;
        }
        patch(
            &db,
            SCENE,
            "hc1-pov",
            "povCharacterId",
            json!("nir1-alice"),
            true,
            "2026-10-18T00:02:00.000Z",
        )?;
        run_incremental_freshness_cycle(&db)?;
        let mut revisions = Vec::new();
        for index in 0..2 {
            let run_id = format!("pooled-run-{index}");
            create_typed_run(&db, &run_id)?;
            let created = create_nir1_entity_relation_revision(
                &db,
                request_for_run(&db, &run_id, &format!("pooled-proposal-{index}")),
            )?;
            approve_typed_revision(&db, &run_id, &created)?;
            revisions.push(
                created["revisionId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("fixture revision ID missing"))?
                    .to_owned(),
            );
        }
        create_typed_run(&db, "hc1-other-run")?;
        let other_revision = approve_anchored(&db, OTHER_ANCHOR, "hc1-other-proposal")?;
        let workspace = PreparedWorkspace::new(db)?;
        let snapshot = workspace.snapshot()?;
        snapshot.db().db().with_conn(|conn| {
            conn.execute(
                "INSERT INTO chat_sessions(id,project_id,node_id) VALUES (?1,?2,?3)",
                params![SESSION, PROJECT, SCENE],
            )?;
            Ok(())
        })?;
        Ok(Self {
            _workspace: workspace,
            snapshot,
            revisions,
            other_revision,
            clock_base: wall_clock_ms() - 1_000_000,
            turns: 0,
        })
    }

    fn db(&self) -> &Database {
        self.snapshot.db().db()
    }

    fn owner(&self) -> Result<ChatInputCaptureOwner> {
        let locator = self.snapshot.path().to_string_lossy().into_owned();
        let authority = self.snapshot.db().identity();
        ChatInputCaptureOwner::new(
            "hc1-profile".into(),
            "hc1-caller".into(),
            1,
            1,
            locator.clone(),
            "hc1-caller-session".into(),
            format!("prepared-test:{authority}"),
            locator,
            authority,
            0,
            0,
        )
    }

    /// Accept a Human input; the session's earlier current capture becomes
    /// superseded. Returns the capture and the chat message id.
    fn accept(&self, key: &str, text: &str) -> Result<(AcceptedChatInputCapture, String)> {
        let message_id = format!("hc1-message-{key}");
        let submission = NewChatInputSubmission::new(
            format!("hc1-submission-{key}"),
            message_id.clone(),
            SESSION.into(),
            SCENE.into(),
            text.into(),
            "2026-10-18T10:00:00.000Z".into(),
        )?;
        let capture = accept_current_human_chat_input(
            &self.snapshot,
            &self.owner()?,
            &submission,
            prepared_sql_budget(),
        )?;
        Ok((capture, message_id))
    }

    fn admission() -> Nir1AdmissionSqlBudget {
        Nir1AdmissionSqlBudget::new(Arc::new(AtomicBool::new(false)), Arc::new(|| true))
            .for_untimed_test()
    }

    fn read_budget() -> ReadBudget {
        ReadBudget {
            max_references: 4_096,
            max_reference_bytes: 4 << 20,
        }
    }

    /// The qualification rows of an adopted past Human or generated output
    /// (K4/3 section 3, table): a Source reference, the Scope references of
    /// the target Scene, and the typed N/A of the other kinds. The D1
    /// reference is added by `finalize_qualifications`.
    fn history_rows(
        ordinal: usize,
        adopt: &Adopt,
        scope: &NativeNir1ScopeBinding,
    ) -> Result<Vec<QualificationReference>> {
        let (version_id, digest, decision) = match adopt {
            Adopt::Human { version_id, digest } => {
                (version_id, digest, NotApplicableReason::HumanAuthored)
            }
            Adopt::Output {
                version_id, digest, ..
            } => (version_id, digest, NotApplicableReason::DerivedFromParents),
        };
        let mut rows = vec![QualificationReference::present(
            ordinal,
            QualificationKind::Source,
            version_id.clone(),
            digest.clone(),
        )];
        add_scene_scope_references(&mut rows, ordinal, SCENE, scope)?;
        for (kind, reason) in [
            (
                QualificationKind::Revision,
                NotApplicableReason::NotARevision,
            ),
            (QualificationKind::Decision, decision),
            (
                QualificationKind::Freshness,
                NotApplicableReason::ImmutableMessageVersion,
            ),
            (
                QualificationKind::Index,
                NotApplicableReason::NotIndexDerived,
            ),
        ] {
            rows.push(QualificationReference::not_applicable(
                ordinal, kind, reason,
            ));
        }
        Ok(rows)
    }

    /// One turn with the default Revisions: accept the Human input, read
    /// D-final, adopt `adopt` as history, create, claim and (when `reply` is
    /// given) finish the attempt with that generated output.
    fn turn(&mut self, text: &str, adopt: &[Adopt], reply: Option<&str>) -> Result<Turn> {
        let mut spec = TurnSpec::new(text).adopt(adopt);
        if let Some(reply) = reply {
            spec = spec.reply(reply);
        }
        self.run_turn(spec)
    }

    fn run_turn(&mut self, spec: TurnSpec) -> Result<Turn> {
        self.turns += 1;
        let key = self.turns;
        let create_budget = spec.create_budget.unwrap_or_else(Self::read_budget);
        let (capture, human_message_id) = match spec.capture {
            Some(accepted) => accepted,
            None => self.accept(&format!("{key}"), &spec.text)?,
        };
        let revisions = spec
            .revisions
            .clone()
            .unwrap_or_else(|| self.revisions.clone());
        let purpose = match spec.purpose {
            GenerationPurpose::Writing => PackingPurpose::Writing,
            GenerationPurpose::Review => PackingPurpose::Review,
        };
        let mut projection = if spec.graph {
            self.read_graph_projection(&capture, purpose, spec.history)?
        } else {
            read_and_pack_native_nir1_prepared_inputs(
                &self.snapshot,
                purpose,
                HistorySendClassification::LocalOnly,
                spec.history,
                SESSION,
                &capture,
                SCENE,
                &revisions,
                prepared_sql_budget(),
                |_| Ok(spec.context_budget),
            )?
        };
        let human_version_id = projection.user_message_version().id.clone();
        let human_digest = projection.user_message_version().body_digest.clone();
        let scope = projection.authority_bindings()[0].scope().clone();
        for item in &spec.adopt {
            let ordinal = projection.input_references.len();
            let (role, target) = match item {
                Adopt::Human { version_id, .. } => (
                    InputRole::User,
                    InputTarget::Message {
                        version_id: version_id.clone(),
                        parent_attempt_id: None,
                    },
                ),
                Adopt::Output {
                    version_id,
                    parent_attempt_id,
                    ..
                } => (
                    InputRole::Assistant,
                    InputTarget::Message {
                        version_id: version_id.clone(),
                        parent_attempt_id: Some(parent_attempt_id.clone()),
                    },
                ),
            };
            projection.input_references.push(InputReference {
                role,
                target,
                input_use: InputUse::AdoptedHistory,
            });
            projection
                .qualifications
                .extend(Self::history_rows(ordinal, item, &scope)?);
        }
        let finalized = projection.finalize_qualifications(spec.context_budget)?;
        let draft = projection.history_draft(&finalized);
        let mut qualifications = finalized.qualifications.clone();
        if let Some(mutate) = spec.mutate {
            mutate(&mut qualifications);
        }
        let scene = self
            .snapshot
            .db()
            .with_read_transaction(|conn| read_attempt_scene_binding_in_tx(conn, PROJECT, SCENE))?;
        let created_at_ms = spec
            .created_at_ms
            .unwrap_or(self.clock_base + i64::try_from(key)? * 1_000);
        let null_slot = matches!(spec.writer, Writer::TestSupport { null_slot: true });
        let request = NewAttempt {
            binding: AttemptBinding {
                binding_version: AttemptBindingVersion::V2,
                project_id: PROJECT.into(),
                chat_session_id: SESSION.into(),
                scene,
                caller: AttemptCallerBinding {
                    profile_id: "hc1-profile".into(),
                    caller_id: "hc1-caller".into(),
                    caller_epoch: 1,
                    caller_session_id: "hc1-caller-session".into(),
                },
                workspace_binding_digest: digest_of("hc1-workspace"),
                route_revision: "route-1".into(),
                purpose: spec.purpose,
                scope_digest: digest_of("hc1-scope"),
                material_digest: digest_of("hc1-material"),
                d1_digest: finalized.d1_selection_digest.clone(),
                provider: "local".into(),
                model: "test-model".into(),
                api: "chat-completions".into(),
                endpoint_identity: digest_of("hc1-endpoint"),
                history_turn_context: (!null_slot).then_some(draft.slot),
                durable_workspace_identity: draft.durable_workspace_identity,
            },
            payload_digest: digest_of(&format!("hc1-payload-{key}")),
            inputs: projection.input_references().to_vec(),
            qualifications,
            created_at_ms,
            expires_at_ms: wall_clock_ms() + 600_000,
            budget: create_budget,
        };
        let stored = match spec.writer {
            Writer::Product => {
                // The product create decides the times itself (DI-1c): the
                // request carries a lifetime and the Scope binding and restore
                // epoch the D-final snapshot read.
                let capture_request = crate::nir1_generation::NewCaptureAttempt {
                    lifetime_ms: crate::nir1_generation::NIR1_ATTEMPT_MAX_LIFETIME_MS,
                    expected_scope: self.db().with_read_transaction(|conn| {
                        crate::nir1_generation::read_expected_scope_in_tx(conn, PROJECT, SCENE)
                    })?,
                    binding: request.binding.clone(),
                    payload_digest: request.payload_digest.clone(),
                    inputs: request.inputs.clone(),
                    qualifications: request.qualifications.clone(),
                    budget: request.budget,
                };
                create_attempt_for_capture_bounded(
                    &self.snapshot,
                    &capture,
                    &capture_request,
                    &Self::admission(),
                    &mut || Ok(()),
                )
                .map_err(|error| anyhow::anyhow!("create: {error:?}"))?
            }
            Writer::TestSupport { .. } => create_attempt(self.db(), request)?,
        };
        let expected = Nir1ExpectedAttempt::from_stored(&stored, create_budget);
        let output = match &spec.reply {
            Some(reply) => {
                match claim_attempt_bounded(
                    &self.snapshot,
                    &expected,
                    &Self::admission(),
                    &mut || Ok(()),
                )
                .map_err(|error| anyhow::anyhow!("claim: {error}"))?
                {
                    Nir1ClaimOutcome::Claimed { .. } => {}
                    other => anyhow::bail!("claim: {other:?}"),
                }
                let mut observer = OutputObserver::new();
                observer.observe(OutputChannel::Text, reply.as_bytes())?;
                observer.observe(OutputChannel::Thinking, b"")?;
                observer.observe_terminal(ProviderTerminal::Complete)?;
                let message_id = format!("hc1-reply-{key}");
                let terminal = finish_attempt_bounded(
                    &self.snapshot,
                    &expected,
                    &observer.finish(Completion::Parsed),
                    Some(NewMessageBody {
                        message_id: message_id.clone(),
                        content: reply.clone(),
                        thinking: String::new(),
                    }),
                    wall_clock_ms(),
                    &Nir1PinnedSqlBudget::new().for_untimed_test(),
                )
                .map_err(|error| anyhow::anyhow!("finish: {error}"))?;
                let version = terminal
                    .message_version
                    .ok_or_else(|| anyhow::anyhow!("the output version"))?;
                Some((message_id, version.id, version.body_digest))
            }
            None => {
                finish_pretransport_attempt_bounded(
                    &self.snapshot,
                    &expected,
                    Nir1ExpectedClaim::Unclaimed,
                    Nir1ZeroSendCompletion::DispatchFailure,
                    &Nir1PinnedSqlBudget::new().for_untimed_test(),
                )
                .map_err(|error| anyhow::anyhow!("zero-send: {error}"))?;
                None
            }
        };
        Ok(Turn {
            attempt_id: stored.id,
            capture,
            human_message_id,
            human_version_id,
            human_digest,
            output,
        })
    }

    /// D-final with the Native selection and the Graph of every relation of
    /// the Revisions the control read adopted, under B's seal.
    fn read_graph_projection(
        &self,
        capture: &AcceptedChatInputCapture,
        purpose: PackingPurpose,
        history: Option<NativeNir1HistoryRequest>,
    ) -> Result<NativeNir1PreparedInputs> {
        use super::tests::di1a_graph::{candidates_from, write_seal, GENERATION};

        write_seal(self.db(), GENERATION, false)?;
        let select = |graph: Option<&Nir1GraphCandidates>| {
            read_and_pack_native_nir1_selected_inputs(
                &self.snapshot,
                purpose,
                HistorySendClassification::LocalOnly,
                history,
                SESSION,
                capture,
                SCENE,
                graph,
                prepared_sql_budget(),
                |_| Ok(100_000),
            )
        };
        let control = select(None)?;
        let bindings = control.prepared().authority_bindings();
        let candidates = candidates_from(bindings, &vec![0u8; bindings.len()])?;
        let selected = select(Some(&candidates))?;
        ensure!(
            selected.prepared().graph_binding().is_some(),
            "the Graph reached the request"
        );
        Ok(selected.into_parts().0)
    }

    fn generous_budget() -> GenerationHistoryReadBudget {
        GenerationHistoryReadBudget {
            max_attempts: 256,
            sql: Some(GenerationHistorySqlLedger::new(
                GenerationHistorySnapshotSqlBudget {
                    max_vm_steps: 500_000_000,
                    deadline: Instant::now() + Duration::from_secs(60),
                    busy_wait: Duration::from_millis(100),
                },
            )),
            max_candidates: 256,
            max_reference_count: 100_000,
            max_reference_bytes: 64 << 20,
            max_resolved_body_bytes: 16 << 20,
            remaining_project_authority_rows: 0,
            remaining_nodes: 10_000,
            remaining_edges: 100_000,
            remaining_qualification_refs: 1_000_000,
        }
    }

    /// The history of the current turn, run in one read snapshot together
    /// with the builder that makes the current turn's context.
    fn run_purpose(
        &self,
        budget: &mut GenerationHistoryReadBudget,
        purpose: GenerationPurpose,
        now_ms: i64,
    ) -> Result<SessionHistoryOutcome> {
        self.snapshot
            .db()
            .with_participant_read_transaction_bounded(
                self.snapshot.participant(),
                prepared_sql_budget(),
                |conn| {
                    let stage = build_history_context_stage(
                        conn,
                        PROJECT,
                        SCENE,
                        self.snapshot.durable_workspace_identity(),
                        HistorySendClassification::LocalOnly,
                    )?;
                    let scene = read_attempt_scene_binding_in_tx(conn, PROJECT, SCENE)?;
                    let current = stage.current_history_context(
                        HistoryRange {
                            project_id: PROJECT.into(),
                            chat_session_id: SESSION.into(),
                            scene_id: SCENE.into(),
                            scene_incarnation_id: scene.scene_incarnation_id,
                        },
                        purpose,
                    );
                    // The history run writes nothing, whatever it decides.
                    let changes_before = conn.total_changes();
                    let outcome = run_in(conn, &current, budget, now_ms);
                    assert_eq!(
                        conn.total_changes(),
                        changes_before,
                        "the history run must not write"
                    );
                    outcome
                },
            )
    }

    fn run_with(&self, budget: &mut GenerationHistoryReadBudget) -> Result<SessionHistoryOutcome> {
        self.run_purpose(budget, GenerationPurpose::Writing, wall_clock_ms())
    }

    fn run(&self) -> Result<SessionHistoryOutcome> {
        self.run_with(&mut Self::generous_budget())
    }

    fn run_review(&self) -> Result<SessionHistoryOutcome> {
        self.run_purpose(
            &mut Self::generous_budget(),
            GenerationPurpose::Review,
            wall_clock_ms(),
        )
    }

    // ---- product writers that change the world around the session ----

    fn patch_node(&self, node: &str, tag: &str, field: &str, value: Value) -> Result<()> {
        patch(self.db(), node, tag, field, value, true, &clock_stamp())
    }

    fn create_node(
        &self,
        id: &str,
        node_type: &str,
        sort_order: &str,
        parent: Option<&str>,
    ) -> Result<()> {
        tree_node_create(
            self.db(),
            TreeNodeCreatePayload {
                id: id.into(),
                project_id: PROJECT.into(),
                request_id: format!("hc1-create-{id}"),
                session_id: "hc1-world".into(),
                event_uid: format!("hc1-create-{id}-event"),
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                undo_journal_id: None,
                parent_id: parent.map(str::to_owned),
                node_type: node_type.into(),
                title: id.into(),
                sort_order: sort_order.into(),
                synopsis: None,
                status: None,
                source_uri: None,
                source_mtime: None,
                content: (node_type == "scene").then(|| "{}".to_owned()),
                canonical_payload: None,
            },
        )?;
        Ok(())
    }

    fn delete_node(&self, id: &str) -> Result<()> {
        tree_node_delete(
            self.db(),
            TreeNodeDeletePayload {
                project_id: PROJECT.into(),
                request_id: format!("hc1-delete-{id}"),
                session_id: "hc1-world".into(),
                event_uid: format!("hc1-delete-{id}-event"),
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                undo_journal_id: None,
                node_id: id.into(),
                canonical_payload: None,
            },
        )?;
        Ok(())
    }

    /// The target Scene's explicit Scope through the Scene Scope writer: the
    /// current binding with `change` applied. This moves the Scene's Scope
    /// binding token as well as the axis the change names.
    fn update_target_scope(
        &self,
        tag: &str,
        change: impl FnOnce(&mut crate::narrative_extraction::scene_scope::NarrativeSceneScopeUpdateV1),
    ) -> Result<()> {
        use crate::narrative_extraction::scene_scope::{
            read_narrative_scene_scope, update_narrative_scene_scope,
            NarrativeSceneScopeUpdatePayload, NarrativeSceneScopeUpdateV1,
        };
        let current = self
            .db()
            .with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, SCENE))?;
        let binding = current.binding;
        let mut scope = NarrativeSceneScopeUpdateV1 {
            schema_version: 1,
            compatibility_marker: binding.compatibility_marker,
            query_identity: binding.query_identity,
            material_constraint: binding.material_constraint,
            knowledge_holder: binding.knowledge_holder,
            audience: binding.audience,
        };
        change(&mut scope);
        update_narrative_scene_scope(
            self.db(),
            NarrativeSceneScopeUpdatePayload {
                project_id: PROJECT.into(),
                scene_id: SCENE.into(),
                request_id: format!("hc1-scope-{tag}-request"),
                session_id: "hc1-scope-session".into(),
                event_uid: format!("hc1-scope-{tag}-event"),
                base_version: binding.version,
                updated_at: clock_stamp(),
                scope,
            },
        )?;
        Ok(())
    }

    fn phase_mode(&self) -> Result<Option<String>> {
        self.db().with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT phase_resolution_mode FROM projects WHERE id=?1",
                [PROJECT],
                |row| row.get(0),
            )?)
        })
    }

    fn set_phase_mode(&self, mode: Option<&str>, tag: &str) -> Result<()> {
        let base: String = self.db().with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT updated_at FROM projects WHERE id=?1",
                [PROJECT],
                |row| row.get(0),
            )?)
        })?;
        project_patch(
            self.db(),
            ProjectPatchPayload {
                project_id: PROJECT.into(),
                request_id: format!("hc1-project-{tag}"),
                session_id: "hc1-world".into(),
                event_uid: format!("hc1-project-{tag}-event"),
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                undo_journal_id: None,
                base_updated_at: base,
                updated_at: clock_stamp(),
                patch: serde_json::Map::from_iter([(
                    "phaseResolutionMode".to_owned(),
                    mode.map_or(Value::Null, |mode| Value::String(mode.to_owned())),
                )]),
            },
        )?;
        Ok(())
    }

    /// The renderer rewrites a chat message (its own write path).
    fn renderer_edit_message(&self, message_id: &str, content: &str) -> Result<()> {
        self.db().execute_renderer(
            "UPDATE chat_messages SET content = ?1 WHERE id = ?2",
            &[json!(content), json!(message_id)],
            "run",
        )?;
        Ok(())
    }

    fn sort_order_of(&self, node: &str) -> Result<String> {
        self.db().with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT sort_order FROM tree_nodes WHERE id=?1 AND project_id=?2",
                params![node, PROJECT],
                |row| row.get(0),
            )?)
        })
    }
}

/// A strictly increasing writer clock for the product writers that take one.
fn clock_stamp() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let n = NEXT.fetch_add(1, Ordering::SeqCst);
    format!(
        "2026-11-01T00:{:02}:{:02}.{:03}Z",
        (n / 60) % 60,
        n % 60,
        n % 1000
    )
}

fn run_in(
    conn: &Connection,
    current: &CurrentHistoryContext,
    budget: &mut GenerationHistoryReadBudget,
    now_ms: i64,
) -> Result<SessionHistoryOutcome> {
    let cancellation =
        GenerationHistorySnapshotCancellation::from_control(&ParticipantSqlControl::default());
    reauthorize_session_history_in_tx(
        conn,
        &cancellation,
        budget,
        &SessionHistoryRequest { current, now_ms },
        &mut || false,
    )
}

fn find<'a>(
    outcome: &'a SessionHistoryOutcome,
    kind: SessionCandidateKind,
    attempt_id: &str,
) -> &'a SessionCandidateResult {
    outcome
        .candidates
        .iter()
        .find(|result| result.kind == kind && result.attempt_id == attempt_id)
        .unwrap_or_else(|| panic!("no {kind:?} result for {attempt_id}: {outcome:#?}"))
}

fn is_qualified(
    outcome: &SessionHistoryOutcome,
    kind: SessionCandidateKind,
    attempt_id: &str,
) -> bool {
    find(outcome, kind, attempt_id).disposition == CandidateDisposition::Qualified
}

fn failure_of(
    outcome: &SessionHistoryOutcome,
    kind: SessionCandidateKind,
    attempt_id: &str,
) -> Failure {
    match &find(outcome, kind, attempt_id).disposition {
        CandidateDisposition::Excluded(failure) => failure.clone(),
        CandidateDisposition::Qualified => {
            panic!("{kind:?} of {attempt_id} was qualified: {outcome:#?}")
        }
    }
}

fn context_reason(mismatch: ContextMismatch) -> Failure {
    Failure::Ineligible(IneligibleReason::Context(mismatch))
}

fn lineage_reason(reason: HumanLineageReason) -> Failure {
    Failure::Incomplete(IncompleteReason::HumanLineage(reason))
}

fn requalification_reason(reason: RequalificationReason) -> Failure {
    Failure::Ineligible(IneligibleReason::Requalification(reason))
}

use SessionCandidateKind::{Attempt, GeneratedOutput, PastHuman};

/// A qualified candidate whose body the run could not pay for (the last
/// charge of a run is the read of an output no later attempt adopted, DI1B-2):
/// the candidate is qualified, the adoption has no body for it. That is a
/// budget cut like an exclusion, not a wrong answer.
fn has_unpaid_material(outcome: &SessionHistoryOutcome) -> bool {
    outcome.qualified().any(|result| {
        outcome
            .materials
            .get(&result.attempt_id)
            .is_none_or(|material| match result.kind {
                PastHuman => material.human.is_none(),
                GeneratedOutput => material.output.is_none(),
                Attempt => false,
            })
    })
}

/// Both candidates of the turn are adopted.
fn assert_turn_adopted(outcome: &SessionHistoryOutcome, turn: &Turn) {
    assert!(
        is_qualified(outcome, PastHuman, &turn.attempt_id),
        "the Human of {} is adopted: {outcome:#?}",
        turn.attempt_id
    );
    if turn.output.is_some() {
        assert!(
            is_qualified(outcome, GeneratedOutput, &turn.attempt_id),
            "the output of {} is adopted: {outcome:#?}",
            turn.attempt_id
        );
    }
}

// ---------------------------------------------------------------------------
// Positive
// ---------------------------------------------------------------------------

#[test]
fn positive_chain_h1_m1_h2_m2_is_adopted() -> Result<()> {
    let mut session = SessionFixture::new()?;
    // H1 -> M1, then H2 (adopting H1 and M1) -> M2.
    let first = session.turn(
        "Tell me about the harbour.",
        &[],
        Some("The harbour is quiet."),
    )?;
    let second = session.turn(
        "And the lighthouse?",
        &[Adopt::human(&first), Adopt::output(&first)],
        Some("The lighthouse is dark."),
    )?;
    // The next turn's Human is accepted: H2's capture is superseded.
    session.accept("next", "What happens next?")?;
    let outcome = session.run()?;
    assert_eq!(outcome.without_history, None, "{outcome:#?}");
    assert_turn_adopted(&outcome, &first);
    assert_turn_adopted(&outcome, &second);
    // The second turn's output depends on the first attempt too.
    let m2 = find(&outcome, GeneratedOutput, &second.attempt_id);
    assert!(m2.visited_attempts.contains(&first.attempt_id));
    // The total order: newest attempt first.
    let order: Vec<(SessionCandidateKind, &str)> = outcome
        .candidates
        .iter()
        .map(|result| (result.kind, result.attempt_id.as_str()))
        .collect();
    assert_eq!(
        order,
        vec![
            (PastHuman, second.attempt_id.as_str()),
            (GeneratedOutput, second.attempt_id.as_str()),
            (PastHuman, first.attempt_id.as_str()),
            (GeneratedOutput, first.attempt_id.as_str()),
        ]
    );
    // Two Revisions, one A3 evaluation each, for the whole session.
    assert_eq!(outcome.a3_evaluations, 2);
    Ok(())
}

#[test]
fn positive_resend_after_failed_turn_adopts_h1prime_and_m2() -> Result<()> {
    // A1 ends without an output; the same sentence is sent again.
    for (edit_between, name) in [(false, "no edit"), (true, "a Scope edit")] {
        let mut session = SessionFixture::new()?;
        let a1 = session.turn("Describe the sea.", &[], None)?;
        if edit_between {
            // A Scope edit of the target Scene (its reading position) advances
            // the Scope binding token; the axes stay the same.
            let moved = format!("{}x", session.sort_order_of(SCENE)?);
            session.patch_node(SCENE, "hc1-resend-move", "sortOrder", json!(moved))?;
        }
        let a2 = session.turn("Describe the sea.", &[], Some("Blue."))?;
        session.accept("next", "And the sky?")?;
        let outcome = session.run()?;
        assert_eq!(outcome.without_history, None, "{name}");
        // A2 holds H1' at ordinal 0 and its output M2 is adopted either way.
        assert_turn_adopted(&outcome, &a2);
        // H1 is judged by A1's context: it stays with no edit and goes with
        // one. A1 has no output, so it has no output candidate.
        if edit_between {
            assert_eq!(
                failure_of(&outcome, PastHuman, &a1.attempt_id),
                context_reason(ContextMismatch::ScopeBindingTokenChanged),
                "{name}"
            );
        } else {
            assert!(is_qualified(&outcome, PastHuman, &a1.attempt_id), "{name}");
        }
        assert!(
            !outcome
                .candidates
                .iter()
                .any(|result| result.kind == GeneratedOutput && result.attempt_id == a1.attempt_id),
            "{name}: a failed attempt has no output"
        );
    }
    Ok(())
}

#[test]
fn positive_user_cancelled_turn_human_is_excluded_by_capture_state() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let earlier = session.turn("An earlier request.", &[], Some("An earlier answer."))?;
    let cancelled = session.turn("A request that is taken back.", &[], Some("An answer."))?;
    // The user cancels the turn: the capture is still the session's current
    // one, and its state becomes cancelled.
    cancel_current_human_chat_input(
        &session.snapshot,
        &cancelled.capture,
        &session.owner()?,
        prepared_sql_budget(),
    )?;
    session.accept("next", "A new request.")?;
    let outcome = session.run()?;
    assert_turn_adopted(&outcome, &earlier);
    let expected = lineage_reason(HumanLineageReason::CaptureNotSuperseded(
        crate::nir1_generation_history::HistoryCaptureState::Cancelled,
    ));
    assert_eq!(
        failure_of(&outcome, PastHuman, &cancelled.attempt_id),
        expected
    );
    // The output of a turn whose capture was cancelled after it succeeded is
    // not adopted either (its parent's Human fails the same rule).
    assert_eq!(
        failure_of(&outcome, GeneratedOutput, &cancelled.attempt_id),
        expected
    );
    Ok(())
}

#[test]
fn positive_non_user_cancel_human_is_judged_by_rules_1_to_4() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let turn = session.turn("A request whose window closed.", &[], Some("An answer."))?;
    // The capture is still current (the stop was not the user's): rule 2.
    let outcome = session.run()?;
    let current = lineage_reason(HumanLineageReason::CaptureNotSuperseded(
        crate::nir1_generation_history::HistoryCaptureState::Current,
    ));
    assert_eq!(failure_of(&outcome, PastHuman, &turn.attempt_id), current);
    assert_eq!(
        failure_of(&outcome, GeneratedOutput, &turn.attempt_id),
        current
    );
    // A new user row supersedes it, and rules 1 to 4 then hold.
    session.accept("next", "The next request.")?;
    let outcome = session.run()?;
    assert_turn_adopted(&outcome, &turn);
    Ok(())
}

#[test]
fn positive_writes_to_other_scenes_keep_history() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let first = session.turn("First request.", &[], Some("First answer."))?;
    let second = session.turn(
        "Second request.",
        &[Adopt::human(&first), Adopt::output(&first)],
        Some("Second answer."),
    )?;
    session.accept("next", "Third request.")?;
    // Writes to Scenes other than the target: bodies, titles, synopses,
    // status, labels, and the creation, renaming and deletion of an empty
    // folder.
    save_body(session.db(), "a3-source", "hc1-other-body", &clock_stamp())?;
    save_body(session.db(), ANCHOR, "hc1-anchor-body", &clock_stamp())?;
    for (tag, field, value) in [
        ("title", "title", json!("Retitled")),
        ("synopsis", "synopsis", json!("Synopsis only")),
        ("status", "status", json!("revision")),
        ("label", "storyTimeLabel", json!("Display label")),
    ] {
        session.patch_node("a3-source", tag, field, value.clone())?;
        session.patch_node(ANCHOR, &format!("anchor-{tag}"), field, value)?;
    }
    session.create_node("hc1-empty-folder", "folder", "z0", None)?;
    session.patch_node(
        "hc1-empty-folder",
        "folder-title",
        "title",
        json!("Renamed"),
    )?;
    session.delete_node("hc1-empty-folder")?;
    run_incremental_freshness_cycle(session.db())?;
    let outcome = session.run()?;
    assert_eq!(outcome.without_history, None);
    assert_turn_adopted(&outcome, &first);
    assert_turn_adopted(&outcome, &second);
    // The next turn can be prepared and recorded without approving anything
    // again, and the history is still adopted for the turn after it.
    let third = session.turn(
        "Third request.",
        &[Adopt::output(&second)],
        Some("Third answer."),
    )?;
    session.accept("after", "Fourth request.")?;
    let outcome = session.run()?;
    assert_turn_adopted(&outcome, &third);
    assert_turn_adopted(&outcome, &second);
    Ok(())
}

#[test]
fn positive_independent_branches_and_long_chain_survive_one_bad_branch() -> Result<()> {
    let mut session = SessionFixture::new()?;
    // A long chain: each turn adopts the previous turn's Human and output.
    let mut turns: Vec<Turn> = Vec::new();
    for index in 0..6 {
        let adopt: Vec<Adopt> = turns
            .last()
            .map(|previous| vec![Adopt::human(previous), Adopt::output(previous)])
            .unwrap_or_default();
        let reply = format!("answer {index}");
        let turn = session.turn(&format!("request {index}"), &adopt, Some(&reply))?;
        turns.push(turn);
    }
    session.accept("next", "request next")?;
    let outcome = session.run()?;
    for turn in &turns {
        assert_turn_adopted(&outcome, turn);
    }
    // One bad branch: the renderer rewrites the Human of the third turn. That
    // turn and every turn that adopted it are out; the turns before it are
    // independent of it and stay.
    session.renderer_edit_message(&turns[2].human_message_id, "rewritten by the renderer")?;
    let outcome = session.run()?;
    for turn in &turns[..2] {
        assert_turn_adopted(&outcome, turn);
    }
    assert_eq!(
        failure_of(&outcome, PastHuman, &turns[2].attempt_id),
        lineage_reason(HumanLineageReason::MessageVersionInvalidated)
    );
    // The outputs from the third turn on depend on the rewritten Human
    // (through their own turn's Human or an adopted copy of it).
    for turn in &turns[2..] {
        assert!(
            !is_qualified(&outcome, GeneratedOutput, &turn.attempt_id),
            "the output of {} depends on the rewritten Human",
            turn.attempt_id
        );
    }
    Ok(())
}

#[test]
fn positive_shared_ancestor_is_verified_once_and_diamond_fanout_fit_the_budget() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let t1 = session.turn("one", &[], Some("answer one"))?;
    // Fan-out: two turns adopt the same ancestor.
    let t2 = session.turn(
        "two",
        &[Adopt::human(&t1), Adopt::output(&t1)],
        Some("answer two"),
    )?;
    let t3 = session.turn("three", &[Adopt::output(&t1)], Some("answer three"))?;
    // Diamond: one turn adopts both branches.
    let t4 = session.turn(
        "four",
        &[Adopt::output(&t2), Adopt::output(&t3)],
        Some("answer four"),
    )?;
    session.accept("next", "five")?;
    let mut budget = SessionFixture::generous_budget();
    let before_nodes = budget.remaining_nodes;
    let outcome = session.run_with(&mut budget)?;
    for turn in [&t1, &t2, &t3, &t4] {
        assert_turn_adopted(&outcome, turn);
    }
    // Four distinct attempts, each header verified once whatever the number
    // of paths that reach it (t1 is reached from t2, t3 and, through them,
    // from t4).
    assert_eq!(before_nodes - budget.remaining_nodes, 4);
    // One A3 evaluation per (Revision, target Scene) for the whole turn.
    assert_eq!(outcome.a3_evaluations, 2);
    let m4 = find(&outcome, GeneratedOutput, &t4.attempt_id);
    for ancestor in [&t1, &t2, &t3, &t4] {
        assert!(m4.visited_attempts.contains(&ancestor.attempt_id));
    }
    Ok(())
}

#[test]
fn positive_review_turn_uses_only_review_history() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let writing = session.turn("A drafting request.", &[], Some("A draft."))?;
    let review = {
        let spec = TurnSpec::new("A review request.")
            .reply("A review.")
            .purpose(GenerationPurpose::Review);
        session.run_turn(spec)?
    };
    session.accept("next", "next")?;
    // A writing turn uses the writing history only.
    let outcome = session.run()?;
    assert_turn_adopted(&outcome, &writing);
    assert_eq!(
        failure_of(&outcome, PastHuman, &review.attempt_id),
        context_reason(ContextMismatch::PurposeMismatch)
    );
    assert_eq!(
        failure_of(&outcome, GeneratedOutput, &review.attempt_id),
        context_reason(ContextMismatch::PurposeMismatch)
    );
    // A review turn uses the review history only.
    let outcome = session.run_review()?;
    assert_turn_adopted(&outcome, &review);
    assert_eq!(
        failure_of(&outcome, PastHuman, &writing.attempt_id),
        context_reason(ContextMismatch::PurposeMismatch)
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Negative: the turn's context (K4/3 section 4)
// ---------------------------------------------------------------------------

/// One session with a successful turn whose next Human is already accepted,
/// so that the turn's Human and output are judged by the context alone.
fn settled_session() -> Result<(SessionFixture, Turn)> {
    let mut session = SessionFixture::new()?;
    let turn = session.turn("A request.", &[], Some("An answer."))?;
    session.accept("next", "The next request.")?;
    Ok((session, turn))
}

fn assert_turn_excluded_with(
    outcome: &SessionHistoryOutcome,
    turn: &Turn,
    expected: &Failure,
    context: &str,
) {
    assert_eq!(
        &failure_of(outcome, PastHuman, &turn.attempt_id),
        expected,
        "{context}: the Human"
    );
    assert_eq!(
        &failure_of(outcome, GeneratedOutput, &turn.attempt_id),
        expected,
        "{context}: the output"
    );
}

#[test]
fn negative_each_axis_and_auto_change() -> Result<()> {
    type Change = fn(&SessionFixture) -> Result<()>;
    type Restore = fn(&SessionFixture, Option<String>) -> Result<()>;
    // The change, how it is undone, and what the undo leaves behind: a value
    // that is monotone (the Scope binding's token) never comes back; the
    // project's resolution mode, not a Scope write, is compared by value.
    let cases: [(&str, HistoryAxisName, Change, Restore, bool); 3] = [
        (
            "story time",
            HistoryAxisName::StoryTime,
            |s| s.patch_node(SCENE, "axis-story", "storyTimeOrder", json!("k-3b")),
            |s, _| s.patch_node(SCENE, "axis-story-back", "storyTimeOrder", json!("k-3")),
            false,
        ),
        (
            "viewpoint",
            HistoryAxisName::Viewpoint,
            |s| s.patch_node(SCENE, "axis-pov", "povCharacterId", json!("nir1-bob")),
            |s, _| {
                s.patch_node(
                    SCENE,
                    "axis-pov-back",
                    "povCharacterId",
                    json!("nir1-alice"),
                )
            },
            false,
        ),
        (
            "auto",
            HistoryAxisName::Auto,
            |s| s.set_phase_mode(Some("reading"), "axis-auto"),
            |s, original| s.set_phase_mode(original.as_deref(), "axis-auto-back"),
            true,
        ),
    ];
    for (name, axis, change, restore, returns) in cases {
        let (session, turn) = settled_session()?;
        let original_mode = session.phase_mode()?;
        change(&session)?;
        let outcome = session.run()?;
        assert_eq!(outcome.without_history, None, "{name}");
        assert_turn_excluded_with(
            &outcome,
            &turn,
            &context_reason(ContextMismatch::AxisChanged(axis)),
            name,
        );
        restore(&session, original_mode)?;
        let outcome = session.run()?;
        if returns {
            // Not a Scope write: the axis is equal again and so is the context.
            assert_turn_adopted(&outcome, &turn);
        } else {
            // A write to the target's own Scope advanced its binding's token,
            // which never returns to the recorded value (K4/3 section 4).
            assert_turn_excluded_with(
                &outcome,
                &turn,
                &context_reason(ContextMismatch::ScopeBindingTokenChanged),
                name,
            );
        }
    }
    Ok(())
}

#[test]
fn negative_scene_scope_axes_change_through_the_scene_scope_writer() -> Result<()> {
    use crate::narrative_extraction::scene_scope::NarrativeSceneScopeUpdateV1;
    use grimodex_core::narrative_scene_scope::{
        NarrativeScopeConstraintV1, NarrativeScopePrincipalV1,
    };
    type Change = fn(&mut NarrativeSceneScopeUpdateV1);
    // Each case writes one part of the target Scene's explicit Scope. The axis
    // it names is reported on its own (the axes are compared before the
    // Scope binding's token, which moves with every one of these writes).
    let cases: [(&str, HistoryAxisName, Change); 5] = [
        (
            "knowledge holder",
            HistoryAxisName::KnowledgeHolder,
            |scope| {
                scope.knowledge_holder = NarrativeScopePrincipalV1::Character {
                    reference: "nir1-bob".into(),
                };
            },
        ),
        ("audience", HistoryAxisName::Audience, |scope| {
            scope.audience = NarrativeScopePrincipalV1::Character {
                reference: "nir1-bob".into(),
            };
        }),
        ("timeline", HistoryAxisName::Timeline, |scope| {
            scope.query_identity.timeline = NarrativeScopeConstraintV1::Exact {
                reference: "timeline:other".into(),
            };
        }),
        ("worldline", HistoryAxisName::Worldline, |scope| {
            scope.query_identity.worldline = NarrativeScopeConstraintV1::Exact {
                reference: "worldline:other".into(),
            };
        }),
        (
            "narrative layer",
            HistoryAxisName::NarrativeLayer,
            |scope| {
                scope.query_identity.narrative_layer = NarrativeScopeConstraintV1::Exact {
                    reference: "layer:other".into(),
                };
            },
        ),
    ];
    for (name, axis, change) in cases {
        let (session, turn) = settled_session()?;
        session.update_target_scope(name.replace(' ', "-").as_str(), change)?;
        let outcome = session.run()?;
        assert_eq!(outcome.without_history, None, "{name}");
        assert_turn_excluded_with(
            &outcome,
            &turn,
            &context_reason(ContextMismatch::AxisChanged(axis)),
            name,
        );
    }
    Ok(())
}

#[test]
fn negative_reading_order_changes_by_insert_delete_reorder_archive_unarchive_before_target(
) -> Result<()> {
    let reading = context_reason(ContextMismatch::AxisChanged(HistoryAxisName::ReadingOrder));
    // Insert a Scene before the target.
    {
        let (session, turn) = settled_session()?;
        session.create_node("hc1-before", "scene", "0", None)?;
        let outcome = session.run()?;
        assert_turn_excluded_with(&outcome, &turn, &reading, "insert");
    }
    // Delete a Scene before the target.
    {
        let (session, turn) = settled_session()?;
        session.delete_node(OTHER_ANCHOR)?;
        let outcome = session.run()?;
        assert_turn_excluded_with(&outcome, &turn, &reading, "delete");
    }
    // Reorder: a Scene that was before the target moves after it.
    {
        let (session, turn) = settled_session()?;
        session.patch_node(OTHER_ANCHOR, "hc1-reorder", "sortOrder", json!("a9"))?;
        let outcome = session.run()?;
        assert_turn_excluded_with(&outcome, &turn, &reading, "reorder");
    }
    // Archive and unarchive a Scene before the target.
    {
        let (session, turn) = settled_session()?;
        session.patch_node(
            OTHER_ANCHOR,
            "hc1-archive",
            "archivedAt",
            json!("2026-11-02T00:00:00.000Z"),
        )?;
        let outcome = session.run()?;
        assert_turn_excluded_with(&outcome, &turn, &reading, "archive");
        session.patch_node(OTHER_ANCHOR, "hc1-unarchive", "archivedAt", Value::Null)?;
        let outcome = session.run()?;
        // (b) The rank is back, and the Human is a candidate again; the
        // output too, as the archived Scene anchors none of its Revisions.
        assert_turn_adopted(&outcome, &turn);
    }
    Ok(())
}

#[test]
fn return_to_original_inserted_scene_and_its_undo() -> Result<()> {
    // (a) A Scene is inserted before the target; the next turn is made after
    // it; the insertion is undone.
    let mut session = SessionFixture::new()?;
    let before = session.turn("A request before the insertion.", &[], Some("Answer one."))?;
    session.create_node("hc1-before", "scene", "0", None)?;
    let after = session.turn("A request after the insertion.", &[], Some("Answer two."))?;
    session.accept("next", "The next request.")?;
    let outcome = session.run()?;
    assert_turn_excluded_with(
        &outcome,
        &before,
        &context_reason(ContextMismatch::AxisChanged(HistoryAxisName::ReadingOrder)),
        "inserted",
    );
    assert_turn_adopted(&outcome, &after);
    session.delete_node("hc1-before")?;
    let outcome = session.run()?;
    // The input made before the insertion is a candidate again; the one made
    // after it recorded the other position and is out.
    assert_turn_adopted(&outcome, &before);
    assert_turn_excluded_with(
        &outcome,
        &after,
        &context_reason(ContextMismatch::AxisChanged(HistoryAxisName::ReadingOrder)),
        "undone",
    );
    Ok(())
}

#[test]
fn return_to_original_archiving_the_anchor_never_restores_its_revisions() -> Result<()> {
    // (b) The anchor of the Revisions is archived and unarchived. The rank
    // comes back, the Human is a candidate again, but the Revisions of that
    // anchor stay retired, and so does every output that holds them.
    let (session, turn) = settled_session()?;
    session.patch_node(
        ANCHOR,
        "hc1-anchor-archive",
        "archivedAt",
        json!("2026-11-02T00:00:00.000Z"),
    )?;
    session.patch_node(ANCHOR, "hc1-anchor-unarchive", "archivedAt", Value::Null)?;
    run_incremental_freshness_cycle(session.db())?;
    let outcome = session.run()?;
    assert!(is_qualified(&outcome, PastHuman, &turn.attempt_id));
    assert_eq!(
        failure_of(&outcome, GeneratedOutput, &turn.attempt_id),
        requalification_reason(RequalificationReason::SourceStale)
    );
    Ok(())
}

#[test]
fn negative_scope_binding_token_changes() -> Result<()> {
    let token = context_reason(ContextMismatch::ScopeBindingTokenChanged);
    // The target's reading position changes without changing its rank.
    {
        let (session, turn) = settled_session()?;
        let moved = format!("{}x", session.sort_order_of(SCENE)?);
        session.patch_node(SCENE, "hc1-token-sort", "sortOrder", json!(moved))?;
        let outcome = session.run()?;
        assert_turn_excluded_with(&outcome, &turn, &token, "sort order");
    }
    // The target moves into a chapter at the same reading position.
    {
        let (session, turn) = settled_session()?;
        session.create_node("hc1-chapter", "folder", "a15", None)?;
        session.patch_node(SCENE, "hc1-token-parent", "parentId", json!("hc1-chapter"))?;
        let outcome = session.run()?;
        assert_turn_excluded_with(&outcome, &turn, &token, "parent change");
    }
    Ok(())
}

#[test]
fn target_body_and_display_writes_keep_history() -> Result<()> {
    // Q8 (a), (b), (d): a body save, a title, a synopsis, a status and a
    // label of the target Scene itself neither retire a generated output nor
    // a Human.
    let (session, turn) = settled_session()?;
    save_body(session.db(), SCENE, "hc1-new-target-body", &clock_stamp())?;
    for (tag, field, value) in [
        ("title", "title", json!("Retitled target")),
        ("synopsis", "synopsis", json!("A synopsis")),
        ("status", "status", json!("revision")),
        ("label", "storyTimeLabel", json!("A label")),
    ] {
        session.patch_node(SCENE, &format!("target-{tag}"), field, value)?;
    }
    run_incremental_freshness_cycle(session.db())?;
    let outcome = session.run()?;
    assert_turn_adopted(&outcome, &turn);
    Ok(())
}

#[test]
fn negative_story_time_and_viewpoint_unavailable_cases() -> Result<()> {
    let unavailable =
        |axis| NoHistory::CurrentContextUnavailable(CurrentContextUnavailable::Axis(axis));
    // NULL story-time key.
    {
        let (session, _turn) = settled_session()?;
        session.patch_node(SCENE, "hc1-null-key", "storyTimeOrder", Value::Null)?;
        let outcome = session.run()?;
        assert_eq!(
            outcome.without_history,
            Some(unavailable(HistoryAxisName::StoryTime))
        );
        assert!(outcome.candidates.is_empty());
    }
    // A key that another Scene of the project also holds is ambiguous.
    {
        let (session, _turn) = settled_session()?;
        session.patch_node(OTHER_ANCHOR, "hc1-dup-key", "storyTimeOrder", json!("k-3"))?;
        let outcome = session.run()?;
        assert_eq!(
            outcome.without_history,
            Some(unavailable(HistoryAxisName::StoryTime))
        );
    }
    // No point of view.
    {
        let (session, _turn) = settled_session()?;
        session.patch_node(SCENE, "hc1-no-pov", "povCharacterId", Value::Null)?;
        let outcome = session.run()?;
        assert_eq!(
            outcome.without_history,
            Some(unavailable(HistoryAxisName::Viewpoint))
        );
    }
    Ok(())
}

#[test]
fn archived_ancestor_folder_leaves_no_history_and_unarchive_does_not_bring_it_back() -> Result<()> {
    let mut session = SessionFixture::new()?;
    // The target sits in a chapter, at its reading position.
    session.create_node("hc1-chapter", "folder", "a15", None)?;
    session.patch_node(SCENE, "hc1-into-chapter", "parentId", json!("hc1-chapter"))?;
    let turn = session.turn("A request.", &[], Some("An answer."))?;
    session.accept("next", "next")?;
    assert_turn_adopted(&session.run()?, &turn);
    session.patch_node(
        "hc1-chapter",
        "hc1-chapter-archive",
        "archivedAt",
        json!("2026-11-02T00:00:00.000Z"),
    )?;
    // The target is not in the reading mapping: no history in this turn
    // (the turn itself goes on).
    let outcome = session.run()?;
    assert_eq!(
        outcome.without_history,
        Some(NoHistory::CurrentContextUnavailable(
            CurrentContextUnavailable::Axis(HistoryAxisName::ReadingOrder)
        ))
    );
    assert!(outcome.candidates.is_empty());
    session.patch_node(
        "hc1-chapter",
        "hc1-chapter-unarchive",
        "archivedAt",
        Value::Null,
    )?;
    // Unarchiving advanced the Scope binding of what lies under the chapter:
    // the history from before the archive does not come back.
    let outcome = session.run()?;
    assert_turn_excluded_with(
        &outcome,
        &turn,
        &context_reason(ContextMismatch::ScopeBindingTokenChanged),
        "unarchive",
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Negative: capture and attempt lineage (K4/3 section 6)
// ---------------------------------------------------------------------------

#[test]
fn negative_capture_and_attempt_lineage() -> Result<()> {
    // Two attempts hold one Human at ordinal 0 (a shape only the test-support
    // writer makes): the Human is no candidate, and neither is an output of an
    // attempt whose current-turn Human it is, nor a turn that adopted it.
    let mut session = SessionFixture::new()?;
    let first = session.turn("A request.", &[], Some("An answer."))?;
    let duplicate = session.run_turn(
        TurnSpec::new("duplicate")
            .capture(first.capture.clone(), first.human_message_id.clone())
            .writer(Writer::TestSupport { null_slot: false }),
    )?;
    let adopter = session.turn(
        "A request that adopts the first.",
        &[Adopt::human(&first), Adopt::output(&first)],
        Some("Another answer."),
    )?;
    session.accept("next", "next")?;
    let outcome = session.run()?;
    let multiple = lineage_reason(HumanLineageReason::MultipleOrdinalZeroAttempts);
    for attempt in [&first.attempt_id, &duplicate.attempt_id] {
        assert_eq!(failure_of(&outcome, PastHuman, attempt), multiple);
    }
    assert_eq!(
        failure_of(&outcome, GeneratedOutput, &first.attempt_id),
        multiple
    );
    // The adopter itself is a fine turn, but what it adopted is not: its
    // output is out with the same reason, its own Human stays.
    assert!(is_qualified(&outcome, PastHuman, &adopter.attempt_id));
    assert_eq!(
        failure_of(&outcome, GeneratedOutput, &adopter.attempt_id),
        multiple
    );
    Ok(())
}

#[test]
fn negative_human_without_an_attempt_is_not_a_candidate() -> Result<()> {
    let mut session = SessionFixture::new()?;
    // A Human whose turn stopped before any attempt was made.
    let (orphan, _message_id) =
        session.accept("orphan", "A request that never became an attempt.")?;
    let orphan_digest: String = session.db().with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT body_digest FROM nir1_generation_message_versions WHERE id=?1",
            [orphan.message_version_id()],
            |row| row.get(0),
        )?)
    })?;
    let adopter = session.turn(
        "A request that adopts the orphan.",
        &[Adopt::Human {
            version_id: orphan.message_version_id().to_owned(),
            digest: orphan_digest,
        }],
        Some("An answer."),
    )?;
    session.accept("next", "next")?;
    let outcome = session.run()?;
    // No attempt, so no candidate of its own; and the turn that adopted it
    // cannot use it.
    assert!(is_qualified(&outcome, PastHuman, &adopter.attempt_id));
    assert_eq!(
        failure_of(&outcome, GeneratedOutput, &adopter.attempt_id),
        lineage_reason(HumanLineageReason::NoOrdinalZeroAttempt)
    );
    Ok(())
}

#[test]
fn negative_renderer_writes_to_messages_and_sessions() -> Result<()> {
    // A rewritten Human (the renderer edits the user row): the version is
    // invalidated by the existing trigger.
    {
        let (session, turn) = settled_session()?;
        session.renderer_edit_message(&turn.human_message_id, "rewritten")?;
        let outcome = session.run()?;
        let invalidated = lineage_reason(HumanLineageReason::MessageVersionInvalidated);
        assert_eq!(
            failure_of(&outcome, PastHuman, &turn.attempt_id),
            invalidated
        );
        assert_eq!(
            failure_of(&outcome, GeneratedOutput, &turn.attempt_id),
            invalidated
        );
        // (c) Writing the original text back does not bring the version back.
        session.renderer_edit_message(&turn.human_message_id, "A request.")?;
        let outcome = session.run()?;
        assert_eq!(
            failure_of(&outcome, PastHuman, &turn.attempt_id),
            invalidated
        );
    }
    // A rewritten generated output: the receipt of its attempt names a version
    // that is no longer live, so the attempt cannot be read at all and is out
    // as a whole; a turn that adopted the output is out for the version; the
    // Human of the turn that adopted it, which does not depend on it, stays.
    {
        let mut session = SessionFixture::new()?;
        let first = session.turn("First.", &[], Some("First answer."))?;
        let second = session.turn("Second.", &[Adopt::output(&first)], Some("Second answer."))?;
        session.accept("next", "next")?;
        let (reply_message_id, _, _) = first.output.clone().expect("output");
        session.renderer_edit_message(&reply_message_id, "an edited answer")?;
        let outcome = session.run()?;
        assert_eq!(
            failure_of(&outcome, Attempt, &first.attempt_id),
            Failure::Incomplete(IncompleteReason::MissingAttempt(first.attempt_id.clone()))
        );
        assert_eq!(
            failure_of(&outcome, GeneratedOutput, &second.attempt_id),
            requalification_reason(RequalificationReason::MessageVersionInvalid)
        );
        assert!(is_qualified(&outcome, PastHuman, &second.attempt_id));
    }
    // The session is deleted and created again under the same ID: the old
    // attempts are listed by the session column, but their messages are
    // invalidated and their captures are gone. A turn that did not succeed
    // shows the Human's own reason.
    {
        let mut session = SessionFixture::new()?;
        let failed = session.turn("A request that failed.", &[], None)?;
        let succeeded = session.turn("A request that succeeded.", &[], Some("An answer."))?;
        session.accept("next", "next")?;
        session.db().with_conn(|conn| {
            conn.execute("DELETE FROM chat_sessions WHERE id = ?1", [SESSION])?;
            conn.execute(
                "INSERT INTO chat_sessions(id,project_id,node_id) VALUES (?1,?2,?3)",
                params![SESSION, PROJECT, SCENE],
            )?;
            Ok(())
        })?;
        let outcome = session.run()?;
        assert_eq!(
            failure_of(&outcome, PastHuman, &failed.attempt_id),
            lineage_reason(HumanLineageReason::MessageVersionInvalidated)
        );
        assert_eq!(
            failure_of(&outcome, Attempt, &succeeded.attempt_id),
            Failure::Incomplete(IncompleteReason::MissingAttempt(
                succeeded.attempt_id.clone()
            ))
        );
    }
    Ok(())
}

#[test]
fn negative_context_less_and_legacy_rows_do_not_stop_the_turn() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let good = session.turn("A good request.", &[], Some("A good answer."))?;
    // An attempt made without a history slot (a build that never recorded
    // one) and a legacy (version 1) row, in the same session.
    let context_less = session.run_turn(
        TurnSpec::new("A request whose attempt has no context.")
            .reply("An answer nobody can use.")
            .writer(Writer::TestSupport { null_slot: true }),
    )?;
    let legacy = session.turn("A legacy request.", &[], Some("A legacy answer."))?;
    let legacy_binding = json!({
        "projectId": PROJECT,
        "sessionId": SESSION,
        "profileId": "hc1-profile",
        "callerId": "hc1-caller",
        "callerEpoch": 1,
        "workspaceBindingDigest": digest_of("hc1-workspace"),
        "purpose": GenerationPurpose::Writing,
        "scopeDigest": digest_of("hc1-scope"),
        "materialDigest": digest_of("hc1-material"),
        "d1Digest": digest_of("hc1-d1"),
        "routeRevision": "route-1",
        "provider": "local",
        "model": "test-model",
        "api": "chat-completions",
        "endpointIdentity": digest_of("hc1-endpoint"),
    });
    session.db().with_conn(|conn| {
        conn.execute(
            "UPDATE nir1_generation_attempts SET binding_json = ?2 WHERE id = ?1",
            params![
                legacy.attempt_id,
                grimodex_core::canonical_json_string(&legacy_binding)?
            ],
        )?;
        Ok(())
    })?;
    session.accept("next", "next")?;
    let outcome = session.run()?;
    assert_eq!(outcome.without_history, None);
    assert_turn_adopted(&outcome, &good);
    for (attempt, reason) in [
        (&context_less.attempt_id, HistoryContextGateReason::Missing),
        (&legacy.attempt_id, HistoryContextGateReason::LegacyBinding),
    ] {
        assert_eq!(
            failure_of(&outcome, Attempt, attempt),
            Failure::Incomplete(IncompleteReason::HistoryContextUnusable(reason)),
            "{attempt}"
        );
    }
    Ok(())
}

#[test]
fn a_row_of_an_unknown_binding_version_makes_the_exactly_one_rule_unprovable() -> Result<()> {
    // The reference rows of such a row are of a format this build cannot
    // read, so it cannot be told whether the row holds a Human at ordinal 0:
    // no past Human of the session is a candidate (fail closed), and the turn
    // goes on (DR-HC1-2b).
    let mut session = SessionFixture::new()?;
    let good = session.turn("A good request.", &[], Some("A good answer."))?;
    let unknown = session.turn("A future request.", &[], None)?;
    let stored = read_attempt(
        session.db(),
        &unknown.attempt_id,
        SessionFixture::read_budget(),
    )?;
    let mut future = serde_json::to_value(&stored.binding)?;
    future["bindingVersion"] = json!(3);
    session.db().with_conn(|conn| {
        conn.execute(
            "UPDATE nir1_generation_attempts SET binding_json = ?2 WHERE id = ?1",
            params![
                unknown.attempt_id,
                grimodex_core::canonical_json_string(&future)?
            ],
        )?;
        Ok(())
    })?;
    session.accept("next", "next")?;
    let outcome = session.run()?;
    assert_eq!(outcome.without_history, None);
    assert_eq!(
        failure_of(&outcome, Attempt, &unknown.attempt_id),
        Failure::Incomplete(IncompleteReason::HistoryContextUnusable(
            HistoryContextGateReason::UnsupportedBindingVersion
        ))
    );
    assert_turn_excluded_with(
        &outcome,
        &good,
        &lineage_reason(HumanLineageReason::OrdinalZeroUncountable),
        "unknown version in the session",
    );
    Ok(())
}

#[test]
fn no_repair_a_context_less_attempts_human_is_never_promoted() -> Result<()> {
    let mut session = SessionFixture::new()?;
    // The attempt of this Human has no history slot. It is the only attempt
    // that holds the Human, and a later turn adopts the Human: the Human is
    // not repaired into a candidate, and the turn that adopted it loses the
    // output for the attempt's closed reason.
    let context_less = session.run_turn(
        TurnSpec::new("A request whose attempt has no context.")
            .writer(Writer::TestSupport { null_slot: true }),
    )?;
    let adopter = session.turn(
        "A request that adopts it.",
        &[Adopt::human(&context_less)],
        Some("An answer."),
    )?;
    session.accept("next", "next")?;
    let outcome = session.run()?;
    assert_eq!(
        failure_of(&outcome, Attempt, &context_less.attempt_id),
        Failure::Incomplete(IncompleteReason::HistoryContextUnusable(
            HistoryContextGateReason::Missing
        ))
    );
    assert!(is_qualified(&outcome, PastHuman, &adopter.attempt_id));
    assert_eq!(
        failure_of(&outcome, GeneratedOutput, &adopter.attempt_id),
        Failure::Incomplete(IncompleteReason::HistoryContextUnusable(
            HistoryContextGateReason::Missing
        ))
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Negative: the references of an input (K4/3 sections 3 and 13)
// ---------------------------------------------------------------------------

#[test]
fn negative_dependency_changes_retire_only_what_holds_the_dependency() -> Result<()> {
    use crate::domain_writes::{
        apply_codex_rename, CodexRenameApplyPayload, CodexRenameUndoUpdate,
    };

    let mut session = SessionFixture::new()?;
    let held = session.turn("Holds the Revisions.", &[], Some("An answer."))?;
    let entry_version: i64 = session.db().with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT version FROM codex_entries WHERE id = 'nir1-bob'",
            [],
            |row| row.get(0),
        )?)
    })?;
    session.accept("next", "next")?;
    // A Codex edit of an Entity both Revisions name changes a Source of the
    // Revisions: the output that holds them is out, the Human is not.
    apply_codex_rename(
        session.db(),
        CodexRenameApplyPayload {
            request_id: "hc1-dep-rename-request".into(),
            project_id: PROJECT.into(),
            session_id: "hc1-dep-rename-session".into(),
            surface: Some("hc1".into()),
            entry_id: "nir1-bob".into(),
            updated_at: "2026-11-03T00:00:00.000Z".into(),
            updates: vec![CodexRenameUndoUpdate {
                kind: "codex-summary".into(),
                ref_id: "nir1-bob".into(),
                detail_definition_id: None,
                base_version: entry_version,
                value: "Robert".into(),
                char_count: None,
                placed_beat_preview: None,
            }],
            event_summary: "{}".into(),
            event_uid: "hc1-dep-rename-event".into(),
            timestamp: 1,
            redo: false,
            original_transaction_id: None,
            undo_journal_id: None,
        },
    )?;
    for phase in ["before the Freshness cycle", "after the Freshness cycle"] {
        let outcome = session.run()?;
        assert!(
            is_qualified(&outcome, PastHuman, &held.attempt_id),
            "{phase}"
        );
        assert_eq!(
            failure_of(&outcome, GeneratedOutput, &held.attempt_id),
            requalification_reason(RequalificationReason::SourceStale),
            "{phase}"
        );
        run_incremental_freshness_cycle(session.db())?;
    }
    Ok(())
}

/// A new Decision on a Revision through the product's decision writer.
fn append_decision(db: &Database, revision_id: &str, decision: &str) -> Result<()> {
    let (run_id, proposal_id): (String, String) = db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT s.run_id, r.proposal_id
               FROM narrative_proposal_revisions r
               JOIN narrative_proposals p ON p.id = r.proposal_id
               JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
              WHERE r.id = ?1",
            [revision_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?)
    })?;
    crate::narrative_extraction::narrative_extraction_append_human_decision(
        db,
        crate::narrative_extraction::AppendDecisionPayload {
            run_id,
            project_id: PROJECT.into(),
            proposal_id,
            revision_id: revision_id.into(),
            decision: decision.into(),
            decision_json: None,
            created_by: Some("hc1-test".into()),
        },
    )?;
    Ok(())
}

#[test]
fn negative_decision_and_canonical_freshness_each_have_their_own_reason() -> Result<()> {
    // A Decision on a Revision is terminal; a rejection after the attempt is a
    // Decision that no longer matches the recorded token.
    {
        let (session, turn) = settled_session()?;
        append_decision(session.db(), &session.revisions[0], "rejected")?;
        let outcome = session.run()?;
        assert_eq!(
            failure_of(&outcome, GeneratedOutput, &turn.attempt_id),
            requalification_reason(RequalificationReason::DecisionStale)
        );
        assert!(is_qualified(&outcome, PastHuman, &turn.attempt_id));
    }
    // The canonical Freshness is a projection of the dependency cycle, so no
    // product writer moves it without also moving a Source token (and the
    // Source is read first). Its own reason is therefore made on the
    // projection row itself, the way the cycle would leave a stale Revision
    // whose Sources were unchanged: nothing else about the Revision moves.
    {
        let (session, turn) = settled_session()?;
        let revision = session.revisions[0].clone();
        session.db().with_conn(|conn| {
            let changed = conn.execute(
                "UPDATE narrative_consumer_freshness
                    SET evidence_freshness = 'stale', build_action = 'revalidate-exact'
                  WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1",
                [&revision],
            )?;
            assert_eq!(changed, 1);
            Ok(())
        })?;
        let outcome = session.run()?;
        assert_eq!(
            failure_of(&outcome, GeneratedOutput, &turn.attempt_id),
            requalification_reason(RequalificationReason::FreshnessNotFresh)
        );
        assert!(is_qualified(&outcome, PastHuman, &turn.attempt_id));
    }
    Ok(())
}

#[test]
fn negative_anchor_scope_edits_expire_only_revisions_anchored_there() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let anchored = session.turn("Held at the anchor.", &[], Some("Answer one."))?;
    let other = {
        let spec = TurnSpec::new("Held at the other anchor.")
            .reply("Answer two.")
            .revisions(&[session.other_revision.clone()]);
        session.run_turn(spec)?
    };
    session.accept("next", "next")?;
    let outcome = session.run()?;
    assert_turn_adopted(&outcome, &anchored);
    assert_turn_adopted(&outcome, &other);
    // An edit of the first anchor's Scope.
    session.patch_node(
        ANCHOR,
        "hc1-anchor-pov",
        "povCharacterId",
        json!("nir1-alice"),
    )?;
    run_incremental_freshness_cycle(session.db())?;
    let outcome = session.run()?;
    assert_eq!(
        failure_of(&outcome, GeneratedOutput, &anchored.attempt_id),
        requalification_reason(RequalificationReason::SourceStale)
    );
    assert_turn_adopted(&outcome, &other);
    assert!(is_qualified(&outcome, PastHuman, &anchored.attempt_id));
    // Undoing the edit does not bring the Revisions back.
    session.patch_node(ANCHOR, "hc1-anchor-pov-undo", "povCharacterId", Value::Null)?;
    run_incremental_freshness_cycle(session.db())?;
    let outcome = session.run()?;
    assert_eq!(
        failure_of(&outcome, GeneratedOutput, &anchored.attempt_id),
        requalification_reason(RequalificationReason::SourceStale)
    );
    assert_turn_adopted(&outcome, &other);
    Ok(())
}

#[test]
fn negative_ref_and_na_integrity() -> Result<()> {
    // The rows of a Revision input (ordinal 2 of a D-final output) are changed
    // after D-final and before the attempt is stored. A change the structural
    // rule catches downgrades the attempt's slot to `d-final-incomplete` (the
    // writer's own check, HS-1); a change only the current state can judge
    // (rule 3: the recorded set is the set the Revisions derive) is caught by
    // the requalification.
    type Mutate = fn(&mut Vec<QualificationReference>);
    let rule_3: [(&str, Mutate); 2] = [
        ("a missing Source", |rows| {
            let at = rows
                .iter()
                .position(|row| {
                    row.input_ordinal == 2
                        && row.kind == QualificationKind::Source
                        && matches!(
                            &row.body,
                            QualificationBody::Present { identity, .. } if identity.starts_with("codex:")
                        )
                })
                .expect("a Codex Source row");
            rows.remove(at);
        }),
        ("an extra Source", |rows| {
            rows.push(QualificationReference::present(
                2,
                QualificationKind::Source,
                "codex:ghost",
                "codex:ghost@v1",
            ));
        }),
    ];
    for (name, mutate) in rule_3 {
        let mut session = SessionFixture::new()?;
        let turn = session.run_turn(
            TurnSpec::new("A request.")
                .reply("An answer.")
                .mutate(mutate),
        )?;
        session.accept("next", "next")?;
        let outcome = session.run()?;
        assert!(
            is_qualified(&outcome, PastHuman, &turn.attempt_id),
            "{name}"
        );
        assert!(
            matches!(
                failure_of(&outcome, GeneratedOutput, &turn.attempt_id),
                Failure::Ineligible(IneligibleReason::Requalification(
                    RequalificationReason::ExpectedSetMismatch(_)
                ))
            ),
            "{name}: {outcome:#?}"
        );
    }
    let structural: [(&str, Mutate); 2] = [
        ("a repeated (kind, target)", |rows| {
            let repeated = rows
                .iter()
                .find(|row| row.input_ordinal == 2 && row.kind == QualificationKind::Revision)
                .cloned()
                .expect("a Revision row");
            let mut again = repeated;
            if let QualificationBody::Present { version, .. } = &mut again.body {
                *version = "sha256:other".into();
            }
            rows.push(again);
        }),
        ("a reference where the table puts an N/A", |rows| {
            rows.push(QualificationReference::present(
                2,
                QualificationKind::Index,
                "index:ghost",
                "index:ghost@v1",
            ));
        }),
    ];
    for (name, mutate) in structural {
        let mut session = SessionFixture::new()?;
        let turn = session.run_turn(
            TurnSpec::new("A request.")
                .reply("An answer.")
                .mutate(mutate),
        )?;
        session.accept("next", "next")?;
        let outcome = session.run()?;
        let gated = Failure::Incomplete(IncompleteReason::HistoryContextUnusable(
            HistoryContextGateReason::Unavailable(
                crate::nir1_generation::history_context::HistoryUnavailableReason::DFinalIncomplete,
            ),
        ));
        assert_eq!(
            failure_of(&outcome, Attempt, &turn.attempt_id),
            gated,
            "{name}"
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Negative: restore epoch; return to the original value
// ---------------------------------------------------------------------------

#[test]
fn epoch_only_difference_excludes_every_candidate() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let first = session.turn("First.", &[], Some("First answer."))?;
    let second = session.turn("Second.", &[Adopt::output(&first)], Some("Second answer."))?;
    session.accept("next", "next")?;
    assert_turn_adopted(&session.run()?, &second);
    // What a snapshot restore and an integrity repair do in their own
    // transaction: mint the project's next semantic epoch. Nothing else
    // differs.
    session.db().with_conn(|conn| {
        crate::narrative_extraction::semantic_epoch::create_epoch_in_tx(
            conn, PROJECT, "restore", None,
        )?;
        Ok(())
    })?;
    let outcome = session.run()?;
    for turn in [&first, &second] {
        assert_turn_excluded_with(
            &outcome,
            turn,
            &context_reason(ContextMismatch::RestoreEpochMismatch),
            "epoch",
        );
    }
    // The restore retired the approvals; once a Revision is approved again, a
    // turn made after the epoch records the new one and is a candidate.
    create_typed_run(session.db(), "hc1-renewed-run")?;
    let renewed = approve_anchored_in(
        session.db(),
        "hc1-renewed-run",
        OTHER_ANCHOR,
        "hc1-after-epoch",
    )?;
    let third = session.run_turn(
        TurnSpec::new("Third.")
            .reply("Third answer.")
            .revisions(&[renewed]),
    )?;
    session.accept("after", "after")?;
    let outcome = session.run()?;
    assert_turn_adopted(&outcome, &third);
    Ok(())
}

#[test]
fn return_to_original_project_authority_version_does_not_matter() -> Result<()> {
    // (d) Another node is created and then removed: the project's Scope
    // authority token moves, and here it comes back. A typed Revision's
    // qualification does not depend on it, so the adoption is the same before,
    // during and after, although the A3 disclosure's own identity (the project
    // authority revision and the reveal-state token) differs in the middle.
    let (session, turn) = settled_session()?;
    let revision = session.revisions[0].clone();
    let a3_identity = |session: &SessionFixture| -> Result<(String, String)> {
        session.db().with_read_transaction(|conn| {
            match evaluate_nir1_entity_relation_disclosure(conn, PROJECT, &revision, SCENE)? {
                Nir1EntityRelationDisclosureRead::Eligible(disclosure) => Ok((
                    disclosure.scope_authority_revision.clone(),
                    disclosure.reveal_state_token.clone(),
                )),
                Nir1EntityRelationDisclosureRead::Unavailable { reason } => {
                    anyhow::bail!("A3 unavailable: {reason}")
                }
            }
        })
    };
    let before = (project_token(session.db())?, a3_identity(&session)?);
    assert_turn_adopted(&session.run()?, &turn);
    // A Scene far from the target, with a unique story-time key (so the
    // project's effective axis stays the same).
    session.create_node("hc1-passing", "scene", "z9", None)?;
    session.patch_node(
        "hc1-passing",
        "hc1-passing-key",
        "storyTimeOrder",
        json!("k-9"),
    )?;
    let during = (project_token(session.db())?, a3_identity(&session)?);
    assert_ne!(during.0, before.0, "the project token moves with the node");
    assert_ne!(
        (during.1).0,
        (before.1).0,
        "the A3 disclosure's project authority revision moves"
    );
    assert_ne!(
        (during.1).1,
        (before.1).1,
        "the reveal-state token moves with it"
    );
    assert_turn_adopted(&session.run()?, &turn);
    session.delete_node("hc1-passing")?;
    let after = (project_token(session.db())?, a3_identity(&session)?);
    assert_eq!(
        after, before,
        "the round trip returns the project's version"
    );
    assert_turn_adopted(&session.run()?, &turn);
    run_incremental_freshness_cycle(session.db())?;
    assert_turn_adopted(&session.run()?, &turn);
    Ok(())
}

#[test]
fn return_to_original_chapter_reorganization() -> Result<()> {
    // (e) The target sits in a chapter. A move of another chapter changes
    // nothing for it; a move or reorder of its own chapter advances the Scope
    // binding of what lies under it and the history does not come back even
    // when the reading rank is the same again.
    let mut session = SessionFixture::new()?;
    session.create_node("hc1-chapter", "folder", "a15", None)?;
    session.create_node("hc1-other-chapter", "folder", "z5", None)?;
    session.patch_node(SCENE, "hc1-into-chapter", "parentId", json!("hc1-chapter"))?;
    let turn = session.turn("A request.", &[], Some("An answer."))?;
    session.accept("next", "next")?;
    assert_turn_adopted(&session.run()?, &turn);
    // Another chapter is reorganized.
    session.patch_node(
        "hc1-other-chapter",
        "hc1-other-reorder",
        "sortOrder",
        json!("z6"),
    )?;
    session.patch_node(
        "hc1-other-chapter",
        "hc1-other-title",
        "title",
        json!("Elsewhere"),
    )?;
    assert_turn_adopted(&session.run()?, &turn);
    // The target's own chapter is reordered (the rank stays the same).
    session.patch_node("hc1-chapter", "hc1-own-reorder", "sortOrder", json!("a16"))?;
    let token = context_reason(ContextMismatch::ScopeBindingTokenChanged);
    assert_turn_excluded_with(&session.run()?, &turn, &token, "reordered");
    session.patch_node(
        "hc1-chapter",
        "hc1-own-reorder-back",
        "sortOrder",
        json!("a15"),
    )?;
    assert_turn_excluded_with(&session.run()?, &turn, &token, "reordered back");
    Ok(())
}

// ---------------------------------------------------------------------------
// Budgets, order, cancellation
// ---------------------------------------------------------------------------

/// What one budget dimension is set to.
#[derive(Clone, Copy, Debug)]
enum Dimension {
    Attempts,
    ReferenceCount,
    ReferenceBytes,
    BodyBytes,
    Nodes,
    Edges,
    QualificationRefs,
}

impl Dimension {
    const ALL: [Dimension; 7] = [
        Dimension::Attempts,
        Dimension::ReferenceCount,
        Dimension::ReferenceBytes,
        Dimension::BodyBytes,
        Dimension::Nodes,
        Dimension::Edges,
        Dimension::QualificationRefs,
    ];

    fn get(self, budget: &GenerationHistoryReadBudget) -> usize {
        match self {
            Self::Attempts => budget.max_attempts,
            Self::ReferenceCount => budget.max_reference_count,
            Self::ReferenceBytes => budget.max_reference_bytes,
            Self::BodyBytes => budget.max_resolved_body_bytes,
            Self::Nodes => budget.remaining_nodes,
            Self::Edges => budget.remaining_edges,
            Self::QualificationRefs => budget.remaining_qualification_refs,
        }
    }

    fn set(self, budget: &mut GenerationHistoryReadBudget, value: usize) {
        match self {
            Self::Attempts => {
                budget.max_attempts = value;
                // The candidate bound is the smaller of the two, and is the
                // caller's own number: keep it from masking the dimension.
                budget.max_candidates = budget.max_candidates.max(value);
            }
            Self::ReferenceCount => budget.max_reference_count = value,
            Self::ReferenceBytes => budget.max_reference_bytes = value,
            Self::BodyBytes => budget.max_resolved_body_bytes = value,
            Self::Nodes => budget.remaining_nodes = value,
            Self::Edges => budget.remaining_edges = value,
            Self::QualificationRefs => budget.remaining_qualification_refs = value,
        }
    }
}

/// A three-turn chain that is next to be extended (six candidates).
fn chain_session() -> Result<(SessionFixture, Vec<Turn>)> {
    let mut session = SessionFixture::new()?;
    let mut turns: Vec<Turn> = Vec::new();
    for index in 0..3 {
        let adopt: Vec<Adopt> = turns
            .last()
            .map(|previous| vec![Adopt::human(previous), Adopt::output(previous)])
            .unwrap_or_default();
        let turn = session.turn(
            &format!("request {index}"),
            &adopt,
            Some(&format!("answer {index}")),
        )?;
        turns.push(turn);
    }
    session.accept("next", "next")?;
    Ok((session, turns))
}

#[test]
fn budget_boundary_n_and_n_plus_one_per_ledger_dimension() -> Result<()> {
    let (session, turns) = chain_session()?;
    let mut probe = SessionFixture::generous_budget();
    let baseline = session.run_with(&mut probe)?;
    for turn in &turns {
        assert_turn_adopted(&baseline, turn);
    }
    let generous = SessionFixture::generous_budget();
    for dimension in Dimension::ALL {
        let consumed = dimension.get(&generous) - dimension.get(&probe);
        assert!(consumed > 0, "{dimension:?} is charged by a run");
        // N: the run fits exactly and decides the same.
        let mut exact = SessionFixture::generous_budget();
        dimension.set(&mut exact, consumed);
        assert_eq!(
            session.run_with(&mut exact)?,
            baseline,
            "{dimension:?} at N"
        );
        assert_eq!(dimension.get(&exact), 0, "{dimension:?} is used up at N");
        // N - 1: something is not verified. What was verified stays, and what
        // was not is excluded with the budget's reason or, when not even the
        // session could be read, the whole turn goes on without history.
        let mut short = SessionFixture::generous_budget();
        dimension.set(&mut short, consumed - 1);
        let outcome = session.run_with(&mut short)?;
        let cut_short = outcome.without_history == Some(NoHistory::SessionOverBudget)
            || outcome.candidates.iter().any(|result| {
                result.disposition
                    == CandidateDisposition::Excluded(Failure::Incomplete(
                        IncompleteReason::BudgetExhausted,
                    ))
            })
            || has_unpaid_material(&outcome);
        assert!(cut_short, "{dimension:?} at N-1: {outcome:#?}");
        for result in outcome.qualified() {
            assert!(
                is_qualified(&baseline, result.kind, &result.attempt_id),
                "{dimension:?} at N-1 adopts only what the full run adopts"
            );
        }
        // Everything that is excluded by the budget is a candidate the full
        // run adopted (an unverified candidate, not a wrong one).
        for result in &outcome.candidates {
            if result.disposition
                == CandidateDisposition::Excluded(Failure::Incomplete(
                    IncompleteReason::BudgetExhausted,
                ))
            {
                let full = baseline
                    .candidates
                    .iter()
                    .find(|other| other.attempt_id == result.attempt_id)
                    .expect("the same attempt");
                let _ = full;
            }
        }
    }
    Ok(())
}

#[test]
fn budget_exhaustion_excludes_unverified_candidates_and_keeps_verified_independent_ones(
) -> Result<()> {
    // Two independent sessions' worth of history in one session: the turns
    // are not linked to each other. A node budget that covers three attempts
    // verifies the three newest candidates' attempts and leaves the others
    // unverified.
    let mut session = SessionFixture::new()?;
    let mut turns = Vec::new();
    for index in 0..4 {
        turns.push(session.turn(
            &format!("independent request {index}"),
            &[],
            Some(&format!("independent answer {index}")),
        )?);
    }
    session.accept("next", "next")?;
    let mut budget = SessionFixture::generous_budget();
    budget.remaining_nodes = 3;
    let outcome = session.run_with(&mut budget)?;
    assert_eq!(outcome.without_history, None);
    // Newest first: the three newest turns are verified (their Human and
    // their output share one header), the oldest is not.
    for turn in &turns[1..] {
        assert_turn_adopted(&outcome, turn);
    }
    let exhausted = Failure::Incomplete(IncompleteReason::BudgetExhausted);
    assert_eq!(
        failure_of(&outcome, PastHuman, &turns[0].attempt_id),
        exhausted
    );
    assert_eq!(
        failure_of(&outcome, GeneratedOutput, &turns[0].attempt_id),
        exhausted
    );
    Ok(())
}

#[test]
fn budget_enumeration_overflow_continues_without_history() -> Result<()> {
    let (session, turns) = chain_session()?;
    // The session has three attempts: a listing allowance of two cannot read
    // it, so no candidate is verified and the turn goes on without history.
    for (attempts, candidates) in [(2, 256), (256, 2)] {
        let mut budget = SessionFixture::generous_budget();
        budget.max_attempts = attempts;
        budget.max_candidates = candidates;
        let outcome = session.run_with(&mut budget)?;
        assert_eq!(outcome.without_history, Some(NoHistory::SessionOverBudget));
        assert!(outcome.candidates.is_empty());
    }
    // Exactly the listing: the candidates are then verified with what is left.
    let mut budget = SessionFixture::generous_budget();
    budget.max_attempts = 3;
    budget.max_candidates = 3;
    let outcome = session.run_with(&mut budget)?;
    assert!(outcome.without_history.is_none());
    for result in &outcome.candidates {
        assert!(
            !is_qualified(&outcome, result.kind, &result.attempt_id),
            "the allowance is spent by the listing: nothing is read after it"
        );
    }
    let _ = turns;
    Ok(())
}

#[test]
fn sql_steps_and_the_deadline_stop_the_snapshot_with_a_typed_reason() -> Result<()> {
    use crate::narrative_extraction::{ValidationTerminated, ValidationTerminationReason};

    let (session, _turns) = chain_session()?;
    let mut probe = SessionFixture::generous_budget();
    session.run_with(&mut probe)?;
    let used = probe.sql.as_ref().expect("a ledger").sql_steps_used();
    assert!(used > 0);
    let reason = |error: &anyhow::Error| {
        error
            .downcast_ref::<ValidationTerminated>()
            .map(|terminated| terminated.reason)
    };
    // Plenty of steps: the same answer.
    let mut roomy = SessionFixture::generous_budget();
    roomy.sql = Some(GenerationHistorySqlLedger::new(
        GenerationHistorySnapshotSqlBudget {
            max_vm_steps: used * 4,
            deadline: Instant::now() + Duration::from_secs(60),
            busy_wait: Duration::from_millis(100),
        },
    ));
    assert!(session.run_with(&mut roomy)?.without_history.is_none());
    // Half of what the run needs: the turn's SQL ledger is the connection's
    // progress handler, so the snapshot itself ends with the typed reason.
    let mut short = SessionFixture::generous_budget();
    short.sql = Some(GenerationHistorySqlLedger::new(
        GenerationHistorySnapshotSqlBudget {
            max_vm_steps: used / 2,
            deadline: Instant::now() + Duration::from_secs(60),
            busy_wait: Duration::from_millis(100),
        },
    ));
    let error = session.run_with(&mut short).expect_err("steps exhausted");
    assert_eq!(
        reason(&error),
        Some(ValidationTerminationReason::CapacityExceeded),
        "{error:#}"
    );
    // A deadline that has passed.
    let mut late = SessionFixture::generous_budget();
    late.sql = Some(GenerationHistorySqlLedger::new(
        GenerationHistorySnapshotSqlBudget {
            max_vm_steps: used * 4,
            deadline: Instant::now(),
            busy_wait: Duration::from_millis(100),
        },
    ));
    let error = session.run_with(&mut late).expect_err("deadline");
    assert_eq!(
        reason(&error),
        Some(ValidationTerminationReason::TimedOut),
        "{error:#}"
    );
    Ok(())
}

#[test]
fn order_is_deterministic_for_equal_created_at_ms() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let same = session.clock_base + 5_000;
    let mut turns = Vec::new();
    for index in 0..3 {
        let spec = TurnSpec::new(&format!("request {index}"))
            .reply(&format!("answer {index}"))
            .created_at(same)
            // The product create decides the time from Native's clock (DI-1c),
            // so equal creation times need the test-support writer.
            .writer(Writer::TestSupport { null_slot: false });
        turns.push(session.run_turn(spec)?);
    }
    session.accept("next", "next")?;
    let outcome = session.run()?;
    // Equal creation times are ordered by the attempt IDs' bytes.
    let mut ids: Vec<&str> = turns.iter().map(|turn| turn.attempt_id.as_str()).collect();
    ids.sort_unstable();
    let humans: Vec<&str> = outcome
        .candidates
        .iter()
        .filter(|result| result.kind == PastHuman)
        .map(|result| result.attempt_id.as_str())
        .collect();
    assert_eq!(humans, ids);
    // A budget that runs out part-way excludes the same candidates for the
    // same reasons on every run.
    let run_tight = || -> Result<SessionHistoryOutcome> {
        let mut budget = SessionFixture::generous_budget();
        budget.remaining_nodes = 2;
        session.run_with(&mut budget)
    };
    let first = run_tight()?;
    assert_eq!(first, run_tight()?);
    assert!(first
        .candidates
        .iter()
        .any(|result| result.disposition != CandidateDisposition::Qualified));
    // The first two attempts in the order are the ones verified.
    for id in &ids[..2] {
        assert!(is_qualified(&first, PastHuman, id));
    }
    assert_eq!(
        failure_of(&first, PastHuman, ids[2]),
        Failure::Incomplete(IncompleteReason::BudgetExhausted)
    );
    Ok(())
}

#[test]
fn cancellation_stops_the_whole_turn_without_partial_results() -> Result<()> {
    use crate::narrative_extraction::{ValidationTerminated, ValidationTerminationReason};

    let (session, _turns) = chain_session()?;
    // The caller's poll says stop part-way: the run is an error with the
    // typed reason, never a part of the outcome.
    let mut polls = 0;
    let error = session
        .snapshot
        .db()
        .with_participant_read_transaction_bounded(
            session.snapshot.participant(),
            prepared_sql_budget(),
            |conn| {
                let stage = build_history_context_stage(
                    conn,
                    PROJECT,
                    SCENE,
                    session.snapshot.durable_workspace_identity(),
                    HistorySendClassification::LocalOnly,
                )?;
                let scene = read_attempt_scene_binding_in_tx(conn, PROJECT, SCENE)?;
                let current = stage.current_history_context(
                    HistoryRange {
                        project_id: PROJECT.into(),
                        chat_session_id: SESSION.into(),
                        scene_id: SCENE.into(),
                        scene_incarnation_id: scene.scene_incarnation_id,
                    },
                    GenerationPurpose::Writing,
                );
                let cancellation = GenerationHistorySnapshotCancellation::from_control(
                    &ParticipantSqlControl::default(),
                );
                let mut budget = SessionFixture::generous_budget();
                reauthorize_session_history_in_tx(
                    conn,
                    &cancellation,
                    &mut budget,
                    &SessionHistoryRequest {
                        current: &current,
                        now_ms: wall_clock_ms(),
                    },
                    &mut || {
                        polls += 1;
                        polls > 6
                    },
                )
            },
        )
        .expect_err("a cancelled run is an error");
    assert_eq!(
        error
            .downcast_ref::<ValidationTerminated>()
            .map(|terminated| terminated.reason),
        Some(ValidationTerminationReason::Cancelled),
        "{error:#}"
    );
    // The owner's stop flag does the same before anything is read.
    let stop = Arc::new(AtomicBool::new(true));
    let error = session
        .snapshot
        .db()
        .with_participant_read_transaction_bounded(
            session.snapshot.participant(),
            prepared_sql_budget(),
            |conn| {
                let cancellation = GenerationHistorySnapshotCancellation::from_control(
                    &ParticipantSqlControl {
                        stop: Arc::clone(&stop),
                        deadline: None,
                    },
                );
                let current = CurrentHistoryContext::Unavailable(
                    crate::nir1_generation::history_context::HistoryUnavailableReason::SceneScopeUnavailable,
                );
                let mut budget = SessionFixture::generous_budget();
                reauthorize_session_history_in_tx(
                    conn,
                    &cancellation,
                    &mut budget,
                    &SessionHistoryRequest {
                        current: &current,
                        now_ms: wall_clock_ms(),
                    },
                    &mut || false,
                )
            },
        )
        .expect_err("a stopped owner");
    assert_eq!(
        error
            .downcast_ref::<ValidationTerminated>()
            .map(|terminated| terminated.reason),
        Some(ValidationTerminationReason::Cancelled),
        "{error:#}"
    );
    Ok(())
}

#[test]
fn the_in_snapshot_form_refuses_an_autocommit_connection() -> Result<()> {
    // The listing, the captures, the ordinal-0 counts and every
    // requalification must be read in the one snapshot the caller owns: on an
    // autocommit connection each statement would see its own implicit
    // snapshot, so the entry refuses it instead of qualifying a torn view.
    let (session, turn) = settled_session()?;
    let current = session
        .snapshot
        .db()
        .with_participant_read_transaction_bounded(
            session.snapshot.participant(),
            prepared_sql_budget(),
            |conn| {
                let stage = build_history_context_stage(
                    conn,
                    PROJECT,
                    SCENE,
                    session.snapshot.durable_workspace_identity(),
                    HistorySendClassification::LocalOnly,
                )?;
                let scene = read_attempt_scene_binding_in_tx(conn, PROJECT, SCENE)?;
                Ok(stage.current_history_context(
                    HistoryRange {
                        project_id: PROJECT.into(),
                        chat_session_id: SESSION.into(),
                        scene_id: SCENE.into(),
                        scene_incarnation_id: scene.scene_incarnation_id,
                    },
                    GenerationPurpose::Writing,
                ))
            },
        )?;
    let error = session
        .db()
        .with_conn(|conn| {
            assert!(conn.is_autocommit());
            run_in(
                conn,
                &current,
                &mut SessionFixture::generous_budget(),
                wall_clock_ms(),
            )
        })
        .expect_err("an autocommit connection is refused");
    assert!(
        format!("{error:#}").contains("NIR1_GENERATION_TRANSACTION_REQUIRED"),
        "{error:#}"
    );
    // Nothing was decided on that connection; the same run in the participant
    // read transaction decides the turn.
    assert_turn_adopted(&session.run()?, &turn);
    Ok(())
}

#[test]
fn history_cannot_raise_secret_disclosure() -> Result<()> {
    // The run takes the current turn's context and nothing else from the
    // request: there is no query context, no `allow_secrets` and no viewpoint
    // to set. What an old attempt recorded is compared with the current turn
    // and never widens it: an attempt that recorded another viewpoint is out,
    // and the A3 judgement the Revisions are held to is the current one.
    let (session, turn) = settled_session()?;
    session.patch_node(SCENE, "hc1-secret-pov", "povCharacterId", json!("nir1-bob"))?;
    let outcome = session.run()?;
    assert_turn_excluded_with(
        &outcome,
        &turn,
        &context_reason(ContextMismatch::AxisChanged(HistoryAxisName::Viewpoint)),
        "the recorded viewpoint is not the current one",
    );
    Ok(())
}

#[test]
fn history_cannot_raise_secret_disclosure_when_the_entity_is_no_longer_disclosable() -> Result<()> {
    // K4/3's mandatory defense "a stored value does not change disclosure".
    // Two outputs hold Revisions of disjoint Entities. A secret foreshadow
    // (product commit pipeline) is linked to one Entity: its reveal state is
    // now "not disclosed". The target Scene's nine axes and Scope binding token
    // are untouched (the Humans of both turns stay qualified, which only an
    // equal context allows) and no Source, Decision or bundle of either
    // Revision changed. The current A3 evaluation alone retires the output
    // that holds the linked Entity's Revision; the independent one stays.
    let mut session = SessionFixture::new()?;
    let alice = approve_single_entity_revision(
        session.db(),
        "hc1-alice-run",
        ANCHOR,
        "hc1-alice-proposal",
        "nir1-alice",
    )?;
    let bob = approve_single_entity_revision(
        session.db(),
        "hc1-bob-run",
        ANCHOR,
        "hc1-bob-proposal",
        "nir1-bob",
    )?;
    let holds_alice = session.run_turn(
        TurnSpec::new("Holds the Revision of Alice.")
            .reply("Answer one.")
            .revisions(&[alice]),
    )?;
    let holds_bob = session.run_turn(
        TurnSpec::new("Holds the Revision of Bob.")
            .reply("Answer two.")
            .revisions(&[bob]),
    )?;
    session.accept("next", "The next request.")?;
    let outcome = session.run()?;
    assert_turn_adopted(&outcome, &holds_alice);
    assert_turn_adopted(&outcome, &holds_bob);

    create_secret_foreshadow_linked_to(session.db(), "nir1-alice", "alice")?;
    // The same result before and after the Freshness cycle drains the feed:
    // the foreshadow is not a Source of either Revision.
    for phase in ["before the Freshness cycle", "after the Freshness cycle"] {
        let outcome = session.run()?;
        assert_eq!(
            failure_of(&outcome, GeneratedOutput, &holds_alice.attempt_id),
            Failure::Ineligible(IneligibleReason::Requalification(
                RequalificationReason::DisclosureIneligible
            )),
            "{phase}: the output of the Entity that is no longer disclosable"
        );
        assert!(
            is_qualified(&outcome, PastHuman, &holds_alice.attempt_id),
            "{phase}: its Human has no Revision input and the context is equal"
        );
        assert_turn_adopted(&outcome, &holds_bob);
        run_incremental_freshness_cycle(session.db())?;
    }
    Ok(())
}

#[test]
fn negative_snapshot_restore_without_body_moves_only_the_epoch() -> Result<()> {
    use crate::project_snapshots::{
        apply_project_snapshot_restore, build_canonical_restore_plan, create_project_snapshot,
        ApplyProjectSnapshotRestorePayload, CreateProjectSnapshotPayload, RestoreScope,
    };

    let (session, turn) = settled_session()?;
    assert_turn_adopted(&session.run()?, &turn);
    // A snapshot that has no labels, taken before a label exists.
    create_project_snapshot(
        session.db(),
        CreateProjectSnapshotPayload {
            project_id: PROJECT.to_owned(),
            snapshot_id: "hc1-snapshot".to_owned(),
            name: "hc1".to_owned(),
            description: None,
            created_at: "2026-11-04T00:00:00.000Z".to_owned(),
            tree_rows: Vec::new(),
            codex_rows: Vec::new(),
            snippet_rows: Vec::new(),
            version_ids: Vec::new(),
        },
    )?;
    session.db().with_conn(|conn| {
        conn.execute(
            "INSERT INTO labels(id,project_id,name,color) VALUES ('hc1-label',?1,'Label','red')",
            [PROJECT],
        )?;
        Ok(())
    })?;
    // Restoring the Labels scope (no Body) removes the label and rotates the
    // project's semantic epoch in the same transaction.
    let scopes = vec![RestoreScope::Labels];
    let selected = scopes
        .iter()
        .copied()
        .collect::<std::collections::HashSet<_>>();
    let inserts = session
        .db()
        .with_conn(|conn| build_canonical_restore_plan(conn, PROJECT, "hc1-snapshot", &selected))?;
    apply_project_snapshot_restore(
        session.db(),
        ApplyProjectSnapshotRestorePayload {
            request_id: "hc1-restore-request".to_owned(),
            session_id: "hc1-restore-session".to_owned(),
            project_id: PROJECT.to_owned(),
            snapshot_id: "hc1-snapshot".to_owned(),
            scopes,
            inserts,
        },
    )?;
    let epochs: i64 = session.db().with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM narrative_semantic_epochs WHERE reason = 'restore'",
            [],
            |row| row.get(0),
        )?)
    })?;
    assert!(epochs >= 1, "the restore minted an epoch");
    // Nothing else of the turn's context differs: the Scene, its Scope and
    // its axes are the same. Only the epoch is, and every candidate is out.
    let outcome = session.run()?;
    assert_turn_excluded_with(
        &outcome,
        &turn,
        &context_reason(ContextMismatch::RestoreEpochMismatch),
        "snapshot restore",
    );
    Ok(())
}

#[test]
fn positive_chain_survives_a_cold_reopen() -> Result<()> {
    let directory = std::env::temp_dir().join(format!("hc1-cold-reopen-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory)?;
    let path = directory.join("grimodex.db");
    let result = (|| -> Result<()> {
        let mut session = SessionFixture::new_on_file(&path)?;
        let first = session.turn("First.", &[], Some("First answer."))?;
        let second = session.turn(
            "Second.",
            &[Adopt::human(&first), Adopt::output(&first)],
            Some("Second answer."),
        )?;
        let before_authority = session.snapshot.db().identity();
        // The process is gone: a new authority instance opens the file again.
        let session = session.reopen(&path)?;
        assert_ne!(session.snapshot.db().identity(), before_authority);
        session.accept("next", "next")?;
        let outcome = session.run()?;
        assert_eq!(outcome.without_history, None);
        assert_turn_adopted(&outcome, &first);
        assert_turn_adopted(&outcome, &second);
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&directory);
    result
}

// ---------------------------------------------------------------------------
// HC-1a: the measurement of what one turn's history costs (K1b rule 5)
// ---------------------------------------------------------------------------

/// What a run took from the caller's budget, and how long it took.
#[derive(Debug)]
#[expect(
    dead_code,
    reason = "the fields are read through Debug by the HC-1a harness, which `dead_code` does not count"
)]
struct Measured {
    nodes: usize,
    edges: usize,
    qualification_refs: usize,
    attempts: usize,
    reference_count: usize,
    reference_bytes: usize,
    body_bytes: usize,
    sql_vm_steps: u64,
    a3_evaluations: usize,
    candidates: usize,
    qualified: usize,
    elapsed_ms: u128,
}

fn measure(session: &SessionFixture) -> Result<Measured> {
    let generous = SessionFixture::generous_budget();
    let mut budget = SessionFixture::generous_budget();
    let started = Instant::now();
    let outcome = session.run_with(&mut budget)?;
    let elapsed_ms = started.elapsed().as_millis();
    Ok(Measured {
        nodes: Dimension::Nodes.get(&generous) - Dimension::Nodes.get(&budget),
        edges: Dimension::Edges.get(&generous) - Dimension::Edges.get(&budget),
        qualification_refs: Dimension::QualificationRefs.get(&generous)
            - Dimension::QualificationRefs.get(&budget),
        attempts: Dimension::Attempts.get(&generous) - Dimension::Attempts.get(&budget),
        reference_count: Dimension::ReferenceCount.get(&generous)
            - Dimension::ReferenceCount.get(&budget),
        reference_bytes: Dimension::ReferenceBytes.get(&generous)
            - Dimension::ReferenceBytes.get(&budget),
        body_bytes: Dimension::BodyBytes.get(&generous) - Dimension::BodyBytes.get(&budget),
        sql_vm_steps: budget.sql.as_ref().expect("a ledger").sql_steps_used(),
        a3_evaluations: outcome.a3_evaluations,
        candidates: outcome.candidates.len(),
        qualified: outcome.qualified().count(),
        elapsed_ms,
    })
}

/// The rows and bytes one attempt stores for its inputs, as serialized:
/// `(input references + qualification rows, bytes of both, qualification rows,
/// bytes of the qualification rows)`.
fn stored_size(session: &SessionFixture, attempt_id: &str) -> Result<(usize, usize, usize, usize)> {
    let stored = read_attempt(session.db(), attempt_id, SessionFixture::read_budget())?;
    let input_bytes: usize = stored
        .inputs
        .iter()
        .map(|input| serde_json::to_string(input).map(|text| text.len()))
        .sum::<Result<usize, _>>()?;
    let row_bytes: usize = stored
        .qualifications
        .iter()
        .map(|row| serde_json::to_string(row).map(|text| text.len()))
        .sum::<Result<usize, _>>()?;
    Ok((
        stored.inputs.len() + stored.qualifications.len(),
        input_bytes + row_bytes,
        stored.qualifications.len(),
        row_bytes,
    ))
}

/// The stored `binding_json` of an attempt (it carries the history slot).
fn binding_bytes(session: &SessionFixture, attempt_id: &str) -> Result<i64> {
    session.db().with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT octet_length(binding_json) FROM nir1_generation_attempts WHERE id=?1",
            [attempt_id],
            |row| row.get(0),
        )?)
    })
}

/// A fixture with `count` more approved Revisions of one Entity each (the
/// largest request the packing admits carries 102 of them).
fn approve_small_revisions(db: &Database, count: usize) -> Result<Vec<String>> {
    let mut revisions = Vec::new();
    for index in 0..count {
        let run_id = format!("hc1a-run-{index}");
        create_typed_run(db, &run_id)?;
        let mut typed = request_for_run(db, &run_id, &format!("hc1a-proposal-{index}"));
        typed.bundle.entities.truncate(1);
        typed.bundle.relations.clear();
        let created = create_nir1_entity_relation_revision(db, typed)?;
        approve_typed_revision(db, &run_id, &created)?;
        revisions.push(
            created["revisionId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("revision id missing"))?
                .to_owned(),
        );
    }
    Ok(revisions)
}

/// Run alone: `cargo test --features native-current-human-capture --lib
/// session_history_tests::hc1a_measurement -- --ignored --nocapture`.
#[test]
#[ignore = "HC-1a measurement harness: run alone, its output goes to the decisions record"]
fn hc1a_measurement() -> Result<()> {
    let note = |label: &str, measured: &Measured| eprintln!("HC1A {label}: {measured:?}");

    // 1. The rows and bytes of one attempt with the fixture's two Revisions
    // (E = 2, Rel = 1), on the tree after X1-3.
    let mut session = SessionFixture::new()?;
    let one = session.turn("one", &[], Some("answer one"))?;
    let (rows, bytes, qualification_rows, qualification_bytes) =
        stored_size(&session, &one.attempt_id)?;
    eprintln!(
        "HC1A one attempt, 2 Revisions (E=2,Rel=1): {rows} rows ({qualification_rows} qualification rows), {bytes} bytes ({qualification_bytes} bytes of qualification rows, {:.1} per row)",
        qualification_bytes as f64 / qualification_rows as f64
    );
    eprintln!(
        "HC1A binding_json of that attempt: {} bytes",
        binding_bytes(&session, &one.attempt_id)?
    );

    // 2. A chain of 6 turns with those Revisions, each adopting the previous
    // turn's Human and output.
    let mut turns = vec![one];
    for index in 1..6 {
        let previous = turns.last().expect("a turn").clone();
        let turn = session.turn(
            &format!("request {index}"),
            &[Adopt::human(&previous), Adopt::output(&previous)],
            Some(&format!("answer {index}")),
        )?;
        turns.push(turn);
    }
    session.accept("next", "next")?;
    note("chain of 6 turns, 2 Revisions each", &measure(&session)?);

    // 3. Fan-out and diamond (4 turns).
    let mut session = SessionFixture::new()?;
    let t1 = session.turn("one", &[], Some("answer one"))?;
    let t2 = session.turn("two", &[Adopt::human(&t1), Adopt::output(&t1)], Some("two"))?;
    let t3 = session.turn("three", &[Adopt::output(&t1)], Some("three"))?;
    session.turn(
        "four",
        &[Adopt::output(&t2), Adopt::output(&t3)],
        Some("four"),
    )?;
    session.accept("next", "next")?;
    note("diamond and fan-out, 4 turns", &measure(&session)?);

    // 4. A chain with a missing link: the output of the second turn was
    // rewritten by the renderer, so the attempt cannot be read.
    let mut session = SessionFixture::new()?;
    let a = session.turn("one", &[], Some("answer one"))?;
    let b = session.turn("two", &[Adopt::output(&a)], Some("answer two"))?;
    session.turn("three", &[Adopt::output(&b)], Some("answer three"))?;
    session.accept("next", "next")?;
    let (reply, _, _) = b.output.clone().expect("output");
    session.renderer_edit_message(&reply, "rewritten")?;
    note(
        "chain of 3 with an unreadable middle attempt",
        &measure(&session)?,
    );

    // 5. Sessions with more attempts: the listing and the per-attempt cost.
    for count in [8usize, 32] {
        let mut session = SessionFixture::new()?;
        for index in 0..count {
            session.turn(
                &format!("request {index}"),
                &[],
                Some(&format!("answer {index}")),
            )?;
        }
        session.accept("next", "next")?;
        note(
            &format!("{count} independent attempts"),
            &measure(&session)?,
        );
        // The listing fails at one past the allowance.
        let mut budget = SessionFixture::generous_budget();
        budget.max_attempts = count - 1;
        let outcome = session.run_with(&mut budget)?;
        eprintln!(
            "HC1A {count} attempts with max_attempts {}: {:?}",
            count - 1,
            outcome.without_history
        );
    }

    // 6. Turns with many Revisions: 102 Revisions of one Entity each, the
    // largest request the packing admits.
    let mut session = SessionFixture::new()?;
    let many = approve_small_revisions(session.db(), 102)?;
    let first = session.run_turn(
        TurnSpec::new("many one")
            .reply("many answer one")
            .revisions(&many),
    )?;
    let (rows, bytes, qualification_rows, qualification_bytes) =
        stored_size(&session, &first.attempt_id)?;
    eprintln!(
        "HC1A one attempt, 102 Revisions (E=1): {rows} rows ({qualification_rows} qualification rows), {bytes} bytes ({qualification_bytes} bytes of qualification rows, {:.1} per row)",
        qualification_bytes as f64 / qualification_rows as f64
    );
    eprintln!(
        "HC1A binding_json of the 102-Revision attempt: {} bytes",
        binding_bytes(&session, &first.attempt_id)?
    );
    let second = session.run_turn(
        TurnSpec::new("many two")
            .adopt(&[Adopt::human(&first), Adopt::output(&first)])
            .reply("many answer two")
            .revisions(&many),
    )?;
    session.run_turn(
        TurnSpec::new("many three")
            .adopt(&[Adopt::human(&second), Adopt::output(&second)])
            .reply("many answer three")
            .revisions(&many),
    )?;
    session.accept("next", "next")?;
    note("3 turns of 102 Revisions each", &measure(&session)?);
    Ok(())
}

#[test]
fn positive_the_self_transaction_form_decides_like_the_in_snapshot_form() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let first = session.turn("First.", &[], Some("First answer."))?;
    let second = session.turn(
        "Second.",
        &[Adopt::human(&first), Adopt::output(&first)],
        Some("Second answer."),
    )?;
    session.accept("next", "next")?;
    // The current turn's context, made by the builder in its own snapshot.
    let current = session
        .snapshot
        .db()
        .with_participant_read_transaction_bounded(
            session.snapshot.participant(),
            prepared_sql_budget(),
            |conn| {
                let stage = build_history_context_stage(
                    conn,
                    PROJECT,
                    SCENE,
                    session.snapshot.durable_workspace_identity(),
                    HistorySendClassification::LocalOnly,
                )?;
                let scene = read_attempt_scene_binding_in_tx(conn, PROJECT, SCENE)?;
                Ok(stage.current_history_context(
                    HistoryRange {
                        project_id: PROJECT.into(),
                        chat_session_id: SESSION.into(),
                        scene_id: SCENE.into(),
                        scene_incarnation_id: scene.scene_incarnation_id,
                    },
                    GenerationPurpose::Writing,
                ))
            },
        )?;
    let now_ms = wall_clock_ms();
    let own = reauthorize_session_history(
        &session.snapshot,
        ParticipantSqlControl::default(),
        &mut SessionFixture::generous_budget(),
        &SessionHistoryRequest {
            current: &current,
            now_ms,
        },
        &mut || false,
    )?;
    assert_eq!(own.without_history, None);
    assert_turn_adopted(&own, &first);
    assert_turn_adopted(&own, &second);
    let in_snapshot = session.run_purpose(
        &mut SessionFixture::generous_budget(),
        GenerationPurpose::Writing,
        now_ms,
    )?;
    assert_eq!(own, in_snapshot);
    Ok(())
}

/// A-15 (DI-1a): an attempt with Graph-derived inputs is stored and read back,
/// and the history of the next turn leaves its Human and its output out as
/// `PendingAuthority` (K4/3 section 6). The independent branch stays.
#[test]
fn graph_derived_attempts_stay_pending_and_leave_the_next_turn() -> Result<()> {
    let mut session = SessionFixture::new()?;
    let graph_turn = session.run_turn(
        TurnSpec::new("A request with a Graph.")
            .with_graph()
            .reply("A Graph answer."),
    )?;
    let plain_turn = session.turn("A request without a Graph.", &[], Some("A plain answer."))?;

    // The stored attempt holds the Graph-derived inputs, each with an Index
    // reference that is not a typed N/A, and reads back whole.
    let stored = read_attempt(
        session.db(),
        &graph_turn.attempt_id,
        SessionFixture::read_budget(),
    )?;
    let graph_ordinals = stored
        .inputs
        .iter()
        .enumerate()
        .filter(|(_, input)| matches!(input.target, InputTarget::GraphEvidence { .. }))
        .map(|(ordinal, _)| ordinal)
        .collect::<Vec<_>>();
    assert!(
        !graph_ordinals.is_empty(),
        "the attempt stored Graph inputs"
    );
    for ordinal in &graph_ordinals {
        let index = stored
            .qualifications
            .iter()
            .filter(|row| row.input_ordinal == *ordinal && row.kind == QualificationKind::Index)
            .collect::<Vec<_>>();
        assert_eq!(index.len(), 1);
        assert!(
            matches!(index[0].body, QualificationBody::Present { .. }),
            "the Index of a Graph-derived input is a reference: {index:?}"
        );
    }
    assert!(
        read_attempt(
            session.db(),
            &plain_turn.attempt_id,
            SessionFixture::read_budget()
        )?
        .inputs
        .iter()
        .all(|input| !matches!(input.target, InputTarget::GraphEvidence { .. })),
        "the control turn has no Graph input"
    );

    session.accept("next", "The next request.")?;
    let outcome = session.run()?;
    assert_eq!(outcome.without_history, None, "{outcome:#?}");
    // The generated output descends from every input of its attempt, so the
    // Graph-derived input keeps it out (Pending). The past Human is judged by
    // its own message input only: DI-1a does not change the history reader.
    assert_eq!(
        failure_of(&outcome, GeneratedOutput, &graph_turn.attempt_id),
        Failure::Incomplete(IncompleteReason::PendingAuthority),
        "the output of a Graph-derived attempt"
    );
    assert!(
        is_qualified(&outcome, PastHuman, &graph_turn.attempt_id),
        "the Human of a Graph-derived attempt is unchanged: {outcome:#?}"
    );
    assert_turn_adopted(&outcome, &plain_turn);
    Ok(())
}

// DI1B-1: the production history budget and the entry for the D-final snapshot.
#[path = "nir1_history_budget_tests.rs"]
mod history_budget_tests;

// DI1B-2: the adoption rule on the outcome of a real session.
#[path = "nir1_history_adoption_session_tests.rs"]
mod history_adoption_session_tests;

// DI1B-3: the history in D-final.
#[path = "nir1_history_packing_session_tests.rs"]
mod history_packing_session_tests;
