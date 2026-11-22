//! The Backend of the flow tests: no database, no model.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use grimodex_db::workspace_lifecycle::WorkspaceParticipant;

use crate::chat_ir::basis::{basis_for, Basis};
use crate::chat_ir::flow::{Backend, FirstRead, Prepared, Selection};
use crate::chat_ir::item::IrItem;
use crate::chat_ir::permit::PermitPool;
use crate::chat_ir::request::Request;
use crate::chat_ir::status::ChatIrStatus;
use crate::chat_ir::tail::TailFlush;

pub(crate) type Log = Arc<Mutex<Vec<String>>>;

pub(crate) fn request() -> Request {
    Request {
        query: "a query".into(),
        project_id: "p".into(),
        expected_workspace_path: "/w".into(),
        current_scene_id: "s".into(),
        chronicle_event_ids: Vec::new(),
    }
}

#[derive(Clone)]
pub(crate) struct PendingSpec {
    pub(crate) busy_for: Duration,
    pub(crate) succeed_on_call: Option<usize>,
    /// Set when a flush has been written.
    pub(crate) written: Arc<AtomicBool>,
    /// Counts the calls of `flush_until`.
    pub(crate) calls: Arc<std::sync::atomic::AtomicUsize>,
}

impl PendingSpec {
    pub(crate) fn never(busy_for: Duration) -> Self {
        Self {
            busy_for,
            succeed_on_call: None,
            written: Arc::new(AtomicBool::new(false)),
            calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }

    pub(crate) fn on_call(busy_for: Duration, call: usize) -> Self {
        Self {
            succeed_on_call: Some(call),
            ..Self::never(busy_for)
        }
    }
}

pub(crate) enum PrepareMode {
    Query,
    Cold,
    /// No IR; the terminal records are pending.
    Pending(PendingSpec),
    Panic,
}

pub(crate) struct FakePending {
    spec: PendingSpec,
    log: Log,
    /// Holds a reference that the real pending holds (the pinned database).
    _database: Arc<()>,
}

impl TailFlush for FakePending {
    fn is_empty(&self) -> bool {
        self.spec.written.load(Ordering::SeqCst)
    }

    fn flush_until(&mut self, deadline: Instant) -> anyhow::Result<bool> {
        let call = self.spec.calls.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::sleep(
            self.spec
                .busy_for
                .min(deadline.saturating_duration_since(Instant::now())),
        );
        if self.spec.succeed_on_call == Some(call) {
            self.spec.written.store(true, Ordering::SeqCst);
            return Ok(true);
        }
        Ok(false)
    }
}

impl Drop for FakePending {
    fn drop(&mut self) {
        self.log.lock().unwrap().push("pending dropped".into());
    }
}

pub(crate) struct Fake {
    pub(crate) log: Log,
    pub(crate) first: Result<(), ChatIrStatus>,
    pub(crate) prepare: PrepareMode,
    pub(crate) prepare_sleep: Duration,
    pub(crate) select: Result<Vec<IrItem>, ChatIrStatus>,
    /// What the fake T3 also returns when `select` is `Ok` (S1-A2).
    pub(crate) event_ids: BTreeMap<String, String>,
    pub(crate) excluded: Vec<String>,
    pub(crate) select_sleep: Duration,
    pub(crate) stop: Arc<AtomicBool>,
    pub(crate) identity: u64,
    /// A real participant (shutdown tests): `stop_requested` is then its own.
    pub(crate) participant: Option<WorkspaceParticipant>,
    /// Records, when the backend is dropped, whether the permit is still held.
    pub(crate) pool: Option<Arc<PermitPool>>,
    /// Stands for the pinned database reference (strong count).
    pub(crate) database: Arc<()>,
}

impl Fake {
    pub(crate) fn new() -> Self {
        Self {
            log: Arc::new(Mutex::new(Vec::new())),
            first: Ok(()),
            prepare: PrepareMode::Query,
            prepare_sleep: Duration::ZERO,
            select: Ok(Vec::new()),
            event_ids: BTreeMap::new(),
            excluded: Vec::new(),
            select_sleep: Duration::ZERO,
            stop: Arc::new(AtomicBool::new(false)),
            identity: 1,
            participant: None,
            pool: None,
            database: Arc::new(()),
        }
    }

    pub(crate) fn entries(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }

    fn note(&self, entry: &str) {
        self.log.lock().unwrap().push(entry.to_string());
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        let held = self.pool.as_ref().map_or_else(
            || "unknown".to_string(),
            |pool| pool.in_flight().to_string(),
        );
        self.log
            .lock()
            .unwrap()
            .push(format!("backend dropped (permits held: {held})"));
    }
}

impl Backend for Fake {
    type Snapshot = ();
    type Batch = ();
    type Query = ();
    type Pending = FakePending;

    fn first_read(
        &self,
        _request: &Request,
        _deadline: Instant,
        _probe: Duration,
    ) -> Result<FirstRead<()>, ChatIrStatus> {
        self.note("first_read");
        self.first?;
        Ok(FirstRead {
            basis: basis_for("ja").unwrap().unwrap(),
            snapshot: (),
        })
    }

    fn prepare(
        &self,
        _request: &Request,
        _basis: &Basis,
        _deadline: Instant,
    ) -> Result<Prepared<(), FakePending>, ChatIrStatus> {
        self.note("prepare");
        std::thread::sleep(self.prepare_sleep);
        match &self.prepare {
            PrepareMode::Query => Ok(Prepared::Query(())),
            PrepareMode::Cold => Err(ChatIrStatus::EmbedderCold),
            PrepareMode::Pending(spec) => Ok(Prepared::Unavailable {
                status: ChatIrStatus::Timeout,
                pending: Some(FakePending {
                    spec: spec.clone(),
                    log: Arc::clone(&self.log),
                    _database: Arc::clone(&self.database),
                }),
            }),
            PrepareMode::Panic => panic!("the embedding panicked"),
        }
    }

    fn qualify(
        &self,
        _request: &Request,
        _first: &Basis,
        _snapshot: &(),
        _deadline: Instant,
    ) -> Result<(), ChatIrStatus> {
        self.note("qualify");
        Ok(())
    }

    fn score(
        &self,
        _query: &(),
        _basis: &Basis,
        _batch: &(),
        _deadline: Instant,
    ) -> Result<Vec<f32>, ChatIrStatus> {
        self.note("score");
        Ok(Vec::new())
    }

    fn select(
        &self,
        _request: &Request,
        _first: &Basis,
        _query: &(),
        _batch: &(),
        _scores: Vec<f32>,
        _deadline: Instant,
    ) -> Result<Selection, ChatIrStatus> {
        self.note("select");
        std::thread::sleep(self.select_sleep);
        self.select.clone().map(|items| Selection {
            items,
            event_ids: self.event_ids.clone(),
            excluded: self.excluded.clone(),
        })
    }

    fn stop_requested(&self) -> bool {
        self.participant.as_ref().map_or_else(
            || self.stop.load(Ordering::SeqCst),
            |participant| participant.stop_requested().unwrap_or(true),
        )
    }

    fn db_identity(&self) -> u64 {
        self.identity
    }
}
