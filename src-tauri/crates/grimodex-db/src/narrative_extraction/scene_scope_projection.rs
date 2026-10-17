//! Scene Scope projection Source (`scene-scope-projection-v1`).
//!
//! A typed Revision that depends on one Scene's Scope (its anchor) binds that
//! Scene's projection instead of the whole project Scope authority. The
//! projection is a view Native computes from the project Scope authority and
//! the Scene's validated A1 binding in one SQLite snapshot. It owns no table,
//! column or mutable head; the token is the digest of a closed type.
//!
//! The token moves when the anchor's Scope moves: its Scope generation (the
//! binding `version`, advanced only by the writers listed in
//! `scope_writer_coverage_manifest`), its A1 meaning fields, its incarnation,
//! the registry refs the binding names, or its place in the live tree (a
//! Scene that is no longer live has no projection). It does not move for
//! another Scene's edits, for bodies, titles or display labels, for folder or
//! note renames, or for the project token. Rank, story keys, the other
//! Scenes' bindings, the binding's `updatedAt`/`sourceToken` and the tree's
//! `version`/`updatedAt` are deliberately outside it.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{anyhow, ensure};
use grimodex_core::narrative_nir1::ScopeValue;
use grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1;
use grimodex_core::narrative_scene_scope::{
    NarrativeSceneMaterialConstraintV1, NarrativeSceneQueryIdentityV1,
    NarrativeSceneScopeBindingV1, NarrativeScopeCompatibilityMarkerV1, NarrativeScopeConstraintV1,
    NarrativeScopePrincipalV1, NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID,
};
use grimodex_core::narrative_scope_authority_basis::NARRATIVE_SCOPE_AUTHORITY_REGISTRY_VERSION;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::dependency_edges::starts_with_legacy_source_prefix;
use super::project_scope_authority::{
    load_live_project_scope_authority_with_scene_bindings, LiveProjectScopeRead,
};

pub(crate) const SOURCE_KIND: &str = "scene-scope-projection-v1";
pub(crate) const SOURCE_PREFIX: &str = "project:scene-scope-projection:";
pub(crate) const CONTRACT_ID: &str = "narrative-scene-scope-projection/1";

/// The one reserved audience ref the projection of a non-secret Scope needs.
/// The prepare shape of `nir1.entity-relation@1` reveals to the reader only.
const REVEAL_READER_REF: &str = "reader";

/// The A1 meaning fields of the binding. Duplicated with the generation so a
/// writer that forgets to advance the generation is still caught.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProjectionBindingV1 {
    pub compatibility_marker: NarrativeScopeCompatibilityMarkerV1,
    pub query_identity: NarrativeSceneQueryIdentityV1,
    pub material_constraint: NarrativeSceneMaterialConstraintV1,
    pub knowledge_holder: NarrativeScopePrincipalV1,
    pub audience: NarrativeScopePrincipalV1,
}

/// The A1 registry's contract version and only the refs this binding names.
/// The registry's revision number and the refs the binding does not use are
/// not part of the projection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProjectionSceneRegistryV1 {
    pub registry_version: String,
    pub timeline_refs: Vec<String>,
    pub worldline_refs: Vec<String>,
    pub narrative_layer_refs: Vec<String>,
}

/// The Native authority registry's contract version and the reserved reveal
/// audience the non-secret Scope resolves against.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProjectionAuthorityRegistryV1 {
    pub registry_version: String,
    pub reveal_reader_ref: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SceneScopeProjectionV1 {
    pub contract_id: String,
    pub project_id: String,
    pub scene_id: String,
    pub scene_incarnation_id: String,
    /// The binding `version`. Never decreases within one incarnation and one
    /// restore epoch; a recreated binding starts again from 1 under a new
    /// incarnation.
    pub scope_generation: i64,
    pub binding: ProjectionBindingV1,
    pub scene_registry: ProjectionSceneRegistryV1,
    pub authority_registry: ProjectionAuthorityRegistryV1,
}

// ---------------------------------------------------------------------
// Failure codes (a closed set; the typed layer maps missing and stale to
// "absent" and every other code stays an error).
// ---------------------------------------------------------------------

fn key_invalid(detail: impl std::fmt::Display) -> anyhow::Error {
    anyhow!("NEX_SOURCE_KEY_INVALID: scene-scope-projection-v1 {detail}")
}

fn missing(detail: impl std::fmt::Display) -> anyhow::Error {
    anyhow!("NEX_SOURCE_MISSING: Scene Scope projection {detail}")
}

fn stale(detail: impl std::fmt::Display) -> anyhow::Error {
    anyhow!("NEX_SOURCE_STALE: Scene Scope projection {detail}")
}

fn project_mismatch(detail: impl std::fmt::Display) -> anyhow::Error {
    anyhow!("NEX_SOURCE_PROJECT_MISMATCH: Scene Scope projection {detail}")
}

// ---------------------------------------------------------------------
// Key grammar: `project:scene-scope-projection:<sceneId>`.
// ---------------------------------------------------------------------

fn validate_scene_id(scene_id: &str) -> anyhow::Result<()> {
    ensure!(
        !scene_id.is_empty(),
        key_invalid("sceneId must not be empty")
    );
    ensure!(
        scene_id.trim() == scene_id,
        key_invalid("sceneId must not contain surrounding whitespace")
    );
    // The same guard `project:scene:<id>` has: a key that is itself prefixed
    // is the stored shape of a double-prefix defect (`project:scene:<id>`
    // handed in as a projection id is the same mistake).
    ensure!(
        !starts_with_legacy_source_prefix(scene_id) && !scene_id.starts_with(SOURCE_PREFIX),
        key_invalid("sceneId must not itself carry a Source identity prefix")
    );
    Ok(())
}

/// The projection key of one Scene. The project is decided by the edge's
/// `project_id` and the resolver's check, not by the key.
pub(crate) fn source_key(scene_id: &str) -> anyhow::Result<String> {
    validate_scene_id(scene_id)?;
    Ok(format!("{SOURCE_PREFIX}{scene_id}"))
}

/// The Scene id of a projection key. Anything else fails closed.
pub(crate) fn scene_id_from_source_key(source_key: &str) -> anyhow::Result<&str> {
    let scene_id = source_key
        .strip_prefix(SOURCE_PREFIX)
        .ok_or_else(|| key_invalid(format!("sourceKey must be {SOURCE_PREFIX}<sceneId>")))?;
    validate_scene_id(scene_id)?;
    Ok(scene_id)
}

/// The Scene id an Entity's `scope.reading` ref names. A3 accepts both
/// `scene:<id>` and `reading:<id>`; both normalize to the Scene id.
pub(crate) fn anchor_scene_id_from_ref(reference: &str) -> Option<&str> {
    reference
        .strip_prefix("scene:")
        .or_else(|| reference.strip_prefix("reading:"))
        .filter(|id| !id.is_empty() && id.trim() == *id)
}

/// The anchor Scene of an Entity's reading. Only an `Exact` reading that
/// names a Scene has an anchor; every other value is not a projection input.
#[allow(dead_code)] // The typed Revision writer and reader use it from S2.
pub(crate) fn anchor_scene_id(reading: &ScopeValue) -> Option<&str> {
    match reading {
        ScopeValue::Exact { value } => anchor_scene_id_from_ref(value),
        _ => None,
    }
}

// ---------------------------------------------------------------------
// Projection and digest.
// ---------------------------------------------------------------------

fn referenced_registry_refs(
    binding: &NarrativeSceneScopeBindingV1,
) -> (BTreeSet<&str>, BTreeSet<&str>, BTreeSet<&str>) {
    let mut timeline = BTreeSet::new();
    let mut worldline = BTreeSet::new();
    let mut layer = BTreeSet::new();
    let query = &binding.query_identity;
    let material = &binding.material_constraint;
    for (set, constraints) in [
        (&mut timeline, [&query.timeline, &material.timeline]),
        (&mut worldline, [&query.worldline, &material.worldline]),
        (
            &mut layer,
            [&query.narrative_layer, &material.narrative_layer],
        ),
    ] {
        for constraint in constraints {
            if let NarrativeScopeConstraintV1::Exact { reference } = constraint {
                set.insert(reference.as_str());
            }
        }
    }
    (timeline, worldline, layer)
}

/// Build the projection from an already validated binding and the live
/// authority. No SQL is issued.
pub(crate) fn build_projection(
    binding: &NarrativeSceneScopeBindingV1,
    authority: &NarrativeProjectScopeAuthorityV1,
) -> anyhow::Result<SceneScopeProjectionV1> {
    let registry = &authority.scope_registry;
    ensure!(
        registry.registry_version == NARRATIVE_SCOPE_AUTHORITY_REGISTRY_VERSION,
        stale("authority registry contract is not supported")
    );
    ensure!(
        registry
            .reserved_audience_refs
            .iter()
            .filter(|reference| reference.as_str() == REVEAL_READER_REF)
            .count()
            == 1,
        stale("reveal reader audience is unavailable")
    );
    let (timeline, worldline, layer) = referenced_registry_refs(binding);
    let owned = |set: BTreeSet<&str>| set.into_iter().map(str::to_owned).collect::<Vec<_>>();
    Ok(SceneScopeProjectionV1 {
        contract_id: CONTRACT_ID.into(),
        project_id: binding.project_id.clone(),
        scene_id: binding.scene_id.clone(),
        scene_incarnation_id: binding.scene_incarnation_id.clone(),
        scope_generation: binding.version,
        binding: ProjectionBindingV1 {
            compatibility_marker: binding.compatibility_marker,
            query_identity: binding.query_identity.clone(),
            material_constraint: binding.material_constraint.clone(),
            knowledge_holder: binding.knowledge_holder.clone(),
            audience: binding.audience.clone(),
        },
        scene_registry: ProjectionSceneRegistryV1 {
            registry_version: NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID.into(),
            timeline_refs: owned(timeline),
            worldline_refs: owned(worldline),
            narrative_layer_refs: owned(layer),
        },
        authority_registry: ProjectionAuthorityRegistryV1 {
            registry_version: registry.registry_version.clone(),
            reveal_reader_ref: REVEAL_READER_REF.into(),
        },
    })
}

/// `sha256:<hex>` of the closed type's canonical JSON. The contract id is
/// part of the JSON, which is the digest's domain.
pub(crate) fn projection_token(projection: &SceneScopeProjectionV1) -> anyhow::Result<String> {
    Ok(grimodex_core::canonical_json_digest(
        &serde_json::to_value(projection)?,
    )?)
}

// ---------------------------------------------------------------------
// Resolution. The pure core takes the live authority and the validated
// bindings from the same read (`LiveProjectScopeRead`) and issues no SQL.
// ---------------------------------------------------------------------

/// Resolve one projection key against a shared Scope read.
///
/// - `NEX_SOURCE_KEY_INVALID`: the key is not `project:scene-scope-projection:<sceneId>`.
/// - `NEX_SOURCE_PROJECT_MISMATCH`: the read or binding belongs to another project.
/// - `NEX_SOURCE_MISSING`: the Scene has no validated binding (deleted, never
///   bound, or the binding failed the validation the authority read applies).
/// - `NEX_SOURCE_STALE`: the Scene exists but is not exactly one live mapping
///   (archived, unreachable under an archived ancestor, ambiguous or an
///   inconsistent mapping), or the authority registry cannot reveal.
pub(crate) fn resolve_with_authority(
    project_id: &str,
    source_key: &str,
    authority: &NarrativeProjectScopeAuthorityV1,
    scene_bindings: &BTreeMap<String, NarrativeSceneScopeBindingV1>,
) -> anyhow::Result<String> {
    let scene_id = scene_id_from_source_key(source_key)?;
    ensure!(
        authority.project_id == project_id,
        project_mismatch("authority belongs to another project")
    );
    let Some(binding) = scene_bindings.get(scene_id) else {
        return Err(missing(format!(
            "has no validated binding for Scene '{scene_id}'"
        )));
    };
    ensure!(
        binding.project_id == project_id && binding.scene_id == scene_id,
        project_mismatch("binding does not belong to the project and Scene")
    );
    let scene_ref = format!("scene:{scene_id}");
    let mut live = authority
        .mappings
        .iter()
        .filter(|mapping| mapping.scene_ref == scene_ref);
    let mapping = live.next().ok_or_else(|| {
        stale(format!(
            "Scene '{scene_id}' is not live (archived or unreachable)"
        ))
    })?;
    ensure!(
        live.next().is_none() && mapping.source_key == format!("project:scene:{scene_id}"),
        stale(format!(
            "Scene '{scene_id}' mapping is ambiguous or inconsistent"
        ))
    );
    projection_token(&build_projection(binding, authority)?)
}

/// [`resolve_with_authority`] over the read that carries both halves.
pub(crate) fn resolve_with_read(
    project_id: &str,
    source_key: &str,
    read: &LiveProjectScopeRead,
) -> anyhow::Result<String> {
    resolve_with_authority(
        project_id,
        source_key,
        &read.authority,
        &read.scene_bindings,
    )
}

/// The key is checked before any read so a malformed key never costs one.
pub(crate) fn load_scope_read(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<LiveProjectScopeRead> {
    load_live_project_scope_authority_with_scene_bindings(
        conn,
        project_id,
        &format!("project:scope-authority:{project_id}"),
    )
}

/// Resolve one projection key for a caller that holds no shared read. It
/// reads the project Scope authority and the bindings once, in one snapshot
/// (the loader's own savepoint), then resolves; callers that resolve several
/// anchors share a [`LiveProjectScopeRead`] instead.
pub(crate) fn resolve(
    conn: &Connection,
    project_id: &str,
    source_key: &str,
) -> anyhow::Result<String> {
    scene_id_from_source_key(source_key)?;
    let read = load_scope_read(conn, project_id)?;
    resolve_with_read(project_id, source_key, &read)
}

/// The typed layer's view of a resolution: a Scene that is missing or no
/// longer live has no token (`None`); every other failure stays an error.
pub(crate) fn token_or_absent(resolved: anyhow::Result<String>) -> anyhow::Result<Option<String>> {
    match resolved {
        Ok(token) => Ok(Some(token)),
        Err(error) => {
            let message = error.to_string();
            if message.starts_with("NEX_SOURCE_MISSING") || message.starts_with("NEX_SOURCE_STALE")
            {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}

#[cfg(test)]
pub(in crate::narrative_extraction) mod tests {
    use super::*;
    use crate::domain_writes::{
        tree_node_delete, tree_node_patch, TreeNodeDeletePayload, TreeNodePatchPayload,
    };
    use crate::narrative_extraction::change_feed::NarrativeChangeOrigin;
    use crate::narrative_extraction::dependency_edges::DependencyEdge;
    use crate::narrative_extraction::nir1_capacity::project_read_probe::{self, Read};
    use crate::narrative_extraction::restore_rebuild::evaluate_owned_edges_from_db_in_tx;
    use crate::narrative_extraction::scene_scope::{
        ensure_scene_scope_binding_in_tx, read_narrative_scene_scope, update_narrative_scene_scope,
        update_narrative_scene_scope_registry, NarrativeSceneScopeRegistryUpdatePayload,
        NarrativeSceneScopeUpdatePayload, NarrativeSceneScopeUpdateV1,
    };
    use crate::test_support::fresh_migrated_memory;
    use crate::Database;
    use grimodex_core::narrative_project_scope_authority::{
        build_narrative_project_scope_authority_v1, NarrativeProjectScopeAuthoritySceneInputV1,
    };
    use grimodex_core::narrative_scene_scope::NarrativeSceneScopeRegistryV1;
    use rusqlite::params;
    use serde_json::{json, Value};
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicUsize, Ordering};

    pub(in crate::narrative_extraction) const P: &str = "p1";

    // ---- pure fixtures -------------------------------------------------

    pub(in crate::narrative_extraction) fn constraint(
        reference: &str,
    ) -> NarrativeScopeConstraintV1 {
        NarrativeScopeConstraintV1::Exact {
            reference: reference.into(),
        }
    }

    fn pure_binding(scene_id: &str) -> NarrativeSceneScopeBindingV1 {
        NarrativeSceneScopeBindingV1 {
            schema_version: 1,
            project_id: P.into(),
            scene_id: scene_id.into(),
            scene_incarnation_id: format!("inc-{scene_id}"),
            compatibility_marker: NarrativeScopeCompatibilityMarkerV1::Explicit,
            query_identity: NarrativeSceneQueryIdentityV1 {
                timeline: constraint("timeline:main"),
                worldline: constraint("worldline:prime"),
                narrative_layer: constraint("layer:manuscript"),
            },
            material_constraint: NarrativeSceneMaterialConstraintV1 {
                timeline: NarrativeScopeConstraintV1::Any,
                worldline: NarrativeScopeConstraintV1::Any,
                narrative_layer: NarrativeScopeConstraintV1::Any,
            },
            knowledge_holder: NarrativeScopePrincipalV1::Reader {},
            audience: NarrativeScopePrincipalV1::Reader {},
            version: 3,
            source_token: "token-a".into(),
            updated_at: "2026-10-17T00:00:00.000Z".into(),
        }
    }

    fn pure_authority(project_id: &str, scene_ids: &[&str]) -> NarrativeProjectScopeAuthorityV1 {
        let scenes = scene_ids
            .iter()
            .map(|id| NarrativeProjectScopeAuthoritySceneInputV1 {
                scene_id: (*id).into(),
                raw_story_key: None,
            })
            .collect::<Vec<_>>();
        build_narrative_project_scope_authority_v1(project_id, &scenes).expect("authority")
    }

    fn pure_token(
        binding: &NarrativeSceneScopeBindingV1,
        authority: &NarrativeProjectScopeAuthorityV1,
    ) -> String {
        let bindings = BTreeMap::from([(binding.scene_id.clone(), binding.clone())]);
        resolve_with_authority(
            &binding.project_id,
            &source_key(&binding.scene_id).unwrap(),
            authority,
            &bindings,
        )
        .expect("token")
    }

    fn code<T: std::fmt::Debug>(result: anyhow::Result<T>) -> String {
        result
            .expect_err("must fail closed")
            .to_string()
            .split(':')
            .next()
            .unwrap_or_default()
            .to_owned()
    }

    // ---- key grammar ---------------------------------------------------

    #[test]
    fn key_grammar_is_exact_and_rejects_prefix_confusion() {
        assert_eq!(
            source_key("s1").unwrap(),
            "project:scene-scope-projection:s1"
        );
        assert_eq!(
            scene_id_from_source_key("project:scene-scope-projection:s1").unwrap(),
            "s1"
        );
        for bad in [
            "",
            "project:scene-scope-projection:",
            "project:scene-scope-projection: s1",
            "project:scene-scope-projection:s1 ",
            // The body Source's key is not a projection key.
            "project:scene:s1",
            "project:scene-scope-projection:project:scene-scope-projection:s1",
            "project:scene-scope-projection:project:scene:s1",
            "project:scene-scope-projection:snapshot:run-1",
            "scene-scope-projection:s1",
            "s1",
        ] {
            assert_eq!(
                code(scene_id_from_source_key(bad)),
                "NEX_SOURCE_KEY_INVALID",
                "key {bad:?}"
            );
        }
        for bad_id in [
            "",
            " s1",
            "s1 ",
            "project:scene:s1",
            "project:scene-scope-projection:s1",
        ] {
            assert!(source_key(bad_id).is_err(), "id {bad_id:?}");
        }
    }

    #[test]
    fn anchor_normalizes_scene_and_reading_refs_and_rejects_the_rest() {
        assert_eq!(anchor_scene_id_from_ref("scene:s1"), Some("s1"));
        assert_eq!(anchor_scene_id_from_ref("reading:s1"), Some("s1"));
        for bad in ["scene:", "reading:", "story:s1", "s1", "scene: s1", ""] {
            assert_eq!(anchor_scene_id_from_ref(bad), None, "{bad:?}");
        }
        assert_eq!(
            anchor_scene_id(&ScopeValue::Exact {
                value: "reading:s2".into()
            }),
            Some("s2")
        );
        for value in [
            ScopeValue::Any { purpose: None },
            ScopeValue::LegacyAbsent,
            ScopeValue::Unresolved,
            ScopeValue::Exact {
                value: "chapter:c1".into(),
            },
        ] {
            assert_eq!(anchor_scene_id(&value), None);
        }
    }

    // ---- digest: what is in and what is out ----------------------------

    #[test]
    fn token_changes_for_every_input_and_ignores_every_non_input() {
        let authority = pure_authority(P, &["s1", "s2"]);
        let base = pure_binding("s1");
        let base_token = pure_token(&base, &authority);
        assert!(base_token.starts_with("sha256:"));

        type BindingEdit = Box<dyn Fn(&mut NarrativeSceneScopeBindingV1)>;
        let edits: Vec<(&str, BindingEdit)> = vec![
            ("generation", Box::new(|b| b.version += 1)),
            (
                "incarnation",
                Box::new(|b| b.scene_incarnation_id = "inc-other".into()),
            ),
            (
                "marker",
                Box::new(|b| b.compatibility_marker = NarrativeScopeCompatibilityMarkerV1::Unknown),
            ),
            (
                "queryIdentity",
                Box::new(|b| b.query_identity.timeline = constraint("timeline:alt")),
            ),
            (
                "materialConstraint",
                Box::new(|b| b.material_constraint.worldline = constraint("worldline:prime")),
            ),
            (
                "holder",
                Box::new(|b| {
                    b.knowledge_holder = NarrativeScopePrincipalV1::Character {
                        reference: "c1".into(),
                    }
                }),
            ),
            (
                "audience",
                Box::new(|b| {
                    b.audience = NarrativeScopePrincipalV1::Character {
                        reference: "c1".into(),
                    }
                }),
            ),
        ];
        let mut seen = HashSet::from([base_token.clone()]);
        for (label, edit) in &edits {
            let mut binding = base.clone();
            edit(&mut binding);
            assert!(
                seen.insert(pure_token(&binding, &authority)),
                "{label} must produce a new token"
            );
        }

        // Non-inputs: the binding's own timestamp and source token, and the
        // rest of the project (the other Scene's presence and order).
        let mut touched = base.clone();
        touched.updated_at = "2030-01-01T00:00:00.000Z".into();
        touched.source_token = "token-b".into();
        assert_eq!(pure_token(&touched, &authority), base_token);
        assert_eq!(
            pure_token(&base, &pure_authority(P, &["s2", "s1"])),
            base_token,
            "reading rank is not an input"
        );
        assert_eq!(
            pure_token(&base, &pure_authority(P, &["s1"])),
            base_token,
            "the other Scene is not an input"
        );

        // The project is an input (a coherent other project gets another token).
        let mut other = base.clone();
        other.project_id = "p2".into();
        assert_ne!(
            pure_token(&other, &pure_authority("p2", &["s1"])),
            base_token
        );
    }

    #[test]
    fn the_projection_is_a_closed_type_without_body_title_rank_or_project_token() {
        let projection =
            build_projection(&pure_binding("s1"), &pure_authority(P, &["s1"])).expect("projection");
        let value = serde_json::to_value(&projection).expect("json");
        let mut keys = value
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        assert_eq!(
            keys,
            [
                "authorityRegistry",
                "binding",
                "contractId",
                "projectId",
                "sceneId",
                "sceneIncarnationId",
                "sceneRegistry",
                "scopeGeneration"
            ]
        );
        assert_eq!(value["contractId"], "narrative-scene-scope-projection/1");
        assert_eq!(
            value["authorityRegistry"]["registryVersion"],
            "narrative-scope/2"
        );
        assert_eq!(
            value["sceneRegistry"],
            json!({
                "registryVersion": "narrative-scene-scope-registry/1",
                "timelineRefs": ["timeline:main"],
                "worldlineRefs": ["worldline:prime"],
                "narrativeLayerRefs": ["layer:manuscript"],
            }),
            "only the refs the binding names"
        );
        // Unknown fields are rejected on the way back in (closed type).
        let mut extended = value.clone();
        extended["title"] = json!("Scene");
        assert!(serde_json::from_value::<SceneScopeProjectionV1>(extended).is_err());
        assert_eq!(
            serde_json::from_value::<SceneScopeProjectionV1>(value).unwrap(),
            projection
        );
        // The rendered JSON never carries these keys.
        let text = serde_json::to_string(&projection).unwrap();
        for forbidden in [
            "revisionToken",
            "readingRank",
            "storyTime",
            "updatedAt",
            "sourceToken",
            "title",
            "synopsis",
            "body",
        ] {
            assert!(!text.contains(forbidden), "projection leaks {forbidden}");
        }
    }

    #[test]
    fn an_unusable_authority_registry_fails_closed_as_stale() {
        let mut authority = pure_authority(P, &["s1"]);
        authority.scope_registry.reserved_audience_refs.clear();
        let bindings = BTreeMap::from([("s1".to_owned(), pure_binding("s1"))]);
        assert_eq!(
            code(resolve_with_authority(
                P,
                &source_key("s1").unwrap(),
                &authority,
                &bindings
            )),
            "NEX_SOURCE_STALE"
        );
    }

    #[test]
    fn pure_resolution_classifies_project_mismatch_missing_and_stale() {
        let authority = pure_authority(P, &["s1"]);
        let bindings = BTreeMap::from([
            ("s1".to_owned(), pure_binding("s1")),
            ("archived".to_owned(), pure_binding("archived")),
        ]);
        let key = |id: &str| source_key(id).unwrap();
        resolve_with_authority(P, &key("s1"), &authority, &bindings).expect("live Scene");
        // A read of another project never resolves this project's key.
        assert_eq!(
            code(resolve_with_authority(
                "p2",
                &key("s1"),
                &authority,
                &bindings
            )),
            "NEX_SOURCE_PROJECT_MISMATCH"
        );
        // A binding owned by another project that reaches the map is refused.
        let mut foreign = pure_binding("s1");
        foreign.project_id = "p2".into();
        let foreign_bindings = BTreeMap::from([("s1".to_owned(), foreign)]);
        assert_eq!(
            code(resolve_with_authority(
                P,
                &key("s1"),
                &authority,
                &foreign_bindings
            )),
            "NEX_SOURCE_PROJECT_MISMATCH"
        );
        // No validated binding: missing. A binding whose Scene is not a live
        // mapping (archived, or unreachable under an archived ancestor): stale.
        assert_eq!(
            code(resolve_with_authority(
                P,
                &key("nope"),
                &authority,
                &bindings
            )),
            "NEX_SOURCE_MISSING"
        );
        assert_eq!(
            code(resolve_with_authority(
                P,
                &key("archived"),
                &authority,
                &bindings
            )),
            "NEX_SOURCE_STALE"
        );
        // An ambiguous or inconsistent mapping is stale, never a token.
        let mut doubled = authority.clone();
        doubled.mappings.push(doubled.mappings[0].clone());
        assert_eq!(
            code(resolve_with_authority(P, &key("s1"), &doubled, &bindings)),
            "NEX_SOURCE_STALE"
        );
        let mut wrong_source = authority.clone();
        wrong_source.mappings[0].source_key = "project:scene:other".into();
        assert_eq!(
            code(resolve_with_authority(
                P,
                &key("s1"),
                &wrong_source,
                &bindings
            )),
            "NEX_SOURCE_STALE"
        );
        // Malformed keys never reach the lookup.
        assert_eq!(
            code(resolve_with_authority(
                P,
                "project:scene:s1",
                &authority,
                &bindings
            )),
            "NEX_SOURCE_KEY_INVALID"
        );
    }

    #[test]
    fn the_typed_layer_sees_missing_and_stale_as_absent_and_nothing_else() {
        assert_eq!(token_or_absent(Ok("t".into())).unwrap(), Some("t".into()));
        for absent in ["NEX_SOURCE_MISSING: x", "NEX_SOURCE_STALE: x"] {
            assert_eq!(token_or_absent(Err(anyhow!(absent))).unwrap(), None);
        }
        for failing in [
            "NEX_SOURCE_PROJECT_MISMATCH: x",
            "NEX_SOURCE_KEY_INVALID: x",
            "database is locked",
        ] {
            assert!(token_or_absent(Err(anyhow!(failing))).is_err(), "{failing}");
        }
    }

    // ---- SQLite-backed fixtures ----------------------------------------

    static SEQUENCE: AtomicUsize = AtomicUsize::new(1);

    fn next() -> usize {
        SEQUENCE.fetch_add(1, Ordering::SeqCst)
    }

    fn stamp() -> String {
        format!(
            "2026-10-17T01:{:02}:{:02}.000Z",
            (next() / 60) % 60,
            next() % 60
        )
    }

    pub(in crate::narrative_extraction) fn registry_refs() -> NarrativeSceneScopeRegistryV1 {
        NarrativeSceneScopeRegistryV1 {
            registry_version: NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID.into(),
            timeline_refs: vec!["timeline:main".into(), "timeline:alt".into()],
            worldline_refs: vec!["worldline:prime".into()],
            narrative_layer_refs: vec!["layer:manuscript".into()],
        }
    }

    /// Project p1: folders f1 (holds s1 and s2) and empty f3; scenes s1, s2 in
    /// f1 and s3 at the root; a note n1; a character c1; a second project p2
    /// with its own Scene sp2. Every Scene is bound.
    pub(in crate::narrative_extraction) fn fixture() -> Database {
        let db = fresh_migrated_memory().expect("migrated database");
        db.with_conn(|conn| {
            for project in ["p1", "p2"] {
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES (?1, 'Project')",
                    [project],
                )?;
            }
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name)
                 VALUES ('c1', 'p1', 'character', 'Character')",
                [],
            )?;
            for (id, project, kind, parent, order) in [
                ("f1", "p1", "folder", None, "a0"),
                ("f3", "p1", "folder", None, "b0"),
                ("s1", "p1", "scene", Some("f1"), "e0"),
                ("s2", "p1", "scene", Some("f1"), "e5"),
                ("s3", "p1", "scene", None, "c0"),
                ("n1", "p1", "note", None, "d0"),
                ("sp2", "p2", "scene", None, "a0"),
            ] {
                conn.execute(
                    "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, parent_id)
                     VALUES (?1, ?2, ?3, ?1, ?4, ?5)",
                    params![id, project, kind, order, parent],
                )?;
                if kind == "scene" {
                    ensure_scene_scope_binding_in_tx(
                        conn,
                        project,
                        id,
                        "2026-10-17T00:00:00.000Z",
                    )?;
                }
            }
            Ok(())
        })
        .expect("seed");
        update_registry(&db, registry_refs());
        db
    }

    pub(in crate::narrative_extraction) fn update_registry(
        db: &Database,
        registry: NarrativeSceneScopeRegistryV1,
    ) {
        let base_version = db
            .with_read_transaction(|conn| {
                Ok(read_narrative_scene_scope(conn, P, "s1")?.registry_revision)
            })
            .expect("registry revision");
        let n = next();
        update_narrative_scene_scope_registry(
            db,
            NarrativeSceneScopeRegistryUpdatePayload {
                project_id: P.into(),
                request_id: format!("registry-{n}"),
                session_id: "session".into(),
                event_uid: format!("registry-event-{n}"),
                base_version,
                updated_at: stamp(),
                registry,
            },
        )
        .expect("registry update");
    }

    pub(in crate::narrative_extraction) fn set_scope(
        db: &Database,
        scene: &str,
        edit: impl FnOnce(&mut NarrativeSceneScopeUpdateV1),
    ) {
        let current = db
            .with_read_transaction(|conn| read_narrative_scene_scope(conn, P, scene))
            .expect("current scope");
        let mut scope = NarrativeSceneScopeUpdateV1 {
            schema_version: 1,
            compatibility_marker: current.binding.compatibility_marker,
            query_identity: current.binding.query_identity.clone(),
            material_constraint: current.binding.material_constraint.clone(),
            knowledge_holder: current.binding.knowledge_holder.clone(),
            audience: current.binding.audience.clone(),
        };
        edit(&mut scope);
        let n = next();
        update_narrative_scene_scope(
            db,
            NarrativeSceneScopeUpdatePayload {
                project_id: P.into(),
                scene_id: scene.into(),
                request_id: format!("scope-{n}"),
                session_id: "session".into(),
                event_uid: format!("scope-event-{n}"),
                base_version: current.binding.version,
                updated_at: stamp(),
                scope,
            },
        )
        .expect("scope update");
    }

    pub(in crate::narrative_extraction) fn explicit(
        scope: &mut NarrativeSceneScopeUpdateV1,
        timeline: &str,
    ) {
        scope.compatibility_marker = NarrativeScopeCompatibilityMarkerV1::Explicit;
        scope.query_identity = NarrativeSceneQueryIdentityV1 {
            timeline: constraint(timeline),
            worldline: constraint("worldline:prime"),
            narrative_layer: constraint("layer:manuscript"),
        };
    }

    pub(in crate::narrative_extraction) fn patch(
        db: &Database,
        node: &str,
        field: &str,
        value: Value,
        bump_version: bool,
    ) {
        let n = next();
        let mut patch = serde_json::Map::new();
        patch.insert(field.to_owned(), value);
        tree_node_patch(
            db,
            TreeNodePatchPayload {
                project_id: P.into(),
                request_id: format!("patch-{n}"),
                session_id: "session".into(),
                event_uid: format!("patch-event-{n}"),
                node_id: node.into(),
                patch,
                base_version: None,
                bump_version,
                updated_at: format!("2026-10-17T02:{:02}:{:02}.{:03}Z", (n / 60) % 60, n % 60, n),
                change_event: None,
                timelapse_doc_step_coverage: None,
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                undo_journal_id: None,
                source_domain: None,
                op_type: None,
                canonical_payload: None,
            },
        )
        .expect("patch");
    }

    fn resolve_in(db: &Database, project: &str, scene: &str) -> anyhow::Result<String> {
        db.with_read_transaction(|conn| resolve(conn, project, &source_key(scene)?))
    }

    fn token(db: &Database, scene: &str) -> String {
        resolve_in(db, P, scene).unwrap_or_else(|error| panic!("{scene}: {error}"))
    }

    fn project_token(db: &Database) -> String {
        db.with_read_transaction(|conn| {
            Ok(
                super::super::project_scope_authority::load_live_project_scope_authority(
                    conn,
                    P,
                    "project:scope-authority:p1",
                )?
                .source
                .revision_token,
            )
        })
        .expect("project token")
    }

    // ---- behavior against the real writers -----------------------------

    #[test]
    fn edits_that_are_not_the_anchors_scope_leave_its_token_alone() {
        let db = fixture();
        set_scope(&db, "s1", |scope| explicit(scope, "timeline:main"));
        let before = token(&db, "s1");
        let project_before = project_token(&db);

        // The anchor's own body-Source fields.
        for (field, first, second) in [
            ("title", "Renamed", "Renamed again"),
            ("synopsis", "A synopsis", "Another synopsis"),
            ("status", "revision", "final"),
            ("storyTimeLabel", "Day 3", "Day 4"),
        ] {
            patch(&db, "s1", field, json!(first), true);
            patch(&db, "s1", field, json!(second), false);
        }
        assert_eq!(token(&db, "s1"), before, "display fields");

        // Other Scenes: scope, POV, story key, move, creation.
        set_scope(&db, "s2", |scope| explicit(scope, "timeline:alt"));
        patch(&db, "s2", "povCharacterId", json!("c1"), true);
        patch(&db, "s2", "storyTimeOrder", json!("a1"), true);
        patch(&db, "s3", "sortOrder", json!("c5"), true);
        patch(&db, "s2", "sortOrder", json!("e7"), true);
        assert_eq!(token(&db, "s1"), before, "another Scene's edits");

        // A folder or note rename, and any operation on an empty folder or a note.
        patch(&db, "f1", "title", json!("Chapter"), true);
        patch(&db, "f3", "sortOrder", json!("b5"), true);
        patch(
            &db,
            "f3",
            "archivedAt",
            json!("2026-10-17T03:00:00.000Z"),
            true,
        );
        patch(&db, "f3", "archivedAt", Value::Null, true);
        patch(&db, "n1", "sortOrder", json!("d5"), true);
        patch(
            &db,
            "n1",
            "archivedAt",
            json!("2026-10-17T03:00:01.000Z"),
            true,
        );
        assert_eq!(token(&db, "s1"), before, "empty folder and note operations");

        // The project token moved for the other Scenes' edits; the projection did not.
        assert_ne!(project_token(&db), project_before);
    }

    #[test]
    fn the_anchors_scope_moves_the_token_and_round_trips_never_return() {
        let db = fixture();
        let mut seen = HashSet::new();
        let mut observe = |db: &Database, label: &str| {
            assert!(
                seen.insert(token(db, "s1")),
                "{label}: the token must be one never seen before"
            );
        };
        observe(&db, "initial");

        // A1 settings X -> Y -> X (and a field per step).
        set_scope(&db, "s1", |scope| explicit(scope, "timeline:main"));
        observe(&db, "X");
        set_scope(&db, "s1", |scope| explicit(scope, "timeline:alt"));
        observe(&db, "Y");
        set_scope(&db, "s1", |scope| explicit(scope, "timeline:main"));
        observe(&db, "X again");
        set_scope(&db, "s1", |scope| {
            scope.material_constraint.worldline = constraint("worldline:prime")
        });
        observe(&db, "material constraint");
        set_scope(&db, "s1", |scope| {
            scope.knowledge_holder = NarrativeScopePrincipalV1::Character {
                reference: "c1".into(),
            }
        });
        observe(&db, "holder");
        set_scope(&db, "s1", |scope| {
            scope.audience = NarrativeScopePrincipalV1::Character {
                reference: "c1".into(),
            }
        });
        observe(&db, "audience");

        // The Scene's own tree place: move, order, POV, story key.
        patch(&db, "s1", "sortOrder", json!("e3"), true);
        observe(&db, "sortOrder");
        patch(&db, "s1", "sortOrder", json!("e0"), true);
        observe(&db, "sortOrder back");
        patch(&db, "s1", "parentId", Value::Null, true);
        observe(&db, "parent");
        patch(&db, "s1", "parentId", json!("f1"), true);
        observe(&db, "parent back");
        patch(&db, "s1", "povCharacterId", json!("c1"), true);
        observe(&db, "POV");
        patch(&db, "s1", "storyTimeOrder", json!("a1"), true);
        observe(&db, "story key");

        // Archive makes it stale, and bringing it back does not restore a token.
        patch(
            &db,
            "s1",
            "archivedAt",
            json!("2026-10-17T03:00:00.000Z"),
            true,
        );
        assert_eq!(code(resolve_in(&db, P, "s1")), "NEX_SOURCE_STALE");
        patch(&db, "s1", "archivedAt", Value::Null, true);
        observe(&db, "unarchived");

        // A folder that holds live Scenes moves the Scenes below it only.
        let sibling = token(&db, "s3");
        patch(&db, "f1", "sortOrder", json!("a7"), true);
        observe(&db, "ancestor folder order");
        patch(&db, "f1", "sortOrder", json!("a0"), true);
        observe(&db, "ancestor folder order back");
        patch(
            &db,
            "f1",
            "archivedAt",
            json!("2026-10-17T03:00:01.000Z"),
            true,
        );
        assert_eq!(
            code(resolve_in(&db, P, "s1")),
            "NEX_SOURCE_STALE",
            "a Scene under an archived ancestor is not live"
        );
        patch(&db, "f1", "archivedAt", Value::Null, true);
        observe(&db, "ancestor folder unarchived");
        assert_eq!(token(&db, "s3"), sibling, "a Scene outside the folder");
    }

    #[test]
    fn a_registry_change_moves_every_scenes_token() {
        let db = fixture();
        let (s1, s3) = (token(&db, "s1"), token(&db, "s3"));
        let mut registry = registry_refs();
        registry.timeline_refs.push("timeline:extra".into());
        update_registry(&db, registry);
        assert_ne!(token(&db, "s1"), s1);
        assert_ne!(token(&db, "s3"), s3);
        // ... and registry A -> B -> A does not bring the first token back.
        update_registry(&db, registry_refs());
        assert_ne!(token(&db, "s1"), s1);
    }

    #[test]
    fn a_deleted_scene_is_missing_and_a_recreated_one_is_a_new_projection() {
        let db = fixture();
        let original = token(&db, "s3");
        let n = next();
        tree_node_delete(
            &db,
            TreeNodeDeletePayload {
                project_id: P.into(),
                request_id: format!("delete-{n}"),
                session_id: "session".into(),
                event_uid: format!("delete-event-{n}"),
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                undo_journal_id: None,
                node_id: "s3".into(),
                canonical_payload: None,
            },
        )
        .expect("delete");
        assert_eq!(code(resolve_in(&db, P, "s3")), "NEX_SOURCE_MISSING");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order)
                 VALUES ('s3', 'p1', 'scene', 's3', 'c0')",
                [],
            )?;
            ensure_scene_scope_binding_in_tx(conn, P, "s3", "2026-10-17T04:00:00.000Z")?;
            Ok(())
        })
        .expect("recreate under the same id");
        assert_ne!(token(&db, "s3"), original, "a new incarnation");
    }

    #[test]
    fn unresolvable_keys_and_projects_are_classified() {
        let db = fixture();
        assert_eq!(
            code(resolve_in(&db, P, "never-bound")),
            "NEX_SOURCE_MISSING"
        );
        assert_eq!(
            code(resolve_in(&db, "no-project", "s1")),
            "NEX_SOURCE_MISSING"
        );
        // A Scene of another project has no binding in this project's read.
        assert_eq!(code(resolve_in(&db, "p2", "s1")), "NEX_SOURCE_MISSING");
        assert!(resolve_in(&db, "p2", "sp2").is_ok());
        assert_eq!(
            code(db.with_read_transaction(|conn| resolve(conn, P, "project:scene:s1"))),
            "NEX_SOURCE_KEY_INVALID"
        );
    }

    #[test]
    fn a_batch_of_anchors_reads_the_project_scope_once() {
        let db = fixture();
        let edge = |scene: &str, stored: String| DependencyEdge {
            id: format!("edge-{scene}"),
            project_id: P.into(),
            consumer_kind: "proposal-revision".into(),
            consumer_key: "revision-1".into(),
            source_object_identity: source_key(scene).unwrap(),
            read_set_json: serde_json::to_string(&[stored]).unwrap(),
            generated_by_transaction_id: None,
            created_at: "2026-10-17T00:00:00.000Z".into(),
            owning_run_id: None,
        };
        let edges = vec![
            edge("s1", token(&db, "s1")),
            edge("s2", token(&db, "s2")),
            edge("s3", token(&db, "s3")),
        ];
        let evaluate = |edges: &[DependencyEdge]| {
            project_read_probe::recording(|| {
                db.with_read_transaction(|conn| evaluate_owned_edges_from_db_in_tx(conn, P, edges))
                    .expect("batch evaluation")
            })
        };
        let (fresh, reads) = evaluate(&edges);
        assert_eq!(fresh.len(), 3);
        assert!(fresh.iter().all(|observation| observation == &fresh[0]));
        assert_eq!(reads.get(&Read::AuthorityTree), Some(&1), "{reads:?}");
        assert_eq!(reads.get(&Read::ScopeExtension), Some(&1), "{reads:?}");

        // A change to one anchor makes that Edge differ; the others do not.
        set_scope(&db, "s2", |scope| explicit(scope, "timeline:main"));
        let (changed, reads) = evaluate(&edges);
        assert_eq!(changed[0], fresh[0]);
        assert_ne!(changed[1], fresh[1]);
        assert_eq!(changed[2], fresh[2]);
        assert_eq!(reads.get(&Read::AuthorityTree), Some(&1), "{reads:?}");
    }
}
