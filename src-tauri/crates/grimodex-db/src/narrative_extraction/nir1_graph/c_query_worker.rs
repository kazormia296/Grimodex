//! Native-owned, direct-spawn one-query worker. Product Graph IPC remains closed.
use std::{
    cell::UnsafeCell,
    io::{Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use anyhow::{anyhow, ensure, Result};

use crate::{
    state::{ActiveWorkspaceSnapshot, CQueryChildClaim},
    WorkspaceAuthority,
};

use super::{
    worker_frame::{self, FrameView},
    Nir1GraphRequest, QUERY_DEADLINE,
};

const PARENT_BYTES: usize = 524_288;
pub const REQUEST_BYTES: usize = 8_192;
const START_TIMEOUT: Duration = Duration::from_secs(30);
const CLEANUP_TIMEOUT: Duration = Duration::from_millis(500);
const POLL_INTERVAL: Duration = Duration::from_millis(1);
const FRAME_EXIT_POLL_INTERVAL: Duration = Duration::from_micros(100);

/// Owner metadata outside the fixed Native allocation is deducted from the
/// request/result allowance; the allocation itself never grows after reservation.
struct RegionControl {
    storage: Option<Vec<NativeRegion>>,
    claim: Option<CQueryChildClaim>,
    elapsed: Option<Duration>,
    result_len: usize,
    prepared_project_len: usize,
    preparation_attempted: bool,
    prepared: bool,
    started: bool,
    lease_held: bool,
    quarantined: bool,
}

const READER_READY: usize = 1 << 0;
const READER_FRAME: usize = 1 << 1;
const READER_FAILED: usize = 1 << 2;
const READER_EOF: usize = 1 << 3;
const READER_TRAILING: usize = 1 << 4;
const READER_PIPE_ERROR: usize = 1 << 5;
const OWNER_REQUEST: usize = 1 << 6;
const OWNER_CANCEL: usize = 1 << 7;
const PARENT_THREAD_READY: usize = 1 << 8;

/// Inline one-shot state and wake handles; no channel queue or backing allocation.
struct ReaderMailbox {
    events: AtomicUsize,
    frame_len: AtomicUsize,
    parent_thread: UnsafeCell<Option<thread::Thread>>,
}

const MAILBOX_BYTES: usize = std::mem::size_of::<ReaderMailbox>();
pub const FRAME_BYTES: usize = PARENT_BYTES
    - REQUEST_BYTES
    - std::mem::size_of::<RegionControl>()
    - std::mem::size_of::<usize>() // borrowed lease handle
    - MAILBOX_BYTES;
const STORAGE_BYTES: usize = REQUEST_BYTES + FRAME_BYTES;

/// The sole Native allocation owns both the bytes and the mailbox. Its address
/// stays stable while the detached reader runs; quarantine leaks it if the
/// reader cannot be joined after child exit and pipe EOF are proved.
struct NativeRegion {
    mailbox: ReaderMailbox,
    bytes: UnsafeCell<[u8; STORAGE_BYTES]>,
}

// SAFETY: `bytes` transfers from owner to reader at OWNER_REQUEST and back at
// READER_FRAME; those release/acquire bits prevent concurrent access. The
// parent-thread handle is initialized before PARENT_THREAD_READY and remains
// immutable until the reader is joined or the allocation is quarantined.
unsafe impl Sync for NativeRegion {}

#[derive(Clone, Copy)]
struct NativeRegionPtr(*const NativeRegion);

// SAFETY: the pointed-to allocation is stable and is retained until reader
// join, or leaked by quarantine if cleanup cannot prove termination.
unsafe impl Send for NativeRegionPtr {}

impl NativeRegionPtr {
    unsafe fn read_pipe(self, stdout: ChildStdout) {
        // SAFETY: preserved from the owner's stable-reservation contract.
        unsafe { read_worker_pipe(stdout, self.0) };
    }
}

const _: () = assert!(std::mem::size_of::<NativeRegion>() == MAILBOX_BYTES + STORAGE_BYTES);
const _: () = assert!(
    std::mem::size_of::<NativeRegion>()
        + std::mem::size_of::<RegionControl>()
        + std::mem::size_of::<usize>()
        == PARENT_BYTES
);

type Storage = Vec<NativeRegion>;

impl NativeRegion {
    fn new() -> Self {
        Self {
            mailbox: ReaderMailbox {
                events: AtomicUsize::new(0),
                frame_len: AtomicUsize::new(0),
                parent_thread: UnsafeCell::new(None),
            },
            bytes: UnsafeCell::new([0; STORAGE_BYTES]),
        }
    }

    fn set_parent_thread(&self, parent: thread::Thread) {
        // SAFETY: the reader waits for PARENT_THREAD_READY before reading this
        // field; this is the sole write and remains immutable through join.
        unsafe { *self.mailbox.parent_thread.get() = Some(parent) };
        self.mailbox
            .events
            .fetch_or(PARENT_THREAD_READY, Ordering::Release);
    }

    fn publish(&self, event: usize) {
        self.mailbox.events.fetch_or(event, Ordering::Release);
        // SAFETY: publishing events is only done after PARENT_THREAD_READY;
        // the field is immutable until this reader exits.
        if let Some(parent) = unsafe { (&*self.mailbox.parent_thread.get()).as_ref() } {
            parent.unpark();
        }
    }

    fn wait_for_parent_thread(&self) -> bool {
        loop {
            let events = self.mailbox.events.load(Ordering::Acquire);
            if events & OWNER_CANCEL != 0 {
                return false;
            }
            if events & PARENT_THREAD_READY != 0 {
                return true;
            }
            thread::park_timeout(POLL_INTERVAL);
        }
    }

    fn wait_for_request(&self) -> bool {
        loop {
            let events = self.mailbox.events.load(Ordering::Acquire);
            if events & OWNER_CANCEL != 0 {
                return false;
            }
            if events & OWNER_REQUEST != 0 {
                return true;
            }
            thread::park_timeout(POLL_INTERVAL);
        }
    }

    fn request(&self) {
        self.mailbox
            .events
            .fetch_or(OWNER_REQUEST, Ordering::Release);
    }

    fn cancel(&self) {
        self.mailbox
            .events
            .fetch_or(OWNER_CANCEL, Ordering::Release);
    }

    unsafe fn bytes_mut(&self) -> &mut [u8] {
        // SAFETY: callers must hold the exclusive buffer phase described above.
        unsafe { std::slice::from_raw_parts_mut(self.bytes.get().cast::<u8>(), STORAGE_BYTES) }
    }

    unsafe fn bytes(&self) -> &[u8] {
        // SAFETY: callers must hold the exclusive buffer phase described above.
        unsafe { std::slice::from_raw_parts(self.bytes.get().cast::<u8>(), STORAGE_BYTES) }
    }
}

fn reserve_storage() -> Result<Storage> {
    let mut storage = Vec::new();
    storage.try_reserve_exact(1)?;
    ensure!(storage.capacity() == 1, "NIR1_GRAPH_NATIVE_ARENA_CAPACITY");
    storage.push(NativeRegion::new());
    Ok(storage)
}

fn frame_length_allowed(len: usize) -> bool {
    (1..=FRAME_BYTES).contains(&len)
}

struct ChildSession {
    child: Child,
    stdin: Option<ChildStdin>,
    reader: Option<JoinHandle<()>>,
    exit: Option<ExitStatus>,
    eof: bool,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct QueryPhaseDiagnostics {
    frame_binding_validated_at: Option<Duration>,
    reader_eof_observed_at: Option<Duration>,
    first_try_wait_success_at: Option<Duration>,
    first_post_frame_try_wait_none_at: Option<Duration>,
    first_post_frame_try_wait_success_at: Option<Duration>,
    post_frame_try_wait_none_count: u32,
    post_frame_park_count: u32,
    reader_join_start_at: Option<Duration>,
    reader_join_end_at: Option<Duration>,
    final_binding_check_start_at: Option<Duration>,
    final_binding_check_end_at: Option<Duration>,
}

/// Holds one Native workspace snapshot. A result lease borrows this owner, so
/// its fixed storage and child admission cannot be reused before lease drop.
pub struct CQueryWorkerOwner {
    snapshot: Option<ActiveWorkspaceSnapshot>,
    worker: PathBuf,
    region: RegionControl,
    session: Option<ChildSession>,
    #[cfg(test)]
    inject_crash_after_request_for_test: bool,
    #[cfg(test)]
    hold_after_request_for_test: Option<PathBuf>,
    #[cfg(test)]
    suppress_eof_proof_for_test: bool,
    #[cfg(test)]
    test_cleanup_proved: bool,
    #[cfg(test)]
    test_abnormal_exit_observed: bool,
    #[cfg(test)]
    test_normal_exit_and_eof_observed: bool,
    #[cfg(test)]
    query_phase_diagnostics: QueryPhaseDiagnostics,
}

impl CQueryWorkerOwner {
    pub fn new(snapshot: ActiveWorkspaceSnapshot, worker: PathBuf) -> Self {
        Self {
            snapshot: Some(snapshot),
            worker,
            region: RegionControl {
                storage: None,
                claim: None,
                elapsed: None,
                result_len: 0,
                prepared_project_len: 0,
                preparation_attempted: false,
                prepared: false,
                started: false,
                lease_held: false,
                quarantined: false,
            },
            session: None,
            #[cfg(test)]
            inject_crash_after_request_for_test: false,
            #[cfg(test)]
            hold_after_request_for_test: None,
            #[cfg(test)]
            suppress_eof_proof_for_test: false,
            #[cfg(test)]
            test_cleanup_proved: false,
            #[cfg(test)]
            test_abnormal_exit_observed: false,
            #[cfg(test)]
            test_normal_exit_and_eof_observed: false,
            #[cfg(test)]
            query_phase_diagnostics: QueryPhaseDiagnostics::default(),
        }
    }

    /// Start and canonically register one isolated worker before request admission.
    /// The pinned Native participant and child claim remain held until cleanup.
    pub fn prepare(&mut self, project_id: &str) -> Result<()> {
        ensure!(
            !project_id.is_empty() && project_id.len() < REQUEST_BYTES,
            "NIR1_GRAPH_WORKER_PROJECT_ID"
        );
        ensure!(
            !self.region.preparation_attempted,
            "NIR1_GRAPH_WORKER_PREPARE_ONCE"
        );
        self.region.preparation_attempted = true;
        let snapshot = self
            .snapshot
            .as_ref()
            .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_OWNER_CLOSED"))?;
        snapshot.check_current_binding()?;
        let authority = std::sync::Arc::clone(&snapshot.authority);
        self.region.claim = Some(
            authority
                .claim_c_query_child()
                .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_BUSY"))?,
        );
        match self.prepare_claimed(&authority, project_id) {
            Ok(()) => {
                self.region.prepared = true;
                Ok(())
            }
            Err(error) => Err(self.cleanup_error(error)),
        }
    }

    /// Test-only crash injection against the real child after READY was observed.
    #[cfg(test)]
    pub(super) fn crash_child_after_ready_for_test(&mut self) -> Result<()> {
        let child = &mut self
            .session
            .as_mut()
            .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_SESSION"))?
            .child;
        child.kill()?;
        let status = child.wait()?;
        ensure!(!status.success(), "NIR1_GRAPH_TEST_CHILD_DID_NOT_CRASH");
        Ok(())
    }

    /// Crash the real child after request admission. This proves Native admission
    /// only; it does not prove child SQL began or that any frame bytes were emitted.
    #[cfg(test)]
    pub(super) fn crash_after_request_for_test(&mut self) {
        self.inject_crash_after_request_for_test = true;
    }

    #[cfg(test)]
    pub(super) fn hold_after_request_for_test(&mut self, path: PathBuf) {
        self.hold_after_request_for_test = Some(path);
    }

    #[cfg(test)]
    pub(super) fn suppress_eof_proof_for_test(&mut self) {
        self.suppress_eof_proof_for_test = true;
    }

    #[cfg(test)]
    pub(super) fn cleanup_proved_for_test(&self) -> bool {
        self.test_cleanup_proved
    }

    #[cfg(test)]
    pub(super) fn child_pid_for_test(&self) -> Result<u32> {
        self.session
            .as_ref()
            .map(|session| session.child.id())
            .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_SESSION"))
    }

    #[cfg(test)]
    pub(super) fn abnormal_exit_observed_for_test(&self) -> bool {
        self.test_abnormal_exit_observed
    }

    #[cfg(test)]
    pub(super) fn normal_exit_and_eof_observed_for_test(&self) -> bool {
        self.test_normal_exit_and_eof_observed
    }

    #[cfg(test)]
    pub(super) fn query_phase_diagnostics_for_test(&self) -> QueryPhaseDiagnostics {
        self.query_phase_diagnostics
    }

    #[cfg(test)]
    pub(super) fn quarantined_resources_held_for_test(&self) -> bool {
        self.region.quarantined
            && self.snapshot.is_some()
            && self.region.claim.is_some()
            && self.region.storage.is_some()
            && self.session.as_ref().is_some_and(|session| {
                !session.eof
                    && session.exit.is_some_and(|status| status.success())
                    && session.reader.is_some()
            })
    }

    /// Admit exactly one request after READY, validate its bounded frame in-place,
    /// and require both child exit and pipe EOF before returning a lease.
    pub fn query_once<'a>(
        &'a mut self,
        request: &Nir1GraphRequest,
    ) -> Result<CQueryResultLease<'a>> {
        ensure!(self.region.prepared, "NIR1_GRAPH_WORKER_NOT_READY");
        ensure!(!self.region.started, "NIR1_GRAPH_WORKER_ONE_QUERY_ONLY");
        let request_len = request_len(request)?;
        let admitted_at = Instant::now();
        #[cfg(test)]
        {
            self.query_phase_diagnostics = QueryPhaseDiagnostics::default();
        }
        self.region.started = true;
        let result = self
            .query_claimed(request, request_len, admitted_at)
            .and_then(|()| {
                #[cfg(test)]
                {
                    self.query_phase_diagnostics.final_binding_check_start_at =
                        Some(admitted_at.elapsed());
                }
                self.snapshot
                    .as_ref()
                    .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_OWNER_CLOSED"))?
                    .check_current_binding()?;
                #[cfg(test)]
                {
                    self.query_phase_diagnostics.final_binding_check_end_at =
                        Some(admitted_at.elapsed());
                }
                let elapsed = admitted_at.elapsed();
                if elapsed > QUERY_DEADLINE {
                    anyhow::bail!("{}", deadline_refusal_reason(self.region.elapsed));
                }
                self.region.elapsed = Some(elapsed);
                Ok(())
            });
        match result {
            Ok(()) => {
                self.region.lease_held = true;
                Ok(CQueryResultLease { owner: self })
            }
            Err(error) => Err(self.cleanup_error(error)),
        }
    }

    fn cleanup_error(&mut self, error: anyhow::Error) -> anyhow::Error {
        if self.session.is_some() {
            if let Err(cleanup) = self.stop_and_reap() {
                self.region.quarantined = true;
                return anyhow!("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED: {error}; {cleanup}");
            }
        }
        self.region.prepared = false;
        self.region.quarantined = false;
        if let Some(claim) = self.region.claim.take() {
            claim.release();
        }
        error
    }

    fn prepare_claimed(
        &mut self,
        authority: &std::sync::Arc<WorkspaceAuthority>,
        project_id: &str,
    ) -> Result<()> {
        let storage = reserve_storage()?;
        // SAFETY: the reader cannot access bytes until REQUEST is published.
        unsafe {
            storage[0].bytes_mut()[..project_id.len()].copy_from_slice(project_id.as_bytes());
        }
        self.region.prepared_project_len = project_id.len();
        self.region.storage = Some(storage);

        let mut child = Command::new(&self.worker)
            .arg(authority.path())
            .arg(project_id)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        if stdin.is_none() || stdout.is_none() {
            self.session = Some(ChildSession {
                child,
                stdin,
                reader: None,
                exit: None,
                eof: false,
            });
            anyhow::bail!("NIR1_GRAPH_WORKER_PIPE_MISSING");
        }
        let stdin = stdin.ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_STDIN"))?;
        let stdout = stdout.ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_STDOUT"))?;
        let region_address = self
            .region
            .storage
            .as_ref()
            .and_then(|storage| storage.first())
            .map(|region| NativeRegionPtr(region as *const NativeRegion))
            .ok_or_else(|| anyhow!("NIR1_GRAPH_NATIVE_ARENA"))?;
        let reader = match thread::Builder::new()
            .spawn(move || unsafe { region_address.read_pipe(stdout) })
        {
            Ok(reader) => reader,
            Err(error) => {
                // stdout was transferred to a thread that could not start; cleanup
                // will quarantine unless actual exit and pipe EOF can be proved.
                self.session = Some(ChildSession {
                    child,
                    stdin: Some(stdin),
                    reader: None,
                    exit: None,
                    eof: false,
                });
                return Err(error.into());
            }
        };
        let parent_thread = thread::current();
        self.session = Some(ChildSession {
            child,
            stdin: Some(stdin),
            reader: Some(reader),
            exit: None,
            eof: false,
        });
        let native = self
            .region
            .storage
            .as_ref()
            .and_then(|storage| storage.first())
            .ok_or_else(|| anyhow!("NIR1_GRAPH_NATIVE_ARENA"))?;
        native.set_parent_thread(parent_thread);
        self.session
            .as_ref()
            .and_then(|session| session.reader.as_ref())
            .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_READER"))?
            .thread()
            .unpark();
        self.wait_until_ready()
    }

    fn query_claimed(
        &mut self,
        request: &Nir1GraphRequest,
        request_len: usize,
        admitted_at: Instant,
    ) -> Result<()> {
        self.snapshot
            .as_ref()
            .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_OWNER_CLOSED"))?
            .check_current_binding()?;
        let project_len = self.region.prepared_project_len;
        {
            let native = self
                .region
                .storage
                .as_ref()
                .and_then(|storage| storage.first())
                .ok_or_else(|| anyhow!("NIR1_GRAPH_NATIVE_ARENA"))?;
            // SAFETY: the reader is waiting for OWNER_REQUEST and has not touched
            // the buffer; this owner exclusively prepares the request bytes.
            let bytes = unsafe { native.bytes_mut() };
            ensure!(
                project_len == request.project_id.len()
                    && &bytes[..project_len] == request.project_id.as_bytes(),
                "NIR1_GRAPH_WORKER_PROJECT_MISMATCH"
            );
            encode_request(request, &mut bytes[..REQUEST_BYTES])?;
        }
        let mut stdin = self
            .session
            .as_mut()
            .and_then(|session| session.stdin.take())
            .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_STDIN"))?;
        let write_result = {
            let native = self
                .region
                .storage
                .as_ref()
                .and_then(|storage| storage.first())
                .ok_or_else(|| anyhow!("NIR1_GRAPH_NATIVE_ARENA"))?;
            // SAFETY: the reader still waits for OWNER_REQUEST.
            let bytes = unsafe { native.bytes() };
            stdin.write_all(&bytes[..request_len])
        };
        drop(stdin);
        write_result?;
        let native = self
            .region
            .storage
            .as_ref()
            .and_then(|storage| storage.first())
            .ok_or_else(|| anyhow!("NIR1_GRAPH_NATIVE_ARENA"))?;
        native.request();
        self.session
            .as_ref()
            .and_then(|session| session.reader.as_ref())
            .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_READER"))?
            .thread()
            .unpark();

        #[cfg(test)]
        if self.inject_crash_after_request_for_test {
            ensure!(
                self.snapshot
                    .as_ref()
                    .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_OWNER_CLOSED"))?
                    .authority
                    .claim_c_query_child()
                    .is_none(),
                "NIR1_GRAPH_TEST_CLAIM_NOT_BUSY_AFTER_REQUEST"
            );
            self.session
                .as_mut()
                .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_SESSION"))?
                .child
                .kill()?;
            anyhow::bail!("NIR1_GRAPH_TEST_CHILD_CRASH_AFTER_REQUEST");
        }

        #[cfg(test)]
        if let Some(path) = self.hold_after_request_for_test.take() {
            let temporary_path = path.with_extension("tmp");
            std::fs::write(&temporary_path, b"admitted")?;
            std::fs::rename(temporary_path, path)?;
            loop {
                thread::park_timeout(Duration::from_secs(30));
            }
        }

        loop {
            self.snapshot
                .as_ref()
                .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_OWNER_CLOSED"))?
                .check_current_binding()?;
            #[cfg(test)]
            let try_wait_pending = self
                .session
                .as_ref()
                .is_some_and(|session| session.exit.is_none());
            self.poll_exit()?;
            #[cfg(test)]
            if try_wait_pending {
                let observed_at = admitted_at.elapsed();
                let exit_observed = self
                    .session
                    .as_ref()
                    .is_some_and(|session| session.exit.is_some());
                if exit_observed {
                    self.query_phase_diagnostics
                        .first_try_wait_success_at
                        .get_or_insert(observed_at);
                    if self.region.result_len > 0 {
                        self.query_phase_diagnostics
                            .first_post_frame_try_wait_success_at
                            .get_or_insert(observed_at);
                    }
                } else if self.region.result_len > 0 {
                    self.query_phase_diagnostics
                        .first_post_frame_try_wait_none_at
                        .get_or_insert(observed_at);
                    self.query_phase_diagnostics.post_frame_try_wait_none_count = self
                        .query_phase_diagnostics
                        .post_frame_try_wait_none_count
                        .saturating_add(1);
                }
            }
            if admitted_at.elapsed() >= QUERY_DEADLINE {
                anyhow::bail!("{}", deadline_refusal_reason(self.region.elapsed));
            }
            let native = self
                .region
                .storage
                .as_ref()
                .and_then(|storage| storage.first())
                .ok_or_else(|| anyhow!("NIR1_GRAPH_NATIVE_ARENA"))?;
            let events = native.mailbox.events.load(Ordering::Acquire);
            #[cfg(test)]
            if events & READER_EOF != 0
                && self
                    .query_phase_diagnostics
                    .reader_eof_observed_at
                    .is_none()
            {
                self.query_phase_diagnostics.reader_eof_observed_at = Some(admitted_at.elapsed());
            }
            if events & READER_TRAILING != 0 {
                anyhow::bail!("NIR1_GRAPH_WORKER_TRAILING_PIPE_DATA");
            }
            if events & READER_FAILED != 0 {
                anyhow::bail!("NIR1_GRAPH_WORKER_PIPE_TRUNCATED");
            }
            if events & READER_PIPE_ERROR != 0 {
                anyhow::bail!("NIR1_GRAPH_WORKER_PIPE_ERROR");
            }
            if events & READER_EOF != 0 {
                #[cfg(test)]
                if self.suppress_eof_proof_for_test {
                    if self
                        .session
                        .as_ref()
                        .is_some_and(|session| session.exit.is_some_and(|status| status.success()))
                    {
                        ensure!(
                            events & READER_FRAME != 0,
                            "NIR1_GRAPH_TEST_EOF_WITHOUT_COMPLETE_FRAME"
                        );
                        self.test_normal_exit_and_eof_observed = true;
                        anyhow::bail!("NIR1_GRAPH_TEST_EOF_PROOF_UNOBSERVED");
                    }
                } else {
                    self.session
                        .as_mut()
                        .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_SESSION"))?
                        .eof = true;
                }
                #[cfg(not(test))]
                {
                    self.session
                        .as_mut()
                        .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_SESSION"))?
                        .eof = true;
                }
            }
            if self.region.result_len == 0 && events & READER_FRAME != 0 {
                let len = native.mailbox.frame_len.load(Ordering::Relaxed);
                ensure!(len <= FRAME_BYTES, "NIR1_GRAPH_FRAME_LIMIT");
                let bytes = self.result_bytes(len)?;
                let view = worker_frame::validate(bytes)?;
                ensure!(
                    view.project == request.project_id,
                    "NIR1_GRAPH_WORKER_PROJECT_MISMATCH"
                );
                ensure!(
                    view.scene == request.query_scene_id,
                    "NIR1_GRAPH_WORKER_SCENE_MISMATCH"
                );
                if let Some(reason) = view.reason {
                    anyhow::bail!("NIR1_GRAPH_WORKER_UNAVAILABLE: {reason}");
                }
                ensure!(
                    view.scope.is_some()
                        && view.generation.is_some_and(|generation| generation > 0),
                    "NIR1_GRAPH_WORKER_FRAME_INVALID"
                );
                ensure!(
                    view.seed == Some(request.seed_entity_id.as_str()),
                    "NIR1_GRAPH_WORKER_SEED_MISMATCH"
                );
                self.snapshot
                    .as_ref()
                    .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_OWNER_CLOSED"))?
                    .check_current_binding()?;
                let frame_binding_validated_at = admitted_at.elapsed();
                self.region.elapsed = Some(frame_binding_validated_at);
                #[cfg(test)]
                {
                    self.query_phase_diagnostics.frame_binding_validated_at =
                        Some(frame_binding_validated_at);
                }
                self.region.result_len = len;
            }
            if self.region.result_len > 0
                && self
                    .session
                    .as_ref()
                    .is_some_and(|session| session.eof && session.exit.is_some())
            {
                #[cfg(test)]
                self.finish_session(admitted_at)?;
                #[cfg(not(test))]
                self.finish_session()?;
                return Ok(());
            }
            // result_len is set only after complete frame validation and the binding recheck.
            let exit_observed = self
                .session
                .as_ref()
                .is_some_and(|session| session.exit.is_some());
            let remaining = QUERY_DEADLINE.saturating_sub(admitted_at.elapsed());
            let Some(timeout) =
                query_poll_timeout(self.region.result_len > 0, exit_observed, remaining)
            else {
                anyhow::bail!("{}", deadline_refusal_reason(self.region.elapsed));
            };
            #[cfg(test)]
            if self.region.result_len > 0 {
                self.query_phase_diagnostics.post_frame_park_count = self
                    .query_phase_diagnostics
                    .post_frame_park_count
                    .saturating_add(1);
            }
            thread::park_timeout(timeout);
        }
    }

    fn wait_until_ready(&mut self) -> Result<()> {
        let deadline = Instant::now() + START_TIMEOUT;
        loop {
            self.snapshot
                .as_ref()
                .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_OWNER_CLOSED"))?
                .check_current_binding()?;
            self.poll_exit()?;
            if self
                .session
                .as_ref()
                .is_some_and(|session| session.exit.is_some())
            {
                anyhow::bail!("NIR1_GRAPH_WORKER_EXIT_BEFORE_READY");
            }
            if Instant::now() >= deadline {
                anyhow::bail!("NIR1_GRAPH_WORKER_START_TIMEOUT");
            }
            let native = self
                .region
                .storage
                .as_ref()
                .and_then(|storage| storage.first())
                .ok_or_else(|| anyhow!("NIR1_GRAPH_NATIVE_ARENA"))?;
            let events = native.mailbox.events.load(Ordering::Acquire);
            if events & READER_FAILED != 0 {
                anyhow::bail!("NIR1_GRAPH_WORKER_READY_PIPE_CLOSED");
            }
            if events & READER_EOF != 0 {
                self.session
                    .as_mut()
                    .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_SESSION"))?
                    .eof = true;
                anyhow::bail!("NIR1_GRAPH_WORKER_EXIT_BEFORE_READY");
            }
            if events & READER_TRAILING != 0 {
                anyhow::bail!("NIR1_GRAPH_WORKER_TRAILING_PIPE_DATA");
            }
            if events & READER_PIPE_ERROR != 0 {
                anyhow::bail!("NIR1_GRAPH_WORKER_PIPE_ERROR");
            }
            if events & READER_FRAME != 0 {
                anyhow::bail!("NIR1_GRAPH_WORKER_RESULT_BEFORE_REQUEST");
            }
            if events & READER_READY != 0 {
                return Ok(());
            }
            thread::park_timeout(POLL_INTERVAL);
        }
    }

    fn finish_session(&mut self, #[cfg(test)] admitted_at: Instant) -> Result<()> {
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_SESSION"))?;
        ensure!(session.eof, "NIR1_GRAPH_WORKER_EOF_UNPROVED");
        ensure!(
            session.exit.is_some_and(|status| status.success()),
            "NIR1_GRAPH_WORKER_EXIT_FAILURE"
        );
        let mut session = self
            .session
            .take()
            .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_SESSION"))?;
        if let Some(reader) = session.reader.take() {
            #[cfg(test)]
            {
                self.query_phase_diagnostics.reader_join_start_at = Some(admitted_at.elapsed());
            }
            let join_result = reader.join();
            #[cfg(test)]
            {
                self.query_phase_diagnostics.reader_join_end_at = Some(admitted_at.elapsed());
            }
            join_result.map_err(|_| anyhow!("NIR1_GRAPH_WORKER_READER_PANIC"))?;
        }
        Ok(())
    }

    fn poll_exit(&mut self) -> Result<()> {
        let session = self
            .session
            .as_mut()
            .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_SESSION"))?;
        if session.exit.is_none() {
            session.exit = session.child.try_wait()?;
        }
        Ok(())
    }

    fn result_bytes(&self, len: usize) -> Result<&[u8]> {
        let native = self
            .region
            .storage
            .as_ref()
            .and_then(|storage| storage.first())
            .ok_or_else(|| anyhow!("NIR1_GRAPH_NATIVE_ARENA"))?;
        ensure!(frame_length_allowed(len), "NIR1_GRAPH_FRAME_LIMIT");
        let end = REQUEST_BYTES
            .checked_add(len)
            .filter(|end| *end <= STORAGE_BYTES)
            .ok_or_else(|| anyhow!("NIR1_GRAPH_FRAME_LIMIT"))?;
        // SAFETY: READER_FRAME is acquire-observed before validation, and the
        // reader no longer mutates the frame buffer after publishing it.
        let bytes = unsafe { native.bytes() };
        Ok(&bytes[REQUEST_BYTES..end])
    }

    /// Kill then wait only for the bounded cleanup interval. The claim and
    /// snapshot are intentionally retained if exit or pipe EOF is unproved.
    fn stop_and_reap(&mut self) -> Result<()> {
        let Some(session) = self.session.as_mut() else {
            return Ok(());
        };
        if let Some(native) = self
            .region
            .storage
            .as_ref()
            .and_then(|storage| storage.first())
        {
            native.cancel();
        }
        if let Some(reader) = session.reader.as_ref() {
            reader.thread().unpark();
        }
        session.stdin.take();
        if session.exit.is_none() {
            let _ = session.child.kill();
        }
        let deadline = Instant::now() + CLEANUP_TIMEOUT;
        while Instant::now() < deadline {
            self.poll_exit()?;
            let events = self
                .region
                .storage
                .as_ref()
                .and_then(|storage| storage.first())
                .map(|native| native.mailbox.events.load(Ordering::Acquire))
                .unwrap_or_default();
            if events & READER_EOF != 0 {
                #[cfg(test)]
                if !self.suppress_eof_proof_for_test {
                    if let Some(session) = self.session.as_mut() {
                        session.eof = true;
                    }
                }
                #[cfg(not(test))]
                if let Some(session) = self.session.as_mut() {
                    session.eof = true;
                }
            }
            if self
                .session
                .as_ref()
                .is_some_and(|s| s.exit.is_some() && s.eof)
            {
                let mut session = self
                    .session
                    .take()
                    .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_SESSION"))?;
                if let Some(reader) = session.reader.take() {
                    reader
                        .join()
                        .map_err(|_| anyhow!("NIR1_GRAPH_WORKER_READER_PANIC"))?;
                }
                #[cfg(test)]
                {
                    // ExitStatus is populated only by Child::try_wait in poll_exit.
                    self.test_abnormal_exit_observed = session
                        .exit
                        .as_ref()
                        .is_some_and(|status| !status.success());
                    // This follows observed child exit + stdout EOF and a successful reader join.
                    self.test_cleanup_proved = true;
                }
                return Ok(());
            }
            thread::park_timeout(POLL_INTERVAL);
        }
        anyhow::bail!("NIR1_GRAPH_WORKER_BOUNDED_JOIN_UNPROVED")
    }
}

/// A borrowed, non-owning projection over the Native fixed result region.
/// Dropping it is the only successful-path action that releases child admission.
pub struct CQueryResultLease<'a> {
    owner: &'a mut CQueryWorkerOwner,
}

impl CQueryResultLease<'_> {
    pub fn frame(&self) -> Result<FrameView<'_>> {
        let len = self.owner.region.result_len;
        worker_frame::validate(self.owner.result_bytes(len)?)
    }

    pub fn elapsed(&self) -> Duration {
        self.owner.region.elapsed.unwrap_or_default()
    }

    #[cfg(test)]
    pub(super) fn query_phase_diagnostics_for_test(&self) -> QueryPhaseDiagnostics {
        self.owner.query_phase_diagnostics_for_test()
    }
}

impl Drop for CQueryResultLease<'_> {
    fn drop(&mut self) {
        self.owner.region.lease_held = false;
        self.owner.region.result_len = 0;
        self.owner.region.elapsed = None;
        if let Some(claim) = self.owner.region.claim.take() {
            claim.release();
        }
    }
}

impl Drop for CQueryWorkerOwner {
    fn drop(&mut self) {
        if self.session.is_some() && !self.region.quarantined {
            if self.stop_and_reap().is_err() {
                self.region.quarantined = true;
            }
        }
        if self.region.quarantined {
            if let Some(snapshot) = self.snapshot.take() {
                std::mem::forget(snapshot);
            }
            if let Some(claim) = self.region.claim.take() {
                std::mem::forget(claim);
            }
            if let Some(storage) = self.region.storage.take() {
                std::mem::forget(storage);
            }
            if let Some(session) = self.session.take() {
                std::mem::forget(session);
            }
        } else if let Some(claim) = self.region.claim.take() {
            claim.release();
        }
    }
}

fn query_poll_timeout(
    frame_validated: bool,
    child_exit_observed: bool,
    remaining: Duration,
) -> Option<Duration> {
    if remaining.is_zero() {
        return None;
    }
    let interval = if frame_validated && !child_exit_observed {
        FRAME_EXIT_POLL_INTERVAL
    } else {
        POLL_INTERVAL
    };
    Some(interval.min(remaining))
}

fn deadline_refusal_reason(frame_elapsed: Option<Duration>) -> &'static str {
    if frame_elapsed.is_some_and(|elapsed| elapsed <= QUERY_DEADLINE) {
        "NIR1_GRAPH_QUERY_DEADLINE_AFTER_TIMELY_FRAME_RETURN"
    } else {
        "NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME"
    }
}

fn request_len(request: &Nir1GraphRequest) -> Result<usize> {
    let mut len = 2usize;
    for text in [
        &request.project_id,
        &request.query_scene_id,
        &request.seed_entity_id,
    ] {
        ensure!(
            !text.is_empty() && text.len() <= u16::MAX as usize,
            "NIR1_GRAPH_WORKER_REQUEST_TEXT"
        );
        len = len
            .checked_add(2 + text.len())
            .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_REQUEST_OVERFLOW"))?;
    }
    ensure!(len <= REQUEST_BYTES, "NIR1_GRAPH_WORKER_REQUEST_LIMIT");
    Ok(len)
}

fn encode_request(request: &Nir1GraphRequest, storage: &mut [u8]) -> Result<()> {
    let len = request_len(request)?;
    ensure!(storage.len() >= len, "NIR1_GRAPH_WORKER_REQUEST_LIMIT");
    storage[..2].copy_from_slice(&u16::try_from(len - 2)?.to_le_bytes());
    let mut position = 2;
    for text in [
        &request.project_id,
        &request.query_scene_id,
        &request.seed_entity_id,
    ] {
        let text_len = u16::try_from(text.len())?;
        storage[position..position + 2].copy_from_slice(&text_len.to_le_bytes());
        position += 2;
        storage[position..position + text.len()].copy_from_slice(text.as_bytes());
        position += text.len();
    }
    Ok(())
}

/// The address points into the one-element Native reservation. The owner keeps
/// that allocation alive until this thread is joined; on unproved cleanup it
/// deliberately leaks the allocation before dropping the owner.
unsafe fn read_worker_pipe(mut stdout: ChildStdout, region_ptr: *const NativeRegion) {
    // SAFETY: guaranteed by the caller's stable-allocation/quarantine contract.
    let region = unsafe { &*region_ptr };
    if !region.wait_for_parent_thread() {
        drain_to_eof(&mut stdout, region);
        return;
    }

    let mut ready = [0u8; 1];
    if stdout.read_exact(&mut ready).is_err() || ready != [b'R'] {
        region.publish(READER_PIPE_ERROR);
        drain_to_eof(&mut stdout, region);
        return;
    }
    region.publish(READER_READY);
    if !region.wait_for_request() {
        drain_to_eof(&mut stdout, region);
        return;
    }

    let len = {
        // SAFETY: the owner has stopped touching bytes before publishing
        // OWNER_REQUEST; the reader exclusively owns the buffer until FRAME.
        let bytes = unsafe { region.bytes_mut() };
        if stdout.read_exact(&mut bytes[..4]).is_err() {
            region.publish(READER_FAILED);
            drain_to_eof(&mut stdout, region);
            return;
        }
        u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize
    };
    if !frame_length_allowed(len) {
        region.publish(READER_FAILED);
        drain_to_eof(&mut stdout, region);
        return;
    }
    let Some(end) = REQUEST_BYTES.checked_add(len) else {
        region.publish(READER_FAILED);
        drain_to_eof(&mut stdout, region);
        return;
    };
    {
        // SAFETY: still the reader-owned buffer phase; publishing FRAME below
        // transfers read-only access back to the Native owner.
        let bytes = unsafe { region.bytes_mut() };
        if stdout.read_exact(&mut bytes[REQUEST_BYTES..end]).is_err() {
            region.publish(READER_FAILED);
            drain_to_eof(&mut stdout, region);
            return;
        }
    }
    region.mailbox.frame_len.store(len, Ordering::Relaxed);
    region.publish(READER_FRAME);

    let mut trailing = [0u8; 1];
    match stdout.read(&mut trailing) {
        Ok(0) => region.publish(READER_EOF),
        Ok(_) => {
            region.publish(READER_TRAILING);
            drain_to_eof(&mut stdout, region);
        }
        Err(_) => region.publish(READER_PIPE_ERROR),
    }
}

fn drain_to_eof(stdout: &mut ChildStdout, region: &NativeRegion) {
    let mut byte = [0u8; 1];
    loop {
        match stdout.read(&mut byte) {
            Ok(0) => {
                region.publish(READER_EOF);
                return;
            }
            Ok(_) => {}
            Err(_) => {
                region.publish(READER_PIPE_ERROR);
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_polling_accelerates_only_unobserved_exit_after_frame_and_obeys_deadline() {
        let remaining = Duration::from_millis(10);
        assert_eq!(
            query_poll_timeout(false, false, remaining),
            Some(POLL_INTERVAL)
        );
        assert_eq!(
            query_poll_timeout(true, true, remaining),
            Some(POLL_INTERVAL)
        );
        assert_eq!(
            query_poll_timeout(true, false, remaining),
            Some(FRAME_EXIT_POLL_INTERVAL)
        );
        assert_eq!(
            query_poll_timeout(false, false, Duration::from_micros(25)),
            Some(Duration::from_micros(25))
        );
        assert_eq!(
            query_poll_timeout(true, false, Duration::from_micros(25)),
            Some(Duration::from_micros(25))
        );
        assert_eq!(query_poll_timeout(true, false, Duration::ZERO), None);
    }

    #[test]
    fn deadline_refusal_identifies_whether_frame_was_validated_in_time() {
        assert_eq!(
            deadline_refusal_reason(None),
            "NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME"
        );
        assert_eq!(
            deadline_refusal_reason(Some(QUERY_DEADLINE)),
            "NIR1_GRAPH_QUERY_DEADLINE_AFTER_TIMELY_FRAME_RETURN"
        );
        assert_eq!(
            deadline_refusal_reason(Some(QUERY_DEADLINE + Duration::from_nanos(1))),
            "NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME"
        );
    }

    #[test]
    fn native_region_reserves_metadata_and_bounds_request() -> Result<()> {
        let metadata =
            std::mem::size_of::<RegionControl>() + std::mem::size_of::<usize>() + MAILBOX_BYTES;
        assert_eq!(
            std::mem::size_of::<NativeRegion>(),
            MAILBOX_BYTES + STORAGE_BYTES
        );
        assert_eq!(
            std::mem::size_of::<NativeRegion>()
                + std::mem::size_of::<RegionControl>()
                + std::mem::size_of::<usize>(),
            PARENT_BYTES
        );
        assert_eq!(REQUEST_BYTES + FRAME_BYTES + metadata, PARENT_BYTES);
        assert!(REQUEST_BYTES + FRAME_BYTES + 1 + metadata > PARENT_BYTES);
        assert!(frame_length_allowed(FRAME_BYTES));
        assert!(!frame_length_allowed(FRAME_BYTES + 1));
        assert!(!frame_length_allowed(0));

        let request = Nir1GraphRequest {
            project_id: "p".repeat(REQUEST_BYTES - 10),
            query_scene_id: "s".into(),
            seed_entity_id: "e".into(),
        };
        assert_eq!(request_len(&request)?, REQUEST_BYTES);
        let storage = reserve_storage()?;
        assert_eq!(storage.len(), 1);
        assert_eq!(storage.capacity(), 1);
        let native = &storage[0];
        // This exact one-element allocation holds mailbox, request and frame.
        assert_eq!(
            std::mem::size_of_val(native)
                + std::mem::size_of::<RegionControl>()
                + std::mem::size_of::<usize>(),
            PARENT_BYTES
        );
        native.set_parent_thread(thread::current());
        native.mailbox.frame_len.store(17, Ordering::Relaxed);
        native.publish(READER_FRAME);
        native.publish(READER_EOF);
        let events = native.mailbox.events.load(Ordering::Acquire);
        assert_eq!(native.mailbox.frame_len.load(Ordering::Relaxed), 17);
        assert_ne!(events & READER_FRAME, 0);
        assert_ne!(events & READER_EOF, 0);
        // SAFETY: no reader thread is active in this test.
        let bytes = unsafe { native.bytes_mut() };
        encode_request(&request, &mut bytes[..REQUEST_BYTES])?;
        assert_eq!(
            u16::from_le_bytes([bytes[0], bytes[1]]) as usize + 2,
            REQUEST_BYTES
        );
        assert_eq!(bytes[REQUEST_BYTES..].len(), FRAME_BYTES);
        let over = Nir1GraphRequest {
            project_id: format!("{}p", request.project_id),
            ..request
        };
        let error = request_len(&over).expect_err("N+1 request must exceed its region");
        assert!(error
            .to_string()
            .contains("NIR1_GRAPH_WORKER_REQUEST_LIMIT"));
        Ok(())
    }
}
