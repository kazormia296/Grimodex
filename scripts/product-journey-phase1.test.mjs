import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function read(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("workspace lifecycle journeys drive the main-only maintenance wake", async () => {
  const mainIndex = await read("electron/main/index.ts");
  const journeys = await read("electron/scripts/product-journeys.mjs");
  const preload = await read("electron/preload/index.ts");

  assert.match(mainIndex, /workspace:opened[\s\S]*narrativeMaintenance\.(?:request|enqueue)/);
  assert.match(mainIndex, /workspace:(?:restored|restore)/);
  assert.match(journeys, /narrativeMaintenance\.(?:request|enqueue)/);
  assert.doesNotMatch(preload, /narrativeMaintenance/i);
});

test("product journeys prove ordered discovery, coordinate revalidation, and sealed completion", async () => {
  const journeys = await read("electron/scripts/product-journeys.mjs");

  assert.match(journeys, /legacy-dependency-backfill:v2/);
  assert.match(journeys, /dependency-verify/);
  assert.match(journeys, /semantic-index-rebuild/);
  assert.match(journeys, /graphContractDigest/);
  assert.match(journeys, /ruleRegistryDigest/);
  assert.match(journeys, /producerGenerationSetDigest/);
  assert.match(journeys, /completed.*(?:Run|run).*evidence/i);
});

test("foreground authoring and workspace wake share live-authority evidence", async () => {
  const journeys = await read("electron/scripts/product-journeys.mjs");

  assert.match(journeys, /workspaceBinding/);
  assert.match(journeys, /SQLITE_BUSY_SNAPSHOT/);
  assert.match(journeys, /foreground.*write|authoring.*write/i);
  assert.match(journeys, /workspace.*wake/i);
  assert.doesNotMatch(journeys, /Repair|dependency-repair/);
});

test("incremental liveness requires current epoch, completed Run, and Feed head", async () => {
  const journeys = await read("electron/scripts/product-journeys.mjs");

  assert.match(journeys, /current.*epoch/i);
  assert.match(journeys, /completed.*freshness/i);
  assert.match(journeys, /cursor/i);
  assert.match(journeys, /feed.*head/i);
  assert.match(journeys, /new.*feed|old.*epoch|missing.*cursor/i);
});
