import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  const workflows = await Promise.all(
    [
      ".github/workflows/ci.yml",
      ".github/workflows/codeql.yml",
      ".github/workflows/dependency-review.yml",
    ].map(readWorkflow),
  );

  for (const workflow of workflows) {
    assert.equal(workflow.on.push, undefined);
    assert.equal(workflow.on.pull_request, undefined);
    assert.equal(workflow.on.schedule, undefined);
    assert.ok(
      Object.hasOwn(workflow.on, "workflow_dispatch"),
      "manual recovery must remain available",
    );
  }

  const ci = workflows[0];
  assert.ok(
    ci.on.workflow_call,
    "release reusable CI call must remain available",
  );
});
