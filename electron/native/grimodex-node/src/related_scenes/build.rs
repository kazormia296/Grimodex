use super::*;
use grimodex_db::narrative_extraction::{GraphWorkControl, GraphWorkStage};
use grimodex_semantic::runtime::{
    Nir1DocumentEmbeddingOutcome, Nir1EmbeddingDocument, SemanticEmbeddingAuditBinding,
    SemanticEmbeddingIdentity,
};

/// DR-IRB-3 (E11): how many reader-caused `Retry` in a row end the build task
/// as `Stopped`. 250 ms × 40 ≒ 10 s, the same length as the renderer's read
/// IPC deadline (`IPC_TIMEOUT_MS`): a transient `BUSY` is waited out for up to
/// that long, and a persistent open failure is not retried forever. User
/// decision of 2026-11-06.
const MAX_CONSECUTIVE_READER_RETRIES: u32 = 40;
const RETRY_DELAY: Duration = Duration::from_millis(250);
/// DR-IRB-7: the wait after a publish-side `Stale` (`StaleRetry`). A save
/// reserves Freshness between the prepare and the publish, so the publish
/// check no longer matches (`Stale` is not only Freshness: an owner mismatch
/// or a runtime epoch rotation also give it, and the next attempt then stops
/// or proceeds with the new epoch, so the short retry does no harm); the renderer's hook begins the parent query
/// 400 ms after the save, and a build task asleep for 250 ms at that moment
/// leaves Chronicle unusable so IR/Graph never start. In the dev measurement
/// `Stale` came 156-243 ms after the save and one build takes about 25 ms, so
/// 50 ms still finishes the next build before 400 ms (243 + 50 + 25 = about 320 ms).
/// It is not 0 ms: 0 ms would busy-loop while Freshness is still being
/// evaluated, and in theory `prepare_on_reader` drops any `Unavailable` other
/// than `PendingChange` (for example `ReservedBinding`) to `Stopped`, which
/// would end the task and release the reservation (a theoretical path: the
/// reason is decided inside one transaction, and between the Freshness
/// reservation and the publish `PendingChange` is what is seen).
/// `PendingChange` keeps `RETRY_DELAY`.
const STALE_RETRY_DELAY: Duration = Duration::from_millis(50);
/// DR-IRB-7: how many `StaleRetry` in a row wait `STALE_RETRY_DELAY`; the
/// following ones go back to `RETRY_DELAY` until another outcome ends the run.
/// Independent of the reader-retry streak (`K`).
const MAX_CONSECUTIVE_STALE_RETRIES: u32 = 3;
/// DR-MPS-15/16: how long periodic ticks may keep yielding the database
/// connection (`BuildOutcome::Skipped`), counted from the first skip, before
/// the next tick takes it like any foreground caller. 10 s is the same length
/// as `K` and the renderer's read IPC deadline: longer than a maintenance
/// Verify needs (about 3-4 s measured), and it bounds how late a stale index
/// or a withdrawn operation can be noticed while maintenance keeps the
/// connection. Separate from `MAX_CONSECUTIVE_SKIPPED_ROUNDS` in the parent
/// module (reconcile rounds), which has the same intended length.
const YIELD_WINDOW: Duration = Duration::from_secs(10);
/// DR-MPS-16: how long the task waits after a `Skipped` tick (capped by the
/// wait it carries over). One waiter-free try per 50 ms keeps the retry cheap
/// and lets a rebuild after a save catch a short occupation.
const SKIP_RETRY_DELAY: Duration = Duration::from_millis(50);

/// The waits and bounds of the build task's retry loop. Tests shorten them.
#[derive(Clone, Copy)]
struct RetryPolicy {
    retry_delay: Duration,
    stale_delay: Duration,
    max_stale_retries: u32,
    max_reader_retries: u32,
    /// DR-MPS-16: the longest sleep after a `Skipped` tick.
    skip_delay: Duration,
    /// DR-MPS-16: how long from the first skip the task keeps yielding.
    yield_window: Duration,
}

impl RetryPolicy {
    const PRODUCTION: Self = Self {
        retry_delay: RETRY_DELAY,
        stale_delay: STALE_RETRY_DELAY,
        max_stale_retries: MAX_CONSECUTIVE_STALE_RETRIES,
        max_reader_retries: MAX_CONSECUTIVE_READER_RETRIES,
        skip_delay: SKIP_RETRY_DELAY,
        yield_window: YIELD_WINDOW,
    };
}

/// How one tick of the task takes the database connection (DR-MPS-15).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TickMode {
    /// Like any foreground caller: waits, and announces itself as a waiter
    /// (which makes a running maintenance Verify hand the connection over).
    Foreground,
    /// A periodic tick that may give way: the first connection acquisition is
    /// one waiter-free try, and a busy connection ends the tick as
    /// `BuildOutcome::Skipped` without having announced anything.
    Yielding,
}

/// The mode of the next tick. Only a periodic tick yields: the task's first
/// tick (`previous` is `None`, started by `begin`) never does, and neither does
/// the retry that follows a publish-side `StaleRetry` or a reader retry (both
/// are about work the user is waiting on or about the reader's own bound).
/// After `Idle`, `Ready`, `Retry` or `Skipped` the tick yields, except that
/// skipping for `yield_window` (since the first skip) makes the next one a
/// normal foreground tick.
fn next_tick_mode(
    previous: Option<&BuildOutcome>,
    skipping_for: Duration,
    yield_window: Duration,
) -> TickMode {
    match previous {
        None | Some(BuildOutcome::StaleRetry) | Some(BuildOutcome::ReaderRetry(_)) => {
            TickMode::Foreground
        }
        // `Stopped` ends the task, so no tick follows it.
        Some(BuildOutcome::Stopped) => TickMode::Foreground,
        Some(BuildOutcome::Idle)
        | Some(BuildOutcome::Ready)
        | Some(BuildOutcome::Retry)
        | Some(BuildOutcome::Skipped) => {
            if skipping_for >= yield_window {
                TickMode::Foreground
            } else {
                TickMode::Yielding
            }
        }
    }
}

/// When the current run of skips began, after a tick that ran in `mode`: a
/// skip keeps the earlier start (or starts at `now`); anything else, including
/// the forced foreground tick after the window, starts over.
fn next_skipping_since(
    skipping_since: Option<Instant>,
    mode: TickMode,
    outcome: &BuildOutcome,
    now: Instant,
) -> Option<Instant> {
    match (mode, outcome) {
        (TickMode::Yielding, BuildOutcome::Skipped) => Some(skipping_since.unwrap_or(now)),
        _ => None,
    }
}

/// One build step of the task, as the older tests script it (`schedule_with`
/// adapts it to a `ModeStep`).
#[cfg(test)]
type BuildStep = dyn Fn(&Arc<AppState>, &SemanticRequest, &WorkspaceParticipant, &str) -> Result<BuildOutcome>
    + Send
    + Sync;

/// A build step that is told how its tick may take the connection
/// (`schedule_with` adapts a `BuildStep`, which ignores the mode).
type ModeStep = dyn Fn(
        &Arc<AppState>,
        &SemanticRequest,
        &WorkspaceParticipant,
        &str,
        TickMode,
    ) -> Result<BuildOutcome>
    + Send
    + Sync;

pub(super) fn schedule(
    state: Arc<AppState>,
    request: SemanticRequest,
    participant: grimodex_db::workspace_lifecycle::WorkspaceParticipant,
    project: String,
) -> Result<()> {
    schedule_with_mode(
        state,
        request,
        participant,
        project,
        RetryPolicy::PRODUCTION,
        Arc::new(|state, request, participant, project, mode| {
            build_once_with_mode(state, request, participant, project, mode)
        }),
    )
}

#[cfg(test)]
fn schedule_with(
    state: Arc<AppState>,
    request: SemanticRequest,
    participant: grimodex_db::workspace_lifecycle::WorkspaceParticipant,
    project: String,
    policy: RetryPolicy,
    build: Arc<BuildStep>,
) -> Result<()> {
    schedule_with_mode(
        state,
        request,
        participant,
        project,
        policy,
        Arc::new(move |state, request, participant, project, _mode| {
            build(state, request, participant, project)
        }),
    )
}

fn schedule_with_mode(
    state: Arc<AppState>,
    request: SemanticRequest,
    participant: grimodex_db::workspace_lifecycle::WorkspaceParticipant,
    project: String,
    policy: RetryPolicy,
    build: Arc<ModeStep>,
) -> Result<()> {
    if !current_request(&state, &request)? {
        return Ok(());
    }
    let key = (request.database().identity(), project.clone());
    let generation = request.epoch().generation();
    {
        let mut builds = lock(&state.related_scenes.builds)?;
        if !builds.reserve(key.clone(), generation) {
            // A task of this workspace and generation already runs (a second
            // `begin`, or a stale operation's rebuild). The caller wants a
            // rebuild now: the running task must not yield on its next tick.
            // Polling itself never reaches this point (the loop does not call
            // `schedule`), so the request is always a begin or a stale rebuild.
            builds.request_foreground(&key, generation);
            return Ok(());
        }
    }
    // Independent of query tickets: closing an old list cannot interrupt a
    // needed index publication. Workspace/model changes still revoke the job.
    let weak_state = Arc::downgrade(&state);
    tokio::spawn(async move {
        // Keep the workspace participant across every retry and blocking
        // build. A transition must observe this task before publishing a
        // replacement authority.
        //
        // Consecutive `Retry` outcomes caused by the dedicated reader
        // (open failure, BUSY, slot taken, unproven close). Local to this
        // task, so a new generation's task counts for itself.
        let mut reader_retry_streak: u32 = 0;
        // Consecutive `StaleRetry` (DR-IRB-7); also local to this task.
        let mut stale_retry_streak: u32 = 0;
        // DR-MPS-15: what the previous tick returned (`None` before the first),
        // since when ticks have been yielding, and the wait a skip carries over.
        let mut previous: Option<BuildOutcome> = None;
        let mut skipping_since: Option<Instant> = None;
        let mut last_wait = policy.retry_delay;
        loop {
            let Some(state) = weak_state.upgrade() else {
                break;
            };
            let work_state = state.clone();
            let work_request = request.clone();
            let work_project = project.clone();
            let work_participant = participant.clone();
            let work_build = Arc::clone(&build);
            // A `schedule` that found this task already running asks for a
            // foreground tick (once). Read it before the mode is decided.
            let requested = lock(&state.related_scenes.builds)
                .map(|mut builds| builds.take_foreground(&key, generation))
                .unwrap_or(false);
            let mode = if requested {
                TickMode::Foreground
            } else {
                next_tick_mode(
                    previous.as_ref(),
                    skipping_since.map_or(Duration::ZERO, |since| since.elapsed()),
                    policy.yield_window,
                )
            };
            let result = tokio::task::spawn_blocking(move || {
                work_build(
                    &work_state,
                    &work_request,
                    &work_participant,
                    &work_project,
                    mode,
                )
            })
            .await;
            let outcome = match result {
                Ok(Ok(outcome)) => outcome,
                _ => break,
            };
            let (next_streak, verdict) =
                next_reader_retry_streak(reader_retry_streak, &outcome, policy.max_reader_retries);
            reader_retry_streak = next_streak;
            let (next_stale_streak, wait) =
                next_wait(last_wait, stale_retry_streak, &outcome, &policy);
            stale_retry_streak = next_stale_streak;
            last_wait = wait;
            skipping_since = next_skipping_since(skipping_since, mode, &outcome, Instant::now());
            tracing::debug!(target:"grimodex::nir1_index", outcome=outcome.label(),
                reader_retry_streak,stale_retry_streak,skipping=skipping_since.is_some(),wait_ms=wait.as_millis(),"NIR1 build outcome");
            if let StreakVerdict::Stop(reason) = verdict {
                // Logged once: the loop ends here and the reservation below
                // is released (the next `begin` starts a fresh task).
                tracing::warn!(target:"grimodex::nir1_index", identity=key.0, project=%project,
                    ?reason, max_reader_retries = policy.max_reader_retries,
                    "NIR1 reader retries exhausted; stopping the Related Scenes index build");
                break;
            }
            match outcome {
                BuildOutcome::Ready => {
                    state
                        .events
                        .emit("related-scenes:index-ready", json!({"projectId":project}));
                }
                // Pending Feed work can outlive the originating query. Keep
                // its single workspace-bound rebuild alive until the actual
                // canonical state settles or the pinned runtime is revoked.
                BuildOutcome::Retry
                | BuildOutcome::StaleRetry
                | BuildOutcome::ReaderRetry(_)
                | BuildOutcome::Idle
                | BuildOutcome::Skipped => {}
                BuildOutcome::Stopped => break,
            }
            // DR-MPS-16: a skip retries after `skip_delay` at most; `last_wait`
            // itself stays as it was.
            let sleep_for = if matches!(outcome, BuildOutcome::Skipped) {
                wait.min(policy.skip_delay)
            } else {
                wait
            };
            previous = Some(outcome);
            drop(state);
            tokio::time::sleep(sleep_for).await;
        }
        if let Some(state) = weak_state.upgrade() {
            if let Ok(mut builds) = lock(&state.related_scenes.builds) {
                builds.release(&key, generation);
            };
        }
    });
    Ok(())
}

enum BuildOutcome {
    Ready,
    /// The prepare side saw `PendingChange` (Feed work still settling).
    /// Waits `RETRY_DELAY`.
    Retry,
    /// The publish-side check was `Stale` (DR-IRB-7). Waits
    /// `STALE_RETRY_DELAY` for the first `MAX_CONSECUTIVE_STALE_RETRIES` in a
    /// row.
    StaleRetry,
    /// A `Retry` caused by the dedicated reader (DR-IRB-3). Counted against
    /// `MAX_CONSECUTIVE_READER_RETRIES`.
    ReaderRetry(index::NirIndexUnavailableReason),
    Idle,
    /// DR-MPS-15: a `Yielding` tick found the connection in use and did
    /// nothing (no waiter was announced). It changes neither the reader-retry
    /// streak nor the stale streak, and the task waits the same as before it.
    Skipped,
    Stopped,
}

impl BuildOutcome {
    fn label(&self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Retry => "retry",
            Self::StaleRetry => "stale-retry",
            Self::ReaderRetry(_) => "reader-retry",
            Self::Idle => "idle",
            Self::Skipped => "skipped",
            Self::Stopped => "stopped",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum StreakVerdict {
    Continue,
    Stop(index::NirIndexUnavailableReason),
}

/// How long the task sleeps after `outcome`, and the next `StaleRetry` streak
/// (DR-IRB-7). The first `max_stale_retries` consecutive `StaleRetry` wait
/// `stale_delay`; the ones after that, and every other outcome, wait
/// `retry_delay`. Any outcome other than `StaleRetry` resets the streak.
fn next_retry_wait(
    stale_streak: u32,
    outcome: &BuildOutcome,
    policy: &RetryPolicy,
) -> (u32, Duration) {
    match outcome {
        BuildOutcome::StaleRetry => {
            let streak = stale_streak.saturating_add(1);
            let wait = if streak <= policy.max_stale_retries {
                policy.stale_delay
            } else {
                policy.retry_delay
            };
            (streak, wait)
        }
        // Not used by the loop (see `next_wait`, which carries the previous
        // wait over a skip); kept so the match stays total.
        BuildOutcome::Skipped => (stale_streak, policy.retry_delay),
        _ => (0, policy.retry_delay),
    }
}

/// `next_retry_wait`, except that a `Skipped` tick keeps both the stale streak
/// and the wait that preceded it (DR-MPS-15): a skip is not an outcome of the
/// build, so it must not restart or advance the DR-IRB-7 waits.
fn next_wait(
    previous_wait: Duration,
    stale_streak: u32,
    outcome: &BuildOutcome,
    policy: &RetryPolicy,
) -> (u32, Duration) {
    match outcome {
        BuildOutcome::Skipped => (stale_streak, previous_wait),
        _ => next_retry_wait(stale_streak, outcome, policy),
    }
}

/// The reader-retry counter: a reader-caused `Retry` adds one and `K` of them
/// in a row stop the task; every other outcome (`Ready`, `Idle`, an ordinary
/// `Retry`, `StaleRetry`) resets it, except `Skipped`, which neither adds nor
/// resets (DR-MPS-15: a yielded tick says nothing about the reader).
fn next_reader_retry_streak(
    streak: u32,
    outcome: &BuildOutcome,
    max_reader_retries: u32,
) -> (u32, StreakVerdict) {
    match outcome {
        BuildOutcome::ReaderRetry(reason) => {
            let streak = streak.saturating_add(1);
            if streak >= max_reader_retries {
                (streak, StreakVerdict::Stop(*reason))
            } else {
                (streak, StreakVerdict::Continue)
            }
        }
        BuildOutcome::Skipped => (streak, StreakVerdict::Continue),
        _ => (0, StreakVerdict::Continue),
    }
}

/// E11: reader reasons are either transient (`Retry`, bounded by the streak)
/// or mean the authority is not the file that was admitted (`Stopped`).
fn reader_reason_outcome(reason: index::NirIndexUnavailableReason) -> Option<BuildOutcome> {
    use index::NirIndexUnavailableReason as Reason;
    match reason {
        Reason::ReaderOpenFailed
        | Reason::ReaderBusy
        | Reason::ReaderSlotBusy
        | Reason::ReaderCloseUnproven => Some(BuildOutcome::ReaderRetry(reason)),
        Reason::ReaderIdentityMismatch | Reason::ReaderUnavailableForMemoryDatabase => {
            Some(BuildOutcome::Stopped)
        }
        _ => None,
    }
}

/// The detached Chronicle build is a lifecycle participant, but the
/// participant itself is not a full-roster validation context.  Borrow the
/// exact pinned request and re-check its workspace/generation at every Source
/// page and serialization boundary so a transition or shutdown can interrupt
/// the eligibility read before publication.
pub(super) struct RelatedScenesBuildControl<'a> {
    state: &'a AppState,
    request: &'a SemanticRequest,
    participant: &'a WorkspaceParticipant,
}

impl<'a> RelatedScenesBuildControl<'a> {
    pub(super) fn new(
        state: &'a AppState,
        request: &'a SemanticRequest,
        participant: &'a WorkspaceParticipant,
    ) -> Self {
        RelatedScenesBuildControl {
            state,
            request,
            participant,
        }
    }
}

impl GraphWorkControl for RelatedScenesBuildControl<'_> {
    fn check(&mut self, _stage: GraphWorkStage) -> anyhow::Result<()> {
        use grimodex_db::narrative_extraction::{
            validation_terminated, ValidationTerminationReason,
        };
        if self
            .participant
            .stop_requested()
            .map_err(|error| anyhow!(error.to_string()))?
            || self.state.ws.safe_mode.is_active()
        {
            return Err(validation_terminated(
                ValidationTerminationReason::Cancelled,
                "RELATED_SCENES_INVALIDATED",
            ));
        }
        if self.state.semantic.snapshot_epoch().generation() != self.request.epoch().generation() {
            return Err(validation_terminated(
                ValidationTerminationReason::WorkspaceGenerationChanged,
                "RELATED_SCENES_WORKSPACE_CHANGED",
            ));
        }
        Ok(())
    }

    fn allows_full_eligibility(&self) -> bool {
        true
    }
}

fn identity(model: SemanticEmbeddingIdentity) -> index::NirEmbeddingIdentity {
    index::NirEmbeddingIdentity {
        model_id: model.model_id,
        artifact_sha256: model.artifact_sha256,
        tokenizer_sha256: model.tokenizer_sha256,
        embedding_dim: model.embedding_dim,
        chunker_version: model.chunker_version,
    }
}
fn audit(audit: SemanticEmbeddingAuditBinding) -> index::NirEmbeddingAuditBinding {
    index::NirEmbeddingAuditBinding {
        operation_id: audit.operation_id,
        execution_id: audit.execution_id,
    }
}

/// What the reader-side half of one build produced. The plan is consumed
/// immediately; keep it inline rather than boxing it.
#[allow(clippy::large_enum_variant)]
enum Prepared {
    Finished(BuildOutcome),
    Ready {
        plan: index::NirIndexBuildPlan,
        documents: Vec<grimodex_db::narrative_extraction::ChronicleRetrievalDocument>,
    },
}

/// The authority admission and the dedicated-reader prepare of one build
/// (DR-IRB-3). The reader slot permit is taken first and is always either
/// consumed by `with_chronicle_reader` or given back here: no early return
/// leaves it taken unless the reader's close was not proven (E8 (a)).
#[cfg(test)]
fn prepare_on_reader(
    request: &SemanticRequest,
    participant: &WorkspaceParticipant,
    project: &str,
    control: &mut dyn GraphWorkControl,
) -> Result<Prepared> {
    prepare_on_reader_with_mode(request, participant, project, control, TickMode::Foreground)
}

/// `mode` only changes how the first database acquisition, the authority
/// admission, is taken: `Yielding` tries once without announcing a waiter and
/// a busy connection is `Skipped` (the reader permit is given back first).
/// The reader's own work and everything after the admission are unchanged.
fn prepare_on_reader_with_mode(
    request: &SemanticRequest,
    participant: &WorkspaceParticipant,
    project: &str,
    control: &mut dyn GraphWorkControl,
    mode: TickMode,
) -> Result<Prepared> {
    let db = request.database();
    let runtime = db.nir_chronicle_index_runtime();
    let Some(permit) = runtime.try_acquire_reader_permit() else {
        if runtime.chronicle_reader_slot_blocked() {
            // A reader's close was not proven: the slot never comes back
            // (E8 (a)), so retrying cannot help. Stop now; a workspace
            // re-open starts a new authority with a free slot.
            tracing::warn!(target:"grimodex::nir1_index", project=%project,
                "NIR1 reader slot blocked by an unproven close; stopping the index build");
            return Ok(Prepared::Finished(BuildOutcome::Stopped));
        }
        // Another build's reader is in flight: wait for it (counted by K).
        return Ok(Prepared::Finished(BuildOutcome::ReaderRetry(
            index::NirIndexUnavailableReason::ReaderSlotBusy,
        )));
    };
    let read_admission =
        |conn: &_| runtime.chronicle_reader_admission(conn, project, &mut *control);
    let admission_read = match mode {
        TickMode::Foreground => db
            .with_participant_read_transaction(participant, read_admission)
            .map(Some),
        TickMode::Yielding => db.try_with_participant_read_transaction(participant, read_admission),
    };
    let admission = match admission_read {
        // The connection is in use: nothing was read and no waiter was
        // announced. Give the permit back like every other early return.
        Ok(None) => {
            permit.release_unused();
            return Ok(Prepared::Finished(BuildOutcome::Skipped));
        }
        Ok(Some(index::ChronicleReaderAdmissionRead::Admitted(admission))) => admission,
        Ok(Some(index::ChronicleReaderAdmissionRead::Idle)) => {
            permit.release_unused();
            return Ok(Prepared::Finished(BuildOutcome::Idle));
        }
        Ok(Some(index::ChronicleReaderAdmissionRead::Stopped)) => {
            permit.release_unused();
            return Ok(Prepared::Finished(BuildOutcome::Stopped));
        }
        Err(error) => {
            permit.release_unused();
            return Err(error);
        }
    };
    if admission.already_usable() {
        permit.release_unused();
        return Ok(Prepared::Finished(BuildOutcome::Idle));
    }
    if !admission.reader_available() {
        // An in-memory authority has no second connection. Stop with a typed
        // reason; never fall back to preparing on the authority silently.
        permit.release_unused();
        return Ok(Prepared::Finished(BuildOutcome::Stopped));
    }
    let prepared = runtime.with_chronicle_reader(permit, &admission, participant, |conn| {
        index::prepare_chronicle_index_build_on_reader(
            conn,
            runtime,
            &admission,
            project,
            &mut *control,
        )
    });
    let prepared = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            return match index::chronicle_reader_error_reason(&error)
                .and_then(reader_reason_outcome)
            {
                Some(outcome) => {
                    tracing::debug!(target:"grimodex::nir1_index", error=%error,
                        "NIR1 reader prepare ended without a plan");
                    Ok(Prepared::Finished(outcome))
                }
                None => Err(error),
            }
        }
    };
    Ok(match prepared {
        index::NirIndexBuildRead::Ready { plan, documents } => Prepared::Ready { plan, documents },
        index::NirIndexBuildRead::AlreadyUsable => Prepared::Finished(BuildOutcome::Idle),
        index::NirIndexBuildRead::Unavailable {
            reason: index::NirIndexUnavailableReason::PendingChange,
        } => Prepared::Finished(BuildOutcome::Retry),
        _ => Prepared::Finished(BuildOutcome::Stopped),
    })
}

#[cfg(test)]
fn build_once(
    state: &AppState,
    request: &SemanticRequest,
    participant: &WorkspaceParticipant,
    project: &str,
) -> Result<BuildOutcome> {
    build_once_with_mode(state, request, participant, project, TickMode::Foreground)
}

fn build_once_with_mode(
    state: &AppState,
    request: &SemanticRequest,
    participant: &WorkspaceParticipant,
    project: &str,
    mode: TickMode,
) -> Result<BuildOutcome> {
    let started = Instant::now();
    if !current_request(state, request)? {
        return Ok(BuildOutcome::Stopped);
    }
    let db = request.database();
    let mut control = RelatedScenesBuildControl::new(state, request, participant);
    let (plan, documents) =
        match prepare_on_reader_with_mode(request, participant, project, &mut control, mode)? {
            Prepared::Ready { plan, documents } => (plan, documents),
            Prepared::Finished(outcome) => return Ok(outcome),
        };
    let prepared_at = Instant::now();
    let model = identity(
        state
            .semantic
            .nir1_document_embedding_identity_with_control(request, project, || {
                control.check(GraphWorkStage::Row)
            })?,
    );
    let mut outcomes = db.with_participant_read_transaction(participant, |conn| {
        index::read_reusable_chronicle_embeddings(
            conn,
            db.nir_chronicle_index_runtime(),
            &plan,
            &model,
        )
    })?;
    let reused_count = outcomes.len();
    let reused = outcomes
        .iter()
        .map(|outcome| outcome.document().revision_id.clone())
        .collect::<HashSet<_>>();
    let documents = documents
        .into_iter()
        .filter(|doc| !reused.contains(&doc.revision_id))
        .collect::<Vec<_>>();
    let inputs = documents
        .iter()
        .map(|doc| Nir1EmbeddingDocument {
            revision_id: doc.revision_id.clone(),
            envelope_digest: doc.envelope_digest.clone(),
            serializer_ref: doc.serializer_ref.into(),
            serialized_statement: doc.serialized_statement.clone(),
            serialized_statement_digest: doc.serialized_statement_digest.clone(),
        })
        .collect::<Vec<_>>();
    let embedded =
        state
            .semantic
            .embed_nir1_documents_with_control(request, project, &inputs, || {
                control.check(GraphWorkStage::Row)
            })?;
    ensure!(
        documents.len() == embedded.len(),
        "RELATED_SCENES_DOCUMENT_OUTCOME_MISSING"
    );
    let generated = documents
        .into_iter()
        .zip(embedded)
        .map(|(original, outcome)| match outcome {
            Nir1DocumentEmbeddingOutcome::Indexed {
                document,
                embedding,
                identity: model,
                audit_binding,
            } => {
                ensure!(
                    document.revision_id == original.revision_id
                        && document.serialized_statement_digest
                            == original.serialized_statement_digest,
                    "RELATED_SCENES_DOCUMENT_OUTCOME_CHANGED"
                );
                Ok(index::NirEmbeddedDocument::Indexed {
                    document: original,
                    embedding,
                    identity: identity(model),
                    audit_binding: audit(audit_binding),
                })
            }
            Nir1DocumentEmbeddingOutcome::SkippedTokenLimit {
                document,
                limit,
                identity: model,
                audit_binding,
            } => {
                ensure!(
                    document.revision_id == original.revision_id
                        && document.serialized_statement_digest
                            == original.serialized_statement_digest,
                    "RELATED_SCENES_DOCUMENT_OUTCOME_CHANGED"
                );
                Ok(index::NirEmbeddedDocument::SkippedTokenLimit {
                    document: original,
                    identity: identity(model),
                    audit_binding: audit(audit_binding),
                    actual_tokens: limit.actual_tokens,
                    maximum_tokens: limit.maximum_tokens,
                })
            }
        })
        .collect::<Result<Vec<_>>>()?;
    outcomes.extend(generated);
    let embedded_at = Instant::now();
    if !current_request(state, request)? {
        return Ok(BuildOutcome::Stopped);
    }
    let published = index::publish_chronicle_index_build_with_participant(
        &db,
        db.nir_chronicle_index_runtime(),
        plan,
        outcomes,
        &mut control,
        participant,
    )?;
    tracing::debug!(target:"grimodex::nir1_index", prepare_ms=prepared_at.duration_since(started).as_millis(),
        embedding_ms=embedded_at.duration_since(prepared_at).as_millis(),
        publication_ms=embedded_at.elapsed().as_millis(),reused_count,"NIR1 build components");
    publish_outcome(state, request, published)
}

/// The outcome of `build_once` for a publish result. `Stale` is not only
/// Freshness: a mismatch of the owner or a rotation of the runtime epoch
/// (pause/resume, an embedding runtime swap) also give it. Those are harmless:
/// the next attempt stops or proceeds with the new epoch.
fn publish_outcome(
    state: &AppState,
    request: &SemanticRequest,
    published: index::NirIndexPublishRead,
) -> Result<BuildOutcome> {
    match published {
        index::NirIndexPublishRead::Published {
            newly_usable_published: true,
            ..
        } if current_request(state, request)? => Ok(BuildOutcome::Ready),
        index::NirIndexPublishRead::Stale => Ok(BuildOutcome::StaleRetry),
        _ => Ok(BuildOutcome::Stopped),
    }
}

#[cfg(test)]
#[path = "build_tests.rs"]
mod tests;
