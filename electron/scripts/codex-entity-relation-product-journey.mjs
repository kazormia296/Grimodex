import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * The Entity/Relation follow-up is a separate product surface from the
 * generic Structure Extract run.  Keep the selectors in this small module so
 * the dependency-free contract test can pin the production click path without
 * importing Electron or Playwright.
 */
export const CODEX_ENTITY_RELATION_REVIEW_JOURNEY_ID =
  "codex-entity-relation-review-apply-reopen";

export const CODEX_ENTITY_RELATION_REVIEW_SELECTORS = Object.freeze([
  '[data-stripe-icon="scenes"]',
  '[data-panel-header]:has(span[role="heading"]:text-is("シーン"))',
  'button[title="新規作成"]',
  '[role="menuitem"]:text-is("New folder")',
  '[data-node-row]',
  'button[title="シーンを追加"]',
  '[data-stripe-icon="codex"]',
  '[data-testid="codex-new-entry-button"]',
  '[data-testid="codex-detail-name"]',
  '[data-testid="codex-detail-summary"]',
  '[data-testid="detail-tab-relations"]',
  '[data-testid="codex-typed-relations-section"]',
  '[data-testid="codex-typed-relation-target"]',
  '[data-testid="codex-typed-relation-label"]',
  '[data-testid="codex-typed-relation-add"]',
  '[data-testid^="codex-typed-relation-row-"]',
  '[data-testid="codex-typed-relations-open-nir1-review"]',
  '[data-testid="nir1-entity-relation-prepare-dialog"]',
  '[data-testid="nir1-typed-scene-scope"]',
  '[data-testid^="nir1-typed-entity-"]',
  '[data-testid^="nir1-typed-relation-"]',
  '[data-testid="nir1-typed-prepare"]',
  '[data-testid="nir1-entity-relation-review-panel"]',
  '[data-testid="nir1-typed-status"]',
  '[data-testid="nir1-typed-evidence"]',
  '[data-testid="nir1-typed-approve"]',
  '[data-testid="nir1-typed-replace"]',
]);

export const CODEX_ENTITY_RELATION_REVIEW_REQUIRED_INTERACTIONS =
  Object.freeze([
    "create-folder-through-scenes-toolbar",
    "create-single-scene-through-folder-row",
    "create-two-codex-entries-through-codex-panel",
    "create-typed-relation-through-relations-tab",
    "select-direct-typed-scope-and-material",
    "inspect-native-typed-draft-evidence",
    "approve-typed-revision-through-ui",
    "close-and-relaunch-electron",
    "restore-dedicated-typed-run-through-ui",
  ]);

const NIR1_ENTITY_RELATION_SET_KIND = "nir1.entity-relation.revision@1";
const NIR1_ENTITY_RELATION_PROPOSAL_KIND = "nir1.entity-relation@1";

function assertNonEmpty(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.length > 0, `${label} must not be empty`);
  return value;
}

async function rows(harness, page, sql, params = []) {
  const result = await harness.invokeOk(page, "db_execute", {
    sql,
    params,
    method: "all",
  });
  return result?.rows ?? [];
}

async function readTypedRuntimeMetadata(harness, page, projectId, runId) {
  const runRows = await rows(
    harness,
    page,
    `SELECT
       r.id AS runId,
       r.project_id AS projectId,
       r.surface_path_id AS surfacePathId,
       r.status AS runStatus,
       ps.id AS proposalSetId,
       ps.set_kind AS proposalSetKind,
       p.id AS proposalId,
       p.kind AS proposalKind,
       p.status AS proposalStatus,
       p.current_revision_id AS revisionId
     FROM narrative_extraction_runs r
     INNER JOIN narrative_proposal_sets ps ON ps.run_id = r.id AND ps.project_id = r.project_id
     INNER JOIN narrative_proposals p ON p.proposal_set_id = ps.id
     WHERE r.id = ? AND r.project_id = ?
     ORDER BY ps.created_at DESC, p.created_at DESC`,
    [runId, projectId],
  );
  assert.equal(
    runRows.length,
    1,
    `typed Run ${runId} must have exactly one saved typed Proposal row`,
  );
  const run = runRows[0];
  assert.equal(run.runId, runId);
  assert.equal(run.projectId, projectId);
  assert.equal(run.surfacePathId, "nir1/entity-relation-review");
  assert.equal(run.proposalSetKind, NIR1_ENTITY_RELATION_SET_KIND);
  assert.equal(run.proposalKind, NIR1_ENTITY_RELATION_PROPOSAL_KIND);
  assertNonEmpty(String(run.proposalSetId), "typed proposalSetId");
  assertNonEmpty(String(run.proposalId), "typed proposalId");
  assertNonEmpty(String(run.revisionId), "typed revisionId");

  const decisions = await rows(
    harness,
    page,
    `SELECT
       d.decision AS decision,
       d.actor_kind AS actorKind,
       d.actor_id AS actorId
     FROM narrative_proposal_decisions d
     WHERE d.proposal_id = ? AND d.revision_id = ?
     ORDER BY d.created_at ASC, d.id ASC`,
    [run.proposalId, run.revisionId],
  );
  return { run, decisions };
}

function assertTypedDecisionMetadata(metadata, expectedDecision) {
  assert.equal(metadata.decisions.length, 1, "typed approval must persist one Decision");
  assert.deepEqual(metadata.decisions[0], {
    decision: expectedDecision,
    actorKind: "human",
    actorId: "electron:human-review",
  });
}

async function waitForLayout(page) {
  await page
    .locator('[data-layout-shell][data-layout-initialized="true"]')
    .waitFor({ state: "attached", timeout: 60_000 });
}

async function openPanel(page, panelId, readyTestId) {
  await waitForLayout(page);
  const toggle = page.locator(`[data-stripe-icon="${panelId}"]`);
  await toggle.waitFor({ state: "visible", timeout: 60_000 });
  const state = await toggle.getAttribute("aria-pressed");
  assert.ok(
    state === "true" || state === "false",
    `${panelId} toggle must expose aria-pressed`,
  );
  if (state === "false") await toggle.click();
  const ready =
    readyTestId === "scenes-panel"
      ? page.locator('[data-droptarget-id="scenes-panel"]')
      : page.getByTestId(readyTestId);
  await ready.waitFor({ state: "visible", timeout: 60_000 });
}

async function createCodexEntryThroughUi(harness, page, { name, summary }) {
  await page.getByTestId("codex-new-entry-button").click();
  const nameField = page.getByTestId("codex-detail-name");
  await nameField.waitFor({ state: "visible", timeout: 30_000 });
  await nameField.fill(name);
  await page.keyboard.press("Enter");

  const nameRows = await harness.waitUntil(
    () =>
      rows(
        harness,
        page,
        "SELECT id, project_id AS projectId, name, summary FROM codex_entries WHERE name = ? ORDER BY created_at DESC",
        [name],
      ).then((result) => result[0] ?? null),
    `Codex entry ${name} name persistence`,
    30_000,
  );
  const summaryField = page.getByTestId("codex-detail-summary");
  await summaryField.waitFor({ state: "visible", timeout: 30_000 });
  await summaryField.fill(summary);
  await summaryField.press("Tab");

  return harness.waitUntil(
    () =>
      rows(
        harness,
        page,
        "SELECT id, project_id AS projectId, name, summary FROM codex_entries WHERE id = ? AND name = ? AND summary = ?",
        [nameRows.id, name, summary],
      ).then((result) => result[0] ?? null),
    `Codex entry ${name} summary persistence`,
    30_000,
  );
}

async function createFolderThroughUi(harness, page, title) {
  const header = page.locator(
    '[data-panel-header]:has(span[role="heading"]:text-is("シーン"))',
  );
  await header.waitFor({ state: "visible", timeout: 60_000 });
  await header.locator('button[title="新規作成"]').click();
  await page
    .getByRole("menuitem", { name: "New folder", exact: true })
    .click();
  const renameInput = page.locator(
    '[data-droptarget-id="scenes-panel"] input:focus',
  );
  await renameInput.waitFor({ state: "visible", timeout: 10_000 });
  await renameInput.fill(title);
  await page.keyboard.press("Enter");
  return harness.waitUntil(
    () =>
      rows(
        harness,
        page,
        "SELECT id, project_id AS projectId, title FROM tree_nodes WHERE node_type = 'folder' AND title = ? ORDER BY created_at DESC",
        [title],
      ).then((result) => result[0] ?? null),
    "Codex Entity/Relation review folder persistence",
    30_000,
  );
}

async function createSceneInFolderThroughUi(
  harness,
  page,
  { folderId, title },
) {
  const row = page.locator(`[data-node-row="${folderId}"]`);
  await row.waitFor({ state: "visible", timeout: 30_000 });
  await row.hover();
  const addScene = row
    .locator('button[title="シーンを追加"],button[title="Add scene"]')
    .first();
  await addScene.click({ force: true });
  const renameInput = page.locator(
    '[data-droptarget-id="scenes-panel"] input:focus',
  );
  if (
    await renameInput
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await renameInput.fill(title);
    await page.keyboard.press("Enter");
  }

  const scene = await harness.waitUntil(
    () =>
      rows(
        harness,
        page,
        "SELECT id, project_id AS projectId, title FROM tree_nodes WHERE node_type = 'scene' AND parent_id = ? ORDER BY created_at DESC",
        [folderId],
      ).then((result) => result[0] ?? null),
    "Codex Entity/Relation review scene persistence",
    30_000,
  );
  const editorSurface = page.locator(
    `[data-editor-loaded-document-id="${scene.id}"][data-editor-document-loading="false"]:visible`,
  );
  await editorSurface.waitFor({ state: "visible", timeout: 30_000 });
  const editor = editorSurface
    .locator('.ProseMirror[contenteditable="true"]')
    .first();
  await editor.waitFor({ state: "visible", timeout: 30_000 });
  return { ...scene, editor };
}

async function captureJournalBoundary(harness, phase) {
  const journal = await readFile(harness.journalPath, "utf8");
  const lines = journal.split("\n").filter(Boolean);
  const lastEntry = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;
  return {
    phase,
    lineOffset: lines.length,
    journalPhase:
      typeof lastEntry?.phase === "string" ? lastEntry.phase : null,
  };
}

async function verifyNoForbiddenDispatches(harness, typedPanelJournalBoundary) {
  assert.ok(
    typedPanelJournalBoundary &&
      Number.isSafeInteger(typedPanelJournalBoundary.lineOffset) &&
      typedPanelJournalBoundary.lineOffset >= 0,
    "typed review journey requires a journal boundary after the typed panel",
  );
  const journal = await readFile(harness.journalPath, "utf8");
  const entries = journal
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const boundaryEntry =
    typedPanelJournalBoundary.lineOffset > 0
      ? entries[typedPanelJournalBoundary.lineOffset - 1]
      : null;
  assert.equal(
    boundaryEntry?.phase ?? null,
    typedPanelJournalBoundary.journalPhase,
    "typed panel boundary must bind to the saved journal phase",
  );
  const operations = entries.map((entry) => String(entry.operation ?? ""));
  const genericReviewBundleRead = [
    "narrative_extraction",
    "get_run_review_bundle",
  ].join("_");
  const genericReviewBundleReadsAfterTypedPanel = operations
    .slice(typedPanelJournalBoundary.lineOffset)
    .filter((operation) => operation.includes(genericReviewBundleRead));
  const forbidden = operations.filter(
    (operation) =>
      /graph|packing|ai[_-]?(dispatch|send)|provider/u.test(operation),
  );
  forbidden.push(...genericReviewBundleReadsAfterTypedPanel);
  assert.deepEqual(
    forbidden,
    [],
    `typed review journey dispatched an out-of-scope operation: ${forbidden.join(",")}`,
  );
  return {
    graphDispatchCount: operations.filter((operation) => /graph/u.test(operation))
      .length,
    packingDispatchCount: operations.filter((operation) => /packing/u.test(operation))
      .length,
    aiDispatchCount: operations.filter((operation) =>
      /ai[_-]?(dispatch|send)|provider/u.test(operation),
    ).length,
    genericReviewBundleReadCount: operations.filter((operation) =>
      operation.includes(genericReviewBundleRead),
    ).length,
    genericReviewBundleReadAfterTypedPanelCount:
      genericReviewBundleReadsAfterTypedPanel.length,
    genericReviewBundleReadBeforeTypedPanelCount: operations
      .slice(0, typedPanelJournalBoundary.lineOffset)
      .filter((operation) => operation.includes(genericReviewBundleRead)).length,
    typedPanelJournalBoundary,
  };
}

/**
 * Production-equivalent direct Option B journey. The runner uses the normal
 * Codex entry/Relations UI and the dedicated typed preparation surface; it
 * never opens the generic Structure Extract surface or injects typed payloads.
 */
export async function runCodexEntityRelationReviewJourney(
  harness,
  { configureWorkspace },
) {
  const id = CODEX_ENTITY_RELATION_REVIEW_JOURNEY_ID;
  assert.equal(typeof configureWorkspace, "function");
  const workspace = harness.workspacePath(id);
  await configureWorkspace(harness, workspace);

  const writing = await harness.launch(`${id}/prepare-ui-input`);
  let projectId;
  let sceneId;
  let leikaId;
  let belkaId;
  let relationId;
  try {
    await openPanel(writing.page, "codex", "codex-header-title");
    const leika = await createCodexEntryThroughUi(harness, writing.page, {
      name: "ライカ",
      summary: "灰の目の騎士見習い",
    });
    const belka = await createCodexEntryThroughUi(harness, writing.page, {
      name: "ベルカ",
      summary: "王都の案内人",
    });
    assertNonEmpty(String(leika.id), "ライカ id");
    assertNonEmpty(String(belka.id), "ベルカ id");
    leikaId = String(leika.id);
    belkaId = String(belka.id);

    await writing.page.getByTestId("detail-tab-relations").click();
    const relationsSection = writing.page.getByTestId(
      "codex-typed-relations-section",
    );
    await relationsSection.waitFor({ state: "visible", timeout: 30_000 });
    await relationsSection
      .getByTestId("codex-typed-relation-target")
      .selectOption(leikaId);
    await relationsSection
      .getByTestId("codex-typed-relation-label")
      .fill("友人");
    await relationsSection.getByTestId("codex-typed-relation-add").click();
    const relation = await harness.waitUntil(
      () =>
        rows(
          harness,
          writing.page,
          "SELECT id, project_id AS projectId, from_codex_id AS fromCodexId, to_codex_id AS toCodexId, relation_type AS relationType, label FROM codex_relations WHERE project_id = ? AND from_codex_id = ? AND to_codex_id = ? ORDER BY created_at DESC",
          [belka.projectId, belkaId, leikaId],
        ).then((result) => result[0] ?? null),
      "typed Relation creation through Relations tab",
      30_000,
    );
    assert.equal(relation.projectId, belka.projectId);
    assert.equal(relation.fromCodexId, belkaId);
    assert.equal(relation.toCodexId, leikaId);
    relationId = String(relation.id);

    await openPanel(writing.page, "scenes", "scenes-panel");
    const folder = await createFolderThroughUi(
      harness,
      writing.page,
      "Entity Relation Journey",
    );
    projectId = String(folder.projectId);
    const scene = await createSceneInFolderThroughUi(harness, writing.page, {
      folderId: String(folder.id),
      title: "ライカとベルカ",
    });
    sceneId = String(scene.id);
    harness.recordTimeline(`${id}/input-prepared`, {
      projectId,
      sceneId,
      entityCount: 2,
      relationCount: 1,
      relationId: relation.id,
      standardUi: true,
      devFlagRequired: false,
    });
  } finally {
    await harness.close(writing.app, writing.page, `${id}/prepare-ui-input`);
  }

  const review = await harness.launch(`${id}/review-apply`);
  let typedRunId;
  let typedProposalSetId;
  let typedProposalId;
  let typedRevisionId;
  let typedPanelJournalBoundary;
  try {
    await openPanel(review.page, "codex", "codex-header-title");
    await review.page
      .getByTestId(`codex-entry-${belkaId}`)
      .click();
    await review.page.getByTestId("detail-tab-relations").click();
    const relationsSection = review.page.getByTestId(
      "codex-typed-relations-section",
    );
    await relationsSection.waitFor({ state: "visible", timeout: 30_000 });
    const prepareLauncher = review.page.getByTestId(
      `codex-typed-relation-prepare-${relationId}`,
    );
    await prepareLauncher.waitFor({ state: "visible", timeout: 60_000 });
    await prepareLauncher.click();
    const dialog = review.page.getByTestId(
      "nir1-entity-relation-prepare-dialog",
    );
    await dialog.waitFor({ state: "visible", timeout: 30_000 });
    await dialog
      .getByTestId("nir1-typed-scene-scope")
      .selectOption(sceneId);
    await dialog
      .getByTestId(`nir1-typed-relation-${relationId}`)
      .waitFor({ state: "visible", timeout: 30_000 });
    await dialog.getByTestId("nir1-typed-prepare").click();

    const typedPanel = review.page.getByTestId(
      "nir1-entity-relation-review-panel",
    );
    await typedPanel.waitFor({ state: "visible", timeout: 60_000 });
    await harness.waitUntil(
      async () =>
        (await typedPanel.getByTestId("nir1-typed-status").textContent())?.includes(
          "未承認",
        ),
      "direct typed draft after Scope/Relation selection",
      60_000,
    );
    assert.equal(
      await typedPanel
        .locator('[data-testid^="nir1-typed-entity-row-"]')
        .count(),
      2,
    );
    assert.equal(
      await typedPanel
        .locator('[data-testid^="nir1-typed-relation-row-"]')
        .count(),
      1,
    );
    const typedEvidence = typedPanel.getByTestId("nir1-typed-evidence");
    assert.ok((await typedEvidence.allTextContents()).join(" ").includes("灰の目"));
    assert.ok((await typedEvidence.allTextContents()).join(" ").includes("王都"));
    typedRunId = await typedPanel.getAttribute("data-run-id");
    assertNonEmpty(typedRunId, "typed review runId");
    typedPanelJournalBoundary = await captureJournalBoundary(
      harness,
      `${id}/typed-draft-visible-before-approval`,
    );
    const draftRuntime = await readTypedRuntimeMetadata(
      harness,
      review.page,
      projectId,
      typedRunId,
    );
    assert.equal(
      draftRuntime.run.proposalStatus,
      "unreviewed",
      "typed panel must be bound to the saved unreviewed Proposal",
    );
    assert.equal(
      draftRuntime.decisions.length,
      0,
      "typed draft must not have a Decision before the UI approval",
    );
    typedProposalSetId = draftRuntime.run.proposalSetId;
    typedProposalId = draftRuntime.run.proposalId;
    typedRevisionId = draftRuntime.run.revisionId;
    harness.recordTimeline(`${id}/typed-runtime-bound`, {
      projectId,
      sceneId,
      typedRunId,
      proposalSetId: draftRuntime.run.proposalSetId,
      proposalId: draftRuntime.run.proposalId,
      revisionId: draftRuntime.run.revisionId,
      proposalSetKind: draftRuntime.run.proposalSetKind,
      proposalKind: draftRuntime.run.proposalKind,
      decisionCount: draftRuntime.decisions.length,
    });
    await typedPanel.getByTestId("nir1-typed-approve").click();
    await harness.waitUntil(
      async () =>
        (await typedPanel.getByTestId("nir1-typed-status").textContent())?.includes(
          "利用可能",
        ),
      "typed revision explicit approval",
      60_000,
    );
    const approvedRuntime = await readTypedRuntimeMetadata(
      harness,
      review.page,
      projectId,
      typedRunId,
    );
    assert.equal(approvedRuntime.run.proposalStatus, "approved");
    assert.equal(approvedRuntime.run.revisionId, draftRuntime.run.revisionId);
    assertTypedDecisionMetadata(approvedRuntime, "approved");
    harness.recordTimeline(`${id}/typed-approved`, {
      projectId,
      sceneId,
      typedRunId,
      typedPanelJournalBoundary,
      entityCount: 2,
      relationCount: 1,
      evidenceVerified: true,
      explicitHumanApproval: true,
      savedDecisionCount: approvedRuntime.decisions.length,
      savedRevisionId: approvedRuntime.run.revisionId,
    });

    await dialog.getByRole("button", { name: "閉じる", exact: true }).click();
    await dialog.waitFor({ state: "hidden", timeout: 30_000 });
  } finally {
    await harness.close(review.app, review.page, `${id}/review-apply`);
  }

  const reopened = await harness.launch(`${id}/reopen`);
  try {
    await openPanel(reopened.page, "codex", "codex-header-title");
    await reopened.page.getByTestId(`codex-entry-${belkaId}`).click();
    await reopened.page.getByTestId("detail-tab-relations").click();
    const coldLauncher = reopened.page.getByTestId(
      "codex-typed-relations-open-nir1-review",
    );
    await coldLauncher.waitFor({ state: "visible", timeout: 60_000 });
    await coldLauncher.click();
    const restored = reopened.page.getByTestId(
      "nir1-entity-relation-review-panel",
    );
    await restored.waitFor({ state: "visible", timeout: 60_000 });
    await harness.waitUntil(
      async () =>
        (await restored.getByTestId("nir1-typed-status").textContent())?.includes(
          "利用可能",
        ),
      "dedicated typed revision after cold reopen",
      60_000,
    );
    const restoredRunId = await restored.getAttribute("data-run-id");
    assertNonEmpty(restoredRunId, "restored typed review runId");
    assert.equal(
      restoredRunId,
      typedRunId,
      "cold reopen must restore the saved typed Run, not qualify a different Run",
    );
    assert.equal(
      await restored
        .locator('[data-testid^="nir1-typed-entity-row-"]')
        .count(),
      2,
    );
    assert.equal(
      await restored
        .locator('[data-testid^="nir1-typed-relation-row-"]')
        .count(),
      1,
    );
    const restoredEvidence = (await restored
      .getByTestId("nir1-typed-evidence")
      .allTextContents())
      .join(" ");
    assert.ok(restoredEvidence.includes("灰の目"));
    assert.ok(restoredEvidence.includes("王都"));
    const coldRuntime = await readTypedRuntimeMetadata(
      harness,
      reopened.page,
      projectId,
      restoredRunId,
    );
    assert.equal(coldRuntime.run.proposalSetId, typedProposalSetId);
    assert.equal(coldRuntime.run.proposalId, typedProposalId);
    assert.equal(coldRuntime.run.revisionId, typedRevisionId);
    assert.equal(coldRuntime.run.proposalStatus, "approved");
    assertTypedDecisionMetadata(coldRuntime, "approved");
    const dispatchObservation = await verifyNoForbiddenDispatches(
      harness,
      typedPanelJournalBoundary,
    );
    harness.recordTimeline(`${id}/cold-reopened`, {
      projectId,
      sceneId,
      typedRunId,
      restored: true,
      entityCount: 2,
      relationCount: 1,
      evidenceRestored: true,
      restoredRunId,
      restoredDecisionCount: coldRuntime.decisions.length,
      restoredRevisionId: coldRuntime.run.revisionId,
      dispatchObservation,
    });
    return {
      id,
      workspace,
      projectId,
      sceneId,
      typedRunId,
      runtimeBinding: {
        proposalSetId: coldRuntime.run.proposalSetId,
        proposalId: coldRuntime.run.proposalId,
        revisionId: coldRuntime.run.revisionId,
        proposalStatus: coldRuntime.run.proposalStatus,
        decision: coldRuntime.decisions[0]?.decision ?? null,
      },
      selectorSequence: [...CODEX_ENTITY_RELATION_REVIEW_SELECTORS],
      dispatchObservation,
    };
  } finally {
    await harness.close(reopened.app, reopened.page, `${id}/reopen`);
  }
}

export function createCodexEntityRelationReviewJourney({ configureWorkspace }) {
  return {
    id: CODEX_ENTITY_RELATION_REVIEW_JOURNEY_ID,
    run: (harness) =>
      runCodexEntityRelationReviewJourney(harness, { configureWorkspace }),
  };
}
