//! DR-IRB-3 (stage 2): the dedicated-reader half of `build_once`. A real
//! embedder is not available here, so the harness drives the reader-side
//! phase (`prepare_on_reader`), the publish boundary and the retry loop
//! (`schedule_with`) separately, on a file workspace with the cold
//! reviewed-child database. Unix-only cases replace the database file under
//! the open authority, which Windows forbids.
use super::*;
use crate::state::AppState;
use grimodex_db::narrative_extraction::{
    GraphWorkControl, GraphWorkStage, ValidationTerminated, ValidationTerminationReason,
};
use grimodex_db::state::{ActiveWorkspace, PinnedWorkspaceDb, WorkspaceAuthority};
use index::NirIndexUnavailableReason as Reason;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;

struct Harness {
    root: PathBuf,
    state: Arc<AppState>,
    authority: PinnedWorkspaceDb,
    project: String,
}

impl Harness {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("irb-reader-build-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".grimodex")).expect("workspace directory");
        std::fs::write(
            root.join(".grimodex/workspace.json"),
            r#"{"id":"irb-reader-workspace"}"#,
        )
        .expect("workspace metadata");
        let db_path = root.join("grimodex.db");
        let project = index::write_reviewed_child_cold_database_for_test(&db_path)
            .expect("cold reviewed-child database");
        let backend =
            crate::Backend::new(root.join("app").to_string_lossy().into_owned(), None, None)
                .expect("Native backend");
        let state = Arc::clone(&backend.state);
        let db = grimodex_db::Database::new(&db_path).expect("database");
        db.migrate().expect("schema");
        let authority =
            WorkspaceAuthority::from_database_for_test(db, root.clone()).expect("authority");
        *state.ws.inner.lock().expect("workspace") =
            Some(ActiveWorkspace::new(Arc::clone(&authority)));
        state
            .workspace_lifecycle
            .ensure_authority_ready(&state.ws)
            .expect("Ready publication");
        std::mem::forget(backend);
        // A real workspace open rotates the semantic epoch to a bound
        // generation (the Chronicle runtime refuses generation 0).
        state.semantic.semantic_cancel_background();
        Self {
            root,
            state,
            authority,
            project,
        }
    }

    fn request(&self) -> SemanticRequest {
        self.state
            .semantic
            .pin_request(|| grimodex_db::state::active_database(&self.state.ws))
            .expect("pinned request")
    }

    fn participant(&self) -> WorkspaceParticipant {
        self.state
            .ws
            .lifecycle_core()
            .begin_workspace_participant()
            .expect("participant")
    }

    fn runtime(&self) -> &index::NirChronicleIndexRuntime {
        self.authority.nir_chronicle_index_runtime()
    }

    fn prepare(
        &self,
        request: &SemanticRequest,
        participant: &WorkspaceParticipant,
    ) -> Result<Prepared> {
        let mut control = RelatedScenesBuildControl::new(&self.state, request, participant);
        prepare_on_reader(request, participant, &self.project, &mut control)
    }

    fn metadata_rows(&self) -> i64 {
        self.authority
            .db()
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM narrative_semantic_index_metadata WHERE project_id=?1",
                    [&self.project],
                    |row| row.get(0),
                )?)
            })
            .expect("metadata rows")
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn outcome(prepared: Prepared) -> BuildOutcome {
    match prepared {
        Prepared::Finished(outcome) => outcome,
        Prepared::Ready { .. } => panic!("a plan was not expected"),
    }
}

fn reader_reason(outcome: &BuildOutcome) -> Option<Reason> {
    match outcome {
        BuildOutcome::ReaderRetry(reason) => Some(*reason),
        _ => None,
    }
}

/// (d) The reader never outlives a phase: the two exits exercised here (a plan
/// and a `Stopped` admission) leave zero readers and the permit of an early
/// return is given back. The busy slot is (q) and the open failure is (e)
/// below; an admission error is exercised by (t) `a_retired_authority_opens_no_reader`.
#[test]
fn every_prepare_exit_leaves_no_reader_and_gives_the_slot_back() {
    let h = Harness::new();
    let request = h.request();
    let participant = h.participant();
    let Prepared::Ready { plan, documents } = h.prepare(&request, &participant).expect("prepare")
    else {
        panic!("the cold workspace needs a build");
    };
    assert_eq!(documents.len(), 2);
    drop(plan);
    assert_eq!(h.runtime().live_chronicle_readers(), 0);

    // Unknown project: the admission is `Stopped` and no reader is opened.
    let mut control = RelatedScenesBuildControl::new(&h.state, &request, &participant);
    let stopped = prepare_on_reader(&request, &participant, "no-such-project", &mut control)
        .expect("stopped");
    assert!(matches!(outcome(stopped), BuildOutcome::Stopped));
    assert_eq!(h.runtime().live_chronicle_readers(), 0);
}

/// P3-5 (iii): a slot whose reader close was never proven is blocked for good
/// (E8 (a)). The next prepare stops at once (no `ReaderSlotBusy` retry streak)
/// and touches neither the slot nor the database.
#[test]
fn a_blocked_slot_stops_the_build_at_once() {
    let h = Harness::new();
    let request = h.request();
    let participant = h.participant();
    h.runtime().block_chronicle_reader_slot_for_test();
    assert!(h.runtime().chronicle_reader_slot_blocked());
    assert_eq!(h.runtime().live_chronicle_readers(), 1);
    let blocked = outcome(h.prepare(&request, &participant).expect("blocked slot"));
    assert!(
        matches!(blocked, BuildOutcome::Stopped),
        "{}",
        blocked.label()
    );
    assert!(h.runtime().chronicle_reader_slot_blocked(), "still blocked");
    assert!(h.runtime().try_acquire_reader_permit().is_none());
    assert_eq!(h.runtime().live_chronicle_readers(), 1, "never given back");
}

/// (q) A second build while a reader is in flight is a slot `Retry`, touches
/// no database, and the slot is usable again once the first one is done.
#[test]
fn a_second_reader_is_a_slot_retry_without_touching_the_database() {
    let h = Harness::new();
    let request = h.request();
    let participant = h.participant();
    let held = h
        .runtime()
        .try_acquire_reader_permit()
        .expect("first reader");
    let retry = outcome(h.prepare(&request, &participant).expect("slot busy"));
    assert_eq!(reader_reason(&retry), Some(Reason::ReaderSlotBusy));
    assert_eq!(
        h.runtime().live_chronicle_readers(),
        1,
        "the first still holds"
    );
    held.release_unused();
    assert!(matches!(
        h.prepare(&request, &participant).expect("free again"),
        Prepared::Ready { .. }
    ));
    assert_eq!(h.runtime().live_chronicle_readers(), 0);
}

/// Make the database file unreadable for a new connection while the
/// authority keeps its open handle. `false` when permissions do not bind
/// (running as root): the caller skips the test.
#[cfg(unix)]
fn make_unreadable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o000)).expect("chmod");
    std::fs::File::open(path).is_err()
}

/// A slot merely in use is a counted `Retry`, and a permit given back is not a
/// block. (The blocked-slot `Stopped` needs a close that cannot be proven; its
/// `chronicle_reader_slot_blocked` flag is a grimodex-db test.)
#[test]
fn a_busy_slot_retries_and_a_returned_permit_is_not_a_block() {
    let h = Harness::new();
    let request = h.request();
    let participant = h.participant();
    let held = h.runtime().try_acquire_reader_permit().expect("in use");
    let busy = outcome(h.prepare(&request, &participant).expect("busy"));
    assert_eq!(reader_reason(&busy), Some(Reason::ReaderSlotBusy));
    drop(held);
    // The permit given back is not a block.
    assert!(!h.runtime().chronicle_reader_slot_blocked());
    assert!(matches!(
        h.prepare(&request, &participant).expect("free"),
        Prepared::Ready { .. }
    ));
}

/// (e) An open failure is a reader `Retry` and gives the slot back. (A file
/// replaced under the authority is not detectable here: the admission names
/// the path through the authority's connection and takes the identity of
/// whatever is at that path now; the shared workspace lease is what forbids a
/// replacement. The mismatch refusal itself is a grimodex-db test.)
#[cfg(unix)]
#[test]
fn open_failure_is_a_reader_retry() {
    let h = Harness::new();
    let request = h.request();
    let participant = h.participant();
    if !make_unreadable(&h.root.join("grimodex.db")) {
        eprintln!("skip: open_failure_is_a_reader_retry (root では権限が効かない)");
        return;
    }
    let retry = outcome(h.prepare(&request, &participant).expect("open failure"));
    assert!(matches!(
        reader_reason(&retry),
        Some(Reason::ReaderOpenFailed)
    ));
    assert_eq!(h.runtime().live_chronicle_readers(), 0);
}

/// (e) Only reader retries count, `K` of them in a row stop the task, and
/// anything else starts the count over.
#[test]
fn k_consecutive_reader_retries_stop_and_other_outcomes_reset() {
    let reader = BuildOutcome::ReaderRetry(Reason::ReaderBusy);
    let mut streak = 0;
    for expected in 1..MAX_CONSECUTIVE_READER_RETRIES {
        let (next, verdict) =
            next_reader_retry_streak(streak, &reader, MAX_CONSECUTIVE_READER_RETRIES);
        assert_eq!((next, verdict), (expected, StreakVerdict::Continue));
        streak = next;
    }
    let (_, verdict) = next_reader_retry_streak(streak, &reader, MAX_CONSECUTIVE_READER_RETRIES);
    assert_eq!(verdict, StreakVerdict::Stop(Reason::ReaderBusy));
    for reset in [BuildOutcome::Ready, BuildOutcome::Idle, BuildOutcome::Retry] {
        assert_eq!(
            next_reader_retry_streak(streak, &reset, MAX_CONSECUTIVE_READER_RETRIES),
            (0, StreakVerdict::Continue),
            "{}",
            reset.label()
        );
    }
    assert_eq!(MAX_CONSECUTIVE_READER_RETRIES, 40);
    assert_eq!(RETRY_DELAY, Duration::from_millis(250));
}

#[test]
fn reader_reasons_map_to_retry_or_stopped() {
    for reason in [
        Reason::ReaderOpenFailed,
        Reason::ReaderBusy,
        Reason::ReaderSlotBusy,
        Reason::ReaderCloseUnproven,
    ] {
        assert!(matches!(
            reader_reason_outcome(reason),
            Some(BuildOutcome::ReaderRetry(r)) if r == reason
        ));
    }
    for reason in [
        Reason::ReaderIdentityMismatch,
        Reason::ReaderUnavailableForMemoryDatabase,
    ] {
        assert!(matches!(
            reader_reason_outcome(reason),
            Some(BuildOutcome::Stopped)
        ));
    }
    assert!(reader_reason_outcome(Reason::PendingChange).is_none());
}

/// (e) The task itself: with an unopenable database the reservation stays
/// while it retries, and after `K` reader retries the task ends and releases
/// the reservation. `K` and the delay are shortened for the test.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn the_task_keeps_its_reservation_while_retrying_then_stops_after_k() {
    let h = Harness::new();
    let request = h.request();
    let participant = h.participant();
    if !make_unreadable(&h.root.join("grimodex.db")) {
        eprintln!("skip: the_task_keeps_its_reservation_while_retrying_then_stops_after_k (root では権限が効かない)");
        return;
    }
    let key = (request.database().identity(), h.project.clone());
    let generation = request.epoch().generation();
    let started = Instant::now();
    schedule_with(
        Arc::clone(&h.state),
        request,
        participant,
        h.project.clone(),
        Duration::from_millis(40),
        4,
    )
    .expect("scheduled");
    assert!(
        !lock(&h.state.related_scenes.builds)
            .expect("builds")
            .reserve(key.clone(), generation),
        "a retrying build keeps its reservation"
    );
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let reserved = lock(&h.state.related_scenes.builds)
            .expect("builds")
            .reserve(key.clone(), generation);
        if reserved {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the task must stop after K retries"
        );
    }
    assert!(
        started.elapsed() >= Duration::from_millis(40 * 3),
        "K retries need K-1 delays"
    );
    assert_eq!(h.runtime().live_chronicle_readers(), 0);
}

/// (i) A rotation of the runtime epoch or a participant stop after the reader
/// read the plan keeps the publish from writing anything or installing a proof.
#[test]
fn an_epoch_rotation_or_a_stop_after_the_reader_prevents_publication() {
    let h = Harness::new();
    let request = h.request();
    let participant = h.participant();
    let Prepared::Ready { plan, .. } = h.prepare(&request, &participant).expect("prepare") else {
        panic!("plan");
    };
    let epoch = request.epoch().generation();
    h.runtime()
        .bind_embedding_generation(epoch + 1)
        .expect("rotate");
    let mut control = RelatedScenesBuildControl::new(&h.state, &request, &participant);
    let published = index::publish_chronicle_index_build_with_participant(
        h.authority.db(),
        h.runtime(),
        plan,
        Vec::new(),
        &mut control,
        &participant,
    )
    .expect("stale publish");
    assert!(matches!(published, index::NirIndexPublishRead::Stale));
    assert_eq!(h.metadata_rows(), 0, "nothing was bound");
    assert_eq!(h.runtime().live_chronicle_readers(), 0);

    // A stopped participant ends the publish as a typed termination.
    let h = Harness::new();
    let request = h.request();
    let participant = h.participant();
    let Prepared::Ready { plan, .. } = h.prepare(&request, &participant).expect("prepare") else {
        panic!("plan");
    };
    h.state
        .ws
        .lifecycle_core()
        .request_shutdown()
        .expect("shutdown");
    let mut control = RelatedScenesBuildControl::new(&h.state, &request, &participant);
    let error = index::publish_chronicle_index_build_with_participant(
        h.authority.db(),
        h.runtime(),
        plan,
        Vec::new(),
        &mut control,
        &participant,
    )
    .expect_err("stopped publish");
    assert!(
        error.downcast_ref::<ValidationTerminated>().is_some(),
        "{error:#}"
    );
    assert_eq!(h.metadata_rows(), 0);
}

/// Panics on the first candidate check, which only the reader's prepare
/// reaches (the admission asks for `Source` only).
struct PanicOnRow;

impl GraphWorkControl for PanicOnRow {
    fn check(&mut self, stage: GraphWorkStage) -> Result<()> {
        if stage == GraphWorkStage::Row {
            panic!("injected panic inside the reader prepare");
        }
        Ok(())
    }

    fn allows_full_eligibility(&self) -> bool {
        true
    }
}

/// (s) A panic inside the reader's operation: no reader left, the authority
/// stays usable, and the next build works.
#[test]
fn a_panic_inside_the_reader_leaves_no_reader_and_a_usable_authority() {
    let h = Harness::new();
    let request = h.request();
    let participant = h.participant();
    let panic = catch_unwind(AssertUnwindSafe(|| {
        let _ = prepare_on_reader(&request, &participant, &h.project, &mut PanicOnRow);
    }))
    .expect_err("the panic propagates");
    assert_eq!(
        panic.downcast_ref::<&str>(),
        Some(&"injected panic inside the reader prepare")
    );
    assert_eq!(h.runtime().live_chronicle_readers(), 0);
    assert!(h.authority.connection_reusable());
    assert!(matches!(
        h.prepare(&request, &participant).expect("next build"),
        Prepared::Ready { .. }
    ));
}

/// (t) An authority that was retired or quarantined never gets a reader: the
/// admission fails, the permit is given back and nothing is opened.
#[test]
fn a_retired_authority_opens_no_reader() {
    let h = Harness::new();
    let request = h.request();
    let participant = h.participant();
    h.authority
        .db()
        .retire_connection_for_recovery()
        .expect("retire the authority connection");
    assert!(!h.authority.connection_reusable());
    let error = h
        .prepare(&request, &participant)
        .err()
        .expect("no admission without a usable authority");
    assert!(
        index::chronicle_reader_error_reason(&error).is_none(),
        "an authority failure is an error (Stopped), not a reader retry: {error:#}"
    );
    assert_eq!(h.runtime().live_chronicle_readers(), 0);
}

/// Requests the stop at the first candidate check and remembers when.
struct StopAtFirstRow<'a> {
    inner: RelatedScenesBuildControl<'a>,
    core: grimodex_db::WorkspaceLifecycleCore,
    stopped_at: Option<Instant>,
}

impl GraphWorkControl for StopAtFirstRow<'_> {
    fn check(&mut self, stage: GraphWorkStage) -> Result<()> {
        if stage == GraphWorkStage::Row && self.stopped_at.is_none() {
            self.core.request_shutdown().expect("shutdown");
            self.stopped_at = Some(Instant::now());
        }
        self.inner.check(stage)
    }

    fn allows_full_eligibility(&self) -> bool {
        true
    }
}

/// (p) Stop in the middle of the reader's prepare: the reader is closed and
/// no plan is returned. The elapsed time from the stop to the close is
/// printed (the tiny fixture bounds only the fixed cost; a real workspace's
/// figure is the candidate preflight, measured separately).
#[test]
fn a_stop_during_the_reader_prepare_closes_the_reader_promptly() {
    let mut worst = Duration::ZERO;
    for _ in 0..3 {
        let h = Harness::new();
        let request = h.request();
        let participant = h.participant();
        let mut control = StopAtFirstRow {
            inner: RelatedScenesBuildControl::new(&h.state, &request, &participant),
            core: h.state.ws.lifecycle_core().clone(),
            stopped_at: None,
        };
        let error = prepare_on_reader(&request, &participant, &h.project, &mut control)
            .err()
            .expect("a stop ends the prepare");
        let closed_after = control
            .stopped_at
            .expect("the stop was requested")
            .elapsed();
        assert!(error.downcast_ref::<ValidationTerminated>().is_some());
        assert_eq!(
            error
                .downcast_ref::<ValidationTerminated>()
                .map(|e| e.reason),
            Some(ValidationTerminationReason::Cancelled)
        );
        assert_eq!(h.runtime().live_chronicle_readers(), 0, "closed, slot back");
        worst = worst.max(closed_after);
    }
    eprintln!("IRB3_STOP_TO_READER_CLOSE_MS={}", worst.as_millis());
    assert!(worst < Duration::from_secs(2), "{worst:?}");
}
