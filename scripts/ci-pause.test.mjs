import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import yaml from "js-yaml";
import { buildLocalCiPlan } from "./local-ci.mjs";
import { normalizedDestination } from "./local-ci-setup-observation.mjs";
import {
  acquireWorkloadInput,
  assertPreparationEnvelope,
  assessFullDemand,
  assessFullSetupDemand,
  collectFullLocations,
  canonicalSystemPackages,
  coldSystemPackages,
  coldSystemSolverFormat,
  systemPackageSizes,
  fullPreparation,
  fullSetupLocations,
  groupedDbPrerequisites,
  normalPrerequisites,
  cpuPrerequisites,
  nativePrerequisites,
  stageFullGroupedReference,
  cpuVersionFormat,
  produceWorkloadEstimate,
  resolveObservedResidual,
  validateWorkloadEstimate,
  validateWorkloadAcquisition,
  validateFullSetupDecision,
  validateFullSetupEstimate,
  validateFullSetupLocations,
} from "./local-ci-full-admission.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function readWorkflow(relativePath) {
  const source = await readFile(path.join(repoRoot, relativePath), "utf8");
  return yaml.load(source);
}

test("shared Rust masks inherited live-provider credentials without step overrides", async () => {
  const ci = await readWorkflow(".github/workflows/ci.yml");
  const rust = ci.jobs.rust;
  const keys = ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "OPEN_ROUTER_API_KEY", "ANTHROPIC_API_KEY", "SAKANA_API_KEY"];
  for (const key of keys) {
    assert.equal(rust.env[key], "", `${key} must be explicitly empty`);
    for (const step of rust.steps) {
      assert.equal(Object.hasOwn(step.env ?? {}, key), false, `${step.name}: ${key} override`);
    }
  }
  for (const step of rust.steps) assert.doesNotMatch(step.run ?? "", /GITHUB_ENV/u);
  // Synthetic nonempty inherited keys, including OpenRouter's alternate spelling.
  // Only test emptiness; never print environment values or call a provider.
  const inherited = Object.fromEntries(keys.map((key) => [key, "synthetic-not-a-credential"]));
  await promisify(execFile)("bash", ["-c", 'set -euo pipefail; for key in OPENAI_API_KEY OPENROUTER_API_KEY OPEN_ROUTER_API_KEY ANTHROPIC_API_KEY SAKANA_API_KEY; do test -z "${!key}"; done'], {
    timeout: 10000,
    env: { ...process.env, ...inherited, ...ci.env, ...rust.env },
  });
});

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
    if (id !== "electron" && id !== "canonical" && id !== "existing-os-suitability") assert.match(job.if, /!inputs\.source_focused/u, id);
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
  assert.equal(contracts.if, "inputs.source_focused && !inputs.source_audit_compat && !inputs.source_canonical_contracts");
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
  assert.match(generation.if, /inputs\.source_focused && !inputs\.source_audit_compat && !cancelled\(\)/u);
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
  assert.equal(upload.if, "always() && inputs.source_focused && !inputs.source_audit_compat && !inputs.source_canonical_contracts");
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

test("sharp graph verifier accepts peer-qualified exact versions and rejects broken graphs", async () => {
  const ci = await readWorkflow(".github/workflows/ci.yml");
  const source = ci.jobs.electron.steps.find(
    ({ name }) => name === "Verify sharp repair graph",
  ).run;
  const start = source.indexOf("function verify(lock)");
  const end = source.indexOf("assert.throws(");
  assert.ok(start >= 0 && end > start);
  const verify = new Function("assert", `${source.slice(start, end)}\nreturn verify;`)(assert);
  const dependency = "0.35.5(@types/node@24.13.3)";
  const lock = {
    packages: {
      "sharp@0.35.5": {
        resolution: {
          integrity: "sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g==",
        },
      },
      "@img/sharp-linux-x64@0.35.5": {},
      "@img/sharp-libvips-linux-x64@1.3.4": {},
    },
    snapshots: {
      [`sharp@${dependency}`]: {},
      "miniflare@5.20260730.0-alpha": { dependencies: { sharp: dependency } },
      "vite-imagetools@10.0.1": { dependencies: { sharp: dependency } },
    },
  };
  assert.deepEqual(Object.values(verify(lock).consumers), [dependency, dependency]);
  const bare = structuredClone(lock);
  bare.snapshots["sharp@0.35.5"] = {};
  for (const name of ["miniflare@5.20260730.0-alpha", "vite-imagetools@10.0.1"]) {
    bare.snapshots[name].dependencies.sharp = "0.35.5";
    for (const version of ["0.35.4", "0.35.50", "0.35.5-beta.1"]) {
      const broken = structuredClone(lock);
      broken.snapshots[name].dependencies.sharp = version;
      broken.snapshots[`sharp@${version}`] = {};
      assert.throws(() => verify(broken));
    }
    const missingConsumer = structuredClone(lock);
    delete missingConsumer.snapshots[name];
    assert.throws(() => verify(missingConsumer));
  }
  assert.deepEqual(Object.values(verify(bare).consumers), ["0.35.5", "0.35.5"]);
  const missingSnapshot = structuredClone(lock);
  delete missingSnapshot.snapshots[`sharp@${dependency}`];
  missingSnapshot.snapshots["sharp@0.35.5"] = {};
  assert.throws(() => verify(missingSnapshot));
  const badIntegrity = structuredClone(lock);
  badIntegrity.packages["sharp@0.35.5"].resolution.integrity = "wrong";
  assert.throws(() => verify(badIntegrity));
  const badPlatform = structuredClone(lock);
  badPlatform.packages["@img/sharp-linux-x64@0.35.4"] = {};
  assert.throws(() => verify(badPlatform));
});

test("audit compatibility is manual, bounded, and separate from resolver/generation/canonical execution", async () => {
  const ci = await readWorkflow(".github/workflows/ci.yml");
  const input = ci.on.workflow_dispatch.inputs.source_audit_compat;
  assert.equal(input.type, "boolean");
  assert.equal(input.default, false);
  assert.equal(ci.on.workflow_call.inputs.source_audit_compat, undefined);
  const steps = ci.jobs.electron.steps;
  const selectionIndex = steps.findIndex(({ name }) => name === "Validate audit compatibility selection");
  const installIndex = steps.findIndex(({ id }) => id === "install");
  assert.ok(selectionIndex >= 0 && selectionIndex < installIndex);
  const selection = steps[selectionIndex];
  assert.equal(selection.if, "inputs.source_audit_compat");
  assert.deepEqual(selection.env, {
    SOURCE_FOCUSED: "${{ inputs.source_focused }}",
    SOURCE_RESOLVE_SHARP: "${{ inputs.source_resolve_sharp }}",
  });
  assert.equal(selection.run, 'test "$SOURCE_FOCUSED" = true && test "$SOURCE_RESOLVE_SHARP" != true');
  const execution = steps.find(({ name }) => name === "Audit and real sharp consumer compatibility");
  assert.equal(execution.if, "inputs.source_focused && inputs.source_audit_compat");
  assert.equal(execution["continue-on-error"], undefined);
  assert.match(execution.run, /runLocalCiCommand/u);
  assert.match(execution.run, /scripts\/ci-pause\.test\.mjs/u);
  assert.match(execution.run, /scripts\/sharp-consumers\.test\.mjs/u);
  assert.match(execution.run, /scripts\/pnpm-audit\.mjs/u);
  assert.match(execution.run, /300000/u);
  assert.match(execution.run, /600000/u);
  assert.match(execution.run, /controller\.abort\(\)/u);
  // Only bounded-close mode supplies the termination/closeObserved success contract.
  assert.match(execution.run, /taskId, signal: controller\.signal, closeGraceMs: 2000,/u);
  assert.match(execution.run, /JSON\.stringify\(error\.result, null, 2\)/u);
  assert.match(execution.run, /finally\s*\{[\s\S]*await error\.lateClose/u);
  assert.match(execution.run, /JSON\.stringify\(late, null, 2\)/u);
  assert.match(execution.run, /throw error;/u);
  for (const field of ["exitCode", "timedOut", "interrupted", "cleanup.complete", "closeObserved", "termination"]) {
    assert.ok(execution.run.includes(`assert.equal(result.${field},`), field);
  }
  assert.doesNotMatch(execution.run, /ci:local:|generate:licenses|pnpm update|\|\|\s*true/u);
  const upload = steps.find(({ name }) => name === "Upload audit compatibility evidence");
  assert.equal(upload.if, "always() && inputs.source_focused && inputs.source_audit_compat");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(upload.with["include-hidden-files"], true);
  assert.equal(upload.with.name, "ci-audit-compat-${{ github.run_id }}-${{ github.run_attempt }}");
  assert.deepEqual(upload.with.path.trim().split("\n"), [
    ".artifacts/ci-source-focused/checkout-identity.json",
    ".artifacts/ci-source-focused/audit-compat/",
  ]);
});

test("registered CI exposes only opt-in canonical source contracts without generation or gates", async () => {
  const ci = await readWorkflow(".github/workflows/ci.yml");
  const workflow = await readWorkflow(".github/workflows/canonical-ci.yml");
  const input = ci.on.workflow_dispatch.inputs.source_canonical_contracts;
  assert.equal(input.type, "boolean");
  assert.equal(input.default, false);
  assert.equal(ci.on.workflow_call.inputs.source_canonical_contracts, undefined);
  // Invalid canonical=true/focused=false must not admit parallel ordinary jobs.
  for (const [id, job] of Object.entries(ci.jobs)) {
    if (id === "electron" || id === "canonical" || id === "existing-os-suitability") continue;
    const canonicalExclusion = " && !inputs.canonical_profile && !inputs.candidate_base && !inputs.candidate_head && !inputs.max_parallel_tasks";
    const independentExclusion = ["electron-runtime-performance", "electron-product-journeys", "electron-native", "rust", "migration-recovery-gate"].includes(id)
      ? " && !inputs.independent_gates" : "";
    const ordinaryCondition = `github.event_name != 'schedule' && !inputs.source_focused && !inputs.source_canonical_contracts${canonicalExclusion}${independentExclusion}`;
    assert.equal(job.if, id === "electron-product-journeys"
      ? `\${{ !inputs.source_focused && !inputs.source_canonical_contracts${canonicalExclusion}${independentExclusion} }}`
      : id === "electron-native"
        ? `\${{ inputs.canonical_profile == 'native-development-build' || inputs.canonical_profile == 'native-development-tests' || inputs.canonical_profile == 'native-release-static' || inputs.canonical_profile == 'native-release-tests' || inputs.canonical_profile == 'native-licensed-mcp' || (${ordinaryCondition}) }}`
      : id === "nir1-c-query-worker"
        ? `\${{ inputs.canonical_profile == 'c-query-workers' || inputs.canonical_profile == 'c-query-cancellation' || inputs.canonical_profile == 'c-query-startup-refusal' || inputs.canonical_profile == 'c-query-trailing-data' || inputs.canonical_profile == 'c-query-partial-terminal' || inputs.canonical_profile == 'c-query-terminal-refusals' || inputs.canonical_profile == 'c-query-practical' || inputs.canonical_profile == 'c-query-frame-lifecycle' || (${ordinaryCondition}) }}`
      : id === "rust"
        ? `\${{ inputs.canonical_profile == 'shared-rust' || (${ordinaryCondition}) }}`
        : id === "migration-recovery-gate"
          ? `\${{ inputs.canonical_profile == 'migration-crash' || inputs.canonical_profile == 'migration-safe-mode' || inputs.canonical_profile == 'migration-library' || inputs.canonical_profile == 'migration-remaining' || (${ordinaryCondition}) }}`
          : ordinaryCondition, id);
  }
  const steps = ci.jobs.electron.steps;
  const selectionIndex = steps.findIndex(({ name }) => name === "Validate canonical contracts selection");
  const resolveIndex = steps.findIndex(({ name }) => name === "Resolve sharp lock repair source");
  const installIndex = steps.findIndex(({ id }) => id === "install");
  assert.ok(selectionIndex >= 0 && selectionIndex < resolveIndex && resolveIndex < installIndex);
  const selection = steps[selectionIndex];
  assert.equal(selection.if, "inputs.source_canonical_contracts");
  assert.deepEqual(selection.env, {
    SOURCE_FOCUSED: "${{ inputs.source_focused }}",
    SOURCE_RESOLVE_SHARP: "${{ inputs.source_resolve_sharp }}",
    SOURCE_AUDIT_COMPAT: "${{ inputs.source_audit_compat }}",
  });
  assert.doesNotMatch(selection.run, /\$\{\{ inputs\./u);
  const execute = promisify(execFile);
  const env = { ...process.env, SOURCE_FOCUSED: "true", SOURCE_RESOLVE_SHARP: "false", SOURCE_AUDIT_COMPAT: "false" };
  const shell = (overrides = {}) => execute("bash", ["-c", selection.run], { env: { ...env, ...overrides }, timeout: 10000 });
  await shell();
  for (const overrides of [
    { SOURCE_FOCUSED: "false" },
    { SOURCE_FOCUSED: "$(exit 0)" },
    { SOURCE_RESOLVE_SHARP: "true" },
    { SOURCE_AUDIT_COMPAT: "true" },
  ]) await assert.rejects(shell(overrides));
  const contracts = steps.find(({ id }) => id === "source-canonical-contracts");
  assert.equal(contracts.if, "inputs.source_focused && inputs.source_canonical_contracts");
  assert.equal(contracts.run, workflow.jobs.canonical.steps.find(({ id }) => id === "contracts").run);
  assert.equal(contracts["continue-on-error"], undefined);
  for (const name of ["Source-focused contracts (before generation)", "Generate license repair source", "Upload source-focused repair evidence"]) {
    assert.match(steps.find((step) => step.name === name).if, /!inputs\.source_canonical_contracts/u, name);
  }
  const upload = steps.find(({ name }) => name === "Upload canonical connection source contracts");
  assert.equal(upload.if, "always() && inputs.source_focused && inputs.source_canonical_contracts");
  assert.equal(upload.with.name, "canonical-source-${{ github.run_id }}-${{ github.run_attempt }}");
  assert.equal(upload.with["include-hidden-files"], true);
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.deepEqual(upload.with.path.trim().split("\n"), [
    ".artifacts/ci-source-focused/checkout-identity.json",
    ".artifacts/canonical-source/contracts.tap",
  ]);
});

test("registered canonical reuse excludes ordinary jobs for every valid or malformed request", async () => {
  const ci = await readWorkflow(".github/workflows/ci.yml");
  const workflow = await readWorkflow(".github/workflows/canonical-ci.yml");
  const dispatch = ci.on.workflow_dispatch.inputs;
  for (const name of ["canonical_profile", "candidate_base", "candidate_head", "max_parallel_tasks"]) {
    assert.equal(dispatch[name].type, "string", name);
    assert.equal(dispatch[name].required, false, name);
    assert.equal(dispatch[name].default ?? "", "", name);
    assert.equal(ci.on.workflow_call.inputs[name], undefined, name);
    assert.equal(workflow.on.workflow_call.inputs[name === "canonical_profile" ? "profile" : name].type, "string", name);
  }
  assert.equal(dispatch.independent_gates.type, "boolean");
  assert.equal(dispatch.independent_gates.default, false);
  assert.equal(dispatch.independent_gates.required, false);
  assert.equal(ci.on.workflow_call.inputs.independent_gates, undefined);
  assert.deepEqual(Object.keys(ci.on.workflow_call.inputs), ["product_journey_mode"]);
  assert.equal(workflow.on.workflow_call.inputs.profile.default, "contracts");
  assert.equal(workflow.on.workflow_call.inputs.max_parallel_tasks.default, "12");
  const owner = ci.jobs.canonical;
  assert.equal(owner.uses, "./.github/workflows/canonical-ci.yml");
  for (const key of ["steps", "runs-on", "secrets", "continue-on-error"]) assert.equal(owner[key], undefined, key);
  assert.deepEqual(Object.keys(owner.with), ["profile", "candidate_base", "candidate_head", "max_parallel_tasks"]);
  assert.equal(owner.if, "${{ !startsWith(inputs.canonical_profile, 'os-') && inputs.canonical_profile != 'shared-rust' && inputs.canonical_profile != 'c-query-workers' && inputs.canonical_profile != 'c-query-cancellation' && inputs.canonical_profile != 'c-query-startup-refusal' && inputs.canonical_profile != 'c-query-trailing-data' && inputs.canonical_profile != 'c-query-partial-terminal' && inputs.canonical_profile != 'c-query-terminal-refusals' && inputs.canonical_profile != 'c-query-practical' && inputs.canonical_profile != 'c-query-frame-lifecycle' && inputs.canonical_profile != 'migration-crash' && inputs.canonical_profile != 'migration-safe-mode' && inputs.canonical_profile != 'migration-library' && inputs.canonical_profile != 'migration-remaining' && inputs.canonical_profile != 'native-development-build' && inputs.canonical_profile != 'native-development-tests' && inputs.canonical_profile != 'native-release-static' && inputs.canonical_profile != 'native-release-tests' && inputs.canonical_profile != 'native-licensed-mcp' && (inputs.canonical_profile || inputs.candidate_base || inputs.candidate_head || inputs.max_parallel_tasks) }}");
  assert.equal(owner.with.profile, "${{ !inputs.independent_gates && !inputs.source_focused && !inputs.source_resolve_sharp && !inputs.source_audit_compat && !inputs.source_canonical_contracts && inputs.product_journey_mode == 'all' && inputs.canonical_profile || 'invalid' }}");
  assert.equal(owner.with.candidate_base, "${{ inputs.candidate_base || '' }}");
  assert.equal(owner.with.candidate_head, "${{ inputs.candidate_head || '' }}");
  assert.equal(owner.with.max_parallel_tasks, "${{ inputs.max_parallel_tasks || '12' }}");
  // Only this workflow's boolean/string-equality expression subset; GitHub
  // string equality is case-insensitive. Actual reusable dispatch is hosted proof.
  const value = (expression, inputs, event = "workflow_dispatch") => new Function("inputs", "github", "startsWith", `return (${expression
    .replace(/^\$\{\{\s*|\s*\}\}$/gu, "")
    .replace(/(inputs\.\w+|github\.\w+)\s*([!=]=)\s*('[^']*')/gu, "String($1 ?? '').toLowerCase() $2 $3")});`)(inputs, { event_name: event }, (value, prefix) => String(value ?? "").toLowerCase().startsWith(prefix));
  const defaults = Object.fromEntries(Object.entries(dispatch).map(([name, input]) => [name, input.default ?? ""]));
  const ordinary = Object.keys(ci.jobs).filter((id) => id !== "canonical" && id !== "existing-os-suitability");
  assert.equal(ordinary.length, 15);
  const admitted = (inputs, event) => Object.entries(ci.jobs).filter(([, job]) => value(job.if, inputs, event)).map(([id]) => id);
  assert.deepEqual(admitted(defaults), ordinary);
  assert.deepEqual(admitted({ product_journey_mode: "all" }, "workflow_call"), ordinary);
  assert.deepEqual(admitted({ ...defaults, source_focused: true }), ["electron"]);
  assert.deepEqual(admitted({ ...defaults, source_canonical_contracts: true }), ["electron"]);
  assert.deepEqual(admitted({ ...defaults, source_focused: true, source_canonical_contracts: true }), ["electron"]);
  // Negative selection only: five unresolved jobs are deferred, never passed.
  // Every remaining job keeps its complete commands; the worker matrix is not a new executor.
  const independent = admitted({ ...defaults, independent_gates: true });
  assert.deepEqual(independent, [
    "quality", "frontend", "lfm-encoder-phase0", "browser", "webgl", "storybook",
    "security", "electron", "electron-windows-installer-contract",
    "nir1-c-query-worker",
  ]);
  // Default/reusable callers also reach the deferred jobs: protect all owners.
  for (const id of ordinary) {
    for (const step of ci.jobs[id].steps) {
      assert.doesNotMatch(step.run ?? "", /sudo\s+rm\s+-(?:rf|fr)\b/u, `${id} must not delete host caches`);
    }
  }
  assert.equal(ci.jobs["nir1-c-query-worker"].strategy["fail-fast"], false);
  assert.equal(ci.jobs["nir1-c-query-worker"].steps.at(-1).run, "bash scripts/nir1-c-query-worker-ci.sh");
  assert.deepEqual(admitted({ ...defaults, independent_gates: true, source_focused: true }), ["electron"]);
  assert.deepEqual(admitted({ ...defaults, independent_gates: true, source_canonical_contracts: true }), ["electron"]);
  for (const field of ["canonical_profile", "candidate_base", "candidate_head", "max_parallel_tasks"]) {
    for (const malformed of ["none", "NONE", " ", "0", "$(touch injected)"]) {
      assert.deepEqual(admitted({ ...defaults, [field]: malformed }), ["canonical"], `${field}=${malformed}`);
      assert.deepEqual(admitted({ ...defaults, independent_gates: true, [field]: malformed }), ["canonical"], `independent ${field}=${malformed}`);
    }
  }
  // Standalone selection reuses the complete ordinary Rust owner. Even mixed
  // inputs select only that owner, whose literal guard runs BEFORE any setup.
  const rust = ci.jobs.rust;
  const shared = { ...defaults, canonical_profile: "shared-rust" };
  assert.deepEqual(admitted(shared), ["rust"]);
  assert.equal(rust["runs-on"], "ubuntu-latest");
  assert.equal(rust["timeout-minutes"], 30);
  assert.deepEqual(rust.env, {
    CARGO_PROFILE_DEV_DEBUG: "0", CARGO_PROFILE_TEST_DEBUG: "0",
    OPENAI_API_KEY: "", OPENROUTER_API_KEY: "", OPEN_ROUTER_API_KEY: "",
    ANTHROPIC_API_KEY: "", SAKANA_API_KEY: "",
  });
  const sharedSelection = rust.steps[0];
  assert.equal(sharedSelection.name, "Validate standalone shared Rust selection");
  assert.equal(sharedSelection.if, "inputs.canonical_profile");
  assert.ok(rust.steps[1].uses.startsWith("actions/checkout@"));
  assert.doesNotMatch(sharedSelection.run, /\$\{\{ inputs\.|pnpm|cargo|sudo|\|\|\s*true/u);
  const executeShared = promisify(execFile);
  // Select the existing complete three-OS worker job without replaying other jobs.
  const workers = ci.jobs["nir1-c-query-worker"];
  const workerOnly = { ...defaults, canonical_profile: "c-query-workers" };
  assert.deepEqual(admitted(workerOnly), ["nir1-c-query-worker"]);
  assert.equal(workers["runs-on"], "${{ matrix.os }}");
  assert.equal(workers["timeout-minutes"], 45);
  const workerSelection = workers.steps[0];
  assert.equal(workerSelection.name, "Validate standalone C-query worker selection");
  assert.equal(workerSelection.if, "inputs.canonical_profile");
  assert.equal(workerSelection.shell, "bash");
  assert.deepEqual(workerSelection.env, sharedSelection.env);
  assert.ok(workers.steps[1].uses.startsWith("actions/checkout@"));
  assert.doesNotMatch(workerSelection.run, /\$\{\{ inputs\.|pnpm|cargo|sudo|\|\|\s*true/u);
  const validateWorkers = (inputs, event = "workflow_dispatch") => {
    assert.deepEqual(admitted(inputs, event), ["nir1-c-query-worker"]);
    const env = Object.fromEntries(Object.entries(workerSelection.env).map(([key, expression]) => [key, String(value(expression, inputs))]));
    return executeShared("bash", ["-c", workerSelection.run], { timeout: 10000, env: {
      ...process.env, ...env, GITHUB_EVENT_NAME: event,
    } });
  };
  const cancellationOnly = { ...defaults, canonical_profile: "c-query-cancellation" };
  const startupOnly = { ...defaults, canonical_profile: "c-query-startup-refusal" };
  const trailingOnly = { ...defaults, canonical_profile: "c-query-trailing-data" };
  const partialTerminalOnly = { ...defaults, canonical_profile: "c-query-partial-terminal" };
  const practicalOnly = { ...defaults, canonical_profile: "c-query-practical" };
  const frameLifecycleOnly = { ...defaults, canonical_profile: "c-query-frame-lifecycle" };
  const terminalRefusalsOnly = { ...defaults, canonical_profile: "c-query-terminal-refusals" };
  const workerProfiles = [workerOnly, cancellationOnly, startupOnly, trailingOnly, partialTerminalOnly, terminalRefusalsOnly, practicalOnly, frameLifecycleOnly];
  assert.equal(workers.strategy.matrix.os, "${{ fromJSON(inputs.canonical_profile == 'c-query-practical' && '[\"ubuntu-latest\"]' || '[\"ubuntu-latest\",\"macos-latest\",\"windows-latest\"]') }}");
  for (const standalone of workerProfiles) {
    await validateWorkers(standalone);
    await validateWorkers({ ...standalone, source_focused: "" });
    for (const inputs of [
      ...["independent_gates", "source_focused", "source_resolve_sharp", "source_audit_compat", "source_canonical_contracts"].flatMap((flag) =>
        [true, "FALSE", "0", "$(exit 0)"].map((value) => ({ ...standalone, [flag]: value }))),
      ...["candidate_base", "candidate_head", "max_parallel_tasks"].map((field) => ({ ...standalone, [field]: "not-empty" })),
      { ...standalone, product_journey_mode: "shadow" },
      { ...standalone, product_journey_mode: "ALL" },
      { ...standalone, canonical_profile: standalone.canonical_profile.toUpperCase() },
      { ...standalone, source_focused: true, source_canonical_contracts: true, candidate_head: "b".repeat(40) },
    ]) await assert.rejects(validateWorkers(inputs));
    for (const event of ["workflow_call", "schedule", "push"]) await assert.rejects(validateWorkers(standalone, event));
    for (const profile of [
      `${standalone.canonical_profile} `, ` ${standalone.canonical_profile}`,
      `${standalone.canonical_profile}$(exit 0)`, `${standalone.canonical_profile}-unknown`,
      ...["native-release-tests", "shared-rust", ...workerProfiles
        .filter((other) => other !== standalone).map((other) => other.canonical_profile)].flatMap((other) =>
        [`${standalone.canonical_profile},${other}`, `${other},${standalone.canonical_profile}`]),
    ]) assert.deepEqual(admitted({ ...standalone, canonical_profile: profile }), ["canonical"]);
  }
  assert.equal(workers.steps.length, 11);
  assert.deepEqual(workers.steps.slice(2, 4).map((step) => step.uses), [
    "dtolnay/rust-toolchain@29eef336d9b2848a0b548edc03f92a220660cdb8",
    "Swatinem/rust-cache@42dc69e1aa15d09112580998cf2ef0119e2e91ae",
  ]);
  assert.deepEqual(workers.steps[2].with, { toolchain: "stable" });
  assert.deepEqual(workers.steps[3].with, { workspaces: "src-tauri" });
  assert.deepEqual(workers.steps[4], {
    name: "Build private Q2 fixture and run caller-cancellation worker test",
    if: "inputs.canonical_profile == 'c-query-cancellation'",
    shell: "bash", run: "bash scripts/nir1-c-query-worker-ci.sh caller-cancellation",
  });
  assert.deepEqual(workers.steps[5], {
    name: "Build private Q2 fixture and run startup-registration-refusal worker test",
    if: "inputs.canonical_profile == 'c-query-startup-refusal'",
    shell: "bash", run: "bash scripts/nir1-c-query-worker-ci.sh startup-registration-refusal",
  });
  assert.deepEqual(workers.steps[6], {
    name: "Build private Q2 fixture and run committed-frame trailing-data worker test",
    if: "inputs.canonical_profile == 'c-query-trailing-data' || inputs.canonical_profile == 'c-query-terminal-refusals'",
    shell: "bash", run: "bash scripts/nir1-c-query-worker-ci.sh trailing-data",
  });
  assert.deepEqual(workers.steps[7], {
    name: "Build private Q2 fixture and run partial-terminal-marker worker test",
    if: "inputs.canonical_profile == 'c-query-partial-terminal' || inputs.canonical_profile == 'c-query-terminal-refusals'",
    shell: "bash", run: "bash scripts/nir1-c-query-worker-ci.sh partial-terminal-marker",
  });
  assert.deepEqual(workers.steps[8], {
    name: "Run finite Q512 retention and maximum-fixture worker tests",
    if: "inputs.canonical_profile == 'c-query-practical'",
    shell: "bash", run: "bash scripts/nir1-c-query-worker-ci.sh practical-retention",
  });
  assert.deepEqual(workers.steps[9], {
    name: "Run grouped Q2 partial-body and Linux missing-EOF worker tests",
    if: "inputs.canonical_profile == 'c-query-frame-lifecycle'",
    shell: "bash", run: "bash scripts/nir1-c-query-worker-ci.sh frame-lifecycle",
  });
  assert.deepEqual(workers.steps[10], {
    name: "Build private Q2/Q512 fixtures and run focused real-worker tests",
    if: "!inputs.canonical_profile || inputs.canonical_profile == 'c-query-workers'",
    shell: "bash", run: "bash scripts/nir1-c-query-worker-ci.sh",
  });
  const workerCommands = (inputs) => workers.steps.slice(4)
    .filter((step) => value(step.if, inputs)).map((step) => step.run);
  for (const inputs of [defaults, { product_journey_mode: "all" }, { ...defaults, independent_gates: true }, workerOnly]) {
    assert.deepEqual(workerCommands(inputs), ["bash scripts/nir1-c-query-worker-ci.sh"]);
  }
  assert.deepEqual(workerCommands(cancellationOnly), ["bash scripts/nir1-c-query-worker-ci.sh caller-cancellation"]);
  assert.deepEqual(workerCommands(startupOnly), ["bash scripts/nir1-c-query-worker-ci.sh startup-registration-refusal"]);
  assert.deepEqual(workerCommands(trailingOnly), ["bash scripts/nir1-c-query-worker-ci.sh trailing-data"]);
  assert.deepEqual(workerCommands(partialTerminalOnly), ["bash scripts/nir1-c-query-worker-ci.sh partial-terminal-marker"]);
  assert.deepEqual(workerCommands(terminalRefusalsOnly), [
    "bash scripts/nir1-c-query-worker-ci.sh trailing-data",
    "bash scripts/nir1-c-query-worker-ci.sh partial-terminal-marker",
  ]);
  const registry = JSON.parse(await readFile(path.join(repoRoot, "scripts/local-ci-registry.json"), "utf8"));
  assert.deepEqual(workerCommands(practicalOnly), ["bash scripts/nir1-c-query-worker-ci.sh practical-retention"]);
  assert.equal(Object.hasOwn(registry.profiles, "c-query-practical"), false);
  assert.deepEqual(workerCommands(frameLifecycleOnly), ["bash scripts/nir1-c-query-worker-ci.sh frame-lifecycle"]);
  assert.equal(Object.hasOwn(registry.profiles, "c-query-frame-lifecycle"), false);
  assert.equal(Object.hasOwn(registry.profiles, "c-query-cancellation"), false);
  assert.equal(Object.hasOwn(registry.profiles, "c-query-startup-refusal"), false);
  assert.equal(Object.hasOwn(registry.profiles, "c-query-trailing-data"), false);
  assert.equal(Object.hasOwn(registry.profiles, "c-query-partial-terminal"), false);
  assert.equal(Object.hasOwn(registry.profiles, "c-query-terminal-refusals"), false);
  assert.deepEqual(registry.stages.rust.commands.find(({ id }) => id === "rust.c-query-worker").args, ["scripts/nir1-c-query-worker-ci.sh"]);
  for (const step of workers.steps) assert.equal(step["continue-on-error"], undefined);
  const validateShared = (inputs, event = "workflow_dispatch") => {
    assert.deepEqual(admitted(inputs, event), ["rust"]);
    const env = Object.fromEntries(Object.entries(sharedSelection.env).map(([key, expression]) => [key, String(value(expression, inputs))]));
    return executeShared("bash", ["-c", sharedSelection.run], { timeout: 10000, env: {
      ...process.env, ...env, GITHUB_EVENT_NAME: event,
    } });
  };
  await validateShared(shared);
  const mixedShared = [
    ...["independent_gates", "source_focused", "source_resolve_sharp", "source_audit_compat", "source_canonical_contracts"].map((flag) => ({ ...shared, [flag]: true })),
    ...["candidate_base", "candidate_head", "max_parallel_tasks"].map((field) => ({ ...shared, [field]: "not-empty" })),
    { ...shared, product_journey_mode: "shadow" },
    { ...shared, product_journey_mode: "ALL" },
    { ...shared, canonical_profile: "SHARED-RUST" },
    { ...shared, source_focused: true, source_canonical_contracts: true, candidate_head: "b".repeat(40) },
  ];
  for (const inputs of mixedShared) await assert.rejects(validateShared(inputs));
  await assert.rejects(validateShared(shared, "workflow_call"));
  for (const malformed of ["shared-rust ", " shared-rust", "shared-rust$(exit 0)", "shared-rust-unknown"]) {
    assert.deepEqual(admitted({ ...shared, canonical_profile: malformed }), ["canonical"]);
  }
  assert.deepEqual(rust.steps.filter((step) => step["working-directory"] === "src-tauri").map((step) => step.run.trim()), [
    "cargo check --workspace --exclude grimodex --features grimodex-semantic/semantic-embedding",
    "cargo clippy --workspace --exclude grimodex --all-targets --features grimodex-semantic/semantic-embedding -- -D warnings",
    "cargo test --workspace --exclude grimodex --features grimodex-semantic/semantic-embedding",
    "cargo test -p grimodex-db --features test-failpoints --test workspace_migration_supervisor",
    "cargo test -p grimodex-db --test narrative_runtime_authority",
    "cargo test -p grimodex-license --features licensing",
  ]);
  for (const step of rust.steps) assert.equal(step["continue-on-error"], undefined);

  // Fixed original build, complete public/release tests, compile-only or licensed MCP steps on the existing owner.
  // These source assertions do not execute or admit any consumer lane.
  const native = ci.jobs["electron-native"];
  const nativeStatic = { ...defaults, canonical_profile: "native-release-static" };
  assert.deepEqual(admitted(nativeStatic), ["electron-native"]);
  assert.equal(native["runs-on"], "ubuntu-24.04");
  assert.equal(native["timeout-minutes"], 90);
  assert.deepEqual(native.env, {
    CARGO_PROFILE_DEV_DEBUG: "0", CARGO_PROFILE_TEST_DEBUG: "0",
  });
  const nativeSelection = native.steps[0];
  assert.equal(nativeSelection.name, "Validate standalone native selection");
  assert.equal(nativeSelection.if, "inputs.canonical_profile");
  assert.deepEqual(nativeSelection.env, sharedSelection.env);
  assert.ok(native.steps[1].uses.startsWith("actions/checkout@"));
  assert.doesNotMatch(nativeSelection.run, /\$\{\{ inputs\.|pnpm|cargo|sudo|\|\|\s*true/u);
  const validateNative = (inputs, event = "workflow_dispatch") => {
    assert.deepEqual(admitted(inputs, event), ["electron-native"]);
    const env = Object.fromEntries(Object.entries(nativeSelection.env).map(([key, expression]) => [key, String(value(expression, inputs))]));
    return executeShared("bash", ["-c", nativeSelection.run], { timeout: 10000, env: {
      ...process.env, ...env, GITHUB_EVENT_NAME: event,
    } });
  };
  const nativeMcp = { ...defaults, canonical_profile: "native-licensed-mcp" };
  const nativeBuild = { ...defaults, canonical_profile: "native-development-build" };
  const nativePublic = { ...defaults, canonical_profile: "native-development-tests" };
  const nativeRelease = { ...defaults, canonical_profile: "native-release-tests" };
  for (const standalone of [nativeBuild, nativePublic, nativeStatic, nativeRelease, nativeMcp]) {
    await validateNative(standalone);
    for (const inputs of [
      ...["independent_gates", "source_focused", "source_resolve_sharp", "source_audit_compat", "source_canonical_contracts"].map((flag) => ({ ...standalone, [flag]: true })),
      ...["candidate_base", "candidate_head", "max_parallel_tasks"].map((field) => ({ ...standalone, [field]: "not-empty" })),
      { ...standalone, product_journey_mode: "shadow" },
      { ...standalone, product_journey_mode: "ALL" },
      { ...standalone, canonical_profile: standalone.canonical_profile.toUpperCase() },
      { ...standalone, source_focused: "$(exit 0)" },
      { ...standalone, source_focused: true, source_canonical_contracts: true, candidate_head: "b".repeat(40) },
    ]) await assert.rejects(validateNative(inputs));
    await assert.rejects(validateNative(standalone, "workflow_call"));
    await assert.rejects(validateNative(standalone, "schedule"));
    for (const malformed of [
      `${standalone.canonical_profile} `, ` ${standalone.canonical_profile}`,
      `${standalone.canonical_profile}$(exit 0)`, `${standalone.canonical_profile}-unknown`,
      "native-release-static,native-licensed-mcp",
      "native-development-build,native-release-static",
      "native-development-build,native-licensed-mcp",
      "native-development-tests,native-development-build",
      "native-development-tests,native-release-static",
      "native-development-tests,native-licensed-mcp",
      ...[nativeBuild, nativePublic, nativeStatic, nativeMcp].flatMap(({ canonical_profile }) => [
        `native-release-tests,${canonical_profile}`, `${canonical_profile},native-release-tests`,
      ]),
    ]) {
      assert.deepEqual(admitted({ ...standalone, canonical_profile: malformed }), ["canonical"]);
    }
  }
  const nativeCommands = native.steps.filter(({ name }) => [
    "Build the development N-API module", "Test the development N-API module",
    "Check both release-only native features",
    "Clippy both release-only native features", "Test both release-only native features",
    "Test licensed MCP sidecar",
  ].includes(name));
  assert.equal(nativeCommands.length, 6);
  assert.match(nativeCommands[0].run, /else\n[ \t]+pnpm napi:build\n[ \t]*fi(?:\n|$)/u);
  assert.deepEqual(nativeCommands.map((step, index) => index === 0 ? "pnpm napi:build" : step.run.trim()), [
    "pnpm napi:build",
    "pnpm --dir electron/native/grimodex-node test",
    "cargo check --manifest-path electron/native/grimodex-node/Cargo.toml --features licensing,legacy-keyring-migration",
    "cargo clippy --manifest-path electron/native/grimodex-node/Cargo.toml --all-targets --features licensing,legacy-keyring-migration -- -D warnings",
    "cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --features licensing,legacy-keyring-migration",
    "cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-mcp --features licensing",
  ]);
  const buildCommands = nativeCommands.slice(0, 1);
  const publicCommands = nativeCommands.slice(0, 2);
  // Adjacent unchanged commands use the same job/workspace; implicit success()
  // prevents the unfiltered test command after build/setup failure or cancellation.
  assert.equal(native.steps.indexOf(publicCommands[1]), native.steps.indexOf(publicCommands[0]) + 1);
  const staticCommands = nativeCommands.slice(2, 4);
  const releaseCommands = nativeCommands.slice(4, 5);
  const mcpCommands = nativeCommands.slice(5);
  for (const step of native.steps.slice(1)) {
    assert.equal(step["continue-on-error"], undefined);
    assert.equal(step.if, buildCommands.includes(step)
      ? "!inputs.canonical_profile || inputs.canonical_profile == 'native-development-build' || inputs.canonical_profile == 'native-development-tests'"
      : publicCommands.includes(step)
        ? "!inputs.canonical_profile || inputs.canonical_profile == 'native-development-tests'"
        : staticCommands.includes(step)
          ? "!inputs.canonical_profile || inputs.canonical_profile == 'native-release-static'"
          : releaseCommands.includes(step)
            ? "!inputs.canonical_profile || inputs.canonical_profile == 'native-release-tests'"
            : mcpCommands.includes(step)
              ? "!inputs.canonical_profile || inputs.canonical_profile == 'native-licensed-mcp'"
              : step.name === "Upload native compile-only allocation observations"
                ? "always() && inputs.canonical_profile == 'native-development-build'"
                : undefined);
  }
  const selectedNative = (inputs) => nativeCommands.filter((step) => !step.if || value(step.if, inputs));
  assert.deepEqual(selectedNative(defaults), nativeCommands);
  assert.deepEqual(selectedNative({ product_journey_mode: "all" }), nativeCommands);
  assert.deepEqual(selectedNative(nativeBuild), buildCommands);
  assert.deepEqual(selectedNative(nativePublic), publicCommands);
  assert.deepEqual(selectedNative(nativeStatic), staticCommands);
  assert.deepEqual(selectedNative(nativeRelease), releaseCommands);
  assert.deepEqual(selectedNative(nativeMcp), mcpCommands);

  // Fixed selections of existing steps, not complete Gate A2 passes.
  // Default/reusable callers retain all eight tests and original bootstrap/cache.
  const migration = ci.jobs["migration-recovery-gate"];
  const crash = { ...defaults, canonical_profile: "migration-crash" };
  assert.deepEqual(admitted(crash), ["migration-recovery-gate"]);
  assert.equal(migration["runs-on"], "ubuntu-latest");
  assert.equal(migration["timeout-minutes"], 45);
  assert.deepEqual(migration.env, {
    CARGO_PROFILE_DEV_DEBUG: "0", CARGO_PROFILE_TEST_DEBUG: "0",
  });
  const crashSelection = migration.steps[0];
  assert.equal(crashSelection.name, "Validate standalone migration selection");
  assert.equal(crashSelection.if, "inputs.canonical_profile");
  assert.deepEqual(crashSelection.env, sharedSelection.env);
  assert.ok(migration.steps[1].uses.startsWith("actions/checkout@"));
  assert.doesNotMatch(crashSelection.run, /\$\{\{ inputs\.|pnpm|cargo|sudo|\|\|\s*true/u);
  const validateCrash = (inputs, event = "workflow_dispatch") => {
    assert.deepEqual(admitted(inputs, event), ["migration-recovery-gate"]);
    const env = Object.fromEntries(Object.entries(crashSelection.env).map(([key, expression]) => [key, String(value(expression, inputs))]));
    return executeShared("bash", ["-c", crashSelection.run], { timeout: 10000, env: {
      ...process.env, ...env, GITHUB_EVENT_NAME: event,
    } });
  };
  for (const profile of ["migration-crash", "migration-safe-mode", "migration-library", "migration-remaining"]) {
    const selected = { ...defaults, canonical_profile: profile };
    await validateCrash(selected);
    for (const inputs of [
      ...["independent_gates", "source_focused", "source_resolve_sharp", "source_audit_compat", "source_canonical_contracts"].map((flag) => ({ ...selected, [flag]: true })),
      ...["candidate_base", "candidate_head", "max_parallel_tasks"].map((field) => ({ ...selected, [field]: "not-empty" })),
      { ...selected, product_journey_mode: "shadow" },
      { ...selected, product_journey_mode: "ALL" },
      { ...selected, canonical_profile: profile.toUpperCase() },
      { ...selected, source_focused: "$(exit 0)" },
      { ...selected, source_focused: true, source_canonical_contracts: true, candidate_head: "b".repeat(40) },
    ]) await assert.rejects(validateCrash(inputs));
    await assert.rejects(validateCrash(selected, "workflow_call"));
    await assert.rejects(validateCrash(selected, "schedule"));
    for (const malformed of [`${profile} `, ` ${profile}`, `${profile}$(exit 0)`, `${profile}-unknown`]) {
      assert.deepEqual(admitted({ ...selected, canonical_profile: malformed }), ["canonical"]);
    }
  }
  const migrationTests = migration.steps.filter(({ name }) => [
    "Migration supervisor unit/integration", "Migration supervisor failpoint suite",
    "Migration recovery failpoint library tests", "Safe Mode structured outcome + restore-by-id",
    "Real release-schema fixture + WAL preservation", "Subprocess crash recovery",
    "Safe Mode IPC contract", "Recovery Shell frontend tests",
  ].includes(name));
  assert.equal(migrationTests.length, 8);
  const remainingTests = migrationTests.filter(({ name }) => [
    "Migration supervisor unit/integration", "Real release-schema fixture + WAL preservation",
    "Safe Mode IPC contract", "Recovery Shell frontend tests",
  ].includes(name));
  assert.equal(remainingTests.length, 4);
  for (const step of migration.steps.slice(1)) {
    assert.equal(step["continue-on-error"], undefined);
    const profile = step.name === "Subprocess crash recovery" ? "migration-crash"
      : step.name === "Safe Mode structured outcome + restore-by-id" ? "migration-safe-mode"
      : step.name === "Migration recovery failpoint library tests" ? "migration-library"
      : remainingTests.includes(step) ? "migration-remaining" : undefined;
    assert.equal(step.if, profile ? `!inputs.canonical_profile || inputs.canonical_profile == '${profile}'`
      : migrationTests.includes(step) ? "!inputs.canonical_profile" : undefined);
  }
  assert.deepEqual(migrationTests.map((step) => step.run.trim()), [
    "cargo test -p grimodex-db --test workspace_migration_supervisor",
    "cargo test -p grimodex-db --features test-failpoints --test workspace_migration_supervisor",
    "cargo test -p grimodex-db --features test-failpoints --lib",
    "cargo test -p grimodex-db --features test-failpoints --test workspace_safe_mode_outcome",
    "cargo test -p grimodex-db --test release_schema_migration",
    "cargo test -p grimodex-db --features test-failpoints --test migration_subprocess_crash --test restore_subprocess_crash",
    "pnpm test:electron --run electron/shared/ipcContract.test.ts",
    "pnpm test --run src/features/workspace/store.test.ts src/features/workspace/recovery/RecoveryShell.test.tsx",
  ]);
  const crashTest = migrationTests.find(({ name }) => name === "Subprocess crash recovery");
  const safeTest = migrationTests.find(({ name }) => name === "Safe Mode structured outcome + restore-by-id");
  const libraryTest = migrationTests.find(({ name }) => name === "Migration recovery failpoint library tests");
  assert.equal(crashTest["working-directory"], "src-tauri");
  assert.equal(safeTest["working-directory"], "src-tauri");
  assert.equal(libraryTest["working-directory"], "src-tauri");
  const selectedTests = (inputs) => migrationTests.filter((step) => !step.if || value(step.if, inputs));
  assert.deepEqual(selectedTests(defaults), migrationTests);
  assert.deepEqual(selectedTests({ product_journey_mode: "all" }), migrationTests);
  assert.deepEqual(selectedTests(crash), [crashTest]);
  assert.deepEqual(selectedTests({ ...defaults, canonical_profile: "migration-safe-mode" }), [safeTest]);
  assert.deepEqual(selectedTests({ ...defaults, canonical_profile: "migration-library" }), [libraryTest]);
  assert.deepEqual(selectedTests({ ...defaults, canonical_profile: "migration-remaining" }), remainingTests);
  assert.deepEqual(remainingTests.map((step) => step["working-directory"]), ["src-tauri", "src-tauri", undefined, undefined]);

  const selection = workflow.jobs.canonical.steps.find(({ name }) => name === "Validate canonical selection");
  assert.equal(selection.if, undefined);
  assert.ok(workflow.jobs.canonical.steps.indexOf(selection) < workflow.jobs.canonical.steps.findIndex(({ uses }) => uses?.startsWith("actions/checkout@")));
  const execute = promisify(execFile);
  const head = "b".repeat(40);
  const mapped = (inputs) => Object.fromEntries(Object.entries(owner.with).map(([key, expression]) => [key, value(expression, inputs)]));
  const validate = (inputs) => {
    assert.deepEqual(admitted(inputs), ["canonical"]);
    const args = mapped(inputs);
    return execute("bash", ["-c", selection.run], { timeout: 10000, env: {
      ...process.env, PROFILE: args.profile, REQUESTED_BASE: args.candidate_base,
      EXPECTED_HEAD: args.candidate_head, MAX_PARALLEL_TASKS: args.max_parallel_tasks, GITHUB_SHA: head,
    } });
  };
  const contracts = { ...defaults, canonical_profile: "contracts" };
  assert.equal(mapped(contracts).max_parallel_tasks, "12");
  await validate(contracts);
  const quick = { ...defaults, canonical_profile: "quick", candidate_base: "a".repeat(40), candidate_head: head, max_parallel_tasks: "3" };
  await validate(quick); // Validation only; no canonical profile or resource probe.
  await validate({ ...quick, canonical_profile: "full" }); // Step0 still denies Full.
  for (const inputs of [
    ...["none", "NONE", "CONTRACTS", "unknown", " ", "$(touch injected)"].map((canonical_profile) => ({ ...contracts, canonical_profile })),
    ...["independent_gates", "source_focused", "source_resolve_sharp", "source_audit_compat", "source_canonical_contracts"].map((flag) => ({ ...contracts, [flag]: true })),
    { ...quick, independent_gates: true },
    { ...quick, canonical_profile: "full", independent_gates: true },
    { ...contracts, product_journey_mode: "shadow" },
    { ...contracts, candidate_base: quick.candidate_base },
    { ...contracts, candidate_head: head },
    { ...quick, candidate_head: "c".repeat(40) },
    { ...quick, candidate_base: "$(touch injected)" },
    ...["0", "13", "$(touch injected)"].map((max_parallel_tasks) => ({ ...contracts, max_parallel_tasks })),
    { ...defaults, candidate_base: quick.candidate_base },
    { ...defaults, candidate_head: head },
    { ...defaults, max_parallel_tasks: "3" },
  ]) await assert.rejects(validate(inputs));
});

test("C-query opt-in scripts fail closed and preserve the original default commands", async () => {
  const source = await readFile(path.join(repoRoot, "scripts/nir1-c-query-worker-ci.sh"), "utf8");
  assert.ok(source.indexOf('exit 2') < source.indexOf('repo_root='));
  const originalCases = [
    "native_worker_returns_fixed_q2_frame_from_real_workspace_owner",
    "native_worker_quarantines_live_request_writer_after_cleanup_timeout",
    "native_worker_returns_canonical_512_a3_eligible_seed_local_graph",
    "native_worker_refuses_exact_513_seed_local_unrelated_reverse_index_edge",
    "native_worker_crashes_after_q2_ack_before_frame",
    "native_worker_refuses_after_actual_sql_steps_over_cap",
    "native_worker_rejects_request_and_frame_length_n_plus_one",
    "native_worker_accepts_committed_q2_frame_before_nonzero_exit",
    "malformed_child_frame_rejected_before_view",
    "native_region_bounds_request_and_frame",
    "q_s_origins_no_fallback_failed_realloc_and_zero_live_seal",
  ];
  const cancellation = "native_worker_cancels_after_request_admission_and_retires_before_reloan";
  const startup = "native_worker_reports_canonical_registration_refusal_before_ready";
  const trailing = "native_worker_rejects_committed_q2_frame_with_trailing_data";
  const partialTerminal = "native_worker_rejects_complete_q2_frame_with_partial_terminal_marker";
  const optInCases = { "caller-cancellation": cancellation, "startup-registration-refusal": startup, "trailing-data": trailing, "partial-terminal-marker": partialTerminal };
  const practicalCases = ["native_worker_practical_retention_q512_30x", "native_worker_returns_canonical_512_a3_eligible_seed_local_graph"];
  const frameLifecycleCases = ["native_worker_rejects_declared_q2_frame_with_partial_body", "native_worker_refuses_committed_q2_frame_without_eof"];
  const requestWriterPanic = "request_writer_panic_keeps_claim_quarantined_after_handle_consumption";
  const owner = await readFile(path.join(repoRoot, "src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_graph/c_query_worker.rs"), "utf8");
  assert.match(owner, /#\[ignore = "isolated panic-join regression; intentionally retains quarantined workspace claims"\]\s*fn request_writer_panic_keeps_claim_quarantined_after_handle_consumption\(\)/u);
  const optInArgs = [...Object.keys(optInCases), "practical-retention", "frame-lifecycle"];
  const tests = await readFile(path.join(repoRoot, "src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_graph/tests.rs"), "utf8");
  for (const name of [...Object.values(optInCases), ...frameLifecycleCases]) assert.match(tests, new RegExp(`fn ${name}\\(\\)`));
  const temporary = await mkdtemp(path.join(tmpdir(), "c-query-script-contract-"));
  const bin = path.join(temporary, "bin");
  const fixtureRoot = path.join(temporary, "fixtures");
  const calls = path.join(temporary, "calls.jsonl");
  const script = path.join(temporary, "scripts/nir1-c-query-worker-ci.sh");
  const execute = promisify(execFile);
  try {
    await mkdir(bin);
    await mkdir(fixtureRoot);
    await mkdir(path.dirname(script));
    await writeFile(script, source);
    // Only script-path contracts: no Cargo/Rust/SQLite/worker consumer is executed.
    const stub = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify({ command, args }) + '\\n');
if (process.env.DENY_CONSUMER === '1') process.exit(97);
if (command === 'uname') console.log(process.env.MOCK_WINDOWS === '1' ? 'MINGW64_NT' : process.env.MOCK_MACOS === '1' ? 'Darwin' : 'Linux');
else if (command === 'cygpath') console.log(args.at(-1));
else if (command === 'mktemp') console.log(fs.mkdtempSync(args.at(-1).slice(0, -6)));
else if (args[0] === 'run') {
  const file = args.at(-1);
  const q2 = args.at(-2) === 'Q2/R1/D0-local';
  fs.writeFileSync(file, 'synthetic closed script-contract source');
  console.log(JSON.stringify({ caseId: args.at(-2), diagnosticOnly: true,
    qualifiedMaterials: q2 ? 2 : 140, qualifiedRevisions: 1, ineligibleCandidates: 0,
    walBytes: 0, shmBytes: 0, reopenedReadOnly: process.env.FAIL_PHASE !== 'report' }, null, 2));
} else if (args[0] === 'build') {
  if (process.env.FAIL_PHASE === 'build') process.exit(7);
  fs.mkdirSync('src-tauri/target/release', { recursive: true });
  fs.writeFileSync('src-tauri/target/release/nir1-c-query-worker' + (process.env.MOCK_WINDOWS === '1' ? '.exe' : ''), 'not an executable');
} else if (args[0] === 'test') {
  const practical = process.env.NIR1_C_QUERY_PRACTICAL_OBSERVE === '1';
  const frameLifecycle = args.includes('${frameLifecycleCases[0]}') || args.includes('${frameLifecycleCases[1]}');
  if (args.includes('${requestWriterPanic}')) {
    if (practical || process.env.NIR1_Q2_FIXTURE_PATH || process.env.NIR1_C_QUERY_WORKER_BIN) process.exit(8);
    if (process.env.FAIL_CASE === 'writer-panic' && process.env.FAIL_PHASE === 'test') process.exit(9);
  } else if (practical || frameLifecycle || args.includes('${cancellation}') || args.includes('${startup}') || args.includes('${trailing}') || args.includes('${partialTerminal}')) {
    const file = process.env.NIR1_Q2_FIXTURE_PATH;
    const expected = practical ? (args.includes('${practicalCases[0]}') ? 'q512-worker-input.db' : 'q512-maximum-worker-input.db') : args.includes('${frameLifecycleCases[1]}') ? 'q2-missing-eof-worker-input.db' : 'q2-worker-input.db';
    if (!file?.endsWith(expected) || !fs.existsSync(process.env.NIR1_C_QUERY_WORKER_BIN)) process.exit(8);
    if (frameLifecycle && (fs.readFileSync(file, 'utf8') !== 'synthetic closed script-contract source' || ['-wal', '-shm', '-journal'].some(suffix => fs.existsSync(file + suffix)))) process.exit(8);
    if (process.env.FAIL_CASE !== 'writer-panic' && (process.env.FAIL_CASE !== 'maximum' || expected === 'q512-maximum-worker-input.db') && (process.env.FAIL_CASE !== 'missing-eof' || expected === 'q2-missing-eof-worker-input.db')) {
      if (process.env.FAIL_PHASE === 'test') process.exit(9);
      if (process.env.FAIL_PHASE === 'input') fs.appendFileSync(file, 'mutation');
      if (process.env.FAIL_PHASE === 'source') fs.appendFileSync(path.join(path.dirname(file), practical ? 'q512-preseed.db' : 'q2-preseed.db'), 'mutation');
      if (process.env.FAIL_PHASE === 'sidecar') fs.writeFileSync(file + '-wal', 'sidecar');
    }
  }
} else process.exit(96);
`;
    for (const command of ["uname", "cygpath", "mktemp", "cargo"]) {
      await writeFile(path.join(bin, command), stub, { mode: 0o755 });
    }
    const shell = (args, overrides = {}) => execute("bash", [script, ...args], { timeout: 10000, env: {
      ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CALLS: calls,
      RUNNER_TEMP: fixtureRoot, RUNNER_OS: "Linux", MOCK_WINDOWS: "0", MOCK_MACOS: "0", FAIL_PHASE: "", FAIL_CASE: "", DENY_CONSUMER: "0", ...overrides,
    } });
    const recorded = async () => (await readFile(calls, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    for (const args of [[""], ["--help"], ["$(touch injected)"],
      ...optInArgs.flatMap((arg) => [
        [arg.toUpperCase()], [`${arg} `], [` ${arg}`], [`${arg}$(touch injected)`],
        [`${arg}-unknown`], [arg, ""], [arg, arg],
        ...optInArgs.filter((other) => other !== arg).flatMap((other) => [[arg, other], [`${arg},${other}`]]),
      ]),
    ]) {
      await assert.rejects(shell(args, { DENY_CONSUMER: "1" }), (error) => error.code === 2);
      await assert.rejects(access(calls));
      assert.deepEqual(await readdir(fixtureRoot), []);
    }
    for (const runnerOS of ["Linux", "macOS", "Windows"]) {
      const windows = runnerOS === "Windows";
      const platform = { MOCK_WINDOWS: windows ? "1" : "0", MOCK_MACOS: runnerOS === "macOS" ? "1" : "0", RUNNER_OS: runnerOS };
      for (const args of [[], ...optInArgs.map((arg) => [arg])]) {
        await writeFile(calls, "");
        if (runnerOS !== "Linux" && args[0] === "practical-retention") {
          await assert.rejects(shell(args, platform), (error) => error.code === 2);
          assert.deepEqual((await recorded()).map(({ command }) => command), ["uname"]);
          assert.deepEqual(await readdir(fixtureRoot), []);
          continue;
        }
        await shell(args, platform);
        const commands = (await recorded()).filter(({ command }) => command === "cargo").map(({ args }) => args);
        assert.ok(commands.every((args) => ["--locked", "--release", "--manifest-path"].every((flag) => args.includes(flag))));
        assert.ok(commands.every((args) => args[args.indexOf("--manifest-path") + 1] === "src-tauri/Cargo.toml"));
        const selectedCases = commands.filter((args) => args[0] === "test").map((args) => args[args.indexOf("--") - 1]);
        const practical = args[0] === "practical-retention";
        const frameLifecycle = args[0] === "frame-lifecycle";
        assert.deepEqual(selectedCases, practical ? practicalCases : frameLifecycle ? [...frameLifecycleCases.slice(0, runnerOS === "Linux" ? 2 : 1), requestWriterPanic] : args.length ? [optInCases[args[0]]] : originalCases);
        if (frameLifecycle) assert.deepEqual(commands.at(-1), ["test", "--locked", "--release", "--manifest-path", "src-tauri/Cargo.toml", "-p", "grimodex-db", "--lib", requestWriterPanic, "--", "--ignored", "--nocapture", "--test-threads=1"]);
        assert.deepEqual(commands.filter((args) => args[0] === "run").map((args) => args.at(-2)), practical ? ["Q512/R2/A3-eligible-shared"] : args.length ? ["Q2/R1/D0-local"] : ["Q2/R1/D0-local", "Q512/R2/A3-eligible-shared"]);
        assert.deepEqual(commands.filter((args) => args[0] === "build").map((args) => args.includes("--features") ? args[args.indexOf("--features") + 1] : "default"), args.length ? [practical || args[0] === "startup-registration-refusal" ? "default" : "nir1-c-query-test-seam"] : ["default", "nir1-c-query-test-seam"]);
        if (args.length) assert.deepEqual(commands.at(-1).slice(-4), ["--", "--ignored", "--nocapture", "--test-threads=1"]);
        assert.deepEqual(await readdir(fixtureRoot), [], "owned trap must remove only its private fixture directory");
      }
      await writeFile(calls, "");
      await assert.rejects(shell(["frame-lifecycle"], { ...platform, FAIL_CASE: "writer-panic", FAIL_PHASE: "test" }), (error) => error.code === 9);
      const failedTests = (await recorded()).filter(({ command, args }) => command === "cargo" && args[0] === "test");
      assert.deepEqual(failedTests.map(({ args }) => args[args.indexOf("--") - 1]), [...frameLifecycleCases.slice(0, runnerOS === "Linux" ? 2 : 1), requestWriterPanic]);
      assert.deepEqual(await readdir(fixtureRoot), [], "final panic-test failure must retain owned EXIT cleanup");
    }
    for (const arg of optInArgs) {
      for (const phase of ["report", "build", "test", "input", "source", ...(arg === "practical-retention" ? [] : ["sidecar"])]) {
        await writeFile(calls, "");
        await assert.rejects(shell([arg], { FAIL_PHASE: phase }));
        const commands = (await recorded()).filter(({ command }) => command === "cargo").map(({ args }) => args);
        assert.deepEqual(commands.map((args) => args[0]), phase === "report" ? ["run"] : phase === "build" ? ["run", "build"] : ["run", "build", "test"]);
        assert.deepEqual(await readdir(fixtureRoot), []);
      }
    }
    for (const phase of ["test", "input", "source"]) {
      await writeFile(calls, "");
      await assert.rejects(shell(["practical-retention"], { FAIL_CASE: "maximum", FAIL_PHASE: phase }));
      const commands = (await recorded()).filter(({ command }) => command === "cargo").map(({ args }) => args);
      assert.deepEqual(commands.map((args) => args[0]), ["run", "build", "test", "test"]);
      assert.deepEqual(await readdir(fixtureRoot), []);
    }
    for (const phase of ["test", "input", "source", "sidecar"]) {
      await writeFile(calls, "");
      await assert.rejects(shell(["frame-lifecycle"], { FAIL_CASE: "missing-eof", FAIL_PHASE: phase }));
      const commands = (await recorded()).filter(({ command }) => command === "cargo").map(({ args }) => args);
      assert.deepEqual(commands.map((args) => args[0]), ["run", "build", "test", "test"]);
      assert.deepEqual(await readdir(fixtureRoot), []);
    }
    // Read-only SQLite inspection may leave owned input WAL/SHM; fresh maximum
    // input and the immutable builder source must not borrow those sidecars.
    await writeFile(calls, "");
    const withSidecars = await shell(["practical-retention"], { FAIL_PHASE: "sidecar" });
    assert.equal((withSidecars.stdout.match(/Native practical input resources:/gu) ?? []).length, 6);
    for (const role of ["retention", "maximum"]) assert.ok(withSidecars.stdout.includes(`role=${role}; suffix=-wal; bytes=7`));
    assert.deepEqual(await readdir(fixtureRoot), []);
    await assert.rejects(access(path.join(temporary, "injected")));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("grouped setup observations preserve contracts/defaults and exclude other profiles", async () => {
  const { jobs: { canonical: { steps } } } = await readWorkflow(".github/workflows/canonical-ci.yml");
  const observation = steps.find(({ id }) => id === "setup_observation");
  assert.equal(observation.if, "inputs.profile == 'contracts'");
  assert.equal(observation.env.PNPM_OBSERVATION_DEST, "${{ steps.pnpm_setup.outputs.dest }}");
  const pnpm = steps.find(({ id }) => id === "pnpm_setup");
  assert.equal(pnpm.with.version, "10.33.0");
  assert.ok(steps.indexOf(observation) > steps.findIndex(({ run }) => run === "pnpm install --frozen-lockfile"));
  assert.ok(steps.indexOf(observation) < steps.findIndex(({ id }) => id === "contracts"));
  assert.match(observation.run, /umask 077[\s\S]*local-ci-setup-observation\.mjs installed/u);
  const reports = steps.find(({ name }) => name === "Observe canonical local report allocation");
  assert.equal(reports.if, "always() && inputs.profile == 'contracts' && steps.contracts.outcome != 'skipped'");
  assert.match(reports.run, /local-ci-setup-observation\.mjs reports/u);
  const prefixes = [["home", "/synthetic/home"], ["workspace", "/synthetic/home/work"]];
  assert.equal(normalizedDestination("/synthetic/home/work/node_modules", prefixes), "workspace/node_modules");
  assert.throws(() => normalizedDestination("/synthetic/home-other/private", prefixes));
  assert.throws(() => normalizedDestination("relative", prefixes));
  assert.throws(() => normalizedDestination("/synthetic/home/\nsecret", prefixes));
});

test("setup allocation counts physical/logical/kind/hardlink metadata without following links or inventing incomplete totals", async () => {
  const source = `
import importlib.util, json, os, pathlib, subprocess, sys, tempfile, types
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('allocation', 'scripts/local-ci-setup-allocation.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temporary:
    root = pathlib.Path(temporary)
    a = root / 'a'; b = root / 'b'; a.mkdir(); b.mkdir()
    payload = a / 'public'; payload.write_bytes(b'synthetic' * 4096)
    os.link(payload, b / 'same'); os.link(payload, a / 'alias')
    sparse = a / 'sparse'
    with sparse.open('wb') as file: file.truncate(1024 * 1024)
    outside = root / 'outside'; outside.mkdir(); (outside / 'never-read').write_bytes(b'x' * 100000)
    os.symlink(outside, a / 'link')
    result = m.observe([('first', str(a)), ('second', str(b))])
    assert all(c['status'] == 'observed' for c in result['components'])
    first = result['components'][0]
    assert first['uniqueInodes'] == '4'  # directory, two files, link
    expected = sum(os.lstat(p).st_blocks * 512 for p in [a, b, payload, sparse, a / 'link'])
    assert result['coexistence'][0]['allocatedBytes'] == str(expected)
    assert result['coexistence'][0]['uniqueInodes'] == '5'  # hardlink counted only once
    assert first['regularLogicalBytes'] == str(payload.stat().st_size + sparse.stat().st_size)
    assert first['regularPathLogicalBytes'] == str(2 * payload.stat().st_size + sparse.stat().st_size)
    assert first['kinds'] == {'regular': {'paths': '3', 'uniqueInodes': '2'}, 'directory': {'paths': '1', 'uniqueInodes': '1'}, 'symlink': {'paths': '1', 'uniqueInodes': '1'}}
    assert first['hardlinkAliases'] == '1'
    assert first['regularInodesWithMultipleLinks'] == '1'
    assert result['components'][1]['hardlinkAliases'] == '0'  # other aliases are not enumerated here
    assert result['components'][1]['regularInodesWithMultipleLinks'] == '1'
    assert str(root) not in json.dumps(result)  # no raw member paths
    limited = m.observe([('bounded', str(a))], max_entries=1)
    assert limited['components'][0]['allocatedBytes'] is None
    assert limited['components'][0]['uniqueInodes'] is None
    for field in ['regularLogicalBytes', 'regularPathLogicalBytes', 'kinds', 'hardlinkAliases', 'regularInodesWithMultipleLinks']:
        assert limited['components'][0][field] is None
    assert limited['components'][0]['status'] == 'bounded-walk-incomplete'
    missing = m.observe([('absent', str(root / 'absent'))])
    assert missing['components'][0]['allocatedBytes'] is None
    os.symlink(a, root / 'redirect')
    redirected = m.observe([('redirected', str(root / 'redirect' / 'public'))])
    assert redirected['components'][0]['allocatedBytes'] is None
    assert m.observe([('deadline', str(a))], seconds=0)['components'][0]['allocatedBytes'] is None
    for count, expected_code in [(17, 0), (18, 1)]:
        bounded_roots = [[f'root-{index}', str(payload)] for index in range(count)]
        cli = subprocess.run([sys.executable, 'scripts/local-ci-setup-allocation.py', json.dumps(bounded_roots)], capture_output=True, text=True, timeout=5)
        assert cli.returncode == expected_code
        if count == 17: assert len(json.loads(cli.stdout)['components']) == 17
    fifo = root / 'fifo'; os.mkfifo(fifo)
    assert m.observe([('special', str(root))])['components'][0]['regularLogicalBytes'] is None
    original_stat = os.stat
    def changed_stat(name, **kwargs):
        info = original_stat(name, **kwargs)
        if name not in ['alias', 'same']: return info
        changed = types.SimpleNamespace(**{key: getattr(info, key) for key in dir(info) if key.startswith('st_')})
        changed.st_size += 1  # same inode/blocks, different logical length
        return changed
    with patch.object(m.os, 'stat', changed_stat):
        changed = m.observe([('changed', str(a))])['components'][0]
        assert changed['status'] == 'changed-shared-inode-incomplete' and changed['kinds'] is None
        cross = m.observe([('first', str(payload)), ('second', str(b / 'same'))])
        assert cross['status'] == 'changed-shared-inode' and cross['coexistence'] is None
print('synthetic allocation adversaries passed')
`;
  await promisify(execFile)("python3", ["-c", source], { cwd: repoRoot, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, timeout: 10000 });
});

for (const payloadCase of ["internal", "workspace-sibling", "installer-root"]) test(`installed observation confines the exact pnpm package without inferring bootstrap v3: ${payloadCase}`, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "canonical-installed-observation-"));
  try {
    const evidence = path.join(temporary, ".artifacts/canonical-source");
    const installer = path.join(temporary, "setup-pnpm");
    const packageRoot = payloadCase === "internal"
      ? path.join(installer, "node_modules/.pnpm/pnpm@10.33.0/node_modules/pnpm")
      : payloadCase === "installer-root" ? installer : path.join(temporary, "setup-pnpm-other/node_modules/pnpm");
    const store = path.join(temporary, "store/v10");
    const bin = path.join(temporary, "bin");
    for (const directory of [evidence, path.join(installer, "node_modules"), packageRoot, store, bin]) await mkdir(directory, { recursive: true });
    await symlink(packageRoot, path.join(installer, "node_modules/pnpm"));
    const identity = { commitSha: "a".repeat(40), treeSha: "b".repeat(40) };
    await writeFile(path.join(evidence, "checkout-identity.json"), JSON.stringify(identity));
    for (const file of [".github/workflows/canonical-ci.yml", "scripts/local-ci-setup-observation.mjs", "scripts/local-ci-setup-allocation.py", "pnpm-lock.yaml", "package.json"]) {
      await mkdir(path.dirname(path.join(temporary, file)), { recursive: true });
      await writeFile(path.join(temporary, file), await readFile(path.join(repoRoot, file)));
    }
    // Routing-only children: no installer, real toolchain scan or bootstrap query.
    for (const [name, body] of Object.entries({
      pnpm: 'if [ "$1" = "--version" ]; then printf "10.33.0\\n"; else printf "%s\\n" "$SYNTHETIC_STORE"; fi',
      rustup: 'printf "stable-x86_64-unknown-linux-gnu (default)\\n"',
      rustc: 'printf "rustc 1.90.0 (synthetic)\\n"',
    })) await writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    await writeFile(path.join(temporary, "scripts/local-ci-setup-allocation.py"), `import json, os, sys
open('.allocation-invoked', 'x').close()
roots = json.loads(sys.argv[1]); selected = dict(roots)
assert len(roots) == 17
assert selected['pnpm-payload'] == os.path.realpath(os.path.join(selected['pnpm-installed'], 'node_modules/pnpm'))
assert selected['pnpm-store'].endswith('/v10')
assert not any('bootstrap' in key for key in selected)
print(json.dumps({'components': [{'id': key} for key in selected]}))
`);
    const invoke = () => promisify(execFile)(process.execPath, [path.join(repoRoot, "scripts/local-ci-setup-observation.mjs"), "installed"], {
      cwd: temporary, timeout: 20000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SYNTHETIC_STORE: store,
        SETUP_OBSERVATION_PROFILE: "contracts", PNPM_OBSERVATION_DEST: installer,
        RUNNER_TOOL_CACHE: path.dirname(path.dirname(process.execPath)), CARGO_HOME: path.join(temporary, ".cargo"), RUSTUP_HOME: path.join(temporary, ".rustup"),
        GITHUB_SHA: identity.commitSha, GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1" },
    });
    if (payloadCase !== "internal") {
      // Recognized workspace and a shared lexical prefix are not installer scope.
      await assert.rejects(invoke(), (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /grouped setup allocation observation failed/u);
        assert.ok(!error.stderr.includes(temporary));
        return true;
      });
      const pending = path.join(evidence, "allocation-installed-pending.json");
      assert.equal(JSON.parse(await readFile(pending, "utf8")).runId, "1");
      assert.equal((await stat(pending)).mode & 0o777, 0o600);
      await assert.rejects(access(path.join(evidence, "allocation-installed.json")));
      await assert.rejects(access(path.join(temporary, ".allocation-invoked")));
      await assert.rejects(access(path.join(temporary, ".artifacts/local-ci/setup-observation-installed/allocation.stdout.log")));
      return;
    }
    await invoke();
    const output = await readFile(path.join(evidence, "allocation-installed.json"), "utf8");
    const result = JSON.parse(output);
    assert.equal(result.destinations["pnpm-payload"], "workspace/setup-pnpm/node_modules/.pnpm/pnpm@10.33.0/node_modules/pnpm");
    assert.equal(result.provenance.installedStore.destination, "workspace/store/v10");
    assert.equal(result.provenance.pnpmInstaller.destination, "workspace/setup-pnpm");
    assert.equal(result.provenance.bootstrapStore.status, "unobserved");
    assert.equal(result.provenance.bootstrapStore.destination, null);
    assert.ok(result.children.every(({ cleanup }) => cleanup.complete && !cleanup.groupAlive));
    assert.ok(result.unobserved.some((entry) => entry.includes("bootstrap")));
    assert.ok(!output.includes(temporary));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("setup observation writes current bound reports once and retains pending ownership on reentry/stale identity", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "canonical-observation-"));
  try {
    const evidence = path.join(temporary, ".artifacts/canonical-source");
    await mkdir(evidence, { recursive: true });
    const identity = { commitSha: "a".repeat(40), treeSha: "b".repeat(40), event: "workflow_dispatch", ref: "refs/heads/synthetic", sha: "a".repeat(40) };
    await writeFile(path.join(evidence, "checkout-identity.json"), JSON.stringify(identity));
    await writeFile(path.join(evidence, "contracts.tap"), "synthetic report only\n");
    for (const file of [".github/workflows/canonical-ci.yml", "scripts/local-ci-setup-observation.mjs", "scripts/local-ci-setup-allocation.py", "pnpm-lock.yaml", "package.json"]) {
      await mkdir(path.dirname(path.join(temporary, file)), { recursive: true });
      await writeFile(path.join(temporary, file), await readFile(path.join(repoRoot, file)));
    }
    const env = { ...process.env, SETUP_OBSERVATION_PROFILE: "contracts", GITHUB_SHA: identity.commitSha, GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1", PYTHONDONTWRITEBYTECODE: "1" };
    const invoke = (overrides = {}) => promisify(execFile)(process.execPath, [path.join(repoRoot, "scripts/local-ci-setup-observation.mjs"), "reports"], { cwd: temporary, env: { ...env, ...overrides }, timeout: 10000 });
    await assert.rejects(invoke({ SETUP_OBSERVATION_PROFILE: "full" }));
    await assert.rejects(invoke({ GITHUB_SHA: "c".repeat(40) }));
    await invoke();
    const file = path.join(evidence, "allocation-reports.json");
    const before = await readFile(file, "utf8");
    const result = JSON.parse(before);
    assert.equal(result.binding.runId, "1");
    assert.equal(result.snapshot.components.length, 2);
    assert.equal(result.provenance, null, "reports do not invent installer provenance");
    assert.ok(result.snapshot.components.every(({ status, uniqueInodes }) => status === "observed" && uniqueInodes === "1"));
    assert.ok(result.children.every(({ exitCode, cleanup }) => exitCode === 0 && cleanup.complete && !cleanup.groupAlive));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(invoke());
    assert.equal(await readFile(file, "utf8"), before);
    await access(path.join(evidence, "allocation-reports-pending.json"));
    assert.doesNotMatch(before, new RegExp(temporary));
    // A failing owned child leaves the start marker, never a success record.
    await rm(file);
    await rm(path.join(evidence, "allocation-reports-pending.json"));
    await rm(path.join(temporary, ".artifacts/local-ci/setup-observation-reports"), { recursive: true });
    await writeFile(path.join(temporary, "scripts/local-ci-setup-allocation.py"), "raise SystemExit(1)\n");
    await assert.rejects(invoke());
    await access(path.join(evidence, "allocation-reports-pending.json"));
    await assert.rejects(access(file));
    await assert.rejects(invoke());
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("canonical hosted connection is manual/reusable and defaults to contracts, not gates", async () => {
  const workflow = await readWorkflow(".github/workflows/canonical-ci.yml");
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch", "workflow_call"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.equal(inputs.profile.default, "contracts");
  assert.deepEqual(inputs.profile.options, ["contracts", "quick", "full"]);
  assert.equal(inputs.max_parallel_tasks.default, "12");
  const job = workflow.jobs.canonical;
  assert.equal(job["runs-on"], "ubuntu-24.04");
  const steps = job.steps;
  const stop = steps.find(({ name }) => name === "Full prerequisites remain unresolved");
  assert.equal(stop.if, "inputs.profile == 'full'");
  const setup = steps.find(({ id }) => id === "full_setup");
  assert.equal(setup.if, "inputs.profile == 'full'");
  assert.ok(steps.indexOf(setup) < steps.indexOf(stop));
  assert.ok(steps.indexOf(stop) < steps.findIndex(({ id }) => id === "pnpm_setup"));
  assert.match(stop.run, /\[precheck\][\s\S]*exit 1/u);
  assert.doesNotMatch(stop.run, /df |quota|dbus|sudo|pnpm|ci:local:/u);
  const checkout = steps.find(({ uses }) => uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ github.sha }}");
  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(checkout.with["persist-credentials"], false);
  assert.equal(steps.indexOf(setup), steps.indexOf(checkout) + 1);
  assert.match(setup.run, /node scripts\/local-ci-full-admission\.mjs --setup "\$REQUESTED_BASE" "\$EXPECTED_HEAD" "\$MAX_PARALLEL_TASKS"/u);
  assert.doesNotMatch(setup.run, /cargo|sudo|ci:local:|\|\|\s*true/u);
  const dependencies = steps.find(({ name }) => name === "Canonical system dependencies");
  assert.equal(dependencies.if, "inputs.profile != 'contracts'");
  assert.deepEqual(dependencies.run.trim().split("\n").slice(0, 2), [
    "sudo rm -f /etc/apt/sources.list.d/*microsoft* /etc/apt/sources.list.d/*azure*",
    "sudo apt-get update",
  ]);
  const contracts = steps.find(({ id }) => id === "contracts");
  assert.equal(contracts.if, "inputs.profile == 'contracts'");
  assert.match(contracts.run, /set -euo pipefail/u);
  for (const name of ["ci-pause", "local-ci", "local-ci-runner", "local-ci-process-supervisor"]) {
    assert.ok(contracts.run.includes(`scripts/${name}.test.mjs`), name);
  }
  assert.doesNotMatch(contracts.run, /ci:local:|generate:licenses|sharp-consumers|pnpm-audit/u);
  const identity = steps.find(({ name }) => name === "Record canonical source checkout identity");
  assert.equal(identity.if, "inputs.profile == 'contracts'");
  assert.ok(steps.indexOf(identity) < steps.indexOf(contracts));
  for (const field of ["commitSha", "treeSha", "event", "ref", "sha"]) assert.ok(identity.run.includes(field), field);
  const sourceUpload = steps.find(({ name }) => name === "Upload canonical connection source contracts");
  assert.equal(sourceUpload.if, "always() && inputs.profile == 'contracts' && (steps.setup_observation.outcome != 'skipped' || steps.contracts.outcome != 'skipped')");
  assert.equal(sourceUpload.with.name, "canonical-source-${{ github.run_id }}-${{ github.run_attempt }}");
  assert.equal(sourceUpload.with["include-hidden-files"], true);
  assert.equal(sourceUpload.with["if-no-files-found"], "error");
  assert.deepEqual(sourceUpload.with.path.trim().split("\n"), [
    ".artifacts/canonical-source/checkout-identity.json",
    ".artifacts/canonical-source/contracts.tap",
    ".artifacts/canonical-source/allocation-*.json",
  ]);
  for (const step of steps) {
    assert.equal(step["continue-on-error"], undefined);
    if (step.run) assert.doesNotMatch(step.run, /\$\{\{ inputs\.|--dry-run|--from|--recover-lock|\|\|\s*true/u);
  }
  const upload = steps.find(({ name }) => name === "Upload existing canonical evidence");
  assert.equal(upload.if, "always() && (steps.canonical.outcome != 'skipped' || steps.full_setup.outcome != 'skipped')");
  assert.equal(upload.with.path.trim().split("\n")[0], "${{ steps.canonical.outcome == 'skipped' && '.artifacts/local-ci/full-admission/*-setup/*.json' || '.artifacts/local-ci/' }}");
  assert.doesNotMatch(upload.with.path, /setup-reference|full-workload-(?:input|estimate)|\.log|stdout|stderr/u);
  assert.equal(upload.with["include-hidden-files"], true);
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.ok(upload.with.path.includes(".artifacts/local-ci/"));
});

test("cold canonical system reference derives exact source requests and rejects invented size facts", async () => {
  const source = await readFile(path.join(repoRoot, ".github/workflows/canonical-ci.yml"), "utf8");
  assert.deepEqual(canonicalSystemPackages(source), ["build-essential", "libssl-dev", "libdbus-1-dev", "libsecret-1-dev", "pkg-config", "xvfb"]);
  for (const malformed of ["", "sudo apt-get install -y --no-install-recommends a a\n", "sudo apt-get install -y --no-install-recommends a; evil\n", `${source}\nsudo apt-get install -y --no-install-recommends extra\n`]) {
    assert.throws(() => canonicalSystemPackages(malformed), /\[precheck\]/u);
  }
  const solution = "Inst sample (1:2.3-4 Ubuntu:24.04/noble [amd64])\nConf sample (1:2.3-4 Ubuntu:24.04/noble [amd64])\n";
  const packages = coldSystemPackages(solution);
  assert.deepEqual(packages, [{ package: "sample", version: "1:2.3-4", architecture: "amd64" }]);
  for (const malformed of ["", solution + solution, "Inst sample unexpected\n", "Inst ../sample (1 origin [amd64])\n"]) {
    assert.throws(() => coldSystemPackages(malformed), /\[precheck\]/u);
  }
  // Synthetic test numbers only; never written into a real Full forecast.
  const metadata = "Package: sample\nVersion: 1:2.3-4\nArchitecture: amd64\nSize: 123\nInstalled-Size: 456\nDescription: test only\n continuation\n";
  assert.deepEqual(systemPackageSizes(packages, metadata), [{ ...packages[0], archiveBytes: "123", installedKiB: "456" }]);
  // An explicit zero from a file-less package is data, not a missing-value default.
  assert.equal(systemPackageSizes(packages, metadata.replace("Installed-Size: 456", "Installed-Size: 0"))[0].installedKiB, "0");
  for (const malformed of ["", metadata + "\n" + metadata, metadata.replace("Size: 123\n", ""), metadata.replace("Size: 123", "Size: 0"), metadata.replace("Installed-Size: 456", "Installed-Size: unknown"), metadata.replace("amd64", "arm64"), metadata.replace("1:2.3-4", "1:2.3-5"), `${metadata}Size: 789\n`]) {
    assert.throws(() => systemPackageSizes(packages, malformed), /\[precheck\]/u);
  }
});

test("cold solver accepts only the observed literal empty suffix without changing tuple or size validation", () => {
  // Synthetic tuple text; only the suffix shape was observed in37999618595/1.
  const line = "Inst sample:amd64 (1:2.3-4 Ubuntu:24.04/noble [amd64])";
  const packages = [{ package: "sample:amd64", version: "1:2.3-4", architecture: "amd64" }];
  assert.deepEqual(coldSystemPackages(line), packages);
  assert.deepEqual(coldSystemPackages(`${line} []`), packages);
  assert.deepEqual(coldSystemSolverFormat(`${line}\n${line} []\n`), { installLines: 2, rejectedLines: 0, firstRejected: null });
  assert.throws(() => coldSystemPackages(`${line}\n${line} []`), /distinct cold APT/u);
  for (const suffix of ["[]", " [ ]", " [annotation]", " [] extra", " [] []", " []\r", " [] ", "  []", " []\t"]) {
    assert.throws(() => coldSystemPackages(line + suffix), /recognized cold APT/u, suffix);
    assert.equal(coldSystemSolverFormat(line + suffix).rejectedLines, 1, suffix);
  }
  for (const malformed of [line.replace("sample:amd64", "../sample"), line.replace("1:2.3-4", "1/2"), line.replace("[amd64]", "[AMD64]")]) {
    assert.throws(() => coldSystemPackages(`${malformed} []`), /recognized cold APT/u);
  }
  // Synthetic size values are test inputs, not real acquisition quantities.
  const metadata = "Package: sample\nVersion: 1:2.3-4\nArchitecture: amd64\nSize: 123\nInstalled-Size: 456\n";
  assert.deepEqual(systemPackageSizes(coldSystemPackages(`${line} []`), metadata), [{ ...packages[0], archiveBytes: "123", installedKiB: "456" }]);
  for (const malformed of [metadata.replace("1:2.3-4", "1:2.3-5"), metadata.replace("amd64", "arm64"), metadata.replace("Size: 123\n", ""), metadata.replace("Installed-Size: 456\n", ""), metadata + "\n" + metadata]) {
    assert.throws(() => systemPackageSizes(coldSystemPackages(`${line} []`), malformed), /\[precheck\]/u);
  }
});

test("cold solver rejection projects syntax without exposing text or accepting arbitrary annotations", () => {
  const valid = "Inst sample (1:2.3-4 Ubuntu:24.04/noble [amd64])";
  assert.deepEqual(coldSystemSolverFormat(`${valid}\nConf sample\n`), { installLines: 1, rejectedLines: 0, firstRejected: null });
  // Unknown nonempty annotations remain rejected and content-free.
  const rejected = "Inst sample (1:2.3-4 PRIVATE_ORIGIN https://private.invalid/token [amd64]) [PRIVATE_SUFFIX]";
  const projection = coldSystemSolverFormat(`Reading package lists...\n${valid}\n${rejected}\nInst ../PRIVATE_PATH unexpected\n`);
  assert.deepEqual(projection, { installLines: 3, rejectedLines: 2, firstRejected: {
    lineNumber: 3, bytes: Buffer.byteLength(rejected), sha256: createHash("sha256").update(rejected).digest("hex"),
    coldPrefix: true, ending: "unrecognized",
  } });
  assert.doesNotMatch(JSON.stringify(projection), /sample|1:2\.3-4|PRIVATE|https:|amd64/u);
  for (const line of [rejected, "Inst ../PRIVATE_PATH unexpected", `${valid} [PRIVATE_SUFFIX]`, "Inst sample (1 origin [amd64])\r", "Inst sample (1 origin [amd64]) https://private.invalid"]) {
    const format = coldSystemSolverFormat(line);
    assert.equal(format.rejectedLines, 1);
    assert.doesNotMatch(JSON.stringify(format), /PRIVATE|https:|private\.invalid/u);
    assert.throws(() => coldSystemPackages(line), /recognized cold APT/u);
  }
  // A recognized suffix cannot make an invalid package prefix acceptable.
  const invalidPrefix = "Inst ../PRIVATE_PATH (1 origin [amd64]) []";
  const format = coldSystemSolverFormat(invalidPrefix);
  assert.equal(format.rejectedLines, 1);
  assert.equal(format.firstRejected.coldPrefix, false);
  assert.equal(format.firstRejected.ending, "architecture-close-empty-brackets");
  assert.doesNotMatch(JSON.stringify(format), /PRIVATE|origin|amd64/u);
  assert.throws(() => coldSystemPackages(invalidPrefix), /recognized cold APT/u);
  assert.deepEqual(coldSystemSolverFormat("PRIVATE_NOT_AN_INSTALL\n"), { installLines: 0, rejectedLines: 0, firstRejected: null });
  assert.deepEqual(coldSystemPackages(valid), [{ package: "sample", version: "1:2.3-4", architecture: "amd64" }]);
});

test("canonical prerequisite reference is isolated from Full ingestion and heavy effects", async () => {
  const helper = await readFile(path.join(repoRoot, "scripts/local-ci-full-admission.mjs"), "utf8");
  const reference = helper.slice(helper.indexOf("export async function stageFullSystemReference"), helper.indexOf("// Focused grouped acquisition"));
  for (const required of ["--simulate", "Debug::NoLocking=1", "Dir::State::status=/dev/null", "Dir::Cache::pkgcache=", "Dir::Cache::srcpkgcache=", "--no-install-recommends", "--no-all-versions", "setup-reference.json", "setup-solver-format.json", "logJoins", "error.lateClose"]) assert.ok(reference.includes(required), required);
  const projection = reference.indexOf('await durableJson(path.join(directory, "setup-solver-format.json")');
  const parsing = reference.indexOf("const packages = coldSystemPackages(solution)");
  assert.ok(projection < parsing && parsing < reference.indexOf('await run("system-cold-sizes"'));
  assert.match(reference.slice(projection, parsing), /signal\?\.throwIfAborted\(\)/u);
  assert.doesNotMatch(reference, /admitted:|acquireWorkloadInput|produceWorkloadEstimate|admitFullResources|admitFullSetup|sudo|apt-get update/u);
  assert.ok(helper.indexOf('if (phase === "setup-reference") return') < helper.indexOf("({ input, estimate } = await acquireWorkloadInput"));
  const { jobs: { canonical: { steps } } } = await readWorkflow(".github/workflows/canonical-ci.yml");
  const stage = steps.find(({ id }) => id === "full_setup");
  const stop = steps.find(({ name }) => name === "Full prerequisites remain unresolved");
  // Real shell adversary: failed assessment cannot be ignored; successful
  // assessment still stops before installation or gates. Hosted tests only.
  const bin = await mkdtemp(path.join(tmpdir(), "full-reference-shell-contract-"));
  try {
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GITHUB_ENV: path.join(bin, "exports"), FULL_PNPM_DEST: path.join(bin, "installer"), npm_config_store_dir: path.join(bin, "store"), PLAYWRIGHT_BROWSERS_PATH: path.join(bin, "browser"), UV_CACHE_DIR: path.join(bin, "uv"), REQUESTED_BASE: "a".repeat(40), EXPECTED_HEAD: "b".repeat(40), MAX_PARALLEL_TASKS: "12" };
    await writeFile(path.join(bin, "node"), "#!/bin/sh\nexit 9\n", { mode: 0o755 });
    await assert.rejects(promisify(execFile)("bash", ["-c", stage.run], { env, timeout: 10000 }), (error) => error.code === 9);
    await writeFile(path.join(bin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await promisify(execFile)("bash", ["-c", stage.run], { env, timeout: 10000 });
    await assert.rejects(promisify(execFile)("bash", ["-c", stop.run], { env, timeout: 10000 }), (error) => error.code === 1 && /\[precheck\]/u.test(error.stderr));
  } finally { await rm(bin, { recursive: true, force: true }); }
});

test("normal prerequisite is the existing frozen materialization and compile-only subset, with no arbitrary consumers", async () => {
  const registry = JSON.parse(await readFile(path.join(repoRoot, "scripts/local-ci-registry.json"), "utf8"));
  const selected = normalPrerequisites(registry);
  assert.deepEqual(selected.map(({ id }) => id), ["bootstrap.install", "bootstrap.electron-binary", "bootstrap.workspace-build", "bootstrap.chromium", "electron.build"]);
  const plan = buildLocalCiPlan(registry, { profile: "full", base: "a".repeat(40), head: "b".repeat(40) });
  for (const step of selected) {
    const command = { ...plan.tasks.find(({ id }) => id === step.id).command };
    delete command.label; // Descriptive metadata is not part of the execution tuple.
    assert.deepEqual(step.command, command);
  }
  for (const change of [
    (value) => { value.stages.bootstrap.commands[0].args.push("--ignore-scripts"); },
    (value) => { value.stages.bootstrap.env = { PRIVATE_OVERRIDE: "1" }; },
    (value) => { value.stages.bootstrap.commands[1].command = "electron"; },
    (value) => { value.stages.electron.commands.find(({ id }) => id === "electron.build").cwd = "foreign"; },
    (value) => { value.stages.bootstrap.commands.push(value.stages.bootstrap.commands[0]); },
  ]) {
    const changed = structuredClone(registry); change(changed);
    assert.throws(() => normalPrerequisites(changed), /\[precheck\]/u);
  }
});

test("CPU version diagnostics keep the pin and reject unknown text without publishing it", () => {
  for (const text of ["uv 0.11.29", "uv 0.11.29 (0123456789 2026-10-01)\n", "uv 0.11.29 (x86_64-unknown-linux-gnu)\n"]) {
    assert.deepEqual(cpuVersionFormat("uv", text), { expected: "0.11.29", observedVersion: "0.11.29", format: "recognized", accepted: true });
  }
  assert.equal(cpuVersionFormat("python", "Python 3.12.10\n").accepted, true);
  for (const [tool, text, observed, format] of [
    ["uv", "uv 0.11.28", "0.11.28", "recognized"],
    ["uv", "uv 0.11.28 (x86_64-unknown-linux-gnu)\n", "0.11.28", "recognized"],
    ["uv", "uv 0.11.29 (x86_64-unknown-linux-musl)\n", "0.11.29", "unsupported"],
    ["uv", "uv 0.11.29 (aarch64-unknown-linux-gnu)\n", "0.11.29", "unsupported"],
    ["uv", "uv 0.11.29 (X86_64-unknown-linux-gnu)\n", "0.11.29", "unsupported"],
    ["uv", "uv 0.11.29 (x86_64-unknown-linux-gnu) PRIVATE_PAYLOAD\n", "0.11.29", "unsupported"],
    ["uv", "uv 0.11.29 (x86_64-unknown-linux-gnu)\nPRIVATE_PAYLOAD\n", "0.11.29", "unsupported"],
    ["python", "Python 3.13.0", "3.13.0", "recognized"],
    ["uv", "uv 0.11.29 (2026-10-01)", "0.11.29", "unsupported"],
    ["uv", "uv 0.11.290", "0.11.290", "recognized"],
    ["uv", "uv 0.11.29 https://private.invalid/secret", "0.11.29", "unsupported"],
    ["python", "Python 3.12.0\nPRIVATE_PAYLOAD", null, "unsupported"],
    ["uv", "PRIVATE_PAYLOAD", null, "unsupported"],
    ["uv", "", null, "unsupported"],
    ["uv", "uv 0.11.29 " + "PRIVATE_PAYLOAD".repeat(30), null, "oversized"],
    ["python", null, null, "oversized"],
  ]) {
    const diagnostic = cpuVersionFormat(tool, text);
    assert.equal(diagnostic.observedVersion, observed);
    assert.equal(diagnostic.format, format);
    assert.equal(diagnostic.accepted, false);
    assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_PAYLOAD|private\.invalid/u);
  }
});

test("CPU prerequisite preserves the one locked Full consumer and excludes Python download, GPU and tests", async () => {
  const registry = JSON.parse(await readFile(path.join(repoRoot, "scripts/local-ci-registry.json"), "utf8"));
  const [step] = cpuPrerequisites(registry);
  const plan = buildLocalCiPlan(registry, { profile: "full", base: "a".repeat(40), head: "b".repeat(40) });
  const actual = plan.tasks.find(({ id }) => id === "lfm.setup").command;
  assert.equal(step.id, "lfm.setup");
  assert.deepEqual(step.command.args, actual.args);
  assert.equal(step.command.command, actual.command);
  assert.equal(step.command.cwd, actual.cwd);
  assert.deepEqual(step.command.env, { UV_PYTHON: "/usr/bin/python3.12", UV_PYTHON_DOWNLOADS: "never" });
  for (const change of [
    (group) => { group.commands[0].args[3] = "cu130"; },
    (group) => { group.commands[0].args.push("--no-sync"); },
    (group) => { group.commands[0].cwd = "foreign"; },
    (group) => { group.env = { UV_PROJECT_ENVIRONMENT: "/foreign" }; },
    (group) => { group.commands.push(group.commands[0]); },
  ]) {
    const changed = structuredClone(registry); change(changed.stages["lfm-encoder-phase0"]);
    assert.throws(() => cpuPrerequisites(changed), /\[precheck\]/u);
  }
});

test("reviewed workload setup assessment replaces consumed CPU acquisition and still refuses every heavy effect", async () => {
  const { jobs: { canonical: { steps } } } = await readWorkflow(".github/workflows/canonical-ci.yml");
  const setup = steps.find(({ id }) => id === "full_setup");
  const stop = steps.find(({ name }) => name === "Full prerequisites remain unresolved");
  const checkout = steps.find(({ uses }) => uses?.startsWith("actions/checkout@"));
  assert.equal(steps.indexOf(setup), steps.indexOf(checkout) + 1);
  assert.equal(steps.indexOf(stop), steps.indexOf(setup) + 1);
  for (const step of steps) {
    assert.ok(!["full_reference", "full_normal_preflight"].includes(step.id));
    assert.doesNotMatch(step.run ?? "", /--(?:cpu|normal|grouped|setup)-reference|--cpu-preflight/u);
  }
  const actions = steps.filter(({ uses }) => uses?.startsWith("astral-sh/setup-uv@"));
  assert.equal(actions.length, 1); // Retain the ordinary Full action, not its consumed acquisition copy.
  assert.equal(actions[0].with.version, "0.11.29");
  assert.equal(actions[0].with["cache-local-path"], "${{ env.UV_CACHE_DIR }}");
  assert.equal(actions[0].with["enable-cache"], undefined);
  assert.ok(steps.indexOf(actions[0]) > steps.indexOf(stop));
  const bin = await mkdtemp(path.join(tmpdir(), "reviewed-setup-shell-"));
  try {
    const exported = path.join(bin, "exports"), calls = path.join(bin, "calls");
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GITHUB_ENV: exported, FULL_PNPM_DEST: path.join(bin, "installer"), npm_config_store_dir: path.join(bin, "store"), PLAYWRIGHT_BROWSERS_PATH: path.join(bin, "browser"), UV_CACHE_DIR: path.join(bin, "uv"), REQUESTED_BASE: "a".repeat(40), EXPECTED_HEAD: "b".repeat(40), MAX_PARALLEL_TASKS: "12" };
    const shell = `${setup.run}\n${stop.run}\nprintf 'installer or gate started' > '${calls}'`;
    await writeFile(path.join(bin, "node"), "#!/bin/sh\nexit 9\n", { mode: 0o755 });
    await assert.rejects(promisify(execFile)("bash", ["-c", shell], { env, timeout: 10000 }), (error) => error.code === 9);
    await assert.rejects(access(exported), { code: "ENOENT" });
    await assert.rejects(access(calls), { code: "ENOENT" });
    await writeFile(path.join(bin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await assert.rejects(promisify(execFile)("bash", ["-c", shell], { env, timeout: 10000 }), (error) => error.code === 1 && /\[precheck\]/u.test(error.stderr));
    assert.deepEqual((await readFile(exported, "utf8")).trim().split("\n"), ["FULL_PNPM_DEST", "npm_config_store_dir", "PLAYWRIGHT_BROWSERS_PATH", "UV_CACHE_DIR"].map((key) => `${key}=${env[key]}`));
    await assert.rejects(access(calls), { code: "ENOENT" });
  } finally { await rm(bin, { recursive: true, force: true }); }
});

test("normal and CPU acquisition consume one current focused owner and join synthetic failure/cancel without successors", async () => {
  const original = await readFile(path.join(repoRoot, "scripts/local-ci-full-admission.mjs"), "utf8");
  const keys = ["PATH", "CARGO_HOME", "CARGO_TARGET_DIR", "RUSTUP_TOOLCHAIN", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "RUNNER_TEMP", "RUNNER_TOOL_CACHE", "FULL_PNPM_DEST", "npm_config_store_dir", "PLAYWRIGHT_BROWSERS_PATH", "UV_CACHE_DIR"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const roots = [];
  try {
    const modes = ["success", "failure", "cancel", "expired", "stale", "location-drift", "digest-missing", "digest-invalid", "quota-zero", "project-unknown", "redirected", "node-outside"];
    for (const [cpu, mode] of [...modes.map((mode) => [false, mode]), ...["success", "uv-platform", "uv-platform-version", "uv-platform-unknown", "uv-platform-private", "failure", "cancel", "expired", "stale", "purpose-drift", "uv-version", "python-version", "uv-format", "uv-private", "python-private", "uv-oversized", "uv-outside", "allocation-missing", "allocation-changed", "allocation-empty-union", "allocation-foreign-device", "allocation-duplicate-device", "allocation-zero-union", "quota-zero", "project-unknown", "redirected"].map((mode) => [true, mode])]) {
      const root = await mkdtemp(path.join(tmpdir(), `normal-reference-${mode}-`)); roots.push(root);
      const bin = path.join(root, "bin"); await mkdir(bin);
      const sources = [".github/workflows/canonical-ci.yml", "scripts/local-ci-registry.json", "scripts/local-ci-full-filesystems.py", "scripts/local-ci-setup-allocation.py", "scripts/local-ci-process-supervisor.mjs", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "scripts/ensure-electron-binary.mjs", "electron/scripts/build.mjs", "vite.config.ts", "experiments/lfm25-encoder-phase0/pyproject.toml", "experiments/lfm25-encoder-phase0/uv.lock"];
      for (const file of sources) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), await readFile(path.join(repoRoot, file))); }
      const helper = path.join(root, "scripts/local-ci-full-admission.mjs");
      // Synthetic host isolation/version ONLY; real supervisor/streams/fsync.
      await writeFile(helper, original.replaceAll("await hostedJobIsolation();", "/* synthetic only */").replaceAll('"/usr/bin/python3.12"', '"python3"').replace("node: process.version, pnpm:", 'node: "v22.0.0", pnpm:').replace("const nodeRoot = normal ? path.dirname(path.dirname(await realpath(process.execPath))) : null;", `const nodeRoot = normal ? path.join(root, ${JSON.stringify(mode === "node-outside" ? "../foreign-node" : "synthetic-node")}) : null;`));
      const script = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const tool = path.basename(process.argv[1]), args = process.argv.slice(2), root = ${JSON.stringify(root)}, mode = ${JSON.stringify(mode)};
if (tool === 'git') { if (args[0] === 'rev-parse') console.log(args[1].includes('tree') ? 'b'.repeat(40) : 'a'.repeat(40)); }
else if (tool === 'sudo') {
  fs.writeFileSync(path.join(root, 'quota-checked'), 'observed');
  const request = JSON.parse(args.at(-1));
  console.log(JSON.stringify(request.locations.map(([label]) => ({ label, device: '1', bytes: mode === 'quota-zero' ? '0' : '1000000', inodes: '10000', quotas: [0,1,2].map(type => ({ type, state: mode === 'project-unknown' && type === 2 ? 'unknown' : 'kernel-disabled' })) }))));
} else if (tool === 'python3') {
  if (args[0] === '--version') console.log(mode === 'python-version' ? 'Python 3.13.0' : mode === 'python-private' ? 'Python 3.12.0\\nPRIVATE_PAYLOAD' : 'Python 3.12.0');
  else if (args.includes('-I')) console.log(args.at(-1).includes('shutil') ? path.join(mode === 'uv-outside' ? root + '/../foreign' : root, 'uv-tool', 'uv') : '3.12');
  else {
    const components = ${JSON.stringify(cpu)} ? JSON.parse(args.at(-1)).map(([id]) => ({ id, status: mode === 'allocation-missing' ? 'missing-or-disappeared' : 'observed', device: '1', allocatedBytes: mode === 'allocation-missing' ? null : '4096', uniqueInodes: mode === 'allocation-missing' ? null : '1' })) : [];
    // CPU project/environment alias one inode in this synthetic shape only.
    const coexistence = components.length ? [{ device: '1', allocatedBytes: '12288', uniqueInodes: '3' }] : [];
    if (mode === 'allocation-empty-union') coexistence.length = 0;
    if (mode === 'allocation-foreign-device') coexistence[0].device = '2';
    if (mode === 'allocation-duplicate-device') coexistence.push({ ...coexistence[0] });
    if (mode === 'allocation-zero-union') coexistence[0].allocatedBytes = '0';
    console.log(JSON.stringify({ status: mode === 'allocation-changed' ? 'changed-shared-inode' : 'observed-roots-only', components, coexistence: mode === 'allocation-changed' ? null : coexistence }));
  }
} else if (tool === 'uv') {
  const platformOutputs = {
    'uv-platform': 'uv 0.11.29 (x86_64-unknown-linux-gnu)',
    'uv-platform-version': 'uv 0.11.28 (x86_64-unknown-linux-gnu)',
    'uv-platform-unknown': 'uv 0.11.29 (x86_64-unknown-linux-musl)',
    'uv-platform-private': 'uv 0.11.29 (x86_64-unknown-linux-gnu)\\nPRIVATE_PAYLOAD',
  };
  if (args[0] === '--version') console.log(platformOutputs[mode] ?? (mode === 'uv-version' ? 'uv 0.11.28' : mode === 'uv-format' ? 'uv 0.11.29 (2026-10-01)' : mode === 'uv-private' ? 'uv 0.11.29 https://private.invalid/secret' : mode === 'uv-oversized' ? 'uv 0.11.29 ' + 'PRIVATE_PAYLOAD'.repeat(30) : 'uv 0.11.29 (0123456789 2026-10-01)'));
  else { if (process.env.UV_PYTHON_DOWNLOADS !== 'never' || process.env.UV_PYTHON !== 'python3') process.exit(8); fs.appendFileSync(path.join(root, 'started'), args.join(' ') + '\\n'); console.log('complete synthetic stdout'); console.error('complete synthetic stderr'); if (mode === 'failure') process.exit(9); if (mode === 'cancel') setInterval(() => {}, 1000); }
} else if (tool === 'pnpm') {
  if (!fs.existsSync(path.join(root, 'quota-checked'))) process.exit(8);
  if (args[0] === '--version') console.log('10.33.0');
  else if (args[0] === 'store') console.log(path.join(process.env.npm_config_store_dir, 'v10'));
  else { fs.appendFileSync(path.join(root, 'started'), args.join(' ') + '\\n'); console.log('complete synthetic stdout'); console.error('complete synthetic stderr'); if (mode === 'failure') process.exit(9); if (mode === 'cancel') setInterval(() => {}, 1000); }
} else { fs.appendFileSync(path.join(root, 'started'), 'node materialization\\n'); }
`;
      for (const tool of ["git", "sudo", "python3", "pnpm", "node", "uv"]) await writeFile(path.join(bin, tool), script, { mode: 0o755 });
      process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
      process.env.CARGO_HOME = path.join(process.env.HOME, `synthetic-unused-cargo-${path.basename(root)}`);
      delete process.env.CARGO_TARGET_DIR; delete process.env.RUSTUP_TOOLCHAIN;
      Object.assign(process.env, { GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1", RUNNER_TEMP: root, RUNNER_TOOL_CACHE: root, FULL_PNPM_DEST: path.join(root, "installer"), npm_config_store_dir: path.join(root, "store"), PLAYWRIGHT_BROWSERS_PATH: path.join(root, "browser"), UV_CACHE_DIR: path.join(root, "uv") });
      if (mode === "redirected") await symlink(bin, process.env.npm_config_store_dir);
      const { stageFullGroupedReference } = await import(pathToFileURL(helper).href);
      const controller = new AbortController();
      const options = { root, base: "c".repeat(40), head: process.env.GITHUB_SHA, maxParallelTasks: 12, signal: controller.signal, normal: true, cpu };
      const directory = path.join(root, ".artifacts/local-ci/full-admission/1-1-setup-reference");
      if (["quota-zero", "project-unknown", "redirected"].includes(mode)) {
        await assert.rejects(stageFullGroupedReference({ ...options, preflight: true }), /\[precheck\]/u);
        await assert.rejects(access(path.join(directory, "normal-preflight.json")), { code: "ENOENT" });
        await assert.rejects(stageFullGroupedReference(options));
        await assert.rejects(access(path.join(root, "started")), { code: "ENOENT" });
        continue;
      }
      await stageFullGroupedReference({ ...options, preflight: true });
      await assert.rejects(stageFullGroupedReference({ ...options, preflight: true }));
      const identityStart = JSON.parse(await readFile(path.join(directory, "identity-tree-start.json"), "utf8"));
      assert.equal(identityStart.state, "possible-start");
      const identityClose = JSON.parse(await readFile(path.join(directory, "identity-tree-close.json"), "utf8"));
      assert.equal(identityClose.closeObserved, true);
      assert.equal(identityClose.cleanup.complete, true);
      assert.equal(identityClose.cleanup.groupAlive, false);
      assert.equal(identityClose.exitCode, 0);
      for (const log of Object.values(identityClose.logs)) {
        const bytes = await readFile(path.join(root, log.path));
        assert.equal(log.size, bytes.length);
        assert.equal(log.sha256, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
      }
      const preflightPath = path.join(directory, "normal-preflight.json");
      const preflightBytes = await readFile(preflightPath, "utf8");
      const value = JSON.parse(preflightBytes);
      assert.equal(value.locations, undefined);
      const locations = [...fullSetupLocations(root), ...(cpu ? [["uv-project", path.join(root, "experiments/lfm25-encoder-phase0")], ["uv-environment", path.join(root, "experiments/lfm25-encoder-phase0/.venv")]] : [])];
      assert.equal(value.locationsDigest, createHash("sha256").update(JSON.stringify(locations)).digest("hex"));
      assert.equal(value.purpose, cpu ? "cpu" : "normal");
      for (const [, destination] of locations) {
        if (destination !== "/") assert.equal(preflightBytes.includes(destination), false, "uploaded preflight excludes actual filesystem paths");
      }
      if (["expired", "stale", "location-drift", "digest-missing", "digest-invalid", "purpose-drift"].includes(mode)) {
        if (mode === "expired") value.deadline = Date.now() - 1;
        else if (mode === "stale") value.binding.attempt = "2";
        else if (mode === "purpose-drift") value.purpose = "normal";
        else if (mode === "location-drift") process.env.npm_config_store_dir = path.join(root, "moved-store");
        else if (mode === "digest-missing") delete value.locationsDigest;
        else value.locationsDigest = "not-a-digest";
        await writeFile(preflightPath, JSON.stringify(value));
        await assert.rejects(stageFullGroupedReference(options), /normal preflight binding/u);
        await assert.rejects(access(path.join(directory, "normal-start.json")), { code: "ENOENT" });
        await assert.rejects(access(path.join(directory, "normal-resume-tree-pending.json")), { code: "ENOENT" });
        await assert.rejects(access(path.join(root, "started")), { code: "ENOENT" });
        continue;
      }
      if (["node-outside", "uv-outside", "uv-version", "uv-platform-version", "uv-platform-unknown", "uv-platform-private", "python-version", "uv-format", "uv-private", "python-private", "uv-oversized"].includes(mode)) {
        await assert.rejects(stageFullGroupedReference(options), /Node payload inside the assessed tool cache|uv executable inside its assessed tool cache|pinned uv0\.11\.29/u);
        await assert.rejects(access(path.join(root, "started")), { code: "ENOENT" });
        if (cpu) {
          const bytes = await readFile(path.join(directory, "cpu-versions.json"), "utf8");
          const diagnostic = JSON.parse(bytes);
          assert.deepEqual(diagnostic.binding, value.binding);
          assert.deepEqual(diagnostic.sources, value.sources);
          assert.equal(diagnostic.observed.uv.accepted, mode === "uv-outside" || mode.startsWith("python-"));
          assert.equal(diagnostic.observed.python.accepted, !mode.startsWith("python-"));
          assert.doesNotMatch(bytes, /PRIVATE_PAYLOAD|private\.invalid/u);
          for (const [tool, { child }] of Object.entries(diagnostic.observed)) {
            assert.equal(child.exitCode, 0); assert.equal(child.closeObserved, true); assert.equal(child.cleanup.complete, true); assert.equal(child.cleanup.groupAlive, false);
            for (const [stream, log] of Object.entries(child.logJoins)) {
              const raw = await readFile(path.join(directory, `cpu-${tool}-version.${stream}.log`));
              assert.equal(raw.length, log.size); assert.equal(`sha256:${createHash("sha256").update(raw).digest("hex")}`, log.sha256);
            }
          }
          if (mode !== "uv-outside") await assert.rejects(access(path.join(directory, "preparation-plan.json")), { code: "ENOENT" });
          await assert.rejects(access(path.join(directory, "lfm.setup-pending.json")), { code: "ENOENT" });
          await assert.rejects(access(path.join(directory, "setup-reference.json")), { code: "ENOENT" });
          const marker = await readFile(path.join(directory, "normal-start.json"), "utf8");
          await assert.rejects(stageFullGroupedReference(options));
          assert.equal(await readFile(path.join(directory, "cpu-versions.json"), "utf8"), bytes);
          assert.equal(await readFile(path.join(directory, "normal-start.json"), "utf8"), marker);
        } else await assert.rejects(stageFullGroupedReference(options));
        continue;
      }
      const pending = stageFullGroupedReference(options).then(() => null, (error) => error);
      if (mode === "cancel") {
        try {
          const deadline = Date.now() + 5000;
          for (;;) { try { await access(path.join(root, "started")); break; } catch (error) { if (error.code !== "ENOENT" || Date.now() >= deadline) throw error; } await new Promise((resolve) => setTimeout(resolve, 10)); }
        } finally { controller.abort(new Error("synthetic cancellation")); }
      }
      const error = await pending;
      const closed = JSON.parse(await readFile(path.join(directory, `${cpu ? "lfm.setup" : "bootstrap.install"}-close.json`), "utf8"));
      assert.equal(closed.closeObserved, true); assert.equal(closed.cleanup.complete, true); assert.equal(closed.cleanup.groupAlive, false);
      for (const [stream, log] of Object.entries(closed.logJoins)) {
        const bytes = await readFile(path.join(directory, `${cpu ? "lfm.setup" : "bootstrap.install"}.${stream}.log`));
        assert.equal(bytes.length, log.size); assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, log.sha256);
      }
      if (mode === "success" || mode === "uv-platform") {
        assert.equal(error, null);
        const reference = JSON.parse(await readFile(path.join(directory, "setup-reference.json"), "utf8"));
        assert.equal(reference.samples.length, cpu ? 1 : 5); assert.equal(reference.admitted, undefined);
        assert.ok(reference.unobserved.some((fact) => fact.includes("sub-200ms")));
        if (cpu) {
          const versions = JSON.parse(await readFile(path.join(directory, "cpu-versions.json"), "utf8"));
          assert.equal(versions.observed.python.accepted, true); assert.equal(versions.observed.uv.accepted, true);
          if (mode === "uv-platform") {
            const raw = await readFile(path.join(directory, "cpu-uv-version.stdout.log"));
            assert.equal(raw.toString(), "uv 0.11.29 (x86_64-unknown-linux-gnu)\n");
            assert.equal(versions.observed.uv.child.closeObserved, true); assert.equal(versions.observed.uv.child.cleanup.complete, true); assert.equal(versions.observed.uv.child.cleanup.groupAlive, false);
            assert.equal(versions.observed.uv.child.logJoins.stdout.size, 38);
            assert.equal(versions.observed.uv.child.logJoins.stdout.sha256, `sha256:${createHash("sha256").update(raw).digest("hex")}`);
            assert.equal(await readFile(path.join(root, "started"), "utf8"), "sync --frozen --extra cpu\n");
          }
          assert.deepEqual(reference.versions, { python: "Python 3.12.0", uv: "uv 0.11.29" });
          const allocation = reference.samples[0].allocation;
          assert.equal(allocation.status, "observed-roots-only");
          assert.equal(allocation.components.length, 4);
          assert.deepEqual(allocation.coexistence, [{ device: "1", allocatedBytes: "12288", uniqueInodes: "3" }]);
        }
      } else {
        assert.match(error.message, /\[precheck\]/u);
        if (mode.startsWith("allocation-") && mode !== "allocation-missing") {
          const { allocation } = JSON.parse(await readFile(path.join(directory, "preparation-0.json"), "utf8"));
          assert.equal(allocation.components.length, 4);
          assert.ok(allocation.components.every((entry) => entry.status === "observed" && BigInt(entry.allocatedBytes) > 0n && BigInt(entry.uniqueInodes) > 0n));
          assert.match(error.message, /complete .*CPU/u);
        }
        assert.equal(await readFile(path.join(root, "started"), "utf8"), cpu ? "sync --frozen --extra cpu\n" : "install --frozen-lockfile\n");
        await assert.rejects(access(path.join(directory, "setup-reference.json")), { code: "ENOENT" });
        await assert.rejects(access(path.join(directory, "bootstrap.electron-binary-pending.json")), { code: "ENOENT" });
      }
      const marker = await readFile(path.join(directory, "normal-start.json"), "utf8");
      const diagnostic = cpu ? await readFile(path.join(directory, "cpu-versions.json"), "utf8") : null;
      await assert.rejects(stageFullGroupedReference(options));
      assert.equal(await readFile(path.join(directory, "normal-start.json"), "utf8"), marker);
      if (cpu) assert.equal(await readFile(path.join(directory, "cpu-versions.json"), "utf8"), diagnostic);
      if (mode === "uv-platform") assert.equal(await readFile(path.join(root, "started"), "utf8"), "sync --frozen --extra cpu\n");
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const root of roots) await rm(root, { recursive: true, force: true });
  }
});

test("grouped pure-DB acquisition preserves the official tuple and complete failure target", async () => {
  const registry = JSON.parse(await readFile(path.join(repoRoot, "scripts/local-ci-registry.json"), "utf8"));
  const binding = { head: "a".repeat(40), tree: "b".repeat(40) };
  const output = path.join(tmpdir(), "synthetic-grouped-fixture");
  const steps = groupedDbPrerequisites(registry, binding, output);
  assert.deepEqual(steps.map(({ id }) => id), ["db-cold-compile", "db-official-backup", "db-fixture-failures"]);
  for (const { command } of steps) {
    assert.equal(command.command, "cargo");
    assert.equal(command.cwd, ".");
    assert.equal(command.env.CARGO_BUILD_JOBS, "2");
    assert.equal(command.env.RUSTUP_AUTO_INSTALL, "0");
    assert.ok(command.args.includes("--locked"));
    assert.doesNotMatch(command.args.join(" "), /semantic-embedding|native|Editor|dbus|nir1-material/u);
  }
  assert.deepEqual(steps[0].command.args, ["test", "--locked", "-p", "grimodex-db", "--manifest-path", "src-tauri/Cargo.toml", "--features", "c2zc-fixture-builder", "--test", "c2zc_restore_fixture", "--no-run"]);
  assert.deepEqual(steps[2].command.args, [...steps[0].command.args.slice(0, -1), "--offline"]);
  const fixture = registry.stages["c2-zc-restore-fixture-builder"].commands[0];
  const replacements = { __C2ZC_RESTORE_FIXTURE_OUTPUT_DIR__: output, __C2ZC_RESTORE_FIXTURE_EXPECTED_HEAD__: binding.head, __C2ZC_RESTORE_FIXTURE_EXPECTED_TREE__: binding.tree };
  assert.deepEqual(steps[1].command.args, ["run", "--locked", "--offline", ...fixture.args.slice(1).map((arg) => replacements[arg] ?? arg)]);
  for (const change of [
    (r) => { r.stages["c2-zc-restore-fixture-builder"].commands[0].args[6] = "semantic-embedding"; },
    (r) => { r.stages["c2-zc-restore-fixture-builder"].commands[0].args.push("extra"); },
    (r) => { r.stages["c2-zc-restore-fixture-builder"].commands[0].env.CARGO_BUILD_JOBS = "3"; },
    (r) => { r.stages["c2-zc-restore-fixture-builder"].env.INJECTED = "1"; },
    (r) => { r.stages["c2-zc-restore-fixture-builder"].commands[0].cwd = ".."; },
  ]) {
    const modified = structuredClone(registry); change(modified);
    assert.throws(() => groupedDbPrerequisites(modified, binding, output), /\[precheck\]/u);
  }
  assert.throws(() => groupedDbPrerequisites(registry, { ...binding, head: "bad" }, output), /\[precheck\]/u);
  assert.throws(() => groupedDbPrerequisites(registry, binding, "relative"), /\[precheck\]/u);
});

test("native allocation connects only the existing compile consumer and preserves ordinary build routing", async () => {
  const registry = JSON.parse(await readFile(path.join(repoRoot, "scripts/local-ci-registry.json"), "utf8"));
  assert.deepEqual(nativePrerequisites(registry), [{ id: "native.build", command: { command: "pnpm", args: ["napi:build"], cwd: ".", env: { CARGO_PROFILE_DEV_DEBUG: "0", CARGO_PROFILE_TEST_DEBUG: "0", CARGO_BUILD_JOBS: "4", RUSTUP_AUTO_INSTALL: "0" } } }]);
  for (const change of [
    (r) => { r.stages["electron-native"].commands[0].args = ["napi:build:release"]; },
    (r) => { r.stages["electron-native"].commands[0].cwd = "electron/native/grimodex-node"; },
    (r) => { r.stages["electron-native"].commands[0].env.CARGO_BUILD_JOBS = "2"; },
    (r) => { r.stages["electron-native"].env.CARGO_PROFILE_DEV_DEBUG = "1"; },
    (r) => { r.stages["electron-native"].commands.push(r.stages["electron-native"].commands[0]); },
  ]) { const changed = structuredClone(registry); change(changed); assert.throws(() => nativePrerequisites(changed), /unchanged compile-only native Full tuple/u); }
  const ci = await readWorkflow(".github/workflows/ci.yml"), job = ci.jobs["electron-native"];
  const cache = job.steps.find(({ uses }) => uses === "Swatinem/rust-cache@42dc69e1aa15d09112580998cf2ef0119e2e91ae");
  assert.deepEqual(cache.with, {
    workspaces: "src-tauri\nelectron/native/grimodex-node\n",
    key: "electron-native",
    "cache-directories": "${{ inputs.canonical_profile == 'native-development-build' && '~/.cache/ort.pyke.io' || '' }}",
  });
  const build = job.steps.find(({ name }) => name === "Build the development N-API module");
  assert.deepEqual(build.env, { PROFILE: "${{ inputs.canonical_profile }}" });
  assert.equal(job.steps[1].with["fetch-depth"], "${{ inputs.canonical_profile == 'native-development-build' && '0' || '1' }}");
  const upload = job.steps.find(({ name }) => name === "Upload native compile-only allocation observations");
  assert.equal(upload.if, "always() && inputs.canonical_profile == 'native-development-build'");
  assert.equal(upload.with.path, ".artifacts/local-ci/full-admission/*-setup-reference/*.json");
  assert.equal(upload.with["include-hidden-files"], true); assert.equal(upload.with["if-no-files-found"], "error");
  assert.doesNotMatch(upload.with.path, /\.log|node_modules|target/u);
  const bin = await mkdtemp(path.join(tmpdir(), "native-allocation-routing-"));
  try {
    const options = { root: bin, native: true, base: "c".repeat(40), head: "a".repeat(40), maxParallelTasks: 12 };
    const cancelled = new AbortController(); cancelled.abort(new Error("synthetic cancelled entry"));
    await assert.rejects(stageFullGroupedReference({ ...options, signal: cancelled.signal }), /cancelled entry/u);
    for (const flag of ["normal", "cpu", "preflight"]) await assert.rejects(stageFullGroupedReference({ ...options, [flag]: true }), /without mixed purposes/u);
    const previous = process.env.ORT_CACHE_DIR;
    try { process.env.ORT_CACHE_DIR = bin; await assert.rejects(stageFullGroupedReference(options), /unoverridden native/u); }
    finally { if (previous === undefined) delete process.env.ORT_CACHE_DIR; else process.env.ORT_CACHE_DIR = previous; }
    await assert.rejects(access(path.join(bin, ".artifacts")), { code: "ENOENT" });
    const script = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), tool = path.basename(process.argv[1]), args = process.argv.slice(2);
if (tool === 'git') console.log(args.at(-1) === 'origin/master' ? 'c'.repeat(40) : 'a'.repeat(40));
else { fs.appendFileSync(process.env.CALLS, JSON.stringify([tool, ...args]) + '\\n'); if (process.env.FAIL_CHILD === '1') process.exit(9); }
`;
    for (const tool of ["git", "node", "pnpm"]) await writeFile(path.join(bin, tool), script, { mode: 0o755 });
    for (const [index, profile] of ["", "native-development-build", "native-development-tests"].entries()) {
      const calls = path.join(bin, `calls-${index}`), env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PROFILE: profile, CALLS: calls, GITHUB_SHA: "a".repeat(40) };
      await promisify(execFile)("bash", ["-c", build.run], { env, timeout: 10000 });
      assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n").map(JSON.parse), profile === "native-development-build" ? [["node", "scripts/local-ci-full-admission.mjs", "--native-reference", "c".repeat(40), "a".repeat(40), "12"]] : [["pnpm", "napi:build"]]);
      await assert.rejects(promisify(execFile)("bash", ["-c", build.run], { env: { ...env, FAIL_CHILD: "1" }, timeout: 10000 }), (error) => error.code === 9);
    }
    const refused = path.join(bin, "wrong-head-calls");
    await assert.rejects(promisify(execFile)("bash", ["-c", build.run], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, PROFILE: "native-development-build", CALLS: refused, GITHUB_SHA: "b".repeat(40) }, timeout: 10000 }));
    await assert.rejects(access(refused), { code: "ENOENT" });
  } finally { await rm(bin, { recursive: true, force: true }); }
});

test("grouped acquisition joins real synthetic children and retains failure/cancellation owners", async () => {
  const original = await readFile(path.join(repoRoot, "scripts/local-ci-full-admission.mjs"), "utf8");
  const saved = Object.fromEntries(["PATH", "CARGO_HOME", "CARGO_TARGET_DIR", "RUSTUP_TOOLCHAIN", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "RUNNER_TEMP"].map((key) => [key, process.env[key]]));
  const roots = [], outputs = [];
  try {
    for (const [native, mode] of [
      ...["success", "failure", "cancel", "cache-outside", "target-redirect", "quota-unknown", "metadata-mismatch", "capacity-bytes-zero", "capacity-inodes-zero", "quota-bytes-zero", "quota-inodes-zero", "quota-before-compile", "quota-before-backup"].map((mode) => [false, mode]),
      ...["success", "failure", "cancel", "cache-outside", "target-redirect", "quota-unknown", "metadata-mismatch", "capacity-bytes-zero", "capacity-inodes-zero", "quota-bytes-zero", "project-unknown", "script-drift", "tuple-drift", "allocation-missing", "allocation-ort-missing", "allocation-changed", "allocation-duplicate-device", "allocation-foreign-device"].map((mode) => [true, mode]),
    ]) {
      const root = await mkdtemp(path.join(tmpdir(), `grouped-db-${mode}-`)); roots.push(root);
      const bin = path.join(root, "bin"); await mkdir(bin);
      // Copied consumer package.json is ESM; these extensionless mocks use require.
      await writeFile(path.join(bin, "package.json"), JSON.stringify({ type: "commonjs" }));
      const files = [".github/workflows/canonical-ci.yml", "scripts/local-ci-registry.json", "scripts/local-ci-full-filesystems.py", "scripts/local-ci-setup-allocation.py", "scripts/local-ci-process-supervisor.mjs", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/crates/grimodex-db/Cargo.toml", "src-tauri/crates/grimodex-core/Cargo.toml", "src-tauri/crates/grimodex-db/tests/c2zc_restore_fixture.rs", "src-tauri/crates/grimodex-db/src/narrative_extraction/c2zc_restore_fixture.rs", ".github/workflows/ci.yml", "package.json", "pnpm-lock.yaml", "electron/native/grimodex-node/package.json", "electron/native/grimodex-node/Cargo.toml", "electron/native/grimodex-node/Cargo.lock", "src-tauri/crates/grimodex-lint/Cargo.toml", "src-tauri/crates/grimodex-semantic/Cargo.toml"];
      for (const file of files) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), await readFile(path.join(repoRoot, file))); }
      if (mode === "script-drift") {
        const file = path.join(root, "electron/native/grimodex-node/package.json"), pkg = JSON.parse(await readFile(file, "utf8"));
        pkg.scripts.build = "napi build --release --features licensing"; await writeFile(file, JSON.stringify(pkg));
      }
      if (mode === "tuple-drift") {
        const file = path.join(root, "scripts/local-ci-registry.json"), registry = JSON.parse(await readFile(file, "utf8"));
        registry.stages["electron-native"].commands[0].env.CARGO_BUILD_JOBS = "2"; await writeFile(file, JSON.stringify(registry));
      }
      const target = path.join(root, native ? "electron/native/grimodex-node/target" : "src-tauri/target");
      if (mode === "target-redirect") await symlink(bin, target);
      // Synthetic source shim ONLY: do not probe this contract host's isolation.
      // Production keeps its actual hosted VM check. Supervisor remains real.
      const helper = path.join(root, "scripts/local-ci-full-admission.mjs");
      await writeFile(helper, original.replaceAll("await hostedJobIsolation();", "/* synthetic test only */").replace(
        'const output = normal || native ? null : await mkdtemp(path.join(tmpdir(), "grimodex-c2zc-restore-fixture-"));',
        'const output = normal || native ? null : await mkdtemp(path.join(tmpdir(), "grimodex-c2zc-restore-fixture-")); if (output) await durableJson(path.join(root, "synthetic-output.json"), { output });',
      ).replace('versions.node = process.version;', 'versions.node = "v22.0.0";'));
      const script = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const tool = path.basename(process.argv[1]), args = process.argv.slice(2), root = ${JSON.stringify(root)}, native = ${JSON.stringify(native)}, mode = ${JSON.stringify(mode)}, target = ${JSON.stringify(target)};
const head = "a".repeat(40), tree = "b".repeat(40);
if (tool === "git") {
  if (args[0] === "rev-parse") console.log(args[1].includes("tree") ? tree : head);
} else if (tool === "cargo" || tool === "rustc") {
  fs.appendFileSync(path.join(root, "cargo-called"), tool + " " + args[0] + "\\n");
  if (!fs.existsSync(path.join(root, "quota-checked"))) { console.error("synthetic Cargo started before quota check"); process.exit(8); }
  if (process.env.RUSTUP_AUTO_INSTALL !== '0') process.exit(8);
  if (args[0] === "metadata") {
    if (process.cwd() !== (native ? path.join(root, 'electron/native/grimodex-node') : root)) process.exit(8);
    console.log(JSON.stringify({ target_directory: mode === 'metadata-mismatch' ? path.join(root, 'unassessed-target') : target }));
  } else if (args[0] === "--version") console.log(tool + (native ? " 1.90.0 (0123456789 2026-01-01)" : " 1.0.0 (synthetic)"));
  else {
    fs.appendFileSync(path.join(root, "started"), args[0] + " " + args.includes("--no-run") + "\\n");
    if (args.includes("--no-run") && ${JSON.stringify(mode)} === "failure") process.exit(9);
    if (args.includes("--no-run") && ${JSON.stringify(mode)} === "cancel") setInterval(() => {}, 1000);
    if (args[0] === "run") {
      const output = args[args.indexOf("--output-dir") + 1];
      fs.writeFileSync(path.join(root, "owned-output"), output);
      fs.writeFileSync(path.join(output, "synthetic-backup.db"), "synthetic only");
    }
    console.log("complete synthetic stdout"); console.error("complete synthetic stderr");
  }
} else if (tool === 'pnpm') {
  if (args[0] === '--version') console.log('10.33.0');
  else {
    if (!native || args.join(' ') !== 'napi:build' || process.env.CARGO_BUILD_JOBS !== '4' || process.env.CARGO_PROFILE_DEV_DEBUG !== '0' || process.env.CARGO_PROFILE_TEST_DEBUG !== '0' || process.env.RUSTUP_AUTO_INSTALL !== '0' || !fs.existsSync(path.join(root, 'quota-checked'))) process.exit(8);
    fs.appendFileSync(path.join(root, 'started'), 'napi:build\\n');
    console.log('complete synthetic stdout'); console.error('complete synthetic stderr');
    if (mode === 'failure') process.exit(9);
    if (mode === 'cancel') setInterval(() => {}, 1000);
  }
} else if (tool === "sudo") {
  const request = JSON.parse(args.at(-1));
  if (request.locations.find(([label]) => label === "cargo-target")[1] !== target || request.locations.find(([label]) => label === "cargo-home")[1] !== process.env.CARGO_HOME) process.exit(8);
  if (${JSON.stringify(mode)} === "quota-unknown") { console.error("[precheck] synthetic applicable quota state unavailable"); process.exit(9); }
  const marker = path.join(root, "quota-checked");
  const sequence = fs.existsSync(marker) ? Number(fs.readFileSync(marker, "utf8")) : 0;
  fs.writeFileSync(marker, String(sequence + 1));
  const mode = ${JSON.stringify(mode)};
  console.log(JSON.stringify(request.locations.map(([label]) => {
    const observation = { label, device: "1", bytes: "100000", inodes: "1000", quotas: [0, 1, 2].map((type) => ({ type, state: mode === 'project-unknown' && type === 2 ? 'unknown' : "kernel-disabled" })) };
    if (mode === "capacity-bytes-zero" && label === "cargo-home") observation.bytes = "0";
    if (mode === "capacity-inodes-zero" && label === "cargo-target") observation.inodes = "0";
    if ((mode === "quota-bytes-zero" || mode === "quota-before-compile" && sequence === 3) && label === "cargo-home") observation.quotas[0] = { type: 0, state: "kernel-enabled", bytes: "0", inodes: null };
    if ((mode === "quota-inodes-zero" || mode === "quota-before-backup" && sequence === 5) && label === "cargo-target") observation.quotas[1] = { type: 1, state: "kernel-enabled", bytes: null, inodes: "0" };
    return observation;
  })));

} else {
  const roots = JSON.parse(args.at(-1));
  const components = roots.map(([id]) => native && (id === 'cargo-git' || mode === 'allocation-missing' && id === 'native-output' || mode === 'allocation-ort-missing' && id === 'ort-cache') ? { id, status: 'missing-or-disappeared', device: null, allocatedBytes: null, uniqueInodes: null } : { id, status: 'observed', device: '1', allocatedBytes: '4096', uniqueInodes: '1' });
  const coexistence = native ? [{ device: mode === 'allocation-foreign-device' ? '2' : '1', allocatedBytes: '12288', uniqueInodes: '3' }] : [];
  if (mode === 'allocation-duplicate-device') coexistence.push({ ...coexistence[0] });
  console.log(JSON.stringify({ status: native ? mode === 'allocation-changed' ? 'changed-shared-inode' : 'observed-roots-only' : 'synthetic', components, coexistence: mode === 'allocation-changed' ? null : coexistence }));
}
`;
      for (const tool of ["git", "cargo", "rustc", "sudo", "python3", "pnpm"]) await writeFile(path.join(bin, tool), script, { mode: 0o755 });
      process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
      process.env.CARGO_HOME = mode === "cache-outside" ? root : path.join(process.env.HOME, `synthetic-unused-cargo-${path.basename(root)}`);
      delete process.env.CARGO_TARGET_DIR; delete process.env.RUSTUP_TOOLCHAIN;
      process.env.GITHUB_SHA = "a".repeat(40); process.env.GITHUB_RUN_ID = "1"; process.env.GITHUB_RUN_ATTEMPT = "1"; process.env.RUNNER_TEMP = root;
      const { stageFullGroupedReference } = await import(pathToFileURL(helper).href);
      const controller = new AbortController();
      const options = { root, base: "c".repeat(40), head: process.env.GITHUB_SHA, maxParallelTasks: 12, signal: controller.signal, native };
      const operation = stageFullGroupedReference(options);
      // Attach rejection handling immediately while waiting for the cancel seam.
      const observed = operation.then(() => null, (error) => error);
      if (mode === "cancel") {
        try {
          const deadline = Date.now() + 5000;
          for (;;) {
            try { await access(path.join(root, "started")); break; } catch (error) { if (error.code !== "ENOENT" || Date.now() >= deadline) throw error; }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        } finally { controller.abort(new Error("synthetic cancellation")); }
      }
      const error = await observed;
      // Report the operation's original error before a missing output masks it.
      if (mode === "success") assert.ifError(error);
      else assert.ok(error instanceof Error, `${native ? "native" : "pure-DB"}/${mode} must refuse`);
      const directory = path.join(root, ".artifacts/local-ci/full-admission/1-1-setup-reference");
      if (native) {
        const owner = await readFile(path.join(directory, "owner.json"), "utf8");
        if (["success", "failure", "cancel", "allocation-missing", "allocation-ort-missing", "allocation-changed", "allocation-duplicate-device", "allocation-foreign-device"].includes(mode)) {
          assert.equal(await readFile(path.join(root, "started"), "utf8"), "napi:build\n");
          const closed = JSON.parse(await readFile(path.join(directory, "native.build-close.json"), "utf8"));
          assert.equal(closed.closeObserved, true); assert.equal(closed.cleanup.complete, true); assert.equal(closed.cleanup.groupAlive, false);
          for (const [stream, log] of Object.entries(closed.logJoins)) {
            const bytes = await readFile(path.join(directory, `native.build.${stream}.log`));
            assert.equal(bytes.length, log.size); assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, log.sha256);
          }
          await access(path.join(directory, "native.build-pending.json"));
          if (mode === "allocation-ort-missing") {
            assert.equal(closed.exitCode, 0);
            assert.match(error.message, /complete positive native registry\/target\/ORT\/output allocation observations/u);
            const preparation = JSON.parse(await readFile(path.join(directory, "preparation-0.json"), "utf8"));
            assert.equal(preparation.allocation.components.find(({ id }) => id === "ort-cache").allocatedBytes, null);
            assert.equal(preparation.allocation.components.find(({ id }) => id === "native-output").status, "observed");
          }
        } else await assert.rejects(access(path.join(root, "started")), { code: "ENOENT" });
        if (mode === "success") {
          const reference = JSON.parse(await readFile(path.join(directory, "setup-reference.json"), "utf8"));
          assert.deepEqual(reference.samples.map(({ id }) => id), ["native.build"]);
          assert.equal(reference.admitted, undefined);
          assert.deepEqual(reference.samples[0].allocation.coexistence, [{ device: "1", allocatedBytes: "12288", uniqueInodes: "3" }]);
          assert.equal(reference.samples[0].allocation.components.find(({ id }) => id === "cargo-git").allocatedBytes, null);
          assert.ok(reference.logs.length > 6); assert.ok(reference.unobserved.some((fact) => fact.includes("sub-200ms")));
        } else {
          assert.match(error.message, /\[precheck\]/u);
          await assert.rejects(access(path.join(directory, "setup-reference.json")), { code: "ENOENT" });
        }
        await assert.rejects(access(path.join(root, "synthetic-output.json")), { code: "ENOENT" });
        await assert.rejects(access(path.join(directory, "db-cold-compile-pending.json")), { code: "ENOENT" });
        await assert.rejects(stageFullGroupedReference(options));
        assert.equal(await readFile(path.join(directory, "owner.json"), "utf8"), owner);
        continue;
      }
      if (mode === "quota-before-compile") outputs.push(JSON.parse(await readFile(path.join(root, "synthetic-output.json"), "utf8")).output);
      if (["cache-outside", "target-redirect", "quota-unknown", "metadata-mismatch", "capacity-bytes-zero", "capacity-inodes-zero", "quota-bytes-zero", "quota-inodes-zero", "quota-before-compile"].includes(mode)) {
        const refusal = { "cache-outside": /Cargo cache inside the owned home/u, "target-redirect": /unredirected focused Cargo destinations/u, "quota-unknown": /db-filesystems-0/u, "metadata-mismatch": /source-bound pure-DB Cargo target/u }[mode] ?? /capacity\/quota/u;
        assert.match(error.message, refusal);
        await access(path.join(directory, "owner.json"));
        if (mode === "metadata-mismatch") assert.equal(await readFile(path.join(root, "cargo-called"), "utf8"), "cargo metadata\n");
        else if (mode === "quota-before-compile") assert.equal(await readFile(path.join(root, "cargo-called"), "utf8"), "cargo metadata\ncargo --version\nrustc --version\n");
        else await assert.rejects(access(path.join(root, "cargo-called")), { code: "ENOENT" });
        const absent = [path.join(root, "started"), path.join(directory, "db-cold-compile-pending.json"), path.join(directory, "setup-reference.json")];
        if (mode !== "quota-before-compile") absent.push(path.join(root, "synthetic-output.json"));
        for (const file of absent) await assert.rejects(access(file), { code: "ENOENT" });
        await assert.rejects(stageFullGroupedReference(options)); // retain rejected owner
        continue;
      }
      outputs.push(JSON.parse(await readFile(path.join(root, "synthetic-output.json"), "utf8")).output);
      if (mode === "success") {
        const reference = JSON.parse(await readFile(path.join(directory, "setup-reference.json"), "utf8"));
        assert.equal(reference.samples.length, 3); assert.ok(reference.logs.length > 6);
        assert.ok(reference.unobserved.some((fact) => fact.includes("sub-200ms")));
        assert.equal(reference.admitted, undefined);
      } else {
        assert.match(error.message, /\[precheck\]/u);
        assert.deepEqual((await readFile(path.join(root, "started"), "utf8")).trim().split("\n"), ["test true"]);
        await assert.rejects(access(path.join(directory, "setup-reference.json")), { code: "ENOENT" });
      }
      const closed = JSON.parse(await readFile(path.join(directory, "db-cold-compile-close.json"), "utf8"));
      if (mode === "quota-before-backup") {
        assert.match(error.message, /capacity\/quota/u);
        assert.equal(closed.exitCode, 0);
        for (const file of ["db-official-backup-pending.json", "db-fixture-failures-pending.json"]) await assert.rejects(access(path.join(directory, file)), { code: "ENOENT" });
        await assert.rejects(access(path.join(root, "owned-output")), { code: "ENOENT" });
      }
      assert.equal(closed.closeObserved, true); assert.equal(closed.cleanup.complete, true); assert.equal(closed.cleanup.groupAlive, false);
      for (const [stream, log] of Object.entries(closed.logJoins)) {
        const bytes = await readFile(path.join(directory, `db-cold-compile.${stream}.log`));
        assert.equal(bytes.length, log.size); assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, log.sha256);
      }
      await access(path.join(directory, "db-cold-compile-pending.json"));
      await assert.rejects(stageFullGroupedReference(options)); // owner cannot be replaced
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const root of [...outputs, ...roots]) await rm(root, { recursive: true, force: true });
  }
});

test("grouped acquisition retains Full fences, bounded ownership and scoped observations", async () => {
  const helper = await readFile(path.join(repoRoot, "scripts/local-ci-full-admission.mjs"), "utf8");
  const grouped = helper.slice(helper.indexOf("export async function stageFullGroupedReference"), helper.indexOf("// Installed components"));
  assert.doesNotMatch(grouped, /stageFullSystemReference|apt-get|admitted:|acquireWorkloadInput|produceWorkloadEstimate|admitFullSetup|admitFullResources|buildLocalCiPlan|\brm\(/u);
  for (const required of ["900_000", "1_800_000", "--locked", "--no-deps", "assertWritableLocations", "local-ci-full-filesystems.py", "local-ci-setup-allocation.py", "groupedDbPrerequisites", "commandDigest", "possible-start", "await sampler", "error.lateClose", "closeObserved", "cleanup.groupAlive", "logJoins", "setup-reference.json", "sub-200ms", "db-final-clean"]) assert.ok(grouped.includes(required), required);
  assert.ok(grouped.indexOf("const cargo =") < grouped.indexOf("const initial = await probe()"));
  assert.ok(grouped.indexOf("for (const destination of [cargo, target,") < grouped.indexOf("const initial = await probe()"));
  assert.ok(grouped.indexOf("await assertWritableLocations(locations)") < grouped.indexOf("const initial = await probe()"));
  assert.ok(grouped.indexOf("assessFullDemand(filesystems, [])") < grouped.indexOf("return filesystems"));
  assert.ok(grouped.indexOf("const initial = await probe()") < grouped.indexOf('run("db-target"'));
  const version = grouped.slice(grouped.indexOf("const version ="), grouped.indexOf("const versions ="));
  assert.ok(version.indexOf("await probe()") < version.indexOf("await run(id"));
  assert.ok(grouped.indexOf("const before = await probe()") < grouped.indexOf("result = await runLocalCiCommand"));
  assert.ok(grouped.indexOf("metadata.target_directory !== target") < grouped.indexOf("const output = normal || native ? null : await mkdtemp"));
  assert.ok(grouped.indexOf("possible-start") < grouped.indexOf("result = await runLocalCiCommand"));
  assert.ok(grouped.indexOf("await sampler") < grouped.indexOf('`${step.id}-close.json`'));
  assert.ok(grouped.indexOf("result.exitCode !== 0") < grouped.indexOf("samples.push"));
  const { jobs: { canonical: { steps } } } = await readWorkflow(".github/workflows/canonical-ci.yml");
  const setup = steps.find(({ id }) => id === "full_setup");
  assert.match(setup.run, /--setup /u);
  assert.doesNotMatch(setup.run, /--(?:cpu|grouped|setup|normal)-reference/u);
  assert.ok(steps.indexOf(setup) < steps.findIndex(({ name }) => name === "Full prerequisites remain unresolved"));
  assert.ok(steps.find(({ id }) => id === "canonical").run.includes("Full conditional admission is not yet enabled"));
});

test("Full preparation preserves actual compilation tuples without executing tests or journeys", async () => {
  const registry = JSON.parse(await readFile(path.join(repoRoot, "scripts/local-ci-registry.json"), "utf8"));
  const plan = buildLocalCiPlan(registry, { profile: "full", base: "a".repeat(40), head: "b".repeat(40) });
  const steps = fullPreparation(plan);
  for (const step of steps) {
    if (step.command.command === "cargo" && step.command.args[0] === "test") {
      assert.ok(step.command.args.includes("--no-run"), step.id);
      assert.ok(!step.command.args.includes("--doc"), step.id);
      assert.ok(!step.command.args.includes("--"), step.id);
    }
    assert.ok(!step.id.startsWith("journeys.shard") && step.id !== "rust.c-query-worker");
    if (step.command.command === "cargo") {
      assert.notEqual(step.command.args[0], "run");
      assert.notEqual(step.command.args[0], "clippy", `${step.id}: preparation must not execute lint gates`);
    }
  }
  assert.equal(steps.find((step) => step.id === "c2zc.fixture-build").command.args[0], "build");
  for (const id of ["bootstrap.install", "native.build", "native.tests", "lfm.setup", "electron.build", "rust.c-query-build-worker-seam", "rust.c-query-build-worker-tests", "c2zc.fixture-build"]) assert.ok(steps.some((step) => step.id === id), id);
  assert.ok(steps.find((step) => step.id === "native.tests").command.args.includes("licensing,legacy-keyring-migration"));
  const compiled = steps.find((step) => step.id === "migration.supervisor");
  const original = plan.tasks.find((task) => task.id === compiled.id).command;
  assert.deepEqual(compiled.command.args.slice(0, -1), original.args);
  assert.deepEqual(compiled.command.env, original.env);
  for (const task of plan.tasks.filter((entry) => entry.command.command === "cargo" && entry.command.args[0] === "clippy")) {
    const separator = task.command.args.indexOf("--");
    const args = task.command.args.slice(0, separator === -1 ? undefined : separator);
    args[0] = "check";
    // Deduplication may select the already-existing check with this same tuple.
    assert.ok(steps.some((step) => JSON.stringify(step.command) === JSON.stringify({ command: task.command.command, args, cwd: task.command.cwd, env: { ...task.command.env } })), `${task.id}: equivalent compile-only tuple`);
  }
  const adversarial = structuredClone(plan);
  const lint = adversarial.tasks.find((task) => task.command.command === "cargo" && task.command.args[0] === "clippy");
  lint.command.args = ["clippy", "--release", "--all-targets", "--no-default-features", "--features", "synthetic-feature", "--target", "synthetic-target", "--", "-D", "warnings", "-W", "clippy::all"];
  lint.command.env = { RUSTFLAGS: "synthetic-build-flag" };
  const compile = fullPreparation(adversarial).find((step) => step.id === lint.id);
  assert.deepEqual(compile.command, { command: "cargo", args: ["check", ...lint.command.args.slice(1, lint.command.args.indexOf("--"))], cwd: lint.command.cwd, env: lint.command.env });
});

const disabledQuotas = () => [0, 1, 2].map((type) => ({ type, state: "kernel-disabled" }));
const syntheticFilesystem = (label, device = "1", bytes = "1000", inodes = "100") => ({ label, device, bytes, inodes, allocationUnit: "4096", quotas: disabledQuotas() });
const syntheticTerm = (location = "workspace", bytes = "200", inodes = "10") => ({ location, bytes, inodes });

test("Full demand aggregates aliases, applicable quotas, failure coexistence and inode demand", () => {
  const fs = [syntheticFilesystem("workspace"), syntheticFilesystem("home"), syntheticFilesystem("root")];
  assert.deepEqual(assessFullDemand(fs, [syntheticTerm(), syntheticTerm("home")])[0], { device: "1", bytes: "1000", inodes: "100", demandBytes: "400", demandInodes: "20", allocationUnit: "4096" });
  assert.throws(() => assessFullDemand(fs, [syntheticTerm("workspace", "600"), syntheticTerm("home", "600")]), /capacity\/quota/u);
  assert.throws(() => assessFullDemand(fs, [syntheticTerm("workspace", "1", "100")]), /capacity\/quota/u);
  assert.throws(() => assessFullDemand(fs, [syntheticTerm("missing")]), /effective storage/u);
  assert.throws(() => assessFullDemand([{ ...fs[0], quotas: [] }], []), /quota/u);
  assert.throws(() => assessFullDemand([{ ...fs[0], quotas: [{ type: 0, state: "unknown" }] }], []), /kernel quota/u);
  const quota = { type: 0, state: "kernel-enabled", bytes: "300", inodes: "50" };
  const limited = [{ ...fs[0], quotas: [quota, ...disabledQuotas().slice(1)] }];
  assert.throws(() => assessFullDemand(limited, [syntheticTerm("workspace", "301")]), /capacity\/quota/u);
  assert.throws(() => assessFullDemand([{ ...fs[0], quotas: disabledQuotas().slice(1) }], []), /quota domains/u);
  assert.throws(() => assessFullDemand([fs[0], fs[0]], []), /unique/u);
  assert.throws(() => assessFullDemand([syntheticFilesystem("root", "2", "0")], []), /root\/home pressure/u);
  assert.throws(() => assessFullDemand(fs, [syntheticTerm("workspace", "1e6")]), /decimal/u);
});

test("Full positive forecasts require observed allocation geometry, including aliased and observation-only destinations", () => {
  const fs = [syntheticFilesystem("workspace"), syntheticFilesystem("home"), syntheticFilesystem("root", "root")];
  assert.equal(assessFullDemand(fs, [syntheticTerm()])[0].allocationUnit, "4096");
  for (const index of [0, 1, 2]) {
    for (const allocationUnit of [undefined, null, 4096, "0", "1024", "8192", "65536", "unknown"]) {
      const changed = fs.map((row, i) => i === index ? { ...row, allocationUnit } : row);
      assert.throws(() => assessFullDemand(changed, [syntheticTerm()]), /actual allocation geometry/u);
      assert.doesNotThrow(() => assessFullDemand(changed, []), "no-demand reference scope does not attest forecast geometry");
      const terms = ["retained", "transient", "uncertainty"].map((kind) => ({ ...syntheticTerm("workspace", "1", "1"), kind }));
      assert.throws(() => assessFullSetupDemand(changed, terms), /actual allocation geometry/u);
    }
  }
});

test("Full setup risk charges workload destinations, observes aliases and fails closed for quotas and pressure", () => {
  const fs = [syntheticFilesystem("workspace"), syntheticFilesystem("root"), syntheticFilesystem("home"), syntheticFilesystem("tool-cache")];
  const terms = fs.flatMap(({ label }) => ["retained", "transient", "uncertainty"].map((kind) => ({ ...syntheticTerm(label, "10", "1"), kind })));
  assert.equal(assessFullSetupDemand(fs, terms)[0].demandBytes, "120");
  const workload = terms.filter((term) => term.location === "workspace");
  assert.equal(assessFullSetupDemand(fs, workload)[0].demandBytes, "30");
  // Root/home may be separate observation-only devices. No fabricated positive
  // retained/transient/uncertainty charges or default-zero inventory is needed.
  const separate = [fs[0], syntheticFilesystem("root", "root", "1", "1"), syntheticFilesystem("home", "home", "1", "1")];
  assert.deepEqual(assessFullSetupDemand(separate, workload).map(({ device, demandBytes }) => [device, demandBytes]), [["1", "30"], ["root", "0"], ["home", "0"]]);
  // Alias pressure still constrains all writes on that device; a separate full
  // root/home or unknown quota still fails even with no term at its label.
  assert.throws(() => assessFullSetupDemand([fs[0], syntheticFilesystem("home", "1", "30")], workload), /capacity\/quota/u);
  for (const label of ["root", "home"]) {
    assert.throws(() => assessFullSetupDemand([fs[0], syntheticFilesystem(label, label, "0")], workload), /root\/home pressure/u);
    assert.throws(() => assessFullSetupDemand([fs[0], { ...syntheticFilesystem(label, label), quotas: [] }], workload), /project-quota/u);
  }
  assert.throws(() => assessFullSetupDemand(fs, workload.filter((term) => term.kind !== "uncertainty")), /setup uncertainty workload risk/u);
  assert.throws(() => assessFullSetupDemand(fs, terms.map((term) => ({ ...term, bytes: "100" }))), /capacity\/quota/u);
  const enabledProject = { ...fs[0], quotas: [disabledQuotas()[0], disabledQuotas()[1], { type: 2, state: "kernel-enabled", bytes: null, inodes: null }] };
  assert.throws(() => assessFullSetupDemand([enabledProject], terms), /installer destination\/project-quota placement/u);
  assert.throws(() => assessFullSetupDemand([{ ...fs[0], quotas: [] }], terms), /project-quota/u);
});

test("Full resolves installer caches before setup and rejects unknown or changed effective placement before build queries", async () => {
  const env = {
    FULL_PNPM_DEST: "/synthetic/installer", npm_config_store_dir: "/synthetic/separate-store",
    PLAYWRIGHT_BROWSERS_PATH: "/synthetic/separate-browser", UV_CACHE_DIR: "/synthetic/separate-uv",
  };
  const locations = fullSetupLocations(repoRoot, env);
  assert.equal(locations.find(([label]) => label === "pnpm-store")[1], "/synthetic/separate-store/v10");
  assert.equal(locations.find(([label]) => label === "browser-cache")[1], env.PLAYWRIGHT_BROWSERS_PATH);
  for (const key of Object.keys(env)) {
    for (const value of [undefined, "", "relative", "0", "/synthetic/injected\nOTHER=value"]) {
      assert.throws(() => fullSetupLocations(repoRoot, { ...env, [key]: value }), /explicit absolute/u);
    }
  }
  const estimate = { setup: { destinations: locations } };
  validateFullSetupLocations(estimate, locations);
  assert.throws(() => validateFullSetupLocations(estimate, fullSetupLocations(repoRoot, { ...env, npm_config_store_dir: "/synthetic/changed-store" })), /unchanged resolved installer destinations/u);
  for (const wrong of ["pnpm", "browser", "uv"]) {
    const queried = [];
    const run = async (id) => {
      queried.push(id);
      assert.ok(["storage-pnpm", "storage-browser", "storage-uv"].includes(id), "placement must reject before Cargo/build/writability work");
      if (id === "storage-pnpm") return wrong === "pnpm" ? "/unassessed/store/v10" : "/synthetic/separate-store/v10";
      if (id === "storage-browser") return JSON.stringify(`${wrong === "browser" ? "/unassessed/browser" : env.PLAYWRIGHT_BROWSERS_PATH}/chromium-123/chrome-linux64/chrome`);
      return wrong === "uv" ? "/unassessed/uv" : env.UV_CACHE_DIR;
    };
    await assert.rejects(collectFullLocations(repoRoot, run, env), /query agreeing with its pre-installation destination assessment/u);
    assert.equal(queried.at(-1), `storage-${wrong}`);
  }
});

test("Full Cargo collection rejects unaccounted targets in every caller context and symlink ancestors", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "full-cargo-placement-contract-"));
  const prior = Object.fromEntries(["RUNNER_TEMP", "RUNNER_TOOL_CACHE"].map((key) => [key, process.env[key]]));
  try {
    process.env.RUNNER_TEMP = temporary;
    process.env.RUNNER_TOOL_CACHE = temporary;
    const env = {
      FULL_PNPM_DEST: path.join(temporary, "installer"), npm_config_store_dir: path.join(temporary, "store"),
      PLAYWRIGHT_BROWSERS_PATH: path.join(temporary, "browser"), UV_CACHE_DIR: path.join(temporary, "uv"),
    };
    const targets = ["cargo-shared", "cargo-shared-package", "cargo-native", "cargo-native-package"];
    const expected = (label) => path.join(temporary, label.startsWith("cargo-shared") ? "src-tauri/target" : "electron/native/grimodex-node/target");
    const runner = (queries, wrong, target) => async (id, command) => {
      queries.push(id);
      if (id === "storage-pnpm") return path.join(env.npm_config_store_dir, "v10");
      if (id === "storage-browser") return JSON.stringify(`${env.PLAYWRIGHT_BROWSERS_PATH}/chromium-123/chrome-linux64/chrome`);
      if (id === "storage-uv") return env.UV_CACHE_DIR;
      const label = id.slice("storage-".length);
      assert.ok(targets.includes(label), "no preparation/build/writability child may be spawned");
      assert.deepEqual(command.args.slice(0, 6), ["metadata", "--no-deps", "--locked", "--offline", "--format-version", "1"]);
      assert.equal(command.cwd, label.endsWith("-package") ? label.startsWith("cargo-shared") ? "src-tauri" : "electron/native/grimodex-node" : ".");
      return JSON.stringify({ target_directory: label === wrong ? target : expected(label) });
    };
    const queries = [];
    const locations = await collectFullLocations(temporary, runner(queries), env);
    assert.deepEqual(locations.filter(([label]) => targets.includes(label)), targets.map((label) => [label, expected(label)]));
    assert.equal(queries.length, 7);
    for (const label of targets) {
      for (const target of [undefined, null, "relative-target", path.join(temporary, "unaccounted-target"), path.join(temporary, "../disjoint-target")]) {
        const rejectedQueries = [];
        await assert.rejects(collectFullLocations(temporary, runner(rejectedQueries, label, target), env), /source-bound workspace Cargo target/u);
        assert.equal(rejectedQueries.at(-1), `storage-${label}`);
      }
    }
    // An exact lexical target is still redirected if an existing ancestor is a
    // symlink. Do not borrow workspace demand for its physical destination.
    await mkdir(path.join(temporary, "elsewhere"));
    await symlink(path.join(temporary, "elsewhere"), path.join(temporary, "src-tauri"));
    await assert.rejects(collectFullLocations(temporary, runner([]), env), /unredirected source-bound workspace Cargo target ancestors/u);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Full setup is dependency-free and binds workflow, estimate and same-job phase before later preparation", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "full-setup-contract-"));
  try {
    // Deliberately omit local-ci.mjs and node_modules. Even with packages present
    // in the test checkout, the initial helper cannot depend on their imports.
    for (const name of ["local-ci-full-admission.mjs", "local-ci-process-supervisor.mjs"]) {
      await writeFile(path.join(temporary, name), await readFile(path.join(repoRoot, "scripts", name)));
    }
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", "await import('./local-ci-full-admission.mjs')"], { cwd: temporary, timeout: 10000 });
    const workflow = "public synthetic setup source\n";
    await mkdir(path.join(temporary, ".github/workflows"), { recursive: true });
    await writeFile(path.join(temporary, ".github/workflows/canonical-ci.yml"), workflow);
    const hash = createHash("sha256").update(workflow).digest("hex");
    const binding = { head: "b".repeat(40), runId: "1", attempt: "1" };
    const estimate = {
      binding, sources: [{ path: ".github/workflows/canonical-ci.yml", sha256: hash }],
      setup: { workflowSha256: hash, terms: ["retained", "transient", "uncertainty"].map((kind) => ({ ...syntheticTerm(), id: kind, kind, domain: "cache-environment", basis: "synthetic contract only", operation: "synthetic setup", sources: [0] })) },
    };
    await validateFullSetupEstimate(estimate, binding, temporary);
    const jsonDigest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const decision = { binding, phase: "setup", admitted: true, estimateDigest: jsonDigest(estimate) };
    validateFullSetupDecision(decision, binding, estimate);
    for (const change of [
      { ...decision, admitted: false }, { ...decision, phase: "preparation" },
      { ...decision, binding: { ...binding, attempt: "2" } },
      { ...decision, binding: { ...binding, head: "c".repeat(40) } },
      { ...decision, estimateDigest: "0".repeat(64) }, null,
    ]) assert.throws(() => validateFullSetupDecision(change, binding, estimate), /\[precheck\]/u);
    for (const mutate of [
      (value) => { delete value.setup; },
      (value) => { value.setup.workflowSha256 = "0".repeat(64); },
      (value) => { value.setup.terms.pop(); },
      (value) => { value.setup.terms[0].bytes = "0"; },
      (value) => { value.binding.attempt = "2"; },
    ]) {
      const malformed = structuredClone(estimate);
      mutate(malformed);
      await assert.rejects(validateFullSetupEstimate(malformed, binding, temporary), /\[precheck\]/u);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("canonical Full setup assessment precedes every heavy action/install and cannot run profile gates", async () => {
  const { jobs: { canonical: { steps } } } = await readWorkflow(".github/workflows/canonical-ci.yml");
  const setupIndex = steps.findIndex(({ id }) => id === "full_setup");
  assert.ok(setupIndex > steps.findIndex(({ uses }) => uses?.startsWith("actions/checkout@")));
  const setup = steps[setupIndex];
  assert.equal(setup.if, "inputs.profile == 'full'");
  for (const [key, directory] of [["FULL_PNPM_DEST", "setup-pnpm"], ["npm_config_store_dir", "pnpm-store"], ["PLAYWRIGHT_BROWSERS_PATH", "ms-playwright"], ["UV_CACHE_DIR", "uv-cache"]]) {
    assert.equal(setup.env[key], `\${{ format('{0}/${directory}', runner.tool_cache) }}`);
    assert.ok(setup.run.includes(key));
  }
  assert.ok(setup.run.indexOf('>> "$GITHUB_ENV"') > setup.run.indexOf("node scripts/local-ci-full-admission.mjs --setup"));
  assert.equal(steps.find(({ id }) => id === "pnpm_setup").with.dest, "${{ env.FULL_PNPM_DEST || '~/setup-pnpm' }}");
  assert.equal(steps.find(({ uses }) => uses?.startsWith("astral-sh/setup-uv@")).with["cache-local-path"], "${{ env.UV_CACHE_DIR }}");
  assert.match(setup.run, /node scripts\/local-ci-full-admission\.mjs --setup "\$REQUESTED_BASE" "\$EXPECTED_HEAD" "\$MAX_PARALLEL_TASKS"/u);
  assert.doesNotMatch(setup.run, /ci:local:|pnpm|cargo|apt-get|\|\|\s*true/u);
  // No prerequisite installer remains before the actual reviewed-input assessment.
  // All eight ordinary Full installers are still behind the first refusal.
  const stopIndex = steps.findIndex(({ name }) => name === "Full prerequisites remain unresolved");
  assert.equal(stopIndex, setupIndex + 1);
  const helper = await readFile(path.join(repoRoot, "scripts/local-ci-full-admission.mjs"), "utf8");
  const runner = helper.slice(helper.indexOf("function admissionRunner"), helper.indexOf("// Exactly one same-job continuation"));
  assert.ok(runner.indexOf("`${id}-start.json`") < runner.indexOf("await runLocalCiCommand"));
  assert.ok(runner.lastIndexOf("`${id}-close.json`") < runner.indexOf("if (result.exitCode"));
  assert.match(runner, /error\.result \?\? \{ termination: "unknown" \}/u);
  assert.match(runner, /error\.lateClose[\s\S]*await error\.lateClose[\s\S]*throw error/u);
  const heavy = steps.filter(({ uses, run }) => /pnpm\/action-setup@|actions\/setup-node@|dtolnay\/rust-toolchain@|astral-sh\/setup-uv@/u.test(uses ?? "") || /apt-get|pnpm install|playwright install-deps|cargo install/u.test(run ?? ""));
  assert.equal(heavy.length, 8);
  for (const step of heavy) {
    assert.ok(steps.indexOf(step) > stopIndex, step.name ?? step.uses ?? step.run);
    assert.doesNotMatch(step.if ?? "", /always\(|failure\(|cancelled\(/u);
    assert.equal(step["continue-on-error"], undefined);
  }
  // A failed/missing setup decision must stop the shell; no installer fallback.
  const bin = await mkdtemp(path.join(tmpdir(), "full-setup-shell-contract-"));
  try {
    await writeFile(path.join(bin, "node"), "#!/bin/sh\nprintf '[precheck] missing setup risk\\n' >&2\nexit 9\n", { mode: 0o755 });
    await assert.rejects(promisify(execFile)("bash", ["-c", setup.run], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, REQUESTED_BASE: "a".repeat(40), EXPECTED_HEAD: "b".repeat(40), MAX_PARALLEL_TASKS: "12" }, timeout: 10000 }), (error) => error.code === 9 && /missing setup risk/u.test(error.stderr));
  } finally { await rm(bin, { recursive: true, force: true }); }
});

test("Full preparation observations reject overruns and influence residual estimates without cache-zero admission", () => {
  const before = [syntheticFilesystem("workspace")];
  const low = new Map([["workspace", { bytes: 700n, inodes: 80n }]]);
  assert.throws(() => assertPreparationEnvelope(before, low, assessFullDemand(before, [syntheticTerm()])), /overrun/u);
  assertPreparationEnvelope(before, low, assessFullDemand(before, [syntheticTerm("workspace", "400", "30")]));
  const term = { ...syntheticTerm(), id: "build", measurement: { preparationId: "native.build", mode: "peak", location: "workspace" } };
  const samples = [{ id: "native.build", before, after: [syntheticFilesystem("workspace", "1", "1000", "100")], lowWater: [syntheticFilesystem("workspace", "1", "700", "80")] }];
  assert.deepEqual(resolveObservedResidual([term], samples)[0], { ...term, bytes: "300", inodes: "20" });
  assert.deepEqual(resolveObservedResidual([{ ...term, measurement: { ...term.measurement, mode: "retained" } }], samples)[0].bytes, "200");
  assert.throws(() => resolveObservedResidual([term], []), /actual same-job/u);
});

test("Full workload-risk ledger rejects missing consumers, sizing, source freshness and stale owner", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "full-risk-contract-"));
  try {
    const source = "public synthetic sizing source\n";
    await writeFile(path.join(temporary, "source.txt"), source);
    const registry = JSON.parse(await readFile(path.join(repoRoot, "scripts/local-ci-registry.json"), "utf8"));
    const plan = buildLocalCiPlan(registry, { profile: "full", base: "a".repeat(40), head: "b".repeat(40) });
    const preparation = fullPreparation(plan);
    const binding = { head: "b".repeat(40), registryDigest: plan.registryDigest, runId: "1", attempt: "1" };
    const term = (id, kind, domain) => ({ id, kind, domain, location: "workspace", bytes: "200", inodes: "10", basis: "synthetic contract only, not an actual risk estimate", operation: "construct synthetic fixture", sources: [0] });
    const estimate = {
      binding, sources: [{ path: "source.txt", sha256: createHash("sha256").update(source).digest("hex") }],
      tasks: plan.tasks.map((task) => task.id),
      preparation: preparation.map((step) => ({ id: step.id, commandDigest: createHash("sha256").update(JSON.stringify(step.command)).digest("hex"), timeoutMs: 1000, terms: [term("retained", "retained", "cache-environment"), term("transient", "transient", "build-link-doctest"), term("uncertainty", "uncertainty", "logs-reports")] })),
      residual: [
        { ...term("build", "transient", "build-link-doctest"), measurement: { preparationId: "native.build", mode: "peak", location: "workspace" } },
        term("fixtures", "retained", "fixtures-db-wal-backup"), term("copies", "retained", "failure-tmproot-artifact-copy"),
        term("environment", "retained", "cache-environment"), term("logs", "uncertainty", "logs-reports"),
      ],
    };
    const validate = (value) => validateWorkloadEstimate(value, binding, plan, preparation, temporary);
    await validate(estimate);
    for (const mutate of [
      (value) => { value.binding.attempt = "2"; },
      (value) => { value.tasks.pop(); },
      (value) => { value.tasks[0] = value.tasks[1]; },
      (value) => { value.sources[0].sha256 = "0".repeat(64); },
      (value) => { value.sources[0].path = "../escape"; },
      (value) => { value.preparation[0].commandDigest = "0".repeat(64); },
      (value) => { value.preparation[0].timeoutMs = 0; },
      (value) => { value.residual.pop(); },
      (value) => { value.residual[1].bytes = "0"; },
      (value) => { value.residual[1].basis = ""; },
      (value) => { delete value.residual[0].measurement; },
      (value) => { value.residual[0].measurement.preparationId = "foreign"; },
    ]) {
      const malformed = structuredClone(estimate);
      mutate(malformed);
      await assert.rejects(validate(malformed), /\[precheck\]/u);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("Reviewed Full workload data covers the real plan and rejects source, tuple, placement and backup drift", async () => {
  // Real proposed risk data, not a resource probe/admission or fixture/app run.
  const data = JSON.parse(await readFile(path.join(repoRoot, "scripts/local-ci-full-workload-allocation.json"), "utf8"));
  assert.deepEqual(Object.keys(data).sort(), ["version", "registryDigest", "maxParallelTasks", "sources", "inventories", "setup", "preparation", "tasks"].sort());
  assert.equal(data.version, "full-workload-allocation/1");
  assert.equal(new Set(data.sources.map(({ path }) => path)).size, data.sources.length);
  assert.ok(!data.sources.some(({ path }) => path === "scripts/local-ci-full-workload-allocation.json"));
  const registry = JSON.parse(await readFile(path.join(repoRoot, "scripts/local-ci-registry.json"), "utf8"));
  const plan = buildLocalCiPlan(registry, { profile: "full", base: "a".repeat(40), head: "b".repeat(40) });
  const preparation = fullPreparation(plan);
  assert.equal(data.registryDigest, plan.registryDigest);
  assert.equal(data.maxParallelTasks, 12);
  assert.deepEqual(data.tasks.map(({ id }) => id), plan.tasks.map(({ id }) => id));
  assert.deepEqual(data.preparation.map(({ id, commandDigest }) => ({ id, commandDigest })), preparation.map(({ id, command }) => ({ id, commandDigest: createHash("sha256").update(JSON.stringify(command)).digest("hex") })));
  const binding = { head: "b".repeat(40), registryDigest: data.registryDigest, maxParallelTasks: 12, runId: "1", attempt: "1" };
  const locations = fullSetupLocations(repoRoot, {
    FULL_PNPM_DEST: "/synthetic/pnpm", npm_config_store_dir: "/synthetic/store",
    PLAYWRIGHT_BROWSERS_PATH: "/synthetic/browser", UV_CACHE_DIR: "/synthetic/uv",
  });
  const input = { version: "full-workload-input/1", binding, sources: data.sources, inventories: data.inventories, setup: data.setup, preparation: data.preparation, tasks: data.tasks };
  const produce = (value) => produceWorkloadEstimate(value, binding, repoRoot, locations);
  const estimate = await produce(input);
  await validateFullSetupEstimate(estimate, binding, repoRoot);
  await validateWorkloadEstimate(estimate, binding, plan, preparation, repoRoot);
  assert.equal(estimate.tasks.length, 68);
  // The tracked recipes charge Cargo compilation to workspace. Canonical paths
  // alone are insufficient: a target may be a disjoint mounted descendant.
  const cargoLabels = ["cargo-shared", "cargo-shared-package", "cargo-native", "cargo-native-package"];
  const compileTerms = [...estimate.preparation.flatMap(({ terms }) => terms), ...estimate.residual];
  const compileSum = (metric) => compileTerms.reduce((sum, term) => sum + BigInt(term[metric]), 0n);
  const compileSpace = locations.map(([label]) => syntheticFilesystem(label, "workspace-device", String(compileSum("bytes") + 1n), String(compileSum("inodes") + 1n)));
  const observedTargets = cargoLabels.map((label) => ({ ...compileSpace[0], label }));
  const compileReport = assessFullDemand(compileSpace, compileTerms);
  assert.deepEqual(assessFullDemand([...compileSpace, ...observedTargets], compileTerms), compileReport, "observation aliases do not add another compilation allocation");
  for (const label of cargoLabels) {
    for (const metric of ["bytes", "inodes"]) {
      const disjoint = observedTargets.map((fs) => fs.label === label ? { ...fs, device: "disjoint-cargo", [metric]: "1" } : fs);
      assert.throws(() => assessFullDemand([...compileSpace, ...disjoint], compileTerms), /Cargo targets on the charged workspace device before preparation/u);
      // Same-device enabled target quotas constrain the aggregate workspace
      // demand, despite abundant workspace capacity and no term at that alias.
      const quotas = disabledQuotas();
      quotas[0] = { type: 0, state: "kernel-enabled", bytes: null, inodes: null, [metric]: String(compileSum(metric)) };
      const limited = observedTargets.map((fs) => fs.label === label ? { ...fs, quotas } : fs);
      assert.throws(() => assessFullDemand([...compileSpace, ...limited], compileTerms), /capacity\/quota/u);
    }
  }
  assert.equal(estimate.residual.filter(({ id }) => /^journey\.[0-9]+\.tmp$/u.test(id)).length, 33);
  // The actual runner retains a Node-temp original while evidence copies only
  // DB/backup/manifest to workspace. Neither device can borrow the other's room.
  const fixture = data.inventories.find(({ id }) => id === "c2zc.fixture");
  const original = estimate.residual.find(({ id }) => id === "c2zc.fixture");
  const copy = estimate.residual.find(({ id }) => id === "c2zc.fixture.copy");
  assert.equal(original.location, "node-temp");
  assert.equal(copy.location, "workspace");
  const copiedItems = fixture.items.filter(({ role }) => ["db", "backup", "manifest"].includes(role));
  for (const metric of ["bytes", "inodes"]) {
    const total = (items) => items.reduce((sum, item) => sum + BigInt(item[metric]), 0n);
    assert.equal(BigInt(original[metric]), total(fixture.items));
    assert.equal(BigInt(copy[metric]), total(copiedItems));
    const baseline = estimate.residual.filter((term) => term !== original);
    const ample = locations.map(([label]) => syntheticFilesystem(label, label,
      String(estimate.residual.reduce((sum, term) => sum + BigInt(term.bytes), 0n) + 1n),
      String(estimate.residual.reduce((sum, term) => sum + BigInt(term.inodes), 0n) + 1n)));
    const baselineReport = assessFullDemand(ample, baseline);
    const limited = structuredClone(ample);
    limited.find(({ label }) => label === "node-temp")[metric] = String(BigInt(baselineReport.find(({ device }) => device === "node-temp")[metric === "bytes" ? "demandBytes" : "demandInodes"]) + 1n);
    assert.doesNotThrow(() => assessFullDemand(limited, baseline));
    assert.throws(() => assessFullDemand(limited, estimate.residual), /capacity\/quota/u);
  }
  const aliasedFixture = locations.map(([label]) => syntheticFilesystem(label, "shared-fixture",
    String(BigInt(original.bytes) + BigInt(copy.bytes) + 1n),
    String(BigInt(original.inodes) + BigInt(copy.inodes) + 1n)));
  const [fixtureDemand] = assessFullDemand(aliasedFixture, [original, copy]);
  assert.equal(BigInt(fixtureDemand.demandBytes), BigInt(original.bytes) + BigInt(copy.bytes));
  assert.equal(BigInt(fixtureDemand.demandInodes), BigInt(original.inodes) + BigInt(copy.inodes));
  assert.ok([original, copy].every((term) => term.sources.some((index) => data.sources[index].path === "scripts/local-ci.mjs")));
  for (const term of [...estimate.setup.terms, ...estimate.preparation.flatMap(({ terms }) => terms), ...estimate.residual]) {
    assert.ok(BigInt(term.bytes) > 0n && BigInt(term.inodes) > 0n);
  }
  // The SAME mutable images must reach their actual devices, not just an
  // ample tool-cache. All resource values below are synthetic, not probes.
  const mutableTerms = [
    ["node", "install.node", "tool-cache"], ["rust", "install.rust", "rustup-home"],
    ["system", "install.system", "root"], ["store", "install.packages", "pnpm-store"],
  ].map(([name, installer, location]) => {
    const id = `setup.mutable-${name}`;
    const inventory = data.inventories.find((entry) => entry.id === id);
    const installed = data.inventories.find((entry) => entry.id === installer).items.find((item) => item.role === "installed" && item.location === location);
    assert.deepEqual(inventory.items, [{ role: "scenario", bytes: installed.bytes, inodes: installed.inodes }]);
    const recipes = data.setup.map((recipe, index) => ({ recipe, index })).filter(({ recipe }) => recipe.inventories.includes(id));
    assert.equal(recipes.length, 1);
    assert.deepEqual(recipes[0].recipe, { kind: "uncertainty", domain: "cache-environment", location, inventories: [id] });
    const term = estimate.setup.terms.find((entry) => entry.id === `setup.${recipes[0].index}`);
    assert.equal(term.location, location);
    assert.equal(term.bytes, installed.bytes);
    assert.equal(term.inodes, installed.inodes);
    return term;
  });
  assert.ok(!data.inventories.some(({ id }) => id === "setup.mutable-images"));
  const sum = (terms, metric) => terms.reduce((total, term) => total + BigInt(term[metric]), 0n);
  assert.equal(sum(mutableTerms, "bytes"), 5494403072n);
  assert.equal(sum(mutableTerms, "inodes"), 719022n);
  const disjoint = locations.map(([label]) => syntheticFilesystem(label, label, String(sum(estimate.setup.terms, "bytes") + 1n), String(sum(estimate.setup.terms, "inodes") + 1n)));
  const report = assessFullSetupDemand(disjoint, estimate.setup.terms);
  const baseline = estimate.setup.terms.filter((term) => !mutableTerms.includes(term));
  const baselineReport = assessFullDemand(disjoint, baseline);
  for (const { location } of mutableTerms) {
    for (const metric of ["bytes", "inodes"]) {
      const limited = structuredClone(disjoint);
      const demandKey = metric === "bytes" ? "demandBytes" : "demandInodes";
      limited.find(({ label }) => label === location)[metric] = String(BigInt(baselineReport.find(({ device }) => device === location)[demandKey]) + 1n);
      assert.doesNotThrow(() => assessFullDemand(limited, baseline));
      assert.throws(() => assessFullSetupDemand(limited, estimate.setup.terms), /capacity\/quota/u);
    }
  }
  const aliased = disjoint.map((fs) => ({ ...fs, device: "shared" }));
  const [shared] = assessFullSetupDemand(aliased, estimate.setup.terms);
  assert.equal(BigInt(shared.demandBytes), report.reduce((total, fs) => total + BigInt(fs.demandBytes), 0n));
  assert.equal(BigInt(shared.demandInodes), report.reduce((total, fs) => total + BigInt(fs.demandInodes), 0n));
  for (const mutate of [
    (value) => { value.sources.at(-1).sha256 = "0".repeat(64); },
    (value) => { value.inventories.find(({ id }) => id === "c2zc.fixture").items.find(({ role }) => role === "backup").bytes = "0"; },
    (value) => { value.inventories.find(({ id }) => id === "journey.editor-persistence.failure").items.find(({ role }) => role === "backup").inodes = "0"; },
    (value) => { value.inventories.find(({ id }) => id === "install.packages").items.find(({ location }) => location === "pnpm-store").location = "workspace"; },
  ]) {
    const malformed = structuredClone(input);
    mutate(malformed);
    await assert.rejects(produce(malformed), /\[precheck\]/u);
  }
  for (const mutate of [
    (value) => { value.tasks.pop(); },
    (value) => { value.preparation[0].commandDigest = "0".repeat(64); },
  ]) {
    const malformed = structuredClone(input);
    mutate(malformed);
    const rejected = await produce(malformed);
    await assert.rejects(validateWorkloadEstimate(rejected, binding, plan, preparation, repoRoot), /\[precheck\]/u);
  }
});

test("Full producer acquires reviewed tracked data exclusively and constructs complete coexistence demand without missing-fact defaults", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "full-producer-contract-"));
  try {
    const paths = [
      ".github/workflows/canonical-ci.yml", "scripts/local-ci-registry.json",
      "scripts/nir1-c-query-worker-ci.sh",
      "src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_capacity_fixtures.rs",
      "src-tauri/crates/grimodex-db/src/narrative_extraction/c2zc_restore_fixture.rs",
      "electron/scripts/product-journey-harness.mjs", "electron/scripts/product-journey-catalog.mjs",
      "src/features/chat/chatScopeRegistry.json",
      "scripts/local-ci-full-admission.mjs", "scripts/local-ci-full-filesystems.py", "scripts/local-ci-process-supervisor.mjs",
      "scripts/local-ci.mjs", "scripts/local-ci-runner.mjs", "package.json", "pnpm-lock.yaml",
      "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "electron/native/grimodex-node/Cargo.toml", "electron/native/grimodex-node/Cargo.lock",
    ];
    const sources = [];
    for (const relative of paths) {
      const contents = await readFile(path.join(repoRoot, relative));
      await mkdir(path.dirname(path.join(temporary, relative)), { recursive: true });
      await writeFile(path.join(temporary, relative), contents);
      sources.push({ path: relative, sha256: createHash("sha256").update(contents).digest("hex") });
    }
    const registry = JSON.parse(await readFile(path.join(temporary, "scripts/local-ci-registry.json"), "utf8"));
    const plan = buildLocalCiPlan(registry, { profile: "full", base: "a".repeat(40), head: "b".repeat(40) });
    const preparation = fullPreparation(plan);
    const binding = { head: "b".repeat(40), registryDigest: plan.registryDigest, maxParallelTasks: 12, runId: "1", attempt: "1" };
    const { PRODUCT_JOURNEY_CATALOG } = await import("../electron/scripts/product-journey-catalog.mjs");
    // Invented small numbers are EXCLUSIVELY synthetic tests, never admission
    // defaults. No fixture construction, build, quota probe or app is executed.
    const inventory = (id, roles) => ({
      id, sources: sources.map((_, index) => index), basis: "synthetic physical allocation arithmetic, not runner evidence",
      operation: `synthetic inventory ${id}`, items: roles.map((role) => ({ ...(typeof role === "string" ? { role } : role), bytes: "10", inodes: "1" })),
    });
    const recipe = (kind, domain, inventories = ["risk.build"], location = "workspace") => ({ kind, domain, location, inventories });
    const terms = () => [recipe("retained", "cache-environment"), recipe("transient", "build-link-doctest"), recipe("uncertainty", "logs-reports", ["risk.uncertainty"])];
    const installedPlaces = {
      pnpm: ["pnpm-installer"], node: ["tool-cache"], rust: ["cargo-home", "rustup-home"], system: ["root"],
      uv: ["tool-cache"], packages: ["workspace", "pnpm-store-root", "pnpm-store"], browser: ["root"], audit: ["cargo-home"],
    };
    const installInventories = Object.entries(installedPlaces).map(([name, places]) => inventory(`install.${name}`, [
      ...places.map((location) => ({ role: "installed", location })),
      ...["download-cache", "extraction"].map((role) => ({ role, location: places[0] })),
      { role: "logs", location: "workspace" },
    ]));
    const locations = fullSetupLocations(temporary, {
      FULL_PNPM_DEST: "/synthetic/installer", npm_config_store_dir: "/synthetic/disjoint-store",
      PLAYWRIGHT_BROWSERS_PATH: "/synthetic/disjoint-browser", UV_CACHE_DIR: "/synthetic/disjoint-uv",
    });
    const input = {
      version: "full-workload-input/1", binding, sources,
      inventories: [
        inventory("risk.build", ["synthetic-build"]), inventory("risk.uncertainty", ["synthetic-additive-uncertainty"]),
        ...installInventories,
        ...["q2", "q512"].map((name) => inventory(`worker.${name}`, ["db", "wal", "shm", "journal", "construction"])),
        inventory("c2zc.fixture", ["db", "wal", "shm", "backup", "standalone", "manifest"]),
        inventory("fixtures.uncertainty", ["sqlite-allocation", "failure-copy", "unsampled-transient"]),
        ...PRODUCT_JOURNEY_CATALOG.flatMap(({ id }) => [
          inventory(`journey.${id}.runtime`, ["db", "wal", "shm", "user-data", "cache", "logs", "receipts", "other"]),
          inventory(`journey.${id}.failure`, ["backup", "receipt-snapshot", "diagnostics", "screenshot"]),
        ]),
      ],
      setup: [
        ...locations.flatMap(([label]) => ["retained", "transient", "uncertainty"].map((kind) => recipe(kind, "cache-environment", [kind === "uncertainty" ? "risk.uncertainty" : "risk.build"], label))),
        ...installInventories.flatMap(({ id, items }) => [...new Set(items.map(({ location }) => location))].map((location) => recipe("retained", "cache-environment", [id], location))),
      ],
      preparation: preparation.map((step) => ({ id: step.id, commandDigest: createHash("sha256").update(JSON.stringify(step.command)).digest("hex"), timeoutMs: 1000, terms: terms() })),
      tasks: plan.tasks.map(({ id }) => ({ id, terms: terms().map((entry) => entry.domain === "build-link-doctest" ? { ...entry, measurement: { preparationId: "native.build", mode: "peak", location: "workspace" } } : entry) })),
    };
    const produce = (value) => produceWorkloadEstimate(value, binding, temporary, locations);
    const estimate = await produce(input);
    await validateFullSetupEstimate(estimate, binding, temporary);
    await validateWorkloadEstimate(estimate, binding, plan, preparation, temporary);
    const find = (id) => estimate.residual.find((entry) => entry.id === id);
    assert.equal(find("worker.q2").bytes, "350"); // pristine plus SIX default copies
    assert.equal(find("worker.q512").bytes, "150"); // pristine plus TWO default copies
    assert.equal(find("worker.q2").inodes, "35");
    assert.equal(find("worker.q2").location, process.env.RUNNER_TEMP ? "runner-temp" : process.env.TMPDIR ? "unix-temp" : process.env.TMP ? "tmp-temp" : process.env.TEMP ? "temp-temp" : "unix-temp");
    assert.equal(find("c2zc.fixture").bytes, "60");
    assert.equal(find("c2zc.fixture").inodes, "6");
    assert.equal(find("c2zc.fixture").location, "node-temp");
    assert.equal(find("c2zc.fixture.copy").bytes, "30");
    assert.equal(find("c2zc.fixture.copy").inodes, "3");
    assert.equal(find("c2zc.fixture.copy").location, "workspace");
    assert.equal(find("journey.0.tmp").bytes, "120");
    assert.equal(find("journey.0.copy").bytes, "120");
    assert.equal(find("journey.0.screenshot").bytes, "10");
    assert.equal(estimate.residual.filter(({ id }) => /^journey\.[0-9]+\.tmp$/u.test(id)).length, PRODUCT_JOURNEY_CATALOG.length);
    assert.deepEqual(estimate.setup.destinations, locations);
    // Actual installer component recipes already cover their real destinations.
    // Observation-only root/home/alias labels must not force duplicate payloads.
    const noProbeCharges = structuredClone(input);
    noProbeCharges.setup = noProbeCharges.setup.filter((entry) => !["risk.build", "risk.uncertainty"].includes(entry.inventories[0]));
    noProbeCharges.setup.push(recipe("transient", "build-link-doctest"), recipe("uncertainty", "cache-environment", ["risk.uncertainty"]));
    const sourceDirected = await produce(noProbeCharges);
    assert.ok(sourceDirected.setup.terms.every((entry) => !["home", "root"].includes(entry.location) || entry.operation.includes("install.")));
    assert.ok(sourceDirected.setup.terms.every((entry) => entry.location !== "pnpm-store-root" || entry.operation.includes("install.packages")));
    await validateFullSetupEstimate(sourceDirected, binding, temporary);
    // Positive totals in other roles must not hide omitted mandatory backups.
    for (const id of ["c2zc.fixture", ...PRODUCT_JOURNEY_CATALOG.map(({ id }) => `journey.${id}.failure`)]) {
      for (const metrics of [["bytes"], ["inodes"], ["bytes", "inodes"]]) {
        const zeroBackup = structuredClone(input);
        const backup = zeroBackup.inventories.find((entry) => entry.id === id).items.find(({ role }) => role === "backup");
        for (const metric of metrics) backup[metric] = "0";
        await assert.rejects(produce(zeroBackup), (error) => error.message.includes(`positive physical byte/inode allocation for ${id}/backup; synthetic inventory ${id}`));
      }
    }
    // Workspace has ample room, but cache writes are on independent mounts.
    // These are synthetic observations ONLY, not a probe of the test host.
    const disjoint = locations.map(([label]) => syntheticFilesystem(label, label === "pnpm-store" ? "store" : label === "browser-cache" ? "browser" : "main", "100000", "10000"));
    const report = assessFullSetupDemand(disjoint, estimate.setup.terms);
    assert.equal(report.find(({ device }) => device === "store").demandBytes, "40"); // three risk terms plus placed package-store component
    assert.equal(report.find(({ device }) => device === "browser").demandBytes, "30");
    for (const label of ["pnpm-store", "browser-cache"]) {
      for (const metric of ["bytes", "inodes"]) {
        const limited = structuredClone(disjoint);
        const device = limited.find((fs) => fs.label === label).device;
        const demand = report.find((fs) => fs.device === device);
        limited.find((fs) => fs.label === label)[metric] = demand[metric === "bytes" ? "demandBytes" : "demandInodes"];
        assert.throws(() => assessFullSetupDemand(limited, estimate.setup.terms), /capacity\/quota/u);
      }
    }
    const before = [syntheticFilesystem("workspace", "1", "1000", "100")];
    const quiet = [{ id: "native.build", before, after: before, lowWater: before }];
    assert.equal(resolveObservedResidual(estimate.residual.filter((entry) => entry.measurement), quiet)[0].bytes, "10");
    const growing = [{ id: "native.build", before, after: [syntheticFilesystem("workspace", "1", "900", "90")], lowWater: [syntheticFilesystem("workspace", "1", "800", "80")] }];
    assert.equal(resolveObservedResidual(estimate.residual.filter((entry) => entry.measurement), growing)[0].bytes, "200");
    for (const mutate of [
      (value) => { value.binding.attempt = "2"; },
      (value) => { value.sources[0].sha256 = "0".repeat(64); },
      (value) => { value.inventories = value.inventories.filter(({ id }) => id !== "install.rust"); },
      (value) => { value.inventories.find(({ id }) => id === "worker.q2").items.pop(); },
      (value) => { value.inventories.find(({ id }) => id === "journey.editor-persistence.failure").items.pop(); },
      (value) => { value.inventories.find(({ id }) => id === "fixtures.uncertainty").items[0].bytes = "1e9"; },
      (value) => { value.inventories.find(({ id }) => id === "risk.uncertainty").items[0].bytes = "0"; },
      (value) => { value.inventories.push(value.inventories[0]); },
      (value) => { value.inventories.push(inventory("silently-unused", ["extra"])); },
      (value) => { value.setup[0].copies = 2; },
      (value) => { value.inventories.find(({ id }) => id === "install.pnpm").items[0].location = "workspace"; },
      (value) => { delete value.inventories.find(({ id }) => id === "install.packages").items[0].location; },
      (value) => { value.inventories.find(({ id }) => id === "install.packages").items.find(({ location }) => location === "pnpm-store").bytes = "0"; },
      (value) => { value.setup.find((entry) => entry.location === "pnpm-store" && entry.inventories.includes("install.packages")).location = "workspace"; },
      (value) => { value.setup.find((entry) => entry.inventories.includes("install.node")).location = "browser-cache"; },
      (value) => { value.setup = value.setup.filter((entry) => entry.location !== "tool-cache"); },
      (value) => { value.preparation[0].timeoutMs = 0; },
      (value) => { value.tasks[0].id = value.tasks[1].id; },
      (value) => { value.tasks[0].terms[1].measurement.preparationId = "foreign"; },
      (value) => { value.tasks[0].terms[1].measurement.location = "node-temp"; },
    ]) {
      const malformed = structuredClone(input);
      mutate(malformed);
      await assert.rejects(produce(malformed), /\[precheck\]/u);
    }
    // Exercise the actual dependency-free ingestion/filesystem writer with a
    // real disposable Git candidate. All numerical values remain synthetic.
    const allocationPath = "scripts/local-ci-full-workload-allocation.json";
    const allocationFile = path.join(temporary, allocationPath);
    const data = {
      version: "full-workload-allocation/1", registryDigest: binding.registryDigest, maxParallelTasks: binding.maxParallelTasks,
      sources: input.sources, inventories: input.inventories, setup: input.setup, preparation: input.preparation, tasks: input.tasks,
    };
    const directory = path.join(temporary, ".artifacts/local-ci/full-admission/1-1-setup");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const git = async (...args) => (await promisify(execFile)("git", args, { cwd: temporary, timeout: 10000 })).stdout;
    await git("init", "--initial-branch=contract");
    await git("config", "user.name", "Synthetic contract");
    await git("config", "user.email", "synthetic@example.invalid");
    const run = async (_id, command) => {
      assert.equal(command.command, "git");
      return git(...command.args);
    };
    const acquire = (signal, runner = run) => acquireWorkloadInput({ root: temporary, binding, directory, run: runner, signal, setupLocations: locations });
    const persistedInput = path.join(temporary, ".artifacts/local-ci/full-workload-input.json");
    const persistedEstimate = path.join(temporary, ".artifacts/local-ci/full-workload-estimate.json");
    await assert.rejects(acquire(), /acquire and independently review physical/u);
    await writeFile(allocationFile, JSON.stringify(data));
    await assert.rejects(acquire(), /tracked by this clean candidate/u);
    await git("add", "--", ...paths, allocationPath);
    await git("commit", "-m", "synthetic reviewed allocation dataset");
    binding.head = (await git("rev-parse", "HEAD")).trim();
    await writeFile(allocationFile, `${JSON.stringify(data)}\n`);
    await assert.rejects(acquire(), /byte-identical/u);
    await rm(allocationFile);
    await symlink(path.join(temporary, paths[0]), allocationFile);
    await assert.rejects(acquire(), /without symlink placement/u);
    await rm(allocationFile);
    // Even committed malformed/stale data must fail BEFORE creating run input.
    for (const mutate of [
      (value) => { value.binding = binding; },
      (value) => { value.admitted = true; },
      (value) => { value.registryDigest = "sha256:stale"; },
      (value) => { value.maxParallelTasks = 1; },
      (value) => { value.sources = value.sources.filter(({ path: name }) => name !== "pnpm-lock.yaml"); },
      (value) => { value.sources.push(value.sources[0]); },
      (value) => { value.sources[0].sha256 = "0".repeat(64); },
      (value) => { value.inventories = value.inventories.filter(({ id }) => id !== "worker.q2"); },
    ]) {
      const malformed = structuredClone(data);
      mutate(malformed);
      await writeFile(allocationFile, JSON.stringify(malformed));
      await git("add", "--", allocationPath);
      await git("commit", "-m", "synthetic malformed allocation adversary");
      binding.head = (await git("rev-parse", "HEAD")).trim();
      await assert.rejects(acquire(), /\[precheck\]/u);
      await assert.rejects(access(persistedInput), { code: "ENOENT" });
    }
    await writeFile(allocationFile, JSON.stringify(data));
    await git("add", "--", allocationPath);
    await git("commit", "-m", "synthetic valid allocation restoration");
    binding.head = (await git("rev-parse", "HEAD")).trim();
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(acquire(cancelled.signal), { name: "AbortError" });
    const pending = new AbortController();
    await assert.rejects(acquire(pending.signal, async (id, command) => {
      const result = await run(id, command);
      if (id === "allocation-committed") pending.abort();
      return result;
    }), { name: "AbortError" });
    await assert.rejects(access(persistedInput), { code: "ENOENT" });
    // A partial/ambiguous write cannot overwrite an earlier estimate or revive.
    await writeFile(persistedEstimate, "retained previous owner", { flag: "wx" });
    await assert.rejects(acquire(), { code: "EEXIST" });
    assert.equal(await readFile(persistedEstimate, "utf8"), "retained previous owner");
    const retainedInput = await readFile(persistedInput, "utf8");
    await assert.rejects(acquire(), { code: "EEXIST" });
    assert.equal(await readFile(persistedInput, "utf8"), retainedInput);
    await assert.rejects(access(path.join(directory, "workload-acquisition.json")), { code: "ENOENT" });
    // Isolated synthetic next owner only: production has NO recovery/removal.
    const nextRoot = await mkdtemp(path.join(tmpdir(), "full-acquisition-owner-contract-"));
    try {
      await git("clone", "--no-hardlinks", temporary, nextRoot);
      const nextDirectory = path.join(nextRoot, ".artifacts/local-ci/full-admission/1-1-setup");
      await mkdir(nextDirectory, { recursive: true, mode: 0o700 });
      const nextRun = async (_id, command) => (await promisify(execFile)(command.command, command.args, { cwd: nextRoot, timeout: 10000 })).stdout;
      const next = () => acquireWorkloadInput({ root: nextRoot, binding, directory: nextDirectory, run: nextRun, setupLocations: locations });
      const result = await next();
      const receipt = JSON.parse(await readFile(path.join(nextDirectory, "workload-acquisition.json"), "utf8"));
      const current = { input: result.input, allocation: { path: allocationPath, sha256: createHash("sha256").update(await readFile(allocationFile)).digest("hex") } };
      validateWorkloadAcquisition(receipt, current, result.input, result.estimate, binding);
      for (const file of ["full-workload-input.json", "full-workload-estimate.json", "full-admission/1-1-setup/workload-acquisition.json"]) assert.equal((await stat(path.join(nextRoot, ".artifacts/local-ci", file))).mode & 0o777, 0o600);
      assert.deepEqual(result.input.binding, binding);
      assert.equal(result.input.version, "full-workload-input/1");
      await assert.rejects(next(), { code: "EEXIST" });
      for (const mutate of [
        (value) => { value.state = "pending"; },
        (value) => { value.binding.attempt = "2"; },
        (value) => { value.allocation.sha256 = "0".repeat(64); },
        (value) => { value.inputDigest = "0".repeat(64); },
        (value) => { value.estimateDigest = "0".repeat(64); },
      ]) {
        const stale = structuredClone(receipt);
        mutate(stale);
        assert.throws(() => validateWorkloadAcquisition(stale, current, result.input, result.estimate, binding), /unchanged reviewed allocation/u);
      }
      const changedInput = structuredClone(result.input);
      changedInput.tasks.pop();
      assert.throws(() => validateWorkloadAcquisition(receipt, { ...current, input: changedInput }, result.input, result.estimate, binding), /unchanged reviewed allocation/u);
    } finally { await rm(nextRoot, { recursive: true, force: true }); }
    // Different source copy topology must change sizing, not a fixed multiplier.
    const workerPath = path.join(temporary, "scripts/nir1-c-query-worker-ci.sh");
    await writeFile(workerPath, `${await readFile(workerPath, "utf8")}\ncp -- "$q2_fixture_file" "$synthetic_extra_input"\n`);
    await assert.rejects(produce(input), /current sizing source digest/u);
    const changed = structuredClone(input);
    changed.sources.find(({ path: name }) => name === "scripts/nir1-c-query-worker-ci.sh").sha256 = createHash("sha256").update(await readFile(workerPath)).digest("hex");
    assert.equal((await produce(changed)).residual.find(({ id }) => id === "worker.q2").bytes, "400");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("Full quota adapter treats kernel disabled, unknown and soft-grace limits distinctly without probing host quotas", async () => {
  const source = `
import ctypes, errno, importlib.util, os
spec = importlib.util.spec_from_file_location('quota', 'scripts/local-ci-full-filesystems.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
assert m.remaining(1000, 500, 400, 0, 100) == 100
assert m.remaining(1000, 500, 600, 200, 100) == 0
assert m.remaining(0, 0, 400, 0, 100) is None
class Query:
    def __init__(self, error): self.error = error
    def __call__(self, *args): ctypes.set_errno(self.error); return -1
class Lib:
    def __init__(self, error): self.quotactl = Query(error)
# Only the quota syscall is shimmed. This harmless read concerns the repository
# directory; it never invokes quotactl or examines a foreign process.
mounts = '1 0 8:1 / / rw - ext4 /dev/synthetic rw'
result = m.inspect([['workspace', os.getcwd()]], os.getuid(), [os.getgid()], libc=Lib(errno.ESRCH), mountinfo=mounts)
assert [q['state'] for q in result[0]['quotas']] == ['kernel-disabled'] * 3
assert result[0]['allocationUnit'] == str(os.statvfs(os.getcwd()).f_frsize)
for error in (errno.EACCES, errno.EINVAL, errno.ENOSYS):
    try: m.inspect([['workspace', os.getcwd()]], os.getuid(), [os.getgid()], libc=Lib(error), mountinfo=mounts)
    except ValueError: pass
    else: raise AssertionError('unknown quota must reject')
try: m.inspect([['workspace', os.getcwd()]], os.getuid(), [os.getgid()], libc=Lib(errno.ESRCH), mountinfo=mounts.replace('ext4', 'overlay'))
except ValueError: pass
else: raise AssertionError('unsupported quota acquisition must reject')
`;
  await promisify(execFile)("python3", ["-c", source], { cwd: repoRoot, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, timeout: 10000 });
});

test("Full setup enforces SGID and non-SGID grpid destination quotas outside caller groups and rejects unreadable records", async () => {
  const source = `
import ctypes, errno, importlib.util, json, stat
from types import SimpleNamespace
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('quota', 'scripts/local-ci-full-filesystems.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
class Query:
    def __init__(self): self.groups = []; self.denied = False
    def __call__(self, command, special, identity, pointer):
        domain, operation = command & 0xff, command >> 8
        if domain != 1:
            ctypes.set_errno(errno.ESRCH); return -1
        if operation == 0x800005: return 0
        assert operation == 0x800007
        self.groups.append(identity)
        if identity == 77 and self.denied:
            ctypes.set_errno(errno.EACCES); return -1
        block = pointer._obj
        block.valid = 0x3f
        if identity == 77: block.bhard = 1; block.ihard = 4
        return 0
query = Query()
lib = SimpleNamespace(quotactl=query)
destination = SimpleNamespace(st_mode=stat.S_IFDIR | stat.S_ISGID | 0o770, st_gid=77, st_dev=1)
capacity = SimpleNamespace(f_flag=0, f_bavail=16, f_frsize=4096, f_favail=1000)
mounts = '1 0 8:1 / / rw - ext4 /dev/synthetic rw'
# All storage and quota observations are synthetic: no chmod/chown, foreign
# group lookup, real quota syscall or host filesystem capacity acquisition.
with patch.object(m.os, 'stat', return_value=destination), patch.object(m.os, 'statvfs', return_value=capacity), patch.object(m.os.path, 'realpath', side_effect=lambda value: value), patch.object(m.os.path, 'exists', side_effect=lambda value: value == '/synthetic/sgid'):
    def inspect(requested='/synthetic/sgid', groups=(11, 12), mountinfo=mounts):
        query.groups.clear()
        return m.inspect([['workspace', requested]], 10, groups, libc=lib, mountinfo=mountinfo)
    sgid = inspect()
    assert sgid[0]['allocationUnit'] == '4096'
    capacity.f_frsize = 65536
    assert inspect()[0]['allocationUnit'] == '65536', 'actual geometry must not be replaced with the forecast unit'
    capacity.f_frsize = 4096
    assert query.groups == [11, 12, 77], query.groups
    assert inspect('/synthetic/sgid/pending/cache') == sgid
    assert query.groups == [11, 12, 77], query.groups
    assert inspect(groups=(11, 12, 77)) == sgid
    assert query.groups == [11, 12, 77], query.groups
    query.denied = True
    try: inspect()
    except ValueError as error: assert 'current-identity quota unavailable' in str(error)
    else: raise AssertionError('unreadable enabled SGID group quota must reject')
    query.denied = False
    destination.st_mode &= ~stat.S_ISGID
    ordinary = inspect()
    assert query.groups == [11, 12], query.groups
    inherited = []
    for option in ('grpid', 'bsdgroups'):
        for mountinfo in (mounts.replace(' / rw - ', ' / rw,' + option + ' - '), mounts + ',' + option):
            inherited.append(inspect(mountinfo=mountinfo))
            assert inherited[-1] == sgid
            assert query.groups == [11, 12, 77], query.groups
            assert inspect('/synthetic/sgid/pending/cache', mountinfo=mountinfo) == sgid
            assert query.groups == [11, 12, 77], query.groups
            assert inspect(groups=(11, 12, 77), mountinfo=mountinfo) == sgid
            assert query.groups == [11, 12, 77], query.groups
            query.denied = True
            try: inspect(mountinfo=mountinfo)
            except ValueError as error: assert 'current-identity quota unavailable' in str(error)
            else: raise AssertionError('unreadable enabled non-SGID parent group quota must reject')
            query.denied = False
    for option in ('nogrpid', 'sysvgroups'):
        assert inspect(mountinfo=mounts + ',' + option) == ordinary
        assert query.groups == [11, 12], query.groups
    # Group inheritance must use the actual destination mount, not an ancestor
    # mount's policy or a mode on another filesystem.
    nested = '2 1 8:2 / /synthetic/sgid rw - ext4 /dev/nested rw'
    assert inspect(mountinfo=mounts + ',grpid\\n' + nested) == ordinary
    assert query.groups == [11, 12], query.groups
    assert inspect(mountinfo=mounts + '\\n' + nested + ',grpid') == sgid
    assert query.groups == [11, 12, 77], query.groups
print(json.dumps({'sgid': sgid, 'ordinary': ordinary, 'inherited': inherited}))
`;
  const { stdout } = await promisify(execFile)("python3", ["-c", source], { cwd: repoRoot, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, timeout: 10000 });
  const { sgid, ordinary, inherited } = JSON.parse(stdout);
  const terms = (bytes, inodes) => ["retained", "transient", "uncertainty"].map((kind) => ({ ...syntheticTerm("workspace", bytes, inodes), kind }));
  assert.equal(assessFullSetupDemand(sgid, terms("100", "1"))[0].bytes, "1024");
  assert.throws(() => assessFullSetupDemand(sgid, terms("400", "1")), /capacity\/quota/u);
  assert.throws(() => assessFullSetupDemand(sgid, terms("100", "2")), /capacity\/quota/u);
  assert.doesNotThrow(() => assessFullSetupDemand(ordinary, terms("400", "2")));
  for (const filesystem of inherited) {
    assert.equal(assessFullSetupDemand(filesystem, terms("100", "1"))[0].bytes, "1024");
    assert.throws(() => assessFullSetupDemand(filesystem, terms("400", "1")), /capacity\/quota/u);
    assert.throws(() => assessFullSetupDemand(filesystem, terms("100", "2")), /capacity\/quota/u);
  }
});

test("canonical shell uses one immutable tuple/options and verifies only profile success", async () => {
  const workflow = await readWorkflow(".github/workflows/canonical-ci.yml");
  const steps = workflow.jobs.canonical.steps;
  const selection = steps.find(({ name }) => name === "Validate canonical selection");
  const stop = steps.find(({ name }) => name === "Full prerequisites remain unresolved");
  const canonical = steps.find(({ id }) => id === "canonical");
  assert.equal(selection.if, undefined);
  assert.equal(stop.if, "inputs.profile == 'full'");
  assert.equal(canonical.if, "inputs.profile != 'contracts'");
  assert.deepEqual(canonical.env, selection.env);
  assert.match(canonical.run, /readonly candidate_base=/u);
  assert.match(canonical.run, /readonly candidate_head=/u);
  const inspectionStart = canonical.run.indexOf('if [[ "$PROFILE" == full ]]; then');
  const profileStart = canonical.run.indexOf('pnpm "ci:local:$PROFILE"');
  assert.ok(inspectionStart > canonical.run.indexOf('git merge-base --is-ancestor'));
  assert.ok(inspectionStart < profileStart);
  const inspection = canonical.run.slice(inspectionStart, profileStart);
  assert.ok(inspection.includes('node scripts/local-ci-full-admission.mjs "$candidate_base" "$candidate_head" "$MAX_PARALLEL_TASKS"'));
  assert.match(inspection, /\[precheck\] Full conditional admission is not yet enabled:[\s\S]*exit 1/u);
  assert.doesNotMatch(inspection, /recover-lock|unlink|^\s*(?:sudo|kill)\b/mu);
  assert.equal((canonical.run.match(/--base "\$candidate_base" --head "\$candidate_head" --max-parallel-tasks "\$MAX_PARALLEL_TASKS"/gu) ?? []).length, 2);
  const execute = promisify(execFile);
  const temporary = await mkdtemp(path.join(tmpdir(), "canonical-ci-contract-"));
  const cwd = path.join(temporary, "checkout");
  const bin = path.join(temporary, "bin");
  const calls = path.join(temporary, "calls.jsonl");
  const inspectionCalls = path.join(temporary, "inspection.jsonl");
  try {
    await mkdir(cwd);
    await mkdir(bin);
    await writeFile(path.join(bin, "pnpm"), `#!${process.execPath}\nconst { appendFileSync } = require('node:fs');\nconst args = process.argv.slice(2);\nappendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');\nif (process.env.FAIL_PROFILE === '1') process.exitCode = 7;\n`, { mode: 0o755 });
    // Synthetic admission only: no real preparation/quota/host probe in contracts.
    await writeFile(path.join(bin, "node"), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(process.env.INSPECTION_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');\nif (process.env.INSPECTION_UNAVAILABLE === '1') { console.error('[precheck] Full scoped filesystem/quota acquisition unavailable'); process.exitCode = 9; }\n`, { mode: 0o755 });
    const git = (...args) => execute("git", args, { cwd, timeout: 10000 });
    await git("init", "--initial-branch=contract");
    await writeFile(path.join(cwd, "source.txt"), "public synthetic fixture\n");
    await git("add", "source.txt");
    await git("-c", "user.name=Contract", "-c", "user.email=contract@example.invalid", "commit", "-m", "Synthetic workflow contract");
    const sha = (await git("rev-parse", "HEAD")).stdout.trim();
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CALLS: calls, INSPECTION_CALLS: inspectionCalls, INSPECTION_UNAVAILABLE: "0", PROFILE: "quick", REQUESTED_BASE: sha, EXPECTED_HEAD: sha, GITHUB_SHA: sha, MAX_PARALLEL_TASKS: "3", FAIL_PROFILE: "0" };
    const shell = (source, overrides = {}) => execute("bash", ["-c", source], { cwd, env: { ...env, ...overrides }, timeout: 10000 });
    await assert.rejects(shell(stop.run), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /\[precheck\] Full requires candidate acceptance\/freeze, prerequisite closure and actual-runner resource-isolation admission/u);
      return true;
    });
    await assert.rejects(access(calls));
    await assert.rejects(access(inspectionCalls));
    await shell(selection.run);
    await shell(canonical.run);
    assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n").map(JSON.parse), [
      ["ci:local:quick", "--", "--base", sha, "--head", sha, "--max-parallel-tasks", "3"],
      ["ci:local:verify", "--", "quick", "--base", sha, "--head", sha, "--max-parallel-tasks", "3"],
    ]);
    await assert.rejects(access(inspectionCalls), "Quick must not inspect Full resources");
    await writeFile(calls, "");
    await shell(selection.run, { PROFILE: "full" });
    await assert.rejects(shell(canonical.run, { PROFILE: "full" }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /\[precheck\] Full conditional admission is not yet enabled/u);
      return true;
    });
    assert.deepEqual((await readFile(inspectionCalls, "utf8")).trim().split("\n").map(JSON.parse), [["scripts/local-ci-full-admission.mjs", sha, sha, "3"]]);
    assert.equal(await readFile(calls, "utf8"), "", "even successful conditional admission remains fenced until review and prerequisites");
    await writeFile(inspectionCalls, "");
    await assert.rejects(shell(canonical.run, { PROFILE: "full", INSPECTION_UNAVAILABLE: "1" }), (error) => {
      assert.equal(error.code, 9);
      assert.match(error.stderr, /\[precheck\] Full scoped filesystem\/quota acquisition unavailable/u);
      return true;
    });
    assert.equal(await readFile(calls, "utf8"), "", "missing facts must not start Full or verify");
    await writeFile(inspectionCalls, "");
    await assert.rejects(shell(canonical.run, { FAIL_PROFILE: "1" }));
    const failedCalls = (await readFile(calls, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(failedCalls.length, 1);
    assert.equal(failedCalls[0][0], "ci:local:quick");
    for (const overrides of [
      { REQUESTED_BASE: "$(touch injected)" },
      { EXPECTED_HEAD: "0".repeat(40) },
      { MAX_PARALLEL_TASKS: "13" },
      { MAX_PARALLEL_TASKS: "0" },
      { PROFILE: "contracts" },
    ]) await assert.rejects(shell(selection.run, overrides));
    await assert.rejects(access(path.join(cwd, "injected")));
    await writeFile(calls, "");
    await writeFile(path.join(cwd, "source.txt"), "dirty\n");
    await assert.rejects(shell(canonical.run));
    await assert.rejects(shell(canonical.run, { PROFILE: "full" }));
    assert.equal(await readFile(calls, "utf8"), "");
    assert.equal(await readFile(inspectionCalls, "utf8"), "", "dirty candidate must fail before inspection");
    await writeFile(path.join(cwd, "source.txt"), "public synthetic fixture\n");
    await assert.rejects(shell(canonical.run, { GITHUB_SHA: "0".repeat(40) }));
    await assert.rejects(shell(canonical.run, { REQUESTED_BASE: "0".repeat(40) }));
    assert.equal(await readFile(calls, "utf8"), "");
  } finally {
    await rm(temporary, { recursive: true, force: true });
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
