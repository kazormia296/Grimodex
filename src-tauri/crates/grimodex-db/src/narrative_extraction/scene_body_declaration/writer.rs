//! The declaration writer (CB-2, DR-CB2-2, DR-CB2-3).
//!
//! [`declare_scene_body`] runs after Main's confirmation was consumed. It opens
//! one bounded `BEGIN IMMEDIATE` transaction and, inside it, in this order:
//!
//! 1. the idempotency ledger (a recorded response for the same request and
//!    payload is returned; another payload under the same request ID is a
//!    conflict);
//! 2. the exact Ready lifecycle binding;
//! 3. the Scene's current facts, with the body digests computed again from the
//!    bytes read here;
//! 4. the consumed binding against those facts, item by item, then the
//!    confirmation text's digest against the text rebuilt here;
//! 5. the declaration ID (UUIDv4 from the OS CSPRNG) and time, both generated
//!    here and never taken from the request;
//! 6. the one statement that sets the two declaration columns, the change
//!    feed event (its own kind) with its canonical event, and the idempotency
//!    record;
//! 7. the lifecycle binding once more, immediately before COMMIT: a stop seen
//!    before COMMIT rolls back.
//!
//! COMMIT runs inside the participant scope, outside every lifecycle lock. The
//! caller's `ActiveWorkspaceSnapshot` keeps the participant until the
//! terminal evidence (see `commit_outcome`) is in the result. Nothing is
//! retried.
//!
//! The v1 columns of the row (`version`, `source_token`, `updated_at`, the A1
//! columns) and `tree_nodes` are never written.

use std::cell::{Cell, RefCell};
use std::panic::{catch_unwind, AssertUnwindSafe};

use anyhow::{anyhow, Result};
use chrono::{SecondsFormat, Utc};
use grimodex_core::narrative_scene_body_declaration::{
    NarrativeSceneBodyDeclarationBindingV1, NarrativeSceneBodyDeclarationV1,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use uuid::Uuid;

use super::binding::{
    declaration_values_digest, BodyDeclarationBinding, ConsumedBodyDeclarationBinding,
    DeclareRefusal, DeclareRequest, DeclareResponse, StateComponent, DECLARE_IDEMPOTENCY_DOMAIN,
};
use super::commit_outcome::{settle, DeclarationTerminalEvidence, Settled, WriteIdentifiers};
use super::facts::{
    check_expected_occ, ensure_no_sql_owner, ensure_not_quarantined, read_scene_facts_in_tx,
    refusal_from_error, refuse, WorkspaceFacts,
};
use super::{canonical_scene_body_declaration_snapshot, scene_body_declaration_feed_event};
use crate::change_events::AppendChangeEvent;
use crate::idempotency::{
    canonical_write_payload_fingerprint, insert_idempotent_response, load_idempotent_response,
    IdempotencyRequest,
};
use crate::narrative_extraction::change_feed::{
    append_canonical_and_narrative_change_in_tx, AppendNarrativeChangeTransactionInput,
    NarrativeChangeCauseKind, NarrativeChangeEventInput, NarrativeChangeOrigin,
};
use crate::nir1_generation::{
    bounded_write, error_chain_contains, Nir1AdmissionSqlBudget, Nir1CommitState,
};
use crate::state::ActiveWorkspaceSnapshot;

/// Marker the idempotency ledger raises when a request ID is reused with
/// another payload.
pub(super) const REQUEST_CONFLICT_MARKER: &str = "NEX_BODY_DECLARATION_REQUEST_CONFLICT";

/// A successful declaration.
#[derive(Debug)]
pub struct DeclareOutcome {
    pub response: DeclareResponse,
    /// The ledger already held this request's response; nothing was written.
    pub replayed: bool,
    /// COMMIT's outcome was unknown and the reread proved the write is there.
    pub recovered_after_unknown_commit: bool,
    pub evidence: DeclarationTerminalEvidence,
}

/// A refused declaration. `evidence` is present when a write transaction ran.
#[derive(Debug)]
pub struct DeclareFailure {
    pub refusal: DeclareRefusal,
    pub evidence: Option<DeclarationTerminalEvidence>,
}

impl DeclareFailure {
    fn before_write(refusal: DeclareRefusal) -> Self {
        Self {
            refusal,
            evidence: None,
        }
    }
}

enum Written {
    Declared,
    Replayed(DeclareResponse),
}

/// Places in the write at which a test injects a failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[cfg_attr(not(test), allow(dead_code))]
pub(super) enum Stage {
    BeforeUpdate,
    AfterUpdate,
    AfterFeed,
    AfterIdempotency,
}

/// Test-only fault injection between the statements of a write. In a product
/// build it does nothing.
pub(super) fn inject(
    stage: Stage,
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
) -> Result<()> {
    #[cfg(test)]
    {
        if stage == Stage::AfterUpdate && test_hooks::MUTATE_UPDATED_AT_AFTER_UPDATE.with(Cell::get)
        {
            mutate_updated_at_for_test(conn, project_id, scene_id)?;
        }
        test_hooks::AT_STAGE.with(|slot| {
            if let Some((hook_stage, hook)) = slot.borrow().as_ref() {
                if *hook_stage == stage {
                    hook();
                }
            }
        });
        if test_hooks::FAIL_AT.with(Cell::get) == Some(stage) {
            return Err(anyhow!("injected failure at {stage:?}"));
        }
    }
    #[cfg(not(test))]
    let _ = (stage, conn, project_id, scene_id);
    Ok(())
}

pub(super) fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(super) fn writer_refusal(error: &anyhow::Error, cancel_requested: bool) -> DeclareRefusal {
    if error_chain_contains(error, REQUEST_CONFLICT_MARKER) {
        return DeclareRefusal::RequestConflict;
    }
    refusal_from_error(error, cancel_requested)
}

/// The one statement that sets the two declaration columns. It is the only
/// production statement that writes a non-NULL declaration. It writes nothing
/// but the two columns; the other conditions make it a compare-and-set on the
/// state the confirmation was bound to.
fn set_declaration_columns(
    conn: &Connection,
    binding: &BodyDeclarationBinding,
    declaration_json: &str,
    declaration_token: &str,
) -> Result<()> {
    let changed = conn.execute(
        "UPDATE narrative_scene_scope_bindings
            SET body_declaration_json = ?3, body_declaration_token = ?4
          WHERE project_id = ?1 AND scene_id = ?2
            AND scene_incarnation_id = ?5 AND version = ?6 AND source_token = ?7
            AND body_declaration_token IS ?8",
        params![
            binding.project_id,
            binding.scene_id,
            declaration_json,
            declaration_token,
            binding.scene_incarnation_id,
            binding.scope_version,
            binding.scope_token,
            binding.declaration_token,
        ],
    )?;
    if changed != 1 {
        return refuse(DeclareRefusal::StateChanged(
            StateComponent::DeclarationToken,
        ));
    }
    Ok(())
}

/// What one change of the declaration columns reports to the feed.
pub(super) struct DeclarationChange<'a> {
    pub project_id: &'a str,
    pub scene_id: &'a str,
    pub request_id: &'a str,
    /// `declare` or `revoke`.
    pub operation: &'a str,
    pub event_uid: &'a str,
    pub before: &'a Value,
    pub after: &'a Value,
}

/// Appends the canonical event and the declaration-kind feed event for one
/// change of the declaration columns, in the caller's transaction.
pub(super) fn append_declaration_change(
    conn: &Connection,
    change: &DeclarationChange<'_>,
) -> Result<()> {
    let DeclarationChange {
        project_id,
        scene_id,
        request_id,
        operation,
        event_uid,
        before,
        after,
    } = *change;
    let op_type = format!("scene.body-declaration.{operation}");
    let occurred_at = now_rfc3339();
    let event: NarrativeChangeEventInput =
        scene_body_declaration_feed_event(scene_id, before, after)?;
    append_canonical_and_narrative_change_in_tx(
        conn,
        project_id,
        "native-scene-body-declaration",
        &AppendChangeEvent {
            event_uid: event_uid.to_owned(),
            scene_id: Some(scene_id.to_owned()),
            domain: "narrative".to_owned(),
            op_type: op_type.clone(),
            entity_type: Some("scene_body_declaration".to_owned()),
            entity_id: Some(scene_id.to_owned()),
            payload: json!({ "requestId": request_id, "sceneId": scene_id }).to_string(),
            timestamp: Utc::now().timestamp_millis(),
        },
        &AppendNarrativeChangeTransactionInput {
            project_id: project_id.to_owned(),
            request_id: format!("scene-body-declaration:{operation}:{request_id}"),
            source_domain: op_type,
            source_change_event_uid: event_uid.to_owned(),
            cause_kind: NarrativeChangeCauseKind::Forward,
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            commit_id: None,
            journal_id: None,
            undo_journal_id: None,
            application_ids: Vec::new(),
            occurred_at,
            events: vec![event],
        },
    )?;
    Ok(())
}

/// Writes one declaration. See the module documentation for the order of the
/// steps and for what each failure means.
pub fn declare_scene_body(
    workspace: &ActiveWorkspaceSnapshot,
    consumed: ConsumedBodyDeclarationBinding,
    request: DeclareRequest,
    budget: &Nir1AdmissionSqlBudget,
) -> Result<DeclareOutcome, DeclareFailure> {
    request.validate().map_err(DeclareFailure::before_write)?;
    ensure_no_sql_owner().map_err(DeclareFailure::before_write)?;
    ensure_not_quarantined(workspace).map_err(DeclareFailure::before_write)?;
    let workspace_facts =
        WorkspaceFacts::from_snapshot(workspace).map_err(DeclareFailure::before_write)?;

    // The request must be the one the confirmation was bound to.
    let bound = consumed.binding();
    if bound.project_id != request.project_id || bound.scene_id != request.scene_id {
        return Err(DeclareFailure::before_write(DeclareRefusal::StateChanged(
            StateComponent::Request,
        )));
    }
    check_expected_occ(&request, bound).map_err(DeclareFailure::before_write)?;
    let values_digest = declaration_values_digest(&request.values)
        .map_err(|_| DeclareFailure::before_write(DeclareRefusal::Internal))?;
    if bound.values_digest != values_digest {
        return Err(DeclareFailure::before_write(DeclareRefusal::StateChanged(
            StateComponent::Values,
        )));
    }

    let payload_hash = canonical_write_payload_fingerprint(DECLARE_IDEMPOTENCY_DOMAIN, &request)
        .map_err(|_| DeclareFailure::before_write(DeclareRefusal::Internal))?;
    let idempotency = IdempotencyRequest {
        domain: DECLARE_IDEMPOTENCY_DOMAIN,
        request_id: Some(&request.request_id),
        payload_hash: &payload_hash,
        conflict_marker: REQUEST_CONFLICT_MARKER,
    };
    let event_uid = Uuid::new_v4().hyphenated().to_string();
    let token_after: RefCell<Option<String>> = RefCell::new(None);
    let ready = Cell::new(false);

    let sql_budget = budget.sql_budget();
    let checkpoint_budget = sql_budget.clone();
    let participant = workspace.participant();
    let write = catch_unwind(AssertUnwindSafe(|| {
        bounded_write(
            workspace,
            budget.fence(),
            sql_budget,
            budget.failpoint(),
            |conn| -> Result<Written> {
                #[cfg(test)]
                test_hooks::TRANSACTIONS_OPENED.with(|count| count.set(count.get() + 1));

                if let Some(recorded) = load_idempotent_response(conn, &idempotency)? {
                    let Some(response) = DeclareResponse::from_recorded(&recorded) else {
                        return refuse(DeclareRefusal::Internal);
                    };
                    ready.set(true);
                    return Ok(Written::Replayed(response));
                }
                if workspace.check_current_binding().is_err() {
                    return refuse(DeclareRefusal::WorkspaceMismatch);
                }
                let mut checkpoint = || checkpoint_budget.check(participant);
                let current = read_scene_facts_in_tx(
                    conn,
                    &workspace_facts,
                    &request.project_id,
                    &request.scene_id,
                    &request.values,
                    &mut checkpoint,
                )?;
                if let Some(component) = bound.first_difference(&current.binding) {
                    return refuse(DeclareRefusal::StateChanged(component));
                }
                if bound.display_digest != current.binding.display_digest {
                    return refuse(DeclareRefusal::DisplayMismatch);
                }

                // Generated here, inside the transaction, and nowhere else.
                let declaration = NarrativeSceneBodyDeclarationV1::new(
                    Uuid::new_v4().hyphenated().to_string(),
                    now_rfc3339(),
                    NarrativeSceneBodyDeclarationBindingV1 {
                        project_id: current.binding.project_id.clone(),
                        scene_id: current.binding.scene_id.clone(),
                        scene_incarnation_id: current.binding.scene_incarnation_id.clone(),
                        scope_source_token: current.binding.scope_token.clone(),
                        body_source: current.binding.body_source.clone(),
                        title_digest: current.binding.title_digest.clone(),
                        workspace_id: current.binding.workspace_id.clone(),
                        canonical_locator_digest: current.binding.canonical_locator_digest.clone(),
                    },
                )?;
                let declaration_json = declaration.canonical_json()?;
                let declaration_token = declaration.token()?;

                let before = canonical_scene_body_declaration_snapshot(
                    conn,
                    &request.project_id,
                    &request.scene_id,
                )?;
                inject(
                    Stage::BeforeUpdate,
                    conn,
                    &request.project_id,
                    &request.scene_id,
                )?;
                set_declaration_columns(conn, bound, &declaration_json, &declaration_token)?;
                inject(
                    Stage::AfterUpdate,
                    conn,
                    &request.project_id,
                    &request.scene_id,
                )?;
                let after = canonical_scene_body_declaration_snapshot(
                    conn,
                    &request.project_id,
                    &request.scene_id,
                )?;
                append_declaration_change(
                    conn,
                    &DeclarationChange {
                        project_id: &request.project_id,
                        scene_id: &request.scene_id,
                        request_id: &request.request_id,
                        operation: "declare",
                        event_uid: &event_uid,
                        before: &before,
                        after: &after,
                    },
                )?;
                inject(
                    Stage::AfterFeed,
                    conn,
                    &request.project_id,
                    &request.scene_id,
                )?;
                insert_idempotent_response(
                    conn,
                    &idempotency,
                    &request.project_id,
                    &DeclareResponse::Declared.recorded(),
                )?;
                inject(
                    Stage::AfterIdempotency,
                    conn,
                    &request.project_id,
                    &request.scene_id,
                )?;

                // A stop or a lifecycle edge seen before COMMIT rolls back.
                if workspace.check_current_binding().is_err() {
                    return refuse(DeclareRefusal::WorkspaceMismatch);
                }
                *token_after.borrow_mut() = Some(declaration_token);
                ready.set(true);
                #[cfg(test)]
                if test_hooks::PANIC_AFTER_READY.with(Cell::get) {
                    panic!("injected panic after the transaction was ready to COMMIT");
                }
                Ok(Written::Declared)
            },
        )
    }));
    let result = match write {
        Ok(result) => result,
        Err(_) if ready.get() => Err((
            anyhow!("NEX_BODY_DECLARATION_PANIC_AFTER_READY"),
            Nir1CommitState::Unknown,
        )),
        Err(_) => Err((
            anyhow!("NEX_BODY_DECLARATION_PANIC_BEFORE_COMMIT"),
            Nir1CommitState::NotCommitted,
        )),
    };

    let token_after = token_after.take();
    let ids = WriteIdentifiers {
        domain: DECLARE_IDEMPOTENCY_DOMAIN,
        request_id: &request.request_id,
        payload_hash: &payload_hash,
        project_id: &request.project_id,
        scene_id: &request.scene_id,
        event_uid: &event_uid,
        token_before: bound.declaration_token.as_deref(),
        token_after: token_after.as_deref(),
    };
    match settle(workspace, &ids, result) {
        Settled::Committed { value, evidence } => Ok(match value {
            Written::Declared => DeclareOutcome {
                response: DeclareResponse::Declared,
                replayed: false,
                recovered_after_unknown_commit: false,
                evidence,
            },
            Written::Replayed(response) => DeclareOutcome {
                response,
                replayed: true,
                recovered_after_unknown_commit: false,
                evidence,
            },
        }),
        Settled::Recovered { evidence } => Ok(DeclareOutcome {
            response: DeclareResponse::Declared,
            replayed: false,
            recovered_after_unknown_commit: true,
            evidence,
        }),
        Settled::NotCommitted { error, evidence } => Err(DeclareFailure {
            refusal: writer_refusal(&error, budget.cancel_requested()),
            evidence: Some(evidence),
        }),
        Settled::CommitFailed { evidence } => Err(DeclareFailure {
            refusal: DeclareRefusal::CommitFailed,
            evidence: Some(evidence),
        }),
        Settled::Quarantined { evidence } => Err(DeclareFailure {
            refusal: DeclareRefusal::RestartRequired,
            evidence: Some(evidence),
        }),
    }
}

/// A test-only mutation that models a writer which also rewrites `updated_at`
/// (the forbidden change): the v1 token check must then fail.
#[cfg(test)]
fn mutate_updated_at_for_test(conn: &Connection, project_id: &str, scene_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE narrative_scene_scope_bindings SET updated_at = '2099-01-01T00:00:00.000Z'
          WHERE project_id = ?1 AND scene_id = ?2",
        params![project_id, scene_id],
    )?;
    Ok(())
}

#[cfg(test)]
pub(super) mod test_hooks {
    use super::Stage;
    use std::cell::{Cell, RefCell};

    type StageHook = Box<dyn Fn()>;

    thread_local! {
        pub(crate) static AT_STAGE: RefCell<Option<(Stage, StageHook)>> = const { RefCell::new(None) };
        pub(crate) static FAIL_AT: Cell<Option<Stage>> = const { Cell::new(None) };
        pub(crate) static MUTATE_UPDATED_AT_AFTER_UPDATE: Cell<bool> = const { Cell::new(false) };
        pub(crate) static PANIC_AFTER_READY: Cell<bool> = const { Cell::new(false) };
        pub(crate) static TRANSACTIONS_OPENED: Cell<usize> = const { Cell::new(0) };
    }

    pub(crate) fn fail_at(stage: Option<Stage>) {
        FAIL_AT.with(|slot| slot.set(stage));
    }

    /// Runs `hook` inside the write transaction when it reaches `stage`.
    pub(crate) fn at_stage(stage: Stage, hook: Option<StageHook>) {
        AT_STAGE.with(|slot| *slot.borrow_mut() = hook.map(|hook| (stage, hook)));
    }

    pub(crate) fn mutate_updated_at(enabled: bool) {
        MUTATE_UPDATED_AT_AFTER_UPDATE.with(|slot| slot.set(enabled));
    }

    pub(crate) fn panic_after_ready(enabled: bool) {
        PANIC_AFTER_READY.with(|slot| slot.set(enabled));
    }

    pub(crate) fn transactions_opened() -> usize {
        TRANSACTIONS_OPENED.with(Cell::get)
    }

    pub(crate) fn reset() {
        at_stage(Stage::BeforeUpdate, None);
        fail_at(None);
        mutate_updated_at(false);
        panic_after_ready(false);
        TRANSACTIONS_OPENED.with(|count| count.set(0));
    }
}
