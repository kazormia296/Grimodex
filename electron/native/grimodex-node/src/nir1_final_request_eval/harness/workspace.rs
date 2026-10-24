//! One isolated case workspace and the product writers that fill it (DPH-4).
//!
//! GDX-ISOLATION-001: every variant gets its own temp root, its own `Backend`
//! (and so its own profile-egress state), its own SQLite file and its own tokio
//! runtime. Nothing is shared between variants, and the root is removed when the
//! workspace is dropped.
//!
//! The setup writes only through the Native product functions the renderer
//! reaches over IPC (the `Backend` methods named in the fixture's setup
//! contract), called with the IPC payload shape. No statement in this module
//! writes a row by itself. `WriteAudit` proves it at run time: an SQLite update
//! hook on the workspace connection attributes every changed row to the product
//! writer that was running; a change with no writer running is a direct write.

use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, ensure, Context, Result};
use grimodex_db::state::{active_workspace_snapshot, ActiveWorkspace, WorkspaceAuthority};
use grimodex_db::workspace_lifecycle::LiveBinding;
use grimodex_db::Database;
use serde_json::{json, Value};

use crate::profile_egress::CallerIdentity;
use crate::state::AppState;
use crate::Backend;

/// Which phase the audit attributes a change to. Setup writes are audited for
/// direct DML; request-phase writes (the chat capture, D-final's own rows) are
/// counted apart.
const PHASE_SETUP: u8 = 0;
const PHASE_REQUEST: u8 = 1;

/// Changed rows per product writer, and any change made while no writer ran.
#[derive(Default)]
pub(super) struct WriteAudit {
    depth: AtomicUsize,
    phase: AtomicU8,
    inner: Mutex<AuditInner>,
}

#[derive(Default)]
struct AuditInner {
    /// (writer, table, action) of a change made while a writer was running.
    attributed: Vec<(String, String, String)>,
    /// Changes made outside every writer during setup.
    direct: Vec<String>,
    /// Tables changed in the request phase, by table name.
    request_changes: Vec<(String, String)>,
    current: Vec<String>,
}

impl WriteAudit {
    fn record(&self, action: String, table: String) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        if self.phase.load(Ordering::SeqCst) == PHASE_REQUEST {
            inner.request_changes.push((table, action));
            return;
        }
        if self.depth.load(Ordering::SeqCst) == 0 {
            inner.direct.push(format!("{action} {table}"));
        } else {
            let writer = inner.current.last().cloned().unwrap_or_default();
            inner.attributed.push((writer, table, action));
        }
    }

    fn enter(self: &Arc<Self>, writer: &str) -> WriterScope {
        self.depth.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut inner) = self.inner.lock() {
            inner.current.push(writer.to_owned());
        }
        WriterScope {
            audit: Arc::clone(self),
        }
    }

    pub(super) fn begin_request_phase(&self) {
        self.phase.store(PHASE_REQUEST, Ordering::SeqCst);
    }

    pub(super) fn end_request_phase(&self) {
        self.phase.store(PHASE_SETUP, Ordering::SeqCst);
    }

    /// Changes made while no product writer was running (setup phase).
    pub(super) fn direct_writes(&self) -> Vec<String> {
        self.inner
            .lock()
            .map(|inner| inner.direct.clone())
            .unwrap_or_default()
    }

    /// Distinct product writers that changed at least one row.
    pub(super) fn writers_that_changed_rows(&self) -> Vec<String> {
        let mut writers = self
            .inner
            .lock()
            .map(|inner| {
                inner
                    .attributed
                    .iter()
                    .map(|(writer, _, _)| writer.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        writers.sort();
        writers.dedup();
        writers
    }

    /// Rows changed per table in the request phase, `table action` strings.
    pub(super) fn request_changes(&self) -> Vec<(String, String)> {
        self.inner
            .lock()
            .map(|inner| inner.request_changes.clone())
            .unwrap_or_default()
    }
}

pub(super) struct WriterScope {
    audit: Arc<WriteAudit>,
}

impl Drop for WriterScope {
    fn drop(&mut self) {
        self.audit.depth.fetch_sub(1, Ordering::SeqCst);
        if let Ok(mut inner) = self.audit.inner.lock() {
            inner.current.pop();
        }
    }
}

/// The renderer's `CanonicalWriteContext` for a human write
/// (`createCanonicalWriteContext("human")`).
fn human_context(request_id: &str, writer_session: &str) -> serde_json::Map<String, Value> {
    let mut context = serde_json::Map::new();
    context.insert("requestId".into(), json!(request_id));
    context.insert("sessionId".into(), json!(writer_session));
    context.insert("writerSessionId".into(), json!(writer_session));
    context.insert("eventUid".into(), json!(format!("{request_id}:event")));
    context.insert("origin".into(), json!("human"));
    context.insert("authorityRoute".into(), json!("human-direct"));
    context.insert("caller".into(), json!("human-ui"));
    context.insert(
        "controls".into(),
        json!([
            "runtime-policy",
            "actor-context",
            "typed-writer",
            "occ",
            "change-event",
            "change-feed"
        ]),
    );
    context.insert("provenance".into(), Value::Null);
    context.insert("writesAuthorityProtectedField".into(), json!(false));
    context.insert("originalTransactionId".into(), Value::Null);
    context.insert("undoJournalId".into(), Value::Null);
    context
}

pub(super) struct CaseWorkspace {
    pub(super) root: PathBuf,
    pub(super) locator: String,
    pub(super) state: Arc<AppState>,
    pub(super) project_id: String,
    pub(super) audit: Arc<WriteAudit>,
    backend: Backend,
    runtime: Option<tokio::runtime::Runtime>,
    writer_session: String,
    request_counter: usize,
    /// The caller registered when the profile is restricted. A restricted
    /// profile admits the Scope entries only for it (DA-1), so the setup
    /// calls made after restriction carry it.
    caller: Option<CallerIdentity>,
}

impl Drop for CaseWorkspace {
    fn drop(&mut self) {
        // The runtime goes first so no blocking task still holds the file.
        drop(self.runtime.take());
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

impl CaseWorkspace {
    /// A fresh workspace: a migrated database with the product's seeded
    /// project, opened as the ready workspace of its own `Backend`. Nothing is
    /// inserted here.
    pub(super) fn open(namespace: &str) -> Result<Self> {
        let root = std::env::temp_dir().join(format!(
            "nir1-final-request-eval-{}-{}",
            namespace.replace(['/', '\\'], "_"),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join(".grimodex"))?;
        let workspace_id = format!("nir1-final-request-eval-{}", uuid::Uuid::new_v4());
        std::fs::write(
            root.join(".grimodex/workspace.json"),
            json!({ "id": workspace_id }).to_string(),
        )?;
        let backend = Backend::new(root.join("app").to_string_lossy().into_owned(), None, None)?;
        let state = Arc::clone(&backend.state);
        let database = Database::new(&root.join("grimodex.db"))?;
        database.migrate()?;
        let audit = Arc::new(WriteAudit::default());
        let hook_audit = Arc::clone(&audit);
        database.with_conn(|conn| {
            conn.update_hook(Some(move |action, _database: &str, table: &str, _rowid| {
                hook_audit.record(format!("{action:?}"), table.to_owned());
            }))
            .map_err(|error| anyhow!("the write audit hook could not be installed: {error}"))?;
            Ok(())
        })?;
        let authority = WorkspaceAuthority::from_database_for_test(database, root.clone())?;
        let live_binding = LiveBinding::new(
            root.to_string_lossy(),
            &workspace_id,
            authority.identity(),
            1,
        )
        .with_durable_workspace_identity(
            grimodex_db::nir1_generation::history_context::DurableWorkspaceIdentity::from_workspace_root(
                &workspace_id,
                &root,
            ),
        );
        *state.ws.inner.lock().expect("workspace lock") = Some(ActiveWorkspace::new(authority));
        state.ws.lifecycle_core().set_ready(live_binding)?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        Ok(Self {
            locator: root.to_string_lossy().into_owned(),
            root,
            state,
            project_id: "default-project".to_owned(),
            audit,
            backend,
            runtime: Some(runtime),
            writer_session: format!("nir1-final-request-eval-writer-{}", uuid::Uuid::new_v4()),
            request_counter: 0,
            caller: None,
        })
    }

    fn block_on<F: Future>(&self, future: F) -> F::Output {
        self.runtime
            .as_ref()
            .expect("the runtime lives as long as the workspace")
            .block_on(future)
    }

    /// The wire form of the registered caller (the shape main sends), or
    /// `None` while the profile is unrestricted.
    fn caller_wire(&self) -> Option<String> {
        self.caller.as_ref().map(|caller| {
            json!({
                "profileId": caller.profile_id,
                "callerId": caller.caller_id,
                "callerEpoch": caller.caller_epoch,
                "senderId": caller.sender_id,
                "workspaceId": caller.workspace_id,
                "sessionId": caller.session_id,
            })
            .to_string()
        })
    }

    fn next_request_id(&mut self, label: &str) -> String {
        self.request_counter += 1;
        format!("nir1-eval:{label}:{}", self.request_counter)
    }

    // ------------------------------------------------------------ writers

    /// `project_create`: the case's own project (the renderer's ordinary way to
    /// start a project in a workspace). Every case needs a project id of its
    /// own, because the scorer treats another case's runtime ids as forbidden
    /// in a payload. Returns the new project's id; later writers use it.
    pub(super) fn write_project(&mut self, title: &str) -> Result<String> {
        let project_id = uuid::Uuid::new_v4().to_string();
        let request_id = self.next_request_id("project");
        let now = grimodex_core::now_rfc3339_millis();
        let payload = json!({
            "projectId": project_id,
            "requestId": request_id,
            "sessionId": self.writer_session,
            "eventUid": format!("{request_id}:event"),
            "origin": "human",
            "originalTransactionId": null,
            "undoJournalId": null,
            "title": title,
            "genre": null,
            "pov": null,
            "tense": null,
            "language": "ja",
            "styleGuide": null,
            "aiInstructions": null,
            "outline": null,
            "targetReaders": null,
            "createdAt": now,
            "updatedAt": now,
        });
        let _scope = self.audit.enter("project_create");
        self.block_on(self.backend.project_create(payload))
            .map_err(|error| anyhow!("project_create failed: {error}"))?;
        self.project_id = project_id.clone();
        Ok(project_id)
    }

    /// `tree_node_create` of a Scene whose body is one ProseMirror paragraph.
    /// Returns the Scene's runtime id (the id the renderer would have drawn).
    pub(super) fn write_scene(
        &mut self,
        title: &str,
        sort_order: &str,
        body: &str,
    ) -> Result<String> {
        let scene_id = uuid::Uuid::new_v4().to_string();
        let request_id = self.next_request_id("scene");
        let mut payload = human_context(&request_id, &self.writer_session);
        let content = json!({
            "type": "doc",
            "content": [{"type": "paragraph", "content": [{"type": "text", "text": body}]}]
        })
        .to_string();
        for (key, value) in [
            ("id", json!(scene_id)),
            ("projectId", json!(self.project_id)),
            ("parentId", Value::Null),
            ("nodeType", json!("scene")),
            ("title", json!(title)),
            ("sortOrder", json!(sort_order)),
            ("synopsis", Value::Null),
            ("status", Value::Null),
            ("sourceUri", Value::Null),
            ("sourceMtime", Value::Null),
            ("content", json!(content)),
            (
                "canonicalPayload",
                json!({"parentId": null, "sortOrder": sort_order, "title": title}),
            ),
        ] {
            payload.insert(key.into(), value);
        }
        let _scope = self.audit.enter("tree_node_create");
        self.block_on(self.backend.tree_node_create(Value::Object(payload)))
            .map_err(|error| anyhow!("tree_node_create failed: {error}"))?;
        Ok(scene_id)
    }

    /// `codex_create` with the fields the renderer's `createCodexEntry` sends.
    pub(super) fn write_codex_entity(
        &mut self,
        type_slug: &str,
        name: &str,
        summary: &str,
    ) -> Result<String> {
        let entry_id = uuid::Uuid::new_v4().to_string();
        let request_id = self.next_request_id("codex");
        let mut payload = human_context(&request_id, &self.writer_session);
        for (key, value) in [
            (
                "canonicalPayload",
                json!({"type": type_slug, "name": name, "parentId": null}),
            ),
            ("entryId", json!(entry_id)),
            ("projectId", json!(self.project_id)),
            ("surface", json!("manual")),
            ("typeSlug", json!(type_slug)),
            ("name", json!(name)),
            ("summary", json!(summary)),
            ("content", Value::Null),
            ("aliases", Value::Null),
            ("excludedAliases", Value::Null),
            ("readings", Value::Null),
            ("tagsCache", Value::Null),
            ("parentId", Value::Null),
            ("contextMode", Value::Null),
            ("icon", Value::Null),
            ("childrenBudget", Value::Null),
            ("notes", Value::Null),
            ("sourceChatMessageId", Value::Null),
            ("model", Value::Null),
            ("chatMessageId", Value::Null),
            ("traceId", Value::Null),
            ("authorshipSpans", json!([])),
        ] {
            payload.insert(key.into(), value);
        }
        let _scope = self.audit.enter("codex_create");
        let raw = self
            .block_on(self.backend.codex_create(Value::Object(payload)))
            .map_err(|error| anyhow!("codex_create failed: {error}"))?;
        let result: Value = serde_json::from_str(&raw)?;
        Ok(result["entityId"]
            .as_str()
            .context("codex_create returned no entityId")?
            .to_owned())
    }

    /// `codex_update` of a summary, with the optimistic-lock version the live
    /// row has (read, not written, here).
    pub(super) fn write_codex_summary(&mut self, entry_id: &str, summary: &str) -> Result<()> {
        let version = self.codex_version(entry_id)?;
        let request_id = self.next_request_id("codex-update");
        let mut payload = human_context(&request_id, &self.writer_session);
        for (key, value) in [
            ("canonicalPayload", json!({"fields": ["summary"]})),
            ("projectId", json!(self.project_id)),
            ("surface", json!("manual")),
            ("entryId", json!(entry_id)),
            ("baseVersion", json!(version)),
            ("summary", json!(summary)),
            ("model", Value::Null),
            ("chatMessageId", Value::Null),
            ("traceId", Value::Null),
            ("authorshipSpans", Value::Null),
            ("authorshipSpanLanes", Value::Null),
        ] {
            payload.insert(key.into(), value);
        }
        let _scope = self.audit.enter("codex_update");
        self.block_on(self.backend.codex_update(Value::Object(payload)))
            .map_err(|error| anyhow!("codex_update failed: {error}"))?;
        Ok(())
    }

    fn codex_version(&self, entry_id: &str) -> Result<i64> {
        let workspace = active_workspace_snapshot(&self.state.ws)?;
        workspace.db().db().with_read_transaction(|conn| {
            conn.query_row(
                "SELECT version FROM codex_entries WHERE id = ?1",
                [entry_id],
                |row| row.get(0),
            )
            .map_err(Into::into)
        })
    }

    fn read_scene_scope(&self, scene_id: &str) -> Result<Value> {
        let payload = json!({
            "expectedWorkspacePath": self.locator,
            "projectId": self.project_id,
            "sceneId": scene_id,
        });
        let raw = self
            .block_on(self.backend.narrative_scene_scope_read(payload, self.caller_wire()))
            .map_err(|error| anyhow!("narrative_scene_scope_read failed: {error}"))?;
        Ok(serde_json::from_str(&raw)?)
    }

    /// `narrative_scene_scope_registry_update`. `registry` is the fixture's
    /// vocabulary (`sceneScope.registry`); `extra_timeline` adds one reference
    /// to the registry the workspace has now (the Scene Scopes are not
    /// changed).
    pub(super) fn write_scope_registry(
        &mut self,
        scene_id: &str,
        registry: Option<&Value>,
        extra_timeline: Option<&str>,
    ) -> Result<()> {
        let current = self.read_scene_scope(scene_id)?;
        let mut next = current["registry"].clone();
        if let Some(vocabulary) = registry {
            next = json!({
                "registryVersion": grimodex_core::narrative_scene_scope::NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID,
                "timelineRefs": vocabulary["timelineRefs"],
                "worldlineRefs": vocabulary["worldlineRefs"],
                "narrativeLayerRefs": vocabulary["narrativeLayerRefs"],
            });
        }
        if let Some(reference) = extra_timeline {
            next["timelineRefs"]
                .as_array_mut()
                .context("registry has no timelineRefs")?
                .push(json!(reference));
        }
        let request_id = self.next_request_id("scope-registry");
        let payload = json!({
            "expectedWorkspacePath": self.locator,
            "payload": {
                "projectId": self.project_id,
                "requestId": request_id,
                "sessionId": self.writer_session,
                "eventUid": format!("{request_id}:event"),
                "baseVersion": current["registryRevision"],
                "updatedAt": grimodex_core::now_rfc3339_millis(),
                "registry": next,
            }
        });
        let _scope = self.audit.enter("narrative_scene_scope_registry_update");
        self.block_on(self.backend.narrative_scene_scope_registry_update(payload, self.caller_wire()))
            .map_err(|error| anyhow!("narrative_scene_scope_registry_update failed: {error}"))?;
        Ok(())
    }

    /// `narrative_scene_scope_update` with the explicit Scope of the fixture's
    /// `sceneScope.perScene`.
    pub(super) fn write_scene_scope(&mut self, scene_id: &str, per_scene: &Value) -> Result<()> {
        let current = self.read_scene_scope(scene_id)?;
        let request_id = self.next_request_id("scene-scope");
        let exact = |reference: &Value| json!({"kind": "exact", "ref": reference});
        let identity = &per_scene["queryIdentity"];
        let material = &per_scene["materialConstraint"];
        let principal = |name: &Value| match name.as_str() {
            Some("reader") => json!({"kind": "reader"}),
            other => json!({"kind": "character", "ref": other}),
        };
        let payload = json!({
            "expectedWorkspacePath": self.locator,
            "payload": {
                "projectId": self.project_id,
                "sceneId": scene_id,
                "requestId": request_id,
                "sessionId": self.writer_session,
                "eventUid": format!("{request_id}:event"),
                "baseVersion": current["binding"]["version"],
                "updatedAt": grimodex_core::now_rfc3339_millis(),
                "scope": {
                    "schemaVersion": 1,
                    "compatibilityMarker": per_scene["compatibilityMarker"],
                    "queryIdentity": {
                        "timeline": exact(&identity["timeline"]),
                        "worldline": exact(&identity["worldline"]),
                        "narrativeLayer": exact(&identity["narrativeLayer"]),
                    },
                    "materialConstraint": {
                        "timeline": exact(&material["timeline"]),
                        "worldline": exact(&material["worldline"]),
                        "narrativeLayer": exact(&material["narrativeLayer"]),
                    },
                    "knowledgeHolder": principal(&per_scene["knowledgeHolder"]),
                    "audience": principal(&per_scene["audience"]),
                },
            }
        });
        let _scope = self.audit.enter("narrative_scene_scope_update");
        self.block_on(self.backend.narrative_scene_scope_update(payload, self.caller_wire()))
            .map_err(|error| anyhow!("narrative_scene_scope_update failed: {error}"))?;
        Ok(())
    }

    /// `nir1_entity_relation_revision_prepare` for one Entity. Returns the
    /// run, proposal and Revision ids of the prepared typed Revision.
    pub(super) fn prepare_revision(
        &mut self,
        anchor_scene_id: &str,
        entity_id: &str,
        proposal_key: &str,
    ) -> Result<PreparedRevision> {
        let binding = self.capture_binding()?;
        let payload = json!({
            "projectId": self.project_id,
            "sceneId": anchor_scene_id,
            "proposalKey": proposal_key,
            "entityIds": [entity_id],
            "relationIds": [],
        });
        let _scope = self.audit.enter("nir1_entity_relation_revision_prepare");
        let raw = self
            .block_on(
                self.backend
                    .nir1_entity_relation_revision_prepare(payload, binding),
            )
            .map_err(|error| anyhow!("nir1_entity_relation_revision_prepare failed: {error}"))?;
        let value: Value = serde_json::from_str(&raw)?;
        let field = |holder: &Value, name: &str| -> Result<String> {
            Ok(holder
                .get(name)
                .and_then(Value::as_str)
                .with_context(|| format!("prepare receipt has no {name}: {value}"))?
                .to_owned())
        };
        Ok(PreparedRevision {
            run_id: field(&value, "runId")?,
            proposal_id: field(&value["receipt"], "proposalId")?,
            revision_id: field(&value["receipt"], "revisionId")?,
        })
    }

    fn capture_binding(&self) -> Result<Value> {
        let raw = self
            .block_on(
                self.backend
                    .narrative_extraction_capture_workspace_binding(self.locator.clone()),
            )
            .map_err(|error| anyhow!("capture workspace binding failed: {error}"))?;
        Ok(serde_json::from_str(&raw)?)
    }

    /// `narrative_extraction_append_human_decision`. Returns the id of the
    /// Decision row it appended.
    pub(super) fn append_decision(
        &mut self,
        prepared: &PreparedRevision,
        decision: &str,
        decision_json: Option<&Value>,
        created_by: &str,
    ) -> Result<Value> {
        let payload = json!({
            "runId": prepared.run_id,
            "projectId": self.project_id,
            "proposalId": prepared.proposal_id,
            "revisionId": prepared.revision_id,
            "decision": decision,
            "decisionJson": decision_json,
            "createdBy": created_by,
        });
        let _scope = self
            .audit
            .enter("narrative_extraction_append_human_decision");
        let raw = self
            .block_on(
                self.backend
                    .narrative_extraction_append_human_decision(payload),
            )
            .map_err(|error| {
                anyhow!("narrative_extraction_append_human_decision failed: {error}")
            })?;
        Ok(serde_json::from_str(&raw)?)
    }
}

impl CaseWorkspace {
    /// The product's maintenance owner, driven the way Electron main's
    /// scheduler drives it: discover the work the workspace needs, run each
    /// item as a maintenance cycle under a begun attempt, run the Change Feed
    /// freshness cycle (which registers scheduler liveness and cuts the
    /// workspace over to canonical Freshness once it is ready), and repeat
    /// until nothing is left. Returns a log line per step.
    pub(super) fn run_product_maintenance(&mut self, max_rounds: usize) -> Result<Vec<String>> {
        let mut log = Vec::new();
        for round in 0..max_rounds {
            let reason = if round < 2 {
                "workspace-opened"
            } else {
                "before-cutover"
            };
            let _scope = self.audit.enter("narrative_maintenance_owner");
            let discovery: Value = serde_json::from_str(
                &self
                    .block_on(
                        self.backend
                            .discover_narrative_maintenance_work(reason.to_owned()),
                    )
                    .map_err(|error| anyhow!("discover failed: {error}"))?,
            )?;
            let works: Vec<Value> = discovery["pages"]
                .as_array()
                .map(|pages| {
                    pages
                        .iter()
                        .flat_map(|page| page["work"].as_array().cloned().unwrap_or_default())
                        .collect()
                })
                .unwrap_or_default();
            log.push(format!(
                "round {round}: discovery status={} work={}",
                discovery["status"],
                works.len()
            ));
            let mut progressed = false;
            for work in works {
                let attempt = format!("nir1-eval-attempt-{}", uuid::Uuid::new_v4());
                let binding = discovery["workspaceBinding"].clone();
                self.block_on(
                    self.backend
                        .begin_narrative_maintenance_attempt(attempt.clone(), binding.clone()),
                )
                .map_err(|error| anyhow!("begin attempt failed: {error}"))?;
                let cycle: Value = serde_json::from_str(
                    &self
                        .block_on(self.backend.run_narrative_maintenance_cycle(json!({
                            "attemptId": attempt,
                            "work": [work.clone()],
                            "wakeProjectIds": [],
                            "workspaceBinding": binding,
                        })))
                        .map_err(|error| anyhow!("maintenance cycle failed: {error}"))?,
                )?;
                log.push(format!(
                    "  work {} {} -> {}",
                    work["runKind"], work["projectId"], cycle
                ));
                progressed = true;
            }
            for _ in 0..64 {
                let freshness = self
                    .block_on(self.backend.run_narrative_freshness_cycle())
                    .map_err(|error| anyhow!("freshness cycle failed: {error}"))?;
                match freshness {
                    None => {
                        log.push("  freshness: none".into());
                        break;
                    }
                    Some(raw) => {
                        let value: Value = serde_json::from_str(&raw)?;
                        log.push(format!("  freshness: {raw}"));
                        if value["hasMore"] == json!(false) {
                            break;
                        }
                        progressed = true;
                    }
                }
            }
            if !progressed {
                break;
            }
        }
        Ok(log)
    }
}

/// One Revision as the Native reader sees it (A2 and A3 in one evaluation).
#[derive(Clone, Debug)]
pub(super) struct RevisionReading {
    pub(super) a2: String,
    pub(super) a3: String,
    pub(super) freshness: String,
    pub(super) scope_authority_revision: Option<String>,
    /// The Scope authority revision each Entity of the Revision carries in its
    /// own Scope binding (since X1-3 the projection token of the Entity's
    /// anchor Scene): the value that appears as `scope.authorityRevision` in
    /// the rendered entry. It differs from `scope_authority_revision` (the
    /// project-level revision the setup compares between setup-end and
    /// request-pre).
    pub(super) entity_scope_authority_revisions: Vec<String>,
    /// (Codex entity id, source token) of the Revision's Entities.
    pub(super) source_tokens: Vec<(String, String)>,
}

pub(super) struct RestrictedState {
    pub(super) restricted: bool,
    pub(super) in_flight_stopped: bool,
}

impl CaseWorkspace {
    /// `write_ai_settings` with the fixture's route: one loopback endpoint that
    /// is never contacted (the harness sends nothing).
    pub(super) fn write_route(&mut self, model: &str, context: u32, output: u32) -> Result<()> {
        use grimodex_ai::{AiProvider, AiSettings, OpenaiCompatibleEndpoint, ToolProtocolMode};
        let settings = AiSettings {
            provider: AiProvider::OpenaiCompatible,
            model: model.to_owned(),
            tool_protocol_mode: ToolProtocolMode::Native,
            openai_compatible_endpoints: vec![OpenaiCompatibleEndpoint {
                id: "fixture-local".into(),
                label: "fixture".into(),
                base_url: "http://127.0.0.1:12345/v1".into(),
                custom_max_context: Some(context),
                custom_max_output: Some(output),
                enable_structured_tasks: None,
                api_variant: None,
            }],
            active_openai_compatible_endpoint_id: Some("fixture-local".into()),
            ..AiSettings::default()
        };
        grimodex_ai::write_ai_settings(&self.state.ai_settings_path, &settings)
    }

    /// The renderer's `createSession` statement through `db_execute`
    /// (unrestricted branch: the profile is not restricted yet). Returns the
    /// session id and whether the harness statement is the pinned renderer
    /// statement.
    pub(super) fn create_chat_session(
        &mut self,
        node_id: &str,
        title: &str,
    ) -> Result<(String, bool)> {
        ensure!(
            !self.state.profile_egress.status().restricted,
            "a chat session is created before the profile is restricted"
        );
        let statement = super::statement::build(&self.project_id, node_id, title)?;
        let _scope = self.audit.enter("db_execute:createSession");
        self.block_on(self.backend.db_execute(
            statement.sql.clone(),
            Value::Array(statement.params.clone()),
            statement.method.clone(),
            None,
            None,
        ))
        .map_err(|error| anyhow!("db_execute (createSession) failed: {error}"))?;
        Ok((statement.session_id, statement.matches_renderer))
    }

    /// D2a: `activate_first_restricted_publication`, then the caller the
    /// capture needs. The caller is main-issued in production; here the
    /// harness registers one the way the D-final tests do.
    pub(super) fn restrict_and_register_caller(&mut self) -> Result<CallerIdentity> {
        let status = self
            .state
            .profile_egress
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )?;
        self.state
            .profile_egress
            .bind_workspace(Some(self.locator.clone()));
        let caller = CallerIdentity {
            profile_id: status.profile_id,
            caller_id: "nir1-final-request-eval-caller".into(),
            caller_epoch: status.caller_epoch,
            sender_id: 1,
            workspace_id: Some(self.locator.clone()),
            session_id: "nir1-final-request-eval-caller-session".into(),
        };
        self.state.profile_egress.register_caller(&caller)?;
        self.caller = Some(caller.clone());
        Ok(caller)
    }

    pub(super) fn restricted_state(&self) -> RestrictedState {
        let status = self.state.profile_egress.status();
        RestrictedState {
            restricted: status.restricted,
            in_flight_stopped: status.in_flight_stopped,
        }
    }

    /// A2 and A3 for one Revision against the query Scene, read by the same
    /// Native function D-final's qualification gate uses.
    pub(super) fn read_revision(
        &self,
        revision_id: &str,
        query_scene_id: &str,
    ) -> Result<RevisionReading> {
        use grimodex_db::narrative_extraction::{
            evaluate_nir1_entity_relation_disclosure, Nir1EntityRelationDisclosureRead,
        };
        let workspace = active_workspace_snapshot(&self.state.ws)?;
        let project_id = self.project_id.clone();
        workspace.db().db().with_read_transaction(|conn| {
            Ok(
                match evaluate_nir1_entity_relation_disclosure(
                    conn,
                    &project_id,
                    revision_id,
                    query_scene_id,
                )? {
                    Nir1EntityRelationDisclosureRead::Eligible(disclosure) => RevisionReading {
                        a2: "eligible".into(),
                        a3: "eligible".into(),
                        freshness: "fresh".into(),
                        scope_authority_revision: Some(disclosure.scope_authority_revision.clone()),
                        entity_scope_authority_revisions: disclosure
                            .revision
                            .bundle
                            .entities
                            .iter()
                            .map(|entity| entity.scope.authority_revision.clone())
                            .collect(),
                        source_tokens: disclosure
                            .revision
                            .bundle
                            .entities
                            .iter()
                            .map(|entity| (entity.entity_id.clone(), entity.source_token.clone()))
                            .collect(),
                    },
                    Nir1EntityRelationDisclosureRead::Unavailable { reason } => {
                        let (a2, a3) = if reason.starts_with("a3-") {
                            ("eligible".to_owned(), reason)
                        } else {
                            (reason, "not-evaluated".to_owned())
                        };
                        RevisionReading {
                            a2,
                            a3,
                            freshness: "unavailable".into(),
                            scope_authority_revision: None,
                            entity_scope_authority_revisions: Vec::new(),
                            source_tokens: Vec::new(),
                        }
                    }
                },
            )
        })
    }

    /// Message, Attempt and input-reference rows (the generation storage the
    /// capture and D-final write), to prove a request adds only what it adds.
    pub(super) fn generation_attempt_count(&self) -> Result<i64> {
        let workspace = active_workspace_snapshot(&self.state.ws)?;
        workspace.db().db().with_read_transaction(|conn| {
            conn.query_row("SELECT COUNT(*) FROM nir1_generation_attempts", [], |row| {
                row.get(0)
            })
            .map_err(Into::into)
        })
    }

    /// The Native-owned entry for a new Human submission in an existing chat.
    pub(super) fn accept_submission(
        &mut self,
        caller: &CallerIdentity,
        session_id: &str,
        scene_id: &str,
        content: &str,
        key: &str,
    ) -> Result<crate::nir1_prepared_request::NativeAcceptedChatSubmission> {
        let submission = grimodex_db::nir1_generation::NewChatInputSubmission::new(
            format!("nir1-eval-submission-{key}"),
            format!("nir1-eval-message-{key}"),
            session_id.to_owned(),
            scene_id.to_owned(),
            content.to_owned(),
            grimodex_core::now_rfc3339_millis(),
        )?;
        crate::nir1_prepared_request::accept_current_chat_submission(
            Arc::clone(&self.state),
            caller.clone(),
            &submission,
        )
    }
}

/// The ids a prepare returns; `revision_id` is the Revision's runtime id.
#[derive(Clone, Debug)]
pub(super) struct PreparedRevision {
    pub(super) run_id: String,
    pub(super) proposal_id: String,
    pub(super) revision_id: String,
}
