#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, statfs } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { runLocalCiCommand } from "./local-ci-process-supervisor.mjs";

const fail = (operation) => { throw new Error(`[precheck] Full admission requires ${operation}`); };
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const amount = (value) => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) fail("nonnegative decimal allocation observations");
  return BigInt(value);
};
const minimum = (a, b) => a < b ? a : b;

// Derive build-only preparation from the actual Full consumers. No test, bus,
// fixture builder, Editor, performance case or gate is executed by this list.
export function fullPreparation(plan) {
  const materialize = new Set([
    "bootstrap.install", "bootstrap.electron-binary", "bootstrap.workspace-build",
    "bootstrap.chromium", "lfm.setup", "native.build", "journeys.mcp-build", "electron.build",
  ]);
  const result = [];
  const seen = new Set();
  for (const task of plan.tasks) {
    const command = { command: task.command.command, args: [...task.command.args], cwd: task.command.cwd, env: { ...task.command.env } };
    if (command.command === "cargo" && command.args[0] === "test" && !command.args.includes("--doc")) {
      // --no-run retains Cargo's real compilation target/features/profile tuple.
      const separator = command.args.indexOf("--");
      if (separator !== -1) command.args = command.args.slice(0, separator);
      if (!command.args.includes("--no-run")) command.args.push("--no-run");
    } else if (command.command === "cargo" && command.args[0] === "run") {
      // Compile the real fixture-builder tuple, but never execute its builder.
      const separator = command.args.indexOf("--");
      if (separator !== -1) command.args = command.args.slice(0, separator);
      command.args[0] = "build";
    } else if (command.command === "cargo" && command.args[0] === "clippy") {
      // Preserve the compilation tuple, not the lint gate or its rustc flags.
      const separator = command.args.indexOf("--");
      if (separator !== -1) command.args = command.args.slice(0, separator);
      command.args[0] = "check";
    } else if (!materialize.has(task.id) && !(command.command === "cargo" && command.args[0] === "check")) {
      continue;
    }
    const key = digest(command);
    if (!seen.has(key)) {
      result.push({ id: task.id, command });
      seen.add(key);
    }
  }
  // The existing rust.c-query-worker shell also builds these release tuples.
  // Do not execute its fixture construction or ignored/practical worker cases.
  const worker = plan.tasks.find((task) => task.id === "rust.c-query-worker");
  if (!worker) fail("the existing C-query Full compilation consumer");
  for (const [suffix, action, features, target] of [
    ["worker", "build", null, "nir1-c-query-worker"],
    ["worker-seam", "build", "nir1-c-query-test-seam", "nir1-c-query-worker"],
    ["capacity", "build", "nir1-material-diagnostics", "nir1-material-capacity"],
    ["lib", "test", null, null],
    ["worker-tests", "test", null, "nir1-c-query-worker"],
  ]) {
    result.push({ id: `rust.c-query-build-${suffix}`, command: {
      command: "cargo", cwd: ".", env: { ...worker.command.env },
      args: [action, "--locked", "--release", "--manifest-path", "src-tauri/Cargo.toml", "-p", "grimodex-db",
        ...(features ? ["--features", features] : []), ...(target ? ["--bin", target] : ["--lib"]), ...(action === "test" ? ["--no-run"] : [])],
    } });
  }
  return result;
}

const residualKinds = ["retained", "transient", "uncertainty"];
const domains = ["build-link-doctest", "fixtures-db-wal-backup", "failure-tmproot-artifact-copy", "cache-environment", "logs-reports"];

const workloadInputPath = ".artifacts/local-ci/full-workload-input.json";
const workloadEstimatePath = ".artifacts/local-ci/full-workload-estimate.json";
// Reviewable data in the candidate, never an ignored pre-bound run record or an
// external URL/configuration option. Actual numerical acquisition is required.
const workloadAllocationPath = "scripts/local-ci-full-workload-allocation.json";

// First, smaller prerequisite: resolve the existing canonical system install
// against the runner's public cached indexes, WITHOUT installed-state shortcuts,
// downloads, installs or cache writes. Package size metadata is not allocation.
export function canonicalSystemPackages(workflow) {
  const requests = [...workflow.matchAll(/^\s*sudo apt-get install -y --no-install-recommends ([^\n]+)$/gmu)];
  if (requests.length !== 1) fail("one source-bound canonical system installation request");
  const packages = requests[0][1].trim().split(/\s+/u);
  if (!packages.length || new Set(packages).size !== packages.length || packages.some((name) => !/^[a-z0-9][a-z0-9+.-]*$/u.test(name))) fail("literal distinct canonical system packages");
  return packages;
}

// Hosted solver evidence includes a literal empty annotation after the tuple.
// Accept only that suffix; never discard arbitrary trailing text.
const coldSystemTuple = /^Inst ([a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?) \(([a-zA-Z0-9.+:~_-]+) .*\[([a-z0-9]+)\]\)(?: \[\])?$/u;

// Observe the failing grammar without publishing a solver line or relaxing it.
// All syntax labels are fixed; no captured package/version/origin/tail is emitted.
export function coldSystemSolverFormat(solution) {
  let installLines = 0, rejectedLines = 0, firstRejected = null;
  for (const [index, line] of solution.split("\n").entries()) {
    if (!/^Inst\b/u.test(line)) continue;
    installLines++;
    if (coldSystemTuple.test(line)) continue;
    rejectedLines++;
    if (firstRejected) continue;
    const coldPrefix = /^Inst [a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)? \([a-zA-Z0-9.+:~_-]+ /u.test(line);
    const tail = line.match(/ \[[a-z0-9]+\]\)(.*)$/u);
    const ending = !tail ? "unrecognized" : tail[1] === "" ? "architecture-close"
      : tail[1] === " []" ? "architecture-close-empty-brackets" : "unrecognized";
    firstRejected = { lineNumber: index + 1, bytes: Buffer.byteLength(line), sha256: createHash("sha256").update(line).digest("hex"), coldPrefix, ending };
  }
  return { installLines, rejectedLines, firstRejected };
}

export function coldSystemPackages(solution) {
  const packages = [];
  for (const line of solution.split("\n").filter((line) => /^Inst\b/u.test(line))) {
    const match = line.match(coldSystemTuple);
    if (!match) fail("recognized cold APT package/version/architecture tuples");
    packages.push({ package: match[1], version: match[2], architecture: match[3] });
  }
  if (!packages.length || new Set(packages.map((entry) => entry.package)).size !== packages.length) fail("a nonempty distinct cold APT dependency solution");
  return packages;
}

export function systemPackageSizes(packages, metadata) {
  const stanzas = metadata.trim().split(/\n\s*\n/u).map((stanza) => {
    const fields = {};
    for (const line of stanza.split("\n")) {
      const field = line.match(/^(Package|Version|Architecture|Size|Installed-Size): (.+)$/u);
      if (field) {
        if (fields[field[1]] !== undefined) fail("unambiguous APT size metadata fields");
        fields[field[1]] = field[2];
      }
    }
    return fields;
  });
  const selected = packages.map((entry) => {
    const matches = stanzas.filter((fields) => fields.Package === entry.package.split(":")[0] && fields.Version === entry.version && fields.Architecture === entry.architecture);
    if (matches.length !== 1) fail("exact cold-solver versions/architectures in cached APT metadata");
    const fields = matches[0];
    if (!/^[1-9][0-9]*$/u.test(fields.Size ?? "") || !/^(0|[1-9][0-9]*)$/u.test(fields["Installed-Size"] ?? "")) fail("explicit archive length and Debian installed-size metadata (not guessed physical allocation)");
    return { ...entry, archiveBytes: fields.Size, installedKiB: fields["Installed-Size"] };
  });
  if (stanzas.length !== selected.length) fail("no extra or duplicate APT metadata stanzas");
  return selected;
}

export async function stageFullSystemReference(options) {
  const { root, signal } = options;
  const { directory, run, binding } = await openAdmission(options, "setup-reference");
  try {
    const workflow = await readFile(path.join(root, ".github/workflows/canonical-ci.yml"), "utf8");
    const requested = canonicalSystemPackages(workflow);
    const sources = [];
    for (const file of [".github/workflows/canonical-ci.yml", "scripts/local-ci-full-admission.mjs", "scripts/local-ci-process-supervisor.mjs"]) {
      sources.push({ path: file, sha256: createHash("sha256").update(await readFile(path.join(root, file))).digest("hex") });
    }
    // No root cache generation/lock or network activity, even on an empty cache.
    const cacheOptions = ["-o", "Dir::Cache::pkgcache=", "-o", "Dir::Cache::srcpkgcache="];
    const solve = await run("system-cold-solution", { command: "apt-get", args: [...cacheOptions, "-o", "Debug::NoLocking=1", "-o", "Dir::State::status=/dev/null", "--simulate", "--no-install-recommends", "install", ...requested], env: { LC_ALL: "C" } }, 30_000, signal, false);
    const solution = await readFile(path.resolve(root, solve.logs.stdout.path), "utf8");
    signal?.throwIfAborted();
    await durableJson(path.join(directory, "setup-solver-format.json"), {
      binding, sources, requested, format: coldSystemSolverFormat(solution),
      child: { exitCode: solve.exitCode, closeObserved: solve.closeObserved, cleanup: solve.cleanup,
        logJoins: Object.fromEntries(Object.entries(solve.logs).map(([stream, log]) => [stream, { size: log.size, sha256: log.sha256 }])) },
      scope: "Redacted cold solver syntax only, before strict parsing. Not accepted tuples, a size reference or Full/B admission; complete private log bodies are not published.",
    });
    signal?.throwIfAborted();
    const packages = coldSystemPackages(solution);
    const sizes = await run("system-cold-sizes", { command: "apt-cache", args: [...cacheOptions, "--no-all-versions", "show", ...packages.map((entry) => `${entry.package}=${entry.version}`)], env: { LC_ALL: "C" } }, 30_000, signal, false);
    const reference = systemPackageSizes(packages, await readFile(path.resolve(root, sizes.logs.stdout.path), "utf8"));
    signal?.throwIfAborted();
    await durableJson(path.join(directory, "setup-reference.json"), {
      binding, sources, requested, packages: reference,
      children: [solve, sizes].map((result) => ({ exitCode: result.exitCode, closeObserved: result.closeObserved, cleanup: result.cleanup,
        logJoins: Object.fromEntries(Object.entries(result.logs).map(([stream, log]) => [stream, { size: log.size, sha256: log.sha256 }])) })),
      scope: "Cold canonical system dependency solution from current cached public APT indexes. Archive lengths and Debian installed-size estimates only; no installation, physical allocation estimate or Full admission.",
      unobserved: ["refreshed index/version drift", "physical bytes/inodes, extraction and transient coexistence", "installer complete-log growth and additive uncertainty", "other setup, compilation/materialization and synthetic DB/backup/failure consumers", "future runner capacity/quota/exclusion and all Full/B gates"],
    });
    signal?.throwIfAborted();
  } catch (error) {
    if (error.lateClose) await error.lateClose;
    throw error;
  }
}

// Focused grouped acquisition, not the complete Full preparation list. Derive
// the actual official fixture command; never accept an arbitrary consumer/filter.
export function groupedDbPrerequisites(registry, binding, output) {
  const group = registry?.stages?.["c2-zc-restore-fixture-builder"];
  const fixture = Array.isArray(group?.commands) ? group.commands.find(({ id }) => id === "c2zc.fixture-build") : null;
  const expected = ["run", "-p", "grimodex-db", "--manifest-path", "src-tauri/Cargo.toml", "--features", "c2zc-fixture-builder", "--bin", "c2zc-restore-fixture", "--", "build", "--repo-root", ".", "--output-dir", "__C2ZC_RESTORE_FIXTURE_OUTPUT_DIR__", "--candidate", "HEAD", "--expected-head", "__C2ZC_RESTORE_FIXTURE_EXPECTED_HEAD__", "--expected-tree", "__C2ZC_RESTORE_FIXTURE_EXPECTED_TREE__"];
  if (!fixture || !Array.isArray(fixture.args) || !group.env || !fixture.env || fixture.command !== "cargo" || fixture.cwd !== "." || digest(fixture.args) !== digest(expected) ||
      digest(group.env) !== digest({ CARGO_PROFILE_DEV_DEBUG: "0", CARGO_PROFILE_TEST_DEBUG: "0" }) ||
      digest(fixture.env) !== digest({ CARGO_BUILD_JOBS: "2" }) ||
      ![binding?.head, binding?.tree].every((id) => /^[a-f0-9]{40}$/u.test(id)) || typeof output !== "string" || !path.isAbsolute(output)) fail("the unchanged pure-DB official fixture tuple and current candidate");
  // Missing preinstalled toolchains must fail, not invoke rustup installation.
  const env = { ...group.env, ...fixture.env, RUSTUP_AUTO_INSTALL: "0" };
  const tuple = fixture.args.slice(1, fixture.args.indexOf("--"));
  const suite = ["test", "--locked", ...tuple.filter((_, i) => i < tuple.indexOf("--bin")), "--test", "c2zc_restore_fixture"];
  const replacements = { __C2ZC_RESTORE_FIXTURE_OUTPUT_DIR__: output, __C2ZC_RESTORE_FIXTURE_EXPECTED_HEAD__: binding.head, __C2ZC_RESTORE_FIXTURE_EXPECTED_TREE__: binding.tree };
  return [
    { id: "db-cold-compile", command: { command: "cargo", args: [...suite, "--no-run"], cwd: ".", env } },
    { id: "db-official-backup", command: { command: "cargo", args: ["run", "--locked", "--offline", ...fixture.args.slice(1).map((arg) => replacements[arg] ?? arg)], cwd: ".", env } },
    { id: "db-fixture-failures", command: { command: "cargo", args: [...suite, "--offline"], cwd: ".", env } },
  ];
}

// This allowlist is the actual normal Full materialization/compiler subset, not
// an arbitrary task selector. No executable app, native binding or model runs.
export function normalPrerequisites(registry) {
  const selected = [
    ["bootstrap", "bootstrap.install", "pnpm", ["install", "--frozen-lockfile"]],
    ["bootstrap", "bootstrap.electron-binary", "node", ["scripts/ensure-electron-binary.mjs"]],
    ["bootstrap", "bootstrap.workspace-build", "pnpm", ["build:workspace:dependencies"]],
    ["bootstrap", "bootstrap.chromium", "pnpm", ["exec", "playwright", "install", "chromium"]],
    ["electron", "electron.build", "pnpm", ["ci:build:desktop"]],
  ];
  return selected.map(([stage, id, executable, args]) => {
    const group = registry?.stages?.[stage];
    const matches = Array.isArray(group?.commands) ? group.commands.filter((entry) => entry.id === id) : [];
    const entry = matches?.[0];
    if (matches?.length !== 1 || entry.command !== executable || digest(entry.args) !== digest(args) ||
        (entry.cwd ?? ".") !== "." || Object.keys(group.env ?? {}).length || Object.keys(entry.env ?? {}).length) fail(`the unchanged normal Full prerequisite ${id}`);
    return { id, command: { command: entry.command, args: [...entry.args], cwd: ".", env: {} } };
  });
}

const normalSources = [".github/workflows/canonical-ci.yml", "scripts/local-ci-registry.json", "scripts/local-ci-full-admission.mjs", "scripts/local-ci-full-filesystems.py", "scripts/local-ci-setup-allocation.py", "scripts/local-ci-process-supervisor.mjs", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "scripts/ensure-electron-binary.mjs", "electron/scripts/build.mjs", "vite.config.ts"];
const cpuSources = [".github/workflows/canonical-ci.yml", "scripts/local-ci-registry.json", "scripts/local-ci-full-admission.mjs", "scripts/local-ci-full-filesystems.py", "scripts/local-ci-setup-allocation.py", "scripts/local-ci-process-supervisor.mjs", "experiments/lfm25-encoder-phase0/pyproject.toml", "experiments/lfm25-encoder-phase0/uv.lock"];
const nativeSources = [".github/workflows/ci.yml", "scripts/local-ci-registry.json", "scripts/local-ci-full-admission.mjs", "scripts/local-ci-full-filesystems.py", "scripts/local-ci-setup-allocation.py", "scripts/local-ci-process-supervisor.mjs", "package.json", "pnpm-lock.yaml", "electron/native/grimodex-node/package.json", "electron/native/grimodex-node/Cargo.toml", "electron/native/grimodex-node/Cargo.lock", "src-tauri/crates/grimodex-lint/Cargo.toml", "src-tauri/crates/grimodex-semantic/Cargo.toml"];
const referenceLocations = (root, cpu) => [...fullSetupLocations(root), ...(cpu ? [["uv-project", path.join(root, "experiments/lfm25-encoder-phase0")], ["uv-environment", path.join(root, "experiments/lfm25-encoder-phase0/.venv")]] : [])];

// One ordinary CPU dependency materialization, never tests/model/GPU execution.
// UV_PYTHON pins the existing runner interpreter; auto-download is forbidden.
export function cpuPrerequisites(registry) {
  const group = registry?.stages?.["lfm-encoder-phase0"];
  const matches = group?.commands?.filter((entry) => entry.id === "lfm.setup");
  const entry = matches?.[0];
  if (matches?.length !== 1 || entry.command !== "uv" || digest(entry.args) !== digest(["sync", "--frozen", "--extra", "cpu"]) ||
      entry.cwd !== "experiments/lfm25-encoder-phase0" || Object.keys(group.env ?? {}).length || Object.keys(entry.env ?? {}).length) fail("the unchanged locked CPU Full materialization tuple");
  return [{ id: entry.id, command: { command: entry.command, args: [...entry.args], cwd: entry.cwd, env: { UV_PYTHON: "/usr/bin/python3.12", UV_PYTHON_DOWNLOADS: "never" } } }];
}

// The existing Full build consumer, not a test or arbitrary native command.
export function nativePrerequisites(registry) {
  const group = registry?.stages?.["electron-native"];
  const matches = group?.commands?.filter((entry) => entry.id === "native.build");
  const entry = matches?.[0];
  if (matches?.length !== 1 || entry.command !== "pnpm" || digest(entry.args) !== digest(["napi:build"]) ||
      (entry.cwd ?? ".") !== "." || digest(group.env) !== digest({ CARGO_PROFILE_DEV_DEBUG: "0", CARGO_PROFILE_TEST_DEBUG: "0" }) ||
      digest(entry.env) !== digest({ CARGO_BUILD_JOBS: "4" })) fail("the unchanged compile-only native Full tuple");
  return [{ id: entry.id, command: { command: entry.command, args: [...entry.args], cwd: ".", env: { ...group.env, ...entry.env, RUSTUP_AUTO_INSTALL: "0" } } }];
}

// Unknown command text stays in private logs, never uploaded as a version.
// This is a diagnostic grammar bound, not a workload/capacity threshold.
export function cpuVersionFormat(tool, output) {
  const expected = tool === "python" ? "3.12" : "0.11.29";
  if (output === null || Buffer.byteLength(output) > 160) return { expected, observedVersion: null, format: "oversized", accepted: false };
  const text = output.trim();
  const prefix = tool === "python" ? "Python" : "uv";
  const observedVersion = text.match(new RegExp(`^${prefix} ([0-9]{1,5}\\.[0-9]{1,5}\\.[0-9]{1,5})(?= |$)`, "u"))?.[1] ?? null;
  const recognized = tool === "python" ? /^Python [0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$/u.test(text)
    : /^uv [0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(?: \((?:[0-9a-f]{7,40} [0-9]{4}-[0-9]{2}-[0-9]{2}|x86_64-unknown-linux-gnu)\))?$/u.test(text);
  const matchesExpected = observedVersion !== null && (tool === "python" ? /^3\.12\./u.test(observedVersion) : observedVersion === expected);
  return { expected, observedVersion, format: recognized ? "recognized" : "unsupported", accepted: recognized && matchesExpected };
}

export async function stageFullGroupedReference(options) {
  const { root, signal: parentSignal, normal = false, preflight = false, cpu = false, native = false } = options;
  if (native) parentSignal?.throwIfAborted();
  if (native && (normal || cpu || preflight)) fail("one compile-only native acquisition, without mixed purposes");
  if (native && Object.keys(process.env).some((key) => process.env[key] && (/^(ORT_|CARGO_TARGET_|CARGO_BUILD_TARGET|CARGO_ENCODED_RUSTFLAGS|CARGO_NET_|LINDERA_|RUSTFLAGS$|DOCS_RS$|XDG_CACHE_HOME$)/u.test(key)))) fail("unoverridden native dictionary/ORT/target/cache/build placement");
  if (cpu && !normal) fail("the existing focused preflight/continuation owner for CPU materialization");
  if (cpu && ["UV_PROJECT_ENVIRONMENT", "UV_NO_CACHE", "UV_NO_SYNC", "UV_LINK_MODE", "UV_PYTHON", "UV_PYTHON_DOWNLOADS", "UV_INDEX", "UV_DEFAULT_INDEX", "UV_INDEX_URL", "UV_EXTRA_INDEX_URL", "VIRTUAL_ENV"].some((key) => process.env[key])) fail("unoverridden locked CPU environment/cache/index/Python placement before setup");
  const deadlineController = new AbortController();
  const cancel = () => deadlineController.abort(parentSignal.reason);
  parentSignal?.addEventListener("abort", cancel, { once: true });
  if (parentSignal?.aborted) cancel();
  const signal = deadlineController.signal;
  const started = Date.now();
  let deadline = setTimeout(() => deadlineController.abort(new Error("grouped prerequisite deadline")), 1_800_000);
  try {
    // Reuse the existing prerequisite owner/artifact shape, not Full /1 ingestion.
    const admitted = normal && !preflight ? await resumeNormalReference({ ...options, signal }) : await openAdmission({ ...options, signal }, "setup-reference");
    const { directory, registry, run, binding } = admitted;
    if (normal && !preflight) {
      clearTimeout(deadline);
      deadline = setTimeout(() => deadlineController.abort(new Error("normal prerequisite deadline")), Math.max(1, admitted.deadline - Date.now()));
    }
    const sources = [];
    for (const file of native ? nativeSources : normal ? cpu ? cpuSources : normalSources : [".github/workflows/canonical-ci.yml", "scripts/local-ci-registry.json", "scripts/local-ci-full-admission.mjs", "scripts/local-ci-full-filesystems.py", "scripts/local-ci-setup-allocation.py", "scripts/local-ci-process-supervisor.mjs", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/crates/grimodex-db/Cargo.toml", "src-tauri/crates/grimodex-core/Cargo.toml", "src-tauri/crates/grimodex-db/tests/c2zc_restore_fixture.rs", "src-tauri/crates/grimodex-db/src/narrative_extraction/c2zc_restore_fixture.rs"]) {
      sources.push({ path: file, sha256: createHash("sha256").update(await readFile(path.join(root, file))).digest("hex") });
    }
    if (process.env.CARGO_TARGET_DIR || process.env.RUSTUP_TOOLCHAIN) fail("the existing unoverridden pure-DB target/toolchain");
    // Even metadata can write a cold cache. Assess source-selected destinations
    // and applicable quotas before the first Cargo child, then verify its target.
    const target = path.join(root, native ? "electron/native/grimodex-node/target" : "src-tauri/target");
    // Locked ort-sys rc.12 default; UniDic archive/extraction/generation is OUT_DIR.
    const ortCache = path.join(homedir(), ".cache/ort.pyke.io");
    const cargo = process.env.CARGO_HOME || path.join(homedir(), ".cargo");
    const relativeCargo = path.relative(homedir(), cargo);
    if (!path.isAbsolute(cargo) || !relativeCargo || relativeCargo === ".." || relativeCargo.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCargo)) fail("the actual Cargo cache inside the owned home");
    for (const destination of [cargo, target, ...(native ? [ortCache] : [])]) {
      let ancestor = destination;
      for (;;) {
        try { if (await realpath(ancestor) !== ancestor) fail("unredirected focused Cargo destinations"); break; }
        catch (error) { if (error.code !== "ENOENT") throw error; ancestor = path.dirname(ancestor); }
      }
    }
    const locations = normal ? referenceLocations(root, cpu) : [["workspace", root], ["cargo-target", target], ["cargo-home", cargo], ["node-temp", tmpdir()], ["runner-temp", process.env.RUNNER_TEMP], ["root", "/"], ["home", homedir()], ...(native ? [["ort-cache", ortCache], ["unix-temp", process.env.TMPDIR || "/tmp"], ...["TMP", "TEMP"].filter((key) => process.env[key]).map((key) => [`${key.toLowerCase()}-temp`, process.env[key]])] : [])];
    if (locations.some(([, destination]) => typeof destination !== "string" || !path.isAbsolute(destination) || /[\r\n\0]/u.test(destination))) fail("actual source-selected focused destinations");
    if (normal || native) for (const [, requested] of locations) {
      let ancestor = requested;
      for (;;) {
        try { if (await realpath(ancestor) !== ancestor) fail("unredirected normal setup destinations"); break; }
        catch (error) { if (error.code !== "ENOENT") throw error; ancestor = path.dirname(ancestor); }
      }
    }
    await assertWritableLocations(locations);
    let sequence = 0;
    const probe = async () => {
      const filesystems = JSON.parse(await run(`${native ? "native" : normal ? preflight ? "normal-preflight" : "normal" : "db"}-filesystems-${sequence++}`, { command: "sudo", args: ["-n", "python3", "scripts/local-ci-full-filesystems.py", JSON.stringify({ locations, uid: process.getuid(), gids: [...new Set([process.getgid(), ...process.getgroups()])] })] }));
      // Usable observed capacity/quotas only, not a zero-demand Full forecast.
      assessFullDemand(filesystems, []);
      if ((normal || native) && filesystems.some((fs) => !fs.quotas?.some((quota) => quota.type === 2 && quota.state === "kernel-disabled") || fs.quotas.some((quota) => quota.type === 2 && quota.state !== "kernel-disabled"))) fail("known installer project-quota placement before focused setup");
      return filesystems;
    };
    const initial = await probe();
    signal?.throwIfAborted();
    if (normal && preflight) {
      (cpu ? cpuPrerequisites : normalPrerequisites)(registry);
      if (cpu && (await run("cpu-python", { command: "/usr/bin/python3.12", args: ["-I", "-c", "import sys; print('.'.join(map(str, sys.version_info[:2])))"] })).trim() !== "3.12") fail("the runner's existing Python3.12, without installation");
      const baseline = JSON.parse(await run("normal-preflight-allocation", { command: "python3", args: ["scripts/local-ci-setup-allocation.py", JSON.stringify(cpu ? locations.filter(([label]) => ["uv-cache", "uv-project", "uv-environment"].includes(label)) : locations.filter(([label]) => ["pnpm-installer", "pnpm-store-root", "browser-cache", "electron-cache"].includes(label)).concat([["packages-installed", path.join(root, "node_modules")]]))] }, 75_000));
      await durableJson(path.join(directory, "normal-preflight.json"), { binding, sources, purpose: cpu ? "cpu" : "normal", locationsDigest: digest(locations), initial, baseline, deadline: started + 1_800_000,
        scope: cpu ? "Focused pinned uv tool and locked CPU environment/cache materialization only. Existing Python3.12; no Python download, model/GPU/test/dataset/app/bus/Editor or Full admission." : "Focused pinned pnpm/Node setup, frozen ordinary packages, binary materialization and JavaScript compilation only. No Full input/admission, system/uv/audit/native/model installation, app/bus/Editor or numerical upper-bound claim." });
      return;
    }
    if (!normal) {
      const metadata = JSON.parse(await run("db-target", { command: "cargo", args: ["metadata", "--locked", "--no-deps", "--format-version", "1", "--manifest-path", native ? "Cargo.toml" : "src-tauri/Cargo.toml"], cwd: native ? "electron/native/grimodex-node" : ".", env: { RUSTUP_AUTO_INSTALL: "0" } }));
      if (metadata.target_directory !== target) fail(native ? "the source-bound native Cargo target" : "the source-bound pure-DB Cargo target");
    }
    // Same existing fixture-output convention; normal compilation creates none.
    const output = normal || native ? null : await mkdtemp(path.join(tmpdir(), "grimodex-c2zc-restore-fixture-"));
    const preparation = native ? nativePrerequisites(registry) : normal ? (cpu ? cpuPrerequisites : normalPrerequisites)(registry) : groupedDbPrerequisites(registry, binding, output);
    if (native) {
      const workspace = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
      const pkg = JSON.parse(await readFile(path.join(root, "electron/native/grimodex-node/package.json"), "utf8"));
      if (workspace.scripts?.["napi:build"] !== "pnpm --dir electron/native/grimodex-node build" || pkg.scripts?.build !== "napi build --release" || pkg.napi?.name !== "grimodex-node") fail("the unchanged default-feature release N-API package consumer");
    }
    const version = async (id, command) => {
      await probe();
      return (await run(id, { command, args: ["--version"], env: { RUSTUP_AUTO_INSTALL: "0" } })).trim();
    };
    let versions;
    if (cpu) {
      const observed = {};
      for (const [tool, executable] of [["python", "/usr/bin/python3.12"], ["uv", "uv"]]) {
        await probe();
        const result = await run(`cpu-${tool}-version`, { command: executable, args: ["--version"] }, 30_000, signal, false);
        let output = null;
        if (result.logs.stdout.size <= 160) {
          const file = await open(path.resolve(root, result.logs.stdout.path), "r");
          try {
            const buffer = Buffer.alloc(161);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            output = buffer.subarray(0, bytesRead).toString("utf8");
          } finally { await file.close(); }
        }
        observed[tool] = { ...cpuVersionFormat(tool, output), child: { exitCode: result.exitCode, closeObserved: result.closeObserved, cleanup: result.cleanup,
          logJoins: Object.fromEntries(Object.entries(result.logs).map(([stream, log]) => [stream, { size: log.size, sha256: log.sha256 }])) } };
      }
      signal?.throwIfAborted();
      await durableJson(path.join(directory, "cpu-versions.json"), { binding, sources, observed,
        scope: "Bounded source-shaped CPU version diagnostics before refusal; private command text is not published. Not materialization or Full admission." });
      signal?.throwIfAborted();
      if (!observed.python.accepted || !observed.uv.accepted) fail("pinned uv0.11.29 and existing Python3.12 before CPU materialization");
      versions = { python: `Python ${observed.python.observedVersion}`, uv: `uv ${observed.uv.observedVersion}` };
    } else versions = normal ? { node: process.version, pnpm: await version("normal-pnpm-version", "pnpm") } : { cargo: await version("db-cargo-version", "cargo"), rust: await version("db-rust-version", "rustc") };
    if (native) {
      versions.node = process.version;
      versions.pnpm = await version("native-pnpm-version", "pnpm");
      if (!/^v22\./u.test(versions.node) || versions.pnpm !== "10.33.0" || !/^cargo [0-9]+\.[0-9]+\.[0-9]+ \([0-9a-f]+ [0-9-]+\)$/u.test(versions.cargo) || !/^rustc [0-9]+\.[0-9]+\.[0-9]+ \([0-9a-f]+ [0-9-]+\)$/u.test(versions.rust)) fail("pinned Node22/pnpm10.33.0 and source-shaped existing native toolchain versions");
    }
    if (normal && !cpu) {
      if (!/^v22\./u.test(versions.node) || versions.pnpm !== "10.33.0") fail("the pinned normal Node22/pnpm10.33.0 tuple");
      await probe();
      if ((await run("normal-store", { command: "pnpm", args: ["store", "path", "--silent"] })).trim() !== locations.find(([label]) => label === "pnpm-store")[1]) fail("normal pnpm store matching the assessed destination");
    }
    await durableJson(path.join(directory, "preparation-plan.json"), { binding, sources, versions, initial,
      preparation: preparation.map(({ id, command }) => ({ id, commandDigest: digest(command), timeoutMs: 900_000 })),
      scope: native ? "ONE existing default-feature release N-API compiler with the exact Full registry environment. No module/test/model/bus/Editor/Full admission or numerical upper bound." : cpu ? "ONE existing locked CPU environment/cache consumer with existing Python3.12 and no Python download. No tests/model/GPU/B/Full admission or numerical upper-bound claim." : normal ? "Focused normal dependency/materialization/JavaScript compiler observations, not Full/B admission or a numerical upper bound." : "Bounded ordinary locked pure Rust/SQLite prerequisites on the actual single-job hosted VM. No Full input, numerical compiler upper-bound, capacity-as-demand or Full/B admission. No model, app, bus or tool installation.",
    });
    const nodeRoot = normal ? path.dirname(path.dirname(await realpath(process.execPath))) : null;
    if (normal && !cpu) {
      const relative = path.relative(locations.find(([label]) => label === "tool-cache")[1], nodeRoot);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("the pinned selected Node payload inside the assessed tool cache");
    }
    let uvRoot = null;
    if (cpu) {
      const executable = (await run("cpu-uv-location", { command: "/usr/bin/python3.12", args: ["-I", "-c", "import os, shutil; print(os.path.realpath(shutil.which('uv') or ''))"] })).trim();
      const toolCache = locations.find(([label]) => label === "tool-cache")[1];
      const relative = path.relative(toolCache, executable);
      if (!path.isAbsolute(executable) || !relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || path.basename(executable) !== "uv") fail("the pinned selected uv executable inside its assessed tool cache");
      uvRoot = path.dirname(executable);
      if (uvRoot === toolCache) fail("the selected uv payload, not the entire tool cache");
    }
    const roots = native ? [["cargo-registry", path.join(cargo, "registry")], ["cargo-git", path.join(cargo, "git")], ["cargo-target", target], ["ort-cache", ortCache], ["native-output", path.join(root, "electron/native/grimodex-node/grimodex-node.node")]] : cpu ? [...locations.filter(([label]) => ["uv-cache", "uv-project", "uv-environment"].includes(label)), ["uv-selected", uvRoot]] : normal ? [
      ...locations.filter(([label]) => ["pnpm-installer", "pnpm-store-root", "browser-cache", "electron-cache"].includes(label)),
      ["packages-installed", path.join(root, "node_modules")], ["workspace-packages", path.join(root, "packages")],
      ["desktop-build", path.join(root, "dist-electron")], ["renderer-build", path.join(root, "dist")],
      ["node-selected", nodeRoot],
    ] : [["cargo-registry", path.join(cargo, "registry")], ["cargo-target", target], ["official-fixture", output], ["fixture-db", path.join(output, "c2zc-restore-fixture.db")], ["fixture-backup", path.join(output, "c2zc-restore-fixture.backup.db")], ["fixture-manifest", path.join(output, "c2zc-restore-fixture.manifest.json")]];
    const snapshot = async (id) => JSON.parse(await run(id, { command: "python3", args: ["scripts/local-ci-setup-allocation.py", JSON.stringify(roots)] }, 75_000));
    const baseline = await snapshot("db-allocation-before");
    const samples = [];
    for (const step of preparation) {
      signal?.throwIfAborted();
      const remaining = (normal ? admitted.deadline : started + 1_800_000) - Date.now();
      if (remaining <= 0) fail("the finite grouped prerequisite deadline, without replacement");
      const before = await probe();
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      let stopped = false, samplingError = null;
      const lowWater = new Map(before.map((fs) => [fs.label, { bytes: amount(fs.bytes), inodes: amount(fs.inodes) }]));
      const sample = async () => {
        for (const [label, destination] of locations) {
          let ancestor = destination;
          for (;;) {
            try {
              const fs = await statfs(ancestor, { bigint: true });
              const values = lowWater.get(label);
              values.bytes = minimum(values.bytes, fs.bavail * fs.bsize);
              values.inodes = minimum(values.inodes, fs.ffree);
              break;
            } catch (error) {
              const parent = path.dirname(ancestor);
              if (error.code !== "ENOENT" || parent === ancestor) throw error;
              ancestor = parent;
            }
          }
        }
      };
      const sampler = (async () => {
        try { while (!stopped) { await sample(); await new Promise((resolve) => setTimeout(resolve, 200)); } }
        catch (error) { samplingError = error; controller.abort(error); }
      })();
      let result, commandError;
      try {
        await durableJson(path.join(directory, `${step.id}-pending.json`), { binding, commandDigest: digest(step.command), state: "possible-start", timeoutMs: Math.min(900_000, remaining) });
        controller.signal.throwIfAborted();
        result = await runLocalCiCommand(step.command, { root, taskId: step.id, logDirectory: path.relative(root, directory), signal: controller.signal, timeoutMs: Math.min(900_000, remaining), closeGraceMs: 2_000 });
      } catch (error) { commandError = error; }
      finally { stopped = true; await sampler; signal?.removeEventListener("abort", abort); }
      if (commandError) {
        if (native) {
          const partial = commandError.result;
          await durableJson(path.join(directory, `${step.id}-close.json`), { binding, termination: partial?.termination ?? "unknown", closeObserved: partial?.closeObserved ?? false, cleanup: partial?.cleanup ?? null,
            logJoins: Object.fromEntries(Object.entries(partial?.logs ?? {}).map(([stream, log]) => [stream, { size: log.size, sha256: log.sha256 }])) });
        }
        throw commandError;
      }
      await durableJson(path.join(directory, `${step.id}-close.json`), { binding, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, interrupted: result.interrupted, closeObserved: result.closeObserved, cleanup: result.cleanup,
        logJoins: Object.fromEntries(Object.entries(result.logs).map(([stream, log]) => [stream, { size: log.size, sha256: log.sha256 }])) });
      if (samplingError || result.exitCode !== 0 || result.signal || result.timedOut || result.interrupted || result.error || !result.closeObserved || !result.cleanup?.complete || result.cleanup.groupAlive) fail(`joined successful focused prerequisite ${step.id}, with no retry`);
      await sample();
      const after = await probe();
      const allocation = await snapshot(`db-allocation-${step.id}`);
      samples.push({ id: step.id, before, after, lowWater: [...lowWater].map(([label, values]) => ({ label, bytes: String(values.bytes), inodes: String(values.inodes) })), allocation });
      await durableJson(path.join(directory, `preparation-${samples.length - 1}.json`), { binding, ...samples.at(-1) });
    }
    if ((await run("db-final-head", { command: "git", args: ["rev-parse", "HEAD"] })).trim() !== binding.head || (await run("db-final-clean", { command: "git", args: ["status", "--porcelain", "--untracked-files=all"] })).trim()) fail("an unchanged clean grouped prerequisite candidate");
    const logs = [];
    for (const file of (await readdir(directory)).filter((name) => /\.(stdout|stderr)\.log$/u.test(name)).sort()) {
      const info = await lstat(path.join(directory, file));
      if (!info.isFile()) fail("regular owned complete prerequisite logs");
      const hash = createHash("sha256");
      let size = 0;
      const reader = createReadStream(path.join(directory, file), { signal });
      try { for await (const bytes of reader) { size += bytes.length; hash.update(bytes); } }
      finally { reader.destroy(); await finished(reader, { cleanup: true }); }
      if (size !== info.size) fail("unchanged closed complete prerequisite logs");
      logs.push({ id: file, size, sha256: hash.digest("hex"), allocatedBytes: String(info.blocks * 512), inodes: "1" });
    }
    signal?.throwIfAborted();
    if (cpu || native) {
      const allocation = samples.at(-1)?.allocation;
      const components = allocation?.components, coexistence = allocation?.coexistence;
      // Positive component rows do not establish a complete shared-inode union.
      if (allocation?.status !== "observed-roots-only" || !Array.isArray(components) || components.length !== roots.length ||
          roots.some(([id]) => components.filter((entry) => entry.id === id).length !== 1) ||
          components.some((entry) => !(native && entry.id === "cargo-git" && entry.status === "missing-or-disappeared" && entry.allocatedBytes === null && entry.uniqueInodes === null && entry.device === null) &&
            (entry.status !== "observed" || typeof entry.device !== "string" || !/^(0|[1-9][0-9]*)$/u.test(entry.device) || !amount(entry.allocatedBytes) || !amount(entry.uniqueInodes)))) {
        fail(`complete positive ${native ? "native registry/target/ORT/output" : "CPU cache/environment/tool"} allocation observations; retain unknowns without retry`);
      }
      const devices = new Set(components.filter((entry) => entry.status === "observed").map((entry) => entry.device));
      if (!Array.isArray(coexistence) || coexistence.length !== devices.size ||
          new Set(coexistence.map((entry) => entry.device)).size !== devices.size ||
          coexistence.some((entry) => !devices.has(entry.device) || !amount(entry.allocatedBytes) || !amount(entry.uniqueInodes))) {
        fail(`complete observed ${native ? "native" : "CPU"} deduplicated coexistence for every selected device; retain unknowns without retry`);
      }
    }
    await durableJson(path.join(directory, "setup-reference.json"), { binding, sources, versions, baseline, samples, logs,
      scope: native ? "Actual default-feature release native target (including UniDic generated/extracted inputs), ORT cache, registry/git caches, published .node and complete private-child-log metadata. Not a peak, complete Full forecast/admission or all-future bound." : cpu ? "Actual locked CPU environment/cache and complete private-child-log observations only. Pinned tool's historical action extraction/logs, other workloads and future capacity are unobserved; not Full admission or an all-future bound." : normal ? "Actual normal setup/materialization/JavaScript compiler and complete private-child-log observations only. Not a complete Full forecast/admission or all-future physical certificate." : "Actual grouped pure-DB cold dependency/compiler/official-backup/failure and complete private-log observations only. Not a complete Full forecast, admission, gate receipt or all-future physical certificate.",
      unobserved: native ? ["ordinary setup/cache action historical extraction and complete action/job logs", "sub-200ms dictionary/ORT/compiler/linker transients and attribution", "additional native/shared check/test/doctest targets, failure copies, logs and additive uncertainty", "future-runner capacity/quota/exclusion and all Full/B gates"] : cpu ? ["uv action historical extraction and complete action/job logs", "sub-200ms transients and allocation attribution", "future Python bytecode/test writes, system/audit/native compilation/doctest and fixture/journey/failure/log uncertainty", "future-runner capacity/quota/exclusion and all Full/B gates"] : normal ? ["pnpm/Node action historical download/extraction peaks and complete action logs", "system/uv/audit/native-Rust/doctest and app/bus/Editor workloads", "sub-200ms transients, failure copies and filesystem activity attribution", "additive version/materialization/failure uncertainty and future-runner capacity/quota/exclusion"] : ["warm preinstalled toolchains and Cargo cache cannot attest historical cold peaks", "other normal Full installers/materialization/compilation/doctests and app/bus/Editor journeys", "sub-200ms transients, fixture-suite temporary trees and filesystem/quota activity attribution", "complete hosted action/job logs outside these owned children", "additive version/materialization/failure uncertainty and future-runner capacity/quota/exclusion"],
    });
  } catch (error) {
    if (error.lateClose) await error.lateClose;
    throw error;
  } finally {
    clearTimeout(deadline);
    parentSignal?.removeEventListener("abort", cancel);
  }
}

// Installed components have finite destinations fixed by canonical action inputs
// and consumer settings. Download/extraction may additionally use observed temp
// roots; complete local logs belong to the workspace evidence tree.
const installerDestinations = {
  "install.pnpm": ["pnpm-installer"],
  "install.node": ["tool-cache"],
  "install.rust": ["cargo-home", "rustup-home"],
  "install.system": ["root"],
  "install.uv": ["tool-cache"],
  "install.packages": ["workspace", "pnpm-store-root", "pnpm-store"],
  "install.browser": ["root"], // install-deps; Chromium materialization is preparation.
  "install.audit": ["cargo-home"],
};
const fixtureSources = [
  "scripts/nir1-c-query-worker-ci.sh",
  "src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_capacity_fixtures.rs",
  "src-tauri/crates/grimodex-db/src/narrative_extraction/c2zc_restore_fixture.rs",
  "electron/scripts/product-journey-harness.mjs",
  "electron/scripts/product-journey-catalog.mjs",
  "src/features/chat/chatScopeRegistry.json",
  "scripts/local-ci.mjs",
];

// Constructive arithmetic over reviewed public/synthetic allocation inventories.
// Inventories are forecasts/observations, NOT capacity attestations. They include
// physical allocation/inodes (not just logical DB or compressed archive length).
// Missing facts name their acquisition operation; no source-size coefficient,
// default uncertainty percentage, zero residual or fixture rehearsal is used.
export async function produceWorkloadEstimate(input, binding, root, setupLocations = fullSetupLocations(root)) {
  await validateEstimateIdentity(input, binding, root);
  if (input.version !== "full-workload-input/1") fail(`a reviewed allocation inventory at ${workloadInputPath}`);
  for (const source of [".github/workflows/canonical-ci.yml", "scripts/local-ci-registry.json", ...fixtureSources]) {
    if (!input.sources.some((entry) => entry.path === source)) fail(`current constructive sizing source ${source}`);
  }
  const inventories = new Map();
  if (!Array.isArray(input.inventories)) fail("materialization, compilation, synthetic fixture and complete-log allocation inventories");
  for (const inventory of input.inventories) {
    if (!inventory || !/^[a-z0-9][a-z0-9.-]*$/u.test(inventory.id ?? "") || inventories.has(inventory.id)) fail("unique allocation inventory identities");
    if (!Array.isArray(inventory.items) || !inventory.items.length || typeof inventory.basis !== "string" || !inventory.basis.trim() || typeof inventory.operation !== "string" || !inventory.operation.trim()) fail(`physical allocation inventory and acquisition basis for ${inventory.id}`);
    if (!Array.isArray(inventory.sources) || !inventory.sources.length || inventory.sources.some((index) => !Number.isSafeInteger(index) || !input.sources[index])) fail(`source grounding for inventory ${inventory.id}`);
    let bytes = 0n, inodes = 0n;
    const roles = new Set();
    for (const item of inventory.items) {
      const key = installerDestinations[inventory.id] ? `${item?.role}@${item?.location ?? ""}` : item?.role;
      if (!item || typeof item.role !== "string" || !item.role.trim() || roles.has(key)) fail(`distinct measured/forecast allocation roles and destinations for ${inventory.id}`);
      roles.add(key);
      bytes += amount(item.bytes);
      inodes += amount(item.inodes);
    }
    if (!bytes || !inodes) fail(`positive physical byte/inode observations for ${inventory.id}: ${inventory.operation}`);
    inventories.set(inventory.id, { ...inventory, bytes, inodes, roles: new Set(inventory.items.map((item) => item.role)) });
  }
  const get = (id, roles = []) => {
    const value = inventories.get(id);
    if (!value) fail(`acquire reviewed physical allocation/inode inventory ${id} (installation payload/extraction, build/link, synthetic DB/WAL/backup, failure retention or complete logs as applicable)`);
    if (roles.some((role) => !value.roles.has(role))) fail(`complete ${id} allocation roles: ${roles.join(", ")}; ${value.operation}`);
    // Mandatory backup coexistence cannot borrow positivity from other roles.
    if (roles.includes("backup") && value.items.some((item) => item.role === "backup" && (!amount(item.bytes) || !amount(item.inodes)))) fail(`positive physical byte/inode allocation for ${id}/backup; ${value.operation}`);
    return value;
  };
  const term = (id, kind, domain, location, ids, copies = 1n, reason = "sum every coexisting inventory member") => {
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) fail(`explicit distinct allocation inventories for ${id}`);
    const values = ids.map((name) => {
      const value = get(name);
      if (!installerDestinations[name]) return value;
      if (!id.startsWith("setup.")) fail(`installer inventory ${name} consumed during initial setup only`);
      const items = value.items.filter((item) => item.location === location);
      if (!items.length) fail(`setup recipe charging ${name} to its actual component destination, not ${location}`);
      return { ...value, bytes: items.reduce((sum, item) => sum + amount(item.bytes), 0n), inodes: items.reduce((sum, item) => sum + amount(item.inodes), 0n) };
    });
    return {
      id, kind, domain, location,
      bytes: String(values.reduce((sum, value) => sum + value.bytes, 0n) * copies),
      inodes: String(values.reduce((sum, value) => sum + value.inodes, 0n) * copies),
      sources: [...new Set(values.flatMap((value) => value.sources))],
      basis: `${reason}; ${values.map((value) => value.basis).join("; ")}`,
      operation: values.map((value) => value.operation).join("; "),
    };
  };
  const recipes = (prefix, entries) => {
    if (!Array.isArray(entries) || !entries.length) fail(`retained/transient/justified additive uncertainty inventories for ${prefix}`);
    return entries.map((entry, index) => {
      // No user-supplied copy multiplier. Only the audited fixture topology below
      // multiplies demand, using actual source consumers rather than a factor.
      if (!entry || Object.keys(entry).some((key) => !["kind", "domain", "location", "inventories", "measurement"].includes(key))) fail(`the finite allocation recipe for ${prefix}`);
      const value = term(`${prefix}.${index}`, entry.kind, entry.domain, entry.location, entry.inventories);
      if (entry.measurement) value.measurement = entry.measurement;
      return value;
    });
  };
  const labels = new Set(setupLocations.map(([label]) => label));
  for (const [id, installed] of Object.entries(installerDestinations)) {
    const inventory = get(id, ["installed", "download-cache", "extraction", "logs"]);
    const temps = ["node-temp", "runner-temp", "unix-temp", "tmp-temp", "temp-temp"].filter((label) => labels.has(label));
    for (const item of inventory.items) {
      const allowed = item.role === "installed" ? installed : item.role === "logs" ? ["workspace"] : ["download-cache", "extraction"].includes(item.role) ? [...installed, ...temps] : [];
      if (!labels.has(item.location) || !allowed.includes(item.location) || !amount(item.bytes) || !amount(item.inodes)) fail(`resolve ${id}/${item.role} component placement and positive allocation at its actual installer destination before setup; ${inventory.operation}`);
      if (!Array.isArray(input.setup) || !input.setup.some((recipe) => recipe.location === item.location && recipe.inventories?.includes(id))) fail(`initial setup recipe consuming ${id}/${item.role} at ${item.location}, before its canonical installation`);
    }
    for (const location of installed) {
      if (!inventory.items.some((item) => item.role === "installed" && item.location === location)) fail(`acquire ${id} installed allocation at actual ${location}; ${inventory.operation}`);
    }
  }
  const setupTerms = recipes("setup", input.setup);
  validateTerms(setupTerms, input.sources, residualKinds);
  // Probe labels include observation-only root/home and aliases. Charge actual
  // workload destinations, not invented allocations for every observed label.
  if (!Array.isArray(input.preparation) || !input.preparation.length || !Array.isArray(input.tasks) || !input.tasks.length) fail("every actual Full preparation tuple and residual task inventory");
  const preparationIds = new Set();
  const preparation = input.preparation.map((step, index) => {
    if (!step || typeof step.id !== "string" || preparationIds.has(step.id) || !/^[0-9a-f]{64}$/u.test(step.commandDigest ?? "") || !Number.isSafeInteger(step.timeoutMs) || step.timeoutMs <= 0) fail("unique actual preparation tuple/digest and finite deadline");
    preparationIds.add(step.id);
    const terms = recipes(`prepare.${index}`, step.terms);
    validateTerms(terms, input.sources, residualKinds);
    if (terms.some((entry) => entry.measurement)) fail("pre-start preparation inventories, without future observation substitution");
    return { id: step.id, commandDigest: step.commandDigest, timeoutMs: step.timeoutMs, terms };
  });
  const taskIds = new Set();
  const residual = input.tasks.flatMap((task, index) => {
    if (!task || typeof task.id !== "string" || !task.id || taskIds.has(task.id)) fail("unique Full consumer inventory identities");
    taskIds.add(task.id);
    const terms = recipes(`task.${index}`, task.terms);
    validateTerms(terms, input.sources, residualKinds);
    if (!terms.some((entry) => entry.domain === "logs-reports")) fail(`complete stdout/stderr/report allocation risk for ${task.id}`);
    return terms;
  });

  // Default Full script retains pristine Q2/Q512 and ALL named input copies
  // until its EXIT trap. Derive copy counts from that default branch; do not
  // count opt-in lanes or assume sequential queries release their files.
  const worker = await readFile(path.join(root, fixtureSources[0]), "utf8");
  const defaultStart = worker.lastIndexOf('\nq2_fixture_checksum="$(cksum < "$q2_fixture_file")"');
  if (defaultStart < 0) fail("the current default C-query fixture-copy topology");
  const defaultWorker = worker.slice(defaultStart);
  const workerTemp = process.env.RUNNER_TEMP ? "runner-temp" : process.env.TMPDIR ? "unix-temp" : process.env.TMP ? "tmp-temp" : process.env.TEMP ? "temp-temp" : "unix-temp";
  for (const [name, variable] of [["q2", "q2_fixture_file"], ["q512", "q512_fixture_file"]]) {
    const copies = [...defaultWorker.matchAll(new RegExp(`^cp -- "\\$${variable}" "\\$[a-z0-9_]+"$`, "gmu"))].length;
    if (!copies) fail(`the current ${name} pristine/input copy consumers`);
    get(`worker.${name}`, ["db", "wal", "shm", "journal", "construction"]);
    residual.push(term(`worker.${name}`, "retained", "fixtures-db-wal-backup", workerTemp, [`worker.${name}`], BigInt(1 + copies), `${1 + copies} source-derived pristine/input copies, each including open SQLite sidecars and construction risk`));
  }
  // createC2ZcRestoreFixtureContext retains the original under os.tmpdir().
  // captureC2ZcRestoreFixtureEvidence copies only DB/backup/manifest into the
  // workspace; publishing renames that staged tree, not another allocation.
  const fixture = get("c2zc.fixture", ["db", "wal", "shm", "backup", "standalone", "manifest"]);
  residual.push(term("c2zc.fixture", "retained", "fixtures-db-wal-backup", "node-temp", ["c2zc.fixture"]));
  const fixtureCopy = fixture.items.filter(({ role }) => ["db", "backup", "manifest"].includes(role));
  residual.push({
    ...term("c2zc.fixture.copy", "retained", "fixtures-db-wal-backup", "workspace", ["c2zc.fixture"]),
    bytes: String(fixtureCopy.reduce((sum, item) => sum + amount(item.bytes), 0n)),
    inodes: String(fixtureCopy.reduce((sum, item) => sum + amount(item.inodes), 0n)),
    basis: `DB/backup/manifest evidence copy coexists with retained Node-temp original; ${fixture.basis}`,
  });

  // This existing catalog is explicitly dependency-free/preinstall-safe. No
  // harness, test, bus or fixture builder is imported or executed here.
  const { PRODUCT_JOURNEY_CATALOG } = await import(pathToFileURL(path.join(root, fixtureSources[4])).href);
  if (!Array.isArray(PRODUCT_JOURNEY_CATALOG) || !PRODUCT_JOURNEY_CATALOG.length || new Set(PRODUCT_JOURNEY_CATALOG.map(({ id }) => id)).size !== PRODUCT_JOURNEY_CATALOG.length) fail("the actual complete product-journey catalog");
  for (const [index, journey] of PRODUCT_JOURNEY_CATALOG.entries()) {
    const id = `journey.${journey.id}`;
    // Inventory must cover the whole case, including all owned workspaces and
    // restart/userData/cache writes. Failure adds official snapshots, receipt
    // snapshots and diagnostics, then copies that WHOLE tree to artifacts while
    // retaining tmpRoot. Account all cases: no serial/fail-fast savings assumed.
    get(`${id}.runtime`, ["db", "wal", "shm", "user-data", "cache", "logs", "receipts", "other"]);
    get(`${id}.failure`, ["backup", "receipt-snapshot", "diagnostics", "screenshot"]);
    const ids = [`${id}.runtime`, `${id}.failure`];
    residual.push(term(`journey.${index}.tmp`, "retained", "failure-tmproot-artifact-copy", "node-temp", ids, 1n, "all owned case runtime + failure snapshots/diagnostics retained in tmpRoot"));
    residual.push(term(`journey.${index}.copy`, "retained", "failure-tmproot-artifact-copy", "workspace", ids, 1n, "whole tmpRoot artifact copy coexists with retained original"));
    const screenshot = get(`${id}.failure`).items.find((item) => item.role === "screenshot");
    residual.push({
      ...term(`journey.${index}.screenshot`, "retained", "failure-tmproot-artifact-copy", "workspace", [`${id}.failure`]),
      bytes: screenshot.bytes, inodes: screenshot.inodes,
      basis: `additional renderer.png copy outside the copied runtime tree; ${get(`${id}.failure`).basis}`,
    });
  }
  const fixtureInventoryIds = ["worker.q2", "worker.q512", "c2zc.fixture", ...PRODUCT_JOURNEY_CATALOG.flatMap(({ id }) => [`journey.${id}.runtime`, `journey.${id}.failure`])];
  // Justified additive uncertainty is an independent reviewed inventory, not a
  // default factor or spread guessed from a single low-frequency sample.
  get("fixtures.uncertainty", ["sqlite-allocation", "failure-copy", "unsampled-transient"]);
  residual.push(term("fixtures.uncertainty", "uncertainty", "fixtures-db-wal-backup", workerTemp, ["fixtures.uncertainty"]));
  residual.push(term("journey.uncertainty", "uncertainty", "failure-tmproot-artifact-copy", "node-temp", ["fixtures.uncertainty"]));
  residual.push(term("failure.uncertainty", "uncertainty", "failure-tmproot-artifact-copy", "workspace", ["fixtures.uncertainty"]));
  // The constructive terms themselves cite the audited topology, not merely
  // the measured payload's schema. Keep all refs bound to the current checkout.
  const topology = fixtureSources.map((name) => input.sources.findIndex((entry) => entry.path === name));
  for (const value of residual.filter((entry) => /^(worker|c2zc|journey|fixtures|failure)\./u.test(entry.id))) value.sources = [...new Set([...value.sources, ...topology])];
  const used = new Set([...input.setup, ...input.preparation.flatMap((step) => step.terms), ...input.tasks.flatMap((task) => task.terms)].flatMap((entry) => entry.inventories));
  for (const id of [...fixtureInventoryIds, "fixtures.uncertainty"]) used.add(id);
  if ([...inventories.keys()].some((id) => !used.has(id))) fail("a reviewed finite inventory without silently unused demand");
  validateTerms(residual, input.sources, residualKinds);
  for (const domain of domains) if (!residual.some((entry) => entry.domain === domain)) fail(`residual inventory for ${domain}`);
  if (!residual.some((entry) => entry.domain === "build-link-doctest" && entry.measurement)) fail("same-job compile observations connected to a positive reviewed residual");
  for (const entry of residual.filter((value) => value.measurement)) {
    const observed = entry.measurement;
    if (!["retained", "peak"].includes(observed.mode) || !preparationIds.has(observed.preparationId) || observed.location !== entry.location) fail(`current preparation observation at the effective residual destination for ${entry.id}`);
  }
  const workflow = await readFile(path.join(root, ".github/workflows/canonical-ci.yml"));
  return {
    binding, sources: input.sources, inputDigest: digest(input), tasks: input.tasks.map(({ id }) => id),
    setup: { workflowSha256: createHash("sha256").update(workflow).digest("hex"), destinations: setupLocations, terms: setupTerms },
    preparation, residual,
  };
}

// The risk ledger is data, not executable commands or an admission Boolean.
// It must describe the complete workload, preparation risk AND residual demand.
// Exact all-future allocation proofs are deliberately not required. Source refs,
// uncertainty, and the concrete operation that supplies an estimate are required.
async function validateEstimateIdentity(estimate, binding, root) {
  if (!estimate?.binding || JSON.stringify(Object.keys(estimate.binding).sort()) !== JSON.stringify(Object.keys(binding).sort()) || Object.keys(binding).some((key) => estimate.binding[key] !== binding[key])) fail("a workload-risk estimate bound to this candidate, registry, options and owned run");
  if (!Array.isArray(estimate.sources) || estimate.sources.length === 0) fail("source-grounded constructive fixture/failure-copy/build/log sizing");
  for (const source of estimate.sources) {
    if (!source || typeof source.path !== "string" || path.isAbsolute(source.path) || source.path.split(/[\\/]/u).includes("..")) fail("repository-relative sizing sources");
    const resolved = await realpath(path.resolve(root, source.path));
    if (!resolved.startsWith(`${await realpath(root)}${path.sep}`)) fail("sizing sources inside this checkout");
    const actual = createHash("sha256").update(await readFile(resolved)).digest("hex");
    if (source.sha256 !== actual) fail(`current sizing source digest for ${source.path}`);
  }
}

export async function validateWorkloadEstimate(estimate, binding, plan, preparation, root) {
  await validateEstimateIdentity(estimate, binding, root);
  if (!Array.isArray(estimate.preparation) || estimate.preparation.length !== preparation.length) fail("risk estimates for every required materialization/compilation tuple before preparation");
  for (const [index, step] of preparation.entries()) {
    const risk = estimate.preparation[index];
    if (!risk || risk.id !== step.id || risk.commandDigest !== digest(step.command)) fail(`the current build-only preparation tuple ${step.id}`);
    validateTerms(risk.terms, estimate.sources, ["retained", "transient", "uncertainty"]);
    if (!Number.isSafeInteger(risk.timeoutMs) || risk.timeoutMs <= 0) fail(`a finite preparation deadline for ${step.id}`);
  }
  const tasks = plan.tasks.map((task) => task.id).sort();
  if (!Array.isArray(estimate.tasks) || JSON.stringify([...estimate.tasks].sort()) !== JSON.stringify(tasks)) fail("complete Full consumer coverage, including every concurrent task");
  validateTerms(estimate.residual, estimate.sources, residualKinds);
  for (const domain of domains) {
    if (!estimate.residual.some((term) => term.domain === domain)) fail(`the concrete residual sizing operation for ${domain}`);
  }
  if (!estimate.residual.some((term) => term.domain === "build-link-doctest" && term.measurement)) fail("measured same-job build/link preparation connected to residual demand");
  for (const term of estimate.residual.filter((entry) => entry.measurement)) {
    const observation = term.measurement;
    if (!["retained", "peak"].includes(observation.mode) || !preparation.some((step) => step.id === observation.preparationId) || typeof observation.location !== "string") fail(`the actual preparation observation operation for ${term.id}`);
  }
  return estimate;
}

function validateTerms(terms, sources, kinds) {
  if (!Array.isArray(terms) || terms.length === 0) fail("explicit retained, transient and uncertainty allocation terms");
  const names = new Set();
  for (const term of terms) {
    if (!term || typeof term.id !== "string" || !/^[a-z0-9][a-z0-9.-]*$/u.test(term.id) || names.has(term.id)) fail("unique named allocation terms");
    names.add(term.id);
    if (!kinds.includes(term.kind) || !domains.includes(term.domain)) fail("classified workload-risk terms");
    if (typeof term.location !== "string" || !term.location) fail("an effective storage destination for each allocation term");
    if (typeof term.basis !== "string" || !term.basis.trim() || typeof term.operation !== "string" || !term.operation.trim()) fail(`a sizing basis and concrete observation operation for ${term.id}`);
    if (!Array.isArray(term.sources) || !term.sources.length || term.sources.some((i) => !Number.isSafeInteger(i) || !sources[i])) fail(`current source grounding for ${term.id}`);
    // No zero/default residuals: omitted necessary observations must reject.
    if (amount(term.bytes) === 0n || amount(term.inodes) === 0n) fail(`positive byte/inode risk estimates for ${term.id}`);
  }
  for (const kind of kinds) if (!terms.some((term) => term.kind === kind)) fail(`explicit ${kind} demand rather than an assumed zero`);
}

export function assessFullDemand(filesystems, terms) {
  const locations = new Map();
  const devices = new Map();
  for (const fs of filesystems) {
    if (locations.has(fs.label) || typeof fs.device !== "string") fail("unique observed storage labels/device identity");
    locations.set(fs.label, fs.device);
    // Positive forecasts use the reviewed 4 KiB allocation scenario. This is
    // geometry compatibility, not a fixed free-capacity threshold. No-demand
    // prerequisite observations do not claim that scenario or renew acquisition.
    if (terms.length && fs.allocationUnit !== "4096") fail(`actual allocation geometry compatible with the reviewed 4 KiB forecast for ${fs.label}`);
    let bytes = amount(fs.bytes), inodes = amount(fs.inodes);
    if (!Array.isArray(fs.quotas) || !fs.quotas.length) fail(`authoritative applicable quota acquisition for ${fs.label}`);
    const types = new Set();
    for (const quota of fs.quotas) {
      if (![0, 1, 2].includes(quota.type)) fail("user/group/project quota classification");
      types.add(quota.type);
      if (quota.state === "kernel-disabled") continue;
      if (quota.state !== "kernel-enabled") fail("authoritative enabled/disabled kernel quota state");
      if (quota.bytes !== null) bytes = minimum(bytes, amount(String(quota.bytes)));
      if (quota.inodes !== null) inodes = minimum(inodes, amount(String(quota.inodes)));
    }
    if (types.size !== 3) fail(`all applicable user/group/project quota domains for ${fs.label}`);
    const prior = devices.get(fs.device);
    devices.set(fs.device, { bytes: prior ? minimum(prior.bytes, bytes) : bytes, inodes: prior ? minimum(prior.inodes, inodes) : inodes, demandBytes: prior?.demandBytes ?? 0n, demandInodes: prior?.demandInodes ?? 0n });
  }
  // Reviewed shared/native compilation is charged to workspace. Metadata may
  // not silently move those writes to an observation-only, disjoint device.
  for (const [label, device] of locations) {
    if (/^cargo-(shared|native)(-package)?$/u.test(label) && device !== locations.get("workspace")) fail("source-bound Cargo targets on the charged workspace device before preparation");
  }
  for (const term of terms) {
    const device = locations.get(term.location);
    if (!device) fail(`effective storage acquisition for ${term.location}`);
    const fs = devices.get(device);
    // Sum ALL transient terms, rather than assume serial tasks or exploit an
    // unproven concurrency relation. Retained outputs/failure copies coexist.
    fs.demandBytes += amount(term.bytes);
    fs.demandInodes += amount(term.inodes);
  }
  const report = [];
  for (const [device, fs] of devices) {
    if (fs.bytes <= fs.demandBytes || fs.inodes <= fs.demandInodes) fail("workload-derived writable capacity/quota including separate root/home pressure");
    report.push({ device, bytes: String(fs.bytes), inodes: String(fs.inodes), demandBytes: String(fs.demandBytes), demandInodes: String(fs.demandInodes), ...(terms.length ? { allocationUnit: "4096" } : {}) });
  }
  return report;
}

export function fullSetupLocations(root, env = process.env) {
  const home = homedir();
  const placement = (key) => {
    if (typeof env[key] !== "string" || !path.isAbsolute(env[key]) || /[\r\n]/u.test(env[key])) fail(`explicit absolute ${key} configured in the canonical installer/consumer before setup (no unknown/default cache placement)`);
    return env[key];
  };
  return [
    ["workspace", root], ["root", "/"], ["home", home], ["node-temp", tmpdir()], ["runner-temp", process.env.RUNNER_TEMP],
    // Linux Rust/linker temporary storage uses TMPDIR or /tmp, unlike Node's
    // TMP/TEMP precedence. Observe those separate Python/Node candidates too.
    ["unix-temp", process.env.TMPDIR || "/tmp"],
    ...["TMP", "TEMP"].filter((key) => process.env[key]).map((key) => [`${key.toLowerCase()}-temp`, process.env[key]]),
    ["cargo-home", process.env.CARGO_HOME || path.join(home, ".cargo")],
    ["rustup-home", process.env.RUSTUP_HOME || path.join(home, ".rustup")],
    ["electron-cache", process.env.electron_config_cache || path.join(root, ".artifacts/electron-download-cache")],
    ["tool-cache", process.env.RUNNER_TOOL_CACHE],
    ["pnpm-installer", placement("FULL_PNPM_DEST")],
    // The pinned pnpm 10 action uses store format v10. The actual query below
    // must agree exactly; a different format/config never borrows this assessment.
    ["pnpm-store-root", placement("npm_config_store_dir")],
    ["pnpm-store", path.join(placement("npm_config_store_dir"), "v10")],
    ["browser-cache", placement("PLAYWRIGHT_BROWSERS_PATH")],
    ["uv-cache", placement("UV_CACHE_DIR")],
  ];
}

async function assertWritableLocations(locations) {
  for (const [label, requested] of locations) {
    if (typeof requested !== "string" || !path.isAbsolute(requested)) fail(`the actual ${label} destination`);
    let ancestor = requested;
    for (;;) {
      try {
        const resolved = await realpath(ancestor);
        if (/^cargo-(shared|native)(-package)?$/u.test(label) && resolved !== ancestor) fail("unredirected source-bound workspace Cargo target ancestors");
        break;
      }
      catch (error) {
        if (error.message?.startsWith("[precheck]")) throw error;
        const parent = path.dirname(ancestor);
        if (error.code !== "ENOENT" || parent === ancestor) fail(`the ${label} directory ancestor`);
        ancestor = parent;
      }
    }
    // sudo quota visibility must not substitute for the application's permissions.
    if (label !== "root") await access(ancestor, constants.W_OK | constants.X_OK);
  }
}

// Before toolchain/package setup, only installed Node/Python/git and the
// supervisor are needed. No product-plan or dependency import is allowed here.
export async function validateFullSetupEstimate(estimate, binding, root) {
  await validateEstimateIdentity(estimate, binding, root);
  const workflow = await readFile(path.join(root, ".github/workflows/canonical-ci.yml"));
  if (estimate.setup?.workflowSha256 !== createHash("sha256").update(workflow).digest("hex")) fail("setup risk covering the current canonical workflow actions and installs");
  validateTerms(estimate.setup.terms, estimate.sources, residualKinds);
}

export function validateFullSetupLocations(estimate, locations) {
  if (digest(estimate.setup?.destinations) !== digest(locations)) fail("unchanged resolved installer destinations before setup and after installation (no old environment-placement transfer)");
}

export function assessFullSetupDemand(filesystems, terms) {
  for (const kind of residualKinds) {
    if (!terms.some((term) => term.kind === kind)) fail(`source-grounded setup ${kind} workload risk`);
  }
  for (const fs of filesystems) {
    // Installer-created descendants can select a different project. Until their
    // exact placements are resolved, a root ancestor project is not authority.
    if (!fs.quotas?.some((quota) => quota.type === 2 && quota.state === "kernel-disabled") || fs.quotas.some((quota) => quota.type === 2 && quota.state !== "kernel-disabled")) fail("actual installer destination/project-quota placement before setup on a project-quota-enabled mount");
    // Every probe still contributes quota/capacity pressure to its real device,
    // even when writes are charged at another label or there are no writes here.
  }
  return assessFullDemand(filesystems, terms);
}

export async function collectFullLocations(root, run, env = process.env) {
  const locations = fullSetupLocations(root, env);
  const verify = (label, actual) => {
    const expected = locations.find(([name]) => name === label)?.[1];
    if (!path.isAbsolute(actual) || path.normalize(actual) !== path.normalize(expected)) fail(`actual ${label} query agreeing with its pre-installation destination assessment`);
  };
  const pnpm = await run("storage-pnpm", { command: "pnpm", args: ["store", "path"], cwd: "." });
  verify("pnpm-store", pnpm.trim());
  const browser = JSON.parse(await run("storage-browser", { command: "node", args: ["--input-type=module", "-e", "import { chromium } from 'playwright'; console.log(JSON.stringify(chromium.executablePath()))"], cwd: "." }));
  // On this Linux lane Playwright resolves cache/chromium-<revision>/
  // chrome-linux[64]/chrome. Observe the cache root, not the revision directory.
  if (!/^chromium-[0-9]+$/u.test(path.basename(path.dirname(path.dirname(browser)))) || !["chrome-linux", "chrome-linux64"].includes(path.basename(path.dirname(browser))) || path.basename(browser) !== "chrome") fail("the actual Linux Chromium cache placement before preparation");
  verify("browser-cache", path.dirname(path.dirname(path.dirname(browser))));
  const uv = await run("storage-uv", { command: "uv", args: ["cache", "dir"], cwd: "experiments/lfm25-encoder-phase0" });
  verify("uv-cache", uv.trim());
  for (const [label, cwd, manifest] of [
    ["cargo-shared", ".", "src-tauri/Cargo.toml"],
    ["cargo-shared-package", "src-tauri", "Cargo.toml"],
    ["cargo-native", ".", "electron/native/grimodex-node/Cargo.toml"],
    ["cargo-native-package", "electron/native/grimodex-node", "Cargo.toml"],
  ]) {
    const metadata = JSON.parse(await run(`storage-${label}`, { command: "cargo", args: ["metadata", "--no-deps", "--locked", "--offline", "--format-version", "1", "--manifest-path", manifest], cwd }));
    const target = path.join(root, label.startsWith("cargo-shared") ? "src-tauri/target" : "electron/native/grimodex-node/target");
    if (metadata.target_directory !== target) fail(`the source-bound workspace Cargo target for ${label}`);
    locations.push([label, target]);
  }
  locations.push(["uv-environment", process.env.UV_PROJECT_ENVIRONMENT ? path.resolve(root, "experiments/lfm25-encoder-phase0", process.env.UV_PROJECT_ENVIRONMENT) : path.join(root, "experiments/lfm25-encoder-phase0/.venv")]);
  await assertWritableLocations(locations);
  return locations;
}

// Measured preparation is connected to both safety (reject envelope overruns)
// and the residual estimate. Sampling is finite empirical evidence, not an
// exact all-future high-water certificate; reviewed uncertainty remains required.
export function assertPreparationEnvelope(before, lowWater, budgets) {
  for (const fs of before) {
    const budget = budgets.find((entry) => entry.device === fs.device);
    const low = lowWater.get(fs.label);
    if (!budget || !low) fail("complete joined preparation allocation observations");
    const bytes = amount(fs.bytes) > low.bytes ? amount(fs.bytes) - low.bytes : 0n;
    const inodes = amount(fs.inodes) > low.inodes ? amount(fs.inodes) - low.inodes : 0n;
    if (bytes > amount(budget.demandBytes) || inodes > amount(budget.demandInodes)) fail("a revised source-grounded preparation risk estimate after an observed envelope overrun (no retry)");
  }
}

export function resolveObservedResidual(terms, samples) {
  return terms.map((term) => {
    if (!term.measurement) return term;
    const { preparationId, mode, location } = term.measurement;
    if (!["retained", "peak"].includes(mode)) fail(`a defined preparation observation for ${term.id}`);
    const sample = samples.find((entry) => entry.id === preparationId);
    const before = sample?.before.find((fs) => fs.label === location);
    const after = (mode === "peak" ? sample?.lowWater : sample?.after)?.find((fs) => fs.label === location);
    if (!before || !after) fail(`actual same-job ${mode} preparation sizing for ${term.id}`);
    const growth = (key) => {
      const observed = amount(before[key]) > amount(after[key]) ? amount(before[key]) - amount(after[key]) : 0n;
      // A quiet cached rebuild never turns a positive reviewed residual to zero.
      return String(amount(term[key]) > observed ? amount(term[key]) : observed);
    };
    return { ...term, bytes: growth("bytes"), inodes: growth("inodes") };
  });
}

async function hostedJobIsolation() {
  // Authority: this fixed ubuntu-24.04 standard hosted job receives a fresh VM
  // for ONE job (GitHub hosted-runner contract). Environment alone is not proof;
  // corroborate actual Linux VM, and never accept self-hosted/container runners.
  if (process.platform !== "linux" || process.env.RUNNER_ENVIRONMENT !== "github-hosted" || !/^[1-9][0-9]*$/u.test(process.env.GITHUB_RUN_ID ?? "") || !/^[1-9][0-9]*$/u.test(process.env.GITHUB_RUN_ATTEMPT ?? "")) fail("a continuously owned standard GitHub-hosted Linux job");
  const vendor = (await readFile("/sys/class/dmi/id/sys_vendor", "utf8")).trim();
  const model = (await readFile("/sys/class/dmi/id/product_name", "utf8")).trim();
  if (vendor !== "Microsoft Corporation" || model !== "Virtual Machine") fail("actual standard hosted VM isolation, not a checkout lock/serial option");
}

async function durableJson(file, data) {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  const directory = await open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function readWorkloadAllocation(root, binding, run) {
  let bytes;
  try {
    const file = path.join(root, workloadAllocationPath);
    if (!(await lstat(file)).isFile() || await realpath(file) !== path.join(await realpath(root), workloadAllocationPath)) fail("a regular allocation dataset inside this checkout, without symlink placement");
    bytes = await readFile(file);
  } catch (error) {
    if (error.message?.startsWith("[precheck]")) throw error;
    fail(`acquire and independently review physical installer/build/fixture/failure/log byte/inode inventories and justified additive uncertainty in the tracked ${workloadAllocationPath} before Full setup`);
  }
  const tracked = (await run("allocation-tracked", { command: "git", args: ["ls-files", "--stage", "--", workloadAllocationPath] })).trim();
  if (!/^100(644|755) [0-9a-f]{40} 0\tscripts\/local-ci-full-workload-allocation\.json$/u.test(tracked)) fail("the regular reviewed allocation dataset tracked by this clean candidate");
  const committed = await run("allocation-committed", { command: "git", args: ["show", `${binding.head}:${workloadAllocationPath}`] });
  if (!bytes.equals(Buffer.from(committed))) fail("allocation data byte-identical to the current candidate, not an untracked or changed inventory");
  let data;
  try { data = JSON.parse(bytes.toString("utf8")); }
  catch { fail(`valid reviewed physical allocation JSON in ${workloadAllocationPath}`); }
  const keys = ["version", "registryDigest", "maxParallelTasks", "sources", "inventories", "setup", "preparation", "tasks"];
  if (!data || Array.isArray(data) || digest(Object.keys(data).sort()) !== digest(keys.sort()) || data.version !== "full-workload-allocation/1") fail("the finite reviewed allocation schema, without a supplied candidate/run binding, command or admission flag");
  if (data.registryDigest !== binding.registryDigest || data.maxParallelTasks !== binding.maxParallelTasks) fail("allocation recipes for the current registry and exact scheduler option");
  const input = { version: "full-workload-input/1", binding, sources: data.sources, inventories: data.inventories, setup: data.setup, preparation: data.preparation, tasks: data.tasks };
  await validateEstimateIdentity(input, binding, root);
  const required = ["scripts/local-ci-full-admission.mjs", "scripts/local-ci-full-filesystems.py", "scripts/local-ci-process-supervisor.mjs", "scripts/local-ci.mjs", "scripts/local-ci-runner.mjs", "package.json", "pnpm-lock.yaml", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "electron/native/grimodex-node/Cargo.toml", "electron/native/grimodex-node/Cargo.lock"];
  if (new Set(input.sources.map(({ path: name }) => name)).size !== input.sources.length || input.sources.some(({ path: name }) => name === workloadAllocationPath)) fail("distinct sizing sources without a self-referential dataset digest");
  for (const name of required) if (!input.sources.some((entry) => entry.path === name)) fail(`current acquisition/build/dependency sizing source ${name}`);
  for (const [index, source] of input.sources.entries()) {
    const file = path.resolve(root, source.path);
    if (!(await lstat(file)).isFile() || await realpath(file) !== path.join(await realpath(root), source.path)) fail(`regular sizing source without symlink placement: ${source.path}`);
    await run(`allocation-source-${index}`, { command: "git", args: ["ls-files", "--error-unmatch", "--", source.path] });
  }
  return { input, allocation: { path: workloadAllocationPath, sha256: createHash("sha256").update(bytes).digest("hex") } };
}

export function validateWorkloadAcquisition(acquired, current, input, estimate, binding) {
  if (acquired?.state !== "created" || digest(acquired.binding) !== digest(binding) || digest(acquired.allocation) !== digest(current.allocation) || acquired.inputDigest !== digest(input) || digest(current.input) !== digest(input) || acquired.estimateDigest !== digest(estimate) || estimate.inputDigest !== digest(input)) fail("unchanged reviewed allocation dataset, current-run input and estimate after setup");
}

// Same durable setup owner calls this once. All quantities and sources are
// validated before input creation; partial writes retain the owner's fence.
export async function acquireWorkloadInput({ root, binding, directory, run, signal, setupLocations }) {
  signal?.throwIfAborted();
  const { input, allocation } = await readWorkloadAllocation(root, binding, run);
  const estimate = await produceWorkloadEstimate(input, binding, root, setupLocations);
  signal?.throwIfAborted();
  await durableJson(path.join(root, workloadInputPath), input);
  signal?.throwIfAborted();
  await durableJson(path.join(root, workloadEstimatePath), estimate);
  signal?.throwIfAborted();
  await durableJson(path.join(directory, "workload-acquisition.json"), { binding, allocation, inputDigest: digest(input), estimateDigest: digest(estimate), state: "created" });
  signal?.throwIfAborted();
  return { input, estimate };
}

function admissionRunner(root, directory, signal) {
  return async (id, command, timeoutMs = 30_000, commandSignal = signal, capture = true) => {
    // Retain per-child ownership and complete supervisor close/log identities,
    // not raw argv/environment/log bodies, in the existing phase directory.
    await durableJson(path.join(directory, `${id}-start.json`), { id, state: "possible-start", timeoutMs });
    let result;
    try {
      result = await runLocalCiCommand(command, { root, taskId: id, logDirectory: path.relative(root, directory), signal: commandSignal, timeoutMs, closeGraceMs: 2_000 });
    } catch (error) {
      await durableJson(path.join(directory, `${id}-close.json`), error.result ?? { termination: "unknown" });
      if (error.lateClose) await durableJson(path.join(directory, `${id}-late-close.json`), await error.lateClose);
      throw error;
    }
    await durableJson(path.join(directory, `${id}-close.json`), result);
    if (result.exitCode !== 0 || result.signal || result.interrupted || result.timedOut || !result.closeObserved || result.cleanup?.complete !== true || result.cleanup?.groupAlive || result.error) fail(`successful actual close/EOF/file joins/group absence for ${id}`);
    return capture ? readFile(path.resolve(root, result.logs.stdout.path), "utf8") : result;
  };
}

// Exactly one same-job continuation after the selected pinned ordinary setup.
// Missing/failed/stale/consumed preflight never recovers or creates another owner.
async function resumeNormalReference({ root, base, head, maxParallelTasks, signal, cpu = false }) {
  await hostedJobIsolation();
  const directory = path.join(root, ".artifacts/local-ci/full-admission", `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-setup-reference`);
  const preflight = JSON.parse(await readFile(path.join(directory, "normal-preflight.json"), "utf8"));
  const registry = JSON.parse(await readFile(path.join(root, "scripts/local-ci-registry.json"), "utf8"));
  const binding = { base, head, tree: preflight.binding?.tree, registryDigest: `sha256:${digest(registry)}`, maxParallelTasks, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
  if (head !== process.env.GITHUB_SHA || digest(binding) !== digest(preflight.binding) || digest(referenceLocations(root, cpu)) !== preflight.locationsDigest || (cpu ? preflight.purpose !== "cpu" : preflight.purpose === "cpu") || !Number.isSafeInteger(preflight.deadline) || Date.now() >= preflight.deadline) fail("unchanged current normal preflight binding/destinations/deadline");
  if (!Array.isArray(preflight.sources) || digest(preflight.sources.map(({ path: file }) => file)) !== digest(cpu ? cpuSources : normalSources)) fail("the exact normal prerequisite sizing sources");
  for (const { path: file, sha256 } of preflight.sources) if (createHash("sha256").update(await readFile(path.join(root, file))).digest("hex") !== sha256) fail("unchanged normal preparation sources");
  signal?.throwIfAborted();
  // Claim before any resumed child/log write. EEXIST fences all reentry.
  await durableJson(path.join(directory, "normal-start.json"), { binding, state: "possible-start", deadline: preflight.deadline });
  signal?.throwIfAborted();
  const run = admissionRunner(root, directory, signal);
  const tree = (await run("normal-resume-tree", { command: "git", args: ["rev-parse", "HEAD^{tree}"] })).trim();
  if (tree !== binding.tree || (await run("normal-resume-head", { command: "git", args: ["rev-parse", "HEAD"] })).trim() !== head || (await run("normal-resume-clean", { command: "git", args: ["status", "--porcelain", "--untracked-files=all"] })).trim()) fail("a clean unchanged normal preparation candidate");
  return { directory, registry, run, binding, deadline: preflight.deadline };
}

async function openAdmission({ root, base, head, maxParallelTasks, signal }, phase) {
  await hostedJobIsolation();
  if (![base, head].every((id) => /^[0-9a-f]{40}$/u.test(id)) || head !== process.env.GITHUB_SHA) fail("the expanded immutable candidate tuple");
  if (!Number.isSafeInteger(maxParallelTasks) || maxParallelTasks < 1 || maxParallelTasks > 12) fail("the existing scheduler option from 1 through 12");
  const directory = path.join(root, ".artifacts/local-ci/full-admission", `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}${phase === "preparation" ? "" : `-${phase}`}`);
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  // No stale-owner recovery. A failed/uncertain attempt retains this fence.
  await mkdir(directory, { mode: 0o700 });
  const registry = JSON.parse(await readFile(path.join(root, "scripts/local-ci-registry.json"), "utf8"));
  const run = admissionRunner(root, directory, signal);
  try {
    await durableJson(path.join(directory, "acquisition-owner.json"), { base, head, maxParallelTasks, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, state: `possible-${phase}-acquisition` });
    const tree = (await run("identity-tree", { command: "git", args: ["rev-parse", "HEAD^{tree}"] })).trim();
    if ((await run("identity-head", { command: "git", args: ["rev-parse", "HEAD"] })).trim() !== head || (await run("identity-clean", { command: "git", args: ["status", "--porcelain", "--untracked-files=all"] })).trim()) fail("a clean current candidate before preparation");
    await run("identity-ancestry", { command: "git", args: ["merge-base", "--is-ancestor", base, head] });
    const binding = { base, head, tree, registryDigest: `sha256:${digest(registry)}`, maxParallelTasks, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
    await durableJson(path.join(directory, "owner.json"), { binding, state: `possible-${phase}` });
    signal?.throwIfAborted();
    // This read-only prerequisite never creates/consumes an admission decision.
    if (phase === "setup-reference") return { directory, registry, run, binding };
    let input, estimate;
    if (phase === "setup") {
      ({ input, estimate } = await acquireWorkloadInput({ root, binding, directory, run, signal }));
    } else {
      let acquired;
      try {
        input = JSON.parse(await readFile(path.join(root, workloadInputPath), "utf8"));
        estimate = JSON.parse(await readFile(path.join(root, workloadEstimatePath), "utf8"));
        acquired = JSON.parse(await readFile(path.join(`${directory}-setup`, "workload-acquisition.json"), "utf8"));
      } catch { fail("the exclusively created same-job input/estimate/acquisition receipt, without regeneration or stale transfer"); }
      const current = await readWorkloadAllocation(root, binding, run);
      validateWorkloadAcquisition(acquired, current, input, estimate, binding);
    }
    signal?.throwIfAborted();
    await validateEstimateIdentity(estimate, binding, root);
    return { directory, registry, run, binding, estimate };
  } catch (error) {
    if (error.lateClose) await error.lateClose;
    throw error;
  }
}

export function validateFullSetupDecision(setup, binding, estimate) {
  if (setup?.admitted !== true || setup.phase !== "setup" || digest(setup.binding) !== digest(binding) || setup.estimateDigest !== digest(estimate)) fail("the unchanged setup estimate and same owned run/attempt decision (no stale transfer)");
}

export async function admitFullSetup(options) {
  const { root } = options;
  const { directory, run, binding, estimate } = await openAdmission(options, "setup");
  try {
    await validateFullSetupEstimate(estimate, binding, root);
    const locations = fullSetupLocations(root);
    validateFullSetupLocations(estimate, locations);
    await assertWritableLocations(locations);
    const filesystems = JSON.parse(await run("setup-filesystems", {
      command: "sudo", args: ["-n", "python3", "scripts/local-ci-full-filesystems.py", JSON.stringify({ locations, uid: process.getuid(), gids: [...new Set([process.getgid(), ...process.getgroups()])] })], cwd: ".",
    }));
    const report = assessFullSetupDemand(filesystems, estimate.setup.terms);
    options.signal?.throwIfAborted();
    await durableJson(path.join(directory, "decision.json"), { binding, estimateDigest: digest(estimate), admitted: true, phase: "setup", report });
    options.signal?.throwIfAborted();
    return report;
  } catch (error) {
    if (error.lateClose) await error.lateClose;
    throw error;
  }
}

export async function admitFullResources(options) {
  const { root, base, head, maxParallelTasks, signal } = options;
  const { directory, registry, run, binding, estimate } = await openAdmission(options, "preparation");
  try {
    await validateFullSetupEstimate(estimate, binding, root);
    let setup;
    try { setup = JSON.parse(await readFile(path.join(`${directory}-setup`, "decision.json"), "utf8")); }
    catch { fail("the successful same-job setup risk/quota decision before any heavy installation"); }
    validateFullSetupDecision(setup, binding, estimate);
    validateFullSetupLocations(estimate, fullSetupLocations(root));
    const locations = await collectFullLocations(root, run);
    // local-ci's product-plan imports need installed packages. Never import them
    // before the initial setup risk/quota decision has been validated.
    const { buildLocalCiPlan } = await import("./local-ci.mjs");
    const plan = buildLocalCiPlan(registry, { profile: "full", base, head, maxParallelTasks });
    const preparation = fullPreparation(plan);
    await validateWorkloadEstimate(estimate, binding, plan, preparation, root);
    await durableJson(path.join(directory, "preparation-plan.json"), { binding, preparation: preparation.map(({ id, command }) => ({ id, commandDigest: digest(command) })) });
    let acquisition = 0;
    const probe = async () => JSON.parse(await run(`filesystems-${acquisition++}`, {
      command: "sudo", args: ["-n", "python3", "scripts/local-ci-full-filesystems.py", JSON.stringify({ locations, uid: process.getuid(), gids: [...new Set([process.getgid(), ...process.getgroups()])] })], cwd: ".",
    }));
    const samples = [];
    for (const [index, step] of preparation.entries()) {
      const before = await probe();
      // Account for all future retained outputs and even all preparation peaks
      // together. This is conservative workload overlap, never default serial.
      assessFullDemand(before, [...estimate.preparation.slice(index).flatMap((risk) => risk.terms), ...estimate.residual]);
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      let stopped = false, samplingError = null;
      const peak = new Map(before.map((fs) => [fs.label, { bytes: amount(fs.bytes), inodes: amount(fs.inodes) }]));
      const risk = estimate.preparation[index];
      const stepBudgets = assessFullDemand(before, risk.terms);
      const sample = async () => {
        for (const [label, requested] of locations) {
          let ancestor = requested;
          for (;;) {
            try {
              const fs = await statfs(ancestor, { bigint: true });
              const prior = peak.get(label);
              prior.bytes = minimum(prior.bytes, fs.bavail * fs.bsize);
              prior.inodes = minimum(prior.inodes, fs.ffree);
              break;
            } catch (error) {
              const parent = path.dirname(ancestor);
              if (error.code !== "ENOENT" || parent === ancestor) throw error;
              ancestor = parent;
            }
          }
        }
        assertPreparationEnvelope(before, peak, stepBudgets);
      };
      const sampler = (async () => {
        try { while (!stopped) { await sample(); await new Promise((resolve) => setTimeout(resolve, 200)); } }
        catch (error) { samplingError = error; controller.abort(error); }
      })();
      let result;
      try { result = await run(`prepare-${step.id}`, step.command, risk.timeoutMs, controller.signal, false); }
      finally { stopped = true; await sampler; signal?.removeEventListener("abort", abort); }
      if (samplingError) fail(`joined storage sampling for ${step.id}`);
      await sample();
      const after = await probe();
      samples.push({ id: step.id, before, after, lowWater: [...peak].map(([label, values]) => ({ label, bytes: String(values.bytes), inodes: String(values.inodes) })), logs: result.logs });
      await durableJson(path.join(directory, `preparation-${index}.json`), samples.at(-1));
    }
    // Every preparation child and sampler has joined; quota/capacity observations
    // are fresh on the SAME job. Prepared allocations are already in free space.
    await hostedJobIsolation();
    if ((await run("final-head", { command: "git", args: ["rev-parse", "HEAD"] })).trim() !== head || (await run("final-clean", { command: "git", args: ["status", "--porcelain", "--untracked-files=all"] })).trim()) fail("an unchanged clean candidate after preparation");
    const report = assessFullDemand(await probe(), resolveObservedResidual(estimate.residual, samples));
    signal?.throwIfAborted();
    await durableJson(path.join(directory, "decision.json"), { binding, estimateDigest: digest(estimate), admitted: true, report, preparationCount: samples.length });
    signal?.throwIfAborted();
    // Fixed canonical caller retains job ownership through Full + immediate verify.
    // This is not a transferable receipt, B permission, or a Full gate pass.
    return report;
  } catch (error) {
    // Unknown process retirement retains its supervisor and owner; no replacement
    // can start while lateClose is pending. Never recover/delete a foreign owner.
    if (error.lateClose) await error.lateClose;
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.umask(0o077);
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Full admission interrupted"));
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  try {
    const args = process.argv.slice(2);
    const setup = args[0] === "--setup";
    const reference = args[0] === "--setup-reference";
    const grouped = args[0] === "--grouped-reference";
    const native = args[0] === "--native-reference";
    const cpu = args[0] === "--cpu-preflight" || args[0] === "--cpu-reference";
    const normal = cpu || args[0] === "--normal-preflight" || args[0] === "--normal-reference";
    const preflight = args[0] === "--normal-preflight" || args[0] === "--cpu-preflight";
    if (setup || reference || grouped || normal || native) args.shift();
    const [base, head, slots] = args;
    if (args.length !== 3 || !/^([1-9]|1[0-2])$/u.test(slots ?? "")) fail("the existing exact base/head/scheduler option arguments");
    await (grouped || normal || native ? stageFullGroupedReference : reference ? stageFullSystemReference : setup ? admitFullSetup : admitFullResources)({ root: process.cwd(), base, head, maxParallelTasks: Number(slots), signal: controller.signal, normal, preflight, cpu, native });
    console.log(native ? "Native compile-only prerequisite observations recorded; Full remains unadmitted" : normal ? `${cpu ? "CPU" : "Normal"} prerequisite ${preflight ? "focused preflight" : "observations"} recorded; Full remains unadmitted` : grouped ? "Grouped pure-DB prerequisite observations recorded; Full remains unadmitted" : reference ? "Canonical system prerequisite size reference recorded; Full remains unadmitted" : `Full same-job ${setup ? "setup risk" : "resource"} admission passed; preparation is not Full/B/Editor acceptance`);
  } catch (error) {
    console.error(error.message.startsWith("[precheck]") ? error.message : "[precheck] Full conditional resource acquisition failed; owner retained");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
  }
}
