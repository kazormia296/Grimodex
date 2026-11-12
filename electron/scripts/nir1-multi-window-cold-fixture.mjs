// Builds the cold database behind narrative_nir1_multi_window_membership.rs and
// the TypeScript golden of three windows (MW/1, DR-MW-7). The normal planner,
// the production extraction path and the Human review UI make every row; the
// deterministic Journey provider (electron/main/productJourneyMultiWindowAi.ts
// with electron/shared/productJourneyMultiWindowFixture.json) only supplies
// response text, like the two-window and reviewed-child fixtures. Nothing here
// writes a Native table directly.
//
// Shapes in ONE project (all bodies are synthetic prose written for this
// fixture; no evaluation text):
//   (A) folder "mw-folder-long": one scene of about 15,000 characters (50 paragraphs of about 300), so the
//       planner cuts it into three windows. Cluster "seal" folds an observation
//       of window 1 with one of window 3; cluster "bell" reads window 2 only.
//   (B) folder "mw-folder-three": three scenes, one window each. Cluster "fire"
//       folds scene 1 with scene 3; cluster "writ" reads scene 2 only.
//   (C) folder "mw-folder-split" (DMS/1): three scenes, one window each.
//       Cluster "dawn" reads scene 1 only. Cluster "tide" holds an actual
//       observation of scene 2 and a PLANNED one of scene 3 (same predicate), so
//       the event cites scene 2 only while its synthesis request read scenes 2
//       and 3: the declared material is {scene 2, scene 3} and the evidence is
//       {scene 2}.
// Around them: a scene before both folders and a scene after all of them.
//
// usage: node electron/scripts/nir1-multi-window-cold-fixture.mjs <new absolute output directory> [name]
// `name` (default nir1-multi-window-cold) is the base name of the output files and
// the manifest's schemaVersion prefix. DMS/1 made the product record each
// proposal's material as the scenes its synthesis request read, so the same
// setup run again with the product of that change is committed as
// `nir1-declared-scope-cold` (the MW/1 database, made when every proposal
// declared every scene of its extraction, stays as the old-form fixture).
// Needs a standard build (pnpm napi:build && pnpm electron:build) of this tree.
// Run it under Xvfb like the product journeys (scripts/local-ci-xvfb.mjs).
// Output: nir1-multi-window-cold.db.gz and .json (copy to
// src-tauri/crates/grimodex-db/tests/support/) and long-golden.json /
// three-golden.json (copy to src-tauri/crates/grimodex-db/src/
// narrative_extraction/material_roster/ as production-multi-window-long-golden.json
// and production-multi-window-folder-golden.json). The committed manifest also
// records each golden's file name and sha256 (for the declared-scope run) and
// the product commit that ran.
// Every run makes new ids, so all of them are replaced together.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { gzipSync } from "node:zlib";
import { configureWorkspace } from "./product-journeys.mjs";
import { createProductJourneyHarness } from "./product-journey-harness.mjs";
import {
  analyzeChronicleAndWaitForProposals,
  createChronicleFixtureNode,
  queryChronicleFixtureRows,
  readChronicleReviewBundle,
  readChronicleSynthesisCompanion,
  showChronicleFixturePanel,
  waitForChronicleFixtureWorkspace,
} from "./chronicle-extraction-product-journey.mjs";
import { setMainLineSceneScopeDefault } from "./chronicle-current-scene-product-journey.mjs";
import {
  assertExplicitChildApproval,
  assertInitialProposals,
  assertUnreviewedChild,
} from "./nir1-reviewed-child-evidence.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const [output, name = "nir1-multi-window-cold"] = process.argv.slice(2);
assert.ok(
  output && path.isAbsolute(output),
  "usage: node electron/scripts/nir1-multi-window-cold-fixture.mjs <new absolute output directory> [name]",
);
const fixture = JSON.parse(
  readFileSync(
    new URL("../shared/productJourneyMultiWindowFixture.json", import.meta.url),
    "utf8",
  ),
);
const marker = (key) => fixture.rows.find((row) => row.key === key).marker;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Ids are stable so the Rust tests and the golden can name them.
const IDS = {
  before: "mw-before",
  folderLong: "mw-folder-long",
  long: "mw-long-scene",
  folderThree: "mw-folder-three",
  three: ["mw-scene-1", "mw-scene-2", "mw-scene-3"],
  folderSplit: "mw-folder-split",
  split: ["mw-split-1", "mw-split-2", "mw-split-3"],
  after: "mw-after",
};

/** `count` paragraphs of numbered filler sentences; `inserts` maps a paragraph
 * index to the marker sentence that replaces the first sentence there. */
function prose(label, count, inserts) {
  return Array.from({ length: count }, (_, p) => {
    const sentences = Array.from(
      { length: 5 },
      (_, s) =>
        `The ${label} watch counted lamp ${p * 5 + s + 1} along the cold wall.`,
    );
    if (inserts[p]) sentences[0] = inserts[p];
    return sentences.join(" ");
  });
}
const LONG_PARAGRAPHS = 50;
const longBody = prose("Brackwater", LONG_PARAGRAPHS, {
  // Away from every window boundary (and so from every context range).
  4: marker("seal-first"),
  29: marker("bell-middle"),
  [LONG_PARAGRAPHS - 4]: marker("seal-last"),
});
const threeBodies = [
  prose("Saltmere", 3, { 1: marker("fire-first") }),
  prose("Saltmere", 3, { 1: marker("writ-middle") }),
  prose("Saltmere", 3, { 1: marker("fire-last") }),
];
const splitBodies = [
  prose("Greywater", 3, { 1: marker("dawn-first") }),
  prose("Greywater", 3, { 1: marker("tide-first") }),
  prose("Greywater", 3, { 1: marker("tide-last") }),
];
const plainBody = (text) => [text];
const paragraphs = (texts) =>
  JSON.stringify({
    type: "doc",
    content: texts.map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    })),
  });

// Where each golden is committed (copy it there verbatim): the manifest records
// the name and the sha256 of the file this script wrote.
const COMMITTED_GOLDENS = {
  "nir1-declared-scope-cold": {
    three: "production-declared-scope-folder-golden.json",
    split: "production-declared-scope-split-golden.json",
  },
};
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
assert.equal(
  git("status", "--porcelain", "--untracked-files=no"),
  "",
  "the tree must be clean so productCommit names the code that ran",
);
const productCommit = git("rev-parse", "HEAD");
await mkdir(output);
const save = (name, data) =>
  writeFile(path.join(output, name), JSON.stringify(data, null, 2) + "\n");
const harness = createProductJourneyHarness({
  mainCjs: path.join(root, "dist-electron/main.cjs"),
  artifactRoot: output,
});
const writeContext = () => ({
  requestId: randomUUID(),
  sessionId: "nir1-multi-window-cold-fixture",
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
const rows = (page, sql, params = []) =>
  queryChronicleFixtureRows(harness, page, sql, params);
const bundleOf = (page, identity) =>
  readChronicleReviewBundle(harness, page, identity);

/** What the sealed Run must look like for the shape to prove what it claims. */
function assertShape(
  bundle,
  { windows, cluster, names, windowOf, clusterCount = 2 },
) {
  const artifact = (kind) => {
    const found = bundle.artifacts.filter((row) => row.artifactKind === kind);
    assert.equal(found.length, 1, kind);
    return found[0].payloadJson;
  };
  const plan = artifact("source.window-plan@1");
  assert.equal(plan.windows.length, windows, "window count");
  const raw = artifact("chronicle.raw-observations@1");
  const merged = artifact("chronicle.merged-observations@1");
  assert.deepEqual(raw.observations, merged.observations, "identity merge");
  assert.ok(
    bundle.stageReceipts.every(
      (row) => row.stageExecution.stageId !== "narrative_structured_repair",
    ),
    "no repair",
  );
  assert.equal(
    bundle.stageReceipts.filter(
      (row) => row.stageExecution.stageId === "narrative_observation_extract",
    ).length,
    windows,
    "one observation request per window",
  );
  const clusters = artifact("chronicle.event-clusters@1").clusters;
  assert.equal(clusters.length, clusterCount);
  const prefixes = (ref) =>
    new Set(ref.observationRefs.map((id) => id.split(":")[0]));
  assert.equal(
    clusters.filter((c) => prefixes(c).size > 1).length,
    1,
    "exactly one cluster folds observations of two windows",
  );
  const crossing = clusters.find((c) => prefixes(c).size > 1);
  // The framework re-keys a model's localId as "<window id>:obs-NNN", so the
  // fixture's markers are found through each observation's cited quote.
  const keyOf = (observation) => {
    const keys = fixture.rows
      .filter((row) =>
        observation.evidence.some((e) => e.quote.includes(row.marker)),
      )
      .map((row) => row.key);
    assert.equal(keys.length, 1, `one marker in ${observation.localId}`);
    return keys[0];
  };
  const byId = new Map(raw.observations.map((o) => [o.localId, o]));
  assert.deepEqual(
    crossing.observationRefs.map((id) => keyOf(byId.get(id))),
    cluster,
  );
  assert.deepEqual(
    bundle.proposals.map((row) => row.payloadJson.title).sort(),
    names.sort(),
  );
  for (const [key, windowId] of Object.entries(windowOf)) {
    const found = raw.observations.filter((o) => keyOf(o) === key);
    assert.equal(found.length, 1, key);
    assert.ok(
      found[0].localId.startsWith(`${windowId}:`),
      `${key} in ${windowId}`,
    );
  }
  assert.equal(raw.observations.length, Object.keys(windowOf).length);
  return {
    windows: plan.windows.map((w) => w.windowId),
    observationIds: raw.observations.map((o) => o.localId),
    crossingCluster: crossing.clusterRef,
  };
}

let success = false;
try {
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
  const workspace = harness.workspacePath("nir1-multi-window");
  await configureWorkspace(harness, workspace, { deterministicAi: true });
  const seeded = await harness.launch("nir1-multi-window/seed");
  let projectId;
  try {
    projectId = await harness.waitUntil(
      async () =>
        (
          await rows(
            seeded.page,
            "SELECT id FROM projects ORDER BY created_at, id LIMIT 1",
          )
        )[0]?.id,
      "isolated fixture project",
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
        patch: { language: "en", phaseResolutionMode: "reading" },
      },
    });
    await setMainLineSceneScopeDefault({
      invoke: (command, args) => harness.invokeOk(seeded.page, command, args),
      workspace,
      projectId,
    });
    const create = (node) =>
      createChronicleFixtureNode(harness, seeded.page, projectId, node);
    const folder = (id, title, sortOrder) =>
      create({
        id,
        parentId: null,
        nodeType: "folder",
        title,
        sortOrder,
        content: null,
      });
    const scene = (id, parentId, title, sortOrder, texts) =>
      create({
        id,
        parentId,
        nodeType: "scene",
        title,
        sortOrder,
        content: paragraphs(texts),
      });
    await scene(
      IDS.before,
      null,
      "Before the folders",
      "a0",
      plainBody("A quiet room before the harbour."),
    );
    await folder(IDS.folderLong, "One long scene", "a1");
    await scene(IDS.long, IDS.folderLong, "The ledger room", "a0", longBody);
    await folder(IDS.folderThree, "Three short scenes", "a2");
    for (const [index, id] of IDS.three.entries()) {
      await scene(
        id,
        IDS.folderThree,
        `Quay ${index + 1}`,
        `a${index}`,
        threeBodies[index],
      );
    }
    // "a2V" sorts between the three-scene folder ("a2") and the scene after ("a3").
    await folder(IDS.folderSplit, "Split material scenes", "a2V");
    for (const [index, id] of IDS.split.entries()) {
      await scene(
        id,
        IDS.folderSplit,
        `Stair ${index + 1}`,
        `a${index}`,
        splitBodies[index],
      );
    }
    await scene(
      IDS.after,
      null,
      "After the folders",
      "a3",
      plainBody("A quiet room after the harbour."),
    );
    assert.equal(
      (await rows(seeded.page, "SELECT id FROM narrative_proposal_revisions"))
        .length,
      0,
    );
  } finally {
    await harness.close(seeded.app, seeded.page, "nir1-multi-window/seed");
  }

  const runs = {};
  const reviewed = await harness.launch("nir1-multi-window/extract-and-review");
  try {
    await waitForChronicleFixtureWorkspace(harness, reviewed.page, {
      projectId,
      sceneId: IDS.after,
    });
    await showChronicleFixturePanel(reviewed.page);
    await reviewed.page.getByTitle("AI 抽出", { exact: true }).click();
    const dialog = reviewed.page.getByRole("dialog");
    const shapes = [
      {
        name: "long",
        folderId: IDS.folderLong,
        windows: 3,
        cluster: ["seal-first", "seal-last"],
        windowOf: {
          "seal-first": "window-001",
          "bell-middle": "window-002",
          "seal-last": "window-003",
        },
        titles: [fixture.clusters.seal.title, fixture.clusters.bell.title],
      },
      {
        name: "three",
        folderId: IDS.folderThree,
        windows: 3,
        cluster: ["fire-first", "fire-last"],
        windowOf: {
          "fire-first": "window-001",
          "writ-middle": "window-002",
          "fire-last": "window-003",
        },
        titles: [fixture.clusters.fire.title, fixture.clusters.writ.title],
      },
      {
        name: "split",
        folderId: IDS.folderSplit,
        windows: 3,
        clusterCount: 2,
        cluster: ["tide-first", "tide-last"],
        windowOf: {
          "dawn-first": "window-001",
          "tide-first": "window-002",
          "tide-last": "window-003",
        },
        titles: [fixture.clusters.dawn.title, fixture.clusters.tide.title],
        // The golden is the Run's, with the root Envelope of this proposal.
        goldenTitle: fixture.clusters.tide.title,
        // Declared scenes {2, 3}; evidence scene {2} (DMS/1 D1).
        declared: [IDS.split[1], IDS.split[2]],
        evidence: [IDS.split[1]],
      },
    ];
    for (const shape of shapes) {
      await dialog.locator("select").selectOption(shape.folderId);
      const identity = await analyzeChronicleAndWaitForProposals({
        harness,
        page: reviewed.page,
        dialog,
        projectId,
        directory: output,
        failOnStartNotices: true,
      });
      const initial = await bundleOf(reviewed.page, identity);
      assertInitialProposals(initial.proposals, 2);
      const sealed = assertShape(initial, {
        windows: shape.windows,
        cluster: shape.cluster,
        names: shape.titles,
        windowOf: shape.windowOf,
        clusterCount: shape.clusterCount,
      });
      await save(`${shape.name}-initial.json`, initial);
      const proposals = [];
      for (const parent of initial.proposals) {
        const card = dialog.getByTestId(
          `chronicle-proposal-card-${parent.proposalId}`,
        );
        await card.getByRole("button").first().click();
        const checkbox = dialog.getByTestId("chronicle-proposal-secret-input");
        assert.equal(await checkbox.isChecked(), true);
        // A controlled checkbox settles only after Native persists the child.
        await checkbox.click();
        const child = await harness.waitUntil(async () => {
          const row = (await bundleOf(reviewed.page, identity)).proposals.find(
            (entry) => entry.proposalId === parent.proposalId,
          );
          return (
            row?.currentRevisionId !== parent.currentRevisionId &&
            row?.payloadJson.disclosure.secret === false &&
            row
          );
        }, "nonsecret current child saved");
        await harness.waitUntil(
          async () => !(await checkbox.isChecked()),
          "nonsecret checkbox settled",
        );
        assertUnreviewedChild(parent, child);
        await card.getByRole("button", { name: "承認", exact: true }).click();
        const approved = await harness.waitUntil(async () => {
          const row = (await bundleOf(reviewed.page, identity)).proposals.find(
            (entry) => entry.proposalId === parent.proposalId,
          );
          return row?.latestDecision?.decision === "approved" && row;
        }, "current child's explicit own Decision");
        assertExplicitChildApproval(child, approved, projectId);
        proposals.push({
          proposalId: parent.proposalId,
          title: parent.payloadJson.title,
          rootRevisionId: parent.currentRevisionId,
          revisionId: child.currentRevisionId,
          decisionId: approved.latestDecision.decisionId,
        });
      }
      const after = await bundleOf(reviewed.page, identity);
      assert.deepEqual(after.artifacts, initial.artifacts);
      assert.deepEqual(after.stageReceipts, initial.stageReceipts);
      // The independent golden: everything the TypeScript builders need to
      // rebuild every persisted request of this Run, copied from the sealed
      // artifacts and receipts the normal path persisted.
      const sealedArtifact = (kind) =>
        initial.artifacts.find((row) => row.artifactKind === kind).payloadJson;
      // The review API returns only the DAG artifacts; the synthesis outputs
      // are the persisted companion bound to that verified owner.
      const companion = await readChronicleSynthesisCompanion(
        harness,
        reviewed.page,
        initial,
      );
      const goldenProposal = shape.goldenTitle
        ? proposals.find((p) => p.title === shape.goldenTitle)
        : proposals[0];
      assert.ok(goldenProposal, "golden proposal");
      const [{ envelope }] = await rows(
        reviewed.page,
        "SELECT reconciliation_envelope_json AS envelope FROM narrative_proposal_revisions WHERE id = ?",
        [goldenProposal.rootRevisionId],
      );
      const rootEnvelope = JSON.parse(envelope);
      if (shape.declared) {
        // The record must be the narrowed one this shape exists to prove.
        const basis = rootEnvelope.effectiveMaterialBasis;
        const scenes = (keys) => keys.map((id) => `project:scene:${id}`).sort();
        assert.deepEqual(
          basis.sourceBasis
            .filter((entry) => entry.sourceKind === "scene-body")
            .map((entry) => entry.sourceKey)
            .sort(),
          scenes(shape.declared),
          "declared scenes",
        );
        assert.deepEqual(
          [
            ...new Set(
              basis.evidenceSet
                .map((entry) => entry.sourceKey)
                .filter((key) => key?.startsWith("project:scene:")),
            ),
          ].sort(),
          scenes(shape.evidence),
          "evidence scenes",
        );
      }
      const golden = {
        provenance: {
          source: "normal planner, production extraction path, Human review UI",
          setup: "electron/scripts/nir1-multi-window-cold-fixture.mjs",
        },
        snapshot: sealedArtifact("source.snapshot@1"),
        plan: sealedArtifact("source.window-plan@1"),
        outputs: companion.payloadJson.outputs,
        receipts: initial.stageReceipts,
        rootEnvelope,
      };
      const goldenText = JSON.stringify(golden, null, 2) + "\n";
      await writeFile(path.join(output, `${shape.name}-golden.json`), goldenText);
      runs[shape.name] = {
        ...(COMMITTED_GOLDENS[name]?.[shape.name]
          ? { goldenFile: COMMITTED_GOLDENS[name][shape.name] }
          : {}),
        goldenSha256: sha(goldenText),
        ...identity,
        folderId: shape.folderId,
        sealed,
        proposals,
      };
      process.stdout.write(
        `multi-window fixture: ${shape.name} Run approved\n`,
      );
    }
  } finally {
    await harness.close(
      reviewed.app,
      reviewed.page,
      "nir1-multi-window/extract-and-review",
    );
  }

  const cold = await harness.launch("nir1-multi-window/cold-reopen");
  try {
    await waitForChronicleFixtureWorkspace(harness, cold.page, {
      projectId,
      sceneId: IDS.after,
    });
    for (const run of Object.values(runs)) {
      const reopened = await bundleOf(cold.page, {
        projectId,
        runId: run.runId,
      });
      for (const proposal of run.proposals) {
        const row = reopened.proposals.find(
          (p) => p.proposalId === proposal.proposalId,
        );
        assert.equal(row.currentRevisionId, proposal.revisionId);
        assert.equal(row.latestDecision.decisionId, proposal.decisionId);
      }
    }
  } finally {
    await harness.close(cold.app, cold.page, "nir1-multi-window/cold-reopen");
  }
  const coldWorkspace = path.join(output, "cold-workspace");
  await cp(workspace, coldWorkspace, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const database = await readFile(path.join(coldWorkspace, "grimodex.db"));
  const compressed = gzipSync(database, { level: 9, mtime: 0 });
  await writeFile(path.join(output, `${name}.db.gz`), compressed);
  await save(`${name}.json`, {
    schemaVersion: `${name}/1`,
    projectId,
    scenes: IDS,
    runs,
    // The product that made every row: this tree's HEAD (the run refuses a
    // dirty tree, so the commit names the code that ran).
    productCommit,
    setupScript: "electron/scripts/nir1-multi-window-cold-fixture.mjs",
    providerFixture: "electron/shared/productJourneyMultiWindowFixture.json",
    compressedDatabaseSha256: sha(compressed),
    uncompressedDatabaseSha256: sha(database),
  });
  success = true;
} finally {
  await harness.dispose({ success, name: "nir1-multi-window-cold-fixture" });
}
