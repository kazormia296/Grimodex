import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import process from "node:process";

import {
  CODEX_ENTITY_RELATION_REVIEW_SELECTORS,
  assertNonEmpty,
  assertTypedDecisionMetadata,
  captureJournalBoundary,
  createCodexEntryThroughUi,
  createFolderThroughUi,
  createSceneInFolderThroughUi,
  openPanel,
  readTypedRuntimeMetadata,
  rows,
  verifyNoForbiddenDispatches,
} from "./codex-entity-relation-product-journey.mjs";

/**
 * X1/1 (`scope-storage-authority` and `typed-revision-material`) acceptance in a
 * real Electron.  The journey drives the normal UI for the Entity/Relation
 * Revision it needs to observe (R1), uses the same Native commands the UI uses
 * for the others, and only ever sends Scene identities: it never hands a
 * token, key or incarnation to Native.  Graph and Packing stay unopened
 * (PUB-G / CP-4); the cold reader of the typed Revision is the oracle.
 */
export const NIR1_SCENE_SCOPE_PROJECTION_JOURNEY_ID =
  "nir1-scene-scope-projection-acceptance";

export const NIR1_SCENE_SCOPE_PROJECTION_SELECTORS = Object.freeze([
  ...CODEX_ENTITY_RELATION_REVIEW_SELECTORS,
  "[data-node-row]",
  '.ProseMirror[contenteditable="true"]',
  '[data-testid="nir1-typed-unavailable-reason"]',
]);

export const NIR1_SCENE_SCOPE_PROJECTION_REQUIRED_INTERACTIONS = Object.freeze([
  "create-folders-and-scenes-through-scenes-panel",
  "create-codex-entries-and-typed-relations-through-codex-panel",
  "prepare-and-approve-anchor-revision-through-ui",
  "prepare-and-approve-other-revision-through-native-commands",
  "save-anchor-and-other-scene-bodies-through-editor-autosave",
  "read-current-revisions-through-native-cold-reader",
  "close-and-relaunch-electron",
  "restore-typed-run-through-ui",
  "move-anchor-through-canonical-tree-writer",
  "edit-scope-through-canonical-writers-and-observe-cold-reader",
  "delete-and-retype-codex-persons-through-canonical-writers",
  "replay-undo-journal-through-history-replay-route",
  "restore-project-snapshot-body-through-native-aggregate",
]);

/** Every renderer-bridge command the journey sends.  No Graph/Packing/AI. */
export const NIR1_SCENE_SCOPE_PROJECTION_IPC_COMMANDS = Object.freeze([
  "db_execute",
  "narrative_extraction_capture_workspace_binding",
  "nir1_entity_relation_revision_prepare",
  "nir1_entity_relation_revision_read_current",
  "narrative_extraction_append_human_decision",
  "tree_node_patch",
  "tree_node_create",
  "tree_node_delete",
  "save_scene_body_bundle",
  "chronicle_bulk_mutate",
  "temporal_scene_patch",
  "narrative_scene_scope_read",
  "narrative_scene_scope_update",
  "trash_bin_create",
  "trash_bin_restore",
  "codex_create",
  "codex_update",
  "codex_delete",
  "agent_apply_undo_journal",
  "project_snapshot_create",
  "project_snapshot_restore_context",
  "project_snapshot_apply_restore",
  "project_create",
]);

/** The assertion steps, in execution order (draft acceptance names). */
export const NIR1_SCENE_SCOPE_PROJECTION_STEPS = Object.freeze([
  "e1-prepare-approve",
  "prepare-rejects-foreign-project-and-missing-anchor",
  "e1-body-saves-keep-available",
  "e1-cold-reopen-available",
  "e1-anchor-move-invalidates-anchor-only",
  "f9-body-save-keeps-revisions-available",
  "display-patches-keep-projection",
  "pov-patch-invalidates-anchor-only",
  "unversioned-patch-never-returns-body-token",
  "anchor-reorder-reparent-invalidates-anchor-only",
  "folder-roundtrip-does-not-return",
  "empty-folder-and-note-keep-everything",
  "anchor-scope-roundtrip-stays-invalid",
  "anchor-archive-roundtrip-stays-invalid",
  "story-time-order-roundtrip-stays-invalid",
  "other-scene-scope-change-keeps-anchor",
  "anchor-delete-recreate-stays-invalid",
  "trash-restore-stays-invalid",
  "body-event-does-not-make-pending",
  "scope-event-pends-anchor-only",
  "pov-only-person-delete-nulls-pov",
  "referenced-person-delete-and-type-change-rejected",
  "journal-undo-redo-guard-and-invalidate",
  "probe-def2-journal-pov-null-next-patch",
  "prepare-rejects-other-project-scene",
  "probe-def1-snapshot-restore-feed",
  "snapshot-body-restore-recreates-bindings",
  "snapshot-restore-epoch-keeps-revisions-unavailable",
  "snapshot-token-return-stays-unavailable",
]);

const HUMAN_DECISION_AUTHOR = "nir1-entity-relation-review";

function ipcFailureText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** One Scene's stored Scope projection inputs and tree row (renderer SELECT). */
async function observeScene(harness, page, projectId, sceneId) {
  const bindings = await rows(
    harness,
    page,
    `SELECT scene_incarnation_id AS incarnation, version, source_token AS sourceToken,
            updated_at AS bindingUpdatedAt
       FROM narrative_scene_scope_bindings
      WHERE project_id = ? AND scene_id = ?`,
    [projectId, sceneId],
  );
  const nodes = await rows(
    harness,
    page,
    `SELECT version AS treeVersion, updated_at AS treeUpdatedAt,
            parent_id AS parentId, sort_order AS sortOrder,
            archived_at AS archivedAt
       FROM tree_nodes WHERE project_id = ? AND id = ?`,
    [projectId, sceneId],
  );
  assert.equal(bindings.length, 1, `Scene ${sceneId} must have one binding`);
  assert.equal(nodes.length, 1, `Scene ${sceneId} must have one tree row`);
  return { ...bindings[0], ...nodes[0] };
}

async function readCurrent(harness, page, { workspace, projectId, runId }) {
  return harness.invokeOk(page, "nir1_entity_relation_revision_read_current", {
    expectedWorkspacePath: workspace,
    projectId,
    runId,
  });
}

async function captureWorkspaceBinding(harness, page, workspace) {
  return harness.invokeOk(
    page,
    "narrative_extraction_capture_workspace_binding",
    { expectedWorkspacePath: workspace },
  );
}

/** Prepare + explicit human approval through the Native commands the UI uses. */
async function prepareAndApproveThroughNative(
  harness,
  page,
  { workspace, projectId, sceneId, entityIds, relationIds },
) {
  const workspaceBinding = await captureWorkspaceBinding(
    harness,
    page,
    workspace,
  );
  const prepared = await harness.invokeOk(
    page,
    "nir1_entity_relation_revision_prepare",
    {
      payload: { projectId, sceneId, entityIds, relationIds },
      workspaceBinding,
    },
  );
  assert.equal(prepared.status, "draft");
  assertNonEmpty(String(prepared.runId), "prepared runId");
  const draft = await readCurrent(harness, page, {
    workspace,
    projectId,
    runId: prepared.runId,
  });
  assert.equal(draft.status, "draft", "prepared Revision is a draft first");
  await harness.invokeOk(page, "narrative_extraction_append_human_decision", {
    payload: {
      runId: prepared.runId,
      projectId,
      proposalId: prepared.receipt.proposalId,
      revisionId: prepared.receipt.revisionId,
      decision: "approved",
      createdBy: HUMAN_DECISION_AUTHOR,
    },
  });
  const approved = await readCurrent(harness, page, {
    workspace,
    projectId,
    runId: prepared.runId,
  });
  assert.equal(approved.status, "available", "approval makes it available");
  return {
    runId: String(prepared.runId),
    proposalId: String(prepared.receipt.proposalId),
    revisionId: String(prepared.receipt.revisionId),
  };
}

async function openSceneEditorThroughUi(harness, page, { sceneId, folderId }) {
  await openPanel(page, "scenes", "scenes-panel");
  const row = page.locator(`[data-node-row="${sceneId}"]`);
  const visible = await row
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!visible) {
    await page.locator(`[data-node-row="${folderId}"]`).click();
    await row.waitFor({ state: "visible", timeout: 30_000 });
  }
  // Click the row's own left padding: its centre can land on the status-dot
  // popover trigger (and the drag handle stops propagation).
  await row.click({ position: { x: 2, y: 2 } });
  const surface = page.locator(
    `[data-editor-loaded-document-id="${sceneId}"][data-editor-document-loading="false"]:visible`,
  );
  await surface.waitFor({ state: "visible", timeout: 30_000 });
  const editor = surface
    .locator('.ProseMirror[contenteditable="true"]')
    .first();
  await editor.waitFor({ state: "visible", timeout: 30_000 });
  return editor;
}

/** Type through the editor and wait for the autosave to reach SQLite. */
async function saveBodyThroughEditor(
  harness,
  page,
  { projectId, sceneId, folderId, text },
) {
  const before = await observeScene(harness, page, projectId, sceneId);
  const editor = await openSceneEditorThroughUi(harness, page, {
    sceneId,
    folderId,
  });
  await editor.click();
  await page.keyboard.type(text, { delay: 10 });
  await harness.waitUntil(
    () =>
      rows(
        harness,
        page,
        "SELECT version FROM tree_nodes WHERE project_id = ? AND id = ? AND content LIKE ?",
        [projectId, sceneId, `%${text}%`],
      ).then((result) => result[0] ?? null),
    `editor autosave of ${text}`,
    30_000,
  );
  const after = await observeScene(harness, page, projectId, sceneId);
  return { before, after };
}

async function openTypedReviewThroughColdLauncher(
  page,
  { entityId, alreadySelected = false },
) {
  // Once an entry is selected the Codex list is replaced by its detail view.
  if (!alreadySelected) {
    await page.getByTestId(`codex-entry-${entityId}`).click();
  }
  await page.getByTestId("detail-tab-relations").click();
  const launcher = page.getByTestId("codex-typed-relations-open-nir1-review");
  await launcher.waitFor({ state: "visible", timeout: 60_000 });
  await launcher.click();
  const panel = page.getByTestId("nir1-entity-relation-review-panel");
  await panel.waitFor({ state: "visible", timeout: 60_000 });
  return panel;
}

async function closeTypedReviewDialog(page) {
  await page.getByRole("button", { name: "閉じる", exact: true }).click();
  await page
    .getByTestId("nir1-entity-relation-review-panel")
    .waitFor({ state: "detached", timeout: 30_000 });
}

async function addTypedRelationThroughUi(
  harness,
  page,
  { fromEntry, toEntry, label },
) {
  // The just-created source entry is still the selected detail.
  await page.getByTestId("detail-tab-relations").click();
  const section = page.getByTestId("codex-typed-relations-section");
  await section.waitFor({ state: "visible", timeout: 30_000 });
  await section
    .getByTestId("codex-typed-relation-target")
    .selectOption(String(toEntry.id));
  await section.getByTestId("codex-typed-relation-label").fill(label);
  await section.getByTestId("codex-typed-relation-add").click();
  const relation = await harness.waitUntil(
    () =>
      rows(
        harness,
        page,
        "SELECT id, project_id AS projectId FROM codex_relations WHERE project_id = ? AND from_codex_id = ? AND to_codex_id = ? ORDER BY created_at DESC",
        [fromEntry.projectId, String(fromEntry.id), String(toEntry.id)],
      ).then((result) => result[0] ?? null),
    `typed Relation ${label} creation through Relations tab`,
    30_000,
  );
  return String(relation.id);
}

async function countRows(harness, page, table, projectId) {
  const result = await rows(
    harness,
    page,
    `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`,
    [projectId],
  );
  return Number(result[0]?.n ?? 0);
}

async function countAllRows(harness, page, table) {
  const result = await rows(
    harness,
    page,
    `SELECT COUNT(*) AS n FROM ${table}`,
    [],
  );
  return Number(result[0]?.n ?? 0);
}

const REJECTION_COUNT_TABLES = {
  runs: "narrative_extraction_runs",
  sets: "narrative_proposal_sets",
  bindings: "narrative_scene_scope_bindings",
  events: "narrative_change_events",
};
const FOREIGN_PROJECT_ID = "x1-4-foreign-project";

// Counts for the real project, the rejected foreign project ID and the whole
// table, so a rejected prepare cannot hide a write under another project ID.
async function countRejectionTables(harness, page, projectId) {
  const counts = {};
  for (const [key, table] of Object.entries(REJECTION_COUNT_TABLES)) {
    counts[key] = await countRows(harness, page, table, projectId);
    counts[`${key}Foreign`] = await countRows(
      harness,
      page,
      table,
      FOREIGN_PROJECT_ID,
    );
    counts[`${key}All`] = await countAllRows(harness, page, table);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// S2: Scope edit matrix.  Every writer below is the real Native writer the
// product uses (IPC -> Main -> N-API -> shared Rust); nothing here touches
// SQLite with a direct UPDATE.  Observation is the typed cold reader (A2) plus
// SELECTs on the binding, the tree row and the Change Feed.
// ---------------------------------------------------------------------------

const WRITER_SESSION_ID = "electron-product-journey";
const INTERRUPTION_FUTURE_UPDATED_AT = "2099-01-01T00:00:00.000Z";

function writerIdentity(projectId, label) {
  return {
    projectId,
    requestId: `x1-4-${label}:${randomUUID()}`,
    sessionId: WRITER_SESSION_ID,
    eventUid: `x1-4-event-${label}:${randomUUID()}`,
    origin: "human",
    originalTransactionId: null,
    undoJournalId: null,
  };
}

/** RFC 3339 instant with up to 9 fractional digits, as integer nanoseconds. */
function instantNs(text) {
  const match =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:Z|\+00:00)?$/u.exec(
      String(text),
    );
  assert.ok(match, `uninterpretable timestamp ${text}`);
  const seconds = BigInt(Date.parse(`${match[1]}T${match[2]}Z`)) / 1000n;
  const fraction = BigInt((match[3] ?? "").padEnd(9, "0"));
  return seconds * 1_000_000_000n + fraction;
}

/** The Scene body Source token is `v{version}@{updated_at}`. */
function bodyToken(node) {
  return `v${node.treeVersion}@${node.treeUpdatedAt}`;
}

function proseDoc(text) {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

async function treeCreate(ctx, spec) {
  await ctx.harness.invokeOk(ctx.page, "tree_node_create", {
    payload: {
      ...writerIdentity(ctx.projectId, `create-${spec.id}`),
      id: spec.id,
      nodeType: spec.nodeType,
      title: spec.title,
      parentId: spec.parentId ?? null,
      sortOrder: spec.sortOrder,
    },
  });
}

async function treePatch(ctx, nodeId, patch, options = {}) {
  const bumpVersion = options.bumpVersion ?? false;
  return ctx.harness.invokeOk(ctx.page, "tree_node_patch", {
    payload: {
      ...writerIdentity(ctx.projectId, `patch-${nodeId}`),
      nodeId,
      updatedAt: options.updatedAt ?? new Date().toISOString(),
      patch,
      bumpVersion,
      ...(options.baseVersion === undefined
        ? {}
        : { baseVersion: options.baseVersion }),
    },
  });
}

async function treeDelete(ctx, nodeId) {
  return ctx.harness.invokeOk(ctx.page, "tree_node_delete", {
    payload: { ...writerIdentity(ctx.projectId, `delete-${nodeId}`), nodeId },
  });
}

async function chronicleSetSceneDate(ctx, sceneId, baseUpdatedAt, startTime) {
  return ctx.harness.invokeOk(ctx.page, "chronicle_bulk_mutate", {
    payload: {
      ...writerIdentity(ctx.projectId, `chronicle-${sceneId}`),
      surface: "manual",
      operations: [
        {
          kind: "sceneSetDate",
          sceneId,
          baseUpdatedAt,
          startTime,
          startMinute: null,
          startGranularity: "day",
          endTime: null,
          endMinute: null,
          endGranularity: "none",
        },
      ],
    },
  });
}

async function temporalSetStoryOrder(
  ctx,
  sceneId,
  baseVersion,
  storyTimeOrder,
) {
  return ctx.harness.invokeOk(ctx.page, "temporal_scene_patch", {
    payload: {
      ...writerIdentity(ctx.projectId, `temporal-${sceneId}`),
      targetId: sceneId,
      baseVersion,
      storyTimeOrder,
      storyTimeLabel: null,
      startTime: null,
      startMinute: null,
      startGranularity: "none",
      endTime: null,
      endMinute: null,
      endGranularity: "none",
      precision: "exact",
    },
  });
}

async function saveBodyThroughNative(ctx, sceneId, text) {
  const node = await observeScene(
    ctx.harness,
    ctx.page,
    ctx.projectId,
    sceneId,
  );
  // The body bundle contract denies unknown fields: no replay lineage keys.
  const { originalTransactionId, undoJournalId, ...identity } = writerIdentity(
    ctx.projectId,
    `body-${sceneId}`,
  );
  assert.equal(originalTransactionId, null);
  assert.equal(undoJournalId, null);
  await ctx.harness.invokeOk(ctx.page, "save_scene_body_bundle", {
    payload: {
      ...identity,
      sceneId,
      includeSidecars: false,
      baseVersion: Number(node.treeVersion),
      updatedAt: new Date().toISOString(),
      contentJson: proseDoc(text),
      charCount: text.length,
      placedBeatPreview: null,
      unplacedBeatsDoc: "[]",
      unplacedBeatPreview: null,
      authorshipSpans: [],
      foreshadowSetups: [],
      foreshadowPayoffs: [],
      foreshadowBaseVersions: {},
      annotationAnchors: [],
      beatMentions: [],
      beatPovOverrides: [],
      docContentSize: text.length + 2,
    },
  });
}

async function readScope(ctx, sceneId) {
  return ctx.harness.invokeOk(ctx.page, "narrative_scene_scope_read", {
    expectedWorkspacePath: ctx.workspace,
    projectId: ctx.projectId,
    sceneId,
  });
}

/**
 * Write the A1 binding through the canonical Scope writer.  `fields` names the
 * axes the caller changes (`timeline`, `knowledgeHolder`, `audience`); every
 * other axis is carried over from the binding as read.
 */
async function updateSceneScopeFields(ctx, sceneId, fields) {
  const current = await readScope(ctx, sceneId);
  const binding = current.binding;
  await ctx.harness.invokeOk(ctx.page, "narrative_scene_scope_update", {
    expectedWorkspacePath: ctx.workspace,
    payload: {
      projectId: ctx.projectId,
      sceneId,
      requestId: `x1-4-scope:${randomUUID()}`,
      sessionId: WRITER_SESSION_ID,
      eventUid: `x1-4-event-scope:${randomUUID()}`,
      baseVersion: binding.version,
      updatedAt: new Date().toISOString(),
      scope: {
        schemaVersion: 1,
        compatibilityMarker: binding.compatibilityMarker,
        queryIdentity: binding.queryIdentity,
        materialConstraint:
          fields.timeline === undefined
            ? binding.materialConstraint
            : { ...binding.materialConstraint, timeline: fields.timeline },
        knowledgeHolder: fields.knowledgeHolder ?? binding.knowledgeHolder,
        audience: fields.audience ?? binding.audience,
      },
    },
  });
  return current;
}

/** Write the A1 binding; `materialTimeline` is the axis the matrix varies. */
async function updateSceneScope(ctx, sceneId, materialTimeline) {
  return updateSceneScopeFields(ctx, sceneId, { timeline: materialTimeline });
}

/**
 * A typed Revision is read through the Incremental Freshness cursor: events the
 * background consumer has not acknowledged yet can make a new draft unreadable
 * (pending).  Wait for the consumer to catch up before preparing a Revision.
 */
async function settleFeed(ctx, label) {
  return ctx.harness.waitUntil(
    async () => {
      const cursor = await feedCursor(ctx);
      return cursor.acknowledgedThrough !== null &&
        cursor.acknowledgedThrough >= cursor.head
        ? cursor
        : null;
    },
    `incremental freshness acknowledges the Change Feed (${label})`,
    60_000,
  );
}

async function newRevision(ctx, sceneId) {
  await settleFeed(ctx, `before preparing a Revision for ${sceneId}`);
  const pair = ctx.pairs[ctx.pairIndex % ctx.pairs.length];
  ctx.pairIndex += 1;
  const revision = await prepareAndApproveThroughNative(ctx.harness, ctx.page, {
    workspace: ctx.workspace,
    projectId: ctx.projectId,
    sceneId,
    entityIds: pair.entityIds,
    relationIds: pair.relationIds,
  });
  // Every Revision the journey approved, so the project snapshot restore can
  // check that none of them survives the restore epoch.
  ctx.revisionLog.push({
    name: `${sceneId}#${ctx.revisionLog.length}`,
    ...revision,
  });
  return revision;
}

/** `available` or `unavailable:<reason>` for each named Revision (A2). */
async function revisionStatuses(ctx, revisions) {
  const statuses = {};
  for (const [name, revision] of Object.entries(revisions)) {
    const read = await readCurrent(ctx.harness, ctx.page, {
      workspace: ctx.workspace,
      projectId: ctx.projectId,
      runId: revision.runId,
    });
    statuses[name] =
      read.status === "unavailable"
        ? `unavailable:${read.result?.reason ?? ""}`
        : String(read.status);
  }
  return statuses;
}

/** UTF-16 code-unit order, the order the Scope authority sorts siblings by. */
function compareUtf16(a, b) {
  const left = String(a);
  const right = String(b);
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = left.charCodeAt(i) - right.charCodeAt(i);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/** The only reason the contract gives for a Revision made stale by a Scope edit. */
const STALE_REVISION_STATUS = "unavailable:source-revision-changed";

function assertStatuses(statuses, expected, label) {
  for (const [name, want] of Object.entries(expected)) {
    if (want === "available") {
      assert.equal(
        statuses[name],
        "available",
        `${label}: ${name} stays available`,
      );
    } else {
      assert.equal(
        statuses[name],
        STALE_REVISION_STATUS,
        `${label}: ${name} must be unavailable because its source Revision changed`,
      );
    }
  }
}

/**
 * The saved Freshness state of each Revision's Scene Scope projection edges.
 * The Incremental Freshness consumer writes it in the background, so wait until
 * it has acknowledged the Change Feed first.  `fresh` means every projection
 * edge of the Revision is fresh; `stale:<reason>` that one of them is stale.
 */
async function projectionEdgeStates(ctx, revisions, label) {
  await settleFeed(ctx, `${label}: before reading the projection edge states`);
  const states = {};
  for (const [name, revision] of Object.entries(revisions)) {
    const edges = await rows(
      ctx.harness,
      ctx.page,
      `SELECT state.evidence_freshness AS freshness, state.reason_code AS reason
         FROM narrative_dependency_edges edge
         JOIN narrative_dependency_edge_states state ON state.edge_id = edge.id
        WHERE edge.project_id = ? AND edge.consumer_kind = 'proposal-revision'
          AND edge.consumer_key = ?
          AND edge.source_object_identity LIKE 'project:scene-scope-projection:%'
        ORDER BY edge.id`,
      [ctx.projectId, revision.revisionId],
    );
    assert.ok(
      edges.length > 0,
      `${label}: ${name} has Scene Scope projection edges with a saved state`,
    );
    const stale = edges.find((edge) => edge.freshness !== "fresh");
    states[name] = stale ? `${stale.freshness}:${stale.reason ?? ""}` : "fresh";
  }
  return states;
}

/** The only saved state the contract gives a Revision made stale by a Scope edit. */
const STALE_EDGE_STATE = "stale:source-revision-changed";

/** Same `expected` map as `assertStatuses`: A2 and the saved edge state agree. */
async function assertProjectionEdges(ctx, revisions, expected, label) {
  const states = await projectionEdgeStates(ctx, revisions, label);
  for (const [name, want] of Object.entries(expected)) {
    assert.equal(
      states[name],
      want === "available" ? "fresh" : STALE_EDGE_STATE,
      `${label}: ${name} saved projection edge state`,
    );
  }
  return states;
}

async function snapshotBindings(ctx) {
  const result = await rows(
    ctx.harness,
    ctx.page,
    `SELECT scene_id AS sceneId, scene_incarnation_id AS incarnation, version,
            source_token AS sourceToken
       FROM narrative_scene_scope_bindings WHERE project_id = ?
      ORDER BY scene_id`,
    [ctx.projectId],
  );
  return new Map(result.map((row) => [row.sceneId, row]));
}

/** Change Feed head and Incremental Freshness cursor (observation only). */
async function feedCursor(ctx) {
  const head = await rows(
    ctx.harness,
    ctx.page,
    `SELECT COALESCE(MAX(canonical_sequence), 0) AS head
       FROM narrative_change_events WHERE project_id = ?`,
    [ctx.projectId],
  );
  const cursor = await rows(
    ctx.harness,
    ctx.page,
    `SELECT acknowledged_through_sequence AS acknowledgedThrough
       FROM narrative_change_cursors
      WHERE project_id = ? AND consumer_id = 'narrative-incremental-freshness/v1'`,
    [ctx.projectId],
  );
  return {
    head: Number(head[0]?.head ?? 0),
    acknowledgedThrough:
      cursor[0]?.acknowledgedThrough === undefined
        ? null
        : Number(cursor[0].acknowledgedThrough),
  };
}

async function feedSince(ctx, sequence) {
  return rows(
    ctx.harness,
    ctx.page,
    `SELECT canonical_sequence AS sequence,
            json_extract(object_key_json, '$.kind') AS kind,
            json_extract(object_key_json, '$.sceneId') AS sceneId
       FROM narrative_change_events
      WHERE project_id = ? AND canonical_sequence > ?
      ORDER BY canonical_sequence, event_ordinal`,
    [ctx.projectId, sequence],
  );
}

/** Run one writer and capture the binding and Feed effect it caused. */
async function observedWrite(ctx, write) {
  const bindingsBefore = await snapshotBindings(ctx);
  const cursorBefore = await feedCursor(ctx);
  const value = await write();
  const bindingsAfter = await snapshotBindings(ctx);
  const events = await feedSince(ctx, cursorBefore.head);
  const advanced = {};
  const incarnationChanged = [];
  for (const [sceneId, after] of bindingsAfter) {
    const before = bindingsBefore.get(sceneId);
    if (!before) continue;
    if (before.incarnation !== after.incarnation) {
      incarnationChanged.push(sceneId);
      continue;
    }
    const delta = Number(after.version) - Number(before.version);
    assert.ok(delta >= 0, `Scope generation of ${sceneId} must not decrease`);
    assert.equal(
      after.sourceToken !== before.sourceToken,
      delta > 0,
      `${sceneId}: the v1 token moves exactly when the Scope generation moves`,
    );
    if (delta > 0) advanced[sceneId] = delta;
  }
  const scopeEventScenes = [
    ...new Set(
      events
        .filter((event) => event.kind === "scene-scope")
        .map((event) => String(event.sceneId)),
    ),
  ].sort();
  const eventKinds = {};
  for (const event of events) {
    eventKinds[event.kind] = (eventKinds[event.kind] ?? 0) + 1;
  }
  return {
    value,
    advanced,
    incarnationChanged,
    scopeEventScenes,
    eventKinds,
    cursorBefore,
    cursorAfter: await feedCursor(ctx),
  };
}

/** Assert which Scenes' Scope generation advanced and which got a Feed event. */
function assertScopeEffect(observed, expectedScenes, label) {
  const expected = [...expectedScenes].sort();
  assert.deepEqual(
    Object.keys(observed.advanced).sort(),
    expected,
    `${label}: exactly these Scenes' Scope generation advances`,
  );
  assert.deepEqual(
    observed.scopeEventScenes,
    expected,
    `${label}: exactly these Scenes get a scene-scope Feed event`,
  );
  assert.deepEqual(
    observed.incarnationChanged,
    [],
    `${label}: no new incarnation`,
  );
}

function feedSummary(observed) {
  return {
    advanced: observed.advanced,
    scopeEventScenes: observed.scopeEventScenes,
    eventKinds: observed.eventKinds,
    feedHead: [observed.cursorBefore.head, observed.cursorAfter.head],
    acknowledgedThrough: observed.cursorAfter.acknowledgedThrough,
  };
}

async function createMatrixFixture(ctx) {
  const ids = {};
  for (const name of [
    "fm",
    "fd",
    "fa",
    "fb",
    "fe",
    "note",
    "m1",
    "m2",
    "m3",
    "p1",
    "p2",
    "z",
    "q1",
    "q2",
    "del",
  ]) {
    ids[name] = `x14-${name}-${randomUUID()}`;
  }
  const folders = [
    ["fm", "x14-1"],
    ["fd", "x14-2"],
    ["fa", "x14-3"],
    ["fb", "x14-4"],
    ["fe", "x14-5"],
  ];
  for (const [name, sortOrder] of folders) {
    await treeCreate(ctx, {
      id: ids[name],
      nodeType: "folder",
      title: `X14 ${name}`,
      sortOrder,
    });
  }
  await treeCreate(ctx, {
    id: ids.note,
    nodeType: "note",
    title: "X14 note",
    sortOrder: "x14-6",
  });
  for (const [name, parent, sortOrder] of [
    ["m1", "fm", "m1"],
    ["m2", "fm", "m2"],
    ["m3", "fm", "m3"],
    ["p1", "fa", "p1"],
    ["p2", "fb", "p1"],
    ["z", "fb", "p2"],
    ["q1", "fb", "p3"],
    ["q2", "fb", "p4"],
    ["del", "fb", "p5"],
  ]) {
    await treeCreate(ctx, {
      id: ids[name],
      nodeType: "scene",
      title: `X14 ${name}`,
      parentId: ids[parent],
      sortOrder,
    });
  }
  return ids;
}

async function runScopeEditMatrix(ctx, step) {
  const f = await createMatrixFixture(ctx);
  const bindings0 = await snapshotBindings(ctx);
  for (const name of ["m1", "m2", "m3", "p1", "p2", "z", "q1", "q2", "del"]) {
    assert.ok(
      bindings0.has(f[name]),
      `${name} has a Scope binding after create`,
    );
  }
  const observe = (sceneId) =>
    observeScene(ctx.harness, ctx.page, ctx.projectId, sceneId);
  const nodeRow = async (nodeId) => {
    const result = await rows(
      ctx.harness,
      ctx.page,
      `SELECT version AS treeVersion, updated_at AS treeUpdatedAt,
              parent_id AS parentId, sort_order AS sortOrder,
              archived_at AS archivedAt, title
         FROM tree_nodes WHERE project_id = ? AND id = ?`,
      [ctx.projectId, nodeId],
    );
    assert.equal(result.length, 1, `tree row ${nodeId}`);
    return result[0];
  };

  // --- 1. Body saves (F9 re-observed) ------------------------------------
  const revM1a = await newRevision(ctx, f.m1);
  const revM2a = await newRevision(ctx, f.m2);
  const f9Before = { m1: await observe(f.m1), m2: await observe(f.m2) };
  const f9 = await observedWrite(ctx, async () => {
    await saveBodyThroughNative(ctx, f.m1, "X14BodyOne");
    await saveBodyThroughNative(ctx, f.m2, "X14BodyTwo");
    await saveBodyThroughNative(ctx, f.m1, "X14BodyThree");
  });
  const f9After = { m1: await observe(f.m1), m2: await observe(f.m2) };
  for (const key of ["m1", "m2"]) {
    assert.equal(f9After[key].incarnation, f9Before[key].incarnation);
    assert.equal(f9After[key].version, f9Before[key].version);
    assert.equal(f9After[key].sourceToken, f9Before[key].sourceToken);
    assert.ok(
      Number(f9After[key].treeVersion) > Number(f9Before[key].treeVersion),
      `${key}: the body Source token advances`,
    );
    assert.notEqual(bodyToken(f9After[key]), bodyToken(f9Before[key]));
  }
  assertScopeEffect(f9, [], "body saves");
  const f9Statuses = await revisionStatuses(ctx, { m1a: revM1a, m2a: revM2a });
  assertStatuses(
    f9Statuses,
    { m1a: "available", m2a: "available" },
    "body saves",
  );
  const f9Edges = await assertProjectionEdges(
    ctx,
    { m1a: revM1a, m2a: revM2a },
    { m1a: "available", m2a: "available" },
    "body saves",
  );
  step("f9-body-save-keeps-revisions-available", {
    sceneIds: [f.m1, f.m2],
    bodyTokens: {
      m1: [bodyToken(f9Before.m1), bodyToken(f9After.m1)],
      m2: [bodyToken(f9Before.m2), bodyToken(f9After.m2)],
    },
    generation: { m1: f9After.m1.version, m2: f9After.m2.version },
    statuses: f9Statuses,
    projectionEdges: f9Edges,
    feed: feedSummary(f9),
    evidence:
      "spike-style re-observation in a real Electron, not a product-build reproduction",
  });

  // --- 2. Display fields, Chronicle date, versioned title ------------------
  const displayBefore = await observe(f.m1);
  const displayTokens = [bodyToken(displayBefore)];
  const display = await observedWrite(ctx, async () => {
    const record = async () => {
      displayTokens.push(bodyToken(await observe(f.m1)));
    };
    await treePatch(ctx, f.m1, { title: "X14 表題を変更" });
    await record();
    await treePatch(ctx, f.m1, { synopsis: "X14 synopsis" });
    await record();
    await treePatch(ctx, f.m1, { status: "draft" });
    await record();
    await treePatch(ctx, f.m1, { storyTimeLabel: "X14 label" });
    await record();
    await treePatch(ctx, f.m1, { locationId: ctx.entityIds.belka });
    await record();
    await treePatch(ctx, f.m1, { locationId: null });
    await record();
    const beforeVersioned = await observe(f.m1);
    await treePatch(
      ctx,
      f.m1,
      { title: "X14 versioned title" },
      { bumpVersion: true, baseVersion: Number(beforeVersioned.treeVersion) },
    );
    await record();
    await chronicleSetSceneDate(
      ctx,
      f.m1,
      (await observe(f.m1)).treeUpdatedAt,
      2_000_001,
    );
    await record();
  });
  const displayAfter = await observe(f.m1);
  assert.equal(
    new Set(displayTokens).size,
    displayTokens.length,
    "body Source tokens never repeat",
  );
  for (let index = 1; index < displayTokens.length; index += 1) {
    assert.notEqual(displayTokens[index], displayTokens[index - 1]);
  }
  assert.equal(displayAfter.version, displayBefore.version);
  assert.equal(displayAfter.sourceToken, displayBefore.sourceToken);
  assertScopeEffect(display, [], "display field patches");
  const displayStatuses = await revisionStatuses(ctx, {
    m1a: revM1a,
    m2a: revM2a,
  });
  assertStatuses(
    displayStatuses,
    { m1a: "available", m2a: "available" },
    "display field patches",
  );
  const displayEdges = await assertProjectionEdges(
    ctx,
    { m1a: revM1a, m2a: revM2a },
    { m1a: "available", m2a: "available" },
    "display field patches",
  );
  step("display-patches-keep-projection", {
    patched: [
      "title",
      "synopsis",
      "status",
      "storyTimeLabel",
      "locationId",
      "versioned title",
      "chronicle sceneSetDate",
    ],
    bodyTokens: displayTokens,
    statuses: displayStatuses,
    projectionEdges: displayEdges,
    feed: feedSummary(display),
  });

  // --- 2b. POV patch: anchor generation moves, only the anchor goes -------
  const povBefore = await observe(f.m1);
  const pov = await observedWrite(ctx, () =>
    treePatch(ctx, f.m1, { povCharacterId: ctx.entityIds.leika }),
  );
  const povAfter = await observe(f.m1);
  assert.equal(Number(povAfter.version), Number(povBefore.version) + 1);
  assert.notEqual(povAfter.sourceToken, povBefore.sourceToken);
  assertScopeEffect(pov, [f.m1], "POV patch");
  const povStatuses = await revisionStatuses(ctx, { m1a: revM1a, m2a: revM2a });
  assertStatuses(
    povStatuses,
    { m1a: "unavailable", m2a: "available" },
    "POV patch",
  );
  const povEdges = await assertProjectionEdges(
    ctx,
    { m1a: revM1a, m2a: revM2a },
    { m1a: "unavailable", m2a: "available" },
    "POV patch",
  );
  step("pov-patch-invalidates-anchor-only", {
    anchor: f.m1,
    generation: [povBefore.version, povAfter.version],
    statuses: povStatuses,
    projectionEdges: povEdges,
    feed: feedSummary(pov),
  });

  // --- 2c. bumpVersion=false negatives on a scratch Scene (试験 2) --------
  const zBase = await observe(f.z);
  const tokenZ0 = bodyToken(zBase);
  const interruption = await observedWrite(ctx, async () => {
    await treePatch(
      ctx,
      f.z,
      { title: "ZA", content: proseDoc("ZX"), charCount: 2 },
      { updatedAt: INTERRUPTION_FUTURE_UPDATED_AT },
    );
    const afterFirst = await observe(f.z);
    await chronicleSetSceneDate(ctx, f.z, afterFirst.treeUpdatedAt, 2_000_002);
    const afterChronicle = await observe(f.z);
    const third = await treePatch(
      ctx,
      f.z,
      { title: "ZB", content: proseDoc("ZY"), charCount: 2 },
      { updatedAt: INTERRUPTION_FUTURE_UPDATED_AT },
    ).then(
      () => "accepted",
      (error) => `rejected: ${ipcFailureText(error).slice(0, 200)}`,
    );
    const afterThird = await observe(f.z);
    // The row's current updated_at replayed verbatim with a different title.
    const sameAsCurrent = await treePatch(
      ctx,
      f.z,
      { title: "ZE" },
      { updatedAt: afterThird.treeUpdatedAt },
    ).then(
      () => "accepted",
      (error) => `rejected: ${ipcFailureText(error).slice(0, 200)}`,
    );
    const afterSame = await observe(f.z);
    // A -> B -> A title with the original timestamps replayed.
    const replayed = [];
    for (const title of ["ZC", "ZD", "ZC"]) {
      await treePatch(
        ctx,
        f.z,
        { title },
        { updatedAt: "2020-01-01T00:00:00.000Z" },
      );
      replayed.push(bodyToken(await observe(f.z)));
    }
    return {
      afterFirst,
      afterChronicle,
      third,
      afterThird,
      sameAsCurrent,
      afterSame,
      replayed,
    };
  });
  const {
    afterFirst,
    afterChronicle,
    third,
    afterThird,
    sameAsCurrent,
    afterSame,
    replayed,
  } = interruption.value;
  assert.equal(
    afterFirst.version,
    zBase.version,
    "bumpVersion=false keeps the tree version",
  );
  assert.ok(
    instantNs(afterFirst.treeUpdatedAt) >=
      instantNs(INTERRUPTION_FUTURE_UPDATED_AT),
  );
  assert.ok(
    instantNs(afterChronicle.treeUpdatedAt) >
      instantNs(afterFirst.treeUpdatedAt),
    "Chronicle bulk never moves updated_at back",
  );
  const tokenFirst = bodyToken(afterFirst);
  const tokenChronicle = bodyToken(afterChronicle);
  assert.notEqual(tokenChronicle, tokenFirst);
  const tokenThird = bodyToken(afterThird);
  if (third === "accepted") {
    assert.ok(
      ![tokenFirst, tokenChronicle].includes(tokenThird),
      "the interrupting patch cannot return to an earlier body token",
    );
    assert.ok(
      instantNs(afterThird.treeUpdatedAt) >
        instantNs(afterChronicle.treeUpdatedAt),
    );
  } else {
    assert.equal(
      tokenThird,
      tokenChronicle,
      "a rejected patch leaves the row unchanged",
    );
  }
  const tokenSame = bodyToken(afterSame);
  if (sameAsCurrent === "accepted") {
    assert.ok(
      ![tokenZ0, tokenFirst, tokenChronicle, tokenThird].includes(tokenSame),
      "a patch with updatedAt equal to the row's current value cannot return an earlier body token",
    );
  } else {
    assert.equal(
      tokenSame,
      tokenThird,
      "a rejected equal-updatedAt patch leaves the row unchanged",
    );
  }
  const allZTokens = [
    tokenZ0,
    tokenFirst,
    tokenChronicle,
    ...(third === "accepted" ? [tokenThird] : []),
    ...(sameAsCurrent === "accepted" ? [tokenSame] : []),
    ...replayed,
  ];
  assert.equal(
    new Set(allZTokens).size,
    allZTokens.length,
    "no body token repeats across the negative sequence",
  );
  assert.notEqual(
    replayed[0],
    replayed[2],
    "title A->B->A does not return the body token",
  );
  assertScopeEffect(interruption, [], "unversioned patches on a scratch Scene");
  step("unversioned-patch-never-returns-body-token", {
    scratchScene: f.z,
    tokens: allZTokens,
    interruptingPatch: third,
    equalToCurrentUpdatedAt: sameAsCurrent,
    feed: feedSummary(interruption),
  });

  // --- 3. Anchor reorder / reparent --------------------------------------
  const revM1b = await newRevision(ctx, f.m1);
  const orderRevs = { m1b: revM1b, m2a: revM2a };
  const otherRankBefore = (await nodeRow(f.m3)).sortOrder;
  const anchorRank = (await nodeRow(f.m1)).sortOrder;
  assert.ok(
    compareUtf16(anchorRank, otherRankBefore) < 0,
    "fixture: the other Scene starts after the anchor",
  );
  const beforeOther = await observedWrite(ctx, () =>
    treePatch(ctx, f.m3, { sortOrder: "l9" }),
  );
  const otherRankAfter = (await nodeRow(f.m3)).sortOrder;
  assert.equal(otherRankAfter, "l9");
  assert.ok(
    compareUtf16(otherRankAfter, (await nodeRow(f.m1)).sortOrder) < 0,
    "the other Scene now sorts before the anchor (UTF-16 order, as the Scope authority sorts siblings)",
  );
  assertScopeEffect(
    beforeOther,
    [f.m3],
    "moving another Scene before the anchor",
  );
  const afterBeforeOther = await revisionStatuses(ctx, orderRevs);
  assertStatuses(
    afterBeforeOther,
    { m1b: "available", m2a: "available" },
    "moving another Scene before the anchor",
  );
  const edgesBeforeOther = await assertProjectionEdges(
    ctx,
    orderRevs,
    { m1b: "available", m2a: "available" },
    "moving another Scene before the anchor",
  );
  const reorder = await observedWrite(ctx, () =>
    treePatch(ctx, f.m1, { sortOrder: "m4" }),
  );
  assertScopeEffect(reorder, [f.m1], "anchor reorder");
  const afterReorder = await revisionStatuses(ctx, orderRevs);
  assertStatuses(
    afterReorder,
    { m1b: "unavailable", m2a: "available" },
    "anchor reorder",
  );
  const edgesReorder = await assertProjectionEdges(
    ctx,
    orderRevs,
    { m1b: "unavailable", m2a: "available" },
    "anchor reorder",
  );
  const revM1c = await newRevision(ctx, f.m1);
  const reparent = await observedWrite(ctx, () =>
    treePatch(ctx, f.m1, { parentId: f.fd, sortOrder: "d1" }),
  );
  assertScopeEffect(reparent, [f.m1], "anchor reparent");
  const afterReparent = await revisionStatuses(ctx, {
    m1c: revM1c,
    m2a: revM2a,
  });
  assertStatuses(
    afterReparent,
    { m1c: "unavailable", m2a: "available" },
    "anchor reparent",
  );
  const edgesReparent = await assertProjectionEdges(
    ctx,
    { m1c: revM1c, m2a: revM2a },
    { m1c: "unavailable", m2a: "available" },
    "anchor reparent",
  );
  step("anchor-reorder-reparent-invalidates-anchor-only", {
    otherSceneMovedBeforeAnchor: afterBeforeOther,
    otherSceneRank: [otherRankBefore, otherRankAfter],
    anchorRank,
    reorder: afterReorder,
    reparent: afterReparent,
    projectionEdges: {
      otherBefore: edgesBeforeOther,
      reorder: edgesReorder,
      reparent: edgesReparent,
    },
    feed: {
      otherBefore: feedSummary(beforeOther),
      reorder: feedSummary(reorder),
      reparent: feedSummary(reparent),
    },
  });

  // --- 4. Folder moves (anchor below the folder) --------------------------
  const revP1a = await newRevision(ctx, f.p1);
  const revP2a = await newRevision(ctx, f.p2);
  const folderMove = await observedWrite(ctx, () =>
    treePatch(ctx, f.fa, { parentId: f.fd, sortOrder: "d2" }),
  );
  assertScopeEffect(folderMove, [f.p1], "folder move");
  assert.equal((await nodeRow(f.fa)).parentId, f.fd, "the folder moved");
  const folderBack = await observedWrite(ctx, () =>
    treePatch(ctx, f.fa, { parentId: null, sortOrder: "x14-3" }),
  );
  assertScopeEffect(folderBack, [f.p1], "folder move back");
  assert.equal((await nodeRow(f.fa)).parentId, null, "the folder moved back");
  const afterFolderRoundTrip = await revisionStatuses(ctx, {
    p1a: revP1a,
    p2a: revP2a,
    m2a: revM2a,
  });
  assertStatuses(
    afterFolderRoundTrip,
    { p1a: "unavailable", p2a: "available", m2a: "available" },
    "folder move and back",
  );
  const edgesFolderRoundTrip = await assertProjectionEdges(
    ctx,
    { p1a: revP1a, p2a: revP2a, m2a: revM2a },
    { p1a: "unavailable", p2a: "available", m2a: "available" },
    "folder move and back",
  );
  const revP1b = await newRevision(ctx, f.p1);
  const folderReorder = await observedWrite(ctx, () =>
    treePatch(ctx, f.fa, { sortOrder: "x14-35" }),
  );
  assertScopeEffect(folderReorder, [f.p1], "folder reorder");
  assertStatuses(
    await revisionStatuses(ctx, { p1b: revP1b, p2a: revP2a }),
    { p1b: "unavailable", p2a: "available" },
    "folder reorder",
  );
  const revP1c = await newRevision(ctx, f.p1);
  const folderArchive = await observedWrite(ctx, () =>
    treePatch(ctx, f.fa, { archivedAt: new Date().toISOString() }),
  );
  assertScopeEffect(folderArchive, [f.p1], "folder archive");
  assert.notEqual(
    (await nodeRow(f.fa)).archivedAt,
    null,
    "the folder is archived",
  );
  const archivedStatuses = await revisionStatuses(ctx, {
    p1c: revP1c,
    p2a: revP2a,
  });
  assertStatuses(
    archivedStatuses,
    { p1c: "unavailable", p2a: "available" },
    "folder archive",
  );
  const folderRestore = await observedWrite(ctx, () =>
    treePatch(ctx, f.fa, { archivedAt: null }),
  );
  assertScopeEffect(folderRestore, [f.p1], "folder unarchive");
  assert.equal(
    (await nodeRow(f.fa)).archivedAt,
    null,
    "the folder is restored",
  );
  const restoredStatuses = await revisionStatuses(ctx, {
    p1c: revP1c,
    p2a: revP2a,
  });
  assertStatuses(
    restoredStatuses,
    { p1c: "unavailable", p2a: "available" },
    "folder unarchive does not return",
  );
  const edgesFolderRestore = await assertProjectionEdges(
    ctx,
    { p1c: revP1c, p2a: revP2a },
    { p1c: "unavailable", p2a: "available" },
    "folder unarchive does not return",
  );
  const revP1d = await newRevision(ctx, f.p1);
  assertStatuses(
    await revisionStatuses(ctx, { p1d: revP1d }),
    { p1d: "available" },
    "a fresh Revision after the round trip",
  );
  step("folder-roundtrip-does-not-return", {
    folderMoveAndBack: afterFolderRoundTrip,
    archived: archivedStatuses,
    unarchived: restoredStatuses,
    projectionEdges: {
      moveAndBack: edgesFolderRoundTrip,
      unarchived: edgesFolderRestore,
    },
    freshAfterRoundTrip: "available",
    feed: {
      move: feedSummary(folderMove),
      back: feedSummary(folderBack),
      reorder: feedSummary(folderReorder),
      archive: feedSummary(folderArchive),
      unarchive: feedSummary(folderRestore),
    },
  });

  // --- 4b. Empty folder and note: nothing moves ---------------------------
  const keep = { p1d: revP1d, p2a: revP2a, m2a: revM2a };
  const emptyAndNote = await observedWrite(ctx, async () => {
    await treePatch(ctx, f.fe, { title: "X14 empty renamed" });
    await treePatch(ctx, f.fe, { parentId: f.fb, sortOrder: "e1" });
    await treePatch(ctx, f.fe, { sortOrder: "e2" });
    await treePatch(ctx, f.fe, { archivedAt: new Date().toISOString() });
    await treePatch(ctx, f.fe, { archivedAt: null });
    await treePatch(ctx, f.note, { title: "X14 note renamed" });
    await treePatch(ctx, f.note, { parentId: f.fd, sortOrder: "n1" });
    await treePatch(ctx, f.note, { archivedAt: new Date().toISOString() });
    await treePatch(ctx, f.note, { archivedAt: null });
  });
  assertScopeEffect(emptyAndNote, [], "empty folder and note edits");
  const emptyStatuses = await revisionStatuses(ctx, keep);
  assertStatuses(
    emptyStatuses,
    { p1d: "available", p2a: "available", m2a: "available" },
    "empty folder and note edits",
  );
  const emptyEdges = await assertProjectionEdges(
    ctx,
    keep,
    { p1d: "available", p2a: "available", m2a: "available" },
    "empty folder and note edits",
  );
  step("empty-folder-and-note-keep-everything", {
    statuses: emptyStatuses,
    projectionEdges: emptyEdges,
    edits: 9,
    feed: feedSummary(emptyAndNote),
  });

  // --- 5. Anchor Scope X -> Y -> X, archive, story key -------------------
  const revQ1a = await newRevision(ctx, f.q1);
  const q1Initial = await observe(f.q1);
  const scopeY = await observedWrite(ctx, () =>
    updateSceneScope(ctx, f.q1, {
      kind: "unresolved",
      reason: "x1-4-scope-roundtrip",
    }),
  );
  assertScopeEffect(scopeY, [f.q1], "anchor Scope X->Y");
  const scopeYStatuses = await revisionStatuses(ctx, { q1a: revQ1a });
  assertStatuses(scopeYStatuses, { q1a: "unavailable" }, "anchor Scope X->Y");
  const scopeX = await observedWrite(ctx, () =>
    updateSceneScope(ctx, f.q1, { kind: "any" }),
  );
  assertScopeEffect(scopeX, [f.q1], "anchor Scope Y->X");
  const q1Back = await observe(f.q1);
  const scopeBack = await readScope(ctx, f.q1);
  assert.deepEqual(scopeBack.binding.materialConstraint.timeline, {
    kind: "any",
  });
  assert.equal(Number(q1Back.version), Number(q1Initial.version) + 2);
  assert.notEqual(
    q1Back.sourceToken,
    q1Initial.sourceToken,
    "X->Y->X does not return the v1 token",
  );
  const scopeBackStatuses = await revisionStatuses(ctx, { q1a: revQ1a });
  assertStatuses(
    scopeBackStatuses,
    { q1a: "unavailable" },
    "anchor Scope X->Y->X",
  );
  const edgesScopeBack = await assertProjectionEdges(
    ctx,
    { q1a: revQ1a },
    { q1a: "unavailable" },
    "anchor Scope X->Y->X",
  );
  step("anchor-scope-roundtrip-stays-invalid", {
    anchor: f.q1,
    generation: [q1Initial.version, q1Back.version],
    tokens: [q1Initial.sourceToken, q1Back.sourceToken],
    afterY: scopeYStatuses,
    afterBackToX: scopeBackStatuses,
    projectionEdgesAfterBackToX: edgesScopeBack,
    feed: { toY: feedSummary(scopeY), backToX: feedSummary(scopeX) },
  });

  const revQ1b = await newRevision(ctx, f.q1);
  const archiveScene = await observedWrite(ctx, () =>
    treePatch(ctx, f.q1, { archivedAt: new Date().toISOString() }),
  );
  assertScopeEffect(archiveScene, [f.q1], "anchor archive");
  const archivedSceneStatuses = await revisionStatuses(ctx, { q1b: revQ1b });
  assertStatuses(
    archivedSceneStatuses,
    { q1b: "unavailable" },
    "anchor archive",
  );
  const unarchiveScene = await observedWrite(ctx, () =>
    treePatch(ctx, f.q1, { archivedAt: null }),
  );
  assertScopeEffect(unarchiveScene, [f.q1], "anchor unarchive");
  const unarchivedSceneStatuses = await revisionStatuses(ctx, { q1b: revQ1b });
  assertStatuses(
    unarchivedSceneStatuses,
    { q1b: "unavailable" },
    "anchor unarchive does not return",
  );
  const edgesUnarchived = await assertProjectionEdges(
    ctx,
    { q1b: revQ1b },
    { q1b: "unavailable" },
    "anchor unarchive does not return",
  );
  step("anchor-archive-roundtrip-stays-invalid", {
    archived: archivedSceneStatuses,
    unarchived: unarchivedSceneStatuses,
    projectionEdgesUnarchived: edgesUnarchived,
    feed: {
      archive: feedSummary(archiveScene),
      unarchive: feedSummary(unarchiveScene),
    },
  });

  const revQ1c = await newRevision(ctx, f.q1);
  const storyOn = await observedWrite(ctx, async () =>
    temporalSetStoryOrder(
      ctx,
      f.q1,
      Number((await observe(f.q1)).treeVersion),
      "x14-story-1",
    ),
  );
  assertScopeEffect(storyOn, [f.q1], "anchor story key");
  const storyOnStatuses = await revisionStatuses(ctx, { q1c: revQ1c });
  assertStatuses(storyOnStatuses, { q1c: "unavailable" }, "anchor story key");
  const storyOff = await observedWrite(ctx, async () =>
    temporalSetStoryOrder(
      ctx,
      f.q1,
      Number((await observe(f.q1)).treeVersion),
      null,
    ),
  );
  assertScopeEffect(storyOff, [f.q1], "anchor story key cleared");
  const storyOffStatuses = await revisionStatuses(ctx, { q1c: revQ1c });
  assertStatuses(
    storyOffStatuses,
    { q1c: "unavailable" },
    "anchor story key round trip",
  );
  const edgesStoryOff = await assertProjectionEdges(
    ctx,
    { q1c: revQ1c },
    { q1c: "unavailable" },
    "anchor story key round trip",
  );
  step("story-time-order-roundtrip-stays-invalid", {
    set: storyOnStatuses,
    cleared: storyOffStatuses,
    projectionEdgesCleared: edgesStoryOff,
    feed: { set: feedSummary(storyOn), cleared: feedSummary(storyOff) },
  });

  const revQ1d = await newRevision(ctx, f.q1);
  const otherScope = await observedWrite(ctx, async () => {
    await updateSceneScope(ctx, f.q2, {
      kind: "unresolved",
      reason: "x1-4-other-scene",
    });
    await treePatch(ctx, f.q2, { sortOrder: "p45" });
    await treePatch(ctx, f.q2, { povCharacterId: ctx.entityIds.mira });
  });
  assertScopeEffect(otherScope, [f.q2], "other Scene Scope changes");
  const otherScopeStatuses = await revisionStatuses(ctx, {
    q1d: revQ1d,
    p2a: revP2a,
  });
  assertStatuses(
    otherScopeStatuses,
    { q1d: "available", p2a: "available" },
    "other Scene Scope changes",
  );
  const otherScopeEdges = await assertProjectionEdges(
    ctx,
    { q1d: revQ1d, p2a: revP2a },
    { q1d: "available", p2a: "available" },
    "other Scene Scope changes",
  );
  step("other-scene-scope-change-keeps-anchor", {
    changedScene: f.q2,
    statuses: otherScopeStatuses,
    projectionEdges: otherScopeEdges,
    feed: feedSummary(otherScope),
  });

  // --- 6. Delete -> recreate, trash restore -------------------------------
  const revDel = await newRevision(ctx, f.del);
  const delBefore = await observe(f.del);
  await treeDelete(ctx, f.del);
  const deletedBindings = await rows(
    ctx.harness,
    ctx.page,
    `SELECT COUNT(*) AS n FROM narrative_scene_scope_bindings WHERE project_id = ? AND scene_id = ?`,
    [ctx.projectId, f.del],
  );
  assert.equal(
    Number(deletedBindings[0].n),
    0,
    "the binding goes with the Scene",
  );
  const deletedStatuses = await revisionStatuses(ctx, { del: revDel });
  assertStatuses(deletedStatuses, { del: "unavailable" }, "anchor delete");
  await treeCreate(ctx, {
    id: f.del,
    nodeType: "scene",
    title: "X14 del recreated",
    parentId: f.fb,
    sortOrder: "p5",
  });
  const delAfter = await observe(f.del);
  assert.notEqual(
    delAfter.incarnation,
    delBefore.incarnation,
    "a new incarnation",
  );
  const recreatedStatuses = await revisionStatuses(ctx, { del: revDel });
  assertStatuses(
    recreatedStatuses,
    { del: "unavailable" },
    "anchor recreated with the same ID",
  );
  const revDelNew = await newRevision(ctx, f.del);
  assertStatuses(
    await revisionStatuses(ctx, { delNew: revDelNew }),
    { delNew: "available" },
    "a fresh Revision on the recreated Scene",
  );
  step("anchor-delete-recreate-stays-invalid", {
    sceneId: f.del,
    incarnations: [delBefore.incarnation, delAfter.incarnation],
    afterDelete: deletedStatuses,
    afterRecreate: recreatedStatuses,
  });

  const trashItemId = `x14-trash-${randomUUID()}`;
  await ctx.harness.invokeOk(ctx.page, "trash_bin_create", {
    payload: {
      id: trashItemId,
      projectId: ctx.projectId,
      kind: "structure-item",
      subKind: "scene",
      originSceneId: null,
      originCodexId: null,
      previewText: "X14 trash restore",
      previewMeta: null,
      payload: JSON.stringify({
        originalId: f.del,
        title: "X14 restored scene",
        body: proseDoc("X14Trash"),
        beats: "[]",
        povCharacterId: null,
        folderHintId: f.fb,
        folderHintName: null,
        metadata: {
          synopsis: "restored",
          status: "draft",
          nodeType: "scene",
          locationId: null,
          sortOrder: "p6",
          storyTimeOrder: null,
          storyTimeLabel: null,
        },
        charCount: 8,
      }),
      charCount: 8,
      isInteresting: false,
      deletedAt: new Date().toISOString(),
    },
  });
  const restoreRevs = { del: revDel, delNew: revDelNew };
  const restored = await ctx.harness.invokeOk(ctx.page, "trash_bin_restore", {
    payload: {
      requestId: `x1-4-trash-restore:${trashItemId}`,
      sessionId: WRITER_SESSION_ID,
      projectId: ctx.projectId,
      itemId: trashItemId,
      boardIdOverride: null,
      dropX: null,
      dropY: null,
    },
  });
  const restoredSceneId = String(restored.newId);
  assert.notEqual(
    restoredSceneId,
    f.del,
    "a trash restore creates a different Scene ID",
  );
  const restoredScene = await observe(restoredSceneId);
  assert.notEqual(restoredScene.incarnation, delAfter.incarnation);
  const restoredRevisionStatuses = await revisionStatuses(ctx, restoreRevs);
  assertStatuses(
    restoredRevisionStatuses,
    { del: "unavailable", delNew: "available" },
    "trash restore",
  );
  const revRestored = await newRevision(ctx, restoredSceneId);
  assertStatuses(
    await revisionStatuses(ctx, { restored: revRestored }),
    { restored: "available" },
    "a Revision on the restored Scene",
  );
  step("trash-restore-stays-invalid", {
    restoredSceneId,
    incarnation: restoredScene.incarnation,
    generation: restoredScene.version,
    statuses: restoredRevisionStatuses,
  });

  // --- 7. Feed and pending observations -----------------------------------
  const bodyFeed = f9;
  assert.deepEqual(bodyFeed.scopeEventScenes, []);
  assert.ok(
    (bodyFeed.eventKinds.scene ?? 0) >= 1,
    "the body saves emitted scene events, so the empty scene-scope set is not vacuous",
  );
  assert.deepEqual(
    f9Edges,
    { m1a: "fresh", m2a: "fresh" },
    "after Incremental Freshness, the body saves left every projection edge fresh",
  );
  step("body-event-does-not-make-pending", {
    scopeEventScenes: bodyFeed.scopeEventScenes,
    projectionEdgesAfterFreshness: f9Edges,
    eventKinds: bodyFeed.eventKinds,
    feedHead: [bodyFeed.cursorBefore.head, bodyFeed.cursorAfter.head],
    acknowledgedThrough: bodyFeed.cursorAfter.acknowledgedThrough,
    routing:
      "PendingRelevantChange itself is judged in Packing (closed) and covered by the Rust x13_* tests; here the Feed events (no scene-scope event) and the saved projection edge states after the Incremental Freshness cycle (all fresh) are observed",
  });
  assert.deepEqual(pov.scopeEventScenes, [f.m1]);
  assert.ok(
    (pov.eventKinds["scene-scope"] ?? 0) >= 1,
    "the POV patch emitted a scene-scope event",
  );
  assert.deepEqual(
    povEdges,
    { m1a: STALE_EDGE_STATE, m2a: "fresh" },
    "after Incremental Freshness, only the anchor's projection edge is stale",
  );
  step("scope-event-pends-anchor-only", {
    anchor: f.m1,
    projectionEdgesAfterFreshness: povEdges,
    scopeEventScenes: pov.scopeEventScenes,
    otherAnchorScopeEvents: pov.scopeEventScenes.filter((id) => id === f.m2),
    eventKinds: pov.eventKinds,
    acknowledgedThrough: pov.cursorAfter.acknowledgedThrough,
  });
}

// ---------------------------------------------------------------------------
// S3: persons the Scope names, Undo Journal replay, project snapshot restore.
// Everything below goes through the writers the product uses.  The Interactive
// Agent create (`agent_codex_create`) needs a one-shot capability that Main
// issues from a chat tool_use response, which this journey (no AI dispatch)
// cannot and must not obtain.  The renderer's own Codex writers reach the same
// Native function with a renderer context and return the same `undoJournalId`,
// which Main records for the sender, so the Undo Journal replay below is the
// real `agent_apply_undo_journal` route.
// ---------------------------------------------------------------------------

const CHARACTER_REFERENCED = /NEX_SCENE_SCOPE_CHARACTER_REFERENCED/u;
const FEED_DISCONTINUITY = /NARRATIVE_CHANGE_FEED_DISCONTINUITY/u;
const HISTORY_REPLAY_CONTROLS = Object.freeze([
  "original-transaction",
  "journal-lineage",
  "typed-writer",
  "occ",
  "change-event",
  "change-feed",
]);
const READER_PRINCIPAL = Object.freeze({ kind: "reader" });

function characterPrincipal(entryId) {
  return { kind: "character", ref: entryId };
}

async function codexRow(ctx, entryId) {
  const result = await rows(
    ctx.harness,
    ctx.page,
    `SELECT id, type, version, name FROM codex_entries WHERE project_id = ? AND id = ?`,
    [ctx.projectId, entryId],
  );
  return result[0] ?? null;
}

/** A person (character) through the renderer's Codex writer. */
async function codexCreateCharacter(ctx, label, name) {
  const entryId = `x14-${label}-${randomUUID()}`;
  const result = await ctx.harness.invokeOk(ctx.page, "codex_create", {
    payload: {
      ...writerIdentity(ctx.projectId, `codex-create-${label}`),
      surface: "manual",
      entryId,
      typeSlug: "character",
      name,
      summary: `${name} summary`,
      content: proseDoc(`${name} content`),
      aliases: null,
      excludedAliases: null,
      readings: null,
      tagsCache: null,
      parentId: null,
      sourceChatMessageId: null,
      model: null,
      chatMessageId: null,
      traceId: null,
      authorshipSpans: [],
    },
  });
  assert.equal(String(result.entityId), entryId);
  assertNonEmpty(String(result.undoJournalId), `${label} create journal id`);
  const row = await codexRow(ctx, entryId);
  assert.ok(row, `${label} exists after create`);
  assert.equal(row.type, "character");
  return { entryId, journalId: String(result.undoJournalId) };
}

async function codexDelete(ctx, entryId, label) {
  const row = await codexRow(ctx, entryId);
  assert.ok(row, `${label}: the person to delete exists`);
  return ctx.harness.invokeOk(ctx.page, "codex_delete", {
    payload: {
      ...writerIdentity(ctx.projectId, `codex-delete-${label}`),
      surface: "manual",
      entryId,
      baseVersion: Number(row.version),
    },
  });
}

async function codexRetype(ctx, entryId, typeSlug, label) {
  const row = await codexRow(ctx, entryId);
  assert.ok(row, `${label}: the person to retype exists`);
  return ctx.harness.invokeOk(ctx.page, "codex_update", {
    payload: {
      ...writerIdentity(ctx.projectId, `codex-retype-${label}`),
      surface: "manual",
      entryId,
      baseVersion: Number(row.version),
      typeSlug,
      model: null,
      chatMessageId: null,
      traceId: null,
      authorshipSpans: null,
      authorshipSpanLanes: null,
    },
  });
}

/** Undo or redo one Undo Journal entry through the history-replay route. */
async function applyUndoJournal(ctx, journalId, direction) {
  return ctx.harness.invokeOk(ctx.page, "agent_apply_undo_journal", {
    payload: {
      requestId: `x1-4-journal-${direction}:${randomUUID()}`,
      projectId: ctx.projectId,
      sessionId: WRITER_SESSION_ID,
      journalId,
      direction,
      authorityRoute: "history-replay",
      origin: direction,
      caller: "undo-redo-command",
      controls: [...HISTORY_REPLAY_CONTROLS],
    },
  });
}

async function expectRejected(label, pattern, action) {
  const failure = await action().then(
    () => null,
    (error) => ipcFailureText(error),
  );
  assert.ok(failure, `${label} must be rejected`);
  assert.match(failure, pattern, `${label}: rejected with its defense code`);
  return failure.slice(0, 300);
}

/** The Scope binding, the tree row and the POV of one Scene (renderer SELECT). */
async function sceneScopeFull(ctx, sceneId) {
  const scene = await observeScene(
    ctx.harness,
    ctx.page,
    ctx.projectId,
    sceneId,
  );
  const extra = await rows(
    ctx.harness,
    ctx.page,
    `SELECT b.knowledge_holder_json AS holder, b.audience_json AS audience,
            n.pov_character_id AS pov, n.title AS title
       FROM narrative_scene_scope_bindings b
       JOIN tree_nodes n ON n.id = b.scene_id AND n.project_id = b.project_id
      WHERE b.project_id = ? AND b.scene_id = ?`,
    [ctx.projectId, sceneId],
  );
  assert.equal(extra.length, 1, `Scene ${sceneId} binding and tree row`);
  return { ...scene, ...extra[0] };
}

async function feedEventTotals(ctx) {
  const cursor = await feedCursor(ctx);
  const count = await rows(
    ctx.harness,
    ctx.page,
    `SELECT COUNT(*) AS n FROM narrative_change_events WHERE project_id = ?`,
    [ctx.projectId],
  );
  return { head: cursor.head, events: Number(count[0]?.n ?? 0) };
}

async function createS3Fixture(ctx) {
  const folderId = `x14-s3-folder-${randomUUID()}`;
  await treeCreate(ctx, {
    id: folderId,
    nodeType: "folder",
    title: "X14 S3",
    sortOrder: "x14-s3",
  });
  const scenes = {};
  for (const [index, name] of [
    "pov",
    "other",
    "hold",
    "aud",
    "jpov",
    "def2",
  ].entries()) {
    scenes[name] = `x14s3-${name}-${randomUUID()}`;
    await treeCreate(ctx, {
      id: scenes[name],
      nodeType: "scene",
      title: `X14 S3 ${name}`,
      parentId: folderId,
      sortOrder: `s${index}`,
    });
  }
  return { folderId, scenes };
}

/** What a rejected or no-op route must leave exactly as it found it. */
async function characterRouteState(ctx, scenes, people, revisions) {
  const state = { scenes: {}, people: {} };
  for (const [name, sceneId] of Object.entries(scenes)) {
    state.scenes[name] = await sceneScopeFull(ctx, sceneId);
  }
  for (const [name, entryId] of Object.entries(people)) {
    state.people[name] = await codexRow(ctx, entryId);
  }
  state.feed = await feedEventTotals(ctx);
  state.revisions = await revisionStatuses(ctx, revisions);
  return state;
}

function jsonKind(text) {
  return JSON.parse(String(text)).kind;
}

async function runCharacterAndJournalChecks(ctx, step) {
  const { scenes } = await createS3Fixture(ctx);

  // --- 1. A person only a POV names: the delete goes through ---------------
  const povPerson = await codexCreateCharacter(ctx, "pov", "POV Person");
  await treePatch(ctx, scenes.pov, { povCharacterId: povPerson.entryId });
  const revPov = await newRevision(ctx, scenes.pov);
  const revOther = await newRevision(ctx, scenes.other);
  const povBefore = await sceneScopeFull(ctx, scenes.pov);
  const otherBefore = await sceneScopeFull(ctx, scenes.other);
  assert.equal(povBefore.pov, povPerson.entryId);
  const povDeletion = await observedWrite(ctx, () =>
    codexDelete(ctx, povPerson.entryId, "pov"),
  );
  const povAfter = await sceneScopeFull(ctx, scenes.pov);
  const otherAfter = await sceneScopeFull(ctx, scenes.other);
  assert.equal(await codexRow(ctx, povPerson.entryId), null);
  assert.equal(povAfter.pov, null, "the foreign key clears the POV");
  assert.equal(povAfter.incarnation, povBefore.incarnation);
  assert.equal(
    Number(povAfter.version),
    Number(povBefore.version) + 1,
    "the Scope generation advances once",
  );
  assert.notEqual(povAfter.sourceToken, povBefore.sourceToken);
  assert.equal(otherAfter.version, otherBefore.version);
  assert.equal(otherAfter.sourceToken, otherBefore.sourceToken);
  assertScopeEffect(povDeletion, [scenes.pov], "POV-only person delete");
  const povStatuses = await revisionStatuses(ctx, {
    pov: revPov,
    other: revOther,
  });
  assertStatuses(
    povStatuses,
    { pov: "unavailable", other: "available" },
    "POV-only person delete",
  );
  const povEdges = await assertProjectionEdges(
    ctx,
    { pov: revPov, other: revOther },
    { pov: "unavailable", other: "available" },
    "POV-only person delete",
  );
  step("pov-only-person-delete-nulls-pov", {
    scene: scenes.pov,
    generation: [povBefore.version, povAfter.version],
    statuses: povStatuses,
    projectionEdges: povEdges,
    feed: feedSummary(povDeletion),
  });

  // --- 2. A holder and an audience: delete and type change are refused -----
  const holder = await codexCreateCharacter(ctx, "holder", "Holder Person");
  const audience = await codexCreateCharacter(
    ctx,
    "audience",
    "Audience Person",
  );
  await updateSceneScopeFields(ctx, scenes.hold, {
    knowledgeHolder: characterPrincipal(holder.entryId),
  });
  await updateSceneScopeFields(ctx, scenes.aud, {
    audience: characterPrincipal(audience.entryId),
  });
  const revHold = await newRevision(ctx, scenes.hold);
  const revAud = await newRevision(ctx, scenes.aud);
  const people = { holder: holder.entryId, audience: audience.entryId };
  const watched = {
    hold: scenes.hold,
    aud: scenes.aud,
    other: scenes.other,
  };
  const referencedRevisions = {
    hold: revHold,
    aud: revAud,
    other: revOther,
  };
  const referencedBefore = await characterRouteState(
    ctx,
    watched,
    people,
    referencedRevisions,
  );
  assert.equal(jsonKind(referencedBefore.scenes.hold.holder), "character");
  assert.equal(jsonKind(referencedBefore.scenes.aud.audience), "character");
  assertStatuses(
    referencedBefore.revisions,
    { hold: "available", aud: "available", other: "available" },
    "Revisions anchored to a holder and an audience Scene",
  );
  const rejections = {};
  for (const [label, person] of [
    ["holder", holder],
    ["audience", audience],
  ]) {
    rejections[`${label}-delete`] = await expectRejected(
      `delete of the ${label}`,
      CHARACTER_REFERENCED,
      () => codexDelete(ctx, person.entryId, label),
    );
    rejections[`${label}-type-change`] = await expectRejected(
      `type change of the ${label}`,
      CHARACTER_REFERENCED,
      () => codexRetype(ctx, person.entryId, "location", label),
    );
  }
  assert.deepEqual(
    await characterRouteState(ctx, watched, people, referencedRevisions),
    referencedBefore,
    "a refused delete or type change writes nothing",
  );
  step("referenced-person-delete-and-type-change-rejected", {
    rejections,
    unchanged: ["binding", "person", "pov", "feed", "revisions"],
  });

  // --- 3. Undo Journal replay (J1) -----------------------------------------
  const guard = {};
  guard.holderCreateUndo = await expectRejected(
    "journal undo of the holder's creation",
    CHARACTER_REFERENCED,
    () => applyUndoJournal(ctx, holder.journalId, "undo"),
  );
  guard.audienceCreateUndo = await expectRejected(
    "journal undo of the audience's creation",
    CHARACTER_REFERENCED,
    () => applyUndoJournal(ctx, audience.journalId, "undo"),
  );
  assert.deepEqual(
    await characterRouteState(ctx, watched, people, referencedRevisions),
    referencedBefore,
    "a refused journal undo writes nothing",
  );

  // Take the holder reference off: the Scope change retires that anchor's
  // Revision, and the person can then be removed and put back by the journal.
  await updateSceneScopeFields(ctx, scenes.hold, {
    knowledgeHolder: READER_PRINCIPAL,
  });
  assertStatuses(
    await revisionStatuses(ctx, referencedRevisions),
    { hold: "unavailable", aud: "available", other: "available" },
    "clearing the holder retires only that anchor's Revision",
  );
  const revHold2 = await newRevision(ctx, scenes.hold);
  const unreferencedRevisions = {
    hold: revHold2,
    aud: revAud,
    other: revOther,
  };
  const holdBeforeJournal = await sceneScopeFull(ctx, scenes.hold);
  const unreferencedUndo = await observedWrite(ctx, () =>
    applyUndoJournal(ctx, holder.journalId, "undo"),
  );
  assert.equal(await codexRow(ctx, holder.entryId), null);
  const holdAfterUndo = await sceneScopeFull(ctx, scenes.hold);
  assert.equal(holdAfterUndo.version, holdBeforeJournal.version);
  assert.equal(holdAfterUndo.sourceToken, holdBeforeJournal.sourceToken);
  assertStatuses(
    await revisionStatuses(ctx, unreferencedRevisions),
    { hold: "available", aud: "available", other: "available" },
    "journal undo of a person nothing references",
  );
  const unreferencedRedo = await observedWrite(ctx, () =>
    applyUndoJournal(ctx, holder.journalId, "redo"),
  );
  assert.ok(
    await codexRow(ctx, holder.entryId),
    "the redo puts the person back",
  );
  const holdAfterRedo = await sceneScopeFull(ctx, scenes.hold);
  assert.equal(jsonKind(holdAfterRedo.holder), "reader");
  assert.equal(holdAfterRedo.version, holdBeforeJournal.version);
  assertStatuses(
    await revisionStatuses(ctx, unreferencedRevisions),
    { hold: "available", aud: "available", other: "available" },
    "journal redo does not name the person again",
  );

  // A delete journal: undo puts the person back, naming the person again makes
  // the redo (delete) a refused route.
  const redoGuard = await codexCreateCharacter(ctx, "redo-guard", "Redo Guard");
  const deleted = await codexDelete(ctx, redoGuard.entryId, "redo-guard");
  const deleteJournalId = String(deleted.undoJournalId);
  assertNonEmpty(deleteJournalId, "delete journal id");
  await applyUndoJournal(ctx, deleteJournalId, "undo");
  assert.ok(await codexRow(ctx, redoGuard.entryId), "the delete was undone");
  await updateSceneScopeFields(ctx, scenes.hold, {
    knowledgeHolder: characterPrincipal(redoGuard.entryId),
  });
  const revHold3 = await newRevision(ctx, scenes.hold);
  const redoWatch = { hold: scenes.hold, aud: scenes.aud, other: scenes.other };
  const redoPeople = { redoGuard: redoGuard.entryId };
  const redoRevisions = { hold: revHold3, aud: revAud, other: revOther };
  const redoBefore = await characterRouteState(
    ctx,
    redoWatch,
    redoPeople,
    redoRevisions,
  );
  guard.deleteRedo = await expectRejected(
    "journal redo of a delete while the person is named",
    CHARACTER_REFERENCED,
    () => applyUndoJournal(ctx, deleteJournalId, "redo"),
  );
  guard.createUndoWhileNamed = await expectRejected(
    "journal undo of the creation while the person is named",
    CHARACTER_REFERENCED,
    () => applyUndoJournal(ctx, redoGuard.journalId, "undo"),
  );
  assert.deepEqual(
    await characterRouteState(ctx, redoWatch, redoPeople, redoRevisions),
    redoBefore,
    "a refused journal redo or undo writes nothing",
  );

  // A person only a POV names, removed and put back by the journal: the POV
  // clears with the delete, the person coming back does not name it again, and
  // the Revision anchored there needs a new approval.
  const journalPov = await codexCreateCharacter(ctx, "jpov", "Journal POV");
  await treePatch(ctx, scenes.jpov, { povCharacterId: journalPov.entryId });
  const revJpov = await newRevision(ctx, scenes.jpov);
  const jpovRevisions = { jpov: revJpov, other: revOther };
  const jpovBefore = await sceneScopeFull(ctx, scenes.jpov);
  assert.equal(jpovBefore.pov, journalPov.entryId);
  const povUndo = await observedWrite(ctx, () =>
    applyUndoJournal(ctx, journalPov.journalId, "undo"),
  );
  const jpovAfterUndo = await sceneScopeFull(ctx, scenes.jpov);
  assert.equal(await codexRow(ctx, journalPov.entryId), null);
  assert.equal(jpovAfterUndo.pov, null);
  assert.equal(
    Number(jpovAfterUndo.version),
    Number(jpovBefore.version) + 1,
    "the journal undo advances the Scope generation once",
  );
  assert.deepEqual(Object.keys(povUndo.advanced), [scenes.jpov]);
  assert.equal(Object.values(povUndo.advanced)[0], 1);
  const afterPovUndo = await revisionStatuses(ctx, jpovRevisions);
  assertStatuses(
    afterPovUndo,
    { jpov: "unavailable", other: "available" },
    "journal undo of the POV person",
  );
  const povRedo = await observedWrite(ctx, () =>
    applyUndoJournal(ctx, journalPov.journalId, "redo"),
  );
  assert.ok(
    await codexRow(ctx, journalPov.entryId),
    "the redo puts the person back",
  );
  const jpovAfterRedo = await sceneScopeFull(ctx, scenes.jpov);
  assert.equal(jpovAfterRedo.pov, null, "the POV is not restored by the redo");
  const afterPovRedo = await revisionStatuses(ctx, jpovRevisions);
  assertStatuses(
    afterPovRedo,
    { jpov: "unavailable", other: "available" },
    "journal redo of the POV person",
  );
  const jpovEdges = await assertProjectionEdges(
    ctx,
    jpovRevisions,
    { jpov: "unavailable", other: "available" },
    "journal undo and redo of the POV person",
  );
  step("journal-undo-redo-guard-and-invalidate", {
    guard,
    unreferencedJournal: {
      undo: feedSummary(unreferencedUndo),
      redo: feedSummary(unreferencedRedo),
    },
    povJournal: {
      generation: [
        jpovBefore.version,
        jpovAfterUndo.version,
        jpovAfterRedo.version,
      ],
      afterUndo: afterPovUndo,
      afterRedo: afterPovRedo,
      projectionEdges: jpovEdges,
      undo: feedSummary(povUndo),
      redo: feedSummary(povRedo),
    },
    note: "a person a Scope still names cannot be put back by the journal as a stale reference: the guard refuses the removal, so the A1 invalidation on re-insert is covered by the Rust x13_* tests only",
  });

  // --- 4. DEF-2 probe: the Scene patch after a journal removed its POV -----
  const def2Person = await codexCreateCharacter(ctx, "def2", "DEF-2 Person");
  await treePatch(ctx, scenes.def2, { povCharacterId: def2Person.entryId });
  await applyUndoJournal(ctx, def2Person.journalId, "undo");
  const def2Before = await sceneScopeFull(ctx, scenes.def2);
  assert.equal(def2Before.pov, null, "the journal undo cleared the POV");
  const def2FeedBefore = await feedEventTotals(ctx);
  const def2Outcome = await treePatch(ctx, scenes.def2, {
    title: "X14 S3 def2 next patch",
  }).then(
    () => ({ result: "accepted", error: "" }),
    (error) => ({ result: "rejected", error: ipcFailureText(error) }),
  );
  const def2After = await sceneScopeFull(ctx, scenes.def2);
  const def2FeedAfter = await feedEventTotals(ctx);
  const def2Reproduced =
    def2Outcome.result === "rejected" &&
    FEED_DISCONTINUITY.test(def2Outcome.error);
  if (def2Outcome.result === "accepted") {
    assert.equal(def2After.title, "X14 S3 def2 next patch");
  } else {
    // Fail closed: a rejected patch rolled back, so nothing was written.
    assert.deepEqual(
      { ...def2After },
      { ...def2Before },
      "a rejected patch leaves the Scene and its binding untouched",
    );
    assert.deepEqual(
      def2FeedAfter,
      def2FeedBefore,
      "a rejected patch appends no Change Feed event",
    );
  }
  step("probe-def2-journal-pov-null-next-patch", {
    result: def2Outcome.result,
    reproduced: def2Reproduced,
    error: def2Outcome.error.slice(0, 400),
    rolledBack: def2Outcome.result === "rejected",
    note: "diagnostic only (DR-X1-3-18 (3)); reproduced or not both pass",
  });
}

// --- project snapshot (body scope) -------------------------------------------

const SNAPSHOT_TREE_SELECT = `SELECT id, parent_id, node_type, title, synopsis, intent, sort_order,
       story_time_order, story_time_label, pov_character_id, location_id,
       chronicle_start_time, chronicle_start_minute, chronicle_start_granularity,
       chronicle_end_time, chronicle_end_minute, chronicle_end_granularity,
       chronicle_precision, status, content, unplaced_beats_doc, char_count,
       created_at, updated_at
  FROM tree_nodes WHERE project_id = ? ORDER BY id`;

/** The body-owned aux scopes, in the order the renderer's restore pushes them. */
const BODY_AUX_RESTORE_SCOPES = Object.freeze([
  "authorship_spans",
  "post_effect_annotations",
  "post_effect_annotation_relations",
  "scene_codex_pins",
  "scene_codex_mentions",
  "scene_beat_pov_cache",
  "plot_threads",
  "plot_thread_scene_links",
  "plot_thread_branches",
  "events",
  "scene_events",
  "event_participants",
  "event_relations",
  "project_calendar",
]);

/**
 * Capture the project like the renderer's `createProjectSnapshot`: every tree
 * row, the body of a Scene or note through a `content_versions` row (the INSERT
 * is the one `createRevision` sends through Drizzle), and the Native
 * `project_snapshot_create` aggregate for the rest.
 */
async function createProjectSnapshotThroughNative(ctx, label) {
  const snapshotId = `x14-snapshot-${label}-${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const nodes = await rows(ctx.harness, ctx.page, SNAPSHOT_TREE_SELECT, [
    ctx.projectId,
  ]);
  const treeRows = [];
  const versionIds = [];
  for (const node of nodes) {
    let bodyVersionId = null;
    const hasBody =
      (node.node_type === "scene" || node.node_type === "note") &&
      node.content &&
      node.content !== "{}";
    if (hasBody) {
      bodyVersionId = randomUUID();
      await ctx.harness.invokeOk(ctx.page, "db_execute", {
        sql: `INSERT INTO content_versions
                (id, entity_type, entity_id, content, version_number, snapshot_type, created_at)
              VALUES (?, ?, ?, ?,
                (SELECT COALESCE(MAX(version_number), 0) + 1 FROM content_versions
                  WHERE entity_type = ? AND entity_id = ?),
                'manual', ?)`,
        params: [
          bodyVersionId,
          node.node_type,
          node.id,
          node.content,
          node.node_type,
          node.id,
          createdAt,
        ],
        method: "run",
      });
      versionIds.push(bodyVersionId);
    }
    treeRows.push({
      snapshot_id: snapshotId,
      node_id: node.id,
      parent_id: node.parent_id ?? null,
      node_type: node.node_type,
      title: node.title,
      synopsis: node.synopsis ?? null,
      intent: node.intent ?? null,
      sort_order: node.sort_order,
      story_time_order: node.story_time_order ?? null,
      story_time_label: node.story_time_label ?? null,
      pov_character_id: node.pov_character_id ?? null,
      location_id: node.location_id ?? null,
      chronicle_start_time: node.chronicle_start_time ?? null,
      chronicle_start_minute: node.chronicle_start_minute ?? null,
      chronicle_start_granularity: node.chronicle_start_granularity ?? "none",
      chronicle_end_time: node.chronicle_end_time ?? null,
      chronicle_end_minute: node.chronicle_end_minute ?? null,
      chronicle_end_granularity: node.chronicle_end_granularity ?? "none",
      chronicle_precision: node.chronicle_precision ?? "exact",
      status: node.status ?? null,
      body_version_id: bodyVersionId,
      unplaced_beats_doc: node.unplaced_beats_doc,
      char_count: node.char_count,
      created_at: node.created_at,
      updated_at: node.updated_at,
    });
  }
  await ctx.harness.invokeOk(ctx.page, "project_snapshot_create", {
    payload: {
      projectId: ctx.projectId,
      snapshotId,
      name: `X1-4 snapshot ${label}`,
      description: null,
      createdAt,
      treeRows,
      codexRows: [],
      snippetRows: [],
      versionIds,
    },
  });
  return {
    snapshotId,
    sceneIds: nodes.filter((n) => n.node_type === "scene").map((n) => n.id),
  };
}

/** The renderer's `restoreStructural` for scope `body` (codex not selected). */
function bodyRestoreInserts(projectId, context) {
  const liveTables = new Set(context.liveTables);
  const liveCodexIds = new Set(context.liveCodexIds);
  const contentById = new Map(
    context.contentRows.map((row) => [row.id, row.content]),
  );
  const aux = new Map(
    context.auxRows.map((row) => [
      row.scope,
      JSON.parse(row.payloadJson).rows ?? [],
    ]),
  );
  const inserts = [];
  const push = (table, row) => {
    if (liveTables.has(table)) inserts.push({ table, row, mode: "insert" });
  };
  const liveOrNull = (value) =>
    value === null || value === undefined || liveCodexIds.has(value)
      ? (value ?? null)
      : null;
  for (const row of context.treeRows) {
    const content = row.body_version_id
      ? (contentById.get(String(row.body_version_id)) ?? "{}")
      : "{}";
    const now = new Date().toISOString();
    push("tree_nodes", {
      id: row.node_id,
      project_id: projectId,
      parent_id: row.parent_id ?? null,
      node_type: row.node_type,
      title: row.title,
      synopsis: row.synopsis ?? null,
      intent: row.intent ?? null,
      sort_order: row.sort_order,
      story_time_order: row.story_time_order ?? null,
      story_time_label: row.story_time_label ?? null,
      pov_character_id: liveOrNull(row.pov_character_id),
      location_id: liveOrNull(row.location_id),
      chronicle_start_time: row.chronicle_start_time ?? null,
      chronicle_start_minute: row.chronicle_start_minute ?? null,
      chronicle_start_granularity: row.chronicle_start_granularity ?? "none",
      chronicle_end_time: row.chronicle_end_time ?? null,
      chronicle_end_minute: row.chronicle_end_minute ?? null,
      chronicle_end_granularity: row.chronicle_end_granularity ?? "none",
      chronicle_precision: row.chronicle_precision ?? "exact",
      status: row.status ?? null,
      content,
      unplaced_beats_doc: row.unplaced_beats_doc ?? "[]",
      char_count: row.char_count ?? 0,
      unplaced_beat_preview: null,
      placed_beat_preview: null,
      created_at: row.created_at ?? now,
      updated_at: row.updated_at ?? now,
    });
  }
  const codexRef = {
    scene_codex_pins: "entry_id",
    scene_codex_mentions: "codex_entry_id",
    scene_beat_pov_cache: "pov_character_id",
    event_participants: "codex_entry_id",
  };
  const auxRowCounts = {};
  for (const scope of BODY_AUX_RESTORE_SCOPES) {
    for (const row of aux.get(scope) ?? []) {
      const ref = codexRef[scope];
      if (ref && typeof row[ref] === "string" && !liveCodexIds.has(row[ref])) {
        continue;
      }
      let next = row;
      if (scope === "events") {
        next = {
          ...row,
          primary_codex_id: liveOrNull(row.primary_codex_id),
          location_codex_id: liveOrNull(row.location_codex_id),
        };
      } else if (scope === "scene_events") {
        next = { ...row, incarnation_token: randomUUID() };
      } else if (scope === "project_calendar") {
        next = { ...row, version: 0 };
      }
      auxRowCounts[scope] = (auxRowCounts[scope] ?? 0) + 1;
      push(scope, next);
    }
  }
  return { inserts, auxRowCounts };
}

async function applyBodySnapshotRestore(ctx, snapshotId) {
  const context = await ctx.harness.invokeOk(
    ctx.page,
    "project_snapshot_restore_context",
    { projectId: ctx.projectId, snapshotId, scopes: ["body"] },
  );
  assert.equal(context.structural, true, "the snapshot is structural");
  const { inserts, auxRowCounts } = bodyRestoreInserts(ctx.projectId, context);
  const result = await ctx.harness.invokeOk(
    ctx.page,
    "project_snapshot_apply_restore",
    {
      payload: {
        requestId: `x1-4-snapshot-restore:${randomUUID()}`,
        sessionId: WRITER_SESSION_ID,
        projectId: ctx.projectId,
        snapshotId,
        scopes: ["body"],
        inserts,
      },
    },
  );
  return { result, insertCount: inserts.length, auxRowCounts };
}

async function restoreEpochCount(ctx) {
  const result = await rows(
    ctx.harness,
    ctx.page,
    `SELECT COUNT(*) AS n FROM narrative_semantic_epochs
      WHERE project_id = ? AND reason = 'restore'`,
    [ctx.projectId],
  );
  return Number(result[0]?.n ?? 0);
}

/** Everything a failed restore must leave as it found it. */
async function projectFingerprint(ctx) {
  const trees = await rows(
    ctx.harness,
    ctx.page,
    `SELECT id, parent_id, version, updated_at, title, pov_character_id,
            archived_at, content
       FROM tree_nodes WHERE project_id = ? ORDER BY id`,
    [ctx.projectId],
  );
  const bindings = await rows(
    ctx.harness,
    ctx.page,
    `SELECT scene_id, scene_incarnation_id, version, source_token,
            knowledge_holder_json, audience_json
       FROM narrative_scene_scope_bindings WHERE project_id = ? ORDER BY scene_id`,
    [ctx.projectId],
  );
  const epochs = await rows(
    ctx.harness,
    ctx.page,
    `SELECT COUNT(*) AS n FROM narrative_semantic_epochs WHERE project_id = ?`,
    [ctx.projectId],
  );
  return {
    trees,
    bindings,
    epochs: Number(epochs[0]?.n ?? 0),
    restoreEpochs: await restoreEpochCount(ctx),
    feed: await feedEventTotals(ctx),
    revisions: await revisionStatuses(
      ctx,
      Object.fromEntries(ctx.revisionLog.map((r) => [r.name, r])),
    ),
  };
}

/**
 * One restore attempt over a fixture of two Scenes: `tk` is never body-saved
 * (version 0), so the snapshot row puts back the very body Source token it had,
 * and `bs` has a body saved before and another after the snapshot.  The
 * attempt either restores or fails with the Change Feed chain error; a failure
 * is checked to have written nothing.
 */
async function runSnapshotRestoreAttempt(ctx, label) {
  const folderId = `x14-snap-${label}-folder-${randomUUID()}`;
  await treeCreate(ctx, {
    id: folderId,
    nodeType: "folder",
    title: `X14 snapshot ${label}`,
    sortOrder: `x14-snap-${label}`,
  });
  const ids = {
    tk: `x14snap-${label}-tk-${randomUUID()}`,
    bs: `x14snap-${label}-bs-${randomUUID()}`,
    late: `x14snap-${label}-late-${randomUUID()}`,
  };
  for (const [index, name] of ["tk", "bs"].entries()) {
    await treeCreate(ctx, {
      id: ids[name],
      nodeType: "scene",
      title: `X14 snapshot ${label} ${name}`,
      parentId: folderId,
      sortOrder: `a${index}`,
    });
  }
  await saveBodyThroughNative(ctx, ids.bs, "SnapBodyBefore");
  const revTk = await newRevision(ctx, ids.tk);
  const revBs = await newRevision(ctx, ids.bs);
  const tkAtSnapshot = await sceneScopeFull(ctx, ids.tk);
  assert.equal(Number(tkAtSnapshot.treeVersion), 0, "tk is never body-saved");
  const snapshot = await createProjectSnapshotThroughNative(ctx, label);
  assert.ok(
    snapshot.sceneIds.includes(ids.tk) && snapshot.sceneIds.includes(ids.bs),
  );

  // The project moves on after the snapshot.
  await treeCreate(ctx, {
    id: ids.late,
    nodeType: "scene",
    title: `X14 snapshot ${label} late`,
    parentId: folderId,
    sortOrder: "a9",
  });
  await treePatch(ctx, ids.tk, { title: `X14 snapshot ${label} tk edited` });
  await saveBodyThroughNative(ctx, ids.bs, "SnapBodyAfter");
  const tkEdited = await sceneScopeFull(ctx, ids.tk);
  assert.notEqual(
    bodyToken(tkEdited),
    bodyToken(tkAtSnapshot),
    "the title edit moved tk's body Source token away from its snapshot value",
  );
  const preStatuses = await revisionStatuses(ctx, { tk: revTk, bs: revBs });
  assertStatuses(
    preStatuses,
    { tk: "available", bs: "available" },
    "title and body edits do not retire the fixture Revisions",
  );
  const bindingsBefore = await snapshotBindings(ctx);
  const fingerprintBefore = await projectFingerprint(ctx);

  const attempt = await applyBodySnapshotRestore(ctx, snapshot.snapshotId).then(
    (applied) => ({ restored: true, applied, error: "" }),
    (error) => ({
      restored: false,
      applied: null,
      error: ipcFailureText(error),
    }),
  );
  const fingerprintAfter = await projectFingerprint(ctx);
  if (!attempt.restored) {
    assert.match(
      attempt.error,
      FEED_DISCONTINUITY,
      `the ${label} restore may fail only on the Change Feed chain (DEF-1): ${attempt.error.slice(0, 300)}`,
    );
    assert.deepEqual(
      fingerprintAfter,
      fingerprintBefore,
      "a failed restore rolls back: no tree, binding, Feed, epoch or Revision change",
    );
  }
  return {
    label,
    ids,
    revisions: { tk: revTk, bs: revBs },
    snapshot,
    tkAtSnapshot,
    tkEdited,
    bindingsBefore,
    fingerprintBefore,
    fingerprintAfter,
    attempt,
  };
}

/**
 * A second project of the workspace (the product's own `project_create`) whose
 * Scenes have no Scope edit history, with two persons for its Revisions.  It
 * is the "basic" fixture of the DEF-1 probe and the other project of the
 * cross-project prepare negative.
 */
async function createSecondProject(ctx) {
  const projectId = `x14-second-project-${randomUUID()}`;
  const now = new Date().toISOString();
  await ctx.harness.invokeOk(ctx.page, "project_create", {
    payload: {
      ...writerIdentity(projectId, "project-create"),
      projectId,
      title: "X1-4 second project",
      genre: null,
      pov: null,
      tense: null,
      language: null,
      styleGuide: null,
      aiInstructions: null,
      outline: null,
      targetReaders: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  const second = {
    ...ctx,
    projectId,
    pairs: [],
    pairIndex: 0,
    revisionLog: [],
  };
  const persons = [];
  for (const name of ["Second One", "Second Two"]) {
    persons.push(
      (await codexCreateCharacter(second, `second-${persons.length}`, name))
        .entryId,
    );
  }
  second.pairs = [{ entityIds: persons, relationIds: [] }];
  return second;
}

function attemptSummary(run) {
  return {
    label: run.label,
    restored: run.attempt.restored,
    error: run.attempt.error.slice(0, 400),
    insertCount: run.attempt.applied?.insertCount ?? null,
    auxRowCounts: run.attempt.applied?.auxRowCounts ?? null,
    result: run.attempt.applied?.result ?? null,
    rolledBack: run.attempt.restored
      ? null
      : JSON.stringify(run.fingerprintAfter) ===
        JSON.stringify(run.fingerprintBefore),
  };
}

function recordSnapshotAttempt(ctx, run) {
  const summary = attemptSummary(run);
  ctx.harness.recordTimeline(
    `${NIR1_SCENE_SCOPE_PROJECTION_JOURNEY_ID}/snapshot-attempt-${run.label}`,
    summary,
  );
  process.stdout.write(
    `[electron:product] ${NIR1_SCENE_SCOPE_PROJECTION_JOURNEY_ID} snapshot attempt ${run.label} ${JSON.stringify(summary)}\n`,
  );
  return summary;
}

async function runSnapshotChecks(rootCtx, step) {
  // The persons of the other project, for a cross-project prepare negative.
  const second = await createSecondProject(rootCtx);
  const foreignSceneId = `x14-foreign-scene-${randomUUID()}`;
  await treeCreate(second, {
    id: foreignSceneId,
    nodeType: "scene",
    title: "X14 other project scene",
    sortOrder: "f0",
  });
  const bindingBefore = await captureWorkspaceBinding(
    rootCtx.harness,
    rootCtx.page,
    rootCtx.workspace,
  );
  const countsBefore = await countRejectionTables(
    rootCtx.harness,
    rootCtx.page,
    rootCtx.projectId,
  );
  const foreignRejection = await expectRejected(
    "prepare of another project's Scene",
    /NIR1_ENTITY_RELATION_PREPARE_SCENE_UNAVAILABLE|NEX_SOURCE_MISSING|NEX_SOURCE_PROJECT_MISMATCH/u,
    () =>
      rootCtx.harness.invokeOk(
        rootCtx.page,
        "nir1_entity_relation_revision_prepare",
        {
          payload: {
            projectId: rootCtx.projectId,
            sceneId: foreignSceneId,
            entityIds: [rootCtx.entityIds.leika],
            relationIds: [],
          },
          workspaceBinding: bindingBefore,
        },
      ),
  );
  const countsAfter = await countRejectionTables(
    rootCtx.harness,
    rootCtx.page,
    rootCtx.projectId,
  );
  assert.deepEqual(countsAfter, countsBefore, "the rejection writes nothing");
  step("prepare-rejects-other-project-scene", {
    otherProjectId: second.projectId,
    rejection: foreignRejection,
    countsBefore,
    countsAfter,
  });

  const ctx = rootCtx;
  let contractCtx = ctx;
  const rich = await runSnapshotRestoreAttempt(ctx, "rich");
  const attempts = [recordSnapshotAttempt(ctx, rich)];
  let contract = rich.attempt.restored ? rich : null;
  if (!contract) {
    const basic = await runSnapshotRestoreAttempt(second, "basic");
    attempts.push(recordSnapshotAttempt(ctx, basic));
    contract = basic.attempt.restored ? basic : null;
    contractCtx = second;
  }
  // An unrelated Change Feed chain observation: delete the Scene the trash
  // restore of the matrix made.  A rejected delete must roll back.
  const trashScenes = await rows(
    ctx.harness,
    ctx.page,
    `SELECT id FROM tree_nodes WHERE project_id = ? AND id LIKE 'restored-scene:%'`,
    [ctx.projectId],
  );
  const trashDelete = [];
  for (const { id } of trashScenes.slice(0, 1)) {
    const before = await sceneScopeFull(ctx, String(id)).catch(() => null);
    const outcome = await treeDelete(ctx, String(id)).then(
      () => ({ result: "accepted", error: "" }),
      (error) => ({ result: "rejected", error: ipcFailureText(error) }),
    );
    if (outcome.result === "rejected" && before) {
      assert.deepEqual(
        await sceneScopeFull(ctx, String(id)),
        before,
        "a rejected delete leaves the Scene and its binding untouched",
      );
    }
    trashDelete.push({
      sceneId: String(id),
      result: outcome.result,
      error: outcome.error.slice(0, 400),
    });
  }
  step("probe-def1-snapshot-restore-feed", {
    reproduced: attempts.map((a) => !a.restored),
    attempts,
    trashRestoredSceneDelete: trashDelete,
    note: "diagnostic only (DR-X1-2-10 (2)); restored or failed on the Change Feed chain both pass, a failure must roll back everything",
  });
  if (!contract) {
    const unmet = {
      status: "unmet-by-DEF-1",
      reason:
        "the body restore fails on NARRATIVE_CHANGE_FEED_DISCONTINUITY both for the project with Scope edit history and for a second project with no Scope edit",
      attempts,
    };
    step("snapshot-body-restore-recreates-bindings", unmet);
    step("snapshot-restore-epoch-keeps-revisions-unavailable", unmet);
    step("snapshot-token-return-stays-unavailable", unmet);
    return;
  }
  const cctx = contractCtx;

  const { ids } = contract;
  const bindingsAfter = await snapshotBindings(cctx);
  const recreated = {};
  for (const sceneId of contract.snapshot.sceneIds) {
    const before = contract.bindingsBefore.get(sceneId);
    const after = bindingsAfter.get(sceneId);
    assert.ok(after, `${sceneId} has a binding after the restore`);
    if (before) {
      assert.notEqual(
        after.incarnation,
        before.incarnation,
        `${sceneId}: the restore creates a new Scene incarnation`,
      );
      assert.notEqual(after.sourceToken, before.sourceToken);
    }
    assert.equal(
      Number(after.version),
      2,
      `${sceneId}: the binding restarts at generation 1, plus the restore's own refresh`,
    );
    recreated[sceneId] = Number(after.version);
  }
  const gone = await rows(
    cctx.harness,
    cctx.page,
    `SELECT COUNT(*) AS n FROM tree_nodes WHERE project_id = ? AND id = ?`,
    [cctx.projectId, ids.late],
  );
  assert.equal(Number(gone[0].n), 0, "a Scene made after the snapshot is gone");
  assert.equal(bindingsAfter.has(ids.late), false);
  const bodyRows = await rows(
    cctx.harness,
    cctx.page,
    `SELECT content FROM tree_nodes WHERE project_id = ? AND id = ?`,
    [cctx.projectId, ids.bs],
  );
  assert.match(String(bodyRows[0].content), /SnapBodyBefore/u);
  assert.doesNotMatch(String(bodyRows[0].content), /SnapBodyAfter/u);
  step("snapshot-body-restore-recreates-bindings", {
    attempt: contract.label,
    restoredSceneCount: contract.snapshot.sceneIds.length,
    generations: recreated,
    lateSceneGone: true,
    bodyRestored: true,
    result: contract.attempt.applied.result,
    insertCount: contract.attempt.applied.insertCount,
  });

  // The restore rotates the semantic epoch; no Revision approved before it is
  // readable afterwards, whatever its Scene's Scope looks like.
  const restoreEpochs = [
    contract.fingerprintBefore.restoreEpochs,
    contract.fingerprintAfter.restoreEpochs,
  ];
  assert.equal(restoreEpochs[1], restoreEpochs[0] + 1, "one restore epoch");
  const everyRevision = Object.fromEntries(
    cctx.revisionLog.map((revision) => [revision.name, revision]),
  );
  const afterStatuses = await revisionStatuses(cctx, everyRevision);
  for (const [name, status] of Object.entries(afterStatuses)) {
    assert.notEqual(
      status,
      "available",
      `${name} must not survive the restore`,
    );
  }
  step("snapshot-restore-epoch-keeps-revisions-unavailable", {
    restoreEpochs,
    revisionCount: cctx.revisionLog.length,
    statuses: afterStatuses,
    reasons: [...new Set(Object.values(afterStatuses))],
  });

  // The restored row carries the very body Source token it had at capture,
  // yet its Revision stays unavailable (new incarnation and a new epoch).
  const tkAfter = await sceneScopeFull(cctx, ids.tk);
  assert.equal(Number(tkAfter.treeVersion), 0);
  assert.equal(
    bodyToken(tkAfter),
    bodyToken(contract.tkAtSnapshot),
    "the restore puts the snapshot-time body Source token back",
  );
  assert.notEqual(bodyToken(tkAfter), bodyToken(contract.tkEdited));
  assert.notEqual(tkAfter.incarnation, contract.tkAtSnapshot.incarnation);
  assert.notEqual(tkAfter.sourceToken, contract.tkAtSnapshot.sourceToken);
  const tkStatuses = await revisionStatuses(cctx, {
    tk: contract.revisions.tk,
    bs: contract.revisions.bs,
  });
  assert.notEqual(tkStatuses.tk, "available");
  assert.notEqual(tkStatuses.bs, "available");
  // A new approval after the restore is the only way back: it is readable.
  let fresh;
  try {
    const revFresh = await newRevision(cctx, ids.tk);
    fresh = (await revisionStatuses(cctx, { fresh: revFresh })).fresh;
    assert.equal(fresh, "available", "a new approval after the restore reads");
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    fresh = `prepare refused: ${ipcFailureText(error).slice(0, 200)}`;
  }
  step("snapshot-token-return-stays-unavailable", {
    sceneId: ids.tk,
    bodyToken: {
      atSnapshot: bodyToken(contract.tkAtSnapshot),
      beforeRestore: bodyToken(contract.tkEdited),
      afterRestore: bodyToken(tkAfter),
    },
    incarnation: [contract.tkAtSnapshot.incarnation, tkAfter.incarnation],
    statuses: tkStatuses,
    freshRevisionAfterRestore: fresh,
  });
}

async function runCharacterJournalAndSnapshotChecks(ctx, step) {
  await runCharacterAndJournalChecks(ctx, step);
  await runSnapshotChecks(ctx, step);
}

export async function runNir1SceneScopeProjectionJourney(
  harness,
  { configureWorkspace },
) {
  const id = NIR1_SCENE_SCOPE_PROJECTION_JOURNEY_ID;
  assert.equal(typeof configureWorkspace, "function");
  const workspace = harness.workspacePath(id);
  await configureWorkspace(harness, workspace);
  const executedSteps = [];
  const step = (name, details = {}) => {
    assert.ok(
      NIR1_SCENE_SCOPE_PROJECTION_STEPS.includes(name),
      `unknown journey step ${name}`,
    );
    executedSteps.push(name);
    harness.recordTimeline(`${id}/${name}`, details);
    process.stdout.write(
      `[electron:product] ${id} step ${name} ${JSON.stringify(details)}\n`,
    );
  };

  // --- Launch 1: normal-UI input (Entities, Relations, folders, Scenes) ----
  const writing = await harness.launch(`${id}/prepare-ui-input`);
  let projectId;
  let anchorFolderId;
  let otherFolderId;
  let anchorSceneId;
  let otherSceneId;
  let entityIds;
  let relationIds;
  try {
    const { page } = writing;
    await openPanel(page, "codex", "codex-header-title");
    const leika = await createCodexEntryThroughUi(harness, page, {
      name: "ライカ",
      summary: "灰の目の騎士見習い",
    });
    const belka = await createCodexEntryThroughUi(harness, page, {
      name: "ベルカ",
      summary: "王都の案内人",
    });
    const relationOne = await addTypedRelationThroughUi(harness, page, {
      fromEntry: belka,
      toEntry: leika,
      label: "友人",
    });
    await page.getByTestId("detail-tab-details").click();
    const mira = await createCodexEntryThroughUi(harness, page, {
      name: "ミラ",
      summary: "港町の薬師",
    });
    const zeno = await createCodexEntryThroughUi(harness, page, {
      name: "ゼノ",
      summary: "北門の番人",
    });
    const relationTwo = await addTypedRelationThroughUi(harness, page, {
      fromEntry: zeno,
      toEntry: mira,
      label: "旧知",
    });
    entityIds = {
      leika: String(leika.id),
      belka: String(belka.id),
      mira: String(mira.id),
      zeno: String(zeno.id),
    };
    relationIds = { one: relationOne, two: relationTwo };

    await openPanel(page, "scenes", "scenes-panel");
    const anchorFolder = await createFolderThroughUi(
      harness,
      page,
      "Scope Projection Anchor",
    );
    const otherFolder = await createFolderThroughUi(
      harness,
      page,
      "Scope Projection Other",
    );
    projectId = String(anchorFolder.projectId);
    anchorFolderId = String(anchorFolder.id);
    otherFolderId = String(otherFolder.id);
    const anchorScene = await createSceneInFolderThroughUi(harness, page, {
      folderId: anchorFolderId,
      title: "ライカとベルカ",
    });
    const otherScene = await createSceneInFolderThroughUi(harness, page, {
      folderId: otherFolderId,
      title: "ミラとゼノ",
    });
    anchorSceneId = String(anchorScene.id);
    otherSceneId = String(otherScene.id);
    assert.notEqual(anchorSceneId, otherSceneId);
    harness.recordTimeline(`${id}/input-prepared`, {
      projectId,
      anchorSceneId,
      otherSceneId,
      entityCount: 4,
      relationCount: 2,
      standardUi: true,
    });
  } finally {
    await harness.close(writing.app, writing.page, `${id}/prepare-ui-input`);
  }

  // --- Launch 2: approve R1 (UI) and R2 (Native), save bodies -------------
  const review = await harness.launch(`${id}/review-body-saves`);
  let r1;
  let r2;
  let typedPanelJournalBoundary;
  try {
    const { page } = review;
    await openPanel(page, "codex", "codex-header-title");
    await page.getByTestId(`codex-entry-${entityIds.belka}`).click();
    await page.getByTestId("detail-tab-relations").click();
    const launcher = page.getByTestId(
      `codex-typed-relation-prepare-${relationIds.one}`,
    );
    await launcher.waitFor({ state: "visible", timeout: 60_000 });
    await launcher.click();
    const dialog = page.getByTestId("nir1-entity-relation-prepare-dialog");
    await dialog.waitFor({ state: "visible", timeout: 30_000 });
    await dialog
      .getByTestId("nir1-typed-scene-scope")
      .selectOption(anchorSceneId);
    await dialog
      .getByTestId(`nir1-typed-relation-${relationIds.one}`)
      .waitFor({ state: "visible", timeout: 30_000 });
    await dialog.getByTestId("nir1-typed-prepare").click();
    const typedPanel = page.getByTestId("nir1-entity-relation-review-panel");
    await typedPanel.waitFor({ state: "visible", timeout: 60_000 });
    await harness.waitUntil(
      async () =>
        (
          await typedPanel.getByTestId("nir1-typed-status").textContent()
        )?.includes("未承認"),
      "direct typed draft for the anchor Scene",
      60_000,
    );
    const r1RunId = assertNonEmpty(
      await typedPanel.getAttribute("data-run-id"),
      "R1 runId",
    );
    typedPanelJournalBoundary = await captureJournalBoundary(
      harness,
      `${id}/typed-draft-visible-before-approval`,
    );
    await typedPanel.getByTestId("nir1-typed-approve").click();
    await harness.waitUntil(
      async () =>
        (
          await typedPanel.getByTestId("nir1-typed-status").textContent()
        )?.includes("利用可能"),
      "anchor typed Revision explicit approval",
      60_000,
    );
    const approvedRuntime = await readTypedRuntimeMetadata(
      harness,
      page,
      projectId,
      r1RunId,
    );
    assert.equal(approvedRuntime.run.proposalStatus, "approved");
    assertTypedDecisionMetadata(approvedRuntime, "approved");
    r1 = {
      runId: r1RunId,
      proposalId: String(approvedRuntime.run.proposalId),
      revisionId: String(approvedRuntime.run.revisionId),
    };
    await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
    await dialog.waitFor({ state: "hidden", timeout: 30_000 });

    r2 = await prepareAndApproveThroughNative(harness, page, {
      workspace,
      projectId,
      sceneId: otherSceneId,
      entityIds: [entityIds.mira, entityIds.zeno],
      relationIds: [relationIds.two],
    });
    const readOne = await readCurrent(harness, page, {
      workspace,
      projectId,
      runId: r1.runId,
    });
    const readTwo = await readCurrent(harness, page, {
      workspace,
      projectId,
      runId: r2.runId,
    });
    assert.equal(readOne.status, "available");
    assert.equal(readOne.result.sceneId, anchorSceneId);
    assert.equal(readTwo.status, "available");
    assert.equal(readTwo.result.sceneId, otherSceneId);
    step("e1-prepare-approve", {
      projectId,
      anchorSceneId,
      otherSceneId,
      r1: { ...r1, route: "ui" },
      r2: { ...r2, route: "native-commands" },
      explicitHumanApproval: true,
    });

    // Prepare must reject identities the renderer cannot vouch for, and the
    // rejection must not write a Run, Proposal Set or Scope binding.
    const bindingBefore = await captureWorkspaceBinding(
      harness,
      page,
      workspace,
    );
    const countsBefore = await countRejectionTables(harness, page, projectId);
    const rejections = {};
    for (const [label, expectedCode, payload] of [
      [
        "foreign-project",
        /NEX_SOURCE_MISSING/,
        {
          projectId: FOREIGN_PROJECT_ID,
          sceneId: anchorSceneId,
          entityIds: [entityIds.leika],
          relationIds: [],
        },
      ],
      [
        "missing-anchor",
        /NIR1_ENTITY_RELATION_PREPARE_SCENE_UNAVAILABLE/,
        {
          projectId,
          sceneId: "x1-4-missing-anchor-scene",
          entityIds: [entityIds.leika],
          relationIds: [],
        },
      ],
    ]) {
      const failure = await harness
        .invokeOk(page, "nir1_entity_relation_revision_prepare", {
          payload,
          workspaceBinding: bindingBefore,
        })
        .then(
          () => null,
          (error) => ipcFailureText(error),
        );
      assert.ok(failure, `prepare must reject ${label}`);
      assert.match(
        failure,
        expectedCode,
        `prepare must reject ${label} with its defense code`,
      );
      rejections[label] = failure.slice(0, 300);
    }
    const countsAfter = await countRejectionTables(harness, page, projectId);
    assert.deepEqual(
      countsAfter,
      countsBefore,
      "rejected prepare writes nothing",
    );
    step("prepare-rejects-foreign-project-and-missing-anchor", {
      rejections,
      countsBefore,
      countsAfter,
    });

    // Body saves (autosave -> save_scene_body_bundle) for the anchor and the
    // other Scene; the typed Revisions stay available and the stored Scope
    // projection inputs do not move (F9 re-observed in a real Electron).
    const anchorBefore = await observeScene(
      harness,
      page,
      projectId,
      anchorSceneId,
    );
    const otherBefore = await observeScene(
      harness,
      page,
      projectId,
      otherSceneId,
    );
    const saves = [];
    for (const [sceneId, folderId, text] of [
      [anchorSceneId, anchorFolderId, "AnchorBodySaveOne"],
      [otherSceneId, otherFolderId, "OtherBodySaveOne"],
      [anchorSceneId, anchorFolderId, "AnchorBodySaveTwo"],
    ]) {
      const saved = await saveBodyThroughEditor(harness, page, {
        projectId,
        sceneId,
        folderId,
        text,
      });
      assert.ok(
        Number(saved.after.treeVersion) > Number(saved.before.treeVersion),
        `body save must advance the tree version of ${sceneId}`,
      );
      assert.notEqual(
        saved.after.treeUpdatedAt,
        saved.before.treeUpdatedAt,
        `body save must advance updated_at of ${sceneId}`,
      );
      saves.push({
        sceneId,
        treeVersionBefore: saved.before.treeVersion,
        treeVersionAfter: saved.after.treeVersion,
      });
    }
    const anchorAfter = await observeScene(
      harness,
      page,
      projectId,
      anchorSceneId,
    );
    const otherAfter = await observeScene(
      harness,
      page,
      projectId,
      otherSceneId,
    );
    for (const [before, after] of [
      [anchorBefore, anchorAfter],
      [otherBefore, otherAfter],
    ]) {
      assert.equal(after.incarnation, before.incarnation);
      assert.equal(after.version, before.version, "binding version is stable");
      assert.equal(
        after.sourceToken,
        before.sourceToken,
        "source token is stable",
      );
    }
    const afterSavesOne = await readCurrent(harness, page, {
      workspace,
      projectId,
      runId: r1.runId,
    });
    const afterSavesTwo = await readCurrent(harness, page, {
      workspace,
      projectId,
      runId: r2.runId,
    });
    assert.equal(afterSavesOne.status, "available");
    assert.equal(afterSavesTwo.status, "available");
    step("e1-body-saves-keep-available", {
      saves,
      bindingVersion: {
        anchor: anchorAfter.version,
        other: otherAfter.version,
      },
      sourceTokenStable: true,
      r1Status: afterSavesOne.status,
      r2Status: afterSavesTwo.status,
    });
  } finally {
    await harness.close(review.app, review.page, `${id}/review-body-saves`);
  }

  // --- Launch 3: cold reopen, then move the anchor ------------------------
  const reopened = await harness.launch(`${id}/reopen-anchor-move`);
  try {
    const { page } = reopened;
    await openPanel(page, "codex", "codex-header-title");
    const coldPanel = await openTypedReviewThroughColdLauncher(page, {
      entityId: entityIds.belka,
    });
    await harness.waitUntil(
      async () =>
        (
          await coldPanel.getByTestId("nir1-typed-status").textContent()
        )?.includes("利用可能"),
      "anchor typed Revision after cold reopen and body saves",
      60_000,
    );
    assert.equal(await coldPanel.getAttribute("data-run-id"), r1.runId);
    const coldRuntime = await readTypedRuntimeMetadata(
      harness,
      page,
      projectId,
      r1.runId,
    );
    assert.equal(coldRuntime.run.revisionId, r1.revisionId);
    assert.equal(coldRuntime.run.proposalStatus, "approved");
    const coldOne = await readCurrent(harness, page, {
      workspace,
      projectId,
      runId: r1.runId,
    });
    const coldTwo = await readCurrent(harness, page, {
      workspace,
      projectId,
      runId: r2.runId,
    });
    assert.equal(coldOne.status, "available");
    assert.equal(coldTwo.status, "available");
    step("e1-cold-reopen-available", {
      restoredRunId: r1.runId,
      r1Status: coldOne.status,
      r2Status: coldTwo.status,
    });
    await closeTypedReviewDialog(page);

    // Move the anchor to the other folder: only the anchor's Revision goes.
    const anchorBefore = await observeScene(
      harness,
      page,
      projectId,
      anchorSceneId,
    );
    const otherBefore = await observeScene(
      harness,
      page,
      projectId,
      otherSceneId,
    );
    await harness.invokeOk(page, "tree_node_patch", {
      payload: {
        projectId,
        requestId: `x1-4-anchor-move:${anchorSceneId}`,
        sessionId: "electron-product-journey",
        eventUid: `x1-4-anchor-move-event:${anchorSceneId}`,
        origin: "human",
        originalTransactionId: null,
        undoJournalId: null,
        nodeId: anchorSceneId,
        updatedAt: new Date().toISOString(),
        patch: {
          parentId: otherFolderId,
          sortOrder: `${otherBefore.sortOrder}V`,
        },
        bumpVersion: false,
      },
    });
    const anchorAfter = await observeScene(
      harness,
      page,
      projectId,
      anchorSceneId,
    );
    const otherAfter = await observeScene(
      harness,
      page,
      projectId,
      otherSceneId,
    );
    assert.equal(anchorAfter.parentId, otherFolderId);
    assert.notEqual(
      anchorAfter.sourceToken,
      anchorBefore.sourceToken,
      "moving the anchor changes its Scope token",
    );
    assert.ok(Number(anchorAfter.version) > Number(anchorBefore.version));
    assert.equal(otherAfter.version, otherBefore.version);
    assert.equal(otherAfter.sourceToken, otherBefore.sourceToken);
    const movedOne = await readCurrent(harness, page, {
      workspace,
      projectId,
      runId: r1.runId,
    });
    const movedTwo = await readCurrent(harness, page, {
      workspace,
      projectId,
      runId: r2.runId,
    });
    assert.equal(
      movedOne.status,
      "unavailable",
      "anchor Revision is invalidated",
    );
    assert.equal(
      movedOne.result?.reason,
      "source-revision-changed",
      "R1 is invalidated because the anchor Scope changed",
    );
    assert.equal(movedTwo.status, "available", "other Revision is untouched");

    const stalePanel = await openTypedReviewThroughColdLauncher(page, {
      entityId: entityIds.belka,
      alreadySelected: true,
    });
    await harness.waitUntil(
      async () =>
        (
          await stalePanel.getByTestId("nir1-typed-status").textContent()
        )?.trim() === "利用不可",
      "anchor typed Revision unavailable in the UI after the anchor move",
      60_000,
    );
    // The reason row is part of the shared selector sequence; assert the
    // visible reason is the draft's invalidation value, not just the status.
    await harness.waitUntil(
      async () =>
        (
          await stalePanel
            .getByTestId("nir1-typed-unavailable-reason")
            .textContent()
        )?.includes("source-revision-changed"),
      "anchor typed Revision reason is source-revision-changed in the UI",
      30_000,
    );
    step("e1-anchor-move-invalidates-anchor-only", {
      anchorSceneId,
      toFolderId: otherFolderId,
      r1Status: movedOne.status,
      r1Reason: movedOne.result.reason,
      r2Status: movedTwo.status,
      bindingVersion: {
        anchor: [anchorBefore.version, anchorAfter.version],
        other: [otherBefore.version, otherAfter.version],
      },
      uiShowsUnavailable: true,
    });

    await closeTypedReviewDialog(page);
    const matrixContext = {
      harness,
      page,
      workspace,
      projectId,
      entityIds,
      relationIds,
      pairs: [
        {
          entityIds: [entityIds.mira, entityIds.zeno],
          relationIds: [relationIds.two],
        },
        {
          entityIds: [entityIds.leika, entityIds.belka],
          relationIds: [relationIds.one],
        },
      ],
      pairIndex: 0,
      revisionLog: [
        { name: "r1", ...r1 },
        { name: "r2", ...r2 },
      ],
    };
    await runScopeEditMatrix(matrixContext, step);
    await runCharacterJournalAndSnapshotChecks(matrixContext, step);

    assert.deepEqual(
      executedSteps,
      [...NIR1_SCENE_SCOPE_PROJECTION_STEPS],
      "the journey ran every declared step, in order",
    );
    const dispatchObservation = await verifyNoForbiddenDispatches(
      harness,
      typedPanelJournalBoundary,
    );
    harness.recordTimeline(`${id}/completed`, {
      executedSteps,
      dispatchObservation,
    });
    return {
      id,
      workspace,
      projectId,
      anchorSceneId,
      otherSceneId,
      runIds: { r1: r1.runId, r2: r2.runId },
      executedSteps,
      selectorSequence: [...NIR1_SCENE_SCOPE_PROJECTION_SELECTORS],
      dispatchObservation,
    };
  } finally {
    await harness.close(
      reopened.app,
      reopened.page,
      `${id}/reopen-anchor-move`,
    );
  }
}

export function createNir1SceneScopeProjectionJourney({ configureWorkspace }) {
  return {
    id: NIR1_SCENE_SCOPE_PROJECTION_JOURNEY_ID,
    run: (harness) =>
      runNir1SceneScopeProjectionJourney(harness, { configureWorkspace }),
  };
}
