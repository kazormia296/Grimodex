//! One variant, end to end: its workspace is built by product writers in the
//! order the draft requires, the profile is restricted, every request is made
//! through D-final, and the setup receipt case and the receipt requests come
//! out as JSON in the shapes `receipt.mjs` validates.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Map, Value};

use super::fixture::{
    validate_variant_setup, CaseSpec, EntitySpec, Fixture, SceneSpec, Step, VariantSpec,
    SCENE_SCOPE_UNKNOWN_WRITE,
};
use super::workspace::{CaseWorkspace, PreparedRevision};
use crate::nir1_prepared_request::nir1_final_request_eval::run_dfinal_with_capture;
use crate::nir1_prepared_request::tests::{prepare_local_chat_request, NO_UNSUPPORTED_INPUTS};

const HISTORY_REASON: &str = "not-applicable";
const WRITER_RESTRICTED: &str = "activate_first_restricted_publication";

/// Strictly increasing setup events (`receipt.mjs` `validateSetupEvent`).
#[derive(Default)]
struct EventLog {
    events: Vec<Value>,
    seq: u64,
}

impl EventLog {
    fn push(
        &mut self,
        stage: u32,
        kind: &str,
        writer: &str,
        logical_id: Option<&str>,
        runtime_id: Option<&str>,
        binding: Option<&str>,
    ) -> u64 {
        self.seq += 1;
        let mut event = Map::new();
        event.insert("seq".into(), json!(self.seq));
        event.insert("stage".into(), json!(stage));
        event.insert("kind".into(), json!(kind));
        event.insert("writer".into(), json!(writer));
        if let Some(value) = logical_id {
            event.insert("logicalId".into(), json!(value));
        }
        if let Some(value) = runtime_id {
            event.insert("runtimeId".into(), json!(value));
        }
        if let Some(value) = binding {
            event.insert("binding".into(), json!(value));
        }
        self.events.push(Value::Object(event));
        self.seq
    }

    /// The seq of the last event of `stage` of one of `kinds`.
    fn last_seq_of(&self, stage: u32, kinds: &[&str]) -> Option<u64> {
        self.events
            .iter()
            .rev()
            .find(|event| {
                event["stage"] == json!(stage)
                    && event["kind"]
                        .as_str()
                        .is_some_and(|kind| kinds.contains(&kind))
            })
            .and_then(|event| event["seq"].as_u64())
    }
}

#[derive(Default)]
struct IdMap {
    rows: Vec<Map<String, Value>>,
    runtime: HashMap<String, String>,
}

impl IdMap {
    fn add(&mut self, logical_id: &str, runtime_id: &str) {
        let mut row = Map::new();
        row.insert("logicalId".into(), json!(logical_id));
        row.insert("runtimeId".into(), json!(runtime_id));
        self.rows.push(row);
        self.runtime
            .insert(logical_id.to_owned(), runtime_id.to_owned());
    }

    fn set(&mut self, logical_id: &str, key: &str, value: &str) {
        if let Some(row) = self
            .rows
            .iter_mut()
            .find(|row| row["logicalId"] == json!(logical_id))
        {
            row.insert(key.into(), json!(value));
        }
    }

    fn runtime_of(&self, logical_id: &str) -> Result<&str> {
        self.runtime
            .get(logical_id)
            .map(String::as_str)
            .with_context(|| format!("{logical_id} has no runtime id yet"))
    }

    fn to_json(&self) -> Value {
        Value::Array(self.rows.iter().cloned().map(Value::Object).collect())
    }
}

/// What a finished variant hands to the receipt writers.
pub(super) struct VariantOutcome {
    pub(super) variant_id: String,
    pub(super) setup_case: Value,
    pub(super) requests: Vec<Value>,
    /// Observed per request, for the harness's own tests (not a receipt field).
    pub(super) dfinal: Vec<crate::nir1_prepared_request::nir1_final_request_eval::DfinalOutcome>,
    pub(super) request_phase_changes: Vec<(String, String)>,
    pub(super) direct_writes: Vec<String>,
}

struct Runner<'a> {
    fixture: &'a Fixture,
    case: &'a CaseSpec,
    variant: &'a VariantSpec,
    ws: CaseWorkspace,
    log: EventLog,
    ids: IdMap,
    prepared: HashMap<String, PreparedRevision>,
    /// revision logical id -> entity logical id (from the prepare steps).
    revision_entity: HashMap<String, String>,
    sessions: HashMap<u32, String>,
    session_statements_match: bool,
    invoked_writers: Vec<String>,
    /// revision logical id -> the stage that prepared it.
    prepared_stage: HashMap<String, u32>,
    /// Stages whose first (positive) prepare has happened: no data write may
    /// follow it in that stage.
    positive_prepared_stages: HashSet<u32>,
}

fn nonempty(value: &Option<String>, what: &str) -> Result<String> {
    value
        .clone()
        .filter(|text| !text.is_empty())
        .with_context(|| format!("step has no {what}"))
}

impl<'a> Runner<'a> {
    fn note_writer(&mut self, writer: &str) {
        if !self.invoked_writers.iter().any(|known| known == writer) {
            self.invoked_writers.push(writer.to_owned());
        }
    }

    fn anchor_runtime(&self) -> Result<String> {
        Ok(self
            .ids
            .runtime_of(&self.case.anchor_scene()?.logical_id)?
            .to_owned())
    }

    fn query_runtime(&self) -> Result<String> {
        let query = self
            .case
            .setup
            .scenes
            .iter()
            .find(|scene| scene.role == "query")
            .with_context(|| format!("{} has no query scene", self.case.case_id))?;
        Ok(self.ids.runtime_of(&query.logical_id)?.to_owned())
    }

    /// Tree, Scope and Codex writes: the first group of setup events.
    fn base_writes(&mut self) -> Result<()> {
        self.ws.write_route(
            &self.fixture.route.model,
            self.fixture.route.context_window_tokens,
            self.fixture.route.output_tokens,
        )?;
        self.note_writer("write_ai_settings");
        self.log
            .push(1, "route-settings", "write_ai_settings", None, None, None);

        // The case's own project, created by the product's project writer: its
        // id is in no other case's payload (the scorer scans for other cases'
        // runtime ids). `project_create` is in the scorer's writer list, so the
        // write is a tree event like the Scene writes.
        let project = self
            .ws
            .write_project(&format!("DP-H {}", self.case.case_id))?;
        self.ids.add(&self.case.setup.project.logical_id, &project);
        self.note_writer("project_create");
        self.log.push(
            1,
            "tree",
            "project_create",
            Some(&self.case.setup.project.logical_id),
            Some(&project),
            None,
        );

        // The case's Scenes, then a reject variant's own negative-anchor Scene
        // (DR-DPH-99), after them in reading order.
        let scenes: Vec<&SceneSpec> = self
            .case
            .setup
            .scenes
            .iter()
            .chain(self.variant.setup.scenes.iter())
            .collect();
        for (index, scene) in scenes.iter().enumerate() {
            let runtime = self
                .ws
                .write_scene(&scene.title, &format!("a{index}"), &scene.body)?;
            self.ids.add(&scene.logical_id, &runtime);
            self.note_writer("tree_node_create");
            self.log.push(
                1,
                "tree",
                "tree_node_create",
                Some(&scene.logical_id),
                Some(&runtime),
                None,
            );
        }
        let anchor = self.anchor_runtime()?;
        self.ws.write_scope_registry(
            &anchor,
            Some(&self.fixture.setup_contract.scene_scope.registry),
            None,
        )?;
        self.note_writer("narrative_scene_scope_registry_update");
        self.log.push(
            1,
            "scope",
            "narrative_scene_scope_registry_update",
            None,
            None,
            None,
        );
        for scene in &scenes {
            let runtime = self.ids.runtime_of(&scene.logical_id)?.to_owned();
            self.ws
                .write_scene_scope(&runtime, &self.fixture.setup_contract.scene_scope.per_scene)?;
            self.log.push(
                1,
                "scope",
                "narrative_scene_scope_update",
                Some(&scene.logical_id),
                Some(&runtime),
                None,
            );
        }
        self.note_writer("narrative_scene_scope_update");
        let entities: Vec<EntitySpec> = self
            .case
            .setup
            .codex_entities
            .iter()
            .chain(self.variant.setup.codex_entities.iter())
            .cloned()
            .collect();
        for entity in &entities {
            let runtime =
                self.ws
                    .write_codex_entity(&entity.type_slug, &entity.name, &entity.summary)?;
            self.ids.add(&entity.logical_id, &runtime);
            self.note_writer("codex_create");
            self.log.push(
                1,
                "codex",
                "codex_create",
                Some(&entity.logical_id),
                Some(&runtime),
                None,
            );
        }
        Ok(())
    }

    fn settle(&mut self) -> Result<()> {
        let steps = self.ws.run_product_maintenance(12)?;
        ensure!(
            !steps.is_empty(),
            "the product maintenance owner ran no step"
        );
        Ok(())
    }

    fn prepared_of(&self, revision: &str) -> Result<&PreparedRevision> {
        self.prepared
            .get(revision)
            .with_context(|| format!("{revision} was not prepared"))
    }

    fn exec_step(&mut self, step: &Step) -> Result<()> {
        let stage = step.stage;
        match step.op.as_str() {
            "prepare" | "prepare-negative" => {
                let revision = nonempty(&step.revision, "revision")?;
                let entity = nonempty(&step.entity, "entity")?;
                let anchor_logical = nonempty(&step.anchor_scene, "anchorScene")?;
                let key = nonempty(&step.proposal_key, "proposalKey")?;
                let anchor = self.ids.runtime_of(&anchor_logical)?.to_owned();
                let entity_runtime = self.ids.runtime_of(&entity)?.to_owned();
                let prepared = self.ws.prepare_revision(&anchor, &entity_runtime, &key)?;
                self.ids.add(&revision, &prepared.revision_id);
                self.ids.set(&revision, "proposalId", &prepared.proposal_id);
                self.revision_entity.insert(revision.clone(), entity);
                self.prepared_stage.insert(revision.clone(), stage);
                if step.op == "prepare" {
                    self.positive_prepared_stages.insert(stage);
                }
                self.note_writer("nir1_entity_relation_revision_prepare");
                self.log.push(
                    stage,
                    &step.op,
                    "nir1_entity_relation_revision_prepare",
                    Some(&revision),
                    Some(&prepared.revision_id),
                    None,
                );
                self.prepared.insert(revision, prepared);
            }
            "approve" | "approve-negative" => {
                let revision = nonempty(&step.revision, "revision")?;
                let prepared = self.prepared_of(&revision)?.clone();
                // An approval belongs to the Revision prepared in the same
                // stage: an old Revision is never approved again to make it
                // eligible (draft: 旧 Revision に Decision を足して適格に戻した
                // としない).
                ensure!(
                    self.prepared_stage.get(&revision) == Some(&stage),
                    "NIR1_EVAL_SETUP_REAPPROVAL_OF_OLD_REVISION: {revision} was not prepared in stage {stage}"
                );
                let decision = step.decision.clone().unwrap_or_else(|| "approved".into());
                let decided = self.ws.append_decision(
                    &prepared,
                    &decision,
                    step.decision_json.as_ref(),
                    step.created_by.as_deref().unwrap_or("dph-reviewer"),
                )?;
                let decision_id = decided["decisionId"]
                    .as_str()
                    .context("the decision writer returned no decisionId")?
                    .to_owned();
                self.ids.set(&revision, "decisionId", &decision_id);
                self.note_writer("narrative_extraction_append_human_decision");
                self.log.push(
                    stage,
                    &step.op,
                    "narrative_extraction_append_human_decision",
                    Some(&revision),
                    Some(&prepared.revision_id),
                    None,
                );
            }
            "invalidate-negative" | "binding-change" => {
                ensure!(
                    !self.positive_prepared_stages.contains(&stage),
                    "NIR1_EVAL_SETUP_WRITE_AFTER_FIRST_PREPARE: {} follows the first prepare of stage {stage}",
                    step.op
                );
                let kind = step.op.clone();
                let write = nonempty(&step.write, "write")?;
                let (writer, logical, runtime) = match write.as_str() {
                    "scene-scope-registry-update" => {
                        let reference = nonempty(&step.add_timeline_ref, "addTimelineRef")?;
                        let anchor = self.anchor_runtime()?;
                        self.ws
                            .write_scope_registry(&anchor, None, Some(&reference))?;
                        ("narrative_scene_scope_registry_update", None, None)
                    }
                    SCENE_SCOPE_UNKNOWN_WRITE => {
                        // The negative's own anchor Scene turns unknown
                        // (`validate_variant_setup` checked the target).
                        ensure!(
                            kind == "invalidate-negative",
                            "{SCENE_SCOPE_UNKNOWN_WRITE} is an invalidate-negative write only"
                        );
                        let scene = nonempty(&step.scene, "scene")?;
                        let reason = nonempty(&step.unresolved_reason, "unresolvedReason")?;
                        let runtime = self.ids.runtime_of(&scene)?.to_owned();
                        self.ws.write_scene_scope_unknown(
                            &runtime,
                            &self.fixture.setup_contract.scene_scope.per_scene,
                            &reason,
                        )?;
                        ("narrative_scene_scope_update", None, None)
                    }
                    "codex-update" => {
                        let entity = nonempty(&step.entity, "entity")?;
                        let summary = nonempty(&step.summary, "summary")?;
                        let runtime = self.ids.runtime_of(&entity)?.to_owned();
                        self.ws.write_codex_summary(&runtime, &summary)?;
                        ("codex_update", None, None)
                    }
                    "decision-cancel" => {
                        let revision = nonempty(&step.revision, "revision")?;
                        let prepared = self.prepared_of(&revision)?.clone();
                        let decision = step.decision.clone().unwrap_or_else(|| "rejected".into());
                        self.ws
                            .append_decision(&prepared, &decision, None, "dph-reviewer")?;
                        (
                            "narrative_extraction_append_human_decision",
                            Some(revision),
                            Some(prepared.revision_id),
                        )
                    }
                    other => bail!("unknown setup write {other}"),
                };
                // A negative's invalidation names the negative Revision; a
                // binding change names the Revision it changed, if any.
                let (logical, runtime) = if kind == "invalidate-negative" {
                    let revision = nonempty(&step.revision, "revision")?;
                    let runtime = self.ids.runtime_of(&revision)?.to_owned();
                    (Some(revision), Some(runtime))
                } else {
                    (logical, runtime)
                };
                self.note_writer(writer);
                self.log.push(
                    stage,
                    &kind,
                    writer,
                    logical.as_deref(),
                    runtime.as_deref(),
                    step.binding.as_deref().filter(|_| kind == "binding-change"),
                );
                self.settle()?;
            }
            other => bail!("unknown setup step {other}"),
        }
        Ok(())
    }

    fn exec_stage_steps(&mut self, stage: u32) -> Result<()> {
        let steps: Vec<Step> = self
            .variant
            .setup
            .steps
            .iter()
            .filter(|step| step.stage == stage)
            .cloned()
            .collect();
        for step in &steps {
            self.exec_step(step)?;
        }
        ensure!(
            self.positive_prepared_stages.contains(&stage),
            "NIR1_EVAL_SETUP_STAGE_WITHOUT_NEW_REVISION: stage {stage} prepared no typed Revision"
        );
        Ok(())
    }

    fn verification_row(
        &self,
        point: &str,
        stage: u32,
        revision_ids: &[String],
        query_scene: &str,
    ) -> Result<(Value, Vec<super::workspace::RevisionReading>)> {
        let mut revisions = Vec::new();
        let mut readings = Vec::new();
        let mut scope_authority = None;
        for logical in revision_ids {
            let runtime = self.ids.runtime_of(logical)?.to_owned();
            let reading = self.ws.read_revision(&runtime, query_scene)?;
            if scope_authority.is_none() {
                scope_authority = reading.scope_authority_revision.clone();
            }
            revisions.push(json!({
                "logicalId": logical,
                "runtimeId": runtime,
                "a2": reading.a2,
                "a3": reading.a3,
                "freshness": reading.freshness,
            }));
            readings.push(reading);
        }
        let d2a = self.ws.restricted_state();
        Ok((
            json!({
                "point": point,
                "stage": stage,
                "revisions": revisions,
                "scopeAuthorityRevision": scope_authority.unwrap_or_else(|| "unavailable".into()),
                "d2a": { "restricted": d2a.restricted, "inFlightStopped": d2a.in_flight_stopped },
            }),
            readings,
        ))
    }
}

/// One variant at a time in the process: the product's scheduler-liveness
/// receipt that the canonical cut-over reads is a process-wide slot.
static ONE_VARIANT_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Runs one variant. `setup_error` cases (a product writer failed, a Revision
/// that must be eligible is not) return `Err`: such a variant has no receipt
/// and the whole run is invalid.
pub(super) fn run_variant(
    fixture: &Fixture,
    case: &CaseSpec,
    variant: &VariantSpec,
) -> Result<VariantOutcome> {
    // The setup shapes are checked before any workspace exists (DR-DPH-102).
    validate_variant_setup(fixture, case, variant)?;
    let _exclusive = ONE_VARIANT_AT_A_TIME
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let namespace = format!("{}/{}", case.isolation.workspace_id, variant.variant_id);
    let ws = CaseWorkspace::open(&namespace)?;
    let mut runner = Runner {
        fixture,
        case,
        variant,
        ws,
        log: EventLog::default(),
        ids: IdMap::default(),
        prepared: HashMap::new(),
        revision_entity: HashMap::new(),
        sessions: HashMap::new(),
        session_statements_match: true,
        invoked_writers: Vec::new(),
        prepared_stage: HashMap::new(),
        positive_prepared_stages: HashSet::new(),
    };
    let stages = variant.stages();
    let first_stage = *stages.first().context("a variant has no request")?;

    // 1. tree, Scope, Codex; then the product's own maintenance (epoch,
    //    freshness, canonical cut-over), which no renderer writer can do.
    runner.base_writes()?;
    runner.settle()?;
    // 2. the first stage's Revisions: prepare and approve last.
    runner.exec_stage_steps(first_stage)?;
    // The stage's setup-end row is taken here, right after its last data,
    // prepare or approve step and before the chat sessions and the restricted
    // activation, so a write those make (or a maintenance side effect) shows as
    // a change of the Scope authority revision against request-pre.
    let mut verifications = Vec::new();
    {
        let request = variant.request_for_stage(first_stage)?;
        let query_scene = runner.query_runtime()?;
        let (end_row, _) = runner.verification_row(
            "setup-end",
            first_stage,
            &request.revision_ids,
            &query_scene,
        )?;
        verifications.push(end_row);
    }
    // 3. every stage's chat session, with the renderer's statement, before the
    //    profile is restricted.
    for spec in &variant.setup.chat_sessions {
        let node = runner.ids.runtime_of(&spec.node_scene)?.to_owned();
        let (session, matches) = runner.ws.create_chat_session(&node, &spec.title)?;
        runner.session_statements_match &= matches;
        runner.note_writer("db_execute:createSession");
        runner.log.push(
            spec.stage,
            "chat-session",
            "db_execute:createSession",
            None,
            Some(&session),
            None,
        );
        runner.sessions.insert(spec.stage, session);
    }
    // 4. D2a: restricted after the setup writes, before the first capture.
    let caller = runner.ws.restrict_and_register_caller()?;
    runner.note_writer(WRITER_RESTRICTED);
    runner.log.push(
        first_stage,
        "restricted",
        WRITER_RESTRICTED,
        None,
        None,
        None,
    );
    let restricted_after = runner.ws.restricted_state();
    ensure!(
        restricted_after.restricted && restricted_after.in_flight_stopped,
        "the profile is not restricted with in-flight stopped after activation"
    );

    let mut requests_json = Vec::new();
    let mut runtime_values = Vec::new();
    let mut dfinal_outcomes = Vec::new();
    let mut request_changes = Vec::new();
    for &stage in &stages {
        if stage != first_stage {
            runner.exec_stage_steps(stage)?;
        }
        let request = variant.request_for_stage(stage)?;
        let query_scene = runner.query_runtime()?;
        if stage != first_stage {
            // A later stage's setup-end is its last step's state (the first
            // stage's was taken before the chat sessions).
            let (end_row, _) =
                runner.verification_row("setup-end", stage, &request.revision_ids, &query_scene)?;
            verifications.push(end_row);
        }
        let is_last = Some(&stage) == stages.last();
        let is_reject = variant.kind == "reject" && is_last;

        // Runtime values the expectations name, read from the state the
        // stage's setup left behind (a product reader), before the capture.
        let mut stage_revisions: Vec<(String, super::workspace::RevisionReading)> = Vec::new();
        for logical in &request.revision_ids {
            let runtime = runner.ids.runtime_of(logical)?.to_owned();
            stage_revisions.push((
                logical.clone(),
                runner.ws.read_revision(&runtime, &query_scene)?,
            ));
        }
        let resolved_at = runner
            .log
            .last_seq_of(stage, &["approve", "binding-change"])
            .or_else(|| runner.log.last_seq_of(stage, &["prepare"]))
            .context("the stage has no event to date its runtime values by")?;
        for spec in variant
            .setup
            .runtime_values
            .iter()
            .filter(|spec| spec.stage == stage)
        {
            let value = match spec.kind.as_str() {
                "revisionToken" => {
                    // The Scope authority revision the Revisions of the request
                    // carry in their own Scope bindings (the `scope.
                    // authorityRevision` of the rendered entries). All of them
                    // must agree: one value stands for the stage.
                    // A reject request's negative is left out: it may anchor
                    // its own Scene (DR-DPH-99), and it is not eligible.
                    let mut tokens: Vec<&String> = stage_revisions
                        .iter()
                        .filter(|(logical, _)| {
                            !(is_reject
                                && variant.ineligible_logical_id.as_deref()
                                    == Some(logical.as_str()))
                        })
                        .flat_map(|(_, reading)| reading.entity_scope_authority_revisions.iter())
                        .collect();
                    tokens.sort();
                    tokens.dedup();
                    ensure!(
                        tokens.len() == 1,
                        "the eligible Revisions of stage {stage} carry {} distinct Scope authority revisions, not one",
                        tokens.len()
                    );
                    tokens[0].clone()
                }
                "sourceToken" => {
                    let entity_runtime = runner.ids.runtime_of(&spec.logical_id)?.to_owned();
                    stage_revisions
                        .iter()
                        .flat_map(|(_, reading)| reading.source_tokens.iter())
                        .find(|(entity, _)| *entity == entity_runtime)
                        .map(|(_, token)| token.clone())
                        .with_context(|| {
                            format!(
                                "no read Revision carries a source token of {}",
                                spec.logical_id
                            )
                        })?
                }
                other => bail!("unknown runtime value kind {other}"),
            };
            runtime_values.push(json!({
                "kind": spec.kind,
                "logicalId": spec.logical_id,
                "stage": stage,
                "value": value,
                "source": "product-reader-function",
                "resolvedAtSeq": resolved_at,
            }));
        }

        // request-pre right before the capture.
        let (pre_row, pre_readings) =
            runner.verification_row("request-pre", stage, &request.revision_ids, &query_scene)?;
        verifications.push(pre_row);
        // Positive Revisions must be eligible and fresh at the request; the
        // reject variant's negative is the one that is not.
        for (index, reading) in pre_readings.iter().enumerate() {
            let logical = &request.revision_ids[index];
            let is_negative =
                is_reject && variant.ineligible_logical_id.as_deref() == Some(logical.as_str());
            let eligible = reading.a2 == "eligible"
                && reading.a3 == "eligible"
                && reading.freshness == "fresh";
            ensure!(
                eligible != is_negative,
                "{logical} is {} at request-pre of stage {stage}",
                if eligible { "eligible" } else { "not eligible" }
            );
        }

        runner
            .log
            .push(stage, "capture", WRITER_RESTRICTED, None, None, None);
        let passed: Vec<String> = request
            .revision_ids
            .iter()
            .map(|logical| runner.ids.runtime_of(logical).map(str::to_owned))
            .collect::<Result<_>>()?;
        let session = runner
            .sessions
            .get(&stage)
            .with_context(|| format!("stage {stage} has no chat session"))?
            .clone();

        let attempts_before = runner.ws.generation_attempt_count()?;
        let state = Arc::clone(&runner.ws.state);
        let query = query_scene.clone();
        let passed_for_call = passed.clone();
        let user_message = case.user_message.clone();
        let key = format!("{}-{}-{stage}", case.case_id, variant.variant_id);
        runner.ws.audit.begin_request_phase();
        let outcome = (|| -> Result<_> {
            let accepted =
                runner
                    .ws
                    .accept_submission(&caller, &session, &query, &user_message, &key)?;
            Ok(run_dfinal_with_capture(|| {
                prepare_local_chat_request(
                    Arc::clone(&state),
                    caller.clone(),
                    &query,
                    &accepted,
                    &passed_for_call,
                    NO_UNSUPPORTED_INPUTS,
                )
            }))
        })();
        runner.ws.audit.end_request_phase();
        let (record, _prepared) = outcome?;
        let attempts_after = runner.ws.generation_attempt_count()?;
        ensure!(
            record.defects.is_empty(),
            "the capture of {}/{} stage {stage} has defects: {}",
            case.case_id,
            variant.variant_id,
            record.defects.join("; ")
        );

        let capture = record.capture.as_deref();
        requests_json.push(json!({
            "requestId": format!("{}/{}/stage-{stage}", case.case_id, variant.variant_id),
            "caseId": case.case_id,
            "variantId": variant.variant_id,
            "requestKind": if is_reject { "reject" } else { "positive" },
            "stage": stage,
            "passedRevisionIds": passed,
            "dfinal": record.dfinal.to_json(),
            "capture": capture.map(|capture| capture.capture_json()),
            "candidate": capture.map(|capture| capture.candidate_arm_json()),
            "baseline": Value::Null,
            "history": { "inputCount": 0, "reason": HISTORY_REASON },
            "attemptRowsAdded": (attempts_after - attempts_before).max(0),
        }));
        dfinal_outcomes.push(record.dfinal.clone());
    }
    request_changes.extend(runner.ws.audit.request_changes());

    let direct_writes = runner.ws.audit.direct_writes();
    let writers_changed = runner.ws.audit.writers_that_changed_rows();
    let restricted_seq = runner
        .log
        .events
        .iter()
        .find(|event| event["kind"] == "restricted")
        .and_then(|event| event["seq"].as_u64())
        .unwrap_or(0);
    let sessions_before_restricted = runner
        .log
        .events
        .iter()
        .filter(|event| event["kind"] == "chat-session")
        .all(|event| event["seq"].as_u64().unwrap_or(u64::MAX) < restricted_seq);
    let valid = direct_writes.is_empty();
    let mut setup_case = Map::new();
    setup_case.insert("caseId".into(), json!(case.case_id));
    setup_case.insert("variantId".into(), json!(variant.variant_id));
    setup_case.insert("workspaceNamespace".into(), json!(namespace));
    setup_case.insert("events".into(), Value::Array(runner.log.events.clone()));
    setup_case.insert("writersUsed".into(), json!(runner.invoked_writers));
    setup_case.insert("directDmlObserved".into(), json!(!direct_writes.is_empty()));
    setup_case.insert("verifications".into(), Value::Array(verifications));
    setup_case.insert("idMap".into(), runner.ids.to_json());
    setup_case.insert(
        "chatSession".into(),
        json!({
            "writer": "db_execute:createSession",
            "statementMatchesRenderer": runner.session_statements_match,
            "createdBeforeRestricted": sessions_before_restricted,
        }),
    );
    setup_case.insert(
        "history".into(),
        json!({ "inputCount": 0, "reason": HISTORY_REASON }),
    );
    setup_case.insert("valid".into(), json!(valid));
    if !valid {
        setup_case.insert(
            "invalidReason".into(),
            json!(format!(
                "a database change was made outside every product writer during setup: {}",
                direct_writes.join(", ")
            )),
        );
    }
    setup_case.insert("runtimeValues".into(), Value::Array(runtime_values));
    setup_case.insert(
        "extensions".into(),
        json!({
            "rowChangingWriters": writers_changed,
            "directWrites": direct_writes,
            "maintenanceOwner": "narrative_maintenance_owner (Backend main-only maintenance API, driven as the Electron scheduler drives it)",
        }),
    );

    Ok(VariantOutcome {
        variant_id: variant.variant_id.clone(),
        setup_case: Value::Object(setup_case),
        requests: requests_json,
        dfinal: dfinal_outcomes,
        request_phase_changes: request_changes,
        direct_writes,
    })
}
