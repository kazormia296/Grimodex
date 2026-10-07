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
        ? `\${{ inputs.canonical_profile == 'native-release-static' || inputs.canonical_profile == 'native-licensed-mcp' || (${ordinaryCondition}) }}`
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
  assert.equal(owner.if, "${{ !startsWith(inputs.canonical_profile, 'os-') && inputs.canonical_profile != 'shared-rust' && inputs.canonical_profile != 'migration-crash' && inputs.canonical_profile != 'migration-safe-mode' && inputs.canonical_profile != 'migration-library' && inputs.canonical_profile != 'migration-remaining' && inputs.canonical_profile != 'native-release-static' && inputs.canonical_profile != 'native-licensed-mcp' && (inputs.canonical_profile || inputs.candidate_base || inputs.candidate_head || inputs.max_parallel_tasks) }}");
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
  // Standalone selection reuses the complete ordinary Rust owner. Even mixed
  // inputs select only that owner, whose literal guard runs BEFORE any setup.
  const rust = ci.jobs.rust;
  const shared = { ...defaults, canonical_profile: "shared-rust" };
  assert.deepEqual(admitted(shared), ["rust"]);
  assert.equal(rust["runs-on"], "ubuntu-latest");
  assert.equal(rust["timeout-minutes"], 30);
  assert.deepEqual(rust.env, { CARGO_PROFILE_DEV_DEBUG: "0", CARGO_PROFILE_TEST_DEBUG: "0" });
  const sharedSelection = rust.steps[0];
  assert.equal(sharedSelection.name, "Validate standalone shared Rust selection");
  assert.equal(sharedSelection.if, "inputs.canonical_profile");
  assert.ok(rust.steps[1].uses.startsWith("actions/checkout@"));
  assert.doesNotMatch(sharedSelection.run, /\$\{\{ inputs\.|pnpm|cargo|sudo|\|\|\s*true/u);
  const executeShared = promisify(execFile);
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

  // Fixed original compile-only or licensed MCP steps on the existing owner.
  // These source assertions do not execute or admit either consumer lane.
  const native = ci.jobs["electron-native"];
  const nativeStatic = { ...defaults, canonical_profile: "native-release-static" };
  assert.deepEqual(admitted(nativeStatic), ["electron-native"]);
  assert.equal(native["runs-on"], "ubuntu-24.04");
  assert.equal(native["timeout-minutes"], 90);
  assert.deepEqual(native.env, rust.env);
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
  for (const standalone of [nativeStatic, nativeMcp]) {
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
    ]) {
      assert.deepEqual(admitted({ ...standalone, canonical_profile: malformed }), ["canonical"]);
    }
  }
  const nativeCommands = native.steps.filter(({ name }) => [
    "Build and test the development N-API module", "Check both release-only native features",
    "Clippy both release-only native features", "Test both release-only native features",
    "Test licensed MCP sidecar",
  ].includes(name));
  assert.equal(nativeCommands.length, 5);
  assert.deepEqual(nativeCommands.map((step) => step.run.trim()), [
    "pnpm napi:build\npnpm --dir electron/native/grimodex-node test",
    "cargo check --manifest-path electron/native/grimodex-node/Cargo.toml --features licensing,legacy-keyring-migration",
    "cargo clippy --manifest-path electron/native/grimodex-node/Cargo.toml --all-targets --features licensing,legacy-keyring-migration -- -D warnings",
    "cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --features licensing,legacy-keyring-migration",
    "cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-mcp --features licensing",
  ]);
  const staticCommands = nativeCommands.slice(1, 3);
  const mcpCommands = nativeCommands.slice(4);
  for (const step of native.steps.slice(1)) {
    assert.equal(step["continue-on-error"], undefined);
    assert.equal(step.if, staticCommands.includes(step)
      ? "!inputs.canonical_profile || inputs.canonical_profile == 'native-release-static'"
      : mcpCommands.includes(step)
        ? "!inputs.canonical_profile || inputs.canonical_profile == 'native-licensed-mcp'"
        : nativeCommands.includes(step) ? "!inputs.canonical_profile" : undefined);
  }
  const selectedNative = (inputs) => nativeCommands.filter((step) => !step.if || value(step.if, inputs));
  assert.deepEqual(selectedNative(defaults), nativeCommands);
  assert.deepEqual(selectedNative({ product_journey_mode: "all" }), nativeCommands);
  assert.deepEqual(selectedNative(nativeStatic), staticCommands);
  assert.deepEqual(selectedNative(nativeMcp), mcpCommands);

  // Fixed selections of existing steps, not complete Gate A2 passes.
  // Default/reusable callers retain all eight tests and original bootstrap/cache.
  const migration = ci.jobs["migration-recovery-gate"];
  const crash = { ...defaults, canonical_profile: "migration-crash" };
  assert.deepEqual(admitted(crash), ["migration-recovery-gate"]);
  assert.equal(migration["runs-on"], "ubuntu-latest");
  assert.equal(migration["timeout-minutes"], 45);
  assert.deepEqual(migration.env, rust.env);
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
