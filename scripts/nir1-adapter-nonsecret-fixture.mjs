// Diagnostic Adapter input only, never a normal-planner E2E acceptance test.
// Build-time transform operates in memory before first Proposal persistence.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { configureWorkspace } from "../electron/scripts/product-journeys.mjs";
import { createProductJourneyHarness } from "../electron/scripts/product-journey-harness.mjs";
import {
  showChronicleFixturePanel,
  waitForChronicleFixtureWorkspace,
  analyzeChronicleAndWaitForProposals,
} from "../electron/scripts/chronicle-extraction-product-journey.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const [seedDirectory, output] = process.argv.slice(2);
assert.ok(
  seedDirectory &&
    output &&
    path.isAbsolute(seedDirectory) &&
    path.isAbsolute(output),
  "usage: node scripts/nir1-adapter-nonsecret-fixture.mjs <absolute-seed-directory> <new-absolute-output-directory>",
);
await mkdir(output);
const sha = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const seed = JSON.parse(
  await readFile(path.join(seedDirectory, "seed.json"), "utf8"),
);
const seedDb = path.join(seedDirectory, "cold-seed-workspace/grimodex.db");
const seedDigest = await sha(seedDb);
const coordinator = path.join(
  root,
  "src/application/narrative-extraction/extractionCoordinator.ts",
);
const coordinatorDigest = await sha(coordinator);
const anchor =
  "      const proposals = planned.map((entry) => entry.proposal);";
const injection = `      // NIR1 diagnostic input: no saved revision or model receipt is edited.
      for (const entry of planned) {
        entry.proposal.disclosure = { ...entry.proposal.disclosure, secret: false };
      }
${anchor}`;
let transformations = 0;
await build({
  root,
  configFile: path.join(root, "vite.config.ts"),
  build: { outDir: path.join(output, "dist"), emptyOutDir: false },
  plugins: [
    {
      name: "nir1-diagnostic-presave-nonsecret-input",
      enforce: "pre",
      transform(code, id) {
        if (id !== coordinator) return null;
        assert.equal(
          code.split(anchor).length,
          2,
          "one exact pre-save input seam",
        );
        transformations += 1;
        return { code: code.replace(anchor, injection), map: null };
      },
    },
  ],
});
assert.equal(transformations, 1);
assert.equal(await sha(coordinator), coordinatorDigest);
await cp(path.join(root, "dist-electron"), path.join(output, "dist-electron"), {
  recursive: true,
});
await symlink(
  path.join(root, "node_modules"),
  path.join(output, "node_modules"),
  "dir",
);
await symlink(
  path.join(root, "electron"),
  path.join(output, "electron"),
  "dir",
);
const harness = createProductJourneyHarness({
  mainCjs: path.join(output, "dist-electron/main.cjs"),
  artifactRoot: output,
});
const name = "nir1-adapter-nonsecret";
const workspace = harness.workspacePath(name);
let success = false;
try {
  await cp(path.join(seedDirectory, "cold-seed-workspace"), workspace, {
    recursive: true,
  });
  await configureWorkspace(harness, workspace, { deterministicAi: true });
  const launched = await harness.launch(name);
  let identity;
  let initial;
  let approved;
  const bundle = (page) =>
    harness.invokeOk(page, "narrative_extraction_get_run_review_bundle", {
      payload: identity,
    });
  try {
    await waitForChronicleFixtureWorkspace(harness, launched.page, {
      projectId: seed.projectId,
      sceneId: seed.s1,
    });
    await showChronicleFixturePanel(launched.page);
    await launched.page.getByTitle("AI 抽出", { exact: true }).click();
    const dialog = launched.page.getByRole("dialog");
    await dialog.locator("select").selectOption(seed.folderId);
    identity = await analyzeChronicleAndWaitForProposals({
      harness,
      page: launched.page,
      dialog,
      projectId: seed.projectId,
      directory: output,
    });
    initial = await bundle(launched.page);
    await writeFile(
      path.join(output, "initial.json"),
      JSON.stringify(initial, null, 2) + "\n",
    );
    assert.equal(initial.proposals.length, 2);
    for (const proposal of initial.proposals) {
      assert.equal(proposal.payloadJson.disclosure.secret, false);
      const card = dialog.getByTestId(
        `chronicle-proposal-card-${proposal.proposalId}`,
      );
      await card.getByRole("button", { name: "承認", exact: true }).click();
      await harness.waitUntil(
        async () =>
          (await bundle(launched.page)).proposals.find(
            (row) => row.proposalId === proposal.proposalId,
          )?.latestDecision?.decision === "approved",
        "explicit durable approval",
      );
    }
    approved = await bundle(launched.page);
    await writeFile(
      path.join(output, "approved.json"),
      JSON.stringify(approved, null, 2) + "\n",
    );
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
    assert.deepEqual(cold.proposals, approved.proposals);
    assert.deepEqual(cold.stageReceipts, initial.stageReceipts);
    await writeFile(
      path.join(output, "reopened.json"),
      JSON.stringify(cold, null, 2) + "\n",
    );
  } finally {
    await harness.close(reopened.app, reopened.page, `${name}/cold-reopen`);
  }
  await cp(workspace, path.join(output, "cold-workspace"), { recursive: true });
  assert.equal(await sha(seedDb), seedDigest);
  assert.equal(await sha(coordinator), coordinatorDigest);
  await writeFile(
    path.join(output, "fixture.json"),
    JSON.stringify(
      {
        diagnosticOnly: true,
        label:
          "S1-only extraction evidence bound nonsecret Adapter diagnostic fixture",
        normalPlannerE2e: false,
        admission: "not-evaluated",
        disclosurePolicyRef: null,
        ...identity,
        s1: seed.s1,
        s2: seed.s2,
        folderId: seed.folderId,
        seedDatabaseDigest: seedDigest,
        databaseDigest: await sha(
          path.join(output, "cold-workspace/grimodex.db"),
        ),
        coordinatorSourceDigest: coordinatorDigest,
        diagnosticTransform: { anchor, injection, transformations },
        producerMainDigest: await sha(
          path.join(output, "dist-electron/main.cjs"),
        ),
        producerNativeDigest: await sha(
          path.join(root, "electron/native/grimodex-node/grimodex-node.node"),
        ),
        revisionIds: approved.proposals.map((row) => row.currentRevisionId),
      },
      null,
      2,
    ) + "\n",
  );
  success = true;
} finally {
  await harness.dispose({ success, name });
}
