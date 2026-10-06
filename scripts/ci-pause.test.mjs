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

test("manual source-focused repair preserves failures and excludes unrelated product execution", async () => {
  const ci = await readWorkflow(".github/workflows/ci.yml");
  const input = ci.on.workflow_dispatch.inputs.source_focused;
  assert.equal(input.type, "boolean");
  assert.equal(input.default, false);
  assert.equal(ci.on.workflow_call.inputs.source_focused, undefined);
  assert.equal(
    ci.on.workflow_dispatch.inputs.product_journey_mode.default,
    "all",
  );

  for (const [id, job] of Object.entries(ci.jobs)) {
    if (id !== "electron") assert.match(job.if, /!inputs\.source_focused/u, id);
  }
  const electron = ci.jobs.electron;
  assert.equal(electron["timeout-minutes"], 20);
  const contractsIndex = electron.steps.findIndex(
    ({ id }) => id === "source-focused-contracts",
  );
  const generationIndex = electron.steps.findIndex(
    ({ name }) => name === "Generate license repair source",
  );
  assert.ok(contractsIndex >= 0 && generationIndex > contractsIndex);
  const contracts = electron.steps[contractsIndex];
  assert.equal(contracts.if, "inputs.source_focused");
  assert.equal(contracts["continue-on-error"], undefined);
  assert.match(contracts.run, /set -euo pipefail/u);
  for (const file of [
    "ci-pause",
    "local-ci",
    "local-ci-runner",
    "local-ci-process-supervisor",
    "electron-product-journeys",
    "generate-licenses",
    "license-policy",
  ]) {
    assert.ok(contracts.run.includes(`scripts/${file}.test.mjs`), file);
  }
  assert.doesNotMatch(contracts.run, /generate:licenses|\|\|\s*true/u);
  const generation = electron.steps[generationIndex];
  assert.equal(generation.run, "pnpm generate:licenses");
  assert.match(generation.if, /inputs\.source_focused && !cancelled\(\)/u);
  assert.match(generation.if, /steps\.install\.outcome == 'success'/u);
  assert.match(
    generation.if,
    /steps\.source-focused-contracts\.outcome == 'failure'/u,
  );
  assert.equal(generation["continue-on-error"], undefined);

  for (const name of [
    "Release workflow and manifest contract tests",
    "Electron type-check",
    "Electron tests",
    "Electron production build",
    "Renderer performance budget",
  ]) {
    assert.equal(
      electron.steps.find((step) => step.name === name).if,
      "${{ !inputs.source_focused }}",
      name,
    );
  }
  const upload = electron.steps.find(
    ({ name }) => name === "Upload source-focused repair evidence",
  );
  assert.equal(upload.if, "always() && inputs.source_focused");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(upload.with["include-hidden-files"], true);
  assert.equal(
    upload.with.name,
    "ci-source-focused-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  assert.deepEqual(upload.with.path.trim().split("\n"), [
    ".artifacts/ci-source-focused/checkout-identity.json",
    ".artifacts/ci-source-focused/contracts.tap",
    "THIRD_PARTY_LICENSES.md",
    "public/THIRD_PARTY_LICENSES.md",
  ]);
});

test("tag releases still call the complete reusable CI workflow", async () => {
  const release = await readWorkflow(".github/workflows/release.yml");
  const ciJob = release.jobs.ci;

  assert.equal(ciJob.uses, "./.github/workflows/ci.yml");
  assert.equal(ciJob.with.product_journey_mode, "all");
  assert.match(ciJob.if, /github\.event_name == 'push'/);
  assert.match(ciJob.if, /github\.ref_type == 'tag'/);
});
