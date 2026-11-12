// Chronicle extraction of ONE scene ("今の場面", SSE/1 S10, DR-SSE-10) in a folder
// that holds sibling scenes -> human edit of one proposal (secret off) ->
// approve all -> apply -> restart. Same fixed provider response as
// chronicle-extract-review-apply-reopen: the extracted scene carries the same
// body; the siblings carry short unrelated bodies that must never reach the Run.
//
// Restart note: the extracted scene is the FIRST scene of its folder on purpose.
// A restart with an open scene that has a previous sibling in its folder crashes
// the renderer today (React #185, "Maximum update depth exceeded", layout never
// initializes); reported separately as a product defect, not worked around in
// product code. Siblings placed after the scene keep the restart reachable.
//
// IR (related scenes) admission: Native exposes no read of
// read_revision_retrieval_eligibility to the product path (it is a Rust crate
// function used by an offline cold-oracle example). This journey therefore
// asserts the preconditions of that verdict that ARE readable from the review
// bundle and the DB (see readIrAdmissionPreconditions); it does not claim the
// verdict itself.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { openPanel } from "./codex-entity-relation-product-journey.mjs";
import {
  assertEditedChronicleApplied,
  clearProposalSecretInReview,
  clickEnabledApplyButton,
  inspectEditedNative,
} from "./chronicle-edited-apply-product-journey.mjs";
import {
  analyzeChronicleAndWaitForProposals,
  createChronicleFixtureNode,
  observeChronicleBeforeReview,
  queryChronicleFixtureRows,
  readChronicleFixtureApplyPolicy,
  readChronicleReviewBundle,
  readChronicleSynthesisCompanion,
  saveChronicleEvidence,
  setupChronicleFixtureApplyPolicy,
  showChronicleFixturePanel,
  waitForChronicleFixtureWorkspace,
} from "./chronicle-extraction-product-journey.mjs";

const fixture = JSON.parse(
  readFileSync(
    new URL("../shared/productJourneyChronicleFixture.json", import.meta.url),
    "utf8",
  ),
);
export const CHRONICLE_CURRENT_SCENE_JOURNEY_ID =
  "chronicle-extract-current-scene-apply-reopen";
const ID = CHRONICLE_CURRENT_SCENE_JOURNEY_ID;
const EDITED_PROPOSAL_TITLE = "門が開いた";
const TITLES = ["門が開いた", "鐘が鳴った"];
// Two siblings, both AFTER the extracted scene (see the restart note above). Neither contains a fixture row
// text, so the fixed provider response can never cite them.
export const SIBLING_BODIES = Object.freeze({
  first: "港には朝霧が立ちこめていた。",
  second: "夕暮れの市場は人でにぎわっていた。",
});

/** The select value of the "今の場面" option (chronicleExtractScene.ts). */
export function currentSceneOptionValue(sceneId) {
  return `scene:${sceneId}`;
}

/** The sibling bodies must not be able to satisfy any fixed-response quote. */
export function assertSiblingBodiesAreInert(bodies = SIBLING_BODIES) {
  for (const body of Object.values(bodies)) {
    assert.ok(body.length > 0);
    for (const row of fixture.rows) {
      assert.ok(
        !body.includes(row.text) && !row.text.includes(body),
        `sibling body must not contain fixture text ${row.key}`,
      );
    }
  }
}

/**
 * The Run asked for exactly one scene of its parent folder, planned one window
 * and sealed that scene's body only.
 */
export function assertSceneScopedRun({
  run,
  bundle,
  folderId,
  sceneId,
  siblingSceneIds,
  siblingTexts,
}) {
  const scope = JSON.parse(run.scopeJson);
  assert.equal(scope.folderId, folderId, "scope names the parent folder");
  assert.deepEqual(scope.sceneIds, [sceneId], "scope names only the scene");
  for (const id of siblingSceneIds) {
    assert.ok(
      !run.scopeJson.includes(id),
      "scope must not mention a sibling scene",
    );
  }
  const coverage = JSON.parse(run.coverageJson);
  assert.equal(coverage.windowCount, 1, "one window for one short scene");
  const snapshots = bundle.artifacts.filter(
    (row) => row.artifactKind === "source.snapshot@1",
  );
  assert.equal(snapshots.length, 1, "one sealed snapshot");
  assert.deepEqual(
    snapshots[0].payloadJson.snapshot.documents.map((row) => row.sourceKey),
    [`project:scene:${sceneId}`],
    "the snapshot seals the requested scene only",
  );
  const serialized = JSON.stringify(bundle);
  for (const id of siblingSceneIds) {
    assert.ok(!serialized.includes(id), "no sibling scene id in the bundle");
  }
  for (const text of siblingTexts) {
    assert.ok(
      !serialized.includes(text),
      "no sibling scene body in the bundle",
    );
  }
}

const REPLAY_STAGES = new Set([
  "narrative_observation_extract",
  "narrative_event_synthesize",
]);

/**
 * Preconditions of Native's IR admission that are readable from the product
 * path, per proposal. Names follow the Native verdicts they mirror
 * (retrieval_admission/{current,disclosure}.rs, material_roster/replay.rs).
 * Returns a failure list per proposal: [] means every readable precondition
 * holds; ["Secret"] means only the disclosure mark stands in the way.
 */
export function readIrAdmissionPreconditions({
  projectId,
  sceneId,
  bundle,
  revisions,
  decisions,
  run,
}) {
  const shared = [];
  const coverage = JSON.parse(run.coverageJson);
  const artifact = (kind) =>
    bundle.artifacts.filter((row) => row.artifactKind === kind);
  const windowPlans = artifact("source.window-plan@1");
  if (
    windowPlans.length !== 1 ||
    coverage.windowCount !== windowPlans[0].payloadJson.windows.length ||
    ![1, 2].includes(coverage.windowCount)
  ) {
    shared.push("multi-window-recipe-not-implemented");
  }
  for (const receipt of bundle.stageReceipts) {
    if (receipt.stageExecution.stageId === "narrative_structured_repair") {
      shared.push("citation-repair-recipe-not-implemented");
    } else if (
      !REPLAY_STAGES.has(receipt.stageExecution.stageId) ||
      receipt.contextSetVersion !== "chronicle.context-set/1"
    ) {
      shared.push("component-recipe-unsupported");
    } else if (
      receipt.terminalStatus !== "succeeded" ||
      receipt.parseStatus !== "parsed" ||
      receipt.stageExecution.parentStageExecutionId != null
    ) {
      shared.push("no-repair-terminal-binding-invalid");
    }
  }
  const snapshots = artifact("source.snapshot@1");
  if (
    snapshots.length !== 1 ||
    snapshots[0].payloadJson.evidence?.catalog?.version !== 1 ||
    snapshots[0].payloadJson.evidence?.catalog?.segmentationVersion !==
      "sentence-like-v1"
  ) {
    shared.push("catalog-recipe-unsupported");
  }
  const raw = artifact("chronicle.raw-observations@1");
  const merged = artifact("chronicle.merged-observations@1");
  if (
    raw.length !== 1 ||
    merged.length !== 1 ||
    JSON.stringify(raw[0].payloadJson.observations) !==
      JSON.stringify(merged[0].payloadJson.observations)
  ) {
    shared.push("nonidentity-merge-recipe-not-implemented");
  }
  return bundle.proposals.map((proposal) => {
    const failures = [...shared];
    const revision = revisions.find(
      (row) => row.revisionId === proposal.currentRevisionId,
    );
    const latest = decisions
      .filter((row) => row.proposalId === proposal.proposalId)
      .sort(
        (a, b) =>
          String(b.createdAt).localeCompare(String(a.createdAt)) ||
          String(b.id).localeCompare(String(a.id)),
      )[0];
    if (
      proposal.status !== "approved" ||
      !revision ||
      !latest ||
      latest.revisionId !== proposal.currentRevisionId ||
      latest.decision !== "approved" ||
      latest.actorKind !== "human" ||
      latest.actorId !== "electron:human-review" ||
      latest.authorityScope !==
        `project/${projectId}/proposal/${proposal.proposalId}/revision/${proposal.currentRevisionId}`
    ) {
      failures.push("RevisionNotCurrentHumanApproved");
    }
    // Native stops at the first disclosure failure, and checks Secret first
    // (disclosure.rs prepare): a secret revision's Scope is never evaluated.
    if (proposal.payloadJson.disclosure.secret !== false) {
      failures.push("Secret");
    } else if (revision) {
      const scope = revision.envelope.assertion?.scope;
      const unresolved =
        scope &&
        typeof scope === "object" &&
        Object.values(scope).some((value) => value?.kind === "unresolved");
      if (unresolved) failures.push("ScopeUnresolved");
      else if (
        scope?.scene?.kind !== "exact" ||
        scope?.readingOrder?.kind !== "any" ||
        scope?.storyTime?.kind !== "any"
      ) {
        failures.push("ScopeUnsupported");
      }
    }
    return {
      proposalId: proposal.proposalId,
      revisionId: proposal.currentRevisionId,
      sceneId,
      failures,
    };
  });
}

/**
 * The edited (secret cleared) proposal has no readable obstacle; the one left
 * secret has exactly one, the disclosure mark.
 */
export function assertIrPreconditionsByDisclosure(
  readings,
  { editedProposalId },
) {
  assert.equal(readings.length, 2);
  for (const reading of readings) {
    if (reading.proposalId === editedProposalId) {
      assert.deepEqual(
        reading.failures,
        [],
        "the secret-free approved proposal meets every readable IR precondition",
      );
    } else {
      assert.deepEqual(
        reading.failures,
        ["Secret"],
        "the secret proposal is stopped only by its disclosure mark",
      );
    }
  }
}

/** Scene-scope IR-relevant fields of the persisted revisions (before any edit). */
export function assertRevisionsSealOnlyScene(
  revisions,
  { sceneId, siblingIds },
) {
  assert.ok(revisions.length > 0);
  for (const revision of revisions) {
    const serialized = JSON.stringify(revision.envelope);
    assert.ok(
      serialized.includes(`project:scene:${sceneId}`) ||
        serialized.includes(sceneId),
      "the envelope is bound to the extracted scene",
    );
    for (const id of siblingIds) {
      assert.ok(!serialized.includes(id), "no sibling scene in any envelope");
    }
  }
}

export async function openSceneInEditor(page, { sceneId, folderId }) {
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
  // The row's own left padding: its centre can land on the status-dot trigger.
  await row.click({ position: { x: 2, y: 2 } });
  await page
    .locator(
      `[data-editor-loaded-document-id="${sceneId}"][data-editor-document-loading="false"]:visible`,
    )
    .waitFor({ state: "visible", timeout: 30_000 });
}

/**
 * Choose "今の場面" in the target select. The option exists only for the scene
 * that is open in the editor, so a scene that is not open fails here.
 */
export async function chooseCurrentSceneTarget(dialog, sceneId) {
  const select = dialog.locator("select");
  await select.selectOption(currentSceneOptionValue(sceneId), {
    timeout: 15_000,
  });
  assert.equal(await select.inputValue(), currentSceneOptionValue(sceneId));
}

export async function readRunAndDecisions(
  harness,
  page,
  identity,
  proposalIds,
) {
  const [run] = await queryChronicleFixtureRows(
    harness,
    page,
    "SELECT scope_json AS scopeJson, coverage_json AS coverageJson, surface_path_id AS surfacePathId FROM narrative_extraction_runs WHERE id = ? AND project_id = ?",
    [identity.runId, identity.projectId],
  );
  assert.ok(run, "the Run row");
  assert.equal(run.surfacePathId, "chronicle.extract");
  const decisions = proposalIds.length
    ? await queryChronicleFixtureRows(
        harness,
        page,
        `SELECT id, proposal_id AS proposalId, revision_id AS revisionId, decision,
                actor_kind AS actorKind, actor_id AS actorId,
                authority_scope AS authorityScope, created_at AS createdAt
           FROM narrative_proposal_decisions
          WHERE proposal_id IN (${proposalIds.map(() => "?").join(", ")})`,
        proposalIds,
      )
    : [];
  return { run, decisions };
}

const MAIN_LINE_AXES = {
  timeline: { kind: "exact", ref: "timeline:main" },
  worldline: { kind: "exact", ref: "worldline:prime" },
  narrativeLayer: { kind: "exact", ref: "layer:manuscript" },
};

/**
 * The product's ordinary project shape (create dialog, main line ON): the
 * project Scene Scope default is `set` to the main line before any Scene is
 * created, so every new Scene binding is born `explicit`.
 */
export async function setMainLineSceneScopeDefault({
  invoke,
  workspace,
  projectId,
}) {
  const current = await invoke("narrative_scope_project_default_read", {
    expectedWorkspacePath: workspace,
    projectId,
  });
  return invoke("narrative_scope_project_default_update", {
    expectedWorkspacePath: workspace,
    payload: {
      projectId,
      requestId: randomUUID(),
      sessionId: randomUUID(),
      eventUid: randomUUID(),
      baseVersion: current.version,
      updatedAt: new Date().toISOString(),
      default: {
        state: "set",
        queryIdentity: MAIN_LINE_AXES,
        materialConstraint: MAIN_LINE_AXES,
      },
    },
  });
}

/** Every Scene must have a binding born `explicit` from the main-line default. */
export function assertSceneBindingsExplicit(bindingRows, sceneIds) {
  assert.equal(
    bindingRows.length,
    sceneIds.length,
    "every Scene has a scope binding",
  );
  for (const sceneId of sceneIds) {
    const row = bindingRows.find((r) => r.sceneId === sceneId);
    assert.ok(row, `scope binding exists for ${sceneId}`);
    assert.equal(
      row.compatibilityMarker,
      "explicit",
      `scope binding of ${sceneId} must be explicit`,
    );
  }
}

export function createChronicleCurrentSceneJourney({
  configureWorkspace,
  evidenceDirectory,
}) {
  return {
    id: ID,
    run: async (harness) => {
      assertSiblingBodiesAreInert();
      const directory = path.join(evidenceDirectory, ID);
      const workspace = harness.workspacePath(ID);
      await configureWorkspace(harness, workspace, { deterministicAi: true });
      const seed = await harness.launch(`${ID}/seed`);
      let projectId;
      let fixtureApplyPolicy;
      const folderId = randomUUID();
      const sceneId = randomUUID();
      const siblingIds = { first: randomUUID(), second: randomUUID() };
      const paragraphs = (texts) => ({
        type: "doc",
        content: texts.map((text) => ({
          type: "paragraph",
          content: [{ type: "text", text }],
        })),
      });
      try {
        projectId = await harness.waitUntil(
          async () =>
            (
              await queryChronicleFixtureRows(
                harness,
                seed.page,
                "SELECT id FROM projects ORDER BY created_at, id LIMIT 1",
              )
            )[0]?.id,
          "fixture project",
        );
        fixtureApplyPolicy = await setupChronicleFixtureApplyPolicy(
          harness,
          seed.page,
        );
        harness.recordTimeline(`${ID}/fixture-policy-setup`, {
          diagnosticFixtureConfiguration: true,
          evidence: await saveChronicleEvidence(
            directory,
            "fixture-policy-setup",
            fixtureApplyPolicy,
          ),
        });
        await setMainLineSceneScopeDefault({
          invoke: (command, args) => harness.invokeOk(seed.page, command, args),
          workspace,
          projectId,
        });
        await createChronicleFixtureNode(harness, seed.page, projectId, {
          id: folderId,
          parentId: null,
          nodeType: "folder",
          title: "実在性の比較",
          sortOrder: "a0",
          content: null,
        });
        await createChronicleFixtureNode(harness, seed.page, projectId, {
          id: sceneId,
          parentId: folderId,
          nodeType: "scene",
          title: "門と鐘",
          sortOrder: "a0",
          content: JSON.stringify(paragraphs(fixture.rows.map((r) => r.text))),
        });
        await createChronicleFixtureNode(harness, seed.page, projectId, {
          id: siblingIds.first,
          parentId: folderId,
          nodeType: "scene",
          title: "港の朝",
          sortOrder: "a1",
          content: JSON.stringify(paragraphs([SIBLING_BODIES.first])),
        });
        await createChronicleFixtureNode(harness, seed.page, projectId, {
          id: siblingIds.second,
          parentId: folderId,
          nodeType: "scene",
          title: "夕暮れの市場",
          sortOrder: "a2",
          content: JSON.stringify(paragraphs([SIBLING_BODIES.second])),
        });
        assertSceneBindingsExplicit(
          await queryChronicleFixtureRows(
            harness,
            seed.page,
            "SELECT scene_id AS sceneId, compatibility_marker AS compatibilityMarker FROM narrative_scene_scope_bindings WHERE project_id=?",
            [projectId],
          ),
          [sceneId, siblingIds.first, siblingIds.second],
        );
      } finally {
        await harness.close(seed.app, seed.page, `${ID}/seed`);
      }
      const siblingSceneIds = Object.values(siblingIds);
      const siblingTexts = Object.values(SIBLING_BODIES);
      const review = await harness.launch(`${ID}/extract-edit-approve-apply`);
      let identity;
      let appliedSnapshot;
      let artifactDigests;
      let stageReceiptDigests;
      let initialSynthesisCompanion;
      let edited;
      try {
        await waitForChronicleFixtureWorkspace(harness, review.page, {
          projectId,
          sceneId,
        });
        await readChronicleFixtureApplyPolicy(
          harness,
          review.page,
          fixtureApplyPolicy.after,
        );
        // Step 1: make the extracted scene the open scene (activeSceneId).
        await openSceneInEditor(review.page, { sceneId, folderId });
        await showChronicleFixturePanel(review.page);
        await review.page.getByTitle("AI 抽出", { exact: true }).click();
        const dialog = review.page.getByRole("dialog");
        // Step 2: choose "今の場面" (the option exists only for the open scene).
        await chooseCurrentSceneTarget(dialog, sceneId);
        // Step 3: one press of 解析 starts the Run; a start notice is a failure.
        identity = await analyzeChronicleAndWaitForProposals({
          harness,
          page: review.page,
          dialog,
          projectId,
          directory,
          failOnStartNotices: true,
        });
        const bundleNow = () =>
          readChronicleReviewBundle(harness, review.page, identity);
        const initial = await bundleNow();
        initialSynthesisCompanion = await readChronicleSynthesisCompanion(
          harness,
          review.page,
          initial,
        );
        const contract = observeChronicleBeforeReview(
          initial,
          initialSynthesisCompanion,
        );
        const before = await inspectEditedNative(
          harness,
          review.page,
          initial,
          sceneId,
        );
        assert.equal(before.events.length, 0);
        assert.equal(before.applications.length, 0);
        assert.equal(before.revisions.length, 2);
        const proposalIds = initial.proposals.map((row) => row.proposalId);
        const runState = await readRunAndDecisions(
          harness,
          review.page,
          identity,
          proposalIds,
        );
        // Step 4: the Run is scoped to the one scene; siblings never entered.
        assertSceneScopedRun({
          run: runState.run,
          bundle: initial,
          folderId,
          sceneId,
          siblingSceneIds,
          siblingTexts,
        });
        assertRevisionsSealOnlyScene(before.revisions, {
          sceneId,
          siblingIds: siblingSceneIds,
        });
        assert.ok(
          initial.proposals.every(
            (row) => row.payloadJson.disclosure.secret === true,
          ),
          "extracted proposals start secret",
        );
        artifactDigests = initial.artifacts
          .map((row) => [row.artifactId, row.payloadDigest])
          .sort();
        stageReceiptDigests = initial.stageReceipts
          .map((row) => [
            row.stageExecution.stageExecutionId,
            row.stageExecutionReceiptDigest,
          ])
          .sort();
        harness.recordTimeline(`${ID}/initial`, {
          ...identity,
          sceneId,
          folderId,
          siblingSceneIds,
          proposalSetId: initial.proposalSet.proposalSetId,
          proposalCount: 2,
          evidence: await saveChronicleEvidence(directory, "initial", {
            bundle: initial,
            run: runState.run,
            persistedSynthesisCompanion: initialSynthesisCompanion,
            native: before,
            contract,
          }),
        });

        const parent = initial.proposals.find(
          (row) => row.payloadJson.title === EDITED_PROPOSAL_TITLE,
        );
        assert.ok(parent, `fixture proposal ${EDITED_PROPOSAL_TITLE}`);
        const rootRevisionId = parent.currentRevisionId;

        // Step 5: clear the secret mark of one proposal in the review UI.
        const child = await clearProposalSecretInReview({
          harness,
          dialog,
          parent,
          readBundle: bundleNow,
        });
        const afterEdit = await bundleNow();
        const afterEditNative = await inspectEditedNative(
          harness,
          review.page,
          afterEdit,
          sceneId,
        );
        assert.equal(afterEditNative.revisions.length, 3);
        assert.equal(afterEditNative.events.length, 0);
        edited = {
          proposalId: parent.proposalId,
          rootRevisionId,
          childRevisionId: child.currentRevisionId,
        };

        // Step 6: approve every proposal.
        for (const proposal of afterEdit.proposals) {
          const card = dialog.getByTestId(
            `chronicle-proposal-card-${proposal.proposalId}`,
          );
          await card.getByRole("button").first().click();
          const quotePane = dialog.getByTestId("chronicle-evidence-pane");
          await quotePane.waitFor({ state: "visible" });
          const expectedQuote = fixture.rows.find(
            (row) => row.title === proposal.payloadJson.title,
          ).text;
          assert.ok((await quotePane.textContent()).includes(expectedQuote));
          await card.getByRole("button", { name: "承認", exact: true }).click();
          await harness.waitUntil(
            async () =>
              (await bundleNow()).proposals.find(
                (row) => row.proposalId === proposal.proposalId,
              )?.latestDecision?.decision === "approved",
            "durable human approval",
          );
        }
        const approved = await bundleNow();
        const approvedNative = await inspectEditedNative(
          harness,
          review.page,
          approved,
          sceneId,
        );
        assert.equal(approvedNative.events.length, 0);
        assert.equal(approvedNative.applications.length, 0);
        assert.equal(
          approved.proposals.find((row) => row.proposalId === edited.proposalId)
            .currentRevisionId,
          edited.childRevisionId,
        );
        // Step 7: IR admission preconditions, before any apply (an apply is not
        // an IR requirement). Approved + secret-free passes; secret does not.
        const approvedState = await readRunAndDecisions(
          harness,
          review.page,
          identity,
          approved.proposals.map((row) => row.proposalId),
        );
        const irReadings = readIrAdmissionPreconditions({
          projectId,
          sceneId,
          bundle: approved,
          revisions: approvedNative.revisions,
          decisions: approvedState.decisions,
          run: approvedState.run,
        });
        assertIrPreconditionsByDisclosure(irReadings, {
          editedProposalId: edited.proposalId,
        });
        harness.recordTimeline(`${ID}/approved`, {
          ...identity,
          irReadings,
          evidence: await saveChronicleEvidence(directory, "approved", {
            bundle: approved,
            native: approvedNative,
            decisions: approvedState.decisions,
            irReadings,
            edited,
          }),
        });

        // Step 8: the apply button must be open; apply.
        const policy = await readChronicleFixtureApplyPolicy(
          harness,
          review.page,
          fixtureApplyPolicy.after,
        );
        harness.recordTimeline(`${ID}/fixture-policy-before-apply`, {
          diagnosticFixtureConfiguration: true,
          evidence: await saveChronicleEvidence(
            directory,
            "fixture-policy-before-apply",
            policy,
          ),
        });
        await clickEnabledApplyButton({ harness, dialog });
        const applied = await harness.waitUntil(
          async () => {
            const bundle = await bundleNow();
            return bundle.proposals.every((row) => row.application)
              ? bundle
              : null;
          },
          "real Native Prepare/Apply committed",
          60_000,
        );
        appliedSnapshot = await inspectEditedNative(
          harness,
          review.page,
          applied,
          sceneId,
        );
        assertEditedChronicleApplied(appliedSnapshot, applied, {
          sceneId,
          editedProposalId: edited.proposalId,
          rootRevisionId: edited.rootRevisionId,
        });
        // The apply neither moves the Run's scope nor changes the IR reading.
        const appliedState = await readRunAndDecisions(
          harness,
          review.page,
          identity,
          applied.proposals.map((row) => row.proposalId),
        );
        assert.equal(appliedState.run.scopeJson, runState.run.scopeJson);
        assertIrPreconditionsByDisclosure(
          readIrAdmissionPreconditions({
            projectId,
            sceneId,
            bundle: applied,
            revisions: appliedSnapshot.revisions,
            decisions: appliedState.decisions,
            run: appliedState.run,
          }),
          { editedProposalId: edited.proposalId },
        );
        const appliedCompanion = await readChronicleSynthesisCompanion(
          harness,
          review.page,
          applied,
        );
        assert.deepEqual(appliedCompanion, initialSynthesisCompanion);
        assert.deepEqual(
          applied.artifacts
            .map((row) => [row.artifactId, row.payloadDigest])
            .sort(),
          artifactDigests,
        );
        assert.deepEqual(
          applied.stageReceipts
            .map((row) => [
              row.stageExecution.stageExecutionId,
              row.stageExecutionReceiptDigest,
            ])
            .sort(),
          stageReceiptDigests,
        );
        harness.recordTimeline(`${ID}/applied`, {
          ...identity,
          evidence: await saveChronicleEvidence(directory, "applied", {
            bundle: applied,
            persistedSynthesisCompanion: appliedCompanion,
            native: appliedSnapshot,
          }),
        });
      } finally {
        await harness.close(
          review.app,
          review.page,
          `${ID}/extract-edit-approve-apply`,
        );
      }
      const reopened = await harness.launch(`${ID}/reopen`);
      try {
        await waitForChronicleFixtureWorkspace(harness, reopened.page, {
          projectId,
          sceneId,
        });
        const reopenedPolicy = await readChronicleFixtureApplyPolicy(
          harness,
          reopened.page,
          fixtureApplyPolicy.after,
        );
        const bundle = await readChronicleReviewBundle(
          harness,
          reopened.page,
          identity,
        );
        const reopenedCompanion = await readChronicleSynthesisCompanion(
          harness,
          reopened.page,
          bundle,
        );
        assert.deepEqual(reopenedCompanion, initialSynthesisCompanion);
        const restored = await inspectEditedNative(
          harness,
          reopened.page,
          bundle,
          sceneId,
        );
        assertEditedChronicleApplied(restored, bundle, {
          sceneId,
          editedProposalId: edited.proposalId,
          rootRevisionId: edited.rootRevisionId,
        });
        assert.deepEqual(restored.events, appliedSnapshot.events);
        assert.deepEqual(restored.applications, appliedSnapshot.applications);
        assert.deepEqual(restored.revisions, appliedSnapshot.revisions);
        assert.deepEqual(restored.journals, appliedSnapshot.journals);
        assert.deepEqual(
          bundle.artifacts
            .map((row) => [row.artifactId, row.payloadDigest])
            .sort(),
          artifactDigests,
        );
        assert.deepEqual(
          bundle.stageReceipts
            .map((row) => [
              row.stageExecution.stageExecutionId,
              row.stageExecutionReceiptDigest,
            ])
            .sort(),
          stageReceiptDigests,
        );
        const reopenedState = await readRunAndDecisions(
          harness,
          reopened.page,
          identity,
          bundle.proposals.map((row) => row.proposalId),
        );
        assertSceneScopedRun({
          run: reopenedState.run,
          bundle,
          folderId,
          sceneId,
          siblingSceneIds,
          siblingTexts,
        });
        await showChronicleFixturePanel(reopened.page);
        for (const title of TITLES)
          await reopened.page
            .getByText(title, { exact: true })
            .first()
            .waitFor({ state: "visible" });
        await reopened.page.getByTitle("AI 抽出", { exact: true }).click();
        const dialog = reopened.page.getByRole("dialog");
        // ダイアログは初回に読み込んで mount するので、出るのを待つ。
        await dialog.waitFor({ state: "visible" });
        assert.equal(
          await dialog
            .locator('[data-testid^="chronicle-proposal-card-"]')
            .count(),
          0,
        );
        const resumable = await harness.invokeOk(
          reopened.page,
          "narrative_extraction_is_run_resumable_for_review",
          { payload: { ...identity, surfacePathId: "chronicle.extract" } },
        );
        assert.equal(resumable.resumable, false);
        harness.recordTimeline(`${ID}/reopened`, {
          ...identity,
          eventCount: 2,
          applicationCount: 2,
          commitCount: 1,
          duplicateCount: 0,
          evidence: await saveChronicleEvidence(directory, "reopened", {
            bundle,
            fixtureRuntimePolicy: reopenedPolicy,
            persistedSynthesisCompanion: reopenedCompanion,
            native: restored,
          }),
        });
      } finally {
        await harness.close(reopened.app, reopened.page, `${ID}/reopen`);
      }
    },
  };
}
