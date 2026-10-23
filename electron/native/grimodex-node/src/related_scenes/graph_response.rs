//! CP-3a S2b: the response of `related_scenes_graph_continue` and the click on
//! its Graph-only row.
//!
//! The worker's Graph is not trusted. Once the ticket and the IR response are
//! in hand (`graph.rs`), one participant read transaction requalifies it
//! (`grimodex_db::...::requalify_graph_for_related_scenes`) and this module
//! turns the outcome into the wire:
//!
//! * `pathAttachments`: the path of each Scene the response displays, with the
//!   text of the typed Revision this snapshot read (never the worker's);
//! * `graphOnly`: at most one Scene the author declared, with its title, the
//!   first non-empty line of its body and the exact range, an opaque handle and
//!   the path that reaches it. Every reason the row is absent (no candidate,
//!   ineligible, over a limit, no free slot, a quarantined workspace) is the
//!   one value `null`: the response can not tell them apart (Mandatory
//!   defense 9).
//!
//! What the operation keeps for the click is the CB-4 binding (digests and
//! tokens) and the identifiers and tokens of the row's path: no response, no
//! excerpt, no body, no path text (Mandatory defense 5, P2-1). The click
//! requalifies from those in a new read transaction, and answers the range only
//! (no body digest ever leaves Native, P2-5).
use super::graph::{gate_reason, GraphState};
use super::*;
use crate::nir1_graph_product::GraphUnavailable;
use grimodex_db::narrative_extraction::nir1_graph::worker_projection::Nir1GraphProjection;
use grimodex_db::narrative_extraction::scene_body_declaration::{
    SCENE_BODY_READ_MAX_BYTES, SCENE_BODY_TITLE_MAX_BYTES,
};
use grimodex_db::narrative_extraction::{
    read_retrieval_query_context, requalify_graph_for_related_scenes, requalify_graph_only_click,
    with_graph_requalification_read, AppendSlot, GraphClickPath, GraphDisclosureQuery,
    GraphDisclosureWorkspace, GraphOnlyBudget, GraphOnlyClick, GraphOnlySceneBinding,
    GraphOnlySceneDisclosure, GraphPathAttachment, GraphPathEdge, GraphRequalification,
    GraphRequalificationDrop, GraphRequalificationInput, GraphWorkControl, GraphWorkStage,
    QualifiedGraphForRelatedScenes, RetrievalQueryContextRead, ValidationTerminated,
    ValidationTerminationReason,
};
use grimodex_db::ParticipantSqlOperationBudget;
use std::collections::BTreeSet;
use std::fmt;
use std::sync::atomic::AtomicBool;

/// K1b rule 5 (DR-CP3A-29). The whole requalification transaction: the stop
/// flag, this deadline and the busy wait of `ParticipantSqlOperationBudget`.
/// Exceeding it is a real timeout of the Graph (`timeout`); it is far above the
/// Graph-only judgement's own deadline, which is what bounds a candidate.
pub(super) const VERIFY_SQL_TIMEOUT: Duration = Duration::from_secs(2);
const VERIFY_SQL_BUSY_TIMEOUT: Duration = Duration::from_millis(100);
/// The deadline of the Graph-only judgement alone (candidate scan, path
/// revalidation, body read), counted from the start of the requalification.
/// Exceeding it adds no Graph-only Scene and changes nothing else.
pub(super) const GRAPH_ONLY_DEADLINE: Duration = Duration::from_millis(500);
/// The judgement's deadline never reaches into this much of the transaction's
/// end, so exceeding the judgement can not become a timeout of the Graph.
const GRAPH_ONLY_DEADLINE_MARGIN: Duration = Duration::from_millis(250);
const _: () = assert!(
    GRAPH_ONLY_DEADLINE.as_millis() + GRAPH_ONLY_DEADLINE_MARGIN.as_millis()
        <= VERIFY_SQL_TIMEOUT.as_millis()
);

/// Why a stop was raised from this module's checkpoint.
#[derive(Debug)]
pub(super) struct GraphStop(pub(super) GraphUnavailable);

impl fmt::Display for GraphStop {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "RELATED_SCENES_GRAPH_STOPPED:{}",
            self.0.as_str()
        )
    }
}

impl std::error::Error for GraphStop {}

/// What a click on a Graph-only row is compared with. Identifiers and tokens
/// only; the type prints nothing.
#[derive(Clone)]
pub(super) struct ClickEntry {
    binding: GraphOnlySceneBinding,
    path: GraphClickPath,
    scene_id: String,
}

impl fmt::Debug for ClickEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("ClickEntry").finish_non_exhaustive()
    }
}

/// The Scenes the response displays and whether the common extra slot is free,
/// computed by Native from its own IR response and the renderer's R. `R` is the
/// renderer's selection out of the dense hits (checked by the claim); the IR
/// Scene is the first one of Native's own response that R does not hold, and it
/// is shown only while R has fewer than `max_scenes` items
/// (`nir1RelatedScenesFusion.ts`).
#[derive(Debug, Eq, PartialEq)]
pub(super) struct Composition {
    pub(super) displayed: BTreeSet<String>,
    pub(super) slot: AppendSlot,
}

pub(super) fn compose(ir: &Value, raw: &[String], max_scenes: usize) -> Option<Composition> {
    if ir["status"] != "available" {
        return None;
    }
    let scenes = ir["scenes"].as_array()?;
    let mut supplement = None;
    for scene in scenes {
        let id = scene["sceneId"].as_str()?;
        if supplement.is_none() && !raw.iter().any(|raw| raw == id) {
            supplement = Some(id);
        }
    }
    let supplement = supplement.filter(|_| raw.len() < max_scenes);
    let displayed = raw
        .iter()
        .map(String::as_str)
        .chain(supplement)
        .map(str::to_owned)
        .collect();
    Some(Composition {
        displayed,
        slot: AppendSlot {
            ir_uses_common_slot: supplement.is_some(),
            raw_count: raw.len(),
        },
    })
}

/// What the requalification leaves for `graph_continue` to return.
pub(super) enum Assembled {
    Unavailable(GraphUnavailable),
    Available {
        wire: Value,
        /// The handle of the Graph-only row and what its click needs.
        click: Option<Box<(String, ClickEntry)>>,
    },
}

/// The closed reason of an `Err` that ended the requalification. A cancel, a
/// deadline or a storage failure is a failure of the whole Graph; none of them
/// is about a Graph-only candidate, so none can reveal one (DR-CP3A-27).
pub(super) fn classify(error: &anyhow::Error) -> GraphUnavailable {
    for cause in error.chain() {
        if let Some(stop) = cause.downcast_ref::<GraphStop>() {
            return stop.0;
        }
        if let Some(terminated) = cause.downcast_ref::<ValidationTerminated>() {
            return match terminated.reason {
                ValidationTerminationReason::TimedOut => GraphUnavailable::Timeout,
                ValidationTerminationReason::Cancelled => GraphUnavailable::Cancelled,
                ValidationTerminationReason::CapacityExceeded => GraphUnavailable::Limit,
                ValidationTerminationReason::ContextUnavailable
                | ValidationTerminationReason::Closed
                | ValidationTerminationReason::WorkspaceGenerationChanged
                | ValidationTerminationReason::ForegroundPreempted
                | ValidationTerminationReason::CleanupFailed => GraphUnavailable::Invalidated,
            };
        }
    }
    GraphUnavailable::Failed
}

fn drop_reason(reason: GraphRequalificationDrop) -> GraphUnavailable {
    match reason {
        GraphRequalificationDrop::ProjectOrSceneMismatch
        | GraphRequalificationDrop::SeedChanged
        | GraphRequalificationDrop::SealUnavailable
        | GraphRequalificationDrop::SealMismatch
        | GraphRequalificationDrop::PathNotCurrent => GraphUnavailable::Invalidated,
        GraphRequalificationDrop::AttachmentLimit => GraphUnavailable::Limit,
    }
}

/// The cancel and deadline checkpoint of the requalification and of a click:
/// the participant's own stop and the workspace generation (as every other
/// Related Scenes read), then this operation's lease, the declaration of the
/// renderer (an await only) and the Graph owner's lifecycle epoch.
struct Checkpoint<'a> {
    state: &'a AppState,
    lease: &'a Lease,
    control: build::RelatedScenesBuildControl<'a>,
    watch_settle: bool,
}

impl<'a> Checkpoint<'a> {
    fn new(state: &'a AppState, lease: &'a Lease, watch_settle: bool) -> Self {
        Self {
            state,
            lease,
            control: build::RelatedScenesBuildControl::new(
                state,
                &lease.data.request,
                &lease.data.participant,
            ),
            watch_settle,
        }
    }

    fn check(&mut self) -> Result<()> {
        self.control.check(GraphWorkStage::Row)?;
        let stop = |reason| Err(anyhow::Error::new(GraphStop(reason)));
        if self.watch_settle && self.lease.data.graph.is_settled() {
            return stop(GraphUnavailable::Cancelled);
        }
        if !self.lease.is_live(Instant::now()) {
            return stop(GraphUnavailable::Invalidated);
        }
        if self.state.nir1_graph.is_closed()
            || self.state.nir1_graph.edge_epoch() != self.lease.data.graph.edge_epoch()
        {
            return stop(GraphUnavailable::Invalidated);
        }
        Ok(())
    }
}

/// The workspace this operation was made for, taken afresh for the read.
fn operation_workspace(
    state: &AppState,
    lease: &Lease,
) -> Result<grimodex_db::state::ActiveWorkspaceSnapshot> {
    let workspace = grimodex_db::state::active_workspace_snapshot(&state.ws)
        .map_err(|error| anyhow!(error.to_string()))?;
    ensure!(
        workspace.db().identity() == lease.data.request.database().identity(),
        "RELATED_SCENES_WORKSPACE_CHANGED"
    );
    Ok(workspace)
}

fn sql_budget(deadline: Instant) -> ParticipantSqlOperationBudget {
    ParticipantSqlOperationBudget::new(
        Arc::new(AtomicBool::new(false)),
        deadline,
        VERIFY_SQL_BUSY_TIMEOUT,
    )
}

/// The query Scene's context in the transaction's snapshot. A context that can
/// not be read gives a query without values, with which the reader adds nothing.
fn disclosure_query(read: Result<RetrievalQueryContextRead>) -> GraphDisclosureQuery {
    match read {
        Ok(RetrievalQueryContextRead::Available(context)) => {
            GraphDisclosureQuery::from_retrieval_query_context(&context)
        }
        _ => GraphDisclosureQuery::unavailable(),
    }
}

/// Requalifies `projection` for one response (runs on a blocking thread).
/// The result is made only from what this transaction read; nothing is kept
/// except the click entry returned with it.
pub(super) fn assemble(
    state: &AppState,
    lease: &Lease,
    projection: &Nir1GraphProjection,
    raw_scene_ids: &[String],
) -> Result<Assembled> {
    let op = &lease.data;
    let ir = lock(&op.result)?.response.clone();
    let Some(ir) = ir else {
        return Ok(Assembled::Unavailable(GraphUnavailable::Cancelled));
    };
    // A Chronicle that is not available is not a Graph to verify (the await
    // already answered `cancelled`); a response this module can not read is a
    // failure.
    if ir["status"] != "available" {
        return Ok(Assembled::Unavailable(GraphUnavailable::Cancelled));
    }
    let (max_scenes, _) = ranking_policy::fusion_limits()?;
    let Some(composition) = compose(&ir, raw_scene_ids, max_scenes) else {
        return Ok(Assembled::Unavailable(GraphUnavailable::Failed));
    };
    let workspace = operation_workspace(state, lease)?;
    let outcome = requalify_in_workspace(
        &workspace,
        &Requalify {
            project_id: op.source.project_id(),
            query_scene_id: op.source.scene_id(),
            projection,
            composition: &composition,
            query_binding: &op.query_binding,
        },
        &mut Checkpoint::new(state, lease, true),
    )?;
    Ok(outcome)
}

pub(super) struct Requalify<'a> {
    pub(super) project_id: &'a str,
    pub(super) query_scene_id: &'a str,
    pub(super) projection: &'a Nir1GraphProjection,
    pub(super) composition: &'a Composition,
    pub(super) query_binding: &'a str,
}

/// Source of the checkpoint's `Err`: a trait so a test can drive the same
/// requalification with its own cancel.
pub(super) trait Stopper {
    fn check(&mut self) -> Result<()>;
}

impl Stopper for Checkpoint<'_> {
    fn check(&mut self) -> Result<()> {
        Checkpoint::check(self)
    }
}

pub(super) fn requalify_in_workspace(
    workspace: &grimodex_db::state::ActiveWorkspaceSnapshot,
    request: &Requalify<'_>,
    checkpoint: &mut dyn Stopper,
) -> Result<Assembled> {
    let disclosure_workspace = GraphDisclosureWorkspace::from_snapshot(workspace);
    let started = Instant::now();
    let transaction_deadline = started + VERIFY_SQL_TIMEOUT;
    let graph_only_deadline = (started + GRAPH_ONLY_DEADLINE).min(
        transaction_deadline
            .checked_sub(GRAPH_ONLY_DEADLINE_MARGIN)
            .unwrap_or(started),
    );
    let outcome =
        with_graph_requalification_read(workspace, sql_budget(transaction_deadline), |conn| {
            let query = disclosure_query(read_retrieval_query_context(
                conn,
                request.project_id,
                request.query_scene_id,
            ));
            let budget = GraphOnlyBudget::standard(Some(graph_only_deadline));
            let input = GraphRequalificationInput {
                project_id: request.project_id,
                query_scene_id: request.query_scene_id,
                projection: request.projection,
                displayed_scene_ids: &request.composition.displayed,
                slot: request.composition.slot,
                workspace: &disclosure_workspace,
                query: &query,
                graph_only_budget: &budget,
            };
            requalify_graph_for_related_scenes(conn, &input, &mut || checkpoint.check())
        })?;
    let mut qualified = match outcome {
        GraphRequalification::Dropped(reason) => {
            return Ok(Assembled::Unavailable(drop_reason(reason)));
        }
        GraphRequalification::Qualified(qualified) => qualified,
    };
    // After the transaction: a quarantined workspace discloses no Graph-only
    // Scene (DR-CB4-12 (4)).
    qualified.drop_graph_only_if_quarantined(&disclosure_workspace);
    Ok(response(request.query_binding, *qualified))
}

// ---- the wire -------------------------------------------------------------

fn edge_wire(edge: &GraphPathEdge) -> Value {
    json!({
        "relationType": edge.relation_type,
        "directionality": edge.directionality,
        "from": {"entityId": edge.from.entity_id, "label": edge.from.label},
        "to": {"entityId": edge.to.entity_id, "label": edge.to.label},
        "evidence": edge.evidence.iter().map(|evidence| json!({
            "evidenceId": evidence.evidence_id, "quote": evidence.quote,
        })).collect::<Vec<_>>(),
    })
}

fn attachment_wire(attachment: &GraphPathAttachment) -> Value {
    json!({
        "sceneId": attachment.scene_id,
        "hop": attachment.hop,
        "edges": attachment.edges.iter().map(edge_wire).collect::<Vec<_>>(),
    })
}

/// The fields of the Graph-only row, as the response shows them.
pub(super) struct RowFields<'a> {
    pub(super) scene_id: &'a str,
    pub(super) title: &'a str,
    pub(super) excerpt: &'a str,
    pub(super) start_utf16: usize,
    pub(super) end_utf16: usize,
    pub(super) path: &'a GraphPathAttachment,
}

/// The row's wire, or `None` when it can not be shown inside the bounds the
/// response keeps (a title or an excerpt larger than the declaration itself
/// allows, or a path that is not the Scene's). Both texts are bounded by the
/// declaration and the body read already; the check is a defense, and its
/// answer is the one `null` of every other reason.
pub(super) fn row_wire(fields: &RowFields<'_>, identity: &str) -> Option<Value> {
    if fields.title.len() > SCENE_BODY_TITLE_MAX_BYTES
        || fields.excerpt.len() > SCENE_BODY_READ_MAX_BYTES
        || fields.path.scene_id != fields.scene_id
    {
        return None;
    }
    Some(json!({
        "sceneId": fields.scene_id,
        "sceneTitle": fields.title,
        "excerpt": fields.excerpt,
        "canonicalRange": {"start": fields.start_utf16, "end": fields.end_utf16},
        "navigationIdentity": identity,
        "path": {
            "hop": fields.path.hop,
            "pinEntityId": fields.path.pin_entity_id,
            "edges": fields.path.edges.iter().map(edge_wire).collect::<Vec<_>>(),
        },
    }))
}

fn graph_only_wire(
    qualified: &QualifiedGraphForRelatedScenes,
) -> Option<(Value, ClickEntry, String)> {
    let GraphOnlySceneDisclosure::Eligible(scene) = &qualified.graph_only else {
        return None;
    };
    let row = qualified.graph_only_row.as_ref()?;
    let range = scene.range();
    let identity = format!("related-scenes-graph-scene:{}", uuid::Uuid::new_v4());
    let wire = row_wire(
        &RowFields {
            scene_id: scene.scene_id(),
            title: scene.title(),
            excerpt: scene.excerpt(),
            start_utf16: range.start_utf16,
            end_utf16: range.end_utf16,
            path: &row.path,
        },
        &identity,
    )?;
    let entry = ClickEntry {
        binding: scene.binding().clone(),
        path: row.click_path.clone(),
        scene_id: scene.scene_id().to_owned(),
    };
    Some((wire, entry, identity))
}

/// The `available` response. `graphOnly` is `null` for every reason the row is
/// absent, so the bytes of such responses are the same.
pub(super) fn response(
    query_binding: &str,
    qualified: QualifiedGraphForRelatedScenes,
) -> Assembled {
    let row = graph_only_wire(&qualified);
    let (graph_only, click) = match row {
        Some((wire, entry, identity)) => (wire, Some(Box::new((identity, entry)))),
        None => (Value::Null, None),
    };
    Assembled::Available {
        wire: json!({
            "status": "available",
            "queryBinding": query_binding,
            "pathAttachments": qualified.attachments.iter().map(attachment_wire).collect::<Vec<_>>(),
            "graphOnly": graph_only,
        }),
        click,
    }
}

/// Keeps the click entry of a response that is about to leave. Called last,
/// after every recheck, so a discarded payload leaves no handle.
pub(super) fn keep_click(graph: &GraphState, click: Option<Box<(String, ClickEntry)>>) {
    if let Some(click) = click {
        let (identity, entry) = *click;
        graph.keep_click(identity, entry);
    }
}

// ---- the click --------------------------------------------------------------

/// `nir1_evidence_qualify` for a Graph-only handle. In a new read transaction
/// the judgement of the row (the path, the pin, the declaration, the title, the
/// body) runs again against what the response bound, and only the range comes
/// back. Whatever no longer holds, a lost gate and a failure of any kind are
/// `unavailable`; the operation (and so the R+IR list) is invalidated only when
/// it is itself stale.
pub(super) fn click(
    state: &AppState,
    ticket: &str,
    lease: &Lease,
    identity: &str,
    entry: &ClickEntry,
) -> Result<Value> {
    if gate_reason(state).is_some() {
        return Ok(unavailable("invalidated"));
    }
    if !current_operation(state, lease)? {
        invalidate(state, ticket, lease)?;
        return Ok(unavailable("invalidated"));
    }
    let outcome = click_in_workspace(state, lease, entry);
    let range = match outcome {
        Ok(Some(range)) => range,
        Ok(None) => return Ok(unavailable("invalidated")),
        Err(error) => {
            return Ok(unavailable(match classify(&error) {
                GraphUnavailable::Cancelled => "cancelled",
                GraphUnavailable::Invalidated | GraphUnavailable::Timeout => "invalidated",
                _ => "failed",
            }))
        }
    };
    // The same rechecks as every Evidence navigation, where the answer leaves.
    if !lease.is_live(Instant::now()) || !current_request(state, &lease.data.request)? {
        return Ok(unavailable("invalidated"));
    }
    if gate_reason(state).is_some() {
        return Ok(unavailable("invalidated"));
    }
    Ok(json!({
        "status": "qualified",
        "bindingKey": identity,
        "queryBinding": lease.data.query_binding,
        "sceneId": entry.scene_id,
        "canonicalRange": {"start": range.0, "end": range.1},
    }))
}

fn click_in_workspace(
    state: &AppState,
    lease: &Lease,
    entry: &ClickEntry,
) -> Result<Option<(usize, usize)>> {
    let workspace = operation_workspace(state, lease)?;
    let mut checkpoint = Checkpoint::new(state, lease, false);
    click_requalified(
        &workspace,
        lease.data.source.project_id(),
        lease.data.source.scene_id(),
        entry,
        &mut checkpoint,
    )
}

pub(super) fn click_requalified(
    workspace: &grimodex_db::state::ActiveWorkspaceSnapshot,
    project_id: &str,
    query_scene_id: &str,
    entry: &ClickEntry,
    checkpoint: &mut dyn Stopper,
) -> Result<Option<(usize, usize)>> {
    let disclosure_workspace = GraphDisclosureWorkspace::from_snapshot(workspace);
    let verdict = with_graph_requalification_read(
        workspace,
        sql_budget(Instant::now() + VERIFY_SQL_TIMEOUT),
        |conn| {
            let query = disclosure_query(read_retrieval_query_context(
                conn,
                project_id,
                query_scene_id,
            ));
            requalify_graph_only_click(
                conn,
                &disclosure_workspace,
                &query,
                &entry.binding,
                &entry.path,
                &mut || checkpoint.check(),
            )
        },
    )?;
    // A quarantine that began during the read is a refusal (DR-CB4-12 (4)).
    Ok(match verdict {
        GraphOnlyClick::Allowed(range) if !disclosure_workspace.is_quarantined() => {
            Some((range.start_utf16, range.end_utf16))
        }
        GraphOnlyClick::Allowed(_) | GraphOnlyClick::Refused(_) => None,
    })
}
