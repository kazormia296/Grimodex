// Diagnostic preparation only. This seeds NEW source scenes through production
// tree writers. It does not claim a nonsecret extraction/admission positive.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configureWorkspace } from "../electron/scripts/product-journeys.mjs";
import { createProductJourneyHarness } from "../electron/scripts/product-journey-harness.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const [output] = process.argv.slice(2);
assert.ok(
  output && path.isAbsolute(output),
  "usage: node scripts/nir1-disclosure-fixture-seed.mjs <new-absolute-output-directory>",
);
await mkdir(output); // Existing output is an error; never replace a cold fixture.
const harness = createProductJourneyHarness({
  mainCjs: path.join(root, "dist-electron/main.cjs"),
  artifactRoot: output,
});
const id = "nir1-disclosure-s1-s2-seed";
const workspace = harness.workspacePath(id);
let success = false;
try {
  await configureWorkspace(harness, workspace);
  const launched = await harness.launch(id);
  let identity;
  try {
    const rows = async (sql, params = []) =>
      (
        await harness.invokeOk(launched.page, "db_execute", {
          sql,
          params,
          method: "all",
        })
      ).rows ?? [];
    const projectId = await harness.waitUntil(
      async () =>
        (
          await rows("SELECT id FROM projects ORDER BY created_at,id LIMIT 1")
        )[0]?.id,
      "seed project",
    );
    const folderId = randomUUID(),
      s1 = randomUUID(),
      s2 = randomUUID();
    const create = async (node) =>
      harness.invokeOk(launched.page, "tree_node_create", {
        payload: {
          projectId,
          requestId: randomUUID(),
          sessionId: randomUUID(),
          eventUid: randomUUID(),
          origin: "human",
          originalTransactionId: null,
          undoJournalId: null,
          status: "draft",
          ...node,
        },
      });
    await create({
      id: folderId,
      parentId: null,
      nodeType: "folder",
      title: "S1 extraction target",
      sortOrder: "a0",
      content: null,
    });
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "electron/shared/productJourneyChronicleFixture.json"),
        "utf8",
      ),
    );
    const doc = (texts) =>
      JSON.stringify({
        type: "doc",
        content: texts.map((text) => ({
          type: "paragraph",
          content: [{ type: "text", text }],
        })),
      });
    await create({
      id: s1,
      parentId: folderId,
      nodeType: "scene",
      title: "S1 門と鐘",
      sortOrder: "a0",
      content: doc(fixture.rows.map((row) => row.text)),
    });
    await create({
      id: s2,
      parentId: null,
      nodeType: "scene",
      title: "S2 後続の場面",
      sortOrder: "a1",
      content: doc(["NIR1_S2_MUST_NOT_ENTER_REQUEST"]),
    });
    const scenes = await rows(
      "SELECT id,parent_id AS parentId,sort_order AS sortOrder,story_time_order AS storyTimeOrder FROM tree_nodes WHERE project_id=? AND node_type='scene' ORDER BY id",
      [projectId],
    );
    assert.equal(scenes.length, 2);
    assert.ok(scenes.every((row) => row.storyTimeOrder === null));
    const mode = (
      await rows(
        "SELECT phase_resolution_mode AS mode FROM projects WHERE id=?",
        [projectId],
      )
    )[0].mode;
    assert.equal(mode, "auto");
    identity = {
      projectId,
      s1,
      s2,
      folderId,
      phaseResolutionMode: mode,
      scenes,
    };
  } finally {
    await harness.close(launched.app, launched.page, id);
  }
  await cp(workspace, path.join(output, "cold-seed-workspace"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const sha = async (file) =>
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  const result = {
    diagnosticOnly: true,
    stage: "production-tree-seed-only",
    ...identity,
    extractionTarget: {
      kind: "folder",
      folderId: identity.folderId,
      expectedSceneIds: [identity.s1],
    },
    producerMainDigest: await sha(path.join(root, "dist-electron/main.cjs")),
    databaseDigest: await sha(
      path.join(output, "cold-seed-workspace/grimodex.db"),
    ),
    nonsecretRevisionGenerated: false,
    disclosurePositive: false,
    nextPrecheck:
      "Current production planner always emits secret:true. Do not rewrite saved Scope or bypass planner to manufacture a positive. Confirm a supported nonsecret generation route first.",
  };
  await writeFile(
    path.join(output, "seed.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  success = true;
  console.log(JSON.stringify(result, null, 2));
} finally {
  await harness.dispose({ success, name: id });
}
