use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, MutexGuard,
    },
};

use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::{
    super::{
        nir1_entity_relation_index::{GraphWorkControl, GraphWorkStage},
        retrieval_admission::build::BuildCandidate,
    },
    binding::StoredBinding,
    ChronicleReaderError, NirEmbeddingIdentity, NirIndexUnavailableReason,
};
use crate::{read_sqlite_source_revision, workspace_lifecycle::WorkspaceParticipant, Database};

pub struct NirChronicleIndexRuntime {
    owner: u64,
    connection_epoch: Option<String>,
    cancellation_epoch: Arc<AtomicU64>,
    state: Mutex<RuntimeState>,
    /// DR-IRB-3 (E13): one dedicated-reader slot per authority. Process-local.
    reader_slot: Arc<AtomicUsize>,
    /// Set when a reader's close was not proven: the slot is then never given
    /// back (E8 (a)) and callers can tell it from a slot merely in use.
    reader_slot_blocked: Arc<std::sync::atomic::AtomicBool>,
}

/// DR-IRB-3: the process-local capability that lets one dedicated reader
/// prepare an index build. It is minted only inside the authority's read
/// transaction (`chronicle_reader_admission`), carries the admitted runtime
/// owner/epoch and the exact main database file the authority has open, and
/// is opaque to callers: they can only pass it back.
#[derive(Debug)]
pub struct ChronicleReaderAdmission {
    pub(crate) owner: u64,
    pub(crate) runtime_epoch: u64,
    /// The project this admission was made for. A prepare for another project
    /// would take this admission's proof verdict for its own.
    pub(crate) project: String,
    pub(crate) target: ChronicleReaderTarget,
    pub(crate) proof_current: bool,
}

#[derive(Debug)]
pub(crate) enum ChronicleReaderTarget {
    File {
        path: std::path::PathBuf,
        identity: String,
    },
    /// In-memory or unnamed main database: a second connection cannot see it.
    Unsupported,
}

impl ChronicleReaderAdmission {
    /// A usable proof already exists: no preparation (and no reader) is needed.
    pub fn already_usable(&self) -> bool {
        self.proof_current
    }

    /// Whether a dedicated reader can be opened for this authority. `false`
    /// must become a typed stop, never a silent fallback.
    pub fn reader_available(&self) -> bool {
        matches!(self.target, ChronicleReaderTarget::File { .. })
    }
}

/// The scheduling verdict of `chronicle_reader_admission`, mirroring
/// `rebuild_requested` (`Some(false)` / `None` / `Some(true)`).
#[derive(Debug)]
pub enum ChronicleReaderAdmissionRead {
    Idle,
    Stopped,
    Admitted(ChronicleReaderAdmission),
}

/// The right to open this authority's single reader (E13). Until a reader
/// connection is actually open, dropping the permit gives the slot back, so an
/// early return or an error between taking it and opening a reader cannot
/// block the authority. `with_chronicle_reader` turns it into an
/// `OpenReaderSlot` once the connection is open; from then on only a proven
/// close gives the slot back (E5/E8 (a)).
#[must_use]
#[derive(Debug)]
pub struct ReaderPermit {
    slot: Arc<AtomicUsize>,
    blocked: Arc<std::sync::atomic::AtomicBool>,
    armed: bool,
}

impl ReaderPermit {
    /// Give the slot back explicitly (the same as dropping the permit).
    pub fn release_unused(self) {}

    fn into_open_slot(mut self) -> OpenReaderSlot {
        self.armed = false;
        OpenReaderSlot {
            slot: Arc::clone(&self.slot),
            blocked: Arc::clone(&self.blocked),
            consumed: false,
        }
    }
}

impl Drop for ReaderPermit {
    fn drop(&mut self) {
        if self.armed {
            self.slot.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// A slot held by a reader connection that is open or being opened. It is
/// consumed explicitly: given back after close evidence
/// (`release_with_close_evidence`) or kept and marked blocked after a failed
/// verdict (`block_reader_slot`). If it is dropped without either (a panic
/// before the close verdict, including inside the open itself), the close was
/// never judged, so the slot stays taken and `Drop` marks it blocked (E8 (a),
/// fail-closed). A drop is never close evidence.
struct OpenReaderSlot {
    slot: Arc<AtomicUsize>,
    blocked: Arc<std::sync::atomic::AtomicBool>,
    consumed: bool,
}

impl Drop for OpenReaderSlot {
    fn drop(&mut self) {
        if !self.consumed {
            self.blocked.store(true, Ordering::SeqCst);
        }
    }
}

pub(super) struct RuntimeState {
    pub epoch: u64,
    embedding_generation: Option<u64>,
    active: bool,
    stopped: bool,
    pub proofs: HashMap<String, Arc<IndexProof>>,
}

pub(super) struct IndexProof {
    pub validated_read: Mutex<Option<super::read_identity::ReadIdentity>>,
    /// DR-CP4-V-1 (P2): query contexts this proof's validation read, each
    /// reusable only for the exact same committed connection state, project
    /// and Scene (`query.rs`, `validated_query_context`). Process-local; never
    /// durable. Entries of an older state are dropped when a newer one is kept.
    pub validated_query_contexts: Mutex<Vec<ValidatedQueryContext>>,
    pub project: String,
    pub runtime_epoch: u64,
    pub binding: StoredBinding,
    pub semantic_epoch: String,
    pub language: String,
    pub candidates: Vec<IndexedCandidate>,
    pub model: Option<NirEmbeddingIdentity>,
    pub input_edges: Vec<super::super::dependency_edges::DependencyEdge>,
}

/// One query context read inside a Read transaction whose identity was the
/// same before and after the read (the `validated_read` rule).
pub(super) struct ValidatedQueryContext {
    pub identity: super::read_identity::ReadIdentity,
    pub project: String,
    pub scene: String,
    pub context: Arc<super::super::retrieval_admission::RetrievalQueryContext>,
}

pub(super) struct IndexedCandidate {
    pub verified: BuildCandidate,
    pub embedding: Option<Vec<u8>>,
    pub evidence: Vec<super::evidence::VerifiedEvidence>,
}

impl NirChronicleIndexRuntime {
    /// A scheduling hint, never a Freshness verdict or query capability.
    /// Complete admission and conditional publication remain mandatory.
    pub fn rebuild_requested(&self, conn: &Connection, project: &str) -> Result<Option<bool>> {
        anyhow::ensure!(
            !conn.is_autocommit(),
            "NIR1 rebuild hint requires a transaction"
        );
        if self.current_epoch(conn)?.is_err() {
            return Ok(None);
        }
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
            [project],
            |r| r.get(0),
        )?;
        if !exists {
            return Ok(None);
        }
        let row=conn.query_row("SELECT m.generation,m.dirty_cache_flag,m.source_digest,m.dependency_set_digest,
            m.producer_id,m.producer_version,f.evidence_freshness,f.build_action,f.semantic_epoch_id
            FROM narrative_semantic_index_metadata m LEFT JOIN narrative_consumer_freshness f
            ON f.project_id=m.project_id AND f.consumer_kind='semantic-index' AND f.consumer_key=m.index_key
            WHERE m.project_id=?1 AND m.index_key=?2",params![project,super::INDEX_KEY],|r|Ok((
                r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?,
                r.get::<_,Option<String>>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,Option<String>>(6)?,
                r.get::<_,Option<String>>(7)?,r.get::<_,Option<String>>(8)?))).optional()?;
        let Some((generation, dirty, source, d1, producer, version, freshness, action, epoch)) =
            row
        else {
            return Ok(Some(true));
        };
        if producer.as_deref() != Some(super::PRODUCER_ID)
            || version.as_deref() != Some(super::PRODUCER_VERSION)
        {
            return Ok(None);
        }
        let current_epoch = super::super::semantic_epoch::get_current_epoch(conn, project)?;
        let state = self.lock()?;
        let unchanged = state.proofs.get(project).is_some_and(|proof| {
            dirty == 0
                && generation == proof.binding.generation
                && source.as_deref() == Some(proof.binding.source_digest.as_str())
                && d1.as_deref() == Some(proof.binding.dependency_set_digest.as_str())
                && freshness.as_deref() == Some("fresh")
                && action.as_deref() == Some("none")
                && epoch.as_deref() == Some(proof.semantic_epoch.as_str())
                && current_epoch
                    .as_ref()
                    .is_some_and(|epoch| epoch.id == proof.semantic_epoch)
        });
        Ok(Some(!unchanged))
    }

    // WorkspaceAuthority is the only production constructor. A connection
    // metadata failure starts unavailable and cannot bind to another DB later.
    pub(crate) fn new(db: &Database, owner: u64) -> Self {
        let connection_epoch = db
            .with_conn(|conn| Ok(read_sqlite_source_revision(conn)?.connection_epoch))
            .ok();
        Self {
            owner,
            connection_epoch,
            cancellation_epoch: Arc::new(AtomicU64::new(1)),
            reader_slot: Arc::new(AtomicUsize::new(0)),
            reader_slot_blocked: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            state: Mutex::new(RuntimeState {
                epoch: 1,
                embedding_generation: None,
                active: true,
                stopped: false,
                proofs: HashMap::new(),
            }),
        }
    }

    pub(super) fn lock(&self) -> Result<MutexGuard<'_, RuntimeState>> {
        self.state
            .lock()
            .map_err(|_| anyhow!("NIR1 runtime lock poisoned"))
    }

    pub(super) fn current_epoch(
        &self,
        conn: &Connection,
    ) -> Result<std::result::Result<u64, NirIndexUnavailableReason>> {
        if self.connection_epoch.as_deref()
            != Some(read_sqlite_source_revision(conn)?.connection_epoch.as_str())
        {
            return Ok(Err(NirIndexUnavailableReason::ConnectionChanged));
        }
        let state = self.lock()?;
        Ok(if state.active && !state.stopped {
            Ok(state.epoch)
        } else {
            Err(NirIndexUnavailableReason::RuntimeUnavailable)
        })
    }

    /// Admit a native index build through the same workspace-bound runtime
    /// owner and cancellation epoch used by the Chronicle producer. The
    /// returned pair is intentionally opaque to callers: it is only a
    /// process-local capability for a later publication recheck.
    pub(crate) fn admit_native_build(&self, conn: &Connection) -> Result<Option<(u64, u64)>> {
        Ok(match self.current_epoch(conn)? {
            Ok(epoch) => Some((self.owner, epoch)),
            Err(_) => None,
        })
    }

    /// Revalidate a previously admitted native build at the publication
    /// boundary. Pause/resume, stop, workspace replacement and embedding
    /// runtime replacement all rotate or invalidate this owner/epoch pair.
    pub(crate) fn native_build_is_current(
        &self,
        conn: &Connection,
        owner: u64,
        epoch: u64,
    ) -> Result<bool> {
        Ok(self.owner == owner && self.current_epoch(conn)? == Ok(epoch))
    }

    /// A read-only callback-safe view of the same epoch used by native build
    /// admission.  SQLite's progress handler cannot call back into the
    /// connection, so the scan compares this atomic signal every 1,000 VM
    /// steps while the normal connection-bound check remains the publication
    /// authority.
    pub(crate) fn native_build_cancellation_epoch(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.cancellation_epoch)
    }

    /// Dedicated readers share the workspace runtime epoch, while keeping
    /// their own connection-local committed-state identity.
    pub(crate) fn native_reader_epoch(&self) -> Result<Option<u64>> {
        let state = match self.state.try_lock() {
            Ok(state) => state,
            Err(std::sync::TryLockError::WouldBlock) => return Ok(None),
            Err(std::sync::TryLockError::Poisoned(_)) => anyhow::bail!("NIR1 runtime lock poisoned"),
        };
        Ok((state.active && !state.stopped).then_some(state.epoch))
    }

    pub(super) fn owner(&self) -> u64 {
        self.owner
    }

    /// DR-IRB-3: run inside the authority's read transaction in place of
    /// `rebuild_requested`. Same verdict, and for `Some(true)` it also admits
    /// the build (owner/epoch), reads the main database file from this very
    /// connection (never through `WorkspaceAuthority::main_database_file_identity`,
    /// which re-enters the connection mutex this transaction already holds)
    /// and decides whether a usable proof already exists.
    pub fn chronicle_reader_admission(
        &self,
        conn: &Connection,
        project: &str,
        control: &mut dyn GraphWorkControl,
    ) -> Result<ChronicleReaderAdmissionRead> {
        match self.rebuild_requested(conn, project)? {
            Some(false) => return Ok(ChronicleReaderAdmissionRead::Idle),
            None => return Ok(ChronicleReaderAdmissionRead::Stopped),
            Some(true) => {}
        }
        control.check(GraphWorkStage::Source)?;
        let Some((owner, runtime_epoch)) = self.admit_native_build(conn)? else {
            return Ok(ChronicleReaderAdmissionRead::Stopped);
        };
        let proof_current =
            super::query::current_proof_with_control(conn, self, project, control)?.is_some();
        let path = crate::narrative_extraction::sqlite_database_path_in_tx(conn)?;
        let target = if path.trim().is_empty() || path == ":memory:" {
            ChronicleReaderTarget::Unsupported
        } else {
            ChronicleReaderTarget::File {
                identity: crate::narrative_extraction::sqlite_database_file_identity_in_tx(conn)?,
                path: path.into(),
            }
        };
        Ok(ChronicleReaderAdmissionRead::Admitted(
            ChronicleReaderAdmission {
                owner,
                runtime_epoch,
                project: project.to_owned(),
                target,
                proof_current,
            },
        ))
    }

    /// DR-IRB-3 (E13): take this authority's single reader slot, or `None`.
    pub fn try_acquire_reader_permit(&self) -> Option<ReaderPermit> {
        // A blocked slot never comes back, even if its reader has since ended
        // (a forced reader's late close is not evidence the waiter relied on).
        if self.reader_slot_blocked.load(Ordering::SeqCst) {
            return None;
        }
        self.reader_slot
            .compare_exchange(0, 1, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| ReaderPermit {
                slot: Arc::clone(&self.reader_slot),
                blocked: Arc::clone(&self.reader_slot_blocked),
                armed: true,
            })
    }

    /// `true` once a reader's close was not proven. The slot is then taken
    /// for good (fail-closed, E8 (a)): a caller that finds no permit can tell
    /// this permanent state from a reader that is merely in use.
    pub fn chronicle_reader_slot_blocked(&self) -> bool {
        self.reader_slot_blocked.load(Ordering::SeqCst)
    }

    /// Give the slot back after the reader's `sqlite3_close` was proven.
    fn release_with_close_evidence(&self, mut open: OpenReaderSlot) {
        debug_assert!(Arc::ptr_eq(&open.slot, &self.reader_slot));
        open.consumed = true;
        open.slot.fetch_sub(1, Ordering::SeqCst);
    }

    /// The reader's close was not proven: keep the slot taken and say so.
    fn block_reader_slot(&self, mut open: OpenReaderSlot) {
        debug_assert!(Arc::ptr_eq(&open.slot, &self.reader_slot));
        open.consumed = true;
        self.reader_slot_blocked.store(true, Ordering::SeqCst);
    }

    /// Test fixture for other crates: leave the slot as an unproven close
    /// would (taken for good and marked blocked).
    #[cfg(any(test, feature = "workspace-maintenance-test-support"))]
    #[doc(hidden)]
    pub fn block_chronicle_reader_slot_for_test(&self) {
        let permit = self
            .try_acquire_reader_permit()
            .expect("reader slot free for the test fixture");
        self.block_reader_slot(permit.into_open_slot());
    }

    /// Number of permits currently held (readers possibly open). Exposed only
    /// for cross-crate deterministic tests.
    #[doc(hidden)]
    pub fn live_chronicle_readers(&self) -> usize {
        self.reader_slot.load(Ordering::SeqCst)
    }

    /// DR-IRB-3: run `operation` on a dedicated read-only connection.
    ///
    /// The permit comes from `try_acquire_reader_permit`; this method owns it
    /// from here on. The reader is opened on exactly the file the admission
    /// names, read under the participant's scope, then explicitly closed; the
    /// permit returns only when that close is proven. A panic inside
    /// `operation` is handled the same way before it is resumed.
    pub fn with_chronicle_reader<T>(
        &self,
        permit: ReaderPermit,
        admission: &ChronicleReaderAdmission,
        participant: &WorkspaceParticipant,
        operation: impl FnOnce(&Connection) -> Result<T>,
    ) -> Result<T> {
        // Before the open starts, dropping the permit (also by unwinding)
        // gives the slot back.
        if !Arc::ptr_eq(&permit.slot, &self.reader_slot) || admission.owner != self.owner {
            anyhow::bail!("NIR1 chronicle reader admission belongs to another runtime");
        }
        let open_started = std::time::Instant::now();
        // From here a connection may exist without a close verdict, so the
        // slot is held as an `OpenReaderSlot`: a panic inside the open (where
        // the connection's own `Drop` swallows a failed close) leaves it
        // unconsumed and blocks the slot instead of giving it back.
        let open_slot = permit.into_open_slot();
        let reader = match Database::open_chronicle_reader(admission) {
            Ok(reader) => reader,
            Err(error) => {
                if matches!(
                    error.downcast_ref::<ChronicleReaderError>(),
                    Some(ChronicleReaderError::CloseUnproven(_))
                ) {
                    // A connection was opened and could not be closed.
                    tracing::error!(%error, "NIR1 chronicle reader close unproven; reader slot kept");
                    self.block_reader_slot(open_slot);
                } else {
                    // Every other open error closed (or never opened) the
                    // connection: the open path proves that before returning.
                    self.release_with_close_evidence(open_slot);
                }
                return Err(error);
            }
        };
        tracing::debug!(target:"grimodex::nir1_index",
            reader_open_ms=open_started.elapsed().as_millis(),"NIR1 chronicle reader opened");
        let cancellation = (
            self.native_build_cancellation_epoch(),
            admission.runtime_epoch,
        );
        // E7: the reader is registered with the participant's lifecycle core
        // while it is open, so a waiting side whose bounded wait passed can
        // force it out of the participant count and block this slot.
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _hold = participant.register_reader_hold(
            self.owner,
            Arc::clone(&stop),
            Arc::clone(&self.reader_slot_blocked),
        );
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            reader.with_participant_chronicle_reader_stoppable(
                participant,
                cancellation,
                stop,
                operation,
            )
        }));
        match outcome {
            Ok(result) => {
                let unproven = matches!(
                    result
                        .as_ref()
                        .err()
                        .and_then(|error| error.downcast_ref::<ChronicleReaderError>()),
                    Some(ChronicleReaderError::CloseUnproven(_))
                );
                if unproven {
                    tracing::error!("NIR1 chronicle reader close unproven; reader slot kept");
                    self.block_reader_slot(open_slot);
                } else if self.reader_slot_blocked.load(Ordering::SeqCst) {
                    // E7: the waiting side forced this reader out. The close
                    // is proven now, but the slot stays blocked: the forced
                    // state was published before this evidence existed.
                    self.block_reader_slot(open_slot);
                } else {
                    self.release_with_close_evidence(open_slot);
                }
                result
            }
            Err(payload) => {
                // The scope already retired the reader before unwinding.
                // Re-prove it (retiring twice is harmless) before the slot
                // is given back.
                match reader.prove_chronicle_reader_closed() {
                    Ok(()) if self.reader_slot_blocked.load(Ordering::SeqCst) => {
                        self.block_reader_slot(open_slot)
                    }
                    Ok(()) => self.release_with_close_evidence(open_slot),
                    Err(error) => {
                        tracing::error!(%error, "NIR1 chronicle reader close unproven after panic; reader slot kept");
                        self.block_reader_slot(open_slot);
                    }
                }
                std::panic::resume_unwind(payload)
            }
        }
    }

    /// The shell supplies its actual pinned SemanticRuntime generation, never
    /// a renderer field. A late request cannot roll this binding backwards.
    pub fn bind_embedding_generation(&self, generation: u64) -> Result<()> {
        anyhow::ensure!(generation > 0, "NIR1 embedding runtime unavailable");
        let mut state = self.lock()?;
        anyhow::ensure!(
            state
                .embedding_generation
                .is_none_or(|old| generation >= old),
            "NIR1 embedding runtime changed"
        );
        if state.embedding_generation != Some(generation) {
            state.epoch = state
                .epoch
                .checked_add(1)
                .ok_or_else(|| anyhow!("NIR1 runtime epoch exhausted"))?;
            self.cancellation_epoch
                .store(state.epoch, Ordering::Release);
            state.proofs.clear();
            state.embedding_generation = Some(generation);
        }
        Ok(())
    }

    /// Returns projects whose old UI operations must be invalidated. No held
    /// proof is reused after either pause or resume, even without a DB write.
    pub fn pause(&self) -> Result<Vec<String>> {
        self.change_state(false, false)
    }
    pub fn resume(&self) -> Result<Vec<String>> {
        self.change_state(true, false)
    }
    pub fn stop(&self) -> Result<Vec<String>> {
        self.change_state(false, true)
    }

    fn change_state(&self, active: bool, stop: bool) -> Result<Vec<String>> {
        let mut state = self.lock()?;
        let mut projects = state.proofs.keys().cloned().collect::<Vec<_>>();
        projects.sort();
        state.epoch = state
            .epoch
            .checked_add(1)
            .ok_or_else(|| anyhow!("NIR1 runtime epoch exhausted"))?;
        self.cancellation_epoch
            .store(state.epoch, Ordering::Release);
        state.proofs.clear();
        state.stopped |= stop;
        state.active = active && !state.stopped;
        Ok(projects)
    }

    pub(super) fn install(&self, epoch: u64, proof: IndexProof) -> Result<bool> {
        let mut state = self.lock()?;
        if !state.active || state.stopped || state.epoch != epoch {
            return Ok(false);
        }
        state.proofs.insert(proof.project.clone(), Arc::new(proof));
        Ok(true)
    }
}
