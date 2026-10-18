//! The session history run (HC1-4, K4/3 sections 6 and 8).
//!
//! One call re-authorizes the history of one chat session for the current
//! turn, entirely from the attempts stored in the session and the current
//! authorities read in the caller's snapshot. The caller supplies the turn's
//! budget, the current turn's context (the HS-1 builder's value) and the
//! cancel poll; nothing is written and nothing is taken from the renderer or
//! from a caller's claim of a session.
//!
//! * The candidates are derived from the listed attempts of the session, in
//!   the total order of the enumeration (newest first, then the attempt ID's
//!   bytes): the Human of an attempt's current turn (a past Human) and, when
//!   the attempt's receipt is a success, the attempt's generated output.
//!   An attempt whose binding or history slot is not usable is one excluded
//!   entry with its closed reason and is never read further.
//! * A past Human is a candidate by capture lineage, a generated output by
//!   the recursive requalification of its parent attempt; both are decided by
//!   the pure traversal with the production [`HistoryRequalifier`].
//! * An exhausted budget excludes the candidates whose verification was not
//!   finished and keeps the independent ones that were (K4/3 section 8). A
//!   session that cannot be listed within the budget, or whose attempts cannot
//!   be counted within it, goes on without history. The turn's SQL ledger
//!   (VM steps, deadline, busy) is the connection's progress handler: once it
//!   is spent the snapshot itself cannot be closed, so that exhaustion, a
//!   cancel and a timeout are the typed errors of the snapshot, not outcomes.
//!   [`reauthorize_session_history_for_turn_in_tx`] is the form the D-final
//!   snapshot calls (DI1B-1): the history's ledger being spent leaves the
//!   caller's own transaction open and usable (the spike
//!   `spike_outer_snapshot_survives_a_spent_history_sql_ledger`), so that
//!   exhaustion and a deadline become "this turn goes on without history"; a
//!   cancel and every other error (a busy or locked error included: that form
//!   waits for nothing) stay the typed error that stops the turn. The form
//!   that opens its own transaction ([`reauthorize_session_history_for_turn`])
//!   is the one that waits for the database, and a wait beyond its allowance
//!   is "without history" too.
//! * A failed read (SQLite or IO, a malformed row) stops the run with that
//!   error. A candidate is excluded only for a closed reason.

use super::*;
use crate::narrative_extraction::{HistoryRequalifier, PROJECT_SCOPE_AUTHORITY_SNAPSHOT};
use crate::nir1_generation::history_reads::GenerationHistoryAttemptHeader;
use crate::nir1_generation::with_generation_history_snapshot_in_tx;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::Connection;

/// What the run is asked for: the current turn's context from the D-final
/// snapshot's builder (it names the project, the chat session and the Scene)
/// and the Native clock's value for the turn.
pub(crate) struct SessionHistoryRequest<'a> {
    pub current: &'a CurrentHistoryContext,
    pub now_ms: i64,
}

/// What a result stands for.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SessionCandidateKind {
    /// The Human of an attempt's current turn.
    PastHuman,
    /// The generated output of an attempt.
    GeneratedOutput,
    /// An attempt that yields no candidate (not usable, not read, or with
    /// neither a Human turn nor an output).
    Attempt,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionCandidateResult {
    pub kind: SessionCandidateKind,
    /// The attempt whose current-turn Human, output or row this is.
    pub attempt_id: AttemptId,
    /// The Human or output message version.
    pub version_id: Option<OpaqueRef>,
    pub disposition: CandidateDisposition,
    /// The attempts the candidate depends on (itself and its ancestors), in
    /// the order they were first reached. Empty when excluded.
    pub visited_attempts: Vec<AttemptId>,
}

/// Why the whole turn goes on without history. These are not failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NoHistory {
    /// The current turn's context cannot be compared (K4/3 section 8).
    CurrentContextUnavailable(CurrentContextUnavailable),
    /// The session's attempts cannot be listed or counted within the turn's
    /// budget, so no candidate could be verified.
    SessionOverBudget,
    /// The history's own SQL capacity ended before the run did: the VM-step
    /// ledger, or the same budget's deadline when the progress handler is the
    /// one that sees it (`CapacityExceeded`). The run cannot return a part of
    /// its result, so none of it is used (DI1B-1).
    SqlCapacityExhausted,
    /// The history's own deadline (the turn's budget, clipped to the prepare
    /// deadline) elapsed before the run ended, seen at a checkpoint of the run
    /// or before it started (`TimedOut`) (DI1B-1).
    SqlDeadlineElapsed,
    /// SQLite reported the database busy beyond the history's busy-wait
    /// allowance, in the form that opens its own transaction and so waits for
    /// the database (DI1B-1). The in-transaction form waits for nothing and
    /// never returns this.
    SqlBusy,
}

impl NoHistory {
    /// A closed code for evidence and tests. It names the kind only: no
    /// identifier, no text.
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::CurrentContextUnavailable(_) => "current-context-unavailable",
            Self::SessionOverBudget => "session-over-budget",
            Self::SqlCapacityExhausted => "sql-capacity-exhausted",
            Self::SqlDeadlineElapsed => "sql-deadline-elapsed",
            Self::SqlBusy => "sql-busy",
        }
    }
}

/// A message the run read and authenticated for a qualified candidate: the
/// message version and the body whose digest the reader verified. This is the
/// reader's own value, handed on; nothing re-reads it (DI1B-2).
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HistoryMessageMaterial {
    pub version_id: OpaqueRef,
    pub origin: MessageOrigin,
    pub parent_attempt_id: Option<AttemptId>,
    /// The version's digest, equal to the digest of `body` as stored.
    pub body_digest: String,
    pub body: String,
}

/// What the run read of one attempt that has a qualified candidate, for the
/// adoption (DI1B-2): the attempt's time and the Scene body it recorded, and
/// the bodies of its qualified candidates. A body the run could not read
/// within the turn's budget is `None` (the adoption does not use that turn).
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HistoryAttemptMaterial {
    pub created_at_ms: i64,
    /// The `bodyDigest` the attempt's Scene binding recorded.
    pub scene_body_digest: String,
    pub human: Option<HistoryMessageMaterial>,
    pub output: Option<HistoryMessageMaterial>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionHistoryOutcome {
    /// One entry per candidate or unusable attempt, in the evaluation order.
    pub candidates: Vec<SessionCandidateResult>,
    pub without_history: Option<NoHistory>,
    /// How many A3 evaluations the turn made: one per Revision and target
    /// Scene, shared by every attempt that holds the Revision.
    pub a3_evaluations: usize,
    /// The material of the attempts that have a qualified candidate (DI1B-2).
    pub materials: BTreeMap<AttemptId, HistoryAttemptMaterial>,
}

impl SessionHistoryOutcome {
    fn without_history(reason: NoHistory) -> Self {
        Self {
            candidates: Vec::new(),
            without_history: Some(reason),
            a3_evaluations: 0,
            materials: BTreeMap::new(),
        }
    }

    /// The candidates that may be adopted, in the evaluation order.
    pub(crate) fn qualified(&self) -> impl Iterator<Item = &SessionCandidateResult> {
        self.candidates
            .iter()
            .filter(|result| result.disposition == CandidateDisposition::Qualified)
    }
}

/// The ledger errors of the reads that debit the caller's budget. These are
/// the budget's own limits; the storage ceilings for malformed rows and every
/// other error stay errors.
fn is_history_budget_error(error: &anyhow::Error) -> bool {
    const CODES: [&str; 5] = [
        "NIR1_GENERATION_HISTORY_LIMIT",
        "NIR1_GENERATION_HISTORY_CANDIDATE_LIMIT",
        "NIR1_GENERATION_HISTORY_BODY_LIMIT",
        "NIR1_GENERATION_HISTORY_BUDGET_EXHAUSTED",
        "NIR1_GENERATION_REF_LIMIT",
    ];
    let rendered = format!("{error:#}");
    rendered.split(": ").any(|part| CODES.contains(&part))
}

/// One planned result: a candidate for the pure traversal, or an entry that
/// was decided without it.
struct Planned {
    kind: SessionCandidateKind,
    attempt_id: AttemptId,
    version_id: Option<OpaqueRef>,
    candidate: Option<Candidate>,
    decided: Option<Failure>,
}

impl Planned {
    fn attempt(header: &GenerationHistoryAttemptHeader, failure: Failure) -> Self {
        Self {
            kind: SessionCandidateKind::Attempt,
            attempt_id: header.id.clone(),
            version_id: None,
            candidate: None,
            decided: Some(failure),
        }
    }

    fn human(header: &GenerationHistoryAttemptHeader, version_id: &str) -> Self {
        Self {
            kind: SessionCandidateKind::PastHuman,
            attempt_id: header.id.clone(),
            version_id: Some(version_id.to_owned()),
            candidate: Some(Candidate {
                id: format!("human:{}", header.id),
                root_attempt_id: header.id.clone(),
                adopted_input_ordinals: vec![0],
                output: None,
            }),
            decided: None,
        }
    }

    fn output(header: &GenerationHistoryAttemptHeader, version_id: &str) -> Self {
        Self {
            kind: SessionCandidateKind::GeneratedOutput,
            attempt_id: header.id.clone(),
            version_id: Some(version_id.to_owned()),
            candidate: Some(Candidate {
                id: format!("output:{}", header.id),
                root_attempt_id: header.id.clone(),
                adopted_input_ordinals: Vec::new(),
                output: Some(GeneratedOutput {
                    version_id: version_id.to_owned(),
                }),
            }),
            decided: None,
        }
    }
}

/// Plan the candidates of one listed attempt whose history slot is a known
/// context: load it, and materialize what its candidates need.
fn plan_attempt<C: FnMut() -> bool>(
    reader: &mut GenerationHistorySnapshotReader<'_>,
    budget: &mut GenerationHistoryReadBudget,
    header: &GenerationHistoryAttemptHeader,
    attempts: &mut BTreeMap<AttemptId, LoadedAttempt>,
    expanded: &mut BTreeSet<AttemptId>,
    cancellation: &GenerationHistorySnapshotCancellation,
    cancelled: &mut C,
) -> Result<Vec<Planned>> {
    load_attempt(reader, budget, &header.id, attempts)?;
    let Some(loaded) = attempts.get(&header.id) else {
        return Ok(vec![Planned::attempt(
            header,
            Failure::incomplete(IncompleteReason::MissingAttempt(header.id.clone())),
        )]);
    };
    if let HistoryContextState::Gated(reason) = loaded.snapshot.context {
        return Ok(vec![Planned::attempt(
            header,
            Failure::incomplete(IncompleteReason::HistoryContextUnusable(reason)),
        )]);
    }
    let Some(stored) = loaded.stored.clone() else {
        return Ok(vec![Planned::attempt(
            header,
            Failure::incomplete(IncompleteReason::MissingAttempt(header.id.clone())),
        )]);
    };
    if stored.reference_format == ReferenceFormat::LegacyV1 {
        return Ok(vec![Planned::attempt(
            header,
            Failure::incomplete(IncompleteReason::LegacyReferenceFormat),
        )]);
    }
    let mut planned = Vec::new();
    // The Human of the attempt's current turn is the user input at ordinal 0.
    if let Some(InputReference {
        role: InputRole::User,
        target:
            InputTarget::Message {
                version_id,
                parent_attempt_id: None,
            },
        ..
    }) = stored.inputs.first()
    {
        ensure_snapshot_not_cancelled(cancellation, cancelled)?;
        enrich_input(reader, budget, &header.id, 0, attempts)?;
        planned.push(Planned::human(header, version_id));
    }
    // A succeeded receipt names the attempt's generated output.
    if let Some(terminal) = &stored.terminal {
        let succeeded = terminal
            .observation
            .get("terminalStatus")
            .and_then(|value| value.as_str())
            == Some("succeeded");
        if let (true, Some(version)) = (succeeded, terminal.message_version.as_ref()) {
            materialize_all(
                reader,
                budget,
                &header.id,
                attempts,
                expanded,
                cancellation,
                cancelled,
            )?;
            planned.push(Planned::output(header, &version.id));
        }
    }
    if planned.is_empty() {
        planned.push(Planned::attempt(
            header,
            Failure::incomplete(IncompleteReason::NoCandidateInAttempt),
        ));
    }
    Ok(planned)
}

/// What the history run may ask of the connection it borrows: reads. The
/// run is read-only by construction (HC-1 asserts `total_changes` stays put);
/// this makes a write a refused statement (`SQLITE_AUTH`) instead of a rule
/// kept by discipline (DR-HC1-24 (3), DI1B-1).
///
/// An authorizer acts when a statement is prepared, so it costs nothing per
/// row, and clearing it is not SQL: it cannot be interrupted by the progress
/// handler, so a connection pooled by the participant cannot be left
/// refusing writes (`PRAGMA query_only` can, which is why it is not used).
/// The run executes inside the participant's connection scope, where no other
/// authorizer is installed (the renderer SQL policy installs its own only for
/// its own call); the guard clears the authorizer when it ends, also when the
/// run fails.
struct ReadOnlyRun<'connection> {
    connection: &'connection Connection,
}

impl<'connection> ReadOnlyRun<'connection> {
    fn enter(connection: &'connection Connection) -> Result<Self> {
        connection
            .authorizer(Some(allow_reads_only))
            .context("NIR1_GENERATION_HISTORY_READ_ONLY_GUARD")?;
        Ok(Self { connection })
    }
}

impl Drop for ReadOnlyRun<'_> {
    fn drop(&mut self) {
        // Not SQL: clearing the hook cannot be interrupted or refused.
        let _ = self
            .connection
            .authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
    }
}

/// Reads only: a SELECT, the columns it reads, the functions and the recursive
/// terms it uses. Everything else (every write, DDL, transaction and
/// savepoint control, PRAGMA, ATTACH) is refused.
fn allow_reads_only(context: AuthContext<'_>) -> Authorization {
    match context.action {
        AuthAction::Select
        | AuthAction::Read { .. }
        | AuthAction::Function { .. }
        | AuthAction::Recursive => Authorization::Allow,
        // The project's Scope authority reads its tree, its Scene bindings and
        // its registry inside one named savepoint so that they are one view.
        // A savepoint writes no row; any other transaction control is refused.
        AuthAction::Savepoint {
            savepoint_name: PROJECT_SCOPE_AUTHORITY_SNAPSHOT,
            ..
        } => Authorization::Allow,
        _ => Authorization::Deny,
    }
}

/// Why a typed or SQLite stop of the run means "this turn goes on without
/// history" (K4/3 section 8, a spent budget) and not "the turn stops".
///
/// The history's own SQL ledger (VM steps, deadline) ends the run with the
/// typed `CapacityExceeded` / `TimedOut`. A cancel (`Cancelled`, or the
/// participant's `ContextUnavailable`), any other typed reason and every other
/// SQLite or IO error stay errors: the owner stopped the work, or a read
/// failed, and the turn stops.
///
/// `waits_for_busy` is true only for the form that opens its own transaction.
/// Only that form waits for the database (the ledger's busy-wait allowance),
/// so only there is `SQLITE_BUSY` / `SQLITE_LOCKED` "the wait ran out". In the
/// caller's own transaction nothing is waited for: a busy or locked error
/// there is not a spent allowance but an unexpected failure of a read in the
/// D-final snapshot, and it stops the turn (DI1B-1 review, DR-DI1B-4).
fn no_history_for_ledger_stop(error: &anyhow::Error, waits_for_busy: bool) -> Option<NoHistory> {
    use crate::narrative_extraction::{ValidationTerminated, ValidationTerminationReason};

    if let Some(terminated) = error.downcast_ref::<ValidationTerminated>() {
        return match terminated.reason {
            ValidationTerminationReason::CapacityExceeded => Some(NoHistory::SqlCapacityExhausted),
            ValidationTerminationReason::TimedOut => Some(NoHistory::SqlDeadlineElapsed),
            _ => None,
        };
    }
    if !waits_for_busy {
        return None;
    }
    error
        .chain()
        .filter_map(|cause| cause.downcast_ref::<rusqlite::Error>())
        .any(|cause| {
            matches!(
                cause,
                rusqlite::Error::SqliteFailure(failure, _)
                    if matches!(
                        failure.code,
                        rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                    )
            )
        })
        .then_some(NoHistory::SqlBusy)
}

fn run_session_history<C: FnMut() -> bool>(
    reader: &mut GenerationHistorySnapshotReader<'_>,
    budget: &mut GenerationHistoryReadBudget,
    cancellation: &GenerationHistorySnapshotCancellation,
    request: &SessionHistoryRequest<'_>,
    cancelled: &mut C,
) -> Result<SessionHistoryOutcome> {
    // Whatever the run decides, it only reads (DR-HC1-24 (3)); the guard is
    // in force before the first poll of the owner.
    let _read_only = ReadOnlyRun::enter(reader.authority_connection().connection())?;
    ensure_snapshot_not_cancelled(cancellation, cancelled)?;
    // A current context that cannot be compared excludes all history and the
    // turn goes on: no row is read and no budget is spent.
    let current = match request.current.available() {
        Ok(current) => current,
        Err(unavailable) => {
            return Ok(SessionHistoryOutcome::without_history(
                NoHistory::CurrentContextUnavailable(unavailable),
            ))
        }
    };
    let project_id = current.range.project_id.as_str();
    let session_id = current.range.chat_session_id.as_str();

    // The session's attempts, from the session column and its index only. A
    // session that cannot be listed within the budget leaves every candidate
    // unverified.
    let headers = match reader.list_session_attempts(budget, project_id, session_id) {
        Ok(headers) => headers,
        Err(error) if is_history_budget_error(&error) => {
            return Ok(SessionHistoryOutcome::without_history(
                NoHistory::SessionOverBudget,
            ))
        }
        Err(error) => return Err(error),
    };
    // The exactly-one rule counts the listed attempts' ordinal 0 rows; count
    // them once, now.
    match reader.ensure_ordinal_zero_index(budget, project_id, session_id) {
        Ok(()) => {}
        Err(error) if is_history_budget_error(&error) => {
            return Ok(SessionHistoryOutcome::without_history(
                NoHistory::SessionOverBudget,
            ))
        }
        Err(error) => return Err(error),
    }

    // Phase 1: read what the candidates need, in the total order. The first
    // attempt whose reads exhaust the budget and every later one stay
    // unverified.
    let mut attempts = BTreeMap::new();
    let mut expanded = BTreeSet::new();
    let mut plan: Vec<Planned> = Vec::new();
    let mut exhausted = false;
    for header in headers.iter() {
        ensure_snapshot_not_cancelled(cancellation, cancelled)?;
        if exhausted {
            plan.push(Planned::attempt(
                header,
                Failure::incomplete(IncompleteReason::BudgetExhausted),
            ));
            continue;
        }
        if let Some(reason) = header.gate() {
            // Legacy and unknown bindings and unusable slots are never read.
            plan.push(Planned::attempt(
                header,
                Failure::incomplete(IncompleteReason::HistoryContextUnusable(reason)),
            ));
            continue;
        }
        match plan_attempt(
            reader,
            budget,
            header,
            &mut attempts,
            &mut expanded,
            cancellation,
            cancelled,
        ) {
            Ok(planned) => plan.extend(planned),
            Err(error) if is_history_budget_error(&error) => {
                exhausted = true;
                plan.push(Planned::attempt(
                    header,
                    Failure::incomplete(IncompleteReason::BudgetExhausted),
                ));
            }
            Err(error) => return Err(error),
        }
    }

    // What the adoption needs of each attempt, taken before the traversal's
    // input takes the loaded attempts (DI1B-2).
    let attempt_meta: BTreeMap<AttemptId, (i64, String)> = headers
        .iter()
        .filter_map(|header| {
            let stored = attempts.get(&header.id)?.stored.as_ref()?;
            Some((
                header.id.clone(),
                (
                    header.created_at_ms,
                    stored.binding.scene.body_digest.clone(),
                ),
            ))
        })
        .collect();

    // Phase 2: the pure traversal over what was read, with the production
    // requalifier on the snapshot's own connection.
    let snapshot = HistorySnapshot {
        attempts: attempts
            .into_iter()
            .map(|(id, loaded)| (id, loaded.snapshot))
            .collect(),
    };
    let candidates: Vec<Candidate> = plan
        .iter()
        .filter_map(|planned| planned.candidate.clone())
        .collect();
    cancellation.checkpoint()?;
    let mut qualifier = HistoryRequalifier::new(reader.authority_connection());
    // The traversal is synchronous and has no connection to poll: combine the
    // caller's cancel with the snapshot's owner control, and let the
    // checkpoint after it keep the typed reason.
    let mut traversal_cancelled = || cancelled() || cancellation.is_cancelled();
    let outcome = reauthorize_history(
        &snapshot,
        &candidates,
        request.current,
        request.now_ms,
        budget,
        &mut qualifier,
        &mut traversal_cancelled,
    );
    cancellation.checkpoint()?;
    let a3_evaluations = qualifier.a3_evaluation_count();
    let outcome = match outcome {
        Ok(outcome) => outcome,
        // A failed read: the qualifier kept its error.
        Err(HistoryRunError::AuthorityUnavailable) => {
            return Err(qualifier
                .take_stop()
                .unwrap_or_else(|| anyhow!("NIR1_GENERATION_HISTORY_AUTHORITY_UNAVAILABLE")))
        }
        Err(error) => return Err(history_run_error(error)),
    };

    let mut results = outcome.candidates.into_iter();
    let mut candidates = Vec::with_capacity(plan.len());
    for planned in plan {
        let (disposition, visited_attempts) = match (planned.candidate, planned.decided) {
            (Some(candidate), _) => {
                let result = results
                    .next()
                    .filter(|result| result.id == candidate.id)
                    .ok_or_else(|| anyhow!("NIR1_GENERATION_HISTORY_RESULT_MISMATCH"))?;
                (result.disposition, result.visited_attempts)
            }
            (None, Some(failure)) => (CandidateDisposition::Excluded(failure), Vec::new()),
            (None, None) => anyhow::bail!("NIR1_GENERATION_HISTORY_RESULT_MISMATCH"),
        };
        candidates.push(SessionCandidateResult {
            kind: planned.kind,
            attempt_id: planned.attempt_id,
            version_id: planned.version_id,
            disposition,
            visited_attempts,
        });
    }
    let materials = collect_materials(reader, budget, &candidates, &attempt_meta, cancellation)?;
    Ok(SessionHistoryOutcome {
        candidates,
        without_history: None,
        a3_evaluations,
        materials,
    })
}

/// The bodies of the qualified candidates, newest attempt first, from the
/// reader. A past Human's message was read (and cached) when its input was
/// enriched, so that is no second read; an output's body is read here once
/// when no later attempt adopted it. A body that the turn's budget cannot
/// pay for, or whose row is gone, is left out (`None`): the adoption does not
/// use that turn. Any other error stops the run.
fn collect_materials(
    reader: &mut GenerationHistorySnapshotReader<'_>,
    budget: &mut GenerationHistoryReadBudget,
    candidates: &[SessionCandidateResult],
    attempt_meta: &BTreeMap<AttemptId, (i64, String)>,
    cancellation: &GenerationHistorySnapshotCancellation,
) -> Result<BTreeMap<AttemptId, HistoryAttemptMaterial>> {
    let mut materials: BTreeMap<AttemptId, HistoryAttemptMaterial> = BTreeMap::new();
    for result in candidates.iter().filter(|result| {
        result.disposition == CandidateDisposition::Qualified
            && matches!(
                result.kind,
                SessionCandidateKind::PastHuman | SessionCandidateKind::GeneratedOutput
            )
    }) {
        cancellation.checkpoint()?;
        let (Some(version_id), Some((created_at_ms, scene_body_digest))) = (
            result.version_id.as_deref(),
            attempt_meta.get(&result.attempt_id),
        ) else {
            continue;
        };
        let body = match reader.read_message(budget, version_id) {
            Ok(message) => Some(HistoryMessageMaterial {
                version_id: version_id.to_owned(),
                origin: message.version.origin,
                parent_attempt_id: message.version.parent_attempt_id,
                body_digest: message.version.body_digest,
                body: message.content,
            }),
            Err(error) if is_history_budget_error(&error) || is_missing_row(&error) => None,
            Err(error) => return Err(error),
        };
        let entry = materials
            .entry(result.attempt_id.clone())
            .or_insert_with(|| HistoryAttemptMaterial {
                created_at_ms: *created_at_ms,
                scene_body_digest: scene_body_digest.clone(),
                human: None,
                output: None,
            });
        match result.kind {
            SessionCandidateKind::PastHuman => entry.human = body,
            _ => entry.output = body,
        }
    }
    Ok(materials)
}

/// Re-authorize the history of the current turn's chat session inside the
/// D-final snapshot's own read transaction (`connection`), with the turn's
/// budget. DI-1b calls this form so that the context, the candidates and
/// every qualification are read in one snapshot.
pub(crate) fn reauthorize_session_history_in_tx<C: FnMut() -> bool>(
    connection: &Connection,
    cancellation: &GenerationHistorySnapshotCancellation,
    caller_budget: &mut GenerationHistoryReadBudget,
    request: &SessionHistoryRequest<'_>,
    cancelled: &mut C,
) -> Result<SessionHistoryOutcome> {
    // The listing, the captures, the ordinal-0 counts and every requalification
    // must be one snapshot: an autocommit connection would read each statement
    // from its own implicit snapshot and could qualify a torn view.
    anyhow::ensure!(
        !connection.is_autocommit(),
        "NIR1_GENERATION_TRANSACTION_REQUIRED"
    );
    with_generation_history_snapshot_in_tx(
        connection,
        cancellation,
        caller_budget,
        |reader, budget| run_session_history(reader, budget, cancellation, request, cancelled),
    )
    .context("NIR1_GENERATION_HISTORY_SESSION")
}

/// The same run in its own participant read transaction, for a caller that
/// has no snapshot of its own.
pub(crate) fn reauthorize_session_history<C: FnMut() -> bool>(
    workspace: &ActiveWorkspaceSnapshot,
    control: ParticipantSqlControl,
    caller_budget: &mut GenerationHistoryReadBudget,
    request: &SessionHistoryRequest<'_>,
    cancelled: &mut C,
) -> Result<SessionHistoryOutcome> {
    with_generation_history_snapshot(
        workspace,
        control,
        caller_budget,
        |reader, budget, cancellation| {
            run_session_history(reader, budget, cancellation, request, cancelled)
        },
    )
    .context("NIR1_GENERATION_HISTORY_SESSION")
}

/// The D-final snapshot's form of the run (DI1B-1): the same run inside the
/// caller's own read transaction, where the history's SQL ledger being spent
/// (VM steps, the history deadline) ends the history, not the turn. The
/// caller's transaction is still open and readable afterwards; the outcome
/// carries no candidate. A cancel, a stop of the participant, any other typed
/// reason and every other error stay errors, a busy or locked error included
/// (this form waits for nothing: the transaction is already open).
pub(crate) fn reauthorize_session_history_for_turn_in_tx<C: FnMut() -> bool>(
    connection: &Connection,
    cancellation: &GenerationHistorySnapshotCancellation,
    caller_budget: &mut GenerationHistoryReadBudget,
    request: &SessionHistoryRequest<'_>,
    cancelled: &mut C,
) -> Result<SessionHistoryOutcome> {
    match reauthorize_session_history_in_tx(
        connection,
        cancellation,
        caller_budget,
        request,
        cancelled,
    ) {
        Err(error) => match no_history_for_ledger_stop(&error, false) {
            Some(reason) => Ok(SessionHistoryOutcome::without_history(reason)),
            None => Err(error),
        },
        outcome => outcome,
    }
}

/// [`reauthorize_session_history_for_turn_in_tx`] for a caller that has no
/// snapshot of its own: the run opens the participant read transaction with
/// the ledger's deadline and busy wait, and a busy database beyond that
/// allowance ends the history, not the turn.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the D-final snapshot uses the in-transaction form; this form is for a caller without one"
    )
)]
pub(crate) fn reauthorize_session_history_for_turn<C: FnMut() -> bool>(
    workspace: &ActiveWorkspaceSnapshot,
    control: ParticipantSqlControl,
    caller_budget: &mut GenerationHistoryReadBudget,
    request: &SessionHistoryRequest<'_>,
    cancelled: &mut C,
) -> Result<SessionHistoryOutcome> {
    match reauthorize_session_history(workspace, control, caller_budget, request, cancelled) {
        Err(error) => match no_history_for_ledger_stop(&error, true) {
            Some(reason) => Ok(SessionHistoryOutcome::without_history(reason)),
            None => Err(error),
        },
        outcome => outcome,
    }
}

#[cfg(test)]
mod ledger_stop_tests {
    use super::*;
    use crate::narrative_extraction::{validation_terminated, ValidationTerminationReason};

    fn sqlite_failure(code: std::ffi::c_int) -> anyhow::Error {
        anyhow::Error::from(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(code),
            None,
        ))
        .context("NIR1_GENERATION_HISTORY_SESSION")
    }

    /// The mapping of a stop to "no history" (DI1B-1 review, DR-DI1B-4): the
    /// typed ledger stops map in both forms; a busy or locked error maps only
    /// in the form that waits for the database (it opens its own transaction)
    /// and stays the turn's error inside the caller's transaction. A cancel
    /// and any other error are never "no history".
    #[test]
    fn busy_maps_only_where_the_run_waits_for_the_database() {
        for waits_for_busy in [false, true] {
            assert_eq!(
                no_history_for_ledger_stop(
                    &validation_terminated(ValidationTerminationReason::CapacityExceeded, "spent"),
                    waits_for_busy
                ),
                Some(NoHistory::SqlCapacityExhausted)
            );
            assert_eq!(
                no_history_for_ledger_stop(
                    &validation_terminated(ValidationTerminationReason::TimedOut, "late"),
                    waits_for_busy
                ),
                Some(NoHistory::SqlDeadlineElapsed)
            );
            assert_eq!(
                no_history_for_ledger_stop(
                    &validation_terminated(ValidationTerminationReason::Cancelled, "stop"),
                    waits_for_busy
                ),
                None
            );
            for code in [rusqlite::ffi::SQLITE_IOERR, rusqlite::ffi::SQLITE_CORRUPT] {
                assert_eq!(
                    no_history_for_ledger_stop(&sqlite_failure(code), waits_for_busy),
                    None
                );
            }
        }
        for code in [rusqlite::ffi::SQLITE_BUSY, rusqlite::ffi::SQLITE_LOCKED] {
            assert_eq!(
                no_history_for_ledger_stop(&sqlite_failure(code), true),
                Some(NoHistory::SqlBusy)
            );
            assert_eq!(
                no_history_for_ledger_stop(&sqlite_failure(code), false),
                None,
                "a busy error inside the caller's transaction stops the turn"
            );
        }
    }
}
