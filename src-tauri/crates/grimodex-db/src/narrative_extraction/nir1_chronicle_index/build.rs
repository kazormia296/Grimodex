use std::collections::BTreeMap;

use anyhow::{ensure, Result};
use rusqlite::Connection;

use super::super::{
    c2zc_canonical_cutover::is_generic_freshness_canonical,
    dependency_edges::{canonical_source_object_identity, find_edges_by_consumer, DependencyEdge},
    project_scope_authority::load_live_project_scope_authority,
    retrieval_admission::{
        build::{finalize_build_candidate, preflight_build_candidate, BuildCandidate},
        ChronicleRetrievalDocument,
    },
    revision_eligibility::pending::{self, FeedSnapshot},
    semantic_epoch::get_current_epoch,
};
use super::{
    binding::{self, BindingRead, StoredBinding},
    source, NirChronicleIndexRuntime, NirIndexUnavailableReason as Reason, INDEX_KEY,
};

/// A consumed Native capability. No serialization, cloning, or caller fields.
pub struct NirIndexBuildPlan {
    pub(super) project: String,
    pub(super) owner: u64,
    pub(super) runtime_epoch: u64,
    pub(super) snapshot: BuildSnapshot,
}

// This transient read result owns its verified snapshot and is consumed
// immediately; keep the payload inline instead of adding a heap allocation.
#[allow(clippy::large_enum_variant)]
pub enum NirIndexBuildRead {
    Ready {
        plan: NirIndexBuildPlan,
        documents: Vec<ChronicleRetrievalDocument>,
    },
    AlreadyUsable,
    Unavailable {
        reason: Reason,
    },
}

pub(super) struct BuildSnapshot {
    pub input_guard: String,
    pub prior: Option<StoredBinding>,
    pub semantic_epoch: String,
    pub language: String,
    pub roster_digest: String,
    pub candidates: Vec<BuildCandidate>,
    pub edges: Vec<DependencyEdge>,
    pub feed: FeedSnapshot,
}

pub fn prepare_chronicle_index_build(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    project: &str,
) -> Result<NirIndexBuildRead> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1 preparation requires a read transaction"
    );
    ensure!(
        !project.trim().is_empty() && project.trim() == project,
        "exact project identity required"
    );
    let runtime_epoch = match runtime.current_epoch(conn)? {
        Ok(value) => value,
        Err(reason) => return Ok(NirIndexBuildRead::Unavailable { reason }),
    };
    if super::query::current_proof(conn, runtime, project)?.is_some() {
        return Ok(NirIndexBuildRead::AlreadyUsable);
    }
    let snapshot = match read_snapshot(conn, project)? {
        Ok(value) => value,
        Err(reason) => return Ok(NirIndexBuildRead::Unavailable { reason }),
    };
    let documents = snapshot
        .candidates
        .iter()
        .map(|candidate| candidate.document.clone())
        .collect();
    Ok(NirIndexBuildRead::Ready {
        plan: NirIndexBuildPlan {
            project: project.into(),
            owner: runtime.owner(),
            runtime_epoch,
            snapshot,
        },
        documents,
    })
}

pub(super) fn read_snapshot(
    conn: &Connection,
    project: &str,
) -> Result<std::result::Result<BuildSnapshot, Reason>> {
    if !is_generic_freshness_canonical(conn)? {
        return Ok(Err(Reason::CanonicalAuthorityUnavailable));
    }
    let prior = match binding::read(conn, project)? {
        BindingRead::Missing => None,
        BindingRead::Registered(value) => {
            if !binding::is_complete_registered(conn, project, INDEX_KEY)? {
                return Ok(Err(Reason::ReservedBinding));
            }
            Some(value)
        }
        BindingRead::Reserved => return Ok(Err(Reason::ReservedBinding)),
    };
    // An edited Source may disappear from the next admitted pool before its
    // canonical Feed evaluation has run. Check the previous complete pool's
    // inputs first, while they still include that Source. Otherwise a costly
    // temporary publication can precede the evaluation that immediately
    // dirties it again. This is a scheduling precheck; all new-pool admission
    // and conditional-publication checks below remain mandatory.
    if prior.is_some() {
        let previous_edges = find_edges_by_consumer(conn, project, "semantic-index", INDEX_KEY)?;
        if pending::read(conn, project, &previous_edges)?.is_err() {
            return Ok(Err(Reason::PendingChange));
        }
    }
    let Some(epoch) = get_current_epoch(conn, project)? else {
        return Ok(Err(Reason::CurrentEpochUnavailable));
    };
    let roster = source::read_eligibility_source(conn, project)?;
    let language: String = conn.query_row(
        "SELECT language FROM projects WHERE id=?1",
        [project],
        |row| row.get(0),
    )?;
    let authority = match load_live_project_scope_authority(
        conn,
        project,
        &format!("project:scope-authority:{project}"),
    ) {
        Ok(value) => value,
        Err(error)
            if error.downcast_ref::<rusqlite::Error>().is_some()
                || error.downcast_ref::<std::io::Error>().is_some() =>
        {
            return Err(error)
        }
        Err(_) => return Ok(Err(Reason::ScopeUnavailable)),
    };
    // Keep membership, approval, binding, and disclosure checks candidate
    // local. Only preflight-passing candidates contribute to the one global
    // scope preload, so a missing scope row in an ineligible roster entry
    // cannot suppress a valid candidate.
    let mut preflights = Vec::new();
    for revision in &roster.revisions {
        if let Ok(preflight) = preflight_build_candidate(conn, project, revision, &authority)? {
            preflights.push(preflight);
        }
    }
    let material_source_keys = preflights
        .iter()
        .flat_map(|preflight| {
            preflight
                .membership
                .materials
                .iter()
                .map(|material| material.source_key.clone())
        })
        .collect::<Vec<_>>();
    let material_scope_cache = match super::super::scene_scope::preload_material_scene_scopes(
        conn,
        project,
        &material_source_keys,
    ) {
        Ok(scopes) => scopes,
        Err(error)
            if error.downcast_ref::<rusqlite::Error>().is_some()
                || error.downcast_ref::<std::io::Error>().is_some() =>
        {
            return Err(error)
        }
        Err(_) => return Ok(Err(Reason::ScopeUnavailable)),
    };
    let mut candidates = Vec::new();
    for preflight in preflights {
        if let Ok(candidate) =
            finalize_build_candidate(conn, project, &authority, preflight, &material_scope_cache)?
        {
            candidates.push(candidate);
        }
    }
    let edges = input_edges(project, &roster.digest, &candidates)?;
    let feed = match pending::read(conn, project, &edges)? {
        Ok(value) => value,
        Err(_) => return Ok(Err(Reason::PendingChange)),
    };
    let input_guard = super::input_guard::read(conn, project)?;
    Ok(Ok(BuildSnapshot {
        input_guard,
        prior,
        semantic_epoch: epoch.id,
        language,
        roster_digest: roster.digest,
        candidates,
        edges,
        feed,
    }))
}

/// The first snapshot fully replayed L1/L2. Compare all its persisted inputs
/// atomically, then resolve every live Source and the bounded Feed again.
/// A partial roster or changed dependency can never publish a cached subset.
pub(super) fn snapshot_current(
    conn: &Connection,
    project: &str,
    snapshot: &BuildSnapshot,
) -> Result<bool> {
    if !is_generic_freshness_canonical(conn)? {
        return Ok(false);
    }
    let prior = match binding::read(conn, project)? {
        BindingRead::Missing => None,
        BindingRead::Registered(value) => Some(value),
        BindingRead::Reserved => return Ok(false),
    };
    if prior.is_some() && !binding::is_complete_registered(conn, project, INDEX_KEY)? {
        return Ok(false);
    }
    if prior != snapshot.prior
        || get_current_epoch(conn, project)?.is_none_or(|epoch| epoch.id != snapshot.semantic_epoch)
        || source::read_eligibility_source(conn, project)?.digest != snapshot.roster_digest
        || super::input_guard::read(conn, project)? != snapshot.input_guard
    {
        return Ok(false);
    }
    let language: String = conn.query_row(
        "SELECT language FROM projects WHERE id=?1",
        [project],
        |r| r.get(0),
    )?;
    if language != snapshot.language
        || pending::read(conn, project, &snapshot.edges)?.ok().as_ref() != Some(&snapshot.feed)
    {
        return Ok(false);
    }
    for observation in super::super::restore_rebuild::evaluate_owned_edges_from_db_in_tx(
        conn,
        project,
        &snapshot.edges,
    )? {
        if observation.freshness != super::super::evaluator::EvidenceFreshness::Fresh
            || observation.build_action != super::super::evaluator::BuildAction::None
            || observation.reason_code.is_some()
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn input_edges(
    project: &str,
    roster_digest: &str,
    candidates: &[BuildCandidate],
) -> Result<Vec<DependencyEdge>> {
    let mut sources = BTreeMap::<String, (String, Option<String>)>::new();
    sources.insert(source::source_key(project), (roster_digest.into(), None));
    for candidate in candidates {
        for source in &candidate.sources {
            let key = canonical_source_object_identity(&source.source_kind, &source.source_key)?;
            // Snapshot and Scope projection identities bind their original
            // sealed Run. Shared live Sources have no candidate Run scope.
            let owner = matches!(
                source.source_kind.as_str(),
                "snapshot-document" | "scope-dependency-projection-v1"
            )
            .then(|| candidate.owning_run_id.clone());
            let value = (source.revision_token.clone(), owner);
            if let Some(previous) = sources.insert(key, value.clone()) {
                ensure!(previous == value, "NIR1 input Source observations conflict");
            }
        }
    }
    sources
        .into_iter()
        .map(|(key, (token, owner))| {
            Ok(DependencyEdge {
                id: String::new(),
                project_id: project.into(),
                consumer_kind: "semantic-index".into(),
                consumer_key: INDEX_KEY.into(),
                source_object_identity: key,
                read_set_json: serde_json::to_string(&[token])?,
                generated_by_transaction_id: None,
                created_at: String::new(),
                owning_run_id: owner,
            })
        })
        .collect()
}
