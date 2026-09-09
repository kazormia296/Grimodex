import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { generateNKeysBetween } from "fractional-indexing";
import { configureWorkspace } from "../../electron/scripts/product-journeys.mjs";
import { createProductJourneyHarness } from "../../electron/scripts/product-journey-harness.mjs";
import {
  showChronicleFixturePanel,
  waitForChronicleFixtureWorkspace,
} from "../../electron/scripts/chronicle-extraction-product-journey.mjs";
import {
  assertInitialProposals,
  assertUnreviewedChild,
  assertExplicitChildApproval,
  assertScopeOverrideLineage,
  assertColdReviewBundle,
} from "../../electron/scripts/nir1-reviewed-child-evidence.mjs";
import { loadContract, sha256 } from "./nir1-retrieval/contract.mjs";
import { loadRecoveryWorkload } from "./nir1-retrieval/recovery-workload.mjs";
import {
  assertCorpusInterpretation,
  assertSetupRoster,
  assertSetupReadingOrder,
} from "./nir1-retrieval/setup-evidence.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const [output, buildReceiptPath, workloadPath] = process.argv.slice(2);
assert.ok(
  output &&
    path.isAbsolute(output) &&
    buildReceiptPath &&
    path.isAbsolute(buildReceiptPath),
  "usage: node scripts/quality/setup-nir1-recovery.mjs <new absolute output> <archived standard build receipt> <frozen workload path>",
);
await mkdir(output);
const save = (file, value) =>
  writeFile(path.join(output, file), JSON.stringify(value, null, 2) + "\n");
const hashFile = async (file) => sha256(await readFile(file));
async function hostCapture() {
  const read = async (file) => readFile(file, "utf8").catch(() => null);
  return {
    at: new Date().toISOString(),
    cpuModel: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    loadAverage: os.loadavg(),
    freeMemory: os.freemem(),
    cpuPressure: await read("/proc/pressure/cpu"),
    ioPressure: await read("/proc/pressure/io"),
    processIo: await read(`/proc/${process.pid}/io`),
  };
}
const contract = await loadContract(root, { requireFreeze: true });
assert.ok(workloadPath && path.isAbsolute(workloadPath));
const { workload, freezePath: workloadFreezePath } =
  await loadRecoveryWorkload(workloadPath);
assert.equal(workload.schemaVersion, "nir1-recovery-normal-setup/1");
assert.equal(workload.currentRevisionCount, 100);
assert.equal(workload.scenes.length, 100);
assert.equal(new Set(workload.scenes.map((scene) => scene.id)).size, 100);
assert.equal(workload.canonicalManifestSha256, contract.digests.manifestSha256);
assert.equal(workload.canonicalCorpusSha256, contract.digests.corpusSha256);
for (const scene of workload.scenes) {
  const template = contract.corpus.languages[workload.language].scenes.find(
    (row) => row.id === workload.sourceTemplateId,
  );
  assert.ok(template?.interpretationSeed);
  assert.equal(scene.body, template.body);
  assert.deepEqual(scene.interpretationSeed, template.interpretationSeed);
}
const queries = [workload.query];
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
const artifactPaths = Object.keys(build.artifacts);
for (const required of [
  "dist/index.html",
  "dist-electron/main.cjs",
  "dist-electron/preload.cjs",
  "electron/native/grimodex-node/grimodex-node.node",
])
  assert.ok(artifactPaths.includes(required));
assert.equal(await hashFile(build.sourceManifest), build.sourceManifestSha256);
const builtSources = JSON.parse(await readFile(build.sourceManifest, "utf8"));
for (const file of [
  "electron/main/productJourneyNir1Ai.ts",
  "electron/main/productJourneyChronicleAi.ts",
  "evals/nir1-retrieval/corpus.json",
])
  assert.equal(
    await hashFile(path.join(root, file)),
    builtSources[file],
    `built source: ${file}`,
  );
async function verifyArtifacts() {
  for (const file of artifactPaths)
    assert.equal(
      await hashFile(path.join(root, file)),
      build.artifacts[file],
      `standard artifact: ${file}`,
    );
}
await verifyArtifacts();
const ownPaths = [
  "scripts/quality/setup-nir1-recovery.mjs",
  "evals/nir1-retrieval/recovery-workload.json",
  "evals/nir1-retrieval/recovery-workload.freeze.json",
  "evals/nir1-retrieval/recovery-workload-v2.json",
  "evals/nir1-retrieval/recovery-workload-v2.freeze.json",
  "scripts/quality/nir1-retrieval/recovery-workload.mjs",
  "scripts/quality/nir1-retrieval/setup-evidence.mjs",
  "electron/main/productJourneyNir1Ai.ts",
  "electron/main/productJourneyChronicleAi.ts",
  "evals/nir1-retrieval/corpus.json",
  "electron/scripts/product-journeys.mjs",
  "electron/scripts/product-journey-harness.mjs",
  "electron/scripts/chronicle-extraction-product-journey.mjs",
  "electron/scripts/nir1-reviewed-child-evidence.mjs",
];
const sourceDigests = Object.fromEntries(
  await Promise.all(
    ownPaths.map(async (file) => [file, await hashFile(path.join(root, file))]),
  ),
);
const receipt = {
  schemaVersion: "nir1-recovery-setup/1",
  archivedBuildProvenance: true,
  currentWipSourceMatchesArchivedBuild: false,
  workloadPath,
  recoveryProbeVersion:
    workload.recoveryProbeVersion ?? "nir1-recovery-normal-setup/1",
  workloadSha256: await hashFile(workloadPath),
  workloadFreezePath,
  workloadFreezeSha256: await hashFile(workloadFreezePath),
  status: "blocked",
  diagnosticOnly: true,
  normalPlannerUi: true,
  searchEligibility: "not-evaluated",
  qualityAcceptance: false,
  contract: contract.digests,
  buildReceiptPath,
  buildReceiptSha256: await hashFile(buildReceiptPath),
  buildArtifacts: build.artifacts,
  sourceDigests,
  requestedQueries: queries.map((query) => query.id),
  startedAt: new Date().toISOString(),
  hostBefore: await hostCapture(),
  cases: [],
  errors: [],
};
let harness;
const writeContext = () => ({
  requestId: randomUUID(),
  sessionId: "nir1-corpus-setup",
  eventUid: randomUUID(),
  origin: "human",
  authorityRoute: "human-direct",
  caller: "human-ui",
  controls: ["field-authority"],
  provenance: null,
  writesAuthorityProtectedField: false,
  originalTransactionId: null,
  undoJournalId: null,
});
const rows = async (page, sql, params = []) =>
  (await harness.invokeOk(page, "db_execute", { sql, params, method: "all" }))
    .rows;
const bundle = (page, identity) =>
  harness.invokeOk(page, "narrative_extraction_get_run_review_bundle", {
    payload: identity,
  });
async function revision(page, id) {
  const result = await rows(
    page,
    "SELECT id AS revisionId, proposal_id AS proposalId, reconciliation_envelope_json AS envelopeJson, reconciliation_envelope_digest AS envelopeDigest, payload_json AS payloadJson FROM narrative_proposal_revisions WHERE id = ?",
    [id],
  );
  assert.equal(result.length, 1);
  const { envelopeJson, payloadJson, ...rest } = result[0];
  return {
    ...rest,
    envelope: JSON.parse(envelopeJson),
    payloadJson: JSON.parse(payloadJson),
  };
}
async function analyze(
  page,
  dialog,
  projectId,
  expectedSceneId,
  caseDirectory,
) {
  const runSql =
    "SELECT id AS runId FROM narrative_extraction_runs WHERE project_id = ? AND surface_path_id = 'chronicle.extract'";
  const before = new Set(
    (await rows(page, runSql, [projectId])).map((row) => row.runId),
  );
  await dialog.getByRole("button", { name: "解析", exact: true }).click();
  let identity;
  let lastState;
  const state = await harness.waitUntil(
    async () => {
      const runs = (await rows(page, runSql, [projectId])).filter(
        (row) => !before.has(row.runId),
      );
      if (runs.length === 0) return false;
      if (runs.length !== 1)
        return { error: "unexpected extraction run count" };
      identity = { projectId, runId: runs[0].runId };
      lastState = await harness.invokeOk(page, "narrative_extraction_get_run", {
        payload: identity,
      });
      const failed = lastState.tasks.find((task) => task.status === "failed");
      if (failed || ["failed", "cancelled"].includes(lastState.run.status))
        return { error: failed?.errorMessage ?? lastState.run.status };
      return (await dialog
        .locator('[data-testid^="chronicle-proposal-card-"]')
        .count()) === 1
        ? { identity }
        : false;
    },
    `one normal proposal for ${expectedSceneId}`,
    60000,
  );
  await writeFile(
    path.join(caseDirectory, `${expectedSceneId}-run.json`),
    JSON.stringify(lastState, null, 2) + "\n",
  );
  assert.ok(!state.error, state.error);
  return state.identity;
}
let success = false;
try {
  for (const query of queries) {
    await verifyArtifacts();
    // Each query owns its process profile as well as its DB. Reusing the old
    // profile can let startup auto-open race the next case's configuration.
    harness = createProductJourneyHarness({
      mainCjs: path.join(root, "dist-electron/main.cjs"),
      artifactRoot: output,
    });
    await mkdir(harness.userDataDir, { recursive: true });
    await writeFile(
      path.join(harness.userDataDir, "legacy-keyring-migration-v1.json"),
      JSON.stringify({
        version: 1,
        completedAt: new Date().toISOString(),
        imported: 0,
        skippedExisting: 0,
        fixtureOnly: true,
      }),
    );
    const scenes = workload.scenes;
    const targets = scenes.filter((scene) => scene.interpretationSeed);
    const workspace = harness.workspacePath(query.id);
    const caseDirectory = path.join(output, query.id);
    await mkdir(caseDirectory);
    await configureWorkspace(harness, workspace, { deterministicAi: true });
    const seeded = await harness.launch(`${query.id}/seed`);
    let projectId;
    let sourceRows;
    const folders = {};
    try {
      projectId = await harness.waitUntil(
        async () =>
          (
            await rows(
              seeded.page,
              "SELECT id FROM projects ORDER BY created_at,id LIMIT 1",
            )
          )[0]?.id,
        "isolated fixture project",
      );
      assert.equal(
        (
          await rows(
            seeded.page,
            "SELECT id FROM tree_nodes WHERE project_id = ?",
            [projectId],
          )
        ).length,
        0,
      );
      const project = (
        await rows(
          seeded.page,
          "SELECT updated_at AS updatedAt FROM projects WHERE id = ?",
          [projectId],
        )
      )[0];
      await harness.invokeOk(seeded.page, "project_patch", {
        payload: {
          ...writeContext(),
          projectId,
          baseUpdatedAt: project.updatedAt,
          updatedAt: new Date().toISOString(),
          patch: { language: query.language, phaseResolutionMode: "reading" },
        },
      });
      const sorted = [
        ...scenes,
        {
          id: query.currentSceneId,
          title: "Current query scene",
          body: query.currentBody,
          order: query.currentOrder,
        },
      ].sort((a, b) => a.order - b.order);
      const keys = generateNKeysBetween(null, null, sorted.length);
      const create = (node) =>
        harness.invokeOk(seeded.page, "tree_node_create", {
          payload: { ...writeContext(), projectId, status: "draft", ...node },
        });
      for (const [index, scene] of sorted.entries()) {
        if (scene.interpretationSeed) {
          folders[scene.id] = `nir1-folder-${scene.id}`;
          await create({
            id: folders[scene.id],
            parentId: null,
            nodeType: "folder",
            title: scene.title,
            sortOrder: keys[index],
            content: null,
          });
        }
        await create({
          id: scene.id,
          parentId: folders[scene.id] ?? null,
          nodeType: "scene",
          title: scene.title,
          sortOrder: folders[scene.id] ? "a0" : keys[index],
          content: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: scene.body }],
              },
            ],
          }),
        });
      }
      sourceRows = await rows(
        seeded.page,
        "SELECT id, parent_id AS parentId, sort_order AS sortOrder, story_time_order AS storyTimeOrder, content FROM tree_nodes WHERE project_id = ? AND node_type = 'scene'",
        [projectId],
      );
      assertSetupRoster(scenes, query, sourceRows);
      assertSetupReadingOrder(
        scenes,
        query,
        await rows(
          seeded.page,
          "SELECT id,parent_id AS parentId,sort_order AS sortOrder,node_type AS nodeType FROM tree_nodes WHERE project_id = ?",
          [projectId],
        ),
      );
      assert.equal(
        (await rows(seeded.page, "SELECT id FROM narrative_proposal_revisions"))
          .length,
        0,
      );
    } finally {
      await harness.close(seeded.app, seeded.page, `${query.id}/seed`);
    }
    const reviewed = await harness.launch(`${query.id}/extract-and-review`);
    const generated = [];
    try {
      await waitForChronicleFixtureWorkspace(harness, reviewed.page, {
        projectId,
        sceneId: query.currentSceneId,
      });
      await showChronicleFixturePanel(reviewed.page);
      await reviewed.page.getByTitle("AI 抽出", { exact: true }).click();
      const dialog = reviewed.page.getByRole("dialog");
      for (const scene of targets) {
        await dialog.locator("select").selectOption(folders[scene.id]);
        const identity = await analyze(
          reviewed.page,
          dialog,
          projectId,
          scene.id,
          caseDirectory,
        );
        const initial = await bundle(reviewed.page, identity);
        assertInitialProposals(initial.proposals, 1);
        const parent = initial.proposals[0];
        const rootRevision = await revision(
          reviewed.page,
          parent.currentRevisionId,
        );
        assertCorpusInterpretation(initial, rootRevision, scene);
        await writeFile(
          path.join(caseDirectory, `${scene.id}-initial.json`),
          JSON.stringify(initial, null, 2) + "\n",
        );
        const card = dialog.getByTestId(
          `chronicle-proposal-card-${parent.proposalId}`,
        );
        await card.getByRole("button").first().click();
        const checkbox = dialog.getByTestId("chronicle-proposal-secret-input");
        assert.equal(await checkbox.isChecked(), true);
        await checkbox.click();
        const child = await harness.waitUntil(async () => {
          const row = (await bundle(reviewed.page, identity)).proposals[0];
          return (
            row.currentRevisionId !== parent.currentRevisionId &&
            row.payloadJson.disclosure.secret === false &&
            row
          );
        }, "nonsecret current child saved");
        await harness.waitUntil(
          async () => !(await checkbox.isChecked()),
          "nonsecret checkbox settled",
        );
        assertUnreviewedChild(parent, child);
        const childRevision = await revision(
          reviewed.page,
          child.currentRevisionId,
        );
        assertScopeOverrideLineage(rootRevision, childRevision);
        await card.getByRole("button", { name: "承認", exact: true }).click();
        const approved = await harness.waitUntil(async () => {
          const row = (await bundle(reviewed.page, identity)).proposals[0];
          return row.latestDecision?.decision === "approved" && row;
        }, "current child's explicit own Decision");
        assertExplicitChildApproval(child, approved, projectId);
        const after = await bundle(reviewed.page, identity);
        assert.deepEqual(after.artifacts, initial.artifacts);
        assert.deepEqual(after.stageReceipts, initial.stageReceipts);
        assert.deepEqual(
          await revision(reviewed.page, rootRevision.revisionId),
          rootRevision,
        );
        await writeFile(
          path.join(caseDirectory, `${scene.id}-approved.json`),
          JSON.stringify(
            { bundle: after, rootRevision, childRevision },
            null,
            2,
          ) + "\n",
        );
        generated.push({
          sceneId: scene.id,
          identity,
          rootRevision,
          childRevision,
          approved,
          bundle: after,
        });
        process.stdout.write(
          `NIR-1 setup ${query.id}: ${generated.length}/${targets.length} normal approved children\n`,
        );
      }
      await dialog.screenshot({
        path: path.join(caseDirectory, "approved-review.png"),
      });
    } finally {
      await harness.close(
        reviewed.app,
        reviewed.page,
        `${query.id}/extract-and-review`,
      );
    }
    const cold = await harness.launch(`${query.id}/cold-reopen`);
    try {
      await waitForChronicleFixtureWorkspace(harness, cold.page, {
        projectId,
        sceneId: query.currentSceneId,
      });
      assertSetupRoster(
        scenes,
        query,
        await rows(
          cold.page,
          "SELECT id,story_time_order AS storyTimeOrder,content FROM tree_nodes WHERE project_id = ? AND node_type = 'scene'",
          [projectId],
        ),
      );
      assertSetupReadingOrder(
        scenes,
        query,
        await rows(
          cold.page,
          "SELECT id,parent_id AS parentId,sort_order AS sortOrder,node_type AS nodeType FROM tree_nodes WHERE project_id = ?",
          [projectId],
        ),
      );
      for (const item of generated)
        assertColdReviewBundle(
          item.bundle,
          await bundle(cold.page, item.identity),
        );
    } finally {
      await harness.close(cold.app, cold.page, `${query.id}/cold-reopen`);
    }
    await cp(workspace, path.join(caseDirectory, "cold-workspace"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    assert.equal(generated.length, workload.currentRevisionCount);
    assert.equal(
      new Set(generated.map((item) => item.childRevision.revisionId)).size,
      100,
    );
    const caseReceipt = {
      currentRevisionCount: generated.length,
      ancestorRevisionCountExcluded: true,
      status: "setup-complete",
      queryId: query.id,
      language: query.language,
      projectId,
      currentSceneId: query.currentSceneId,
      sourceRows,
      folders,
      runtimeMembership: "not-evaluated",
      searchEligibility: "not-evaluated",
      normalApprovedChildren: generated.map(
        ({ sceneId, identity, rootRevision, childRevision, approved }) => ({
          sceneId,
          ...identity,
          rootRevisionId: rootRevision.revisionId,
          revisionId: childRevision.revisionId,
          envelopeDigest: childRevision.envelopeDigest,
          decisionId: approved.latestDecision.decisionId,
        }),
      ),
      coldDatabaseSha256: await hashFile(
        path.join(caseDirectory, "cold-workspace/grimodex.db"),
      ),
    };
    await writeFile(
      path.join(caseDirectory, "setup.json"),
      JSON.stringify(caseReceipt, null, 2) + "\n",
    );
    receipt.cases.push({
      queryId: query.id,
      setupPath: path.join(caseDirectory, "setup.json"),
      setupSha256: await hashFile(path.join(caseDirectory, "setup.json")),
      hostAfter: await hostCapture(),
    });
    await save("receipt.in-progress.json", receipt);
    await verifyArtifacts();
    for (const [file, digest] of Object.entries(sourceDigests))
      assert.equal(await hashFile(path.join(root, file)), digest);
    await harness.dispose({ success: true, name: query.id });
  }
  await verifyArtifacts();
  for (const [file, digest] of Object.entries(sourceDigests))
    assert.equal(await hashFile(path.join(root, file)), digest);
  receipt.status = "setup-complete";
  success = true;
} catch (error) {
  receipt.errors.push(error.stack ?? String(error));
  throw error;
} finally {
  receipt.finishedAt = new Date().toISOString();
  receipt.hostAfter = await hostCapture();
  await save("receipt.json", receipt);
  await harness?.dispose({ success, name: "nir1-corpus-setup" });
}
