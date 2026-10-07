import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import yaml from "js-yaml";
import { checkExistingOsSuitability } from "./existing-os-suitability.mjs";

const ci = yaml.load(await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const owner = ci.jobs["existing-os-suitability"];
const evaluate = (expression, inputs) => new Function("inputs", "github", "startsWith", `return (${expression
  .replace(/^\$\{\{\s*|\s*\}\}$/gu, "")
  .replace(/(inputs\.\w+|github\.\w+)\s*([!=]=)\s*('[^']*')/gu, "String($1 ?? '').toLowerCase() $2 $3")});`)(inputs, { event_name: "workflow_dispatch" }, (value, prefix) => String(value ?? "").toLowerCase().startsWith(prefix));
const defaults = Object.fromEntries(Object.entries(ci.on.workflow_dispatch.inputs).map(([key, input]) => [key, input.default ?? ""]));
const admitted = (inputs) => Object.entries(ci.jobs).filter(([, job]) => evaluate(job.if, inputs)).map(([key]) => key);

test("existing OS suitability is the sole fail-closed owner before setup for malformed and mixed inputs", async () => {
  assert.equal(Object.keys(ci.on.workflow_dispatch.inputs).length, 10);
  assert.equal(ci.on.workflow_dispatch.inputs.canonical_profile.type, "string");
  assert.equal(ci.on.workflow_dispatch.inputs.canonical_profile.default, "");
  assert.equal(ci.on.workflow_call.inputs.canonical_profile, undefined);
  assert.equal(owner["runs-on"], "ubuntu-24.04");
  assert.equal(owner["timeout-minutes"], 5);
  const selection = owner.steps[0];
  assert.equal(selection.name, "Validate existing OS suitability selection");
  assert.doesNotMatch(selection.run, /\$\{\{ inputs\./u);
  const validate = async (inputs, event = "workflow_dispatch") => {
    assert.deepEqual(admitted(inputs), ["existing-os-suitability"]);
    const env = Object.fromEntries(Object.entries(selection.env).map(([key, expression]) => [key, String(evaluate(expression, inputs))]));
    return promisify(execFile)("bash", ["-c", selection.run], { timeout: 10000, env: { ...process.env, ...env, GITHUB_EVENT_NAME: event } });
  };
  for (const mode of ["os-contracts", "os-check"]) {
    const inputs = { ...defaults, canonical_profile: mode };
    await validate(inputs);
    await assert.rejects(validate(inputs, "workflow_call"));
    for (const flag of ["independent_gates", "source_focused", "source_resolve_sharp", "source_audit_compat", "source_canonical_contracts"]) {
      await assert.rejects(validate({ ...inputs, [flag]: true }));
    }
    for (const key of ["candidate_base", "candidate_head", "max_parallel_tasks"]) {
      for (const value of ["contracts", " ", "$(exit 0)"]) await assert.rejects(validate({ ...inputs, [key]: value }));
    }
    for (const value of ["shadow", "ALL", " ", "$(exit 0)"]) await assert.rejects(validate({ ...inputs, product_journey_mode: value }));
  }
  for (const value of ["os-none", "OS-check", "os-CHECK", "os- ", "os-0", "os-$(exit 0)"]) {
    await assert.rejects(validate({ ...defaults, canonical_profile: value }));
    await assert.rejects(validate({ ...defaults, canonical_profile: value, candidate_head: "b".repeat(40), independent_gates: true }));
  }
  assert.equal(admitted(defaults).length, 15);
  assert.equal(admitted({ product_journey_mode: "all" }).length, 15);
  assert.deepEqual(admitted({ ...defaults, canonical_profile: "contracts" }), ["canonical"]);
});

test("existing OS suitability check has no installation or ordinary runtime path and publishes only shaped facts", () => {
  const checkout = owner.steps.find(({ uses }) => uses?.startsWith("actions/checkout@"));
  assert.deepEqual(checkout.with, { ref: "${{ github.sha }}", "fetch-depth": 0, "persist-credentials": false });
  const check = owner.steps.find(({ name }) => name === "One existing namespace permission and harmless behavior check");
  assert.equal(check.if, "inputs.canonical_profile == 'os-check'");
  assert.equal(check.run, "node scripts/existing-os-suitability.mjs");
  for (const step of owner.steps) {
    assert.equal(step["continue-on-error"], undefined);
    assert.doesNotMatch(step.run ?? "", /sudo|apt-get|dbus|xvfb|electron:|ci:local:|generate:licenses|\|\|\s*true/u);
    if (step.uses?.startsWith("pnpm/") || step.uses?.startsWith("actions/setup-node@") || step.run?.includes("pnpm install")) {
      assert.equal(step.if, "inputs.canonical_profile == 'os-contracts'");
    }
  }
  const contracts = owner.steps.find(({ name }) => name === "Existing OS suitability source contracts");
  assert.equal(contracts.if, "inputs.canonical_profile == 'os-contracts'");
  assert.match(contracts.run, /--test-name-pattern=/u);
  assert.match(contracts.run, /scripts\/existing-os-suitability\.test\.mjs/u);
  const upload = owner.steps.at(-1);
  assert.equal(upload.if, "always() && steps.os-selection.outcome == 'success'");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.doesNotMatch(upload.with.path, /\.log|stdout|stderr/u);
  assert.ok(upload.with.path.includes("checkout-identity.json"));
  assert.ok(upload.with.path.includes("late-close.json"));
});

const measured = { user: true, mnt: true, net: true, pid: true, pidOne: true, loopbackOnly: true, childReaped: true };
const retired = { exitCode: 0, signal: null, closeObserved: true, cleanup: { complete: true, groupAlive: false }, timedOut: false, interrupted: false, termination: "close-and-group-exit-observed" };
async function fixture(action) {
  const root = await mkdtemp(path.join(tmpdir(), "existing-os-source-contract-"));
  const output = path.join(root, ".artifacts/ci-os-suitability");
  const options = { root, inspect: async () => ({ status: "available" }), readNamespaces: async () => ({ user: "user:[1]", mnt: "mnt:[2]", net: "net:[3]", pid: "pid:[4]" }) };
  try { await action({ root, output, options }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("existing OS suitability measures the fixed clean helper with bounded ownership, not a bus or B admission", async () => {
  await fixture(async ({ output, options }) => {
    let calls = 0;
    const result = await checkExistingOsSuitability({ ...options, runCommand: async (entry, context) => {
      calls++;
      assert.equal(JSON.parse(await readFile(path.join(output, "namespace-check-intent.json"), "utf8")).status, "possible-start");
      assert.equal(entry.command, "/usr/bin/env");
      assert.deepEqual(entry.args.slice(0, -1), ["-i", "PATH=/usr/bin:/bin", "LANG=C", "/usr/bin/unshare", "--user", "--map-root-user", "--mount", "--net", "--pid", "--fork", "--kill-child=SIGKILL", "--mount-proc", "/usr/bin/python3", "-I", "-c"]);
      assert.match(entry.args.at(-1), /os\.fork\(\)[\s\S]*os\.waitpid\(child, 0\)/u);
      assert.match(entry.args.at(-1), /\/proc\/net\/dev/u);
      assert.doesNotMatch(entry.args.at(-1), /socket|subprocess|dbus|environ/u);
      assert.equal(entry.timeoutMs, 10000);
      assert.equal(context.closeGraceMs, 2000);
      assert.equal(context.taskId, "namespace-check");
      assert.equal(context.signal.aborted, false);
      await writeFile(path.join(output, "namespace-check.stdout.log"), JSON.stringify(measured));
      return retired;
    } });
    assert.equal(result, true);
    assert.equal(calls, 1);
    const facts = JSON.parse(await readFile(path.join(output, "result.json"), "utf8"));
    assert.equal(facts.status, "supported");
    assert.deepEqual(facts.namespaces, measured);
    assert.equal((await stat(output)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(output, "result.json"))).mode & 0o777, 0o600);
    await assert.rejects(checkExistingOsSuitability({ ...options, runCommand: () => { throw new Error("replacement forbidden"); } }), { code: "EEXIST" });
    assert.equal(calls, 1);
  });
});

test("existing OS suitability retains denied, missing, malformed, timeout and unverified retirement without retry", async () => {
  for (const result of [
    { ...retired, exitCode: 1 }, { ...retired, timedOut: true }, { ...retired, interrupted: true },
    { ...retired, closeObserved: false }, { ...retired, cleanup: { complete: false, groupAlive: true } },
    { ...retired, cleanup: { ...retired.cleanup, survivorDetected: true } },
    { ...retired, signal: "SIGKILL" }, { ...retired, termination: "unknown" },
    { ...retired, timedOut: undefined }, { ...retired, error: "spawn failed" },
  ]) await fixture(async ({ output, options }) => {
    let calls = 0;
    assert.equal(await checkExistingOsSuitability({ ...options, runCommand: async () => { calls++; return result; } }), false);
    assert.equal(calls, 1);
    const facts = JSON.parse(await readFile(path.join(output, "result.json"), "utf8"));
    assert.equal(facts.status, result.exitCode === 1 ? "denied-or-unsupported" : "unknown");
    assert.deepEqual(facts.helper, JSON.parse(JSON.stringify(result)));
  });
  for (const status of ["missing", "denied", "unknown"]) await fixture(async ({ output, options }) => {
    assert.equal(await checkExistingOsSuitability({ ...options, inspect: async () => ({ status }), runCommand: () => assert.fail("missing helper must not start") }), false);
    assert.equal(JSON.parse(await readFile(path.join(output, "result.json"), "utf8")).status, "unsupported");
  });
  for (const stdout of ["not JSON", JSON.stringify({ ...measured, net: false }), JSON.stringify({ ...measured, extra: true }), "x".repeat(4097)]) await fixture(async ({ output, options }) => {
    assert.equal(await checkExistingOsSuitability({ ...options, runCommand: async () => {
      await writeFile(path.join(output, "namespace-check.stdout.log"), stdout);
      return retired;
    } }), false);
    assert.equal(JSON.parse(await readFile(path.join(output, "result.json"), "utf8")).status, "unknown");
  });
});

test("existing OS suitability cancellation closes admission before a pending inventory can start a helper", async () => {
  await fixture(async ({ output, options }) => {
    let signalled = false;
    assert.equal(await checkExistingOsSuitability({ ...options, inspect: async () => {
      if (!signalled) { signalled = true; process.emit("SIGTERM"); }
      return { status: "available" };
    }, runCommand: () => assert.fail("cancelled inventory must not start") }), false);
    assert.equal(JSON.parse(await readFile(path.join(output, "result.json"), "utf8")).status, "unknown");
  });
});

test("existing OS suitability cancellation during the final result write persists unknown instead of success", async () => {
  await fixture(async ({ output, options }) => {
    let calls = 0;
    let cancelled = false;
    const signals = ["SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal));
    assert.equal(await checkExistingOsSuitability({ ...options, openFile: async (filePath, ...args) => {
      const file = await open(filePath, ...args);
      if (filePath !== path.join(output, "result.json")) return file;
      return {
        writeFile: async (contents) => {
          await file.writeFile(contents);
          if (JSON.parse(contents).status === "supported") {
            cancelled = true;
            process.emit("SIGTERM"); // Still inside the awaited final write.
          }
        },
        sync: () => file.sync(),
        close: () => file.close(),
      };
    }, runCommand: async () => {
      calls++;
      await writeFile(path.join(output, "namespace-check.stdout.log"), JSON.stringify(measured));
      return retired;
    } }), false);
    assert.equal(cancelled, true);
    assert.equal(calls, 1);
    const facts = JSON.parse(await readFile(path.join(output, "result.json"), "utf8"));
    assert.equal(facts.status, "unknown");
    assert.equal(facts.cancelled, true);
    assert.deepEqual(facts.helper, retired);
    assert.deepEqual(facts.namespaces, measured); // Measurement retained, not admission.
    assert.equal((await stat(path.join(output, "result.json"))).mode & 0o777, 0o600);
    assert.deepEqual(["SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal)), signals);
    await assert.rejects(checkExistingOsSuitability({ ...options, runCommand: () => assert.fail("cancelled owner must not restart") }), { code: "EEXIST" });
    assert.equal(calls, 1);
  });
});

test("existing OS suitability joins late-close ownership while retaining the original unknown failure", async () => {
  await fixture(async ({ output, options }) => {
    let release;
    const lateClose = new Promise((resolve) => { release = resolve; });
    const error = Object.assign(new Error("synthetic unknown close"), { result: { termination: "unknown", closeObserved: false }, lateClose });
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const pending = checkExistingOsSuitability({ ...options, runCommand: async () => { entered(); throw error; } });
    await started;
    let settled = false;
    pending.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    await assert.rejects(checkExistingOsSuitability(options), { code: "EEXIST" });
    release({ termination: "late-close-and-group-exit-observed" });
    assert.equal(await pending, false);
    assert.equal(JSON.parse(await readFile(path.join(output, "result.json"), "utf8")).status, "unknown");
    assert.equal(JSON.parse(await readFile(path.join(output, "late-close.json"), "utf8")).termination, "late-close-and-group-exit-observed");
  });
});
