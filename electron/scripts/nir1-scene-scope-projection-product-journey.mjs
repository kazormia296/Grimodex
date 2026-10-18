import assert from "node:assert/strict";
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
]);

/** Every renderer-bridge command the journey sends.  No Graph/Packing/AI. */
export const NIR1_SCENE_SCOPE_PROJECTION_IPC_COMMANDS = Object.freeze([
  "db_execute",
  "narrative_extraction_capture_workspace_binding",
  "nir1_entity_relation_revision_prepare",
  "nir1_entity_relation_revision_read_current",
  "narrative_extraction_append_human_decision",
  "tree_node_patch",
]);

/** The assertion steps, in execution order (draft acceptance names). */
export const NIR1_SCENE_SCOPE_PROJECTION_STEPS = Object.freeze([
  "e1-prepare-approve",
  "prepare-rejects-foreign-project-and-missing-anchor",
  "e1-body-saves-keep-available",
  "e1-cold-reopen-available",
  "e1-anchor-move-invalidates-anchor-only",
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
            parent_id AS parentId, sort_order AS sortOrder
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
    const countsBefore = {
      runs: await countRows(
        harness,
        page,
        "narrative_extraction_runs",
        projectId,
      ),
      sets: await countRows(
        harness,
        page,
        "narrative_proposal_sets",
        projectId,
      ),
      bindings: await countRows(
        harness,
        page,
        "narrative_scene_scope_bindings",
        projectId,
      ),
    };
    const rejections = {};
    for (const [label, expectedCode, payload] of [
      [
        "foreign-project",
        /NEX_SOURCE_MISSING/,
        {
          projectId: "x1-4-foreign-project",
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
    const countsAfter = {
      runs: await countRows(
        harness,
        page,
        "narrative_extraction_runs",
        projectId,
      ),
      sets: await countRows(
        harness,
        page,
        "narrative_proposal_sets",
        projectId,
      ),
      bindings: await countRows(
        harness,
        page,
        "narrative_scene_scope_bindings",
        projectId,
      ),
    };
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
        )?.includes("利用不可"),
      "anchor typed Revision unavailable in the UI after the anchor move",
      60_000,
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
