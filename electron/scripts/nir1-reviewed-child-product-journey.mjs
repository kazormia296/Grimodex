// Normal planner and Human review UI fixture. The existing local deterministic
// provider supplies synthetic model responses; this is not model-quality proof.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configureWorkspace } from "./product-journeys.mjs";
import { createProductJourneyHarness } from "./product-journey-harness.mjs";
import {
  showChronicleFixturePanel,
  waitForChronicleFixtureWorkspace,
  analyzeChronicleAndWaitForProposals,
} from "./chronicle-extraction-product-journey.mjs";
import {
  assertInitialProposals,
  assertUnreviewedChild,
  assertExplicitChildApproval,
  assertColdReviewBundle,
  assertScopeOverrideLineage,
} from "./nir1-reviewed-child-evidence.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const [seedDirectory, output, buildReceiptPath] = process.argv.slice(2);
assert.ok(
  [seedDirectory, output, buildReceiptPath].every(
    (value) => value && path.isAbsolute(value),
  ),
  "usage: node electron/scripts/nir1-reviewed-child-product-journey.mjs <absolute-seed-directory> <new-absolute-output-directory> <absolute-standard-build-receipt>",
);
await mkdir(output); // A saved fixture is never overwritten.
const sha = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const save = (name, data) =>
  writeFile(path.join(output, name), JSON.stringify(data, null, 2) + "\n");
const action = (data) =>
  appendFile(
    path.join(output, "ui-actions.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), ...data }) + "\n",
  );
const build = JSON.parse(await readFile(buildReceiptPath, "utf8"));
assert.equal(build.root, root);
assert.equal(build.standardBuild, true);
assert.equal(build.sourceUnchanged, true);
assert.deepEqual(
  build.commands.map(({ argv, exitCode }) => ({ argv, exitCode })),
  [
    { argv: ["pnpm", "napi:build"], exitCode: 0 },
    { argv: ["pnpm", "electron:build"], exitCode: 0 },
  ],
);
assert.equal(await sha(build.sourceManifest), build.sourceManifestSha256);
const sources = JSON.parse(await readFile(build.sourceManifest, "utf8"));
async function verifyProducer() {
  for (const [file, expected] of Object.entries({
    ...sources,
    ...build.artifacts,
  })) {
    assert.equal(
      await sha(path.join(root, file)),
      expected,
      `standard build correspondence: ${file}`,
    );
  }
}
await verifyProducer();
const runnerPaths = [
  "electron/scripts/nir1-reviewed-child-product-journey.mjs",
  "electron/scripts/nir1-reviewed-child-evidence.mjs",
  "scripts/nir1-reviewed-child-product-journey.test.mjs",
];
const runnerDigests = Object.fromEntries(
  await Promise.all(
    runnerPaths.map(async (file) => [file, await sha(path.join(root, file))]),
  ),
);
const seed = JSON.parse(
  await readFile(path.join(seedDirectory, "seed.json"), "utf8"),
);
const seedDb = path.join(seedDirectory, "cold-seed-workspace/grimodex.db");
const seedDigest = await sha(seedDb);
assert.equal(seedDigest, seed.databaseDigest);
assert.equal(
  seed.producerMainDigest,
  build.artifacts["dist-electron/main.cjs"],
);
await save("producer.json", {
  buildReceiptPath,
  buildReceiptSha256: await sha(buildReceiptPath),
  runnerDigests,
});
const harness = createProductJourneyHarness({
  mainCjs: path.join(root, "dist-electron/main.cjs"),
  artifactRoot: output,
});
const name = "nir1-reviewed-child";
const workspace = harness.workspacePath(name);
let success = false;
let identity;
const bundle = (page) =>
  harness.invokeOk(page, "narrative_extraction_get_run_review_bundle", {
    payload: identity,
  });
async function revision(page, revisionId) {
  const { rows } = await harness.invokeOk(page, "db_execute", {
    sql: "SELECT id AS revisionId, proposal_id AS proposalId, revision_number AS revisionNumber, payload_json AS payloadJson, origin_kind AS originKind, reconciliation_envelope_json AS envelopeJson, reconciliation_envelope_digest AS envelopeDigest, created_at AS createdAt, created_by AS createdBy FROM narrative_proposal_revisions WHERE id = ?",
    params: [revisionId],
    method: "all",
  });
  assert.equal(rows.length, 1);
  const { envelopeJson, payloadJson, ...row } = rows[0];
  return {
    ...row,
    envelope: JSON.parse(envelopeJson),
    payloadJson: JSON.parse(payloadJson),
  };
}
try {
  await cp(path.join(seedDirectory, "cold-seed-workspace"), workspace, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  await configureWorkspace(harness, workspace, { deterministicAi: true });
  const launched = await harness.launch(name);
  let initial;
  let approved;
  const lineage = [];
  try {
    await waitForChronicleFixtureWorkspace(harness, launched.page, {
      projectId: seed.projectId,
      sceneId: seed.s1,
    });
    await showChronicleFixturePanel(launched.page);
    await launched.page.getByTitle("AI 抽出", { exact: true }).click();
    const dialog = launched.page.getByRole("dialog");
    await dialog.locator("select").selectOption(seed.folderId);
    await action({
      action: "extract-folder",
      projectId: seed.projectId,
      folderId: seed.folderId,
    });
    identity = await analyzeChronicleAndWaitForProposals({
      harness,
      page: launched.page,
      dialog,
      projectId: seed.projectId,
      directory: output,
    });
    initial = await bundle(launched.page);
    await save("initial.json", initial);
    assertInitialProposals(initial.proposals, 2);
    const snapshots = initial.artifacts.filter(
      (row) => row.artifactKind === "source.snapshot@1",
    );
    assert.equal(snapshots.length, 1);
    assert.deepEqual(
      snapshots[0].payloadJson.snapshot.documents.map(
        (document) => document.sourceKey,
      ),
      [`project:scene:${seed.s1}`],
    );
    assert.equal(
      JSON.stringify(initial).includes("NIR1_S2_MUST_NOT_ENTER_REQUEST"),
      false,
    );
    for (const parent of initial.proposals) {
      const rootRevision = await revision(
        launched.page,
        parent.currentRevisionId,
      );
      assert.equal(rootRevision.envelope.revisionBasis.kind, "interpretation");
      assert.deepEqual(rootRevision.envelope.assertion.scope.scene, {
        kind: "exact",
        ref: `scene:${seed.s1}`,
      });
      const card = dialog.getByTestId(
        `chronicle-proposal-card-${parent.proposalId}`,
      );
      await card.getByRole("button").first().click();
      const checkbox = dialog.getByTestId("chronicle-proposal-secret-input");
      assert.equal(await checkbox.isChecked(), true);
      await action({
        action: "uncheck-secret",
        proposalId: parent.proposalId,
        parentRevisionId: parent.currentRevisionId,
      });
      // This controlled checkbox settles only after Native persists the child.
      // Playwright uncheck() assumes a synchronous checked-state transition.
      await checkbox.click();
      const child = await harness.waitUntil(async () => {
        const row = (await bundle(launched.page)).proposals.find(
          (entry) => entry.proposalId === parent.proposalId,
        );
        return (
          row?.currentRevisionId !== parent.currentRevisionId &&
          row?.payloadJson.disclosure.secret === false &&
          row
        );
      }, "the UI creates the nonsecret current Human child");
      await harness.waitUntil(
        async () => !(await checkbox.isChecked()),
        "the review checkbox reflects the saved nonsecret child",
      );
      await save(`child-${parent.proposalId}.json`, child);
      assertUnreviewedChild(parent, child);
      const childRevision = await revision(
        launched.page,
        child.currentRevisionId,
      );
      assertScopeOverrideLineage(rootRevision, childRevision);
      assert.deepEqual(
        await revision(launched.page, parent.currentRevisionId),
        rootRevision,
      );
      lineage.push({ root: rootRevision, child: childRevision });
      await action({
        action: "approve-current-child",
        proposalId: child.proposalId,
        revisionId: child.currentRevisionId,
      });
      await card.getByRole("button", { name: "承認", exact: true }).click();
      const reviewed = await harness.waitUntil(async () => {
        const row = (await bundle(launched.page)).proposals.find(
          (entry) => entry.proposalId === child.proposalId,
        );
        return row?.latestDecision?.decision === "approved" && row;
      }, "explicit durable Human approval of the child");
      assertExplicitChildApproval(child, reviewed, seed.projectId);
    }
    approved = await bundle(launched.page);
    assert.deepEqual(approved.stageReceipts, initial.stageReceipts);
    assert.deepEqual(approved.artifacts, initial.artifacts);
    await save("approved.json", approved);
    await save("lineage.json", lineage);
    await dialog.screenshot({ path: path.join(output, "approved-review.png") });
  } finally {
    await harness.close(launched.app, launched.page, name);
  }
  const reopened = await harness.launch(`${name}/cold-reopen`);
  try {
    await waitForChronicleFixtureWorkspace(harness, reopened.page, {
      projectId: seed.projectId,
      sceneId: seed.s1,
    });
    const cold = await bundle(reopened.page);
    assertColdReviewBundle(approved, cold);
    for (const pair of lineage) {
      assert.deepEqual(
        await revision(reopened.page, pair.root.revisionId),
        pair.root,
      );
      assert.deepEqual(
        await revision(reopened.page, pair.child.revisionId),
        pair.child,
      );
    }
    await save("reopened.json", cold);
    await action({ action: "cold-reopen-verified", ...identity });
  } finally {
    await harness.close(reopened.app, reopened.page, `${name}/cold-reopen`);
  }
  await cp(workspace, path.join(output, "cold-workspace"), {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  assert.equal(await sha(seedDb), seedDigest);
  await verifyProducer();
  for (const [file, expected] of Object.entries(runnerDigests))
    assert.equal(await sha(path.join(root, file)), expected);
  await save("fixture.json", {
    version: "nir1-reviewed-child-fixture/1",
    diagnosticOnly: true,
    normalPlannerUiJourney: true,
    modelProvider: "existing-local-deterministic-v1",
    runtimeMembership: "not-evaluated",
    searchEligibility: "not-evaluated",
    qualityAcceptance: false,
    ...identity,
    s1: seed.s1,
    s2: seed.s2,
    folderId: seed.folderId,
    seedDatabaseDigest: seedDigest,
    databaseDigest: await sha(path.join(output, "cold-workspace/grimodex.db")),
    rootRevisionIds: lineage.map((pair) => pair.root.revisionId),
    revisionIds: approved.proposals.map((row) => row.currentRevisionId),
    buildReceiptPath,
    buildReceiptSha256: await sha(buildReceiptPath),
    runnerDigests,
  });
  success = true;
  console.log(`Normal reviewed-child cold fixture: ${output}`);
} finally {
  await harness.dispose({ success, name });
}
