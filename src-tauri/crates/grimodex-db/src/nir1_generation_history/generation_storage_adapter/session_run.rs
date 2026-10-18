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
//! * A failed read (SQLite or IO, a malformed row) stops the run with that
//!   error. A candidate is excluded only for a closed reason.

use super::*;
use crate::narrative_extraction::HistoryRequalifier;
use crate::nir1_generation::history_reads::GenerationHistoryAttemptHeader;
use crate::nir1_generation::with_generation_history_snapshot_in_tx;
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
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionHistoryOutcome {
    /// One entry per candidate or unusable attempt, in the evaluation order.
    pub candidates: Vec<SessionCandidateResult>,
    pub without_history: Option<NoHistory>,
    /// How many A3 evaluations the turn made: one per Revision and target
    /// Scene, shared by every attempt that holds the Revision.
    pub a3_evaluations: usize,
}

impl SessionHistoryOutcome {
    fn without_history(reason: NoHistory) -> Self {
        Self {
            candidates: Vec::new(),
            without_history: Some(reason),
            a3_evaluations: 0,
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

fn run_session_history<C: FnMut() -> bool>(
    reader: &mut GenerationHistorySnapshotReader<'_>,
    budget: &mut GenerationHistoryReadBudget,
    cancellation: &GenerationHistorySnapshotCancellation,
    request: &SessionHistoryRequest<'_>,
    cancelled: &mut C,
) -> Result<SessionHistoryOutcome> {
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
    Ok(SessionHistoryOutcome {
        candidates,
        without_history: None,
        a3_evaluations: qualifier.a3_evaluation_count(),
    })
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
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "DI-1b runs the in-transaction form inside the D-final snapshot; this form is for a caller without one"
    )
)]
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
