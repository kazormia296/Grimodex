import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function readWorkflow(relativePath) {
  const source = await readFile(path.join(repoRoot, relativePath), "utf8");
  return yaml.load(source);
}

test("automatic hosted CI triggers are paused for the private source repo", async () => {
  const ci = await readWorkflow(".github/workflows/ci.yml");

  assert.deepEqual(Object.keys(ci.on).sort(), [
    "workflow_call",
    "workflow_dispatch",
  ]);
  assert.ok(
    ci.on.workflow_call,
    "release reusable CI call must remain available",
  );
});

test("unusable private-repository security workflows are not dispatchable", async () => {
  for (const relativePath of [
    ".github/workflows/codeql.yml",
    ".github/workflows/dependency-review.yml",
  ]) {
    await assert.rejects(
      access(path.join(repoRoot, relativePath)),
      (error) => error?.code === "ENOENT",
      `${relativePath} must stay removed instead of exposing a broken manual run`,
    );
  }
});

test("tag releases still call the complete reusable CI workflow", async () => {
  const release = await readWorkflow(".github/workflows/release.yml");
  const ciJob = release.jobs.ci;

  assert.equal(ciJob.uses, "./.github/workflows/ci.yml");
  assert.equal(ciJob.with.product_journey_mode, "all");
  assert.match(ciJob.if, /github\.event_name == 'push'/);
  assert.match(ciJob.if, /github\.ref_type == 'tag'/);
});
