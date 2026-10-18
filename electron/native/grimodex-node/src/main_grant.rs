//! MG-1: Main's one-time confirmation (grant) and the pre-publication gate
//! (CB-2, DR-CB2-8 to DR-CB2-10; DSN section 7).
//!
//! A grant carries Main's confirmation of one dialog to one writer. The slot is
//! process-wide (one grant at a time, whatever the kind), bound to a sender and
//! a window, valid for 60 seconds from its preview, and consumed before the
//! writer opens its transaction. A consumed grant is never given back, even
//! when the writer fails.
//!
//! * `Previewed -> Issued -> Consumed | Revoked | Expired`.
//! * previewId and grantId are random hex strings (two UUIDv4s: 244 random
//!   bits). The grantId never leaves Native except as the value Main passes
//!   back; no response or event carries either id to the renderer.
//! * The u64 values of the binding (lifecycle revision, authority instance,
//!   recovery generation) stay inside Native. The grant digest serializes them
//!   as decimal strings; [`parse_decimal_u64`] is the checked inverse.
//! * The lifecycle observer (the third of the Core's four slots, after the
//!   startup gate and the Graph owner) revokes the slot on `TransitionAdmitted`, `Unavailable` and
//!   `ShutdownRequested`. It only takes a short mutex and flips a flag: it never
//!   calls the Core, a database or the projection, never blocks and never
//!   panics (the seam's contract).
//!
//! The [`PrePublicationGate`] is closed by default. Only a Main-only N-API opens
//! it, for the life of the process; nothing persists it.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use anyhow::Result;
use grimodex_core::canonical_json_digest;
use grimodex_db::narrative_extraction::scene_body_declaration::{
    BodyDeclarationBinding, ConsumedBodyDeclarationBinding, DeclareRequest,
};
use grimodex_db::workspace_lifecycle::{
    LifecycleEdge, WorkspaceLifecycleCore, WorkspaceLifecycleObserver,
};
use serde_json::json;
use uuid::Uuid;

/// Validity of a grant, from its preview.
pub(crate) const MAIN_GRANT_TTL_MS: u64 = 60_000;

/// The kinds of grant. `ProfileActivation` is added by DA-2 together with its
/// payload; [`GrantPayload`] and [`GrantKindBinding`] are the places it plugs
/// in.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum MainGrantKind {
    BodyDeclaration,
}

impl MainGrantKind {
    pub(crate) const fn wire(self) -> &'static str {
        match self {
            Self::BodyDeclaration => "body-declaration",
        }
    }

    pub(crate) fn parse(wire: &str) -> Option<Self> {
        match wire {
            "body-declaration" => Some(Self::BodyDeclaration),
            _ => None,
        }
    }

    /// The gate entry that must be open for this kind to be previewed.
    pub(crate) const fn gate_entry(self) -> PrePublicationEntry {
        match self {
            Self::BodyDeclaration => PrePublicationEntry::SceneBodyDeclaration,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GrantState {
    Previewed,
    Issued,
    Consumed,
    Revoked,
    Expired,
}

impl GrantState {
    const fn is_active(self) -> bool {
        matches!(self, Self::Previewed | Self::Issued)
    }
}

/// Why a grant operation was refused. A closed set; each code is the whole
/// error message (no id, digest, sender or binding is ever included).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GrantRefusal {
    /// Another grant is already in the slot. Never waited for.
    Busy,
    /// No grant sidecar came with a call that needs one.
    Missing,
    /// The lifecycle observer is not registered, or the workspace is not Ready.
    Unavailable,
    NotFound,
    /// The sender or the window is not the one the grant is bound to.
    Mismatch,
    Expired,
    Revoked,
    Consumed,
    /// The grant is in a state the call does not accept (for example an issue
    /// of an already issued preview).
    WrongState,
    WrongKind,
    /// The Scene, the workspace or the lifecycle changed since the preview.
    StateChanged,
}

impl GrantRefusal {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::Busy => "MAIN_GRANT_BUSY",
            Self::Missing => "MAIN_GRANT_REQUIRED",
            Self::Unavailable => "MAIN_GRANT_UNAVAILABLE",
            Self::NotFound => "MAIN_GRANT_NOT_FOUND",
            Self::Mismatch => "MAIN_GRANT_MISMATCH",
            Self::Expired => "MAIN_GRANT_EXPIRED",
            Self::Revoked => "MAIN_GRANT_REVOKED",
            Self::Consumed => "MAIN_GRANT_CONSUMED",
            Self::WrongState => "MAIN_GRANT_STATE",
            Self::WrongKind => "MAIN_GRANT_KIND",
            Self::StateChanged => "MAIN_GRANT_STATE_CHANGED",
        }
    }

    pub(crate) fn into_error(self) -> anyhow::Error {
        anyhow::anyhow!(self.code())
    }
}

impl std::fmt::Display for GrantRefusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for GrantRefusal {}

// ───────────────────────────── the gate ─────────────────────────────

/// Entries that stay closed until their product is published (PUB-G, PUB-L).
/// DD-1 adds the local-send route by adding a variant and an index here.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PrePublicationEntry {
    /// K2/4: the body-declaration preview, the declaration writer and the
    /// revoke writer.
    SceneBodyDeclaration,
}

impl PrePublicationEntry {
    const ALL: [Self; 1] = [Self::SceneBodyDeclaration];

    const fn index(self) -> usize {
        match self {
            Self::SceneBodyDeclaration => 0,
        }
    }

    pub(crate) fn parse(wire: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|entry| entry.wire() == wire)
    }

    pub(crate) const fn wire(self) -> &'static str {
        match self {
            Self::SceneBodyDeclaration => "scene-body-declaration",
        }
    }
}

/// Process-local, closed by default, never persisted. There is no close call:
/// a restart closes every entry.
pub(crate) struct PrePublicationGate {
    open: [AtomicBool; PrePublicationEntry::ALL.len()],
}

impl PrePublicationGate {
    pub(crate) fn new() -> Self {
        Self {
            open: std::array::from_fn(|_| AtomicBool::new(false)),
        }
    }

    pub(crate) fn is_open(&self, entry: PrePublicationEntry) -> bool {
        self.open[entry.index()].load(Ordering::SeqCst)
    }

    pub(crate) fn open(&self, entry: PrePublicationEntry) {
        self.open[entry.index()].store(true, Ordering::SeqCst);
    }
}

// ───────────────────────────── the slot ─────────────────────────────

/// What a `BodyDeclaration` grant is bound to. Held in Native only.
#[derive(Clone, Debug)]
pub(crate) struct BodyDeclarationGrantPayload {
    pub(crate) request: DeclareRequest,
    pub(crate) expected_workspace_path: String,
    pub(crate) binding: BodyDeclarationBinding,
}

#[derive(Clone, Debug)]
pub(crate) enum GrantPayload {
    BodyDeclaration(Box<BodyDeclarationGrantPayload>),
}

/// Ties a grant kind to the value the writer receives when the grant is
/// consumed.
pub(crate) trait GrantKindBinding {
    const KIND: MainGrantKind;
    type Consumed;
    fn extract(payload: GrantPayload) -> Option<Self::Consumed>;
}

pub(crate) struct BodyDeclarationKind;

impl GrantKindBinding for BodyDeclarationKind {
    const KIND: MainGrantKind = MainGrantKind::BodyDeclaration;
    type Consumed = ConsumedBodyDeclarationBinding;

    fn extract(payload: GrantPayload) -> Option<Self::Consumed> {
        match payload {
            GrantPayload::BodyDeclaration(payload) => Some(
                ConsumedBodyDeclarationBinding::from_consumed_grant(payload.binding),
            ),
        }
    }
}

struct Slot {
    kind: MainGrantKind,
    state: GrantState,
    preview_id: String,
    grant_id: Option<String>,
    sender_id: u32,
    window_id: u32,
    expires_at_ms: u64,
    digest: String,
    lifecycle_revision: u64,
    /// Dropped when the grant leaves `Previewed` / `Issued`.
    payload: Option<GrantPayload>,
}

impl Slot {
    fn end(&mut self, state: GrantState) {
        self.state = state;
        self.payload = None;
    }
}

/// What `begin_issue` hands back so the caller can read the Scene again.
pub(crate) struct IssueTicket {
    pub(crate) payload: GrantPayload,
    pub(crate) lifecycle_revision: u64,
    pub(crate) sender_id: u32,
    pub(crate) window_id: u32,
}

/// Everything a preview stores in the slot.
pub(crate) struct PreviewInit {
    pub(crate) kind: MainGrantKind,
    pub(crate) sender_id: u32,
    pub(crate) window_id: u32,
    pub(crate) digest: String,
    pub(crate) lifecycle_revision: u64,
    pub(crate) payload: GrantPayload,
}

pub(crate) struct PreviewHandle {
    pub(crate) preview_id: String,
    pub(crate) expires_in_ms: u64,
}

type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// The process-wide slot.
pub(crate) struct MainGrantRegistry {
    slot: Mutex<Option<Slot>>,
    /// Advanced by every lifecycle edge that must stop work, under the slot
    /// mutex. A read-only probe for the writer's SQL fence.
    edge_epoch: AtomicU64,
    observer_registered: AtomicBool,
    clock: Clock,
}

fn random_hex() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

impl MainGrantRegistry {
    pub(crate) fn new() -> Self {
        let base = Instant::now();
        Self::with_clock(Arc::new(move || {
            u64::try_from(base.elapsed().as_millis()).unwrap_or(u64::MAX)
        }))
    }

    /// A registry on another clock (milliseconds on any monotonic origin).
    pub(crate) fn with_clock(clock: Clock) -> Self {
        Self {
            slot: Mutex::new(None),
            edge_epoch: AtomicU64::new(0),
            observer_registered: AtomicBool::new(false),
            clock,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Option<Slot>> {
        self.slot.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn expire_due(&self, slot: &mut Option<Slot>) {
        let now = (self.clock)();
        if let Some(current) = slot.as_mut() {
            if current.state.is_active() && now >= current.expires_at_ms {
                current.end(GrantState::Expired);
            }
        }
    }

    pub(crate) fn edge_epoch(&self) -> u64 {
        self.edge_epoch.load(Ordering::SeqCst)
    }

    pub(crate) fn mark_observer_registered(&self, registered: bool) {
        self.observer_registered.store(registered, Ordering::SeqCst);
    }

    /// The lifecycle seam's revoke: advances the epoch and revokes an active
    /// slot. Short, non-blocking, and free of any Core, database or
    /// projection access.
    pub(crate) fn revoke_for_edge(&self) {
        let mut slot = self.lock();
        self.edge_epoch.fetch_add(1, Ordering::SeqCst);
        if let Some(current) = slot.as_mut() {
            if current.state.is_active() {
                current.end(GrantState::Revoked);
            }
        }
    }

    /// Revokes whatever is active (D2a epoch changes, shutdown).
    pub(crate) fn revoke_all(&self) {
        let mut slot = self.lock();
        if let Some(current) = slot.as_mut() {
            if current.state.is_active() {
                current.end(GrantState::Revoked);
            }
        }
    }

    pub(crate) fn revoke_sender(&self, sender_id: u32) {
        let mut slot = self.lock();
        if let Some(current) = slot.as_mut() {
            if current.state.is_active() && current.sender_id == sender_id {
                current.end(GrantState::Revoked);
            }
        }
    }

    /// Revokes the slot named by a previewId or a grantId. An unknown id, or a
    /// grant that already ended, is not an error.
    pub(crate) fn revoke(&self, id: &str) {
        let mut slot = self.lock();
        self.expire_due(&mut slot);
        if let Some(current) = slot.as_mut() {
            let named = current.preview_id == id || current.grant_id.as_deref() == Some(id);
            if named && current.state.is_active() {
                current.end(GrantState::Revoked);
            }
        }
    }

    /// The cheap early check of a preview: nothing is read when the slot is
    /// taken or the observer is missing.
    pub(crate) fn ensure_can_preview(&self) -> Result<(), GrantRefusal> {
        let mut slot = self.lock();
        self.expire_due(&mut slot);
        self.preview_precondition(&slot)
    }

    fn preview_precondition(&self, slot: &Option<Slot>) -> Result<(), GrantRefusal> {
        if !self.observer_registered.load(Ordering::SeqCst) {
            return Err(GrantRefusal::Unavailable);
        }
        if slot
            .as_ref()
            .is_some_and(|current| current.state.is_active())
        {
            return Err(GrantRefusal::Busy);
        }
        Ok(())
    }

    /// Stores a preview. `expected_epoch` is the edge epoch observed before
    /// the Scene was read: an edge in between refuses the preview, so a grant
    /// can never survive an edge it did not see.
    pub(crate) fn insert_preview(
        &self,
        init: PreviewInit,
        expected_epoch: u64,
    ) -> Result<PreviewHandle, GrantRefusal> {
        let mut slot = self.lock();
        self.expire_due(&mut slot);
        self.preview_precondition(&slot)?;
        if self.edge_epoch() != expected_epoch {
            return Err(GrantRefusal::StateChanged);
        }
        let preview_id = random_hex();
        *slot = Some(Slot {
            kind: init.kind,
            state: GrantState::Previewed,
            preview_id: preview_id.clone(),
            grant_id: None,
            sender_id: init.sender_id,
            window_id: init.window_id,
            expires_at_ms: (self.clock)().saturating_add(MAIN_GRANT_TTL_MS),
            digest: init.digest,
            lifecycle_revision: init.lifecycle_revision,
            payload: Some(init.payload),
        });
        Ok(PreviewHandle {
            preview_id,
            expires_in_ms: MAIN_GRANT_TTL_MS,
        })
    }

    fn state_refusal(state: GrantState) -> GrantRefusal {
        match state {
            GrantState::Expired => GrantRefusal::Expired,
            GrantState::Revoked => GrantRefusal::Revoked,
            GrantState::Consumed => GrantRefusal::Consumed,
            GrantState::Previewed | GrantState::Issued => GrantRefusal::WrongState,
        }
    }

    /// First half of an issue: checks the preview, the sender, the window and
    /// the expiry, and hands back what the caller needs to read the Scene
    /// again. The slot stays `Previewed`.
    pub(crate) fn begin_issue(
        &self,
        preview_id: &str,
        sender_id: u32,
        window_id: u32,
    ) -> Result<IssueTicket, GrantRefusal> {
        let mut slot = self.lock();
        self.expire_due(&mut slot);
        let current = slot
            .as_mut()
            .filter(|current| current.preview_id == preview_id)
            .ok_or(GrantRefusal::NotFound)?;
        if current.sender_id != sender_id || current.window_id != window_id {
            return Err(GrantRefusal::Mismatch);
        }
        if current.state != GrantState::Previewed {
            return Err(Self::state_refusal(current.state));
        }
        let payload = current.payload.clone().ok_or(GrantRefusal::Revoked)?;
        Ok(IssueTicket {
            payload,
            lifecycle_revision: current.lifecycle_revision,
            sender_id,
            window_id,
        })
    }

    /// Second half of an issue. `current_digest` is the grant digest of the
    /// Scene as it reads now; a difference revokes the grant.
    pub(crate) fn finish_issue(
        &self,
        preview_id: &str,
        current_digest: &str,
    ) -> Result<String, GrantRefusal> {
        let mut slot = self.lock();
        self.expire_due(&mut slot);
        let current = slot
            .as_mut()
            .filter(|current| current.preview_id == preview_id)
            .ok_or(GrantRefusal::NotFound)?;
        if current.state != GrantState::Previewed {
            return Err(Self::state_refusal(current.state));
        }
        if current.digest != current_digest {
            current.end(GrantState::Revoked);
            return Err(GrantRefusal::StateChanged);
        }
        let grant_id = random_hex();
        current.grant_id = Some(grant_id.clone());
        current.state = GrantState::Issued;
        Ok(grant_id)
    }

    /// Consumes the grant. Call it before the writer opens a transaction. The
    /// grant is `Consumed` from here on, whatever the writer does.
    pub(crate) fn consume<K: GrantKindBinding>(
        &self,
        grant_id: &str,
        sender_id: u32,
        window_id: u32,
        current_lifecycle_revision: u64,
    ) -> Result<K::Consumed, GrantRefusal> {
        let mut slot = self.lock();
        self.expire_due(&mut slot);
        let current = slot
            .as_mut()
            .filter(|current| current.grant_id.as_deref() == Some(grant_id))
            .ok_or(GrantRefusal::NotFound)?;
        if current.sender_id != sender_id || current.window_id != window_id {
            return Err(GrantRefusal::Mismatch);
        }
        if current.state != GrantState::Issued {
            return Err(Self::state_refusal(current.state));
        }
        if current.kind != K::KIND {
            return Err(GrantRefusal::WrongKind);
        }
        if current.lifecycle_revision != current_lifecycle_revision {
            current.end(GrantState::Revoked);
            return Err(GrantRefusal::StateChanged);
        }
        let payload = current.payload.take().ok_or(GrantRefusal::Revoked)?;
        current.end(GrantState::Consumed);
        K::extract(payload).ok_or(GrantRefusal::WrongKind)
    }

    #[cfg(test)]
    pub(crate) fn state_for_test(&self) -> Option<GrantState> {
        let mut slot = self.lock();
        self.expire_due(&mut slot);
        slot.as_ref().map(|current| current.state)
    }
}

// ─────────────────────── the lifecycle observer ───────────────────────

/// The third observer of the Core (the startup gate and the Graph owner are
/// the other two; the Core allows four).
struct GrantEdgeObserver {
    registry: Arc<MainGrantRegistry>,
}

impl WorkspaceLifecycleObserver for GrantEdgeObserver {
    fn on_lifecycle_edge(&self, edge: &LifecycleEdge) {
        match edge {
            LifecycleEdge::TransitionAdmitted { .. }
            | LifecycleEdge::Unavailable { .. }
            | LifecycleEdge::ShutdownRequested { .. } => self.registry.revoke_for_edge(),
            // A new Ready entry is entered through one of the edges above, and
            // the consume step compares the lifecycle revision. Edges added
            // later do not revoke until this match names them.
            _ => {}
        }
    }
}

/// Everything MG-1 keeps in `AppState`.
pub(crate) struct MainGrantState {
    pub(crate) registry: Arc<MainGrantRegistry>,
    pub(crate) gate: PrePublicationGate,
}

impl MainGrantState {
    /// Builds the state and registers its observer with the Core. A failed
    /// registration leaves the registry unable to preview (fail closed).
    pub(crate) fn new(core: &WorkspaceLifecycleCore) -> Self {
        let registry = Arc::new(MainGrantRegistry::new());
        Self::register(core, registry)
    }

    pub(crate) fn register(
        core: &WorkspaceLifecycleCore,
        registry: Arc<MainGrantRegistry>,
    ) -> Self {
        let registered = core
            .register_observer(Arc::new(GrantEdgeObserver {
                registry: Arc::clone(&registry),
            }))
            .is_ok();
        if !registered {
            tracing::warn!(
                "main grant lifecycle observer was not registered; grants stay unavailable"
            );
        }
        registry.mark_observer_registered(registered);
        Self {
            registry,
            gate: PrePublicationGate::new(),
        }
    }
}

// ───────────────────────────── digests ─────────────────────────────

/// The domain-separated digest of a grant's binding (DSN 7.2). The domain
/// `grimodex/main-grant/v1/<kind>` followed by a NUL is a member of the
/// canonical JSON, as in the binding digest of the db layer. u64 values are
/// decimal strings.
pub(crate) fn main_grant_digest(
    kind: MainGrantKind,
    binding: &BodyDeclarationBinding,
    lifecycle_revision: u64,
    sender_id: u32,
    window_id: u32,
) -> Result<String> {
    Ok(canonical_json_digest(&json!({
        "domain": format!("grimodex/main-grant/v1/{}\0", kind.wire()),
        "kind": kind.wire(),
        "lifecycleRevision": lifecycle_revision.to_string(),
        "senderId": sender_id,
        "windowId": window_id,
        "binding": serde_json::to_value(binding)?,
    }))?)
}

/// Checked parse of a decimal u64 as it appears in diagnostics: digits only,
/// no sign, no whitespace, no leading zero (except `0` itself).
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn parse_decimal_u64(text: &str) -> Option<u64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if text.len() > 1 && text.starts_with('0') {
        return None;
    }
    text.parse::<u64>().ok()
}

#[cfg(test)]
#[path = "main_grant_tests.rs"]
mod tests;
