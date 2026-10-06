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
    ".artifacts/ci-source-focused/sharp-graph.json",
    "pnpm-lock.yaml",
    "THIRD_PARTY_LICENSES.md",
    "public/THIRD_PARTY_LICENSES.md",
  ]);
});

test("sharp lock repair is fixed, opt-in, and verified before source contracts", async () => {
  const ci = await readWorkflow(".github/workflows/ci.yml");
  const input = ci.on.workflow_dispatch.inputs.source_resolve_sharp;
  assert.equal(input.type, "boolean");
  assert.equal(input.default, false);
  assert.equal(ci.on.workflow_call.inputs.source_resolve_sharp, undefined);
  const steps = ci.jobs.electron.steps;
  const selection = steps.find(({ name }) => name === "Validate sharp repair selection");
  assert.equal(selection.if, "inputs.source_resolve_sharp");
  assert.equal(selection.env.SOURCE_FOCUSED, "${{ inputs.source_focused }}");
  assert.equal(selection.run, 'test "$SOURCE_FOCUSED" = true');
  const resolveIndex = steps.findIndex(({ name }) => name === "Resolve sharp lock repair source");
  const installIndex = steps.findIndex(({ id }) => id === "install");
  const verifyIndex = steps.findIndex(({ name }) => name === "Verify sharp repair graph");
  const contractsIndex = steps.findIndex(({ id }) => id === "source-focused-contracts");
  assert.ok(resolveIndex >= 0 && resolveIndex < installIndex);
  assert.ok(installIndex < verifyIndex && verifyIndex < contractsIndex);
  for (const step of [steps[resolveIndex], steps[verifyIndex]]) {
    assert.equal(step.if, "inputs.source_focused && inputs.source_resolve_sharp");
    assert.equal(step["continue-on-error"], undefined);
  }
  assert.match(steps[resolveIndex].run, /pnpm update sharp --depth Infinity --lockfile-only --ignore-scripts/u);
  assert.doesNotMatch(steps[resolveIndex].run, /--latest|\|\|\s*true/u);
  assert.equal(steps[installIndex].run, "pnpm install --frozen-lockfile");
  const verification = steps[verifyIndex].run;
  assert.ok(verification.includes("['miniflare', 'vite-imagetools']"));
  assert.ok(verification.includes("['sharp@0.35.5']"));
  assert.ok(verification.includes("'@1.3.4' : '@0.35.5'"));
  assert.match(verification, /assert\.throws/u);
  assert.match(verification, /sharp-before\.yaml/u);
  assert.match(verification, /sharp-graph\.json/u);
});

test("tag releases still call the complete reusable CI workflow", async () => {
  const release = await readWorkflow(".github/workflows/release.yml");
  const ciJob = release.jobs.ci;

  assert.equal(ciJob.uses, "./.github/workflows/ci.yml");
  assert.equal(ciJob.with.product_journey_mode, "all");
  assert.match(ciJob.if, /github\.event_name == 'push'/);
  assert.match(ciJob.if, /github\.ref_type == 'tag'/);
});
