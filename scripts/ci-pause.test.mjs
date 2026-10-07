import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
    if (id !== "electron" && id !== "canonical") assert.match(job.if, /!inputs\.source_focused/u, id);
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
    if (id === "electron" || id === "canonical") continue;
    const canonicalExclusion = " && !inputs.canonical_profile && !inputs.candidate_base && !inputs.candidate_head && !inputs.max_parallel_tasks";
    const independentExclusion = ["electron-runtime-performance", "electron-product-journeys", "electron-native", "rust", "migration-recovery-gate"].includes(id)
      ? " && !inputs.independent_gates" : "";
    assert.equal(job.if, id === "electron-product-journeys"
      ? `\${{ !inputs.source_focused && !inputs.source_canonical_contracts${canonicalExclusion}${independentExclusion} }}`
      : `github.event_name != 'schedule' && !inputs.source_focused && !inputs.source_canonical_contracts${canonicalExclusion}${independentExclusion}`, id);
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
  assert.equal(owner.if, "${{ inputs.canonical_profile || inputs.candidate_base || inputs.candidate_head || inputs.max_parallel_tasks }}");
  assert.equal(owner.with.profile, "${{ !inputs.independent_gates && !inputs.source_focused && !inputs.source_resolve_sharp && !inputs.source_audit_compat && !inputs.source_canonical_contracts && inputs.product_journey_mode == 'all' && inputs.canonical_profile || 'invalid' }}");
  assert.equal(owner.with.candidate_base, "${{ inputs.candidate_base || '' }}");
  assert.equal(owner.with.candidate_head, "${{ inputs.candidate_head || '' }}");
  assert.equal(owner.with.max_parallel_tasks, "${{ inputs.max_parallel_tasks || '12' }}");
  // Only this workflow's boolean/string-equality expression subset; GitHub
  // string equality is case-insensitive. Actual reusable dispatch is hosted proof.
  const value = (expression, inputs, event = "workflow_dispatch") => new Function("inputs", "github", `return (${expression
    .replace(/^\$\{\{\s*|\s*\}\}$/gu, "")
    .replace(/(inputs\.\w+|github\.\w+)\s*([!=]=)\s*('[^']*')/gu, "String($1 ?? '').toLowerCase() $2 $3")});`)(inputs, { event_name: event });
  const defaults = Object.fromEntries(Object.entries(dispatch).map(([name, input]) => [name, input.default ?? ""]));
  const ordinary = Object.keys(ci.jobs).filter((id) => id !== "canonical");
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
  for (const id of independent) {
    for (const step of ci.jobs[id].steps) {
      assert.doesNotMatch(step.run ?? "", /sudo\s+rm\s+-rf\b/u, `${id} must not delete host caches`);
    }
  }
  assert.deepEqual(ci.jobs["nir1-c-query-worker"].strategy, {
    "fail-fast": false, matrix: { os: ["ubuntu-latest", "macos-latest", "windows-latest"] },
  });
  assert.equal(ci.jobs["nir1-c-query-worker"].steps.at(-1).run, "bash scripts/nir1-c-query-worker-ci.sh");
  assert.deepEqual(admitted({ ...defaults, independent_gates: true, source_focused: true }), ["electron"]);
  assert.deepEqual(admitted({ ...defaults, independent_gates: true, source_canonical_contracts: true }), ["electron"]);
  for (const field of ["canonical_profile", "candidate_base", "candidate_head", "max_parallel_tasks"]) {
    for (const malformed of ["none", "NONE", " ", "0", "$(touch injected)"]) {
      assert.deepEqual(admitted({ ...defaults, [field]: malformed }), ["canonical"], `${field}=${malformed}`);
      assert.deepEqual(admitted({ ...defaults, independent_gates: true, [field]: malformed }), ["canonical"], `independent ${field}=${malformed}`);
    }
  }
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
  const stop = steps[0];
  assert.equal(stop.if, "inputs.profile == 'full'");
  assert.match(stop.run, /\[precheck\][\s\S]*exit 1/u);
  assert.doesNotMatch(stop.run, /df |quota|dbus|sudo|pnpm|ci:local:/u);
  const checkout = steps.find(({ uses }) => uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ github.sha }}");
  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(checkout.with["persist-credentials"], false);
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
  assert.equal(sourceUpload.if, "always() && steps.contracts.outcome != 'skipped'");
  assert.equal(sourceUpload.with.name, "canonical-source-${{ github.run_id }}-${{ github.run_attempt }}");
  assert.equal(sourceUpload.with["include-hidden-files"], true);
  assert.equal(sourceUpload.with["if-no-files-found"], "error");
  assert.deepEqual(sourceUpload.with.path.trim().split("\n"), [
    ".artifacts/canonical-source/checkout-identity.json",
    ".artifacts/canonical-source/contracts.tap",
  ]);
  for (const step of steps) {
    assert.equal(step["continue-on-error"], undefined);
    if (step.run) assert.doesNotMatch(step.run, /\$\{\{ inputs\.|--dry-run|--from|--recover-lock|\|\|\s*true/u);
  }
  const upload = steps.find(({ name }) => name === "Upload existing canonical evidence");
  assert.equal(upload.if, "always() && steps.canonical.outcome != 'skipped'");
  assert.equal(upload.with["include-hidden-files"], true);
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.ok(upload.with.path.includes(".artifacts/local-ci/"));
});

test("canonical shell uses one immutable tuple/options and verifies only profile success", async () => {
  const workflow = await readWorkflow(".github/workflows/canonical-ci.yml");
  const steps = workflow.jobs.canonical.steps;
  const selection = steps.find(({ name }) => name === "Validate canonical selection");
  const canonical = steps.find(({ id }) => id === "canonical");
  assert.equal(selection.if, undefined);
  assert.equal(canonical.if, "inputs.profile != 'contracts'");
  assert.deepEqual(canonical.env, selection.env);
  assert.match(canonical.run, /readonly candidate_base=/u);
  assert.match(canonical.run, /readonly candidate_head=/u);
  const inspectionStart = canonical.run.indexOf('if [[ "$PROFILE" == full ]]; then');
  const profileStart = canonical.run.indexOf('pnpm "ci:local:$PROFILE"');
  assert.ok(inspectionStart > canonical.run.indexOf('git merge-base --is-ancestor'));
  assert.ok(inspectionStart < profileStart);
  const inspection = canonical.run.slice(inspectionStart, profileStart);
  for (const fact of ["realpath(ancestor)", "constants.W_OK | constants.X_OK", "statfs(resolved", "process.cwd()", "['root', '/']", "process.env.HOME", "tmpdir()", "process.env.RUNNER_TEMP"]) {
    assert.ok(inspection.includes(fact), fact);
  }
  assert.match(inspection, /\[precheck\] Full inspection is not admission:[\s\S]*exit 1/u);
  assert.doesNotMatch(inspection, /mkdir|writeFile|unlink|spawn|execFile|recover-lock|^\s*(?:sudo|quota|df|kill)\b/mu);
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
    // Synthetic inspection only: no statfs/quota/host-resource probe in contracts.
    await writeFile(path.join(bin, "node"), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.readFileSync(0);\nfs.appendFileSync(process.env.INSPECTION_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');\nif (process.env.INSPECTION_UNAVAILABLE === '1') { console.error('[precheck] Full filesystem inspection unavailable: runner-temp'); process.exitCode = 9; }\n`, { mode: 0o755 });
    const git = (...args) => execute("git", args, { cwd, timeout: 10000 });
    await git("init", "--initial-branch=contract");
    await writeFile(path.join(cwd, "source.txt"), "public synthetic fixture\n");
    await git("add", "source.txt");
    await git("-c", "user.name=Contract", "-c", "user.email=contract@example.invalid", "commit", "-m", "Synthetic workflow contract");
    const sha = (await git("rev-parse", "HEAD")).stdout.trim();
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CALLS: calls, INSPECTION_CALLS: inspectionCalls, INSPECTION_UNAVAILABLE: "0", PROFILE: "quick", REQUESTED_BASE: sha, EXPECTED_HEAD: sha, GITHUB_SHA: sha, MAX_PARALLEL_TASKS: "3", FAIL_PROFILE: "0" };
    const shell = (source, overrides = {}) => execute("bash", ["-c", source], { cwd, env: { ...env, ...overrides }, timeout: 10000 });
    await assert.rejects(shell(steps[0].run));
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
      assert.match(error.stderr, /\[precheck\] Full inspection is not admission/u);
      return true;
    });
    assert.deepEqual((await readFile(inspectionCalls, "utf8")).trim().split("\n").map(JSON.parse), [["--input-type=module"]]);
    assert.equal(await readFile(calls, "utf8"), "", "successful inspection must not start Full or verify");
    await writeFile(inspectionCalls, "");
    await assert.rejects(shell(canonical.run, { PROFILE: "full", INSPECTION_UNAVAILABLE: "1" }), (error) => {
      assert.equal(error.code, 9);
      assert.match(error.stderr, /\[precheck\] Full filesystem inspection unavailable: runner-temp/u);
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
