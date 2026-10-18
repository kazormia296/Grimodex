//! A and B groups (CB-4 S1): the scan and the judgements that never read the
//! body.
//!
//! The fixture is the CB-2 writer tests' Ready workspace over a file-backed,
//! seeded database. Declarations are placed with the `#[cfg(test)]` setter
//! (bound to the Scene's current values, so a test can change A1 first and
//! declare afterwards) or, once, with the production writer.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::params;
use rusqlite::types::Value as SqlValue;
use uuid::Uuid;

use grimodex_core::narrative_scene_body_declaration::{
    NarrativeSceneBodyDeclarationBindingV1, NarrativeSceneBodyDeclarationV1,
    NarrativeSceneBodySourceV1,
};
use grimodex_core::narrative_scene_scope::NarrativeScopePrincipalV1;

use super::counters::{local_counts, reset_local_counts};
use super::judge::reading_rank;
use super::*;
use crate::narrative_extraction::project_scope_authority::load_live_project_scope_authority;
use crate::narrative_extraction::scene_body_declaration::test_support::{
    set_raw_declaration_cells_for_test, set_scene_body_declaration_for_test, test_digest,
    TEST_DECLARED_AT,
};
use crate::narrative_extraction::scene_body_declaration::writer_support_tests::{
    body_json, declare, request_for, set_a1, Env, LEGACY_SCENE, NOW, OTHER_PROJECT, OTHER_SCENE,
    PROJECT, SCENE, SECOND_SCENE,
};
use crate::narrative_extraction::scene_body_declaration::{
    clear_scene_body_declaration_workspace_quarantine_for_test,
    quarantine_scene_body_declaration_workspace_for_test, scene_body_title_digest, CONTENT_READS,
};
use crate::narrative_extraction::task_leases::with_immediate_transaction;
use crate::narrative_extraction::{
    ensure_scene_scope_binding_in_tx, read_retrieval_query_context, RetrievalQueryContextRead,
};

/// The Scene the Related Scenes query is made from. It sorts after every
/// Scene the tests declare ("b*", "s1", "s5"), so they are read earlier.
pub(super) const QUERY: &str = SECOND_SCENE;

// ---- fixture ----------------------------------------------------------------

pub(super) fn add_scene(env: &Env, id: &str, parent: Option<&str>, resolved_a1: bool) {
    env.with_conn(|conn| {
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, content)
             VALUES (?1, ?2, ?3, 'scene', ?4, ?1, ?5)",
            params![id, PROJECT, parent, format!("Title of {id}"), body_json("Body.")],
        )?;
        ensure_scene_scope_binding_in_tx(conn, PROJECT, id, NOW)?;
        Ok(())
    });
    set_a1(env.db().db(), PROJECT, id, resolved_a1);
}

pub(super) fn add_pin(env: &Env, scene: &str, created_at: &str) {
    env.with_conn(|conn| {
        conn.execute(
            "INSERT INTO scene_codex_pins (scene_id, entry_id, created_at) VALUES (?1, 'c1', ?2)",
            params![scene, created_at],
        )?;
        Ok(())
    });
}

/// Three declarable Scenes before the query, each pinned to the Entity.
pub(super) fn fixture() -> Env {
    reset_local_counts();
    let env = Env::new();
    for (index, id) in ["b1", "b2", "b3"].into_iter().enumerate() {
        add_scene(&env, id, None, true);
        add_pin(&env, id, &format!("2026-10-19T00:00:0{index}Z"));
    }
    env
}

pub(super) fn association(env: &Env, scene: &str) -> Nir1GraphSceneAssociation {
    env.with_conn(|conn| {
        let (incarnation, scope_token): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT scene_incarnation_id, source_token FROM narrative_scene_scope_bindings
                  WHERE scene_id = ?1",
                [scene],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or((None, None));
        let (version, updated_at): (i64, String) = conn.query_row(
            "SELECT version, updated_at FROM tree_nodes WHERE id = ?1",
            [scene],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let (rowid, entry, created_at): (i64, String, String) = conn.query_row(
            "SELECT rowid, entry_id, created_at FROM scene_codex_pins WHERE scene_id = ?1",
            [scene],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        Ok(Nir1GraphSceneAssociation {
            scene_id: scene.to_owned(),
            scene_incarnation_id: incarnation,
            scene_source_token: format!("v{version}@{updated_at}"),
            scene_scope_token: scope_token,
            pin_rowid: rowid,
            pin_entry_id: entry,
            pin_created_at: created_at,
            path_hop: 1,
            path_edge_indices: vec![0],
        })
    })
}

pub(super) fn associations(env: &Env, scenes: &[&str]) -> Vec<Nir1GraphSceneAssociation> {
    scenes.iter().map(|scene| association(env, scene)).collect()
}

/// A declaration bound to the Scene as it is now, with the workspace values
/// of the Ready binding. The body's digests are placeholders: the scan does
/// not read the body.
pub(super) fn place(env: &Env, scene: &str) -> NarrativeSceneBodyDeclarationV1 {
    place_in(env, PROJECT, scene)
}

pub(super) fn place_in(env: &Env, project: &str, scene: &str) -> NarrativeSceneBodyDeclarationV1 {
    let workspace = GraphDisclosureWorkspace::from_snapshot(&env.snapshot());
    let parts = workspace.parts().expect("workspace values");
    env.with_conn(|conn| {
        with_immediate_transaction(conn, |tx| {
            let (incarnation, scope_token): (String, String) = tx.query_row(
                "SELECT scene_incarnation_id, source_token FROM narrative_scene_scope_bindings
                  WHERE project_id = ?1 AND scene_id = ?2",
                params![project, scene],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let (version, updated_at, title): (i64, String, String) = tx.query_row(
                "SELECT version, updated_at, title FROM tree_nodes WHERE id = ?1",
                [scene],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            let declaration = NarrativeSceneBodyDeclarationV1::new(
                Uuid::new_v4().to_string(),
                TEST_DECLARED_AT,
                NarrativeSceneBodyDeclarationBindingV1 {
                    project_id: project.to_owned(),
                    scene_id: scene.to_owned(),
                    scene_incarnation_id: incarnation,
                    scope_source_token: scope_token,
                    body_source: NarrativeSceneBodySourceV1 {
                        source_identity: format!("project:scene:{scene}"),
                        source_token: format!("v{version}@{updated_at}"),
                        storage_digest: test_digest('b'),
                        canonical_digest: test_digest('c'),
                        normalizer_version: "gdx-canonical-text/1".to_owned(),
                        utf16_length: 42,
                    },
                    title_digest: scene_body_title_digest(&title)?,
                    workspace_id: parts.workspace_id.clone(),
                    canonical_locator_digest: parts.canonical_locator_digest.clone(),
                },
            )?;
            set_scene_body_declaration_for_test(tx, &declaration)?;
            Ok(declaration)
        })
    })
}

pub(super) fn place_all(env: &Env, scenes: &[&str]) {
    for scene in scenes {
        place(env, scene);
    }
}

pub(super) fn workspace(env: &Env) -> GraphDisclosureWorkspace {
    GraphDisclosureWorkspace::from_snapshot(&env.snapshot())
}

pub(super) fn context(env: &Env) -> RetrievalQueryContext {
    env.db()
        .db()
        .with_read_transaction(
            |conn| match read_retrieval_query_context(conn, PROJECT, QUERY)? {
                RetrievalQueryContextRead::Available(context) => Ok(context),
                other => anyhow::bail!("query context: {other:?}"),
            },
        )
        .unwrap()
}

/// The query context as it is right now.
pub(super) fn query(env: &Env) -> GraphDisclosureQuery {
    GraphDisclosureQuery::from_retrieval_query_context(&context(env))
}

#[derive(Clone, Copy, Debug)]
pub(super) enum Answer {
    Yes,
    No,
    DataFailure,
    StorageFailure,
}

/// A path revalidation that answers per Scene and remembers what was asked.
pub(super) struct Path {
    answers: BTreeMap<String, Answer>,
    default: Answer,
    pub(super) calls: Vec<String>,
}

impl Path {
    pub(super) fn yes() -> Self {
        Self {
            answers: BTreeMap::new(),
            default: Answer::Yes,
            calls: Vec::new(),
        }
    }

    pub(super) fn answering(mut self, scene: &str, answer: Answer) -> Self {
        self.answers.insert(scene.to_owned(), answer);
        self
    }
}

impl GraphPathRevalidator for Path {
    fn revalidate(
        &mut self,
        _: &Connection,
        association: &Nir1GraphSceneAssociation,
    ) -> Result<bool> {
        self.calls.push(association.scene_id.clone());
        match self
            .answers
            .get(&association.scene_id)
            .copied()
            .unwrap_or(self.default)
        {
            Answer::Yes => Ok(true),
            Answer::No => Ok(false),
            Answer::DataFailure => Err(anyhow::anyhow!("path proof is not current")),
            Answer::StorageFailure => Err(anyhow::Error::new(rusqlite::Error::InvalidQuery)),
        }
    }
}

/// Named changes a test makes to one value, one at a time.
type Tampering<T> = Vec<(&'static str, Box<dyn Fn(&mut T)>)>;

pub(super) const OPEN: AppendSlot = AppendSlot {
    ir_uses_common_slot: false,
    raw_count: 3,
};

#[allow(clippy::too_many_arguments)]
pub(super) fn scan_with(
    env: &Env,
    workspace: &GraphDisclosureWorkspace,
    query: &GraphDisclosureQuery,
    slot: AppendSlot,
    existing: &BTreeSet<String>,
    candidates: &[Nir1GraphSceneAssociation],
    path: &mut Path,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<GraphOnlyScan> {
    let input = GraphOnlyScanInput {
        workspace,
        query,
        slot,
        existing_scene_ids: existing,
        candidates,
    };
    env.db()
        .db()
        .with_read_transaction(|conn| evaluate_graph_only_append(conn, &input, path, check))
}

/// The scan with a fresh query context, an open slot and no R+IR Scenes.
pub(super) fn scan(
    env: &Env,
    candidates: &[Nir1GraphSceneAssociation],
    path: &mut Path,
) -> GraphOnlyScan {
    scan_with(
        env,
        &workspace(env),
        &query(env),
        OPEN,
        &BTreeSet::new(),
        candidates,
        path,
        &mut || Ok(()),
    )
    .unwrap()
}

pub(super) fn adopted(result: &GraphOnlyScan) -> &str {
    match result {
        GraphOnlyScan::Candidate(candidate) => &candidate.association.scene_id,
        GraphOnlyScan::NotAppended(_) => panic!("a candidate was expected"),
    }
}

pub(super) fn assert_not_appended(result: &GraphOnlyScan) {
    assert!(
        matches!(result, GraphOnlyScan::NotAppended(NotAppended)),
        "no Scene should be added, got {result:?}"
    );
}

pub(super) fn counts() -> Vec<(&'static str, u64)> {
    local_counts()
}

/// While installed, every statement the closure rejects fails to prepare, so
/// a scan that succeeds did not issue one.
pub(super) fn restrict(env: &Env, deny: impl Fn(&AuthAction<'_>) -> bool + Send + 'static) {
    env.with_conn(|conn| {
        conn.authorizer(Some(move |context: AuthContext<'_>| {
            if deny(&context.action) {
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }))?;
        Ok(())
    });
}

pub(super) fn unrestrict(env: &Env) {
    env.with_conn(|conn| {
        conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
        Ok(())
    });
}

pub(super) fn deny_every_read(env: &Env) {
    restrict(env, |action| {
        matches!(action, AuthAction::Read { .. } | AuthAction::Select)
    });
}

pub(super) fn deny_body_reads(env: &Env) {
    restrict(env, |action| {
        matches!(action, AuthAction::Read { table_name, column_name }
            if *table_name == "tree_nodes" && *column_name == "content")
    });
}

pub(super) fn execute(env: &Env, sql: &str) {
    env.with_conn(|conn| {
        conn.execute_batch(sql)?;
        Ok(())
    });
}

pub(super) fn stored_declaration(env: &Env, scene: &str) -> (String, String) {
    env.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT body_declaration_json, body_declaration_token
               FROM narrative_scene_scope_bindings WHERE scene_id = ?1",
            [scene],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?)
    })
}

pub(super) fn raw_cells(env: &Env, scene: &str, json: SqlValue, token: SqlValue) {
    env.with_conn(|conn| set_raw_declaration_cells_for_test(conn, PROJECT, scene, json, token));
}

// ---- the happy path ---------------------------------------------------------

#[test]
fn the_first_candidate_that_passes_everything_is_adopted_and_the_rest_are_not_read() {
    let env = fixture();
    place_all(&env, &["b1", "b2", "b3"]);
    let mut path = Path::yes();
    let result = scan(&env, &associations(&env, &["b1", "b2", "b3"]), &mut path);
    assert_eq!(adopted(&result), "b1");
    assert_eq!(path.calls, ["b1"], "later candidates are not even asked");
    assert_eq!(counts(), [("adopted", 1)]);
}

#[test]
fn a_declaration_made_by_the_production_writer_is_accepted() {
    let env = fixture();
    add_pin(&env, SCENE, "2026-10-19T00:00:09Z");
    declare(&env, request_for(&env, PROJECT, SCENE)).expect("production declaration");
    let mut path = Path::yes();
    let result = scan(&env, &associations(&env, &[SCENE]), &mut path);
    assert_eq!(adopted(&result), SCENE);
    let GraphOnlyScan::Candidate(candidate) = &result else {
        unreachable!()
    };
    assert_eq!(candidate.title, "One");
    assert_eq!(candidate.association.scene_id, SCENE);
}

// ---- A1: the declaration is read from its row -------------------------------

#[test]
fn a1_no_declaration_or_a_broken_one_is_not_appended() {
    let env = fixture();
    place(&env, "b1");
    let (json, token) = stored_declaration(&env, "b1");
    let cases: Vec<(&str, SqlValue, SqlValue)> = vec![
        ("both NULL", SqlValue::Null, SqlValue::Null),
        ("json only", SqlValue::Text(json.clone()), SqlValue::Null),
        ("token only", SqlValue::Null, SqlValue::Text(token.clone())),
        (
            "unknown version",
            SqlValue::Text(json.replace(
                "narrative-scene-body-declaration/1",
                "narrative-scene-body-declaration/9",
            )),
            SqlValue::Text(token.clone()),
        ),
        (
            "unknown field",
            SqlValue::Text(json.replacen('{', "{\"extra\":1,", 1)),
            SqlValue::Text(token.clone()),
        ),
        (
            "token mismatch",
            SqlValue::Text(json.clone()),
            SqlValue::Text(test_digest('f')),
        ),
        (
            "a value outside the v1 subset",
            SqlValue::Text(json.replace("\"non-secret\"", "\"secret\"")),
            SqlValue::Text(token.clone()),
        ),
        (
            "an oversized cell",
            SqlValue::Text("x".repeat(100_000)),
            SqlValue::Text(token.clone()),
        ),
        (
            "not text",
            SqlValue::Blob(vec![1, 2, 3]),
            SqlValue::Text(token.clone()),
        ),
    ];
    for (name, json_cell, token_cell) in cases {
        raw_cells(&env, "b1", json_cell, token_cell);
        let reads_before = CONTENT_READS.with(std::cell::Cell::get);
        let mut path = Path::yes();
        let result = scan(&env, &associations(&env, &["b1"]), &mut path);
        assert_not_appended(&result);
        assert!(path.calls.is_empty(), "{name}");
        if name == "an oversized cell" || name == "not text" {
            assert_eq!(
                CONTENT_READS.with(std::cell::Cell::get),
                reads_before,
                "{name}: the cell is rejected without being read"
            );
        }
    }
    let totals: BTreeMap<_, _> = counts().into_iter().collect();
    assert_eq!(totals.get("declaration-unavailable"), Some(&9));
}

#[test]
fn a1_a_feed_event_without_the_columns_is_not_a_declaration() {
    let env = fixture();
    place(&env, "b1");
    // The feed still says "declared"; the row says nothing.
    raw_cells(&env, "b1", SqlValue::Null, SqlValue::Null);
    let mut path = Path::yes();
    let result = scan(&env, &associations(&env, &["b1"]), &mut path);
    assert_not_appended(&result);
    assert!(path.calls.is_empty());
}

// ---- A2: A1 and the reading order -------------------------------------------

#[test]
fn a2_a1_that_is_not_explicit_or_not_resolved_is_rejected() {
    let env = fixture();
    // s5 never had an explicit A1; b4's timeline is unresolved.
    add_pin(&env, LEGACY_SCENE, "2026-10-19T00:01:00Z");
    add_scene(&env, "b4", None, false);
    add_pin(&env, "b4", "2026-10-19T00:01:01Z");
    place_all(&env, &[LEGACY_SCENE, "b4"]);
    for scene in [LEGACY_SCENE, "b4"] {
        let mut path = Path::yes();
        let result = scan(&env, &associations(&env, &[scene]), &mut path);
        assert_not_appended(&result);
        assert!(path.calls.is_empty(), "{scene}");
    }
    let totals: BTreeMap<_, _> = counts().into_iter().collect();
    assert_eq!(totals.get("scope-rejected"), Some(&2), "{totals:?}");
}

#[test]
fn a2_axes_holder_and_audience_must_match_the_query() {
    let env = fixture();
    place_all(&env, &["b1", "b2"]);
    let candidates = associations(&env, &["b1"]);
    let tampered: Tampering<QueryParts> = vec![
        (
            "timeline",
            Box::new(|parts| parts.timeline = "other".into()),
        ),
        (
            "worldline",
            Box::new(|parts| parts.worldline = "other".into()),
        ),
        (
            "layer",
            Box::new(|parts| parts.narrative_layer = "other".into()),
        ),
        (
            "holder",
            Box::new(|parts| {
                parts.knowledge_holder = NarrativeScopePrincipalV1::Character {
                    reference: "c1".into(),
                }
            }),
        ),
        (
            "audience",
            Box::new(|parts| {
                parts.audience = NarrativeScopePrincipalV1::Character {
                    reference: "c1".into(),
                }
            }),
        ),
    ];
    for (name, change) in tampered {
        let mut query = query(&env);
        change(query.parts.as_mut().expect("query values"));
        let mut path = Path::yes();
        let result = scan_with(
            &env,
            &workspace(&env),
            &query,
            OPEN,
            &BTreeSet::new(),
            &candidates,
            &mut path,
            &mut || Ok(()),
        )
        .unwrap();
        assert_not_appended(&result);
        assert!(path.calls.is_empty(), "{name}");
    }
    // The same candidate is fine with the untouched query.
    let mut path = Path::yes();
    assert_eq!(adopted(&scan(&env, &candidates, &mut path)), "b1");
}

#[test]
fn a2_a_scene_at_or_after_the_query_is_not_before_it() {
    let env = fixture();
    // The query Scene itself (equal rank) and a Scene that sorts after it.
    add_pin(&env, QUERY, "2026-10-19T00:02:00Z");
    add_scene(&env, "z1", None, true);
    add_pin(&env, "z1", "2026-10-19T00:02:01Z");
    place_all(&env, &[QUERY, "z1"]);
    for scene in [QUERY, "z1"] {
        let mut path = Path::yes();
        let result = scan(&env, &associations(&env, &[scene]), &mut path);
        assert_not_appended(&result);
        assert!(path.calls.is_empty(), "{scene}");
    }
    let totals: BTreeMap<_, _> = counts().into_iter().collect();
    assert_eq!(totals.get("reading-not-before"), Some(&2), "{totals:?}");
}

#[test]
fn a2_the_reading_rank_comes_from_one_authority_read_not_from_the_caller() {
    let env = fixture();
    place(&env, "b1");
    let candidates = associations(&env, &["b1"]);
    for claimed in [0, 1, u64::MAX] {
        let mut context = context(&env);
        context.query_reading_rank = claimed;
        let query = GraphDisclosureQuery::from_retrieval_query_context(&context);
        let mut path = Path::yes();
        let result = scan_with(
            &env,
            &workspace(&env),
            &query,
            OPEN,
            &BTreeSet::new(),
            &candidates,
            &mut path,
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(adopted(&result), "b1", "claimed rank {claimed}");
    }
}

#[test]
fn a2_a_query_that_names_another_authority_revision_adds_nothing() {
    let env = fixture();
    place_all(&env, &["b1", "b2"]);
    let mut query = query(&env);
    query.parts.as_mut().unwrap().authority_revision_token = "sha256:other".into();
    let mut path = Path::yes();
    let result = scan_with(
        &env,
        &workspace(&env),
        &query,
        OPEN,
        &BTreeSet::new(),
        &associations(&env, &["b1", "b2"]),
        &mut path,
        &mut || Ok(()),
    )
    .unwrap();
    assert_not_appended(&result);
    assert!(path.calls.is_empty());
    let totals: BTreeMap<_, _> = counts().into_iter().collect();
    assert_eq!(totals.get("authority-changed"), Some(&1), "stops the scan");
    assert_eq!(totals.get("adopted"), None);
}

#[test]
fn a2_a_context_that_is_not_a_resolved_reading_query_has_no_values() {
    let env = fixture();
    let base = context(&env);
    assert!(GraphDisclosureQuery::from_retrieval_query_context(&base)
        .parts()
        .is_some());
    let mut secrets = context(&env);
    secrets.allow_secrets = true;
    let mut story = context(&env);
    story.effective_axis = "story";
    let mut unresolved = context(&env);
    unresolved.timeline = QueryIdentityState::Unavailable { reason: "x" };
    let mut no_holder = context(&env);
    no_holder.knowledge_holder = QueryIdentityState::NotApplicable { reason: "x" };
    let mut other_authority = context(&env);
    other_authority.scope_authority_source_key = "project:scope-authority:other".into();
    for (name, context) in [
        ("allow_secrets", secrets),
        ("story axis", story),
        ("unresolved axis", unresolved),
        ("no holder", no_holder),
        ("another authority", other_authority),
    ] {
        assert!(
            GraphDisclosureQuery::from_retrieval_query_context(&context)
                .parts()
                .is_none(),
            "{name}"
        );
    }
    // ... and the reader then answers without reading the database.
    place(&env, "b1");
    deny_every_read(&env);
    let mut path = Path::yes();
    let candidates = associations_without_reads("b1");
    let query = GraphDisclosureQuery { parts: None };
    let result = scan_with(
        &env,
        &workspace(&env),
        &query,
        OPEN,
        &BTreeSet::new(),
        &candidates,
        &mut path,
        &mut || Ok(()),
    )
    .unwrap();
    unrestrict(&env);
    assert_not_appended(&result);
}

/// An association made without touching the database.
fn associations_without_reads(scene: &str) -> Vec<Nir1GraphSceneAssociation> {
    vec![Nir1GraphSceneAssociation {
        scene_id: scene.to_owned(),
        scene_incarnation_id: Some("incarnation".into()),
        scene_source_token: "v1@2026-10-19T00:00:00Z".into(),
        scene_scope_token: Some("sha256:token".into()),
        pin_rowid: 1,
        pin_entry_id: "c1".into(),
        pin_created_at: "2026-10-19T00:00:00Z".into(),
        path_hop: 1,
        path_edge_indices: vec![0],
    }]
}

#[test]
fn a2_a_missing_or_ambiguous_mapping_has_no_rank() {
    let env = fixture();
    let mut authority = env
        .db()
        .db()
        .with_read_transaction(|conn| {
            load_live_project_scope_authority(conn, PROJECT, "project:scope-authority:p1")
        })
        .unwrap();
    assert!(reading_rank(&authority, "b1").is_some());
    assert!(reading_rank(&authority, "nowhere").is_none());
    let duplicate = authority
        .mappings
        .iter()
        .find(|mapping| mapping.scene_ref == "scene:b1")
        .cloned()
        .unwrap();
    authority.mappings.push(duplicate);
    assert!(reading_rank(&authority, "b1").is_none(), "ambiguous");
    assert!(
        reading_rank(&authority, "b2").is_some(),
        "another Scene is not affected"
    );
}

// ---- A3: the Scene is live in the project ------------------------------------

#[test]
fn a3_scenes_that_are_not_live_are_skipped_and_the_scan_goes_on_in_tuple_order() {
    let env = fixture();
    execute(
        &env,
        "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, content)
         VALUES ('fa', 'p1', NULL, 'folder', 'Archived folder', 'a9', '{}');",
    );
    add_scene(&env, "b4", Some("fa"), true);
    add_pin(&env, "b4", "2026-10-19T00:03:00Z");
    add_pin(&env, OTHER_SCENE, "2026-10-19T00:03:01Z");
    place_all(&env, &["b1", "b2", "b3", "b4"]);
    place_in(&env, OTHER_PROJECT, OTHER_SCENE);
    let stale = associations(&env, &["b1", "b4", OTHER_SCENE, "b2", "b3"]);
    // b1 is archived, b4's folder is archived, and a Scene of another project
    // is not a Scene of this one.
    execute(
        &env,
        "UPDATE tree_nodes SET archived_at = '2026-10-19 00:00:00' WHERE id IN ('b1', 'fa');",
    );
    let mut path = Path::yes();
    let result = scan(&env, &stale, &mut path);
    assert_eq!(adopted(&result), "b2");
    assert_eq!(path.calls, ["b2"], "b3 is not read once b2 passed");
    let totals: BTreeMap<_, _> = counts().into_iter().collect();
    assert_eq!(totals.get("scene-not-live"), Some(&3), "{totals:?}");

    // A deleted Scene.
    let mut path = Path::yes();
    execute(&env, "DELETE FROM tree_nodes WHERE id = 'b2';");
    let result = scan(&env, &stale, &mut path);
    assert_eq!(adopted(&result), "b3");
    assert_eq!(path.calls, ["b3"]);
}

// ---- A4: the common extra slot -----------------------------------------------

#[test]
fn a4_the_slot_is_open_only_without_ir_and_with_fewer_than_eight_raw() {
    let env = fixture();
    place(&env, "b1");
    let candidates = associations(&env, &["b1"]);
    let workspace = workspace(&env);
    let query = query(&env);
    deny_every_read(&env);
    for (name, slot) in [
        (
            "IR uses the slot",
            AppendSlot {
                ir_uses_common_slot: true,
                raw_count: 0,
            },
        ),
        (
            "eight Raw",
            AppendSlot {
                ir_uses_common_slot: false,
                raw_count: 8,
            },
        ),
        (
            "nine Raw",
            AppendSlot {
                ir_uses_common_slot: false,
                raw_count: 9,
            },
        ),
    ] {
        let mut path = Path::yes();
        let result = scan_with(
            &env,
            &workspace,
            &query,
            slot,
            &BTreeSet::new(),
            &candidates,
            &mut path,
            &mut || Ok(()),
        )
        .expect("no database read is made");
        assert_not_appended(&result);
        assert!(path.calls.is_empty(), "{name}");
    }
    unrestrict(&env);
    for raw_count in [0, 7] {
        let mut path = Path::yes();
        let result = scan_with(
            &env,
            &workspace,
            &query,
            AppendSlot {
                ir_uses_common_slot: false,
                raw_count,
            },
            &BTreeSet::new(),
            &candidates,
            &mut path,
            &mut || Ok(()),
        )
        .unwrap();
        assert_eq!(adopted(&result), "b1", "raw count {raw_count}");
    }
}

#[test]
fn a4_scenes_already_in_the_result_are_not_scanned() {
    let env = fixture();
    place_all(&env, &["b1", "b2"]);
    let existing: BTreeSet<String> = ["b1".to_owned()].into();
    let mut path = Path::yes();
    let result = scan_with(
        &env,
        &workspace(&env),
        &query(&env),
        OPEN,
        &existing,
        &associations(&env, &["b1", "b2"]),
        &mut path,
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(adopted(&result), "b2");
    assert_eq!(path.calls, ["b2"]);
    assert_eq!(
        counts(),
        [("adopted", 1)],
        "b1 is neither judged nor counted"
    );
}

#[test]
fn a4_only_the_first_eight_associations_are_considered() {
    let env = fixture();
    place(&env, "b3");
    let filler = associations_without_reads("filler");
    let mut candidates = Vec::new();
    for index in 0..8 {
        let mut one = filler[0].clone();
        one.scene_id = format!("filler-{index}");
        candidates.push(one);
    }
    candidates.push(association(&env, "b3"));
    let mut path = Path::yes();
    let result = scan(&env, &candidates, &mut path);
    assert_not_appended(&result);
    assert!(
        path.calls.is_empty(),
        "the ninth association is past the frame"
    );
}

// ---- A5: quarantine ----------------------------------------------------------

#[test]
fn a5_a_quarantined_workspace_discloses_nothing_and_reads_nothing() {
    let env = fixture();
    place(&env, "b1");
    let candidates = associations(&env, &["b1"]);
    let workspace_values = workspace(&env);
    let query = query(&env);
    let snapshot = env.snapshot();
    quarantine_scene_body_declaration_workspace_for_test(&snapshot);
    assert!(workspace_values.is_quarantined());
    deny_every_read(&env);
    let mut path = Path::yes();
    let result = scan_with(
        &env,
        &workspace_values,
        &query,
        OPEN,
        &BTreeSet::new(),
        &candidates,
        &mut path,
        &mut || Ok(()),
    )
    .expect("no database read is made");
    unrestrict(&env);
    assert_not_appended(&result);
    assert_eq!(counts(), [("quarantined", 1)]);
    clear_scene_body_declaration_workspace_quarantine_for_test(&snapshot);
    assert!(!workspace_values.is_quarantined());
    let mut path = Path::yes();
    let result = scan_with(
        &env,
        &workspace_values,
        &query,
        OPEN,
        &BTreeSet::new(),
        &candidates,
        &mut path,
        &mut || Ok(()),
    )
    .unwrap();
    assert_eq!(adopted(&result), "b1");
}

#[test]
fn a5_a_quarantine_that_begins_during_the_scan_stops_it_before_adoption() {
    let env = fixture();
    place_all(&env, &["b1", "b2"]);
    let snapshot = env.snapshot();
    let mut calls = 0;
    let mut path = Path::yes();
    let result = scan_with(
        &env,
        &workspace(&env),
        &query(&env),
        OPEN,
        &BTreeSet::new(),
        &associations(&env, &["b1", "b2"]),
        &mut path,
        &mut || {
            calls += 1;
            if calls == 3 {
                quarantine_scene_body_declaration_workspace_for_test(&snapshot);
            }
            Ok(())
        },
    )
    .unwrap();
    clear_scene_body_declaration_workspace_quarantine_for_test(&snapshot);
    assert_not_appended(&result);
    assert!(path.calls.is_empty(), "nothing is asked of the path");
    let totals: BTreeMap<_, _> = counts().into_iter().collect();
    assert_eq!(totals.get("quarantined"), Some(&1), "{totals:?}");
    assert_eq!(totals.get("adopted"), None);
}

// ---- A6: the workspace values -------------------------------------------------

#[test]
fn a6_a_workspace_without_a_canonical_locator_reads_nothing_and_adds_nothing() {
    let env = fixture();
    place(&env, "b1");
    let candidates = associations(&env, &["b1"]);
    let query = query(&env);
    let unlocated = Env::without_durable_identity();
    let workspace_values = GraphDisclosureWorkspace::from_snapshot(&unlocated.snapshot());
    assert!(workspace_values.parts().is_none());
    assert!(
        workspace_values.is_quarantined(),
        "nothing may be disclosed"
    );
    deny_every_read(&env);
    let mut path = Path::yes();
    let result = scan_with(
        &env,
        &workspace_values,
        &query,
        OPEN,
        &BTreeSet::new(),
        &candidates,
        &mut path,
        &mut || Ok(()),
    )
    .expect("no database read is made");
    unrestrict(&env);
    assert_not_appended(&result);
    assert_eq!(counts(), [("workspace-unavailable", 1)]);
}

#[test]
fn a6_a_declaration_bound_to_another_workspace_or_locator_does_not_hold() {
    let env = fixture();
    let other = place(&env, "b1");
    // Re-bind the same Scene to another workspace ID, then to another locator.
    for (name, change) in [
        (
            "workspace id",
            Box::new(|binding: &mut NarrativeSceneBodyDeclarationBindingV1| {
                binding.workspace_id = "another-workspace".into()
            }) as Box<dyn Fn(&mut NarrativeSceneBodyDeclarationBindingV1)>,
        ),
        (
            "locator",
            Box::new(|binding| binding.canonical_locator_digest = test_digest('9')),
        ),
    ] {
        let mut binding = other.binding.clone();
        change(&mut binding);
        env.with_conn(|conn| {
            with_immediate_transaction(conn, |tx| {
                let declaration = NarrativeSceneBodyDeclarationV1::new(
                    Uuid::new_v4().to_string(),
                    TEST_DECLARED_AT,
                    binding.clone(),
                )?;
                set_scene_body_declaration_for_test(tx, &declaration)
            })
        });
        let mut path = Path::yes();
        let result = scan(&env, &associations(&env, &["b1"]), &mut path);
        assert_not_appended(&result);
        assert!(path.calls.is_empty(), "{name}");
    }
}

// ---- A7: veto ----------------------------------------------------------------

pub(super) fn foreshadow(env: &Env, id: &str, secret: i64, payoff_scene: Option<&str>) {
    env.with_conn(|conn| {
        conn.execute(
            "INSERT INTO foreshadows (id, project_id, title, payoff_scene_id, secret, abandoned,
                                      payoff_confirmed, created_at, updated_at)
             VALUES (?1, 'p1', 'F', ?2, ?3, 0, 1, 0, 0)",
            params![id, payoff_scene, secret],
        )?;
        Ok(())
    });
}

pub(super) fn event(env: &Env, id: &str, secret: i64, reveal_scene: Option<&str>) {
    env.with_conn(|conn| {
        conn.execute(
            "INSERT INTO events (id, project_id, secret, reveal_scene_id) VALUES (?1, 'p1', ?2, ?3)",
            params![id, secret, reveal_scene],
        )?;
        Ok(())
    });
}

#[test]
fn a7_a_record_that_classifies_the_body_vetoes_even_when_it_came_after_the_declaration() {
    type Mark = Box<dyn Fn(&Env)>;
    let cases: Vec<(&str, Mark)> = vec![
        (
            "legacy payoff",
            Box::new(|env| foreshadow(env, "f1", 1, Some("b1"))),
        ),
        (
            "setup",
            Box::new(|env| {
                foreshadow(env, "f1", 1, None);
                execute(
                    env,
                    "INSERT INTO foreshadow_setups (id, foreshadow_id, scene_id, from_pos, to_pos,
                                                    kind, semantic_key, created_at, updated_at)
                     VALUES ('su1', 'f1', 'b1', 0, 1, 'plant', 'su1', 0, 0);",
                );
            }),
        ),
        (
            "payoff",
            Box::new(|env| {
                foreshadow(env, "f1", 1, None);
                execute(
                    env,
                    "INSERT INTO foreshadow_payoffs (id, foreshadow_id, scene_id, created_at, updated_at)
                     VALUES ('pa1', 'f1', 'b1', 0, 0);",
                );
            }),
        ),
        (
            "an existing foreshadow made secret later",
            Box::new(|env| {
                execute(
                    env,
                    "UPDATE foreshadows SET secret = 1 WHERE id = 'f-open';",
                );
            }),
        ),
        (
            "event reveal Scene",
            Box::new(|env| event(env, "e1", 1, Some("b1"))),
        ),
        (
            "event link",
            Box::new(|env| {
                event(env, "e1", 1, None);
                execute(
                    env,
                    "INSERT INTO scene_events (scene_id, event_id) VALUES ('b1', 'e1');",
                );
            }),
        ),
        (
            "Scene POV",
            Box::new(|env| {
                execute(
                    env,
                    "UPDATE tree_nodes SET pov_character_id = 'c1' WHERE id = 'b1';",
                );
            }),
        ),
        (
            "beat POV cache",
            Box::new(|env| {
                execute(
                    env,
                    "INSERT INTO scene_beat_pov_cache (scene_id, pov_character_id) VALUES ('b1', 'c1');",
                );
            }),
        ),
    ];
    for (name, mark) in cases {
        let env = fixture();
        foreshadow(&env, "f-open", 0, Some("b1"));
        place_all(&env, &["b1", "b2"]);
        let before = {
            let mut path = Path::yes();
            adopted(&scan(&env, &associations(&env, &["b1"]), &mut path)).to_owned()
        };
        assert_eq!(before, "b1", "{name}: clear before the record");
        reset_local_counts();
        mark(&env);
        let mut path = Path::yes();
        let result = scan(&env, &associations(&env, &["b1", "b2"]), &mut path);
        assert_eq!(adopted(&result), "b2", "{name}");
        assert_eq!(path.calls, ["b2"], "{name}");
        let totals: BTreeMap<_, _> = counts().into_iter().collect();
        assert_eq!(totals.get("veto"), Some(&1), "{name}: {totals:?}");
    }
}

#[test]
fn a7_records_that_are_not_secret_do_not_veto() {
    let env = fixture();
    foreshadow(&env, "f1", 0, Some("b1"));
    event(&env, "e1", 0, Some("b1"));
    place(&env, "b1");
    let mut path = Path::yes();
    let result = scan(&env, &associations(&env, &["b1"]), &mut path);
    assert_eq!(adopted(&result), "b1");
}

fn many_foreshadows(env: &Env, scene: &str, rows: usize) {
    env.with_conn(|conn| {
        conn.execute(
            "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
             INSERT INTO foreshadows (id, project_id, title, payoff_scene_id, secret, abandoned,
                                      payoff_confirmed, created_at, updated_at)
             SELECT 'bulk-' || i, 'p1', 'F', ?1, 0, 0, 1, 0, 0 FROM n",
            params![scene, i64::try_from(rows - 1).unwrap()],
        )?;
        Ok(())
    });
}

#[test]
fn a7_more_veto_rows_than_the_limit_is_not_a_veto_and_stops_the_scan() {
    let env = fixture();
    place_all(&env, &["b1", "b2"]);
    many_foreshadows(&env, "b1", 513);
    let mut path = Path::yes();
    let result = scan(&env, &associations(&env, &["b1", "b2"]), &mut path);
    assert_not_appended(&result);
    assert!(path.calls.is_empty(), "b2 is not read after the limit");
    let totals: BTreeMap<_, _> = counts().into_iter().collect();
    assert_eq!(totals.get("resource-limit"), Some(&1), "{totals:?}");
    assert_eq!(totals.get("veto"), None, "a limit is not a verdict");

    // Exactly the limit is looked at in full.
    let env = fixture();
    place(&env, "b1");
    many_foreshadows(&env, "b1", 512);
    let mut path = Path::yes();
    assert_eq!(
        adopted(&scan(&env, &associations(&env, &["b1"]), &mut path)),
        "b1"
    );
}

// ---- A8: the body is not read ---------------------------------------------------

#[test]
fn a8_the_scan_never_selects_the_body() {
    let env = fixture();
    place_all(&env, &["b1", "b2"]);
    // A body that cannot be parsed and is far above any limit; and a
    // statement that mentions `content` cannot even be prepared.
    execute(
        &env,
        &format!(
            "UPDATE tree_nodes SET content = '{}' WHERE id = 'b1';",
            "x".repeat(5_000_000)
        ),
    );
    let candidates = associations(&env, &["b1", "b2"]);
    let workspace_values = workspace(&env);
    let query = query(&env);
    deny_body_reads(&env);
    let mut path = Path::yes();
    let result = scan_with(
        &env,
        &workspace_values,
        &query,
        OPEN,
        &BTreeSet::new(),
        &candidates,
        &mut path,
        &mut || Ok(()),
    );
    unrestrict(&env);
    assert_eq!(adopted(&result.expect("no statement reads the body")), "b1");
}

// ---- B1: the frame against the parent's read ------------------------------------

#[test]
fn b1_a_frame_value_that_differs_from_the_parent_is_not_adopted() {
    let env = fixture();
    place_all(&env, &["b1", "b2"]);
    let base = associations(&env, &["b1", "b2"]);
    let tampered: Tampering<Nir1GraphSceneAssociation> = vec![
        (
            "incarnation",
            Box::new(|one| one.scene_incarnation_id = Some("another".into())),
        ),
        (
            "no incarnation",
            Box::new(|one| one.scene_incarnation_id = None),
        ),
        (
            "source token",
            Box::new(|one| one.scene_source_token = "v0@1970-01-01T00:00:00Z".into()),
        ),
        (
            "scope token",
            Box::new(|one| one.scene_scope_token = Some(test_digest('0'))),
        ),
        (
            "no scope token",
            Box::new(|one| one.scene_scope_token = None),
        ),
    ];
    for (name, change) in tampered {
        let mut candidates = base.clone();
        change(&mut candidates[0]);
        let mut path = Path::yes();
        let result = scan(&env, &candidates, &mut path);
        assert_eq!(adopted(&result), "b2", "{name}: b1 is skipped, b2 follows");
        assert_eq!(path.calls, ["b2"], "{name}");
    }
}

#[test]
fn b1_a_scene_that_changed_after_the_frame_was_made_is_not_adopted() {
    let env = fixture();
    let stale = associations(&env, &["b1"]);
    // The Scene's row changes after the frame; the declaration is made later,
    // so it binds the new values and only the frame is behind.
    execute(
        &env,
        "UPDATE tree_nodes SET updated_at = '2026-10-19T09:09:09.000Z' WHERE id = 'b1';",
    );
    place(&env, "b1");
    let mut path = Path::yes();
    let result = scan(&env, &stale, &mut path);
    assert_not_appended(&result);
    assert!(path.calls.is_empty());
    let totals: BTreeMap<_, _> = counts().into_iter().collect();
    assert_eq!(totals.get("frame-mismatch"), Some(&1), "{totals:?}");
}

// ---- B2: the pin ------------------------------------------------------------------

#[test]
fn b2_a_pin_that_moved_was_deleted_or_was_inserted_again_is_not_adopted() {
    let env = fixture();
    place_all(&env, &["b1", "b2", "b3"]);
    execute(
        &env,
        "INSERT INTO codex_entries (id, project_id, type, name) VALUES ('c2', 'p1', 'character', 'Other');",
    );
    let stale = associations(&env, &["b1", "b2", "b3"]);
    // b1's pin is deleted, b2's pin is deleted and inserted again (a new row
    // fingerprint), b3's pin moves to another Entity.
    execute(
        &env,
        "DELETE FROM scene_codex_pins WHERE scene_id = 'b1';
         DELETE FROM scene_codex_pins WHERE scene_id = 'b2';
         INSERT INTO scene_codex_pins (scene_id, entry_id, created_at)
           VALUES ('b2', 'c1', '2026-10-19T08:00:00Z');
         UPDATE scene_codex_pins SET entry_id = 'c2' WHERE scene_id = 'b3';",
    );
    let mut path = Path::yes();
    let result = scan(&env, &stale, &mut path);
    assert_not_appended(&result);
    assert!(path.calls.is_empty(), "no path is asked about a moved pin");
    let totals: BTreeMap<_, _> = counts().into_iter().collect();
    assert_eq!(totals.get("pin-changed"), Some(&3), "{totals:?}");
}

// ---- B3: the caller's path revalidation ---------------------------------------------

#[test]
fn b3_the_path_is_asked_last_and_only_about_candidates_that_passed_everything_else() {
    let env = fixture();
    // b1 has no declaration; b2 is vetoed; b3 passes.
    place_all(&env, &["b2", "b3"]);
    foreshadow(&env, "f1", 1, Some("b2"));
    let mut path = Path::yes();
    let result = scan(&env, &associations(&env, &["b1", "b2", "b3"]), &mut path);
    assert_eq!(adopted(&result), "b3");
    assert_eq!(path.calls, ["b3"]);
}

#[test]
fn b3_a_no_or_a_failed_revalidation_does_not_adopt_and_the_scan_goes_on() {
    let env = fixture();
    place_all(&env, &["b1", "b2", "b3"]);
    let mut path = Path::yes()
        .answering("b1", Answer::No)
        .answering("b2", Answer::DataFailure);
    let result = scan(&env, &associations(&env, &["b1", "b2", "b3"]), &mut path);
    assert_eq!(adopted(&result), "b3");
    assert_eq!(path.calls, ["b1", "b2", "b3"]);
    let totals: BTreeMap<_, _> = counts().into_iter().collect();
    assert_eq!(totals.get("path-rejected"), Some(&2), "{totals:?}");
}

#[test]
fn b3_a_storage_failure_of_the_revalidation_is_an_error_not_a_skip() {
    let env = fixture();
    place_all(&env, &["b1", "b2"]);
    let mut path = Path::yes().answering("b1", Answer::StorageFailure);
    let result = scan_with(
        &env,
        &workspace(&env),
        &query(&env),
        OPEN,
        &BTreeSet::new(),
        &associations(&env, &["b1", "b2"]),
        &mut path,
        &mut || Ok(()),
    );
    assert!(result.is_err());
    assert_eq!(path.calls, ["b1"]);
}

#[test]
fn b3_a_yes_from_the_path_is_not_a_declaration() {
    let env = fixture();
    // Every path proof is current, but nobody declared the body.
    let mut path = Path::yes();
    let result = scan(&env, &associations(&env, &["b1", "b2", "b3"]), &mut path);
    assert_not_appended(&result);
    assert!(path.calls.is_empty(), "the path is not even asked");
}

// ---- B4: the result carries no reason ------------------------------------------------

#[test]
fn b4_every_way_of_adding_nothing_is_the_same_value() {
    let env = fixture();
    place(&env, "b2");
    let mut results = Vec::new();
    // No candidate at all.
    results.push(scan(&env, &[], &mut Path::yes()));
    // A candidate that is not declared.
    results.push(scan(&env, &associations(&env, &["b1"]), &mut Path::yes()));
    // A candidate the path refuses.
    results.push(scan(
        &env,
        &associations(&env, &["b2"]),
        &mut Path::yes().answering("b2", Answer::No),
    ));
    // A candidate past the K1b limit of veto rows.
    many_foreshadows(&env, "b2", 513);
    results.push(scan(&env, &associations(&env, &["b2"]), &mut Path::yes()));
    // No free slot.
    results.push(
        scan_with(
            &env,
            &workspace(&env),
            &query(&env),
            AppendSlot {
                ir_uses_common_slot: true,
                raw_count: 0,
            },
            &BTreeSet::new(),
            &associations(&env, &["b2"]),
            &mut Path::yes(),
            &mut || Ok(()),
        )
        .unwrap(),
    );
    for result in &results {
        let GraphOnlyScan::NotAppended(not_appended) = result else {
            panic!("expected no Scene to be added, got {result:?}")
        };
        assert_eq!(not_appended.code(), "graph-scene-not-appended");
        assert_eq!(format!("{result:?}"), "NotAppended(NotAppended)");
    }
}

#[test]
fn b4_a_candidate_and_the_inputs_print_without_their_contents() {
    let env = fixture();
    place(&env, "b1");
    let candidates = associations(&env, &["b1"]);
    let result = scan(&env, &candidates, &mut Path::yes());
    let printed = format!("{result:?}");
    assert!(!printed.contains("b1"), "{printed}");
    assert!(!printed.contains("Title of"), "{printed}");
    let input = GraphOnlyScanInput {
        workspace: &workspace(&env),
        query: &query(&env),
        slot: OPEN,
        existing_scene_ids: &BTreeSet::new(),
        candidates: &candidates,
    };
    assert!(!format!("{input:?}").contains("b1"));
    assert!(!format!("{:?}", input.workspace).contains("workspace-"));
}

// ---- control and the transaction ----------------------------------------------------------

#[test]
fn a_cancelled_checkpoint_is_an_error_and_no_partial_result_is_made() {
    let env = fixture();
    place_all(&env, &["b1", "b2"]);
    for stop_at in 1..=8 {
        reset_local_counts();
        let mut calls = 0;
        let mut path = Path::yes();
        let result = scan_with(
            &env,
            &workspace(&env),
            &query(&env),
            OPEN,
            &BTreeSet::new(),
            &associations(&env, &["b1", "b2"]),
            &mut path,
            &mut || {
                calls += 1;
                anyhow::ensure!(calls < stop_at, "caller cancelled");
                Ok(())
            },
        );
        match result {
            Err(error) => {
                assert_eq!(error.to_string(), "caller cancelled", "stop at {stop_at}");
                assert!(counts().iter().all(|(code, _)| *code != "adopted"));
            }
            Ok(result) => {
                // The scan finished in fewer checkpoints than `stop_at`.
                assert_eq!(adopted(&result), "b1");
            }
        }
    }
}

#[test]
fn a_connection_that_is_not_in_a_transaction_is_refused() {
    let env = fixture();
    place(&env, "b1");
    let candidates = associations(&env, &["b1"]);
    let workspace_values = workspace(&env);
    let query = query(&env);
    let input = GraphOnlyScanInput {
        workspace: &workspace_values,
        query: &query,
        slot: OPEN,
        existing_scene_ids: &BTreeSet::new(),
        candidates: &candidates,
    };
    let result = env.with_conn(|conn| {
        Ok(evaluate_graph_only_append(
            conn,
            &input,
            &mut Path::yes(),
            &mut || Ok(()),
        ))
    });
    assert!(result.is_err());
}

#[test]
fn b4_the_diagnostic_is_a_closed_list_of_outcome_counts() {
    let env = fixture();
    place(&env, "b1");
    let _ = scan(&env, &associations(&env, &["b1"]), &mut Path::yes());
    let totals = super::counters::totals();
    let codes: Vec<&str> = totals.iter().map(|(code, _)| *code).collect();
    assert_eq!(
        codes,
        [
            "slot-unavailable",
            "workspace-unavailable",
            "quarantined",
            "query-unavailable",
            "authority-changed",
            "scene-not-live",
            "scope-rejected",
            "reading-not-before",
            "declaration-unavailable",
            "binding-mismatch",
            "veto",
            "frame-mismatch",
            "pin-changed",
            "path-rejected",
            "resource-limit",
            "adopted",
            "no-candidate",
            "body-unreadable",
            "disclosed",
            "click-allowed",
            "click-refused",
        ]
    );
    assert!(totals
        .iter()
        .any(|(code, count)| *code == "adopted" && *count >= 1));
}
