//! Fixtures of the declaration writer tests: a Ready workspace over a seeded
//! database, requests that carry the Scene's current OCC, and the preview and
//! consume steps the Native grant code performs.
#![cfg(feature = "native-current-human-capture")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use grimodex_core::narrative_scene_body_declaration::NarrativeSceneBodyDeclarationValuesV1;
use grimodex_core::narrative_scene_scope::{
    NarrativeSceneMaterialConstraintV1, NarrativeSceneQueryIdentityV1,
    NarrativeScopeCompatibilityMarkerV1, NarrativeScopeConstraintV1, NarrativeScopePrincipalV1,
};
use rusqlite::types::ValueRef;
use rusqlite::{params, Connection};
use serde_json::json;
use uuid::Uuid;

use super::*;
use crate::narrative_extraction::{
    ensure_scene_scope_binding_in_tx, ensure_scope_registry_in_tx, read_narrative_scene_scope,
    update_narrative_scene_scope, update_narrative_scene_scope_registry,
    NarrativeSceneScopeRegistryUpdatePayload, NarrativeSceneScopeUpdatePayload,
    NarrativeSceneScopeUpdateV1,
};
use crate::nir1_generation::history_context::DurableWorkspaceIdentity;
use crate::nir1_generation::Nir1AdmissionSqlBudget;
use crate::recovery::SafeModeState;
use crate::state::{
    active_workspace_snapshot, ActiveWorkspace, ActiveWorkspaceSnapshot, WorkspaceAuthority,
    WorkspaceState,
};
use crate::workspace_lifecycle::{
    LiveBinding, WorkspaceLifecycleCompatibilityView, WorkspaceLifecycleCore,
};
use crate::Database;

pub(super) const PROJECT: &str = "p1";
/// A live Scene with a one-paragraph body and an explicit, resolved A1.
pub(super) const SCENE: &str = "s1";
/// A live Scene whose body has no text.
pub(super) const EMPTY_SCENE: &str = "s2";
/// An archived Scene.
pub(super) const ARCHIVED_SCENE: &str = "s3";
/// A Scene of another project.
pub(super) const OTHER_PROJECT: &str = "p2";
pub(super) const OTHER_SCENE: &str = "s4";
/// A live Scene whose A1 was never set (legacy-absent).
pub(super) const LEGACY_SCENE: &str = "s5";
/// A second declarable Scene of the project.
pub(super) const SECOND_SCENE: &str = "s6";

pub(super) const NOW: &str = "2026-10-18T00:00:00.000Z";
pub(super) const BODY_TEXT: &str = "Mira opened the door.";

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(super) fn unique(label: &str) -> String {
    format!("{label}-{}", SEQUENCE.fetch_add(1, Ordering::Relaxed))
}

pub(super) fn body_json(text: &str) -> String {
    json!({
        "type": "doc",
        "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": text }] }],
    })
    .to_string()
}

fn seed(db: &Database) {
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO projects (id, title) VALUES ('p1', 'P'), ('p2', 'Q');
             INSERT OR IGNORE INTO codex_types (id, project_id, slug, label)
               VALUES ('type-p1', 'p1', 'character', 'Character');
             INSERT INTO codex_entries (id, project_id, type, name)
               VALUES ('c1', 'p1', 'character', 'Hero');
             INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, content)
             VALUES ('f1', 'p1', NULL, 'folder', 'Chapter 1', 'a0', '{}');",
        )?;
        let scene = |id: &str, project: &str, title: &str, content: &str| {
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, content)
                 VALUES (?1, ?2, NULL, 'scene', ?3, ?1, ?4)",
                params![id, project, title, content],
            )
        };
        scene(SCENE, PROJECT, "One", &body_json(BODY_TEXT))?;
        scene(EMPTY_SCENE, PROJECT, "Two", r#"{"type":"doc","content":[]}"#)?;
        scene(ARCHIVED_SCENE, PROJECT, "Three", &body_json("Archived."))?;
        scene(LEGACY_SCENE, PROJECT, "Five", &body_json("Legacy."))?;
        scene(SECOND_SCENE, PROJECT, "Six", &body_json("Second."))?;
        scene(OTHER_SCENE, OTHER_PROJECT, "Four", &body_json("Other."))?;
        conn.execute(
            "UPDATE tree_nodes SET archived_at = '2026-10-17 00:00:00' WHERE id = ?1",
            [ARCHIVED_SCENE],
        )?;
        ensure_scope_registry_in_tx(conn, PROJECT, NOW)?;
        ensure_scope_registry_in_tx(conn, OTHER_PROJECT, NOW)?;
        for (project, scene) in [
            (PROJECT, SCENE),
            (PROJECT, EMPTY_SCENE),
            (PROJECT, ARCHIVED_SCENE),
            (PROJECT, LEGACY_SCENE),
            (PROJECT, SECOND_SCENE),
            (OTHER_PROJECT, OTHER_SCENE),
        ] {
            ensure_scene_scope_binding_in_tx(conn, project, scene, NOW)?;
        }
        Ok(())
    })
    .expect("seed");
    for (project, scene) in [(PROJECT, SCENE), (OTHER_PROJECT, OTHER_SCENE)] {
        let read = db
            .with_read_transaction(|conn| read_narrative_scene_scope(conn, project, scene))
            .expect("registry read");
        let mut registry = read.registry.clone();
        registry.timeline_refs = vec!["tl".into()];
        registry.worldline_refs = vec!["wl".into()];
        registry.narrative_layer_refs = vec!["ly".into()];
        update_narrative_scene_scope_registry(
            db,
            NarrativeSceneScopeRegistryUpdatePayload {
                project_id: project.into(),
                request_id: unique("registry"),
                session_id: "session".into(),
                event_uid: unique("registry-event"),
                base_version: read.registry_revision,
                updated_at: NOW.into(),
                registry,
            },
        )
        .expect("registry");
    }
    for (project, scene) in [
        (PROJECT, SCENE),
        (PROJECT, EMPTY_SCENE),
        (PROJECT, ARCHIVED_SCENE),
        (PROJECT, SECOND_SCENE),
        (OTHER_PROJECT, OTHER_SCENE),
    ] {
        set_a1(db, project, scene, true);
    }
}

/// Sets the Scene's A1 to explicit; `resolved` chooses concrete query axes or
/// an unresolved timeline.
pub(super) fn set_a1(db: &Database, project: &str, scene: &str, resolved: bool) {
    let read = db
        .with_read_transaction(|conn| read_narrative_scene_scope(conn, project, scene))
        .expect("scope read");
    let exact = |reference: &str| NarrativeScopeConstraintV1::Exact {
        reference: reference.into(),
    };
    update_narrative_scene_scope(
        db,
        NarrativeSceneScopeUpdatePayload {
            project_id: project.into(),
            scene_id: scene.into(),
            request_id: unique("a1"),
            session_id: "session".into(),
            event_uid: unique("a1-event"),
            base_version: read.binding.version,
            updated_at: NOW.into(),
            scope: NarrativeSceneScopeUpdateV1 {
                schema_version: 1,
                compatibility_marker: NarrativeScopeCompatibilityMarkerV1::Explicit,
                query_identity: NarrativeSceneQueryIdentityV1 {
                    timeline: if resolved {
                        exact("tl")
                    } else {
                        NarrativeScopeConstraintV1::Unresolved {
                            reason: "not-set".into(),
                        }
                    },
                    worldline: exact("wl"),
                    narrative_layer: exact("ly"),
                },
                material_constraint: NarrativeSceneMaterialConstraintV1 {
                    timeline: NarrativeScopeConstraintV1::Any,
                    worldline: NarrativeScopeConstraintV1::Any,
                    narrative_layer: NarrativeScopeConstraintV1::Any,
                },
                knowledge_holder: NarrativeScopePrincipalV1::Reader {},
                audience: NarrativeScopePrincipalV1::Reader {},
            },
        },
    )
    .expect("A1 update");
}

fn ready_state(
    db: Database,
    path: &Path,
    workspace_id: &str,
    with_identity: bool,
) -> (WorkspaceState, crate::state::PinnedWorkspaceDb) {
    let authority =
        WorkspaceAuthority::from_database_for_test(db, path.to_path_buf()).expect("authority");
    let identity = with_identity
        .then(|| DurableWorkspaceIdentity::from_workspace_root(workspace_id, path))
        .flatten();
    let state = WorkspaceState {
        inner: Mutex::new(Some(ActiveWorkspace::new(Arc::clone(&authority)))),
        safe_mode: SafeModeState::default(),
        switching: WorkspaceLifecycleCompatibilityView::new(false),
        open_lock: Mutex::new(Default::default()),
    };
    state
        .lifecycle_core()
        .set_ready(
            LiveBinding::new(
                path.to_string_lossy(),
                workspace_id,
                authority.identity(),
                1,
            )
            .with_durable_workspace_identity(identity),
        )
        .expect("Ready");
    (state, authority)
}

/// A Ready workspace over a file-backed, seeded database in its own directory.
pub(super) struct Env {
    pub state: Option<WorkspaceState>,
    /// The database handle, usable whatever the lifecycle state is.
    pub authority: Option<crate::state::PinnedWorkspaceDb>,
    pub path: PathBuf,
    pub workspace_id: String,
}

impl Env {
    pub fn new() -> Self {
        Self::build(true)
    }

    /// A workspace whose canonical locator could not be determined.
    pub fn without_durable_identity() -> Self {
        Self::build(false)
    }

    fn build(with_identity: bool) -> Self {
        let path =
            std::env::temp_dir().join(format!("grimodex-body-declaration-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("workspace directory");
        let db = Database::new(&path.join("workspace.db")).expect("database");
        db.migrate().expect("migrate");
        seed(&db);
        let workspace_id = format!("workspace-{}", Uuid::new_v4());
        let (state, authority) = ready_state(db, &path, &workspace_id, with_identity);
        Self {
            state: Some(state),
            authority: Some(authority),
            path,
            workspace_id,
        }
    }

    pub fn state(&self) -> &WorkspaceState {
        self.state.as_ref().expect("workspace state")
    }

    pub fn snapshot(&self) -> ActiveWorkspaceSnapshot {
        active_workspace_snapshot(self.state()).expect("workspace snapshot")
    }

    pub fn core(&self) -> WorkspaceLifecycleCore {
        self.state().lifecycle_core()
    }

    pub fn db(&self) -> crate::state::PinnedWorkspaceDb {
        Arc::clone(self.authority.as_ref().expect("authority"))
    }

    pub fn identity(&self) -> DurableWorkspaceIdentity {
        self.snapshot()
            .durable_workspace_identity()
            .expect("durable identity")
            .clone()
    }

    /// Closes the workspace and opens the same directory again as a new
    /// authority instance with a new Ready binding.
    pub fn reopen(&mut self) {
        self.state = None;
        self.authority = None;
        let db = Database::new(&self.path.join("workspace.db")).expect("reopen database");
        let (state, authority) = ready_state(db, &self.path, &self.workspace_id, true);
        self.state = Some(state);
        self.authority = Some(authority);
    }

    /// Closes the workspace and opens the database found through `root` (a
    /// symlink to the workspace directory, or a copy of it) with the same
    /// workspace ID, as Open does for a path the author chose. `self.path`
    /// keeps naming the original directory, which `Drop` removes.
    pub fn reopen_via(&mut self, root: &Path) {
        self.close();
        let db = Database::new(&root.join("workspace.db")).expect("reopen database");
        let (state, authority) = ready_state(db, root, &self.workspace_id, true);
        self.state = Some(state);
        self.authority = Some(authority);
    }

    /// Drops the workspace state and the database handle (a closed workspace).
    pub fn close(&mut self) {
        self.state = None;
        self.authority = None;
    }

    /// Runs `f` on the database through the ordinary connection.
    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> anyhow::Result<T>) -> T {
        self.db().db().with_conn(f).expect("with_conn")
    }

    pub fn declaration_token(&self, scene: &str) -> Option<String> {
        self.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT body_declaration_token FROM narrative_scene_scope_bindings
                  WHERE scene_id = ?1",
                [scene],
                |row| row.get(0),
            )?)
        })
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        self.state = None;
        self.authority = None;
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

pub(super) fn budget() -> Nir1AdmissionSqlBudget {
    Nir1AdmissionSqlBudget::new(Arc::new(AtomicBool::new(false)), Arc::new(|| true))
        .for_untimed_test()
}

/// A request carrying the Scene's current OCC, as the author's screen would
/// have read it.
pub(super) fn request_for(env: &Env, project: &str, scene: &str) -> DeclareRequest {
    let (version, token) = env.with_conn(|conn| {
        let read = read_narrative_scene_scope(conn, project, scene)?;
        Ok((read.binding.version, read.binding.source_token))
    });
    let declaration_token = env.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT body_declaration_token FROM narrative_scene_scope_bindings
                  WHERE project_id = ?1 AND scene_id = ?2",
                params![project, scene],
                |row| row.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten())
    });
    DeclareRequest {
        project_id: project.into(),
        scene_id: scene.into(),
        request_id: unique("request"),
        expected: ExpectedDeclarationOcc {
            scope_version: version,
            scope_token: token,
            declaration_token,
        },
        values: NarrativeSceneBodyDeclarationValuesV1::g01(),
    }
}

pub(super) fn scene_request(env: &Env) -> DeclareRequest {
    request_for(env, PROJECT, SCENE)
}

/// Preview, then consume: what the Native grant code does around the writer.
pub(super) fn consumed_for(
    env: &Env,
    request: &DeclareRequest,
) -> Result<ConsumedBodyDeclarationBinding, DeclareRefusal> {
    let snapshot = env.snapshot();
    let preview = preview_scene_body_declaration(&snapshot, request, &budget())?;
    Ok(ConsumedBodyDeclarationBinding::from_consumed_grant(
        preview.binding,
    ))
}

/// A whole declaration through the preview and the writer.
pub(super) fn declare(
    env: &Env,
    request: DeclareRequest,
) -> Result<DeclareOutcome, DeclareFailure> {
    let consumed = consumed_for(env, &request).map_err(|refusal| DeclareFailure {
        refusal,
        evidence: None,
    })?;
    let snapshot = env.snapshot();
    declare_scene_body(&snapshot, consumed, request, &budget())
}

pub(super) fn revoke_request(project: &str, scene: &str, token: &str) -> RevokeRequest {
    RevokeRequest {
        project_id: project.into(),
        scene_id: scene.into(),
        request_id: unique("revoke"),
        declaration_token: token.into(),
    }
}

/// Every column of one row as text, for byte comparison.
pub(super) fn dump_row(
    conn: &Connection,
    sql: &str,
    key: &[&str],
    skip: &[&str],
) -> BTreeMap<String, String> {
    let mut statement = conn.prepare(sql).expect("prepare dump");
    let names: Vec<String> = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let bound: Vec<&dyn rusqlite::ToSql> = key.iter().map(|k| k as &dyn rusqlite::ToSql).collect();
    statement
        .query_row(bound.as_slice(), |row| {
            let mut out = BTreeMap::new();
            for (index, name) in names.iter().enumerate() {
                if skip.contains(&name.as_str()) {
                    continue;
                }
                let text = match row.get_ref(index)? {
                    ValueRef::Null => "NULL".to_owned(),
                    ValueRef::Integer(value) => format!("i:{value}"),
                    ValueRef::Real(value) => format!("r:{value}"),
                    ValueRef::Text(value) => format!("t:{}", String::from_utf8_lossy(value)),
                    ValueRef::Blob(value) => format!("b:{}", hex::encode(value)),
                };
                out.insert(name.clone(), text);
            }
            Ok(out)
        })
        .expect("dump row")
}

/// The binding row except the two declaration columns.
pub(super) fn binding_row_without_declaration(
    conn: &Connection,
    project: &str,
    scene: &str,
) -> BTreeMap<String, String> {
    dump_row(
        conn,
        "SELECT * FROM narrative_scene_scope_bindings WHERE project_id = ?1 AND scene_id = ?2",
        &[project, scene],
        &["body_declaration_json", "body_declaration_token"],
    )
}

/// The Scene's `tree_nodes` row.
pub(super) fn tree_row(conn: &Connection, scene: &str) -> BTreeMap<String, String> {
    dump_row(
        conn,
        "SELECT * FROM tree_nodes WHERE id = ?1",
        &[scene],
        &[],
    )
}

pub(super) fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).expect("count")
}

/// The plan's limits unchanged (mutex 100 ms, busy 100 ms, operation 250 ms).
pub(super) fn plan_budget() -> Nir1AdmissionSqlBudget {
    Nir1AdmissionSqlBudget::new(Arc::new(AtomicBool::new(false)), Arc::new(|| true))
}

/// A saved body of `paragraphs` paragraphs of `width` characters each.
pub(super) fn long_body(paragraphs: usize, width: usize) -> String {
    let text = "あ".repeat(width);
    let paragraph = json!({
        "type": "paragraph",
        "content": [{ "type": "text", "text": text }],
    });
    json!({ "type": "doc", "content": vec![paragraph; paragraphs] }).to_string()
}
