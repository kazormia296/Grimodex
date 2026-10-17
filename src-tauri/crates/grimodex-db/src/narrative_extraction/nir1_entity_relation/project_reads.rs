//! The project-level reads one Graph query shares across the Revisions it
//! evaluates (CQ-AVAIL).
//!
//! A Revision's A2 current read and A3 disclosure check read some things that
//! are about the project and the query Scene, not about the Revision: the live
//! Scope authority (the tree, the Scene bindings, the registry), the latest
//! Semantic Epoch, and the query Scene's source, scope and viewpoint. Inside
//! one pinned read snapshot none of them can change, so a query that
//! evaluates N Revisions reads each of them once, not N times. The Graph query
//! admits the rows and bytes of exactly this set once, before its first read
//! (`nir1_graph::input::preflight_project_reads`); everything that belongs to
//! one Revision (payload, Decision, its Codex rows, its Evidence) is still read
//! and admitted per Revision.
//!
//! Only the reads are shared. Every gate still runs for every Revision, in the
//! order the unshared evaluation runs them, against the same values, so the
//! result for a Revision is the same as when it is evaluated alone
//! ([`evaluate_nir1_entity_relation_disclosure`] is that evaluation).

use std::collections::BTreeMap;

use anyhow::Result;
use grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1;
use grimodex_core::narrative_scene_scope::{
    NarrativeSceneScopeBindingV1, NarrativeScopeCompatibilityMarkerV1,
};
#[cfg(feature = "native-current-human-capture")]
use grimodex_core::narrative_scope_authority_basis::{
    NarrativeScopeAuthorityStoryTimeOrderV2, NarrativeScopeAuthorityUnresolvedReasonV2,
};
use rusqlite::Connection;
#[cfg(feature = "native-current-human-capture")]
use rusqlite::{params, OptionalExtension};

#[cfg(test)]
use super::super::nir1_capacity::project_read_probe::{self, Read};
use super::super::project_scope_authority::load_live_project_scope_authority_with_scene_bindings;
use super::super::retrieval_admission::{
    read_retrieval_scene_source, scene_axis, RetrievalSceneSourceRead,
};
use super::super::scene_scope::read_narrative_scene_scope;
use super::super::semantic_epoch::CurrentEpoch;
use super::{
    build_a3_story_status_index, check_active_work, is_validation_terminated,
    query_identity_is_resolved, read_scene_viewpoint, A3StoryKeyStatus, A3StoryStatusIndex,
};

/// Where an A3 evaluation gets the scope binding of a Scene.
pub(super) enum SceneScopes<'a> {
    /// One single-Scene read per call, as an evaluation of one Revision alone
    /// reads them.
    Read {
        conn: &'a Connection,
        project_id: &'a str,
    },
    /// The bindings the Scope authority's own read already validated.
    Loaded(&'a BTreeMap<String, NarrativeSceneScopeBindingV1>),
}

impl SceneScopes<'_> {
    /// The Scene's binding, or an error exactly when a single-Scene read of it
    /// fails (a missing or invalid row, a Scene outside the project); a
    /// validation stop propagates unchanged.
    pub(super) fn binding(&self, scene_id: &str) -> Result<NarrativeSceneScopeBindingV1> {
        match self {
            Self::Read { conn, project_id } => {
                read_narrative_scene_scope(conn, project_id, scene_id).map(|read| read.binding)
            }
            Self::Loaded(bindings) => bindings.get(scene_id).cloned().ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: no valid scope binding for scene '{scene_id}'"
                )
            }),
        }
    }
}

/// What the A3 gates on the query Scene found. None of it depends on the
/// Revision, so every Revision of a query meets the same one.
pub(super) enum A3QueryOutcome {
    Ready(Box<A3QueryContext>),
    /// The first gate that refused, as the reason every Revision then gets.
    Unavailable(&'static str),
}

pub(super) struct A3QueryContext {
    pub(super) phase_resolution_mode: String,
    /// `v{version}@{updated_at}` of the query Scene row.
    pub(super) source_token: String,
    pub(super) effective_axis: String,
    pub(super) axis_fallback_reason: Option<String>,
    /// Position of the query Scene in the authority's mappings.
    pub(super) mapping_index: usize,
    pub(super) scope: NarrativeSceneScopeBindingV1,
    pub(super) viewpoint: Option<String>,
}

/// The query-side A3 gates, in the order the evaluation of one Revision ran
/// them: the Scene's source, the Scope axis, the Scene's place in the
/// authority, its scope binding and its viewpoint.
pub(super) fn load_a3_query_context(
    conn: &Connection,
    project_id: &str,
    query_scene_id: &str,
    authority: &NarrativeProjectScopeAuthorityV1,
    story_statuses: &A3StoryStatusIndex,
    scenes: &SceneScopes<'_>,
) -> Result<A3QueryOutcome> {
    use A3QueryOutcome::Unavailable;
    #[cfg(test)]
    project_read_probe::record(Read::QueryScene);
    let query_source = match read_retrieval_scene_source(conn, project_id, query_scene_id)? {
        RetrievalSceneSourceRead::Available(source) if !source.archived => source,
        _ => return Ok(Unavailable("a3-query-scene-unavailable")),
    };
    let axis = match scene_axis::resolve(
        authority,
        &query_source.phase_resolution_mode,
        query_scene_id,
    ) {
        Ok(axis) => axis,
        Err(error) if is_validation_terminated(&error) => return Err(error),
        Err(_) => return Ok(Unavailable("a3-query-axis-unavailable")),
    };
    let Some(effective_axis) = axis.axis_used.as_deref() else {
        return Ok(Unavailable("a3-query-axis-unavailable"));
    };
    let query_ref = format!("scene:{query_scene_id}");
    let Some(mapping_index) = authority
        .mappings
        .iter()
        .position(|mapping| mapping.scene_ref == query_ref)
    else {
        return Ok(Unavailable("a3-query-scene-unavailable"));
    };
    if effective_axis == "story"
        && !matches!(
            story_statuses.status(&authority.mappings[mapping_index].scene_ref),
            A3StoryKeyStatus::Resolved(_)
        )
    {
        return Ok(Unavailable("a3-query-axis-unavailable"));
    }

    let scope = match scenes.binding(query_scene_id) {
        Ok(scope) => scope,
        Err(error) if is_validation_terminated(&error) => return Err(error),
        Err(_) => return Ok(Unavailable("a3-query-scope-unavailable")),
    };
    if scope.compatibility_marker != NarrativeScopeCompatibilityMarkerV1::Explicit
        || !query_identity_is_resolved(&scope.query_identity)
    {
        // Extended profile has no legacy/unknown/unresolved fallback.  In
        // particular a query Any is never manufactured from a missing value.
        return Ok(Unavailable("a3-query-scope-unavailable"));
    }
    #[cfg(test)]
    project_read_probe::record(Read::QueryViewpoint);
    let viewpoint = match read_scene_viewpoint(conn, project_id, query_scene_id) {
        Ok(viewpoint) => viewpoint,
        Err(error) if is_validation_terminated(&error) => return Err(error),
        Err(error)
            if error.downcast_ref::<rusqlite::Error>().is_some()
                || error.downcast_ref::<std::io::Error>().is_some() =>
        {
            return Err(error)
        }
        Err(_) => return Ok(Unavailable("a3-query-viewpoint-unavailable")),
    };
    Ok(A3QueryOutcome::Ready(Box::new(A3QueryContext {
        phase_resolution_mode: query_source.phase_resolution_mode,
        source_token: query_source.query_source.revision_token,
        effective_axis: effective_axis.to_owned(),
        axis_fallback_reason: axis.fallback_reason,
        mapping_index,
        scope,
        viewpoint,
    })))
}

/// The project-level reads of one Graph query, read once in its pinned
/// snapshot.
pub(crate) struct Nir1ProjectReads {
    project_id: String,
    query_scene_id: String,
    epoch: Option<CurrentEpoch>,
    /// None when the live Scope authority could not be loaded: every Revision
    /// is then unavailable as `source-revision-changed`, as when each loads it.
    authority: Option<NarrativeProjectScopeAuthorityV1>,
    scene_bindings: BTreeMap<String, NarrativeSceneScopeBindingV1>,
    story_statuses: A3StoryStatusIndex,
    /// Decided only when the authority loaded: with none, no Revision reaches
    /// the query-side gates.
    query: Option<A3QueryOutcome>,
}

impl Nir1ProjectReads {
    /// Read the shared set. The caller owns a read transaction and has
    /// admitted the rows and bytes of this set against its budget.
    pub(crate) fn load(conn: &Connection, project_id: &str, query_scene_id: &str) -> Result<Self> {
        anyhow::ensure!(
            !conn.is_autocommit(),
            "NIR1_ENTITY_RELATION_A3_REQUIRES_READ_TRANSACTION"
        );
        anyhow::ensure!(
            !project_id.trim().is_empty() && !query_scene_id.trim().is_empty(),
            "NIR1_ENTITY_RELATION_A3_INVALID_READ_REQUEST"
        );
        check_active_work(conn)?;
        let epoch = super::read_current_epoch(conn, project_id)?;
        check_active_work(conn)?;
        let loaded = load_live_project_scope_authority_with_scene_bindings(
            conn,
            project_id,
            &format!("project:scope-authority:{project_id}"),
        );
        let (authority, scene_bindings) = match loaded {
            Ok(read) => (Some(read.authority), read.scene_bindings),
            Err(error) if is_validation_terminated(&error) => return Err(error),
            Err(_) => (None, BTreeMap::new()),
        };
        let mut story_statuses = A3StoryStatusIndex::default();
        let mut query = None;
        if let Some(authority) = &authority {
            check_active_work(conn)?;
            story_statuses = build_a3_story_status_index(authority);
            check_active_work(conn)?;
            query = Some(load_a3_query_context(
                conn,
                project_id,
                query_scene_id,
                authority,
                &story_statuses,
                &SceneScopes::Loaded(&scene_bindings),
            )?);
        }
        Ok(Self {
            project_id: project_id.to_owned(),
            query_scene_id: query_scene_id.to_owned(),
            epoch,
            authority,
            scene_bindings,
            story_statuses,
            query,
        })
    }

    /// Whether these reads are about `project_id` and `query_scene_id`.
    pub(super) fn is_for(&self, project_id: &str, query_scene_id: &str) -> bool {
        self.project_id == project_id && self.query_scene_id == query_scene_id
    }

    pub(super) fn epoch(&self) -> Option<&CurrentEpoch> {
        self.epoch.as_ref()
    }

    pub(super) fn authority(&self) -> Option<&NarrativeProjectScopeAuthorityV1> {
        self.authority.as_ref()
    }

    pub(super) fn scene_scopes(&self) -> SceneScopes<'_> {
        SceneScopes::Loaded(&self.scene_bindings)
    }

    /// The Scene's binding as the shared reads hold it. Tests only.
    #[cfg(test)]
    pub(crate) fn scene_binding_for_test(
        &self,
        scene_id: &str,
    ) -> Result<NarrativeSceneScopeBindingV1> {
        self.scene_scopes().binding(scene_id)
    }

    pub(super) fn story_statuses(&self) -> &A3StoryStatusIndex {
        &self.story_statuses
    }

    pub(super) fn query(&self) -> Result<&A3QueryOutcome> {
        self.query
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("NIR1_ENTITY_RELATION_A3_SHARED_QUERY_UNAVAILABLE"))
    }
}

/// How the target Scene's own story key stands in the live Scope authority.
#[cfg(feature = "native-current-human-capture")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum HistoryStoryFact {
    /// The Scene's own key, unique in the project.
    Resolved { raw_story_key: String },
    /// The Scene has no key of its own but a key is inherited (forward-fill)
    /// from an earlier Scene. The inherited key is not the Scene's own.
    InheritedOnly,
    /// The key repeats in the project (a Chronicle stamp included).
    Ambiguous,
    /// The Scene has no key and nothing to inherit.
    NotProvided,
}

/// The target Scene's row in the live Scope authority's mapping.
#[cfg(feature = "native-current-human-capture")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HistoryMappingFacts {
    pub(crate) reading_order_ref: String,
    pub(crate) story_time_ref: String,
    pub(crate) reading_rank: u64,
    pub(crate) story: HistoryStoryFact,
}

/// The target Scene's explicit POV as `read_scene_viewpoint` reports it.
#[cfg(feature = "native-current-human-capture")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum HistoryViewpointFact {
    NotProvided,
    Pov(String),
    /// Another project, not a character, or hidden/suppressed (one error).
    NotVisibleCharacter,
}

/// The resolver's answer for the target Scene (ADR-002).
#[cfg(feature = "native-current-human-capture")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HistoryAutoFacts {
    pub(crate) setting: String,
    pub(crate) axis_used: String,
    pub(crate) fallback_reason: Option<String>,
}

/// What the history turn context (K4/3 sections 2 and 4) reads about the
/// target Scene, in the caller's read snapshot. It is built from the readers
/// `Nir1ProjectReads::load` uses (the epoch, the live Scope authority with its
/// Scene bindings, the story status index, the Scene viewpoint) but not from
/// `load` itself: `load` also reads the whole Scene body for the A3 query
/// context, which D-final has already read under its own byte budget.
#[cfg(feature = "native-current-human-capture")]
pub(crate) struct Nir1HistoryFacts {
    pub(crate) epoch: Option<CurrentEpoch>,
    /// `None` when the Scene is not in the live authority's mapping (an
    /// archived Scene or a Scene under an archived folder), or when the
    /// authority could not be loaded.
    pub(crate) mapping: Option<HistoryMappingFacts>,
    /// `None` exactly when `mapping` is `None`.
    pub(crate) auto: Option<HistoryAutoFacts>,
    /// The Scene's validated Scope binding, if the live authority's own read
    /// returned one for it.
    pub(crate) scope: Option<NarrativeSceneScopeBindingV1>,
    pub(crate) viewpoint: HistoryViewpointFact,
}

/// Read [`Nir1HistoryFacts`]. A stop of validation (cancel, deadline) and a
/// SQLite or IO error propagate; only a typed absence becomes a fact.
#[cfg(feature = "native-current-human-capture")]
pub(crate) fn load_history_facts(
    conn: &Connection,
    project_id: &str,
    query_scene_id: &str,
) -> Result<Nir1HistoryFacts> {
    anyhow::ensure!(
        !conn.is_autocommit(),
        "NIR1_ENTITY_RELATION_A3_REQUIRES_READ_TRANSACTION"
    );
    anyhow::ensure!(
        !project_id.trim().is_empty() && !query_scene_id.trim().is_empty(),
        "NIR1_ENTITY_RELATION_A3_INVALID_READ_REQUEST"
    );
    check_active_work(conn)?;
    let epoch = super::read_current_epoch(conn, project_id)?;
    check_active_work(conn)?;
    let loaded = load_live_project_scope_authority_with_scene_bindings(
        conn,
        project_id,
        &format!("project:scope-authority:{project_id}"),
    );
    let (authority, scene_bindings) = match loaded {
        Ok(read) => (Some(read.authority), read.scene_bindings),
        Err(error) if is_validation_terminated(&error) => return Err(error),
        Err(error)
            if error.downcast_ref::<rusqlite::Error>().is_some()
                || error.downcast_ref::<std::io::Error>().is_some() =>
        {
            return Err(error)
        }
        Err(_) => (None, BTreeMap::new()),
    };
    let scope = scene_bindings.get(query_scene_id).cloned();
    let scene_ref = format!("scene:{query_scene_id}");
    let mut mapping = None;
    let mut auto = None;
    if let Some(authority) = &authority {
        check_active_work(conn)?;
        let story_statuses = build_a3_story_status_index(authority);
        if let Some(row) = authority
            .mappings
            .iter()
            .find(|mapping| mapping.scene_ref == scene_ref)
        {
            let story = match &row.story_time_order {
                NarrativeScopeAuthorityStoryTimeOrderV2::Resolved { raw_story_key, .. } => {
                    HistoryStoryFact::Resolved {
                        raw_story_key: raw_story_key.clone(),
                    }
                }
                NarrativeScopeAuthorityStoryTimeOrderV2::Unresolved {
                    reason: NarrativeScopeAuthorityUnresolvedReasonV2::Ambiguous,
                    ..
                } => HistoryStoryFact::Ambiguous,
                NarrativeScopeAuthorityStoryTimeOrderV2::Unresolved { .. } => {
                    if matches!(
                        story_statuses.status(&row.scene_ref),
                        A3StoryKeyStatus::Resolved(_)
                    ) {
                        HistoryStoryFact::InheritedOnly
                    } else {
                        HistoryStoryFact::NotProvided
                    }
                }
            };
            mapping = Some(HistoryMappingFacts {
                reading_order_ref: row.reading_order_ref.clone(),
                story_time_ref: row.story_time_ref.clone(),
                reading_rank: row.reading_rank,
                story,
            });
            check_active_work(conn)?;
            let setting: String = conn
                .query_row(
                    "SELECT phase_resolution_mode FROM projects WHERE id = ?1",
                    params![project_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| anyhow::anyhow!("NIR1_HISTORY_CONTEXT_PROJECT_MISSING"))?;
            let axis = scene_axis::resolve(authority, &setting, query_scene_id)?;
            let axis_used = axis
                .axis_used
                .ok_or_else(|| anyhow::anyhow!("NIR1_HISTORY_CONTEXT_AXIS_UNRESOLVED"))?;
            auto = Some(HistoryAutoFacts {
                setting,
                axis_used,
                fallback_reason: axis.fallback_reason,
            });
        }
    }
    check_active_work(conn)?;
    let viewpoint = match read_scene_viewpoint(conn, project_id, query_scene_id) {
        Ok(None) => HistoryViewpointFact::NotProvided,
        Ok(Some(character)) => HistoryViewpointFact::Pov(character),
        Err(error) if is_validation_terminated(&error) => return Err(error),
        Err(error)
            if error.downcast_ref::<rusqlite::Error>().is_some()
                || error.downcast_ref::<std::io::Error>().is_some() =>
        {
            return Err(error)
        }
        Err(_) => HistoryViewpointFact::NotVisibleCharacter,
    };
    Ok(Nir1HistoryFacts {
        epoch,
        mapping,
        auto,
        scope,
        viewpoint,
    })
}
