use std::collections::BTreeMap;

use anyhow::{ensure, Result};
use rusqlite::Connection;

use super::super::nir1_entity_relation_index::GraphWorkControl;
use super::super::{
    c2zc_canonical_cutover::is_generic_freshness_canonical,
    dependency_edges::{canonical_source_object_identity, find_edges_by_consumer, DependencyEdge},
    material_membership_root::RunProofMemo,
    project_scope_authority::load_live_project_scope_authority,
    retrieval_admission::{
        build::{
            finalize_build_candidate_with_control, preflight_build_candidate_with_memo,
            BuildCandidate,
        },
        ChronicleRetrievalDocument,
    },
    revision_eligibility::pending::{self, FeedSnapshot},
    semantic_epoch::get_current_epoch,
};
use super::{
    binding::{self, BindingRead, StoredBinding},
    source, ChronicleReaderAdmission, NirChronicleIndexRuntime,
    NirIndexUnavailableReason as Reason, INDEX_KEY,
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

#[derive(Debug)]
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
    let mut control = super::super::source_revision::ForegroundValidationControl;
    prepare_chronicle_index_build_with_control(conn, runtime, project, &mut control)
}

pub fn prepare_chronicle_index_build_with_control(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    project: &str,
    control: &mut dyn GraphWorkControl,
) -> Result<NirIndexBuildRead> {
    control.check(super::super::nir1_entity_relation_index::GraphWorkStage::Source)?;
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
    if super::query::current_proof_with_control(conn, runtime, project, control)?.is_some() {
        return Ok(NirIndexBuildRead::AlreadyUsable);
    }
    let snapshot = match read_snapshot_with_control(conn, project, control)? {
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

/// DR-IRB-3: prepare on the dedicated read-only reader. Unlike
/// `prepare_chronicle_index_build_with_control` this never reads or checks the
/// connection-bound runtime epoch or proof: those belong to the authority's
/// connection (`chronicle_reader_admission`), and the reader has its own TEMP
/// connection meta. The plan carries the admission's owner and epoch, so a
/// reader result is only a candidate: publication re-checks both on the
/// authority. Everything from `read_snapshot_with_control` on is shared with
/// the authority path.
pub fn prepare_chronicle_index_build_on_reader(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    admission: &ChronicleReaderAdmission,
    project: &str,
    control: &mut dyn GraphWorkControl,
) -> Result<NirIndexBuildRead> {
    control.check(super::super::nir1_entity_relation_index::GraphWorkStage::Source)?;
    ensure!(
        !conn.is_autocommit(),
        "NIR1 preparation requires a read transaction"
    );
    ensure!(
        conn.pragma_query_value(None, "query_only", |row| row.get::<_, i64>(0))? == 1,
        "NIR1 reader preparation requires a query_only connection"
    );
    ensure!(
        !project.trim().is_empty() && project.trim() == project,
        "exact project identity required"
    );
    ensure!(
        conn.is_readonly(rusqlite::MAIN_DB)?,
        "NIR1 reader preparation requires a read-only main database"
    );
    ensure!(
        admission.owner == runtime.owner() && admission.project == project,
        "NIR1 reader admission belongs to another runtime or project"
    );
    if admission.proof_current {
        return Ok(NirIndexBuildRead::AlreadyUsable);
    }
    let snapshot = match read_snapshot_with_control(conn, project, control)? {
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
            owner: admission.owner,
            runtime_epoch: admission.runtime_epoch,
            snapshot,
        },
        documents,
    })
}

#[cfg(test)]
pub(super) fn read_snapshot(
    conn: &Connection,
    project: &str,
) -> Result<std::result::Result<BuildSnapshot, Reason>> {
    let mut control = super::super::source_revision::ForegroundValidationControl;
    read_snapshot_with_control(conn, project, &mut control)
}

pub(super) fn read_snapshot_with_control(
    conn: &Connection,
    project: &str,
    control: &mut dyn GraphWorkControl,
) -> Result<std::result::Result<BuildSnapshot, Reason>> {
    control.check(super::super::nir1_entity_relation_index::GraphWorkStage::Source)?;
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
    let roster = source::read_eligibility_source_with_control(conn, project, control)?;
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
    //
    // Roots of one Run share the Run-level receipt, artifact and Snapshot
    // proofs. This memo is local to this call (one read transaction): it is
    // dropped before the snapshot is returned and is never part of it. The
    // roster is counted per Run up front so a Run's proofs are dropped as soon
    // as its last roster revision is done (the roster order is by proposal id,
    // so a Run's revisions are spread over the whole walk). The count only
    // times that drop; a wrong count costs recomputation, not correctness.
    let mut preflights = Vec::new();
    let mut run_proofs = RunProofMemo::default();
    run_proofs.expect_revisions(conn, project, &roster.revisions)?;
    for revision in &roster.revisions {
        control.check(super::super::nir1_entity_relation_index::GraphWorkStage::Row)?;
        if let Ok(preflight) = preflight_build_candidate_with_memo(
            conn,
            project,
            revision,
            &authority,
            &mut run_proofs,
        )? {
            preflights.push(preflight);
        }
        run_proofs.finish_revision(project, revision);
    }
    drop(run_proofs);
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
    // The candidates' Freshness reads share the Scope read and the sealed Run
    // bindings of their Scope-dependency Sources (DR-IRB-6). Like the Run proof
    // memo, this is a local of this call (one read transaction) and is dropped
    // before the snapshot is returned; it is never part of it.
    let mut candidates = Vec::new();
    let mut freshness_reads = super::super::source_revision::CandidateFreshnessReads::default();
    for preflight in preflights {
        control.check(super::super::nir1_entity_relation_index::GraphWorkStage::Row)?;
        if let Ok(candidate) = finalize_build_candidate_with_control(
            conn,
            project,
            &authority,
            preflight,
            &material_scope_cache,
            control,
            Some(&mut freshness_reads),
        )? {
            candidates.push(candidate);
        }
    }
    drop(freshness_reads);
    let edges = input_edges(project, &roster.digest, &candidates)?;
    let feed = match pending::read(conn, project, &edges)? {
        Ok(value) => value,
        Err(_) => return Ok(Err(Reason::PendingChange)),
    };
    let input_guard = super::input_guard::read(conn, project, control)?;
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
pub(super) fn snapshot_current_with_control(
    conn: &Connection,
    project: &str,
    snapshot: &BuildSnapshot,
    control: &mut dyn GraphWorkControl,
) -> Result<bool> {
    control.check(super::super::nir1_entity_relation_index::GraphWorkStage::Source)?;
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
        || source::read_eligibility_source_with_control(conn, project, control)?.digest
            != snapshot.roster_digest
        || super::input_guard::read(conn, project, control)? != snapshot.input_guard
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
    for observation in
        super::super::restore_rebuild::evaluate_owned_edges_from_db_in_tx_with_control(
            conn,
            project,
            &snapshot.edges,
            control,
        )?
    {
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
