// Scene -> Proposals read (SRA/1 R1-R3) across the N-API boundary: serde of the
// payload (strict fields), workspace routing, and the camelCase page. Shared-Rust
// integration tests (`narrative_scene_proposals`) own the read's behavior; this
// file proves the generated binding carries it.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

const root = mkdtempSync(join(tmpdir(), "grimodex-node-scene-proposals-"));
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
  }
});

const backend = new Backend(join(root, "app-data"));

after(async () => {
  const wire = await backend.shutdownWorkspaceLifecycle();
  assert.equal(
    JSON.parse(wire).status,
    "closed",
    "Native cleanup must prove Closed",
  );
});

before(async () => {
  await backend.openWorkspace(join(root, "workspace"));
});

test("the Scene proposals read crosses the N-API boundary and cuts the page size to Native's cap", async () => {
  // A Scene that is not in the project has no proposals; the page still reports
  // the size Native applied, so a request above the cap shows the cut.
  const unknown = JSON.parse(
    await backend.narrativeExtractionListSceneProposals({
      projectId: "default-project",
      sceneId: "no-such-scene",
      limit: 1000,
    }),
  );
  assert.deepEqual(unknown, { items: [], nextCursor: null, limit: 50 });

  const defaulted = JSON.parse(
    await backend.narrativeExtractionListSceneProposals({
      projectId: "default-project",
      sceneId: "no-such-scene",
    }),
  );
  assert.equal(defaulted.limit, 20);
});

test("the Scene proposals read refuses unknown fields and malformed identities", async () => {
  for (const payload of [
    { projectId: "default-project", sceneId: "s", unexpected: true },
    { projectId: "default-project" },
    { projectId: "", sceneId: "s" },
    { projectId: "default-project", sceneId: " s" },
    { projectId: "default-project", sceneId: "s", limit: 0 },
  ]) {
    await assert.rejects(
      backend.narrativeExtractionListSceneProposals(payload),
      undefined,
      JSON.stringify(payload),
    );
  }
});
