// Chronicle extraction -> "bulk approve" of the proposals with no review reason
// (BAO/1) -> human edit of the remaining proposal (secret off) -> approve it ->
// apply -> restart. Same fixed provider response and workspace as
// chronicle-extract-review-apply-reopen. Native records both the bulk approval
// and the edit as human-derived child revisions (ERA/1, DR-ERA-12; BAO/1).
// The fixed response gives the bell event ordinary significance (the bulk
// approval target) and keeps the gate event major (r3-significance).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import {
  assertSceneBindingsExplicit,
  readIrAdmissionPreconditions,
  readRunAndDecisions,
  setMainLineSceneScopeDefault,
} from "./chronicle-current-scene-product-journey.mjs";
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
export const CHRONICLE_EDITED_APPLY_JOURNEY_ID =
  "chronicle-extract-edit-approve-apply-reopen";
const ID = CHRONICLE_EDITED_APPLY_JOURNEY_ID;
// The proposal whose secret mark the journey clears in the review UI.
export const EDITED_PROPOSAL_TITLE = "門が開いた";
// The proposal the bulk approval must approve (its fixture row has ordinary
// significance); the edited proposal above keeps r3-significance.
export const BULK_APPROVED_PROPOSAL_TITLE = "鐘が鳴った";
const TITLES = ["門が開いた", "鐘が鳴った"];
export const BULK_APPROVE_BUTTON_TESTID = "chronicle-bulk-approve-safe";
export const BULK_APPROVE_RESULT_TESTID = "chronicle-bulk-approve-result";
const HUMAN_REVIEW_ACTOR_ID = "electron:human-review";

/**
 * The edited proposal must have gained exactly one human-derived child that
 * differs from its parent only in /disclosure/secret and is still unreviewed.
 */
export function assertEditedChild(parent, child) {
  assert.equal(child.proposalId, parent.proposalId);
  assert.notEqual(
    child.currentRevisionId,
    parent.currentRevisionId,
    "editing must create a new revision",
  );
  assert.equal(parent.payloadJson.disclosure.secret, true);
  assert.equal(child.payloadJson.disclosure.secret, false);
  const expected = globalThis.structuredClone(parent.payloadJson);
  expected.disclosure.secret = false;
  assert.deepEqual(child.payloadJson, expected);
  assert.equal(child.status, "unreviewed");
  assert.equal(
    child.latestDecision,
    null,
    "a child must not inherit a parent Decision",
  );
}

/** Lineage of the edited revision as Native stored it. */
export function assertHumanDerivedLineage(root, child) {
  assert.notEqual(child.revisionId, root.revisionId);
  assert.notEqual(child.envelopeDigest, root.envelopeDigest);
  assert.equal(root.envelope.revisionBasis.kind, "interpretation");
  const basis = child.envelope.revisionBasis;
  assert.equal(basis.kind, "human-derived");
  assert.equal(basis.parentRevisionId, root.revisionId);
  assert.equal(basis.expectedParentEnvelopeDigest, root.envelopeDigest);
  assert.equal(basis.rootInterpretationRevisionId, root.revisionId);
  assert.equal(basis.derivation.kind, "scope-override");
  assert.deepEqual(basis.derivation.proposalPayloadChangedPaths, [
    "/disclosure/secret",
  ]);
  assert.equal(basis.revisionActor.kind, "human");
}

/**
 * Applied state of the edited journey. `state.revisions` holds every stored
 * revision of every proposal; the applied revision of each proposal is the one
 * its application points at. `bulkApproved` lists the proposals that the bulk
 * approval turned into a human-derived child ({ proposalId, rootRevisionId });
 * like the edited one they are applied from that child, secret-free.
 */
export function assertEditedChronicleApplied(
  state,
  bundle,
  { sceneId, editedProposalId, rootRevisionId, bulkApproved = [] },
) {
  const proposalCount = bundle.proposals.length;
  assert.equal(proposalCount, 2);
  assert.equal(state.events.length, proposalCount);
  assert.deepEqual(
    state.events.map((row) => row.title).sort(),
    [...TITLES].sort(),
  );
  // CAS/1: Events created by an extraction apply are always secret.
  assert.ok(
    state.events.every((row) => Number(row.secret) === 1),
    "every created Chronicle Event is secret (CAS/1)",
  );
  assert.equal(state.applications.length, proposalCount);
  assert.equal(new Set(state.applications.map((row) => row.commitId)).size, 1);
  assert.equal(state.commits.length, 1);
  assert.equal(state.commits[0].status, "applied");
  assert.equal(state.journals.length, 1);
  assert.deepEqual(
    state.applications.map((row) => row.appliedEntityId).sort(),
    state.events.map((row) => row.id).sort(),
  );
  assert.deepEqual(
    state.sceneLinks.map((row) => row.eventId).sort(),
    state.events.map((row) => row.id).sort(),
  );
  assert.ok(state.sceneLinks.every((row) => row.sceneId === sceneId));
  for (const proposal of bundle.proposals) {
    assert.equal(proposal.latestDecision?.decision, "approved");
    assert.equal(proposal.latestDecision?.actorKind, "human");
    assert.equal(
      proposal.latestDecision?.revisionId,
      proposal.currentRevisionId,
    );
    assert.equal(proposal.application?.revisionId, proposal.currentRevisionId);
    const appliedRevision = state.revisions.find(
      (row) => row.revisionId === proposal.application.revisionId,
    );
    assert.ok(appliedRevision, "the applied revision is stored");
    assert.equal(appliedRevision.proposalId, proposal.proposalId);
    const derivedRootRevisionId =
      proposal.proposalId === editedProposalId
        ? rootRevisionId
        : bulkApproved.find((row) => row.proposalId === proposal.proposalId)
            ?.rootRevisionId;
    if (derivedRootRevisionId !== undefined) {
      assert.notEqual(proposal.currentRevisionId, derivedRootRevisionId);
      assert.equal(
        appliedRevision.envelope.revisionBasis.kind,
        "human-derived",
      );
      assert.equal(proposal.payloadJson.disclosure.secret, false);
      const root = state.revisions.find(
        (row) => row.revisionId === derivedRootRevisionId,
      );
      assert.ok(root, "the derived proposal's root revision is stored");
      assertHumanDerivedLineage(root, appliedRevision);
    } else {
      assert.equal(
        appliedRevision.envelope.revisionBasis.kind,
        "interpretation",
      );
      assert.equal(proposal.payloadJson.disclosure.secret, true);
    }
  }
}

/**
 * Native's bulk-approval judgement as the review bundle carries it (BAO/1, B3):
 * the proposal with ordinary significance is a target with no reason; the
 * major one is not, for r3-significance alone.
 */
export function assertBulkApprovalJudgement(
  proposals,
  { eligibleTitle, ineligibleTitle },
) {
  assert.equal(proposals.length, 2);
  const eligible = proposals.find(
    (row) => row.payloadJson.title === eligibleTitle,
  );
  const ineligible = proposals.find(
    (row) => row.payloadJson.title === ineligibleTitle,
  );
  assert.ok(eligible, `proposal ${eligibleTitle}`);
  assert.ok(ineligible, `proposal ${ineligibleTitle}`);
  assert.deepEqual(eligible.bulkApproval, { eligible: true, reasons: [] });
  assert.deepEqual(ineligible.bulkApproval, {
    eligible: false,
    reasons: ["r3-significance"],
  });
}

/** Nothing is left for the bulk approval to do. */
export function assertNoBulkApprovalTargets(proposals) {
  assert.ok(proposals.length > 0);
  for (const row of proposals) {
    assert.equal(row.bulkApproval?.eligible, false, "no bulk approval target");
  }
}

/**
 * The bulk-approved proposal gained one human-derived child that differs from
 * its parent only in /disclosure/secret and carries the author's approval of
 * that very revision.
 */
export function assertBulkApprovedChild(parent, child) {
  assert.equal(child.proposalId, parent.proposalId);
  assert.notEqual(
    child.currentRevisionId,
    parent.currentRevisionId,
    "bulk approval must create a new revision",
  );
  assert.equal(parent.payloadJson.disclosure.secret, true);
  assert.equal(child.payloadJson.disclosure.secret, false);
  const expected = globalThis.structuredClone(parent.payloadJson);
  expected.disclosure.secret = false;
  assert.deepEqual(child.payloadJson, expected);
  assert.equal(child.status, "approved");
  assert.equal(child.latestDecision?.decision, "approved");
  assert.equal(child.latestDecision.actorKind, "human");
  assert.equal(
    child.latestDecision.revisionId,
    child.currentRevisionId,
    "the approval is on the child revision",
  );
  assert.ok(!child.application, "bulk approval does not apply");
}

/** A proposal outside the bulk approval keeps its first revision and no decision. */
export function assertBulkApprovalLeftUntouched(before, after) {
  assert.equal(after.proposalId, before.proposalId);
  assert.equal(after.currentRevisionId, before.currentRevisionId);
  assert.equal(after.status, "unreviewed");
  assert.equal(after.latestDecision, null);
  assert.deepEqual(after.payloadJson, before.payloadJson);
  assert.ok(!after.application);
}

/**
 * Every decision of the journey (the bulk-approved one and the one-by-one one)
 * has the ordinary author actor and authority for its own revision.
 */
export function assertSameApprovalActor(decisions, { projectId, proposals }) {
  assert.equal(decisions.length, proposals.length);
  for (const proposal of proposals) {
    const rows = decisions.filter(
      (row) => row.proposalId === proposal.proposalId,
    );
    assert.equal(rows.length, 1, "one approval per proposal");
    assert.equal(rows[0].decision, "approved");
    assert.equal(rows[0].actorKind, "human");
    assert.equal(rows[0].actorId, HUMAN_REVIEW_ACTOR_ID);
    assert.equal(rows[0].revisionId, proposal.currentRevisionId);
    assert.equal(
      rows[0].authorityScope,
      `project/${projectId}/proposal/${proposal.proposalId}/revision/${proposal.currentRevisionId}`,
    );
  }
}

/** The number the button label shows ("... (N)"); 0 when there is none. */
export function bulkApproveCountFromLabel(label) {
  const match = /\((\d+)\)\s*$/u.exec(String(label).trim());
  return match ? Number(match[1]) : 0;
}

/** Counts in the result line shown after a bulk approval (ChronicleBulkApproveOutcomeNote). */
export function assertBulkApproveResultText(text, { approved, remaining }) {
  const approvedMatch = /(\d+) 件を承認しました/u.exec(text);
  assert.ok(approvedMatch, `result shows the approved count: ${text}`);
  assert.equal(Number(approvedMatch[1]), approved);
  const remainingMatch = /個別に決める提案が (\d+) 件残っています/u.exec(text);
  assert.ok(remainingMatch, `result shows the remaining count: ${text}`);
  assert.equal(Number(remainingMatch[1]), remaining);
  assert.ok(!text.includes("飛ばしました"), "nothing was skipped");
  assert.ok(!text.includes("途中で止まりました"), "the run was not stopped");
}

/**
 * Press the bulk approve button. A disabled button, or a count other than
 * `expectedCount`, fails the journey instead of being forced; the result line
 * is returned after it appears.
 */
export async function clickEnabledBulkApproveButton({
  harness,
  dialog,
  expectedCount,
}) {
  const button = dialog.getByTestId(BULK_APPROVE_BUTTON_TESTID);
  await button.waitFor({ state: "visible" });
  await harness.waitUntil(
    async () => button.isEnabled(),
    "the bulk approve button is enabled",
    15_000,
  );
  assert.equal(await button.isEnabled(), true, "bulk approve is enabled");
  assert.equal(
    bulkApproveCountFromLabel(await button.textContent()),
    expectedCount,
    "the button shows the number of targets",
  );
  await button.click();
  const result = dialog.getByTestId(BULK_APPROVE_RESULT_TESTID);
  await result.waitFor({ state: "visible", timeout: 30_000 });
  return (await result.textContent()).trim();
}

/** After the press: no target is left and the button is disabled. */
export async function assertBulkApproveButtonIdle({ harness, dialog }) {
  const button = dialog.getByTestId(BULK_APPROVE_BUTTON_TESTID);
  await button.waitFor({ state: "visible" });
  await harness.waitUntil(
    async () =>
      !(await button.isEnabled()) &&
      bulkApproveCountFromLabel(await button.textContent()) === 0,
    "the bulk approve button is disabled with no targets",
    15_000,
  );
  assert.equal(await button.isEnabled(), false, "bulk approve is disabled");
  assert.equal(bulkApproveCountFromLabel(await button.textContent()), 0);
}

/**
 * Select the proposal's card, clear its secret mark and wait until Native has
 * stored the human-derived child. The controlled checkbox settles only after
 * the child is persisted, so the wait reads the review bundle, not the DOM.
 */
export async function clearProposalSecretInReview({
  harness,
  dialog,
  parent,
  readBundle,
}) {
  const card = dialog.getByTestId(
    `chronicle-proposal-card-${parent.proposalId}`,
  );
  await card.getByRole("button").first().click();
  const checkbox = dialog.getByTestId("chronicle-proposal-secret-input");
  await checkbox.waitFor({ state: "visible" });
  assert.equal(await checkbox.isChecked(), true, "secret starts checked");
  await checkbox.click();
  const child = await harness.waitUntil(async () => {
    const row = (await readBundle()).proposals.find(
      (entry) => entry.proposalId === parent.proposalId,
    );
    return (
      row?.currentRevisionId !== parent.currentRevisionId &&
      row?.payloadJson.disclosure.secret === false &&
      row
    );
  }, "the UI records a human-derived child without secret");
  await harness.waitUntil(
    async () => !(await checkbox.isChecked()),
    "the review checkbox reflects the saved child",
  );
  assertEditedChild(parent, child);
  return child;
}

/**
 * The apply button must be enabled for a set that contains an edited
 * revision (E8). A disabled button fails the journey instead of being forced.
 */
export async function clickEnabledApplyButton({ harness, dialog }) {
  const button = dialog.getByRole("button", { name: "取り込む", exact: true });
  await button.waitFor({ state: "visible" });
  await harness.waitUntil(
    async () => button.isEnabled(),
    "the apply button is enabled for approved edited revisions",
    15_000,
  );
  assert.equal(await button.isEnabled(), true, "apply button is enabled");
  await button.click();
}

export async function inspectEditedNative(harness, page, bundle, sceneId) {
  const proposalIds = bundle.proposals.map((row) => row.proposalId);
  const revisionRows = await queryChronicleFixtureRows(
    harness,
    page,
    `SELECT id AS revisionId, proposal_id AS proposalId, revision_number AS revisionNumber,
            reconciliation_envelope_json AS envelopeJson,
            reconciliation_envelope_digest AS envelopeDigest
       FROM narrative_proposal_revisions
      WHERE proposal_id IN (${proposalIds.map(() => "?").join(", ")})
      ORDER BY proposal_id, revision_number, id`,
    proposalIds,
  );
  const revisions = revisionRows.map(({ envelopeJson, ...row }) => ({
    ...row,
    envelope: JSON.parse(envelopeJson),
  }));
  const events = await queryChronicleFixtureRows(
    harness,
    page,
    "SELECT id, title, secret FROM events WHERE project_id = ? ORDER BY id",
    [bundle.projectId],
  );
  const sceneLinks = await queryChronicleFixtureRows(
    harness,
    page,
    "SELECT scene_id AS sceneId, event_id AS eventId FROM scene_events WHERE scene_id = ? ORDER BY event_id",
    [sceneId],
  );
  const applications = bundle.proposals
    .map((row) => row.application)
    .filter(Boolean);
  const commitIds = [...new Set(applications.map((row) => row.commitId))];
  const commits = commitIds.length
    ? await queryChronicleFixtureRows(
        harness,
        page,
        "SELECT id, status FROM narrative_apply_commits WHERE id = ?",
        [commitIds[0]],
      )
    : [];
  const journals = commitIds.length
    ? await queryChronicleFixtureRows(
        harness,
        page,
        "SELECT id, commit_id AS commitId, after_json AS afterJson FROM narrative_commit_journals WHERE commit_id = ?",
        [commitIds[0]],
      )
    : [];
  return { revisions, events, sceneLinks, applications, commits, journals };
}

export function createChronicleEditedApplyJourney({
  configureWorkspace,
  evidenceDirectory,
}) {
  return {
    id: ID,
    run: async (harness) => {
      const directory = path.join(evidenceDirectory, ID);
      const workspace = harness.workspacePath(ID);
      await configureWorkspace(harness, workspace, { deterministicAi: true });
      const seed = await harness.launch(`${ID}/seed`);
      let projectId;
      let fixtureApplyPolicy;
      const folderId = randomUUID();
      const sceneId = randomUUID();
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
        // The product's ordinary project shape: the Scene Scope default is the
        // main line before any Scene exists, so each Scene binding is born
        // explicit and the bulk-approved revisions can meet the IR conditions.
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
          content: JSON.stringify({
            type: "doc",
            content: fixture.rows.map((row) => ({
              type: "paragraph",
              content: [{ type: "text", text: row.text }],
            })),
          }),
        });
        assertSceneBindingsExplicit(
          await queryChronicleFixtureRows(
            harness,
            seed.page,
            "SELECT scene_id AS sceneId, compatibility_marker AS compatibilityMarker FROM narrative_scene_scope_bindings WHERE project_id=?",
            [projectId],
          ),
          [sceneId],
        );
      } finally {
        await harness.close(seed.app, seed.page, `${ID}/seed`);
      }
      const review = await harness.launch(`${ID}/extract-edit-approve-apply`);
      let identity;
      let appliedSnapshot;
      let artifactDigests;
      let stageReceiptDigests;
      let initialSynthesisCompanion;
      let edited;
      let bulkApproved;
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
        await showChronicleFixturePanel(review.page);
        await review.page.getByTitle("AI 抽出", { exact: true }).click();
        const dialog = review.page.getByRole("dialog");
        await dialog.locator("select").selectOption(folderId);
        identity = await analyzeChronicleAndWaitForProposals({
          harness,
          page: review.page,
          dialog,
          projectId,
          directory,
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
          proposalSetId: initial.proposalSet.proposalSetId,
          proposalCount: 2,
          evidence: await saveChronicleEvidence(directory, "initial", {
            bundle: initial,
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
        const bulkParent = initial.proposals.find(
          (row) => row.payloadJson.title === BULK_APPROVED_PROPOSAL_TITLE,
        );
        assert.ok(
          bulkParent,
          `fixture proposal ${BULK_APPROVED_PROPOSAL_TITLE}`,
        );
        const bulkRootRevisionId = bulkParent.currentRevisionId;

        // Step 1: Native's judgement. Only the ordinary-significance proposal
        // is a bulk approval target; the major one is not (r3-significance).
        assertBulkApprovalJudgement(initial.proposals, {
          eligibleTitle: BULK_APPROVED_PROPOSAL_TITLE,
          ineligibleTitle: EDITED_PROPOSAL_TITLE,
        });

        // Step 2: press "bulk approve" (the button shows 1 target).
        const resultText = await clickEnabledBulkApproveButton({
          harness,
          dialog,
          expectedCount: 1,
        });
        assertBulkApproveResultText(resultText, { approved: 1, remaining: 1 });
        const bulkChild = await harness.waitUntil(async () => {
          const row = (await bundleNow()).proposals.find(
            (entry) => entry.proposalId === bulkParent.proposalId,
          );
          return row?.status === "approved" && row;
        }, "Native records the bulk approval");
        assertBulkApprovedChild(bulkParent, bulkChild);
        const afterBulk = await bundleNow();
        const afterBulkNative = await inspectEditedNative(
          harness,
          review.page,
          afterBulk,
          sceneId,
        );
        assert.equal(afterBulkNative.revisions.length, 3);
        assert.equal(afterBulkNative.events.length, 0);
        assert.equal(afterBulkNative.applications.length, 0);
        assertHumanDerivedLineage(
          afterBulkNative.revisions.find(
            (row) => row.revisionId === bulkRootRevisionId,
          ),
          afterBulkNative.revisions.find(
            (row) => row.revisionId === bulkChild.currentRevisionId,
          ),
        );
        assertBulkApprovalLeftUntouched(
          parent,
          afterBulk.proposals.find(
            (row) => row.proposalId === parent.proposalId,
          ),
        );
        assert.equal(
          afterBulkNative.revisions.filter(
            (row) => row.proposalId === parent.proposalId,
          ).length,
          1,
          "the proposal outside the bulk approval gained no revision",
        );
        assertNoBulkApprovalTargets(afterBulk.proposals);
        await assertBulkApproveButtonIdle({ harness, dialog });
        const afterBulkState = await readRunAndDecisions(
          harness,
          review.page,
          identity,
          afterBulk.proposals.map((row) => row.proposalId),
        );
        assert.equal(afterBulkState.decisions.length, 1);
        assertSameApprovalActor(afterBulkState.decisions, {
          projectId,
          proposals: [bulkChild],
        });
        // The bulk-approved revision meets every readable IR precondition; the
        // untouched one is neither approved nor secret-free.
        const bulkIrReadings = readIrAdmissionPreconditions({
          projectId,
          sceneId,
          bundle: afterBulk,
          revisions: afterBulkNative.revisions,
          decisions: afterBulkState.decisions,
          run: afterBulkState.run,
        });
        assert.deepEqual(
          bulkIrReadings.find((row) => row.proposalId === bulkParent.proposalId)
            .failures,
          [],
        );
        assert.deepEqual(
          bulkIrReadings.find((row) => row.proposalId === parent.proposalId)
            .failures,
          ["RevisionNotCurrentHumanApproved", "Secret"],
        );
        bulkApproved = [
          {
            proposalId: bulkParent.proposalId,
            rootRevisionId: bulkRootRevisionId,
            childRevisionId: bulkChild.currentRevisionId,
          },
        ];
        harness.recordTimeline(`${ID}/bulk-approved`, {
          ...identity,
          bulkApproved,
          irReadings: bulkIrReadings,
          evidence: await saveChronicleEvidence(directory, "bulk-approved", {
            bundle: afterBulk,
            native: afterBulkNative,
            decisions: afterBulkState.decisions,
            irReadings: bulkIrReadings,
            resultText,
            bulkApproved,
          }),
        });

        // Step 3: edit the proposal that stays (secret off) in the review UI.
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
        assert.equal(afterEditNative.revisions.length, 4);
        assert.equal(afterEditNative.events.length, 0);
        assert.equal(afterEditNative.applications.length, 0);
        assertHumanDerivedLineage(
          afterEditNative.revisions.find(
            (row) => row.revisionId === rootRevisionId,
          ),
          afterEditNative.revisions.find(
            (row) => row.revisionId === child.currentRevisionId,
          ),
        );
        // The edit did not touch the bulk-approved proposal.
        const bulkAfterEdit = afterEdit.proposals.find(
          (row) => row.proposalId === bulkParent.proposalId,
        );
        assert.equal(
          bulkAfterEdit.currentRevisionId,
          bulkChild.currentRevisionId,
        );
        assert.equal(bulkAfterEdit.status, "approved");
        assert.equal(
          afterEdit.proposals.find(
            (row) => row.proposalId === parent.proposalId,
          ).status,
          "unreviewed",
        );
        assert.equal(
          afterEdit.proposals.find(
            (row) => row.proposalId === parent.proposalId,
          ).latestDecision,
          null,
        );
        edited = {
          proposalId: parent.proposalId,
          rootRevisionId,
          childRevisionId: child.currentRevisionId,
        };
        harness.recordTimeline(`${ID}/edited`, {
          ...identity,
          ...edited,
          evidence: await saveChronicleEvidence(directory, "edited", {
            bundle: afterEdit,
            native: afterEditNative,
            edited,
          }),
        });

        // Step 4: approve the edited proposal on its child revision, one by
        // one. The bulk-approved proposal is already approved: no button.
        for (const proposal of afterEdit.proposals) {
          if (proposal.proposalId === bulkParent.proposalId) continue;
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
        assert.equal(approvedNative.revisions.length, 4);
        for (const proposal of approved.proposals) {
          const decision = proposal.latestDecision;
          assert.equal(decision?.decision, "approved");
          assert.equal(decision.actorKind, "human");
          assert.equal(decision.revisionId, proposal.currentRevisionId);
        }
        assert.equal(
          approved.proposals.find((row) => row.proposalId === edited.proposalId)
            .currentRevisionId,
          edited.childRevisionId,
          "approval did not move the edited proposal off its child revision",
        );
        assert.equal(
          approved.proposals.find(
            (row) => row.proposalId === bulkParent.proposalId,
          ).currentRevisionId,
          bulkChild.currentRevisionId,
          "nothing moved the bulk-approved proposal off its child revision",
        );
        // Both approvals (bulk and one by one) carry the same author actor, and
        // both revisions are secret-free and approved: every readable IR
        // precondition holds for both.
        const approvedState = await readRunAndDecisions(
          harness,
          review.page,
          identity,
          approved.proposals.map((row) => row.proposalId),
        );
        assertSameApprovalActor(approvedState.decisions, {
          projectId,
          proposals: approved.proposals,
        });
        const approvedIrReadings = readIrAdmissionPreconditions({
          projectId,
          sceneId,
          bundle: approved,
          revisions: approvedNative.revisions,
          decisions: approvedState.decisions,
          run: approvedState.run,
        });
        assert.equal(approvedIrReadings.length, 2);
        for (const reading of approvedIrReadings) {
          assert.deepEqual(reading.failures, [], "IR preconditions hold");
        }
        const approvedCompanion = await readChronicleSynthesisCompanion(
          harness,
          review.page,
          approved,
        );
        assert.deepEqual(approvedCompanion, initialSynthesisCompanion);
        harness.recordTimeline(`${ID}/approved`, {
          ...identity,
          evidence: await saveChronicleEvidence(directory, "approved", {
            bundle: approved,
            persistedSynthesisCompanion: approvedCompanion,
            native: approvedNative,
            decisions: approvedState.decisions,
            irReadings: approvedIrReadings,
          }),
        });

        // Step 5: the apply button must be open for a set that contains an
        // edited (human-derived) revision (E8); then apply.
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
          bulkApproved,
        });
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
          bulkApproved,
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
