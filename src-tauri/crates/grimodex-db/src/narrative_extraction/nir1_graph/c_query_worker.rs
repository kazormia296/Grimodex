//! Native-owned, direct-spawn one-query worker. Product Graph IPC remains closed.
use std::{
    cell::UnsafeCell,
    io::{Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[cfg(test)]
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::{anyhow, ensure, Result};

use crate::{
    state::{ActiveWorkspaceSnapshot, CQueryChildClaim, CQueryReadyWorkspace},
    workspace_lifecycle::{WorkspaceParticipant, WorkspaceQuarantineFence},
    WorkspaceAuthority,
};

use super::{
    worker_frame::{self, FrameView},
    Nir1GraphRequest, QUERY_DEADLINE,
};

const PARENT_BYTES: usize = 1_572_864;
pub const REQUEST_BYTES: usize = 8_192;
const REQUEST_CAPACITY_BYTES: usize = REQUEST_BYTES;
const START_TIMEOUT: Duration = Duration::from_secs(30);
const CLEANUP_TIMEOUT: Duration = Duration::from_millis(500);
const POLL_INTERVAL: Duration = Duration::from_millis(1);
#[cfg(any(not(target_os = "linux"), test))]
const REQUEST_WRITE_CHUNK_BYTES: usize = 1_024;
const FRAME_EXIT_POLL_INTERVAL: Duration = Duration::from_micros(100);
const STARTUP_STDERR_CAPTURE_BYTES: usize = 256;

// ponytail: one process-local owner; use a bounded permit count only if approved capacity grows.
static C_QUERY_CAPACITY_IN_USE: AtomicBool = AtomicBool::new(false);

struct CQueryCapacityPermit;

impl CQueryCapacityPermit {
    fn acquire() -> Result<Self> {
        C_QUERY_CAPACITY_IN_USE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| anyhow!("NIR1_GRAPH_WORKER_CAPACITY_BUSY"))
    }
}

impl Drop for CQueryCapacityPermit {
    fn drop(&mut self) {
        C_QUERY_CAPACITY_IN_USE.store(false, Ordering::Release);
    }
}

#[cfg(feature = "nir1-c-query-test-seam")]
const SQLITE_FAILURE_RECEIPT_LINE_BYTES: usize = 192;

#[cfg(feature = "nir1-c-query-test-seam")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SqliteAllocationFailureReceipt {
    kind: &'static str,
    requested: usize,
    old_capacity: usize,
    claimed: usize,
    available: usize,
}

#[cfg(feature = "nir1-c-query-test-seam")]
fn parse_sqlite_allocation_failure_receipt(line: &[u8]) -> Option<SqliteAllocationFailureReceipt> {
    if line.len() > SQLITE_FAILURE_RECEIPT_LINE_BYTES {
        return None;
    }
    let line = std::str::from_utf8(line.strip_suffix(b"\n")?).ok()?;
    let fields = line.strip_prefix("NIR1_C_QUERY_SQLITE_ALLOC_FAILURE:v1;kind=")?;
    let (kind, fields) = fields.split_once(";requested=")?;
    let kind = match kind {
        "xMalloc" => "xMalloc",
        "xRealloc" => "xRealloc",
        _ => return None,
    };
    let (requested, fields) = fields.split_once(";old=")?;
    let (old_capacity, fields) = fields.split_once(";claimed=")?;
    let (claimed, available) = fields.split_once(";available=")?;
    let parse_bytes = |value: &str| {
        (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| value.parse::<usize>().ok())
            .flatten()
    };
    let receipt = SqliteAllocationFailureReceipt {
        kind,
        requested: parse_bytes(requested)?,
        old_capacity: parse_bytes(old_capacity)?,
        claimed: parse_bytes(claimed)?,
        available: parse_bytes(available)?,
    };
    (receipt.requested > 0
        && receipt.available <= receipt.claimed
        && (receipt.kind != "xMalloc" || receipt.old_capacity == 0))
        .then_some(receipt)
}

fn startup_exit_error_from_bytes(bytes: &[u8]) -> anyhow::Error {
    let Some(stage_end) = bytes.iter().position(|byte| *byte == b'\n') else {
        return anyhow!("NIR1_GRAPH_WORKER_EXIT_BEFORE_READY");
    };
    let stage = match &bytes[..=stage_end] {
        b"NIR1_C_QUERY_STARTUP_BEFORE_ACTIVATION\n" => "NIR1_C_QUERY_STARTUP_BEFORE_ACTIVATION",
        b"NIR1_C_QUERY_STARTUP_ACTIVATION\n" => "NIR1_C_QUERY_STARTUP_ACTIVATION",
        b"NIR1_C_QUERY_STARTUP_READER_OPEN\n" => "NIR1_C_QUERY_STARTUP_READER_OPEN",
        b"NIR1_C_QUERY_STARTUP_CANONICAL_REGISTRATION\n" => {
            "NIR1_C_QUERY_STARTUP_CANONICAL_REGISTRATION"
        }
        b"NIR1_C_QUERY_STARTUP_CANONICAL_REGISTRATION_SQLITE_NOMEM\n" => {
            "NIR1_C_QUERY_STARTUP_CANONICAL_REGISTRATION_SQLITE_NOMEM"
        }
        b"NIR1_C_QUERY_REG_NOMEM:SETUP\n" => "NIR1_C_QUERY_REG_NOMEM:SETUP",
        b"NIR1_C_QUERY_REG_NOMEM:PRE_IDENTITY\n" => "NIR1_C_QUERY_REG_NOMEM:PRE_IDENTITY",
        b"NIR1_C_QUERY_REG_NOMEM:OWNER_SETUP\n" => "NIR1_C_QUERY_REG_NOMEM:OWNER_SETUP",
        b"NIR1_C_QUERY_REG_NOMEM:BEGIN\n" => "NIR1_C_QUERY_REG_NOMEM:BEGIN",
        b"NIR1_C_QUERY_REG_NOMEM:PINNED_IDENTITY\n" => "NIR1_C_QUERY_REG_NOMEM:PINNED_IDENTITY",
        b"NIR1_C_QUERY_REG_NOMEM:SEMANTIC_INDEX\n" => "NIR1_C_QUERY_REG_NOMEM:SEMANTIC_INDEX",
        b"NIR1_C_QUERY_REG_NOMEM:SOURCE_INDEX\n" => "NIR1_C_QUERY_REG_NOMEM:SOURCE_INDEX",
        b"NIR1_C_QUERY_REG_NOMEM:SEAL\n" => "NIR1_C_QUERY_REG_NOMEM:SEAL",
        b"NIR1_C_QUERY_REG_NOMEM:POST_IDENTITY\n" => "NIR1_C_QUERY_REG_NOMEM:POST_IDENTITY",
        b"NIR1_C_QUERY_STARTUP_CANONICAL_REGISTRATION_SQLITE_ERROR\n" => {
            "NIR1_C_QUERY_STARTUP_CANONICAL_REGISTRATION_SQLITE_ERROR"
        }
        b"NIR1_C_QUERY_STARTUP_CANONICAL_REGISTRATION_REFUSED\n" => {
            "NIR1_C_QUERY_STARTUP_CANONICAL_REGISTRATION_REFUSED"
        }
        _ => return anyhow!("NIR1_GRAPH_WORKER_EXIT_BEFORE_READY"),
    };
    #[cfg(feature = "nir1-c-query-test-seam")]
    if stage == "NIR1_C_QUERY_STARTUP_CANONICAL_REGISTRATION_SQLITE_NOMEM"
        || stage.starts_with("NIR1_C_QUERY_REG_NOMEM:")
    {
        let rest = &bytes[stage_end + 1..];
        if let Some(receipt_end) = rest.iter().position(|byte| *byte == b'\n') {
            if let Some(receipt) = parse_sqlite_allocation_failure_receipt(&rest[..=receipt_end]) {
                return anyhow!(
                    "NIR1_GRAPH_WORKER_EXIT_BEFORE_READY: {stage}; NIR1_C_QUERY_SQLITE_ALLOC_FAILURE:v1;kind={};requested={};old={};claimed={};available={}",
                    receipt.kind,
                    receipt.requested,
                    receipt.old_capacity,
                    receipt.claimed,
                    receipt.available,
                );
            }
        }
    }
    anyhow!("NIR1_GRAPH_WORKER_EXIT_BEFORE_READY: {stage}")
}

/// Per-query owner state; fixed request/result buffers do not cap other process memory.
struct RegionControl {
    storage: Option<NativeRegionReservation>,
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

impl RegionControl {
    fn native_region(&self) -> Option<&NativeRegion> {
        self.storage.as_ref().map(NativeRegionReservation::region)
    }
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
const READER_COMMIT: usize = 1 << 9;
const READER_FRAME_LIMIT: usize = 1 << 10;

/// Inline one-shot state and wake handles; no channel queue or backing allocation.
struct ReaderMailbox {
    events: AtomicUsize,
    frame_len: AtomicUsize,
    parent_thread: UnsafeCell<Option<thread::Thread>>,
}

const MAILBOX_BYTES: usize = std::mem::size_of::<ReaderMailbox>();
pub const FRAME_BYTES: usize = PARENT_BYTES
    - REQUEST_BYTES
    - REQUEST_CAPACITY_BYTES
    - std::mem::size_of::<Nir1GraphRequest>()
    - std::mem::size_of::<RegionControl>()
    - std::mem::size_of::<Option<ChildSession>>()
    - std::mem::size_of::<usize>() // borrowed lease handle
    - MAILBOX_BYTES;
// The request occupies this frame backing only before OWNER_REQUEST is published.
const STORAGE_BYTES: usize = FRAME_BYTES;

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
// immutable until the reader is joined or the slot is quarantined.
unsafe impl Sync for NativeRegion {}

static NATIVE_REGION_SLOT: NativeRegion = NativeRegion::new();

#[cfg(test)]
#[derive(Clone, Copy, Default)]
struct ReaderPublicationStamps {
    commit: Option<Duration>,
    eof: Option<Duration>,
}

#[cfg(test)]
#[derive(Default)]
struct ReaderPublicationState {
    admitted_at: Option<Instant>,
    stamps: ReaderPublicationStamps,
}

/// Reader-shared test timing stays in this Arc sidecar, outside the fixed NativeRegion.
#[derive(Clone, Default)]
struct ReaderPublicationTiming {
    #[cfg(test)]
    state: Arc<Mutex<ReaderPublicationState>>,
}

impl ReaderPublicationTiming {
    #[cfg(test)]
    fn lock(&self) -> MutexGuard<'_, ReaderPublicationState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[cfg(test)]
    fn begin_query(&self, admitted_at: Instant) {
        *self.lock() = ReaderPublicationState {
            admitted_at: Some(admitted_at),
            stamps: ReaderPublicationStamps::default(),
        };
    }

    fn publish(&self, region: &NativeRegion, event: usize) {
        #[cfg(test)]
        {
            let mut state = self.lock();
            let published_at = state.admitted_at.as_ref().map(Instant::elapsed);
            region.publish(event);
            match event {
                READER_COMMIT => state.stamps.commit = published_at,
                READER_EOF => state.stamps.eof = published_at,
                _ => {}
            }
        }
        #[cfg(not(test))]
        region.publish(event);
    }

    #[cfg(test)]
    fn stamps(&self) -> ReaderPublicationStamps {
        self.lock().stamps
    }
}

struct NativeRegionPtr {
    region: *const NativeRegion,
    reader_timing: ReaderPublicationTiming,
}

// SAFETY: the pointed-to allocation is stable and is retained until reader
// join, or leaked by quarantine if cleanup cannot prove termination. Test-only
// timing state is independently synchronized and Arc-owned.
unsafe impl Send for NativeRegionPtr {}

impl NativeRegionPtr {
    unsafe fn read_pipe(self, stdout: ChildStdout) {
        // SAFETY: preserved from the owner's stable-reservation contract.
        unsafe { read_worker_pipe(stdout, self.region, &self.reader_timing) };
    }

    #[cfg(test)]
    unsafe fn read_test_pipe(self, stdout: impl Read) {
        // SAFETY: the test retains the NativeRegion until this reader is joined.
        unsafe { read_worker_pipe(stdout, self.region, &self.reader_timing) };
    }
}

const _: () = assert!(FRAME_BYTES >= REQUEST_BYTES);

struct NativeRegionReservation {
    region: &'static NativeRegion,
    _capacity_permit: CQueryCapacityPermit,
}

impl NativeRegionReservation {
    fn region(&self) -> &NativeRegion {
        self.region
    }
}

impl Drop for NativeRegionReservation {
    fn drop(&mut self) {
        // The reservation is dropped only before a reader starts or after exit,
        // EOF and reader join; quarantine forgets this token instead.
        unsafe { drop((&mut *self.region.mailbox.parent_thread.get()).take()) };
    }
}

impl NativeRegion {
    const fn new() -> Self {
        Self {
            mailbox: ReaderMailbox {
                events: AtomicUsize::new(0),
                frame_len: AtomicUsize::new(0),
                parent_thread: UnsafeCell::new(None),
            },
            bytes: UnsafeCell::new([0; STORAGE_BYTES]),
        }
    }

    /// Initialize a test-local heap reservation in place, without a backing-sized stack temporary.
    ///
    /// # Safety
    /// `pointer` must reference aligned, writable storage for an uninitialized `NativeRegion`.
    #[cfg(test)]
    unsafe fn initialize_at(pointer: *mut Self) {
        unsafe {
            std::ptr::addr_of_mut!((*pointer).mailbox).write(ReaderMailbox {
                events: AtomicUsize::new(0),
                frame_len: AtomicUsize::new(0),
                parent_thread: UnsafeCell::new(None),
            });
            // Zero is valid for every byte in the UnsafeCell array backing.
            std::ptr::addr_of_mut!((*pointer).bytes)
                .cast::<u8>()
                .write_bytes(0, STORAGE_BYTES);
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

    fn bytes_mut_ptr(&self) -> *mut [u8; STORAGE_BYTES] {
        self.bytes.get()
    }

    unsafe fn bytes(&self) -> &[u8] {
        // SAFETY: callers must hold the exclusive buffer phase described above.
        unsafe { std::slice::from_raw_parts(self.bytes.get().cast::<u8>(), STORAGE_BYTES) }
    }
}

fn reserve_storage() -> Result<NativeRegionReservation> {
    let capacity_permit = CQueryCapacityPermit::acquire()?;
    // SAFETY: acquiring the process permit proves that any prior slot owner
    // retired and dropped its reader handle, or permanently leaked this permit.
    unsafe {
        let region = &NATIVE_REGION_SLOT;
        drop((&mut *region.mailbox.parent_thread.get()).take());
        region.mailbox.events.store(0, Ordering::Relaxed);
        region.mailbox.frame_len.store(0, Ordering::Relaxed);
        region
            .bytes
            .get()
            .cast::<u8>()
            .write_bytes(0, STORAGE_BYTES);
    }
    Ok(NativeRegionReservation {
        region: &NATIVE_REGION_SLOT,
        _capacity_permit: capacity_permit,
    })
}

#[cfg(test)]
fn reserve_test_storage() -> Result<Vec<NativeRegion>> {
    let mut storage = Vec::new();
    storage.try_reserve_exact(1)?;
    ensure!(storage.capacity() == 1, "NIR1_GRAPH_NATIVE_ARENA_CAPACITY");
    // SAFETY: the reserved Vec slot is aligned writable storage; initialize the
    // complete region before making it part of the Vec's initialized length.
    unsafe {
        NativeRegion::initialize_at(storage.as_mut_ptr());
        storage.set_len(1);
    }
    Ok(storage)
}

fn frame_length_allowed(len: usize) -> bool {
    (1..=FRAME_BYTES).contains(&len)
}

fn result_wire_complete(events: usize) -> bool {
    events & (READER_FRAME | READER_COMMIT | READER_EOF)
        == (READER_FRAME | READER_COMMIT | READER_EOF)
        && events & (READER_FAILED | READER_TRAILING | READER_PIPE_ERROR) == 0
}

struct ChildSession {
    child: Child,
    stdin: Option<ChildStdin>,
    reader: Option<JoinHandle<()>>,
    exit: Option<ExitStatus>,
    eof: bool,
}

#[cfg(any(not(target_os = "linux"), test))]
struct RequestWriteCompletion {
    stdin: ChildStdin,
    written: usize,
    result: std::io::Result<()>,
}

/// Lifecycle barrier retained with an unproved child until process exit.
enum DetachedCQueryLifecycle {
    Quarantine { _fence: WorkspaceQuarantineFence },
    Participant { _participant: WorkspaceParticipant },
}

enum CQueryWorkspacePin {
    Preparing(ActiveWorkspaceSnapshot),
    Ready(CQueryReadyWorkspace),
}

impl CQueryWorkspacePin {
    fn preparing_snapshot(&self) -> Option<&ActiveWorkspaceSnapshot> {
        match self {
            Self::Preparing(snapshot) => Some(snapshot),
            Self::Ready(_) => None,
        }
    }

    fn check_current_binding(&self) -> Result<()> {
        match self {
            Self::Preparing(snapshot) => snapshot.check_current_binding(),
            Self::Ready(workspace) => workspace.check_current_binding(),
        }
    }

    fn detach_c_query_quarantine(&self) -> Option<WorkspaceQuarantineFence> {
        match self {
            Self::Preparing(snapshot) => snapshot.detach_c_query_quarantine(),
            Self::Ready(workspace) => workspace.detach_c_query_quarantine(),
        }
    }

    fn into_ready(self) -> std::result::Result<Self, Self> {
        match self {
            Self::Preparing(snapshot) => snapshot
                .into_c_query_ready_owner()
                .map(Self::Ready)
                .map_err(Self::Preparing),
            ready @ Self::Ready(_) => Err(ready),
        }
    }

    fn into_fallback_participant(self) -> std::result::Result<WorkspaceParticipant, Self> {
        match self {
            Self::Preparing(snapshot) => snapshot
                .into_c_query_fallback_participant()
                .map_err(Self::Preparing),
            Self::Ready(workspace) => workspace
                .into_c_query_fallback_participant()
                .map_err(Self::Ready),
        }
    }
}

/// Process-lifetime owner for a C-query whose termination could not be proved.
/// It intentionally has no WorkspaceAuthority/Database/index reference.
struct DetachedCQueryOwner {
    _lifecycle: DetachedCQueryLifecycle,
    _claim: Option<CQueryChildClaim>,
    _storage: Option<NativeRegionReservation>,
    _session: Option<ChildSession>,
    #[cfg(any(not(target_os = "linux"), test))]
    _request_writer: Option<JoinHandle<RequestWriteCompletion>>,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct QueryPhaseDiagnostics {
    frame_binding_validated_at: Option<Duration>,
    request_bytes_written: usize,
    request_write_stalled: bool,
    reader_commit_published_at: Option<Duration>,
    reader_eof_published_at: Option<Duration>,
    parent_commit_observed_at: Option<Duration>,
    parent_eof_observed_at: Option<Duration>,
    pre_cleanup_deadline_decision_at: Option<Duration>,
    cleanup_elapsed: Option<Duration>,
    first_try_wait_success_at: Option<Duration>,
    first_post_frame_try_wait_none_at: Option<Duration>,
    first_post_frame_try_wait_success_at: Option<Duration>,
    post_frame_try_wait_none_count: u32,
    post_frame_park_count: u32,
    final_binding_check_start_at: Option<Duration>,
    final_binding_check_end_at: Option<Duration>,
}

#[cfg(test)]
impl QueryPhaseDiagnostics {
    fn observe_events(&mut self, events: usize, observed_at: Duration) {
        if events & READER_COMMIT != 0 {
            self.parent_commit_observed_at.get_or_insert(observed_at);
        }
        if events & READER_EOF != 0 {
            self.parent_eof_observed_at.get_or_insert(observed_at);
        }
    }

    fn observe_publications(&mut self, stamps: ReaderPublicationStamps) {
        self.reader_commit_published_at = stamps.commit;
        self.reader_eof_published_at = stamps.eof;
    }
}

#[cfg(test)]
enum RequestHoldForTest {
    UntilKilled(PathBuf),
    SingleWake {
        path: PathBuf,
        coordinator_release: Arc<AtomicBool>,
    },
}

#[cfg(test)]
#[derive(Clone)]
struct RequestWriterHoldForTest {
    after_bytes: usize,
    entered: Arc<AtomicBool>,
    release: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
}

/// Pins the broad workspace snapshot through worker READY, then keeps only the
/// exact binding/participant with the child claim and Native region. A result
/// lease borrows this owner; unproved retirement transfers its child resources.
pub struct CQueryWorkerOwner {
    workspace: Option<CQueryWorkspacePin>,
    worker: Option<PathBuf>,
    region: RegionControl,
    session: Option<ChildSession>,
    #[cfg(any(not(target_os = "linux"), test))]
    request_writer: Option<JoinHandle<RequestWriteCompletion>>,
    #[cfg(all(test, target_os = "linux"))]
    threaded_request_writer_for_test: bool,
    #[cfg(test)]
    request_write_progress_for_test: Option<Arc<AtomicUsize>>,
    #[cfg(test)]
    request_write_stall_threshold_for_test: usize,
    #[cfg(test)]
    request_writer_hold_for_test: Option<RequestWriterHoldForTest>,
    #[cfg(test)]
    test_live_writer_at_cleanup_timeout: bool,
    #[cfg(test)]
    test_request_writer_joined: bool,
    #[cfg(test)]
    inject_crash_after_request_for_test: bool,
    #[cfg(test)]
    hold_after_request_for_test: Option<RequestHoldForTest>,
    #[cfg(test)]
    child_frame_barrier_for_test: Option<PathBuf>,
    #[cfg(all(test, target_os = "linux"))]
    child_request_barrier_for_test: Option<PathBuf>,
    #[cfg(all(test, target_os = "linux"))]
    request_write_blocked_signal_for_test: Option<std::sync::Arc<AtomicBool>>,
    #[cfg(all(test, target_os = "linux"))]
    wait_for_child_exit_after_full_request_write_for_test: bool,
    #[cfg(all(test, target_os = "linux"))]
    test_child_exit_observed_before_request_handoff: bool,
    #[cfg(test)]
    suppress_eof_proof_for_test: bool,
    #[cfg(all(test, target_os = "linux"))]
    suppress_exit_proof_for_test: bool,
    #[cfg(all(test, target_os = "linux"))]
    panic_reader_after_pipe_for_test: bool,
    #[cfg(all(test, target_os = "linux"))]
    reader_completion_hold_for_test: Option<(Arc<AtomicBool>, Arc<AtomicBool>, Arc<AtomicBool>)>,
    #[cfg(test)]
    partial_terminal_commit_for_test: bool,
    #[cfg(test)]
    partial_frame_for_test: bool,
    #[cfg(test)]
    test_partial_frame_rejected_without_frame: bool,
    #[cfg(test)]
    test_partial_frame_claim_held_before_cleanup: bool,
    #[cfg(test)]
    trailing_data_for_test: bool,
    #[cfg(all(test, target_os = "linux"))]
    hold_after_commit_for_test: bool,
    #[cfg(all(test, target_os = "linux"))]
    hold_stdout_open_after_commit_for_test: bool,
    #[cfg(test)]
    rust_oom_for_test: bool,
    #[cfg(test)]
    sqlite_nomem_for_test: bool,
    #[cfg(test)]
    sql_steps_over_cap_for_test: bool,
    #[cfg(test)]
    oversized_frame_for_test: bool,
    #[cfg(all(test, unix))]
    test_abnormal_exit_signal: Option<i32>,
    #[cfg(test)]
    test_available_request_bound_q2_frame_observed: bool,
    #[cfg(test)]
    test_committed_request_bound_q2_frame_with_trailing_observed: bool,
    #[cfg(test)]
    test_oversized_frame_refusal_state: (usize, usize, usize),
    #[cfg(all(test, target_os = "linux"))]
    test_frame_commit_observed_within_deadline: bool,
    #[cfg(all(test, target_os = "linux"))]
    test_missing_eof_boundary_observed_before_cleanup: bool,
    #[cfg(test)]
    test_cleanup_proved: bool,
    #[cfg(test)]
    test_quarantine_detached: bool,
    #[cfg(all(test, target_os = "linux"))]
    test_exit_proof_suppressed: bool,
    #[cfg(all(test, target_os = "linux"))]
    test_reader_join_failed: bool,
    #[cfg(all(test, target_os = "linux"))]
    test_reader_join_unfinished_at_cleanup_timeout: bool,
    #[cfg(test)]
    test_abnormal_exit_observed: bool,
    #[cfg(test)]
    test_abnormal_exit_code: Option<i32>,
    #[cfg(test)]
    test_normal_exit_and_eof_observed: bool,
    #[cfg(test)]
    test_successful_request_bound_q2_frame_before_eof_suppression: bool,
    #[cfg(test)]
    query_phase_diagnostics: QueryPhaseDiagnostics,
    #[cfg(test)]
    reader_timing_for_test: ReaderPublicationTiming,
}

impl CQueryWorkerOwner {
    pub fn new(snapshot: ActiveWorkspaceSnapshot, worker: PathBuf) -> Self {
        Self {
            workspace: Some(CQueryWorkspacePin::Preparing(snapshot)),
            worker: Some(worker),
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
            #[cfg(any(not(target_os = "linux"), test))]
            request_writer: None,
            #[cfg(all(test, target_os = "linux"))]
            threaded_request_writer_for_test: false,
            #[cfg(test)]
            request_write_progress_for_test: None,
            #[cfg(test)]
            request_write_stall_threshold_for_test: 0,
            #[cfg(test)]
            request_writer_hold_for_test: None,
            #[cfg(test)]
            test_live_writer_at_cleanup_timeout: false,
            #[cfg(test)]
            test_request_writer_joined: false,
            #[cfg(test)]
            inject_crash_after_request_for_test: false,
            #[cfg(test)]
            hold_after_request_for_test: None,
            #[cfg(test)]
            child_frame_barrier_for_test: None,
            #[cfg(all(test, target_os = "linux"))]
            child_request_barrier_for_test: None,
            #[cfg(all(test, target_os = "linux"))]
            request_write_blocked_signal_for_test: None,
            #[cfg(all(test, target_os = "linux"))]
            wait_for_child_exit_after_full_request_write_for_test: false,
            #[cfg(all(test, target_os = "linux"))]
            test_child_exit_observed_before_request_handoff: false,
            #[cfg(test)]
            suppress_eof_proof_for_test: false,
            #[cfg(all(test, target_os = "linux"))]
            suppress_exit_proof_for_test: false,
            #[cfg(all(test, target_os = "linux"))]
            panic_reader_after_pipe_for_test: false,
            #[cfg(all(test, target_os = "linux"))]
            reader_completion_hold_for_test: None,
            #[cfg(test)]
            partial_terminal_commit_for_test: false,
            #[cfg(test)]
            partial_frame_for_test: false,
            #[cfg(test)]
            test_partial_frame_rejected_without_frame: false,
            #[cfg(test)]
            test_partial_frame_claim_held_before_cleanup: false,
            #[cfg(test)]
            trailing_data_for_test: false,
            #[cfg(all(test, target_os = "linux"))]
            hold_after_commit_for_test: false,
            #[cfg(all(test, target_os = "linux"))]
            hold_stdout_open_after_commit_for_test: false,
            #[cfg(test)]
            rust_oom_for_test: false,
            #[cfg(test)]
            sqlite_nomem_for_test: false,
            #[cfg(test)]
            sql_steps_over_cap_for_test: false,
            #[cfg(test)]
            oversized_frame_for_test: false,
            #[cfg(all(test, unix))]
            test_abnormal_exit_signal: None,
            #[cfg(test)]
            test_available_request_bound_q2_frame_observed: false,
            #[cfg(test)]
            test_committed_request_bound_q2_frame_with_trailing_observed: false,
            #[cfg(test)]
            test_oversized_frame_refusal_state: (0, 0, 0),
            #[cfg(all(test, target_os = "linux"))]
            test_frame_commit_observed_within_deadline: false,
            #[cfg(all(test, target_os = "linux"))]
            test_missing_eof_boundary_observed_before_cleanup: false,
            #[cfg(test)]
            test_cleanup_proved: false,
            #[cfg(test)]
            test_quarantine_detached: false,
            #[cfg(all(test, target_os = "linux"))]
            test_exit_proof_suppressed: false,
            #[cfg(all(test, target_os = "linux"))]
            test_reader_join_failed: false,
            #[cfg(all(test, target_os = "linux"))]
            test_reader_join_unfinished_at_cleanup_timeout: false,
            #[cfg(test)]
            test_abnormal_exit_observed: false,
            #[cfg(test)]
            test_abnormal_exit_code: None,
            #[cfg(test)]
            test_normal_exit_and_eof_observed: false,
            #[cfg(test)]
            test_successful_request_bound_q2_frame_before_eof_suppression: false,
            #[cfg(test)]
            query_phase_diagnostics: QueryPhaseDiagnostics::default(),
            #[cfg(test)]
            reader_timing_for_test: ReaderPublicationTiming::default(),
        }
    }

    fn request_writer_present(&self) -> bool {
        #[cfg(any(not(target_os = "linux"), test))]
        {
            self.request_writer.is_some()
        }
        #[cfg(all(target_os = "linux", not(test)))]
        {
            false
        }
    }

    fn check_current_binding(&self) -> Result<()> {
        self.workspace
            .as_ref()
            .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_OWNER_CLOSED"))?
            .check_current_binding()
    }

    fn release_authority_after_ready(&mut self) -> Result<()> {
        let native = self
            .region
            .native_region()
            .ok_or_else(|| anyhow!("NIR1_GRAPH_NATIVE_ARENA"))?;
        ensure!(
            native.mailbox.events.load(Ordering::Acquire) & READER_READY != 0,
            "NIR1_GRAPH_WORKER_READY_NOT_PUBLISHED"
        );
        let workspace = self
            .workspace
            .take()
            .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_OWNER_CLOSED"))?;
        match workspace.into_ready() {
            Ok(workspace) => {
                self.workspace = Some(workspace);
                Ok(())
            }
            Err(workspace) => {
                self.workspace = Some(workspace);
                anyhow::bail!("NIR1_GRAPH_WORKER_READY_OWNER")
            }
        }
    }

    /// Start and canonically register one isolated worker before request admission.
    /// Keep the broad snapshot through READY, then retain its exact binding and
    /// participant with the child claim and Native reservation until cleanup.
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
            .workspace
            .as_ref()
            .and_then(CQueryWorkspacePin::preparing_snapshot)
            .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_OWNER_CLOSED"))?;
        snapshot.check_current_binding()?;
        let authority = std::sync::Arc::clone(&snapshot.authority);
        self.region.claim = Some(
            authority
                .claim_c_query_child()
                .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_BUSY"))?,
        );
        let startup = self.prepare_claimed(&authority, project_id);
        drop(authority);
        match startup {
            Ok(()) => match self.release_authority_after_ready() {
                Ok(()) => {
                    self.region.prepared = true;
                    Ok(())
                }
                Err(error) => Err(self.cleanup_error(error)),
            },
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

    /// Kill the real child after it acknowledges the completed Q2 query and parks before frame output.
    #[cfg(test)]
    pub(super) fn crash_after_request_for_test(&mut self, marker: PathBuf) {
        self.inject_crash_after_request_for_test = true;
        self.child_frame_barrier_for_test = Some(marker);
    }

    #[cfg(test)]
    pub(super) fn hold_after_request_for_test(&mut self, path: PathBuf) {
        self.hold_after_request_for_test = Some(RequestHoldForTest::UntilKilled(path));
    }

    #[cfg(test)]
    pub(super) fn hold_child_before_frame_for_test(&mut self, marker: PathBuf) {
        self.child_frame_barrier_for_test = Some(marker);
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn hold_child_before_request_for_test(&mut self, marker: PathBuf) {
        self.child_request_barrier_for_test = Some(marker);
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn shrink_stdin_pipe_for_test(&self, capacity: libc::c_int) -> Result<usize> {
        use std::os::fd::AsRawFd;

        let stdin = self
            .session
            .as_ref()
            .and_then(|session| session.stdin.as_ref())
            .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_STDIN"))?;
        let fd = stdin.as_raw_fd();
        // SAFETY: fd is the live write end of this child's stdin pipe.
        let resized = unsafe { libc::fcntl(fd, libc::F_SETPIPE_SZ, capacity) };
        ensure!(
            resized >= 0,
            "NIR1_GRAPH_TEST_PIPE_RESIZE: {}",
            std::io::Error::last_os_error()
        );
        // SAFETY: F_GETPIPE_SZ only queries the same live pipe descriptor.
        let actual = unsafe { libc::fcntl(fd, libc::F_GETPIPE_SZ) };
        ensure!(
            actual >= 0,
            "NIR1_GRAPH_TEST_PIPE_SIZE: {}",
            std::io::Error::last_os_error()
        );
        Ok(actual as usize)
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn observe_request_write_blocked_for_test(
        &mut self,
        pipe_capacity: usize,
    ) -> std::sync::Arc<AtomicBool> {
        let blocked = std::sync::Arc::new(AtomicBool::new(false));
        self.request_write_blocked_signal_for_test = Some(std::sync::Arc::clone(&blocked));
        self.request_write_progress_for_test = Some(Arc::new(AtomicUsize::new(0)));
        self.request_write_stall_threshold_for_test = pipe_capacity;
        blocked
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn use_threaded_request_writer_for_test(&mut self) {
        self.threaded_request_writer_for_test = true;
    }

    #[cfg(test)]
    pub(super) fn hold_request_writer_after_bytes_for_test(
        &mut self,
        after_bytes: usize,
    ) -> (Arc<AtomicBool>, Arc<AtomicBool>, Arc<AtomicBool>) {
        let hold = RequestWriterHoldForTest {
            after_bytes,
            entered: Arc::new(AtomicBool::new(false)),
            release: Arc::new(AtomicBool::new(false)),
            finished: Arc::new(AtomicBool::new(false)),
        };
        self.request_write_progress_for_test = Some(Arc::new(AtomicUsize::new(0)));
        self.request_write_stall_threshold_for_test = after_bytes;
        self.request_writer_hold_for_test = Some(hold.clone());
        (hold.entered, hold.release, hold.finished)
    }

    #[cfg(test)]
    pub(super) fn request_write_diagnostics_for_test(&self) -> (usize, bool) {
        let written = self.request_write_progress_for_test.as_ref().map_or(
            self.query_phase_diagnostics.request_bytes_written,
            |progress| progress.load(Ordering::Acquire),
        );
        (written, self.query_phase_diagnostics.request_write_stalled)
    }

    #[cfg(test)]
    pub(super) fn request_writer_joined_for_test(&self) -> bool {
        self.test_request_writer_joined
    }

    #[cfg(test)]
    pub(super) fn live_writer_at_cleanup_timeout_for_test(&self) -> bool {
        self.test_live_writer_at_cleanup_timeout && !self.test_request_writer_joined
    }

    #[cfg(test)]
    pub(super) fn request_handoff_published_for_test(&self) -> bool {
        self.region.native_region().is_some_and(|native| {
            native.mailbox.events.load(Ordering::Acquire) & OWNER_REQUEST != 0
        })
    }

    #[cfg(test)]
    pub(super) fn hold_before_cleanup_for_transition_test(
        &mut self,
        path: PathBuf,
        coordinator_release: Arc<AtomicBool>,
    ) {
        self.hold_after_request_for_test = Some(RequestHoldForTest::SingleWake {
            path,
            coordinator_release,
        });
    }

    #[cfg(test)]
    pub(super) fn suppress_eof_proof_for_test(&mut self) {
        self.suppress_eof_proof_for_test = true;
    }

    #[cfg(test)]
    pub(super) fn partial_terminal_commit_for_test(&mut self) {
        self.partial_terminal_commit_for_test = true;
    }

    #[cfg(test)]
    pub(super) fn partial_frame_for_test(&mut self) {
        self.partial_frame_for_test = true;
    }

    #[cfg(test)]
    pub(super) fn partial_frame_failure_kept_claim_for_test(&self) -> bool {
        self.test_partial_frame_rejected_without_frame
            && self.test_partial_frame_claim_held_before_cleanup
    }

    #[cfg(test)]
    pub(super) fn trailing_data_for_test(&mut self) {
        self.trailing_data_for_test = true;
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn hold_after_commit_for_test(&mut self) {
        self.hold_after_commit_for_test = true;
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn wait_for_child_exit_after_full_request_write_for_test(&mut self) {
        self.wait_for_child_exit_after_full_request_write_for_test = true;
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn child_exit_observed_before_request_handoff_for_test(&self) -> bool {
        self.test_child_exit_observed_before_request_handoff
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn hold_stdout_open_after_commit_for_test(&mut self) {
        self.hold_stdout_open_after_commit_for_test = true;
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn suppress_exit_proof_for_test(&mut self) {
        self.suppress_exit_proof_for_test = true;
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn panic_reader_after_pipe_for_test(&mut self) {
        self.panic_reader_after_pipe_for_test = true;
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn hold_reader_after_eof_for_test(
        &mut self,
    ) -> (Arc<AtomicBool>, Arc<AtomicBool>, Arc<AtomicBool>) {
        let hold = (
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
        );
        self.reader_completion_hold_for_test = Some(hold.clone());
        hold
    }

    #[cfg(test)]
    pub(super) fn rust_oom_for_test(&mut self) {
        self.rust_oom_for_test = true;
    }

    #[cfg(test)]
    pub(super) fn sqlite_nomem_for_test(&mut self) {
        self.sqlite_nomem_for_test = true;
    }

    #[cfg(test)]
    pub(super) fn sql_steps_over_cap_for_test(&mut self) {
        self.sql_steps_over_cap_for_test = true;
    }

    #[cfg(test)]
    pub(super) fn oversized_frame_for_test(&mut self) {
        self.oversized_frame_for_test = true;
    }

    #[cfg(test)]
    fn current_oversized_frame_refusal_state(&self) -> (usize, usize, usize) {
        self.region
            .native_region()
            .map_or((0, 0, self.region.result_len), |native| {
                (
                    native.mailbox.events.load(Ordering::Acquire),
                    native.mailbox.frame_len.load(Ordering::Relaxed),
                    self.region.result_len,
                )
            })
    }

    #[cfg(test)]
    pub(super) fn oversized_frame_refusal_state_for_test(&self) -> (usize, usize, usize) {
        self.test_oversized_frame_refusal_state
    }

    #[cfg(test)]
    pub(super) fn oversized_frame_refused_before_body_for_test(&self) -> bool {
        let (events, frame_len, result_len) = self.oversized_frame_refusal_state_for_test();
        events & READER_FRAME_LIMIT != 0
            && events & (READER_FRAME | READER_FAILED) == 0
            && frame_len == 0
            && result_len == 0
    }

    #[cfg(test)]
    pub(super) fn available_request_bound_q2_frame_observed_for_test(&self) -> bool {
        self.test_available_request_bound_q2_frame_observed
    }

    #[cfg(test)]
    pub(super) fn committed_request_bound_q2_frame_with_trailing_observed_for_test(&self) -> bool {
        self.test_committed_request_bound_q2_frame_with_trailing_observed
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn frame_commit_observed_within_deadline_for_test(&self) -> bool {
        self.test_frame_commit_observed_within_deadline
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn missing_eof_boundary_observed_before_cleanup_for_test(&self) -> bool {
        self.test_missing_eof_boundary_observed_before_cleanup
    }

    #[cfg(test)]
    pub(super) fn cleanup_proved_for_test(&self) -> bool {
        self.test_cleanup_proved
    }

    #[cfg(test)]
    pub(super) fn retirement_pending_for_test(&self) -> bool {
        self.region.lease_held
            && self.region.claim.is_some()
            && self.region.storage.is_some()
            && self
                .session
                .as_ref()
                .is_some_and(|session| session.reader.is_some())
    }

    #[cfg(test)]
    pub(super) fn capacity_refusal_left_no_resources_for_test(&self) -> bool {
        self.region.claim.is_none() && self.region.storage.is_none() && self.session.is_none()
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
    pub(super) fn abnormal_exit_code_for_test(&self) -> Option<i32> {
        self.test_abnormal_exit_code
    }

    #[cfg(all(test, unix))]
    pub(super) fn abnormal_exit_signal_for_test(&self) -> Option<i32> {
        self.test_abnormal_exit_signal
    }

    #[cfg(test)]
    pub(super) fn wait_for_child_exit_code_for_test(&mut self, expected: i32) -> Result<()> {
        let deadline = Instant::now() + CLEANUP_TIMEOUT;
        loop {
            self.poll_exit()?;
            if let Some(status) = self
                .session
                .as_ref()
                .and_then(|session| session.exit.as_ref())
            {
                ensure!(
                    status.code() == Some(expected),
                    "NIR1_GRAPH_TEST_CHILD_EXIT_CODE"
                );
                return Ok(());
            }
            ensure!(
                Instant::now() < deadline,
                "NIR1_GRAPH_TEST_CHILD_EXIT_UNOBSERVED"
            );
            thread::park_timeout(POLL_INTERVAL);
        }
    }

    #[cfg(test)]
    pub(super) fn normal_exit_and_eof_observed_for_test(&self) -> bool {
        self.test_normal_exit_and_eof_observed
    }

    #[cfg(test)]
    pub(super) fn successful_request_bound_q2_frame_before_eof_suppression_for_test(&self) -> bool {
        self.test_successful_request_bound_q2_frame_before_eof_suppression
    }

    #[cfg(test)]
    pub(super) fn query_phase_diagnostics_for_test(&self) -> QueryPhaseDiagnostics {
        self.query_phase_diagnostics
    }

    #[cfg(test)]
    fn record_deadline_decision_for_test(&mut self, decision_at: Duration) {
        self.query_phase_diagnostics
            .pre_cleanup_deadline_decision_at = Some(decision_at);
        self.query_phase_diagnostics
            .observe_publications(self.reader_timing_for_test.stamps());
    }

    #[cfg(test)]
    pub(super) fn quarantined_resources_held_for_test(&self) -> bool {
        self.region.quarantined && self.test_quarantine_detached
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn result_lease_exit_proof_quarantined_for_test(&self) -> bool {
        self.region.quarantined
            && self.test_quarantine_detached
            && !self.test_cleanup_proved
            && self.test_exit_proof_suppressed
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn result_lease_reader_join_quarantined_for_test(&self) -> bool {
        self.region.quarantined
            && self.test_quarantine_detached
            && !self.test_cleanup_proved
            && self.test_reader_join_failed
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn result_lease_reader_completion_quarantined_for_test(&self) -> bool {
        self.region.quarantined
            && self.test_quarantine_detached
            && !self.test_cleanup_proved
            && self.test_reader_join_unfinished_at_cleanup_timeout
    }

    /// Admit one request after READY and return only a validated, committed frame
    /// followed by clean EOF; child exit and reader join are retirement gates.
    pub fn query_once<'a>(
        &'a mut self,
        request: &'a Nir1GraphRequest,
    ) -> Result<CQueryResultLease<'a>> {
        self.query_once_inner(request, None)
    }

    /// Run the ordinary Native query path with a caller-owned, borrowed cancellation flag.
    /// A concurrent cancellation observed before the lease decision refuses the query.
    pub fn query_once_with_cancellation<'a>(
        &'a mut self,
        request: &'a Nir1GraphRequest,
        cancellation: &AtomicBool,
    ) -> Result<CQueryResultLease<'a>> {
        self.query_once_inner(request, Some(cancellation))
    }

    fn query_once_inner<'a>(
        &'a mut self,
        request: &'a Nir1GraphRequest,
        cancellation: Option<&AtomicBool>,
    ) -> Result<CQueryResultLease<'a>> {
        ensure!(self.region.prepared, "NIR1_GRAPH_WORKER_NOT_READY");
        ensure!(!self.region.started, "NIR1_GRAPH_WORKER_ONE_QUERY_ONLY");
        let request_len = request_len(request)?;
        let admitted_at = Instant::now();
        #[cfg(test)]
        {
            self.query_phase_diagnostics = QueryPhaseDiagnostics::default();
            self.reader_timing_for_test.begin_query(admitted_at);
        }
        self.region.started = true;
        let result = self
            .query_claimed(request, request_len, admitted_at, cancellation)
            .and_then(|()| {
                #[cfg(test)]
                {
                    self.query_phase_diagnostics.final_binding_check_start_at =
                        Some(admitted_at.elapsed());
                }
                self.check_current_binding()?;
                check_caller_cancellation(cancellation)?;
                #[cfg(test)]
                {
                    self.query_phase_diagnostics.final_binding_check_end_at =
                        Some(admitted_at.elapsed());
                }
                let elapsed = admitted_at.elapsed();
                if elapsed > QUERY_DEADLINE {
                    #[cfg(test)]
                    self.record_deadline_decision_for_test(elapsed);
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
            Err(error) => {
                #[cfg(all(test, target_os = "linux"))]
                {
                    // Capture the wire/lease/child state before cleanup closes the pipe.
                    let child_still_live = self.poll_exit().is_ok()
                        && self
                            .session
                            .as_ref()
                            .is_some_and(|session| session.exit.is_none());
                    let claim_still_busy = self
                        .region
                        .claim
                        .as_ref()
                        .is_some_and(CQueryChildClaim::is_held_for_test);
                    self.test_missing_eof_boundary_observed_before_cleanup = child_still_live
                        && claim_still_busy
                        && !self.region.lease_held
                        && self.test_frame_commit_observed_within_deadline
                        && self.committed_request_bound_q2_frame_without_eof_for_test(request);
                    if self.hold_stdout_open_after_commit_for_test
                        && !self.test_missing_eof_boundary_observed_before_cleanup
                    {
                        return Err(self.cleanup_query_error_for_test(anyhow!(
                            "NIR1_GRAPH_TEST_MISSING_EOF_BOUNDARY_UNOBSERVED: {error:#}"
                        )));
                    }
                }
                #[cfg(test)]
                {
                    self.test_available_request_bound_q2_frame_observed =
                        self.available_request_bound_q2_frame_for_test(request);
                    self.test_committed_request_bound_q2_frame_with_trailing_observed =
                        self.committed_request_bound_q2_frame_with_trailing_for_test(request);
                    self.test_oversized_frame_refusal_state =
                        self.current_oversized_frame_refusal_state();
                }
                #[cfg(test)]
                {
                    Err(self.cleanup_query_error_for_test(error))
                }
                #[cfg(not(test))]
                {
                    Err(self.cleanup_error(error))
                }
            }
        }
    }

    fn cleanup_error(&mut self, error: anyhow::Error) -> anyhow::Error {
        if self.session.is_some() || self.request_writer_present() {
            if let Err(cleanup) = self.stop_and_reap() {
                self.region.quarantined = true;
                self.detach_quarantined_resources();
                return anyhow!("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED: {error}; {cleanup}");
            }
        }
        self.region.prepared = false;
        self.region.quarantined = false;
        self.release_claim_after_retirement();
        error
    }

    #[cfg(test)]
    fn cleanup_query_error_for_test(&mut self, error: anyhow::Error) -> anyhow::Error {
        let error = match self.hold_after_request_for_test.take() {
            Some(RequestHoldForTest::SingleWake {
                path,
                coordinator_release,
            }) => {
                let temporary_path = path.with_extension("tmp");
                let marker_result = std::fs::write(&temporary_path, b"query-error")
                    .and_then(|()| std::fs::rename(temporary_path, path));
                if let Err(marker_error) = marker_result {
                    error.context(format!("NIR1_GRAPH_TEST_TRANSITION_MARKER: {marker_error}"))
                } else {
                    let deadline = Instant::now() + Duration::from_secs(5);
                    while !coordinator_release.load(Ordering::Acquire) {
                        let remaining = deadline.saturating_duration_since(Instant::now());
                        if remaining.is_zero() {
                            break;
                        }
                        thread::park_timeout(remaining);
                    }
                    if coordinator_release.load(Ordering::Acquire) {
                        error
                    } else {
                        error.context("NIR1_GRAPH_TEST_TRANSITION_SIGNAL_TIMEOUT")
                    }
                }
            }
            Some(hold @ RequestHoldForTest::UntilKilled(_)) => {
                self.hold_after_request_for_test = Some(hold);
                error
            }
            None => error,
        };
        let started_at = Instant::now();
        let error = self.cleanup_error(error);
        self.query_phase_diagnostics.cleanup_elapsed = Some(started_at.elapsed());
        error
    }

    fn prepare_claimed(
        &mut self,
        authority: &std::sync::Arc<WorkspaceAuthority>,
        project_id: &str,
    ) -> Result<()> {
        let storage = reserve_storage()?;
        // SAFETY: no reader exists yet and this reservation owns the process slot.
        unsafe {
            let bytes = &mut *storage.region().bytes_mut_ptr();
            bytes[..project_id.len()].copy_from_slice(project_id.as_bytes());
        }
        self.region.prepared_project_len = project_id.len();
        self.region.storage = Some(storage);

        let worker = self
            .worker
            .take()
            .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_PATH"))?;
        let mut command = Command::new(worker);
        command
            .arg(authority.path())
            .arg(project_id)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(test)]
        if self.partial_terminal_commit_for_test {
            command.env("NIR1_C_QUERY_TEST_PARTIAL_COMMIT", "partial");
        }
        #[cfg(test)]
        if self.partial_frame_for_test {
            command.env("NIR1_C_QUERY_TEST_PARTIAL_FRAME", "partial");
        }
        #[cfg(test)]
        if self.trailing_data_for_test {
            command.env("NIR1_C_QUERY_TEST_TRAILING_DATA", "trailing");
        }
        #[cfg(test)]
        if let Some(marker) = self.child_frame_barrier_for_test.as_ref() {
            command.env("NIR1_C_QUERY_TEST_HOLD_BEFORE_FRAME", marker);
        }
        #[cfg(all(test, target_os = "linux"))]
        if let Some(marker) = self.child_request_barrier_for_test.as_ref() {
            command.env("NIR1_C_QUERY_TEST_HOLD_BEFORE_REQUEST", marker);
        }
        #[cfg(all(test, target_os = "linux"))]
        if self.hold_after_commit_for_test {
            command.env("NIR1_C_QUERY_TEST_HOLD_AFTER_COMMIT", "held");
        }
        #[cfg(all(test, target_os = "linux"))]
        if self.hold_stdout_open_after_commit_for_test {
            command.env("NIR1_C_QUERY_TEST_HOLD_STDOUT_OPEN_AFTER_COMMIT", "held");
        }
        #[cfg(test)]
        if self.rust_oom_for_test {
            command.env("NIR1_C_QUERY_TEST_RUST_OOM", "query");
        }
        #[cfg(test)]
        if self.sqlite_nomem_for_test {
            command.env("NIR1_C_QUERY_TEST_SQLITE_NOMEM", "query");
        }
        #[cfg(test)]
        if self.sql_steps_over_cap_for_test {
            command.env("NIR1_C_QUERY_TEST_SQL_STEPS", "over-limit");
        }
        #[cfg(test)]
        if self.oversized_frame_for_test {
            command.env("NIR1_C_QUERY_TEST_OVERSIZED_FRAME_LENGTH", "one-over-limit");
        }
        let child = command.spawn()?;
        drop(command);
        self.session = Some(ChildSession {
            child,
            stdin: None,
            reader: None,
            exit: None,
            eof: false,
        });
        let stdout = {
            let session = self
                .session
                .as_mut()
                .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_SESSION"))?;
            session.stdin = session.child.stdin.take();
            let stdout = session.child.stdout.take();
            if session.stdin.is_none() || stdout.is_none() {
                anyhow::bail!("NIR1_GRAPH_WORKER_PIPE_MISSING");
            }
            stdout.ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_STDOUT"))?
        };
        let region_address = self
            .region
            .native_region()
            .map(|region| NativeRegionPtr {
                region: region as *const NativeRegion,
                reader_timing: {
                    #[cfg(test)]
                    {
                        self.reader_timing_for_test.clone()
                    }
                    #[cfg(not(test))]
                    {
                        ReaderPublicationTiming::default()
                    }
                },
            })
            .ok_or_else(|| anyhow!("NIR1_GRAPH_NATIVE_ARENA"))?;
        #[cfg(all(test, target_os = "linux"))]
        let panic_reader_after_pipe = self.panic_reader_after_pipe_for_test;
        #[cfg(all(test, target_os = "linux"))]
        let reader_completion_hold = self.reader_completion_hold_for_test.take();
        let reader = match thread::Builder::new().spawn(move || {
            // SAFETY: the owner pins the region until this reader is joined or quarantined.
            unsafe { region_address.read_pipe(stdout) };
            #[cfg(all(test, target_os = "linux"))]
            if panic_reader_after_pipe {
                panic!("NIR1_GRAPH_TEST_READER_JOIN_FAILURE");
            }
            #[cfg(all(test, target_os = "linux"))]
            if let Some((entered, release, finished)) = reader_completion_hold {
                entered.store(true, Ordering::Release);
                while !release.load(Ordering::Acquire) {
                    thread::park_timeout(POLL_INTERVAL);
                }
                finished.store(true, Ordering::Release);
            }
        }) {
            Ok(reader) => reader,
            Err(error) => {
                // stdout was transferred to a thread that could not start; cleanup
                // will quarantine unless actual exit and pipe EOF can be proved.
                return Err(error.into());
            }
        };
        let parent_thread = thread::current();
        self.session
            .as_mut()
            .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_SESSION"))?
            .reader = Some(reader);
        let native = self
            .region
            .native_region()
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
        cancellation: Option<&AtomicBool>,
    ) -> Result<()> {
        self.check_current_binding()?;
        let project_len = self.region.prepared_project_len;
        {
            let native = self
                .region
                .native_region()
                .ok_or_else(|| anyhow!("NIR1_GRAPH_NATIVE_ARENA"))?;
            // SAFETY: the reader is waiting for OWNER_REQUEST and has not touched
            // the buffer; this owner exclusively prepares the request bytes.
            let bytes = unsafe { &mut *native.bytes_mut_ptr() };
            ensure!(
                project_len == request.project_id.len()
                    && &bytes[..project_len] == request.project_id.as_bytes(),
                "NIR1_GRAPH_WORKER_PROJECT_MISMATCH"
            );
            encode_request(request, &mut bytes[..REQUEST_BYTES])?;
        }
        #[cfg(all(target_os = "linux", not(test)))]
        let write_result = {
            let mut stdin = self.take_request_stdin()?;
            let result =
                self.write_request_nonblocking(&mut stdin, request_len, admitted_at, cancellation);
            drop(stdin);
            result
        };
        #[cfg(all(target_os = "linux", test))]
        let write_result = if self.threaded_request_writer_for_test {
            self.write_request_threaded(request_len, admitted_at, cancellation)
        } else {
            let mut stdin = self.take_request_stdin()?;
            let result =
                self.write_request_nonblocking(&mut stdin, request_len, admitted_at, cancellation);
            drop(stdin);
            result
        };
        #[cfg(not(target_os = "linux"))]
        let write_result = self.write_request_threaded(request_len, admitted_at, cancellation);
        write_result?;
        let native = self
            .region
            .native_region()
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
                self.region
                    .claim
                    .as_ref()
                    .is_some_and(CQueryChildClaim::is_held_for_test),
                "NIR1_GRAPH_TEST_CLAIM_NOT_BUSY_AFTER_REQUEST"
            );
            let marker = self
                .child_frame_barrier_for_test
                .clone()
                .ok_or_else(|| anyhow!("NIR1_GRAPH_TEST_CHILD_ACK_PATH_MISSING"))?;
            // Bound only a broken test seam; this is not the query or retirement deadline.
            let acknowledgement_deadline = Instant::now() + Duration::from_secs(5);
            loop {
                self.check_current_binding()?;
                check_caller_cancellation(cancellation)?;
                if marker.is_file() {
                    ensure!(
                        std::fs::read(&marker)?.as_slice() == b"q2-frame-pending",
                        "NIR1_GRAPH_TEST_CHILD_ACK_INVALID"
                    );
                    break;
                }
                self.poll_exit()?;
                if let Some(status) = self
                    .session
                    .as_ref()
                    .and_then(|session| session.exit.as_ref())
                {
                    anyhow::bail!("NIR1_GRAPH_TEST_CHILD_ACK_EXITED_BEFORE_BARRIER: {status:?}");
                }
                ensure!(
                    Instant::now() < acknowledgement_deadline,
                    "NIR1_GRAPH_TEST_CHILD_ACK_TIMEOUT"
                );
                thread::sleep(POLL_INTERVAL);
            }
            eprintln!(
                "Native test fault: child acknowledged completed Q2 and held before frame; injecting termination"
            );
            self.session
                .as_mut()
                .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_SESSION"))?
                .child
                .kill()?;
            anyhow::bail!("NIR1_GRAPH_TEST_CHILD_CRASH_AFTER_REQUEST");
        }

        #[cfg(test)]
        if let Some(RequestHoldForTest::UntilKilled(path)) =
            self.hold_after_request_for_test.as_ref()
        {
            let temporary_path = path.with_extension("tmp");
            std::fs::write(&temporary_path, b"admitted")?;
            std::fs::rename(temporary_path, path)?;
            loop {
                thread::park_timeout(Duration::from_secs(30));
            }
        }

        loop {
            self.check_current_binding()?;
            check_caller_cancellation(cancellation)?;
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
            #[cfg(test)]
            {
                let events = self
                    .region
                    .native_region()
                    .ok_or_else(|| anyhow!("NIR1_GRAPH_NATIVE_ARENA"))?
                    .mailbox
                    .events
                    .load(Ordering::Acquire);
                let events_observed_at = admitted_at.elapsed();
                self.query_phase_diagnostics
                    .observe_events(events, events_observed_at);
                self.query_phase_diagnostics
                    .observe_publications(self.reader_timing_for_test.stamps());
                #[cfg(target_os = "linux")]
                if events & (READER_FRAME | READER_COMMIT) == (READER_FRAME | READER_COMMIT)
                    && events_observed_at < QUERY_DEADLINE
                {
                    self.test_frame_commit_observed_within_deadline = true;
                }
            }
            let elapsed = admitted_at.elapsed();
            if elapsed >= QUERY_DEADLINE {
                #[cfg(test)]
                self.record_deadline_decision_for_test(elapsed);
                anyhow::bail!("{}", deadline_refusal_reason(self.region.elapsed));
            }
            let native = self
                .region
                .native_region()
                .ok_or_else(|| anyhow!("NIR1_GRAPH_NATIVE_ARENA"))?;
            let events = native.mailbox.events.load(Ordering::Acquire);
            #[cfg(test)]
            {
                self.query_phase_diagnostics
                    .observe_events(events, admitted_at.elapsed());
                self.query_phase_diagnostics
                    .observe_publications(self.reader_timing_for_test.stamps());
            }
            if events & READER_TRAILING != 0 {
                anyhow::bail!("NIR1_GRAPH_WORKER_TRAILING_PIPE_DATA");
            }
            if events & READER_FRAME_LIMIT != 0 {
                anyhow::bail!("NIR1_GRAPH_FRAME_LIMIT");
            }
            if events & READER_FAILED != 0 {
                #[cfg(test)]
                if self.partial_frame_for_test {
                    self.test_partial_frame_rejected_without_frame =
                        self.region.result_len == 0 && events & (READER_FRAME | READER_COMMIT) == 0;
                    self.test_partial_frame_claim_held_before_cleanup = self
                        .region
                        .claim
                        .as_ref()
                        .is_some_and(CQueryChildClaim::is_held_for_test);
                }
                anyhow::bail!("NIR1_GRAPH_WORKER_PIPE_TRUNCATED");
            }
            if events & READER_PIPE_ERROR != 0 {
                anyhow::bail!("NIR1_GRAPH_WORKER_PIPE_ERROR");
            }
            if events & READER_EOF != 0 {
                #[cfg(test)]
                if self.suppress_eof_proof_for_test {
                    ensure!(
                        events & READER_FRAME != 0,
                        "NIR1_GRAPH_TEST_EOF_WITHOUT_COMPLETE_FRAME"
                    );
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
                self.check_current_binding()?;
                let frame_binding_validated_at = admitted_at.elapsed();
                self.region.elapsed = Some(frame_binding_validated_at);
                #[cfg(test)]
                {
                    self.query_phase_diagnostics.frame_binding_validated_at =
                        Some(frame_binding_validated_at);
                }
                self.region.result_len = len;
            }
            #[cfg(test)]
            if self.suppress_eof_proof_for_test && events & READER_EOF != 0 {
                ensure!(
                    self.region.result_len > 0
                        && self.request_bound_q2_frame_for_test(
                            request,
                            READER_FRAME | READER_COMMIT | READER_EOF,
                            READER_FAILED | READER_TRAILING | READER_PIPE_ERROR,
                        ),
                    "NIR1_GRAPH_TEST_EOF_SUPPRESSION_WITHOUT_SUCCESSFUL_Q2_FRAME"
                );
                self.test_successful_request_bound_q2_frame_before_eof_suppression = true;
                let exit_deadline = Instant::now() + CLEANUP_TIMEOUT;
                loop {
                    self.poll_exit()?;
                    if let Some(status) = self
                        .session
                        .as_ref()
                        .and_then(|session| session.exit.as_ref())
                    {
                        ensure!(status.success(), "NIR1_GRAPH_TEST_CHILD_EXIT_FAILURE");
                        break;
                    }
                    ensure!(
                        Instant::now() < exit_deadline,
                        "NIR1_GRAPH_TEST_CHILD_EXIT_UNOBSERVED"
                    );
                    thread::yield_now();
                }
                self.test_normal_exit_and_eof_observed = true;
                anyhow::bail!("NIR1_GRAPH_TEST_EOF_PROOF_UNOBSERVED");
            }
            if self.region.result_len > 0 && result_wire_complete(events) {
                check_caller_cancellation(cancellation)?;
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
                #[cfg(test)]
                self.record_deadline_decision_for_test(admitted_at.elapsed());
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

    fn take_request_stdin(&mut self) -> Result<ChildStdin> {
        self.session
            .as_mut()
            .and_then(|session| session.stdin.take())
            .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_STDIN"))
    }

    #[cfg(any(not(target_os = "linux"), test))]
    fn write_request_threaded(
        &mut self,
        request_len: usize,
        admitted_at: Instant,
        cancellation: Option<&AtomicBool>,
    ) -> Result<()> {
        self.check_current_binding()?;
        check_caller_cancellation(cancellation)?;
        if admitted_at.elapsed() >= QUERY_DEADLINE {
            #[cfg(test)]
            self.record_deadline_decision_for_test(admitted_at.elapsed());
            anyhow::bail!("{}", deadline_refusal_reason(self.region.elapsed));
        }
        let native = self
            .region
            .native_region()
            .ok_or_else(|| anyhow!("NIR1_GRAPH_NATIVE_ARENA"))?;
        let mut request_bytes = [0; REQUEST_BYTES];
        // SAFETY: the reader remains behind OWNER_REQUEST while these bytes are copied.
        request_bytes[..request_len].copy_from_slice(unsafe { &native.bytes()[..request_len] });
        self.check_current_binding()?;
        check_caller_cancellation(cancellation)?;
        let stdin = self.take_request_stdin()?;
        #[cfg(test)]
        let progress = self.request_write_progress_for_test.clone();
        #[cfg(test)]
        let writer_hold = self.request_writer_hold_for_test.clone();
        let writer = thread::Builder::new().spawn(move || {
            let mut stdin = stdin;
            let mut written = 0;
            let result = loop {
                if written == request_len {
                    break Ok(());
                }
                let end = (written + REQUEST_WRITE_CHUNK_BYTES).min(request_len);
                match stdin.write(&request_bytes[written..end]) {
                    Ok(0) => {
                        break Err(std::io::Error::new(
                            std::io::ErrorKind::WriteZero,
                            "NIR1_GRAPH_WORKER_STDIN_WRITE_ZERO",
                        ));
                    }
                    Ok(count) => {
                        written += count;
                        #[cfg(test)]
                        if let Some(progress) = &progress {
                            progress.store(written, Ordering::Release);
                        }
                        #[cfg(test)]
                        if let Some(hold) = &writer_hold {
                            if written >= hold.after_bytes
                                && !hold.entered.swap(true, Ordering::AcqRel)
                            {
                                while !hold.release.load(Ordering::Acquire) {
                                    thread::park_timeout(POLL_INTERVAL);
                                }
                            }
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => break Err(error),
                }
            };
            let completion = RequestWriteCompletion {
                stdin,
                written,
                result,
            };
            #[cfg(test)]
            if let Some(hold) = &writer_hold {
                hold.finished.store(true, Ordering::Release);
            }
            completion
        })?;
        self.request_writer = Some(writer);

        loop {
            self.check_current_binding()?;
            check_caller_cancellation(cancellation)?;
            let writer_finished = self
                .request_writer
                .as_ref()
                .is_some_and(JoinHandle::is_finished);
            #[cfg(test)]
            {
                let written = self
                    .request_write_progress_for_test
                    .as_ref()
                    .map_or(0, |progress| progress.load(Ordering::Acquire));
                self.query_phase_diagnostics.request_bytes_written = written;
                if !writer_finished
                    && written >= self.request_write_stall_threshold_for_test
                    && written < request_len
                {
                    self.query_phase_diagnostics.request_write_stalled = true;
                    #[cfg(target_os = "linux")]
                    if let Some(blocked) = &self.request_write_blocked_signal_for_test {
                        blocked.store(true, Ordering::Release);
                    }
                }
            }
            if writer_finished {
                let RequestWriteCompletion {
                    stdin,
                    written,
                    result,
                } = self.join_request_writer()?;
                #[cfg(test)]
                {
                    self.query_phase_diagnostics.request_bytes_written = written;
                }
                drop(stdin);
                match result {
                    Ok(()) => {
                        ensure!(
                            written == request_len,
                            "NIR1_GRAPH_WORKER_STDIN_WRITE_INCOMPLETE"
                        );
                        if admitted_at.elapsed() >= QUERY_DEADLINE {
                            #[cfg(test)]
                            self.record_deadline_decision_for_test(admitted_at.elapsed());
                            anyhow::bail!("{}", deadline_refusal_reason(self.region.elapsed));
                        }
                        #[cfg(all(test, target_os = "linux"))]
                        if self.wait_for_child_exit_after_full_request_write_for_test {
                            loop {
                                self.poll_exit()?;
                                if self
                                    .session
                                    .as_ref()
                                    .is_some_and(|session| session.exit.is_some())
                                {
                                    self.test_child_exit_observed_before_request_handoff = true;
                                    break;
                                }
                                ensure!(
                                    admitted_at.elapsed() < QUERY_DEADLINE,
                                    "NIR1_GRAPH_TEST_CHILD_DID_NOT_EXIT_BEFORE_DEADLINE"
                                );
                                thread::yield_now();
                            }
                        }
                        return Ok(());
                    }
                    Err(error) => {
                        self.poll_exit()?;
                        if self
                            .session
                            .as_ref()
                            .is_some_and(|session| session.exit.is_some())
                        {
                            anyhow::bail!("NIR1_GRAPH_WORKER_EXIT_DURING_REQUEST");
                        }
                        if error.kind() == std::io::ErrorKind::BrokenPipe {
                            return self
                                .wait_for_child_exit_after_broken_pipe(admitted_at, cancellation);
                        }
                        if error.kind() == std::io::ErrorKind::WriteZero {
                            anyhow::bail!("NIR1_GRAPH_WORKER_STDIN_WRITE_ZERO");
                        }
                        return Err(error.into());
                    }
                }
            }
            self.poll_exit()?;
            let child_exited = self
                .session
                .as_ref()
                .is_some_and(|session| session.exit.is_some());
            if admitted_at.elapsed() >= QUERY_DEADLINE {
                #[cfg(test)]
                self.record_deadline_decision_for_test(admitted_at.elapsed());
                if child_exited {
                    anyhow::bail!("NIR1_GRAPH_WORKER_EXIT_DURING_REQUEST");
                }
                anyhow::bail!("{}", deadline_refusal_reason(self.region.elapsed));
            }
            thread::park_timeout(POLL_INTERVAL);
        }
    }

    #[cfg(any(not(target_os = "linux"), test))]
    fn wait_for_child_exit_after_broken_pipe(
        &mut self,
        admitted_at: Instant,
        cancellation: Option<&AtomicBool>,
    ) -> Result<()> {
        loop {
            self.check_current_binding()?;
            check_caller_cancellation(cancellation)?;
            self.poll_exit()?;
            if self
                .session
                .as_ref()
                .is_some_and(|session| session.exit.is_some())
            {
                anyhow::bail!("NIR1_GRAPH_WORKER_EXIT_DURING_REQUEST");
            }
            if admitted_at.elapsed() >= QUERY_DEADLINE {
                #[cfg(test)]
                self.record_deadline_decision_for_test(admitted_at.elapsed());
                anyhow::bail!("{}", deadline_refusal_reason(self.region.elapsed));
            }
            thread::park_timeout(POLL_INTERVAL);
        }
    }

    #[cfg(any(not(target_os = "linux"), test))]
    fn join_request_writer(&mut self) -> Result<RequestWriteCompletion> {
        ensure!(
            self.request_writer
                .as_ref()
                .is_some_and(JoinHandle::is_finished),
            "NIR1_GRAPH_WORKER_STDIN_WRITER_NOT_FINISHED"
        );
        let writer = self
            .request_writer
            .take()
            .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_STDIN_WRITER"))?;
        let result = writer
            .join()
            .map_err(|_| anyhow!("NIR1_GRAPH_WORKER_STDIN_WRITER_PANIC"));
        #[cfg(test)]
        {
            self.test_request_writer_joined = true;
        }
        result
    }

    #[cfg(any(not(target_os = "linux"), test))]
    fn join_request_writer_if_finished(&mut self) -> bool {
        let Some(writer) = self.request_writer.as_ref() else {
            return true;
        };
        if !writer.is_finished() {
            return false;
        }
        let Some(writer) = self.request_writer.take() else {
            return true;
        };
        if let Ok(completion) = writer.join() {
            drop(completion.stdin);
        }
        #[cfg(test)]
        {
            self.test_request_writer_joined = true;
        }
        true
    }

    #[cfg(target_os = "linux")]
    fn write_request_nonblocking(
        &mut self,
        stdin: &mut ChildStdin,
        request_len: usize,
        admitted_at: Instant,
        cancellation: Option<&AtomicBool>,
    ) -> Result<()> {
        use std::os::fd::AsRawFd;

        let fd = stdin.as_raw_fd();
        // SAFETY: the owner holds this live child-stdin descriptor exclusively.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        ensure!(
            flags >= 0,
            "NIR1_GRAPH_WORKER_STDIN_FLAGS: {}",
            std::io::Error::last_os_error()
        );
        // The descriptor is closed on success or error, so O_NONBLOCK cannot escape this call.
        // SAFETY: F_SETFL updates status flags on the live descriptor we own.
        let set_flags = unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
        ensure!(
            set_flags >= 0,
            "NIR1_GRAPH_WORKER_STDIN_NONBLOCK: {}",
            std::io::Error::last_os_error()
        );

        let mut written = 0;
        loop {
            self.check_current_binding()?;
            check_caller_cancellation(cancellation)?;
            // A completed transfer may already have produced a committed frame; hand it off before classifying exit.
            if written == request_len {
                if admitted_at.elapsed() >= QUERY_DEADLINE {
                    #[cfg(test)]
                    self.record_deadline_decision_for_test(admitted_at.elapsed());
                    anyhow::bail!("{}", deadline_refusal_reason(self.region.elapsed));
                }
                #[cfg(all(test, target_os = "linux"))]
                if self.wait_for_child_exit_after_full_request_write_for_test {
                    loop {
                        self.poll_exit()?;
                        if self
                            .session
                            .as_ref()
                            .is_some_and(|session| session.exit.is_some())
                        {
                            self.test_child_exit_observed_before_request_handoff = true;
                            break;
                        }
                        ensure!(
                            admitted_at.elapsed() < QUERY_DEADLINE,
                            "NIR1_GRAPH_TEST_CHILD_DID_NOT_EXIT_BEFORE_DEADLINE"
                        );
                        thread::yield_now();
                    }
                }
                return Ok(());
            }
            self.poll_exit()?;
            ensure!(
                self.session
                    .as_ref()
                    .is_some_and(|session| session.exit.is_none()),
                "NIR1_GRAPH_WORKER_EXIT_DURING_REQUEST"
            );
            if admitted_at.elapsed() >= QUERY_DEADLINE {
                #[cfg(test)]
                self.record_deadline_decision_for_test(admitted_at.elapsed());
                anyhow::bail!("{}", deadline_refusal_reason(self.region.elapsed));
            }

            let result = {
                let native = self
                    .region
                    .native_region()
                    .ok_or_else(|| anyhow!("NIR1_GRAPH_NATIVE_ARENA"))?;
                // SAFETY: OWNER_REQUEST is not published until this complete transfer ends.
                let bytes = unsafe { native.bytes() };
                stdin.write(&bytes[written..request_len])
            };
            match result {
                Ok(0) => anyhow::bail!("NIR1_GRAPH_WORKER_STDIN_WRITE_ZERO"),
                Ok(count) => {
                    written += count;
                    #[cfg(test)]
                    {
                        self.query_phase_diagnostics.request_bytes_written = written;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    #[cfg(test)]
                    {
                        self.query_phase_diagnostics.request_write_stalled = true;
                        if let Some(blocked) = &self.request_write_blocked_signal_for_test {
                            blocked.store(true, Ordering::Release);
                        }
                    }
                    let mut descriptor = libc::pollfd {
                        fd,
                        events: libc::POLLOUT,
                        revents: 0,
                    };
                    // Keep cancellation/binding/exit checks responsive while the child is slow.
                    // poll rounds up to milliseconds, so every wake is followed by a deadline check.
                    let ready = unsafe {
                        libc::poll(&mut descriptor, 1, POLL_INTERVAL.as_millis() as libc::c_int)
                    };
                    if ready < 0 {
                        let error = std::io::Error::last_os_error();
                        if error.kind() == std::io::ErrorKind::Interrupted {
                            continue;
                        }
                        return Err(error.into());
                    }
                    ensure!(
                        descriptor.revents & libc::POLLNVAL == 0,
                        "NIR1_GRAPH_WORKER_STDIN_POLL_INVALID"
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => loop {
                    self.check_current_binding()?;
                    check_caller_cancellation(cancellation)?;
                    self.poll_exit()?;
                    if self
                        .session
                        .as_ref()
                        .is_some_and(|session| session.exit.is_some())
                    {
                        anyhow::bail!("NIR1_GRAPH_WORKER_EXIT_DURING_REQUEST");
                    }
                    if admitted_at.elapsed() >= QUERY_DEADLINE {
                        #[cfg(test)]
                        self.record_deadline_decision_for_test(admitted_at.elapsed());
                        anyhow::bail!("{}", deadline_refusal_reason(self.region.elapsed));
                    }
                    thread::park_timeout(POLL_INTERVAL);
                },
                Err(error) => return Err(error.into()),
            }
        }
    }

    fn wait_until_ready(&mut self) -> Result<()> {
        let deadline = Instant::now() + START_TIMEOUT;
        loop {
            self.check_current_binding()?;
            self.poll_exit()?;
            if self
                .session
                .as_ref()
                .is_some_and(|session| session.exit.is_some())
            {
                return Err(self.startup_exit_error());
            }
            if Instant::now() >= deadline {
                anyhow::bail!("NIR1_GRAPH_WORKER_START_TIMEOUT");
            }
            let native = self
                .region
                .native_region()
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
                thread::park_timeout(POLL_INTERVAL);
                continue;
            }
            if events & READER_TRAILING != 0 {
                anyhow::bail!("NIR1_GRAPH_WORKER_TRAILING_PIPE_DATA");
            }
            if events & READER_PIPE_ERROR != 0 {
                thread::park_timeout(POLL_INTERVAL);
                continue;
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

    fn startup_exit_error(&mut self) -> anyhow::Error {
        let Some(stderr) = self
            .session
            .as_mut()
            .and_then(|session| session.child.stderr.as_mut())
        else {
            return anyhow!("NIR1_GRAPH_WORKER_EXIT_BEFORE_READY");
        };
        let mut bytes = [0u8; STARTUP_STDERR_CAPTURE_BYTES];
        let mut length = 0;
        let mut line_count = 0;
        #[cfg(feature = "nir1-c-query-test-seam")]
        let max_lines = 2;
        #[cfg(not(feature = "nir1-c-query-test-seam"))]
        let max_lines = 1;
        while length < bytes.len() && line_count < max_lines {
            let Ok(read) = stderr.read(&mut bytes[length..]) else {
                break;
            };
            if read == 0 {
                break;
            }
            line_count += bytes[length..length + read]
                .iter()
                .filter(|byte| **byte == b'\n')
                .count();
            length += read;
        }
        startup_exit_error_from_bytes(&bytes[..length])
    }

    fn poll_exit(&mut self) -> Result<()> {
        let exit = {
            let session = self
                .session
                .as_mut()
                .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_SESSION"))?;
            if session.exit.is_some() {
                return Ok(());
            }
            session.child.try_wait()?
        };
        if let Some(exit) = exit {
            #[cfg(all(test, target_os = "linux"))]
            if self.suppress_exit_proof_for_test {
                // Simulate failure to transfer an observed exit status to the owner.
                self.test_exit_proof_suppressed = true;
                return Ok(());
            }
            self.session
                .as_mut()
                .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_SESSION"))?
                .exit = Some(exit);
        }
        Ok(())
    }

    #[cfg(test)]
    fn available_request_bound_q2_frame_for_test(&self, request: &Nir1GraphRequest) -> bool {
        self.request_bound_q2_frame_for_test(
            request,
            READER_FRAME | READER_FAILED,
            READER_COMMIT | READER_TRAILING | READER_PIPE_ERROR,
        )
    }

    #[cfg(test)]
    fn committed_request_bound_q2_frame_with_trailing_for_test(
        &self,
        request: &Nir1GraphRequest,
    ) -> bool {
        self.request_bound_q2_frame_for_test(
            request,
            READER_FRAME | READER_COMMIT | READER_TRAILING,
            READER_FAILED | READER_PIPE_ERROR,
        )
    }

    #[cfg(all(test, target_os = "linux"))]
    fn committed_request_bound_q2_frame_without_eof_for_test(
        &self,
        request: &Nir1GraphRequest,
    ) -> bool {
        self.region.result_len > 0
            && self
                .region
                .elapsed
                .is_some_and(|elapsed| elapsed <= QUERY_DEADLINE)
            && self.request_bound_q2_frame_for_test(
                request,
                READER_FRAME | READER_COMMIT,
                READER_EOF | READER_FAILED | READER_TRAILING | READER_PIPE_ERROR,
            )
    }

    #[cfg(test)]
    fn request_bound_q2_frame_for_test(
        &self,
        request: &Nir1GraphRequest,
        required_events: usize,
        forbidden_events: usize,
    ) -> bool {
        let Some(native) = self.region.native_region() else {
            return false;
        };
        let events = native.mailbox.events.load(Ordering::Acquire);
        if events & required_events != required_events || events & forbidden_events != 0 {
            return false;
        }
        let len = native.mailbox.frame_len.load(Ordering::Relaxed);
        if !frame_length_allowed(len) {
            return false;
        }
        // SAFETY: READER_FRAME is acquire-observed, so the reader no longer
        // mutates these bytes; the fixed region remains owned through cleanup.
        let bytes = unsafe { native.bytes() };
        let Ok(frame) = worker_frame::validate(&bytes[..len]) else {
            return false;
        };
        frame.project == request.project_id.as_str()
            && frame.scene == request.query_scene_id.as_str()
            && frame.reason.is_none()
            && frame.scope.is_some()
            && frame.generation.is_some_and(|generation| generation > 0)
            && frame.seed == Some(request.seed_entity_id.as_str())
            && frame.node_count == 1
            && frame.edge_count == 0
            && frame
                .first_node
                .is_some_and(|node| node.entity.id == request.seed_entity_id.as_str())
    }

    fn result_bytes(&self, len: usize) -> Result<&[u8]> {
        let native = self
            .region
            .native_region()
            .ok_or_else(|| anyhow!("NIR1_GRAPH_NATIVE_ARENA"))?;
        ensure!(frame_length_allowed(len), "NIR1_GRAPH_FRAME_LIMIT");
        // SAFETY: READER_FRAME is acquire-observed before validation, and the
        // reader no longer mutates the frame buffer after publishing it.
        let bytes = unsafe { native.bytes() };
        Ok(&bytes[..len])
    }

    /// Kill then wait only for the bounded cleanup interval. The claim and
    /// snapshot are intentionally retained if exit or pipe EOF is unproved.
    fn stop_and_reap(&mut self) -> Result<()> {
        if self.session.is_none() {
            ensure!(
                !self.request_writer_present(),
                "NIR1_GRAPH_WORKER_STDIN_WRITER_WITHOUT_SESSION"
            );
            return Ok(());
        }
        let Some(session) = self.session.as_mut() else {
            return Ok(());
        };
        if let Some(native) = self.region.native_region() {
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
                .native_region()
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
            #[cfg(any(not(target_os = "linux"), test))]
            let request_writer_joined = self.join_request_writer_if_finished();
            #[cfg(all(target_os = "linux", not(test)))]
            let request_writer_joined = true;
            let reader_finished = self
                .session
                .as_ref()
                .is_some_and(|session| session.reader.as_ref().is_none_or(JoinHandle::is_finished));
            if request_writer_joined
                && reader_finished
                && self
                    .session
                    .as_ref()
                    .is_some_and(|session| session.exit.is_some() && session.eof)
            {
                let session = self
                    .session
                    .as_mut()
                    .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_SESSION"))?;
                if let Some(reader) = session.reader.take() {
                    let joined = reader.join();
                    #[cfg(all(test, target_os = "linux"))]
                    if joined.is_err() {
                        self.test_reader_join_failed = true;
                    }
                    joined.map_err(|_| anyhow!("NIR1_GRAPH_WORKER_READER_PANIC"))?;
                }
                let session = self
                    .session
                    .take()
                    .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_SESSION"))?;
                #[cfg(test)]
                {
                    // ExitStatus is populated only by Child::try_wait in poll_exit.
                    self.test_abnormal_exit_observed = session
                        .exit
                        .as_ref()
                        .is_some_and(|status| !status.success());
                    self.test_abnormal_exit_code =
                        session.exit.as_ref().and_then(|status| status.code());
                    #[cfg(all(test, unix))]
                    {
                        use std::os::unix::process::ExitStatusExt;
                        self.test_abnormal_exit_signal =
                            session.exit.as_ref().and_then(|status| status.signal());
                    }
                    // Retirement requires writer completion (if any), actual exit,
                    // stdout EOF and successful reader join.
                    self.test_cleanup_proved = true;
                }
                drop(session);
                return Ok(());
            }
            thread::park_timeout(POLL_INTERVAL);
        }
        #[cfg(test)]
        {
            self.test_live_writer_at_cleanup_timeout = self
                .request_writer
                .as_ref()
                .is_some_and(|writer| !writer.is_finished())
                && self.session.as_ref().is_some_and(|session| {
                    session.exit.is_some() && session.eof && session.reader.is_some()
                });
            #[cfg(target_os = "linux")]
            {
                self.test_reader_join_unfinished_at_cleanup_timeout =
                    self.session.as_ref().is_some_and(|session| {
                        session.exit.is_some()
                            && session.eof
                            && session
                                .reader
                                .as_ref()
                                .is_some_and(|reader| !reader.is_finished())
                    });
            }
        }
        anyhow::bail!("NIR1_GRAPH_WORKER_BOUNDED_JOIN_UNPROVED")
    }
}

/// A borrowed projection over the Native fixed result region. Drop retires the
/// child before releasing admission; unproved cleanup leaves the owner quarantined.
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

    #[cfg(test)]
    pub(super) fn retirement_pending_for_test(&self) -> bool {
        self.owner.retirement_pending_for_test()
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn suppress_exit_proof_for_test(&mut self) {
        self.owner.suppress_exit_proof_for_test();
    }

    #[cfg(test)]
    pub(super) fn committed_eof_with_reader_pending_for_test(&self) -> bool {
        let Some(session) = self.owner.session.as_ref() else {
            return false;
        };
        let Some(native) = self.owner.region.native_region() else {
            return false;
        };
        self.owner.region.result_len > 0
            && session.eof
            && session.reader.is_some()
            && result_wire_complete(native.mailbox.events.load(Ordering::Acquire))
    }

    #[cfg(test)]
    pub(super) fn wait_for_child_exit_code_for_test(&mut self, expected: i32) -> Result<()> {
        self.owner.wait_for_child_exit_code_for_test(expected)
    }

    #[cfg(all(test, target_os = "linux"))]
    pub(super) fn child_exit_unobserved_for_test(&mut self) -> Result<bool> {
        self.owner.poll_exit()?;
        Ok(self
            .owner
            .session
            .as_ref()
            .is_some_and(|session| session.exit.is_none()))
    }
}

impl Drop for CQueryResultLease<'_> {
    fn drop(&mut self) {
        self.owner.region.lease_held = false;
        self.owner.region.result_len = 0;
        self.owner.region.elapsed = None;
        if (self.owner.session.is_some() || self.owner.request_writer_present())
            && self.owner.stop_and_reap().is_err()
        {
            self.owner.region.quarantined = true;
            self.owner.detach_quarantined_resources();
            return;
        }
        self.owner.region.prepared = false;
        self.owner.release_claim_after_retirement();
    }
}

impl CQueryWorkerOwner {
    fn detach_quarantined_resources(&mut self) {
        if !self.region.quarantined
            || (self.workspace.is_none()
                && self.region.claim.is_none()
                && self.region.storage.is_none()
                && self.session.is_none()
                && !self.request_writer_present())
        {
            return;
        }

        let complete_child =
            self.region.claim.is_some() && self.region.storage.is_some() && self.session.is_some();
        let lifecycle = if complete_child {
            self.workspace
                .as_ref()
                .and_then(CQueryWorkspacePin::detach_c_query_quarantine)
        } else {
            None
        };
        if let Some(fence) = lifecycle {
            drop(self.workspace.take());
            self.forget_detached_child(DetachedCQueryLifecycle::Quarantine { _fence: fence });
            return;
        }

        if complete_child {
            if let Some(workspace) = self.workspace.take() {
                match workspace.into_fallback_participant() {
                    Ok(participant) => {
                        self.forget_detached_child(DetachedCQueryLifecycle::Participant {
                            _participant: participant,
                        });
                        return;
                    }
                    Err(workspace) => self.workspace = Some(workspace),
                }
            }
        }

        // Ambiguous, released or uncounted participant, marker/fence winner,
        // poisoned lifecycle lock, or any missing child resource: preserve the
        // available lifecycle pin and every child resource fail-closed.
        if let Some(workspace) = self.workspace.take() {
            std::mem::forget(workspace);
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
        #[cfg(any(not(target_os = "linux"), test))]
        if let Some(writer) = self.request_writer.take() {
            std::mem::forget(writer);
        }
    }

    fn forget_detached_child(&mut self, lifecycle: DetachedCQueryLifecycle) {
        std::mem::forget(DetachedCQueryOwner {
            _lifecycle: lifecycle,
            _claim: self.region.claim.take(),
            _storage: self.region.storage.take(),
            _session: self.session.take(),
            #[cfg(any(not(target_os = "linux"), test))]
            _request_writer: self.request_writer.take(),
        });
        #[cfg(test)]
        {
            self.test_quarantine_detached = true;
        }
    }

    fn release_claim_after_retirement(&mut self) {
        if self.region.lease_held || self.session.is_some() || self.request_writer_present() {
            return;
        }
        drop(self.workspace.take());
        if let Some(claim) = self.region.claim.take() {
            claim.release();
        }
        // The reservation owns the permit and is released after claim retirement.
        // `session` can be absent only before spawn or after exit + EOF + reader join.
        drop(self.region.storage.take());
    }
}

impl Drop for CQueryWorkerOwner {
    fn drop(&mut self) {
        if (self.session.is_some() || self.request_writer_present())
            && !self.region.quarantined
            && self.stop_and_reap().is_err()
        {
            self.region.quarantined = true;
        }
        if self.region.lease_held {
            self.region.quarantined = true;
        }
        if self.region.quarantined {
            self.detach_quarantined_resources();
        } else {
            self.release_claim_after_retirement();
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

fn check_caller_cancellation(cancellation: Option<&AtomicBool>) -> Result<()> {
    ensure!(
        !cancellation.is_some_and(|signal| signal.load(Ordering::Acquire)),
        "NIR1_GRAPH_WORKER_CALLER_CANCELLED"
    );
    Ok(())
}

fn request_len(request: &Nir1GraphRequest) -> Result<usize> {
    // The caller may retain these buffers while holding the result lease.
    let request_capacity = request
        .project_id
        .capacity()
        .checked_add(request.query_scene_id.capacity())
        .and_then(|capacity| capacity.checked_add(request.seed_entity_id.capacity()))
        .ok_or_else(|| anyhow!("NIR1_GRAPH_WORKER_REQUEST_CAPACITY_OVERFLOW"))?;
    ensure!(
        request_capacity <= REQUEST_CAPACITY_BYTES,
        "NIR1_GRAPH_WORKER_REQUEST_CAPACITY_LIMIT"
    );
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

/// The address points into the one-element Native reservation. The active or
/// detached owner keeps that allocation alive until this thread is joined; on
/// unproved cleanup the detached owner deliberately retains it process-wide.
unsafe fn read_worker_pipe(
    mut stdout: impl Read,
    region_ptr: *const NativeRegion,
    reader_timing: &ReaderPublicationTiming,
) {
    // SAFETY: guaranteed by the caller's stable-allocation/quarantine contract.
    let region = unsafe { &*region_ptr };
    if !region.wait_for_parent_thread() {
        drain_to_eof(&mut stdout, region, reader_timing);
        return;
    }

    let mut ready = [0u8; 1];
    if stdout.read_exact(&mut ready).is_err() || ready != *b"R" {
        region.publish(READER_PIPE_ERROR);
        drain_to_eof(&mut stdout, region, reader_timing);
        return;
    }
    region.publish(READER_READY);
    if !region.wait_for_request() {
        drain_to_eof(&mut stdout, region, reader_timing);
        return;
    }

    let len = {
        // SAFETY: the owner has stopped touching bytes before publishing
        // OWNER_REQUEST; the reader exclusively owns the buffer until FRAME.
        let bytes = unsafe { &mut *region.bytes_mut_ptr() };
        if stdout.read_exact(&mut bytes[..4]).is_err() {
            region.publish(READER_FAILED);
            drain_to_eof(&mut stdout, region, reader_timing);
            return;
        }
        u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize
    };
    if !frame_length_allowed(len) {
        region.publish(READER_FRAME_LIMIT);
        drain_to_eof(&mut stdout, region, reader_timing);
        return;
    }
    {
        // SAFETY: the request write completed before OWNER_REQUEST was
        // published; the reader now reuses the same bytes for the result frame.
        // Publishing FRAME below transfers read-only access back to the owner.
        let bytes = unsafe { &mut *region.bytes_mut_ptr() };
        if stdout.read_exact(&mut bytes[..len]).is_err() {
            region.publish(READER_FAILED);
            drain_to_eof(&mut stdout, region, reader_timing);
            return;
        }
    }
    region.mailbox.frame_len.store(len, Ordering::Relaxed);
    region.publish(READER_FRAME);

    let mut marker = [0u8; worker_frame::TERMINAL_SUCCESS_COMMIT.len()];
    if stdout.read_exact(&mut marker).is_err() || marker != *worker_frame::TERMINAL_SUCCESS_COMMIT {
        region.publish(READER_FAILED);
        drain_to_eof(&mut stdout, region, reader_timing);
        return;
    }
    reader_timing.publish(region, READER_COMMIT);

    let mut trailing = [0u8; 1];
    match stdout.read(&mut trailing) {
        Ok(0) => reader_timing.publish(region, READER_EOF),
        Ok(_) => {
            region.publish(READER_TRAILING);
            drain_to_eof(&mut stdout, region, reader_timing);
        }
        Err(_) => region.publish(READER_PIPE_ERROR),
    }
}

fn drain_to_eof(
    stdout: &mut impl Read,
    region: &NativeRegion,
    reader_timing: &ReaderPublicationTiming,
) {
    let mut byte = [0u8; 1];
    loop {
        match stdout.read(&mut byte) {
            Ok(0) => {
                reader_timing.publish(region, READER_EOF);
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
    use std::io::Cursor;

    fn unavailable_test_frame(reason: &str) -> Vec<u8> {
        let mut frame = b"NQG1\0".to_vec();
        for value in ["p", "s", reason] {
            frame.extend_from_slice(&(value.len() as u32).to_le_bytes());
            frame.extend_from_slice(value.as_bytes());
        }
        frame
    }

    fn read_test_wire(suffix: &[u8]) -> usize {
        read_test_frame(&unavailable_test_frame("r"), suffix)
    }

    fn read_test_frame(frame: &[u8], suffix: &[u8]) -> usize {
        read_test_frame_with_timing(frame, suffix).0
    }

    fn read_test_frame_with_timing(
        frame: &[u8],
        suffix: &[u8],
    ) -> (usize, ReaderPublicationStamps) {
        assert!(worker_frame::validate(frame).is_ok());
        let mut wire = vec![b'R'];
        wire.extend_from_slice(&(frame.len() as u32).to_le_bytes());
        wire.extend_from_slice(frame);
        wire.extend_from_slice(suffix);

        let storage = reserve_test_storage().expect("reserve local Native test region");
        let region = &storage[0];
        let timing = ReaderPublicationTiming::default();
        timing.begin_query(Instant::now());
        region.set_parent_thread(thread::current());
        region.request();
        // SAFETY: this test is the only reader and keeps the region alive.
        unsafe { read_worker_pipe(Cursor::new(wire), region as *const NativeRegion, &timing) };
        (
            region.mailbox.events.load(Ordering::Acquire),
            timing.stamps(),
        )
    }

    fn stage_launch_bytes_for_test(
        bytes: &mut [u8],
        project_prefix_len: usize,
        payload_len: usize,
        fill: u8,
    ) -> bool {
        let Some(end) = project_prefix_len.checked_add(payload_len) else {
            return false;
        };
        let Some(staging) = bytes.get_mut(project_prefix_len..end) else {
            return false;
        };
        staging.fill(fill);
        true
    }

    #[test]
    fn post_ready_owner_drops_authority_but_keeps_exact_binding_claim_and_region() -> Result<()> {
        use crate::state::{ActiveWorkspace, WorkspaceState};
        use crate::workspace_lifecycle::{
            AdmissionKind, AdmissionOutcome, LiveBinding, WorkspaceLifecycleCompatibilityView,
        };

        let path = std::env::temp_dir().join(format!(
            "grimodex-c-query-ready-owner-{}",
            uuid::Uuid::new_v4()
        ));
        let db = crate::Database::new(std::path::Path::new(":memory:"))?;
        let authority = WorkspaceAuthority::from_database_for_test(db, path.clone())?;
        let authority_weak = std::sync::Arc::downgrade(&authority);
        let binding = LiveBinding::new(
            authority.path().to_string_lossy().into_owned(),
            format!("test-workspace:{}", authority.identity()),
            authority.identity(),
            0,
        );
        let state = WorkspaceState {
            inner: std::sync::Mutex::new(Some(ActiveWorkspace::new(std::sync::Arc::clone(
                &authority,
            )))),
            safe_mode: crate::recovery::SafeModeState::default(),
            switching: WorkspaceLifecycleCompatibilityView::new(false),
            open_lock: std::sync::Mutex::new(()),
        };
        let core = state.lifecycle_core();
        core.set_ready(binding)?;
        let snapshot = crate::state::active_workspace_snapshot(&state)?;
        let claim = snapshot
            .authority
            .claim_c_query_child()
            .ok_or_else(|| anyhow!("test child claim unavailable"))?;
        let mut owner = CQueryWorkerOwner::new(snapshot, PathBuf::new());
        owner.region.claim = Some(claim);
        owner.region.storage = Some(reserve_storage()?);
        owner
            .region
            .native_region()
            .ok_or_else(|| anyhow!("test Native region unavailable"))?
            .mailbox
            .events
            .fetch_or(READER_READY, Ordering::Release);

        drop(state.inner.lock().expect("workspace lock").take());
        drop(authority);
        owner.release_authority_after_ready()?;

        assert!(authority_weak.upgrade().is_none());
        assert!(owner.check_current_binding().is_ok());
        assert_eq!(core.workspace_participant_count()?, 1);
        assert!(owner
            .region
            .claim
            .as_ref()
            .is_some_and(CQueryChildClaim::is_held_for_test));
        assert!(owner.region.storage.is_some());
        assert!(C_QUERY_CAPACITY_IN_USE.load(Ordering::Acquire));
        assert!(crate::workspace_lease::acquire_exclusive(&path, Duration::ZERO).is_err());

        let ticket = match core
            .begin_transition(AdmissionKind::Open)
            .expect("Open admission")
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { .. } => panic!("Open must wait for the participant"),
        };
        assert!(owner.check_current_binding().is_err());
        assert!(matches!(
            core.physical_exclusive_for_ticket(&ticket),
            Err(crate::workspace_lifecycle::LifecycleError::ActiveOperations)
        ));

        drop(owner);
        assert_eq!(core.workspace_participant_count()?, 0);
        assert!(!C_QUERY_CAPACITY_IN_USE.load(Ordering::Acquire));
        drop(
            core.physical_exclusive_for_ticket(&ticket)
                .expect("retired participant permits transition"),
        );
        drop(
            crate::workspace_lease::acquire_exclusive(&path, Duration::ZERO)
                .expect("retired claim releases its exact file lease"),
        );
        std::fs::remove_dir_all(path)?;
        Ok(())
    }

    #[test]
    fn terminal_commit_requires_exact_marker_and_eof_without_trailing_data() {
        let events = read_test_wire(worker_frame::TERMINAL_SUCCESS_COMMIT);
        assert_ne!(events & READER_FRAME, 0);
        assert_ne!(events & READER_COMMIT, 0);
        assert_ne!(events & READER_EOF, 0);
        assert!(result_wire_complete(events));

        assert!(!result_wire_complete(READER_FRAME | READER_EOF));
        assert!(!result_wire_complete(READER_FRAME | READER_COMMIT));
        assert!(!result_wire_complete(
            READER_FRAME | READER_COMMIT | READER_EOF | READER_FAILED
        ));
    }

    #[test]
    fn reader_publication_timestamps_capture_commit_then_eof() {
        let (_, stamps) = read_test_frame_with_timing(
            &unavailable_test_frame("r"),
            worker_frame::TERMINAL_SUCCESS_COMMIT,
        );
        assert!(matches!(
            (stamps.commit, stamps.eof),
            (Some(commit), Some(eof)) if commit <= eof
        ));
        let mut phases = QueryPhaseDiagnostics::default();
        phases.observe_publications(stamps);
        assert_eq!(phases.reader_commit_published_at, stamps.commit);
        assert_eq!(phases.reader_eof_published_at, stamps.eof);
    }

    #[test]
    fn parent_event_diagnostics_keep_the_first_observation() {
        let first = Duration::from_micros(6);
        let second = Duration::from_micros(7);
        let mut phases = QueryPhaseDiagnostics::default();
        phases.observe_events(READER_COMMIT, first);
        phases.observe_events(READER_COMMIT | READER_EOF, second);
        phases.observe_events(READER_EOF, Duration::from_micros(8));
        assert_eq!(phases.parent_commit_observed_at, Some(first));
        assert_eq!(phases.parent_eof_observed_at, Some(second));
    }

    #[test]
    fn terminal_commit_rejects_missing_partial_wrong_and_trailing_bytes() {
        let marker = worker_frame::TERMINAL_SUCCESS_COMMIT;
        let wrong_marker = [0u8; 5];
        for suffix in [&[][..], &marker[..marker.len() - 1], &wrong_marker[..]] {
            let events = read_test_wire(suffix);
            assert_ne!(events & READER_FAILED, 0);
            assert_eq!(events & READER_COMMIT, 0);
            assert_ne!(events & READER_EOF, 0);
            assert!(!result_wire_complete(events));
        }

        let mut extra = marker.to_vec();
        extra.push(0xA5);
        let events = read_test_wire(&extra);
        assert_ne!(events & READER_COMMIT, 0);
        assert_ne!(events & READER_TRAILING, 0);
        assert_ne!(events & READER_EOF, 0);
        assert!(!result_wire_complete(events));

        let marker_in_payload = worker_frame::TERMINAL_SUCCESS_COMMIT;
        let events = read_test_frame(
            &unavailable_test_frame(std::str::from_utf8(marker_in_payload).unwrap()),
            &[],
        );
        assert_ne!(events & READER_FAILED, 0);
        assert_eq!(events & READER_COMMIT, 0);
        assert_ne!(events & READER_EOF, 0);
    }

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

    #[cfg(feature = "nir1-c-query-test-seam")]
    #[test]
    fn startup_failure_receipt_is_bounded_and_keeps_stage_classification() {
        let stage = b"NIR1_C_QUERY_REG_NOMEM:SEMANTIC_INDEX\n";
        let receipt = b"NIR1_C_QUERY_SQLITE_ALLOC_FAILURE:v1;kind=xRealloc;requested=8192;old=4096;claimed=1572600;available=32\n";
        let mut stderr = stage.to_vec();
        stderr.extend_from_slice(receipt);
        let error = startup_exit_error_from_bytes(&stderr).to_string();
        assert!(error.contains("NIR1_C_QUERY_REG_NOMEM:SEMANTIC_INDEX"));
        assert!(error.contains("kind=xRealloc;requested=8192;old=4096"));
        assert!(error.contains("claimed=1572600;available=32"));

        let invalid_receipts: [&[u8]; 4] = [
            b"NIR1_C_QUERY_SQLITE_ALLOC_FAILURE:v1;kind=xFree;requested=8;old=0;claimed=10;available=2\n",
            b"NIR1_C_QUERY_SQLITE_ALLOC_FAILURE:v1;kind=xMalloc;requested=8;old=1;claimed=10;available=2\n",
            b"NIR1_C_QUERY_SQLITE_ALLOC_FAILURE:v1;kind=xMalloc;requested=8;old=0;claimed=10;available=11\n",
            b"NIR1_C_QUERY_SQLITE_ALLOC_FAILURE:v1;kind=xRealloc;requested=8;old=0;claimed=10;available=2;data=secret\n",
        ];
        for invalid in invalid_receipts {
            let mut stderr = stage.to_vec();
            stderr.extend_from_slice(invalid);
            let error = startup_exit_error_from_bytes(&stderr).to_string();
            assert!(error.contains("NIR1_C_QUERY_REG_NOMEM:SEMANTIC_INDEX"));
            assert!(!error.contains("data=secret"));
        }
        assert!(parse_sqlite_allocation_failure_receipt(&vec![
            b'0';
            SQLITE_FAILURE_RECEIPT_LINE_BYTES
                + 1
        ])
        .is_none());
    }

    #[test]
    fn reader_reuses_request_bytes_after_release_handoff() -> Result<()> {
        const LAUNCH_STAGING_BYTES: usize = 16_384;
        let request = Nir1GraphRequest {
            project_id: "p".into(),
            query_scene_id: "s".into(),
            seed_entity_id: "e".into(),
        };
        let request_len = request_len(&request)?;
        let project_prefix = request.project_id.as_bytes();
        let stage_end = project_prefix.len() + LAUNCH_STAGING_BYTES;
        let frame = unavailable_test_frame("r");
        let mut wire = vec![b'R'];
        wire.extend_from_slice(&(frame.len() as u32).to_le_bytes());
        wire.extend_from_slice(&frame);
        wire.extend_from_slice(worker_frame::TERMINAL_SUCCESS_COMMIT);

        let storage = reserve_test_storage()?;
        let native = &storage[0];
        // SAFETY: no reader exists; this test exclusively owns the region.
        unsafe {
            let bytes = &mut *native.bytes_mut_ptr();
            bytes.fill(0xCC);
            bytes[..project_prefix.len()].copy_from_slice(project_prefix);
            assert!(stage_launch_bytes_for_test(
                bytes,
                project_prefix.len(),
                LAUNCH_STAGING_BYTES,
                0xA5,
            ));
            assert_eq!(&bytes[..project_prefix.len()], project_prefix);
            assert!(bytes[project_prefix.len()..stage_end]
                .iter()
                .all(|byte| *byte == 0xA5));

            // The checked refusal must leave every in-slice byte untouched.
            assert!(!stage_launch_bytes_for_test(
                bytes,
                project_prefix.len(),
                STORAGE_BYTES,
                0x5A,
            ));
            assert_eq!(&bytes[..project_prefix.len()], project_prefix);
            assert!(bytes[project_prefix.len()..stage_end]
                .iter()
                .all(|byte| *byte == 0xA5));
            assert!(bytes[stage_end..].iter().all(|byte| *byte == 0xCC));
        }

        native.set_parent_thread(thread::current());
        let reader_region = NativeRegionPtr {
            region: native as *const NativeRegion,
            reader_timing: ReaderPublicationTiming::default(),
        };
        let reader = thread::Builder::new().spawn(move || {
            // SAFETY: the test retains `storage` until this thread is joined.
            unsafe { reader_region.read_test_pipe(Cursor::new(wire)) };
        })?;

        let ready_deadline = Instant::now() + Duration::from_secs(5);
        let mut reader_ready = false;
        while Instant::now() < ready_deadline {
            if native.mailbox.events.load(Ordering::Acquire) & READER_READY != 0 {
                reader_ready = true;
                break;
            }
            thread::park_timeout(POLL_INTERVAL);
        }

        // The reader is waiting for OWNER_REQUEST and has not touched bytes.
        // Release staging before encoding and publishing the request handoff.
        let (
            owner_request_unpublished,
            prefix_preserved,
            staging_preserved,
            staging_released_before_handoff,
            prefix_before_encode,
            encoded_len,
            encoded,
        ) = unsafe {
            let bytes = &mut *native.bytes_mut_ptr();
            let owner_request_unpublished =
                native.mailbox.events.load(Ordering::Acquire) & OWNER_REQUEST == 0;
            let prefix_preserved = &bytes[..project_prefix.len()] == project_prefix;
            let staging_preserved = bytes[project_prefix.len()..stage_end]
                .iter()
                .all(|byte| *byte == 0xA5);
            bytes[project_prefix.len()..stage_end].fill(0);
            let staging_released_before_handoff = bytes[project_prefix.len()..stage_end]
                .iter()
                .all(|byte| *byte == 0)
                && native.mailbox.events.load(Ordering::Acquire) & OWNER_REQUEST == 0;
            let prefix_before_encode = &bytes[..project_prefix.len()] == project_prefix;
            let encoded = encode_request(&request, &mut bytes[..REQUEST_BYTES]);
            let encoded_len = u16::from_le_bytes([bytes[0], bytes[1]]) as usize + 2;
            (
                owner_request_unpublished,
                prefix_preserved,
                staging_preserved,
                staging_released_before_handoff,
                prefix_before_encode,
                encoded_len,
                encoded,
            )
        };
        native.request();
        reader.thread().unpark();
        let joined = reader.join();

        assert!(reader_ready, "reader must publish READY before handoff");
        assert!(joined.is_ok(), "reader thread must join successfully");
        assert!(owner_request_unpublished);
        assert!(prefix_preserved);
        assert!(staging_preserved);
        assert!(staging_released_before_handoff);
        assert!(prefix_before_encode);
        encoded?;
        assert_eq!(encoded_len, request_len);

        let events = native.mailbox.events.load(Ordering::Acquire);
        assert!(result_wire_complete(events));
        assert_eq!(
            native.mailbox.frame_len.load(Ordering::Relaxed),
            frame.len()
        );
        // SAFETY: the reader has been joined, so the owner exclusively reads bytes.
        let bytes = unsafe { native.bytes() };
        assert_eq!(&bytes[..frame.len()], frame.as_slice());
        let view = worker_frame::validate(&bytes[..frame.len()])?;
        assert_eq!(view.project, request.project_id);
        assert_eq!(view.scene, request.query_scene_id);
        Ok(())
    }

    #[test]
    fn native_static_slot_is_exclusive_and_resets_after_retirement() -> Result<()> {
        let first = reserve_storage()?;
        let region = first.region();
        let address = region as *const NativeRegion;
        // SAFETY: this test owns the process reservation and has no reader.
        unsafe { (&mut *region.bytes_mut_ptr())[0] = 0xA5 };
        region.mailbox.frame_len.store(17, Ordering::Relaxed);
        region.set_parent_thread(thread::current());

        assert!(reserve_storage().is_err());
        assert_eq!(region.mailbox.frame_len.load(Ordering::Relaxed), 17);
        // SAFETY: this test owns the process reservation and has no reader.
        assert_eq!(unsafe { region.bytes() }[0], 0xA5);
        drop(first);

        let second = reserve_storage()?;
        let region = second.region();
        assert_eq!(address, region as *const NativeRegion);
        assert_eq!(region.mailbox.events.load(Ordering::Acquire), 0);
        assert_eq!(region.mailbox.frame_len.load(Ordering::Relaxed), 0);
        // SAFETY: the exclusive reservation permits retiring the prior handle.
        assert!(unsafe { (&*region.mailbox.parent_thread.get()).is_none() });
        // SAFETY: this test owns the process reservation and has no reader.
        assert_eq!(unsafe { region.bytes() }[0], 0);
        drop(second);
        Ok(())
    }

    #[test]
    fn native_region_bounds_request_and_frame() -> Result<()> {
        assert!(frame_length_allowed(FRAME_BYTES));
        assert!(!frame_length_allowed(FRAME_BYTES + 1));
        assert!(!frame_length_allowed(0));

        let request = Nir1GraphRequest {
            project_id: "p".repeat(REQUEST_BYTES - 10),
            query_scene_id: "s".into(),
            seed_entity_id: "e".into(),
        };
        assert_eq!(request_len(&request)?, REQUEST_BYTES);
        let mut capacity_at_limit = String::with_capacity(REQUEST_CAPACITY_BYTES - 2);
        capacity_at_limit.push('p');
        let request_at_capacity_limit = Nir1GraphRequest {
            project_id: capacity_at_limit,
            query_scene_id: "s".into(),
            seed_entity_id: "e".into(),
        };
        assert_eq!(
            request_at_capacity_limit.project_id.capacity()
                + request_at_capacity_limit.query_scene_id.capacity()
                + request_at_capacity_limit.seed_entity_id.capacity(),
            REQUEST_CAPACITY_BYTES
        );
        assert!(request_len(&request_at_capacity_limit).is_ok());
        let mut oversized_capacity = String::with_capacity(REQUEST_CAPACITY_BYTES + 1);
        oversized_capacity.push('p');
        let oversized_capacity_request = Nir1GraphRequest {
            project_id: oversized_capacity,
            query_scene_id: "s".into(),
            seed_entity_id: "e".into(),
        };
        let error = request_len(&oversized_capacity_request)
            .expect_err("request backing capacity above the reserved allowance must be rejected");
        assert!(error
            .to_string()
            .contains("NIR1_GRAPH_WORKER_REQUEST_CAPACITY_LIMIT"));
        let storage = reserve_test_storage()?;
        assert_eq!(storage.len(), 1);
        assert_eq!(storage.capacity(), 1);
        let native = &storage[0];
        // The frame backing is the same size as before; request bytes overlay it.
        assert_eq!(STORAGE_BYTES, FRAME_BYTES);
        native.set_parent_thread(thread::current());
        native.mailbox.frame_len.store(17, Ordering::Relaxed);
        native.publish(READER_FRAME);
        native.publish(READER_EOF);
        let events = native.mailbox.events.load(Ordering::Acquire);
        assert_eq!(native.mailbox.frame_len.load(Ordering::Relaxed), 17);
        assert_ne!(events & READER_FRAME, 0);
        assert_ne!(events & READER_EOF, 0);
        // SAFETY: no reader thread is active in this test.
        let bytes = unsafe { &mut *native.bytes_mut_ptr() };
        encode_request(&request, &mut bytes[..REQUEST_BYTES])?;
        assert_eq!(
            u16::from_le_bytes([bytes[0], bytes[1]]) as usize + 2,
            REQUEST_BYTES
        );
        assert_eq!(bytes.len(), FRAME_BYTES);
        let mut over_project = String::with_capacity(REQUEST_BYTES - 9);
        over_project.push_str(&request.project_id);
        over_project.push('p');
        let over = Nir1GraphRequest {
            project_id: over_project,
            query_scene_id: "s".into(),
            seed_entity_id: "e".into(),
        };
        let error = request_len(&over).expect_err("N+1 request must exceed its region");
        assert!(error
            .to_string()
            .contains("NIR1_GRAPH_WORKER_REQUEST_LIMIT"));
        Ok(())
    }
}
