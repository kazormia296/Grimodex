// Chronicle extraction -> human edit of one proposal (secret off) -> approve all
// -> apply -> restart. Same fixed provider response and workspace as
// chronicle-extract-review-apply-reopen; the one extra operation is the edit,
// which Native records as a human-derived child revision (ERA/1, DR-ERA-12).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { URL } from "node:url";
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
const TITLES = ["門が開いた", "鐘が鳴った"];

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
 * its application points at.
 */
export function assertEditedChronicleApplied(
  state,
  bundle,
  { sceneId, editedProposalId, rootRevisionId },
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
    if (proposal.proposalId === editedProposalId) {
      assert.notEqual(proposal.currentRevisionId, rootRevisionId);
      assert.equal(
        appliedRevision.envelope.revisionBasis.kind,
        "human-derived",
      );
      assert.equal(proposal.payloadJson.disclosure.secret, false);
      const root = state.revisions.find(
        (row) => row.revisionId === rootRevisionId,
      );
      assert.ok(root, "the edited proposal's root revision is stored");
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

async function inspectEditedNative(harness, page, bundle, sceneId) {
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

        // Step 1: edit one proposal in the review UI.
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
        assert.equal(afterEditNative.applications.length, 0);
        assertHumanDerivedLineage(
          afterEditNative.revisions.find(
            (row) => row.revisionId === rootRevisionId,
          ),
          afterEditNative.revisions.find(
            (row) => row.revisionId === child.currentRevisionId,
          ),
        );
        for (const proposal of afterEdit.proposals) {
          assert.equal(proposal.status, "unreviewed");
          assert.equal(proposal.latestDecision, null);
        }
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

        // Step 2: approve every proposal, the edited one on its child revision.
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
          }),
        });

        // Step 3: the apply button must be open for a set that contains an
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
