import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import yaml from "js-yaml";

import { PRODUCT_DOMAIN_RULES } from "../electron/scripts/product-journey-catalog.mjs";
import {
  decideForEvent,
  decideScope,
  formatOutputs,
  laneNames,
  loadScopeRules,
} from "./ci-change-scope.mjs";
import {
  evaluateIf,
  laneByGatedJob,
  stripScopeGate,
  unwrapIf,
} from "./ci-change-scope.test-support.mjs";
import { compileGlob } from "./impact/core.mjs";

const execute = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts/ci-change-scope.mjs");

const ci = yaml.load(await readFile(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8"));
const rawRules = JSON.parse(await readFile(path.join(repoRoot, "scripts/ci-change-scope.json"), "utf8"));
const rules = await loadScopeRules();
const LANES = laneNames(rules);
const ALWAYS_RUN_JOBS = ["quality", "frontend", "electron"];
const OTHER_OWNERS = ["canonical", "existing-os-suitability", "changes"];

const ALL_RUN = Object.fromEntries(LANES.map((lane) => [lane, true]));
const lanesFor = (changedPaths, extra = {}) => {
  const decision = decideScope({ rules, changedPaths, ...extra });
  return Object.fromEntries(LANES.map((lane) => [lane, decision.lanes[lane].run]));
};
const only = (runs) => Object.fromEntries(LANES.map((lane) => [lane, runs.includes(lane)]));

// ---------------------------------------------------------------------------
// The rules file and the workflow agree with each other.
// ---------------------------------------------------------------------------

test("change scope rules, the changes job outputs and its shell fallback name the same lanes", () => {
  const changes = ci.jobs.changes;
  assert.deepEqual(Object.keys(changes.outputs).sort(), [...LANES].sort());
  for (const lane of LANES) {
    assert.equal(changes.outputs[lane], `\${{ steps.scope.outputs.${lane} }}`, lane);
  }
  const scope = changes.steps.find(({ id }) => id === "scope");
  const listed = /^lanes="([^"]+)"$/mu.exec(scope.run);
  assert.ok(listed, "the shell fallback must list the lanes literally");
  assert.deepEqual(listed[1].split(" ").sort(), [...LANES].sort());
  assert.match(scope.run, /grep -c \.\)" = "8"/u, "the shell checks for exactly eight lines");
  assert.equal(LANES.length, 8);
  for (const lane of LANES) assert.match(lane, /^[a-z][a-z0-9]*$/u);
});

test("every job is gated, a cascade of a gated job, or always runs; nothing else reads the change scope", () => {
  const laneOfJob = laneByGatedJob(rawRules);
  const cascade = new Map();
  for (const [lane, definition] of Object.entries(rawRules.lanes)) {
    for (const id of definition.cascadeJobs ?? []) cascade.set(id, lane);
  }
  const referencing = Object.entries(ci.jobs)
    .filter(([id, job]) => id !== "changes" && /needs\.changes/u.test(JSON.stringify(job)))
    .map(([id]) => id)
    .sort();
  assert.deepEqual(referencing, Object.keys(laneOfJob).sort());

  for (const [id, job] of Object.entries(ci.jobs)) {
    if (OTHER_OWNERS.includes(id)) continue;
    const classified = [id in laneOfJob, cascade.has(id), ALWAYS_RUN_JOBS.includes(id)].filter(Boolean);
    assert.equal(classified.length, 1, `${id} must be exactly one of gated, cascade, always-run`);
    if (id in laneOfJob) {
      const gate = stripScopeGate(job.if);
      assert.equal(gate.lane, laneOfJob[id], id);
      assert.deepEqual(job.needs, ["changes"], id);
      assert.match(job.if, /^\$\{\{ !cancelled\(\) && \(.+\) && needs\.changes\.outputs\.[a-z0-9]+ != 'false' \}\}$/su, id);
    } else {
      // Cascade and always-run jobs keep their guard and never name `changes`.
      assert.doesNotMatch(JSON.stringify(job), /needs\.changes|"changes"/u, id);
    }
  }
  for (const id of ALWAYS_RUN_JOBS) assert.equal(jobOf(id).needs, undefined, id);
});

function jobOf(id) {
  assert.ok(ci.jobs[id], `${id} job is required`);
  return ci.jobs[id];
}

test("cascade jobs skip through the needs chain of a gated job, and the pinned needs are untouched", () => {
  for (const [lane, definition] of Object.entries(rawRules.lanes)) {
    const roots = new Set(definition.gatedJobs);
    const reaches = (id, seen = new Set()) => {
      if (roots.has(id)) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      const needs = [jobOf(id).needs ?? []].flat();
      return needs.some((need) => reaches(need, seen));
    };
    for (const id of definition.cascadeJobs ?? []) {
      assert.ok(reaches(id), `${id} must reach a ${lane} root through needs`);
    }
  }
  // The runtime-performance workflow test pins this literal string.
  assert.equal(jobOf("electron-runtime-performance").needs, "electron-product-journeys-build");
  assert.deepEqual(jobOf("electron-product-journeys").needs, [
    "electron-product-journeys-build",
    "electron-product-journeys-c2zc",
  ]);
  assert.equal(
    jobOf("electron-product-journeys-aggregate").name,
    "Electron product journeys (persistence / workspace authority)",
  );
});

test("the changes job never fails the run and diffs only for pull requests", () => {
  const changes = jobOf("changes");
  assert.equal(changes.name, "Change scope");
  assert.equal(changes["runs-on"], "ubuntu-24.04");
  assert.equal(changes["timeout-minutes"], 5);
  // Same guard as the journey roots, so a root that runs always has `changes`.
  assert.equal(
    changes.if,
    "${{ !inputs.source_focused && !inputs.source_canonical_contracts && !inputs.canonical_profile && !inputs.candidate_base && !inputs.candidate_head && !inputs.max_parallel_tasks && !inputs.independent_gates }}",
  );
  const [checkout, setup, scope, upload] = changes.steps;
  assert.equal(changes.steps.length, 4);
  assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/u);
  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(checkout.with["persist-credentials"], false);
  assert.match(setup.uses, /^actions\/setup-node@[0-9a-f]{40}$/u);
  assert.match(upload.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/u);
  for (const step of [checkout, setup, upload]) assert.equal(step.if, "github.event_name == 'pull_request'");
  // A failed step would fail `changes`, and a failed need also skips the
  // unchanged shard/aggregate jobs downstream, so every step may fail softly.
  for (const step of changes.steps) assert.equal(step["continue-on-error"], true, step.name);
  assert.deepEqual(scope.env, {
    BASE_SHA: "${{ github.event.pull_request.base.sha }}",
    HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
  });
  assert.doesNotMatch(scope.run, /\$\{\{/u, "no expression is interpolated into the script");
  assert.doesNotMatch(scope.run, /\|\|\s*true/u);
  assert.equal(upload.with["if-no-files-found"], "ignore");
});

// ---------------------------------------------------------------------------
// Classification.
// ---------------------------------------------------------------------------

test("docs-only changes skip every heavy lane including journeys", () => {
  assert.deepEqual(
    lanesFor(["docs/local-ci-runner.md", "README.md", "public/RELEASE_NOTES/v2.0.0.ja.md", "experiments/notes/a.py"]),
    only([]),
  );
});

test("CI, scripts and AI instruction changes skip the Rust, native, migration, windows, browser, lfm and security lanes but run journeys", () => {
  assert.deepEqual(
    lanesFor([
      "scripts/quality/impact-map.mjs",
      ".agents/skills/review-code/SKILL.md",
      ".claude/hooks/block-push-to-main.sh",
      "policies/quality/iron-laws.md",
      "evals/quality-manifest.yaml",
      "evals/impact-map.yaml",
    ]),
    only(["journeys"]),
  );
  // scripts/local-ci*.mjs are imported by the native and Windows lanes' own
  // JS tests (through electron/scripts), so those two lanes keep running.
  assert.deepEqual(lanesFor(["scripts/local-ci-runner.mjs"]), only(["journeys", "native", "windows"]));
  // Docs plus CI assets: journeys run because the CI assets are not docs.
  assert.deepEqual(lanesFor(["docs/a.md", "scripts/quality/x.mjs"]), only(["journeys"]));
});

test("the lfm lane runs only when its own directory changes, even beside docs or other code", () => {
  const lfm = "experiments/lfm25-encoder-phase0/src/encoder.py";
  assert.deepEqual(lanesFor([lfm]), only(["lfm"]));
  assert.deepEqual(lanesFor(["docs/a.md", lfm]), only(["lfm"]));
  assert.equal(lanesFor(["src/features/a.ts"]).lfm, false);
  assert.equal(lanesFor(["src/features/a.ts", lfm]).lfm, true);
  assert.equal(lanesFor(["experiments/other/a.py"]).lfm, false);
});

test("mixed changes decide each lane from its own neutral set", () => {
  // Docs plus renderer: only the lanes a renderer change cannot reach are skipped.
  assert.deepEqual(
    lanesFor(["docs/a.md", "src/features/editor/a.ts"]),
    only(["journeys", "rust", "native", "migration", "windows", "browser", "security"]),
  );
  // CI assets plus an unclassified script still run everything but lfm.
  assert.deepEqual(
    lanesFor(["scripts/quality/x.mjs", "scripts/browser-ci-benchmark.mjs"]),
    only(["journeys", "rust", "native", "migration", "windows", "browser", "security"]),
  );
});

test("unclassified and nested markdown paths are not neutral", () => {
  for (const unclassified of [
    "src/features/settings/README.md",
    "public/TERMS_ja.md",
    "packages/ui/notes.md",
    "src-tauri/crates/grimodex-db/src/lib.rs",
    "evals/nir1-capacity/manifest.v1.json",
    "LICENSE",
    "NOTICE",
    "some-new-top-level-file.txt",
  ]) {
    const lanes = lanesFor([unclassified]);
    assert.equal(lanes.journeys && lanes.rust && lanes.native && lanes.migration && lanes.windows && lanes.browser && lanes.security, true, unclassified);
  }
});

test("forced-all paths run every lane, including lfm", () => {
  const samples = [
    ".github/workflows/ci.yml",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    "patches/sharp@0.34.5.patch",
    "src-tauri/Cargo.lock",
    "electron/native/grimodex-node/Cargo.lock",
    "src-tauri/crates/grimodex-db/Cargo.toml",
    ".cargo/config.toml",
    "electron-builder.yml",
    "scripts/local-ci-registry.json",
    "scripts/impact/core.mjs",
    "scripts/ci-change-scope.json",
    "scripts/ci-change-scope.mjs",
    "scripts/ci-change-scope.test.mjs",
    "electron/main/index.ts",
    "electron/shared/ipcContract.ts",
  ];
  for (const sample of samples) {
    assert.deepEqual(lanesFor([sample]), ALL_RUN, sample);
    // One forced path beside docs still forces every lane.
    assert.deepEqual(lanesFor(["docs/a.md", sample]), ALL_RUN, `docs + ${sample}`);
  }
  assert.equal(rawRules.forceAll.length, 14);
});

test("paths the Rust crates read from outside their directories never make Rust skippable", () => {
  const external = [
    "policies/narrative/narrative-run-kind-policy.json",
    "src/db/generated/schema-contract.json",
    "scripts/schema-seed-ja.sql",
    "scripts/schema-seed-en.sql",
    "evals/nir1-capacity/manifest.v1.json",
    "evals/fixtures/narrative/canonical-text-v1.json",
    "agent-tool-manifest.json",
    "src/features/timelapse/hash-vectors.json",
  ];
  for (const sample of external) {
    assert.equal(lanesFor([sample]).rust, true, sample);
    assert.equal(lanesFor(["docs/a.md", sample]).rust, true, `docs + ${sample}`);
    assert.equal(lanesFor(["docs/a.md", "scripts/quality/x.mjs", sample]).rust, true, `docs + ci + ${sample}`);
  }
});

test("the docs set matches the product journey catalog's neutral rules, and its forceAll paths keep journeys running", async () => {
  const neutral = PRODUCT_DOMAIN_RULES.filter((rule) => rule.neutral === true).flatMap((rule) => [...rule.paths]);
  assert.deepEqual([...neutral].sort(), [...rawRules.sets.docs].sort());
  assert.deepEqual(rawRules.lanes.journeys.neutral, ["docs"]);
  // The catalog lets forceAll win over neutral, so a forceAll path that the
  // docs globs also match (AGENTS.md) must still run the journeys.
  const sample = (glob) => glob.replaceAll("**", "sample/x").replaceAll("*", "x");
  const forced = PRODUCT_DOMAIN_RULES.filter((rule) => rule.forceAll === true).flatMap((rule) => [...rule.paths]);
  assert.ok(forced.includes("AGENTS.md"));
  for (const glob of forced) {
    const candidate = sample(glob);
    assert.ok(compileGlob(glob).test(candidate), `${candidate} must match ${glob}`);
    assert.equal(lanesFor([candidate]).journeys, true, `${candidate} (catalog forceAll ${glob})`);
    assert.equal(lanesFor(["docs/a.md", candidate]).journeys, true, `docs + ${candidate}`);
  }
  // Other root markdown stays neutral, as in the catalog.
  assert.equal(lanesFor(["CLAUDE.md", "README.md"]).journeys, false);
});

async function listFiles(directory, pattern) {
  const root = path.join(repoRoot, directory);
  return (await readdir(root, { recursive: true }))
    .filter((name) => pattern.test(name.split(path.sep).join("/")))
    .map((name) => path.join(root, name));
}

/** Static relative-import closure; the files a lane's tests load beyond their own directory. */
async function importClosure(entries) {
  const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/gu;
  const pending = [...entries];
  const seen = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(?:mjs|js|ts|tsx)$/u.test(file)) continue;
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const target = path.resolve(path.dirname(file), match[1]);
      const isFile = await stat(target).then((info) => info.isFile(), () => false);
      if (isFile) pending.push(target);
    }
  }
  return [...seen].map((file) => path.relative(repoRoot, file).split(path.sep).join("/")).sort();
}

test("every file a skippable lane's JS tests import stays outside that lane's neutral sets", async () => {
  // `pnpm --dir electron/native/grimodex-node test` runs node --test over the
  // native test directory (and main-pipeline-specs spawns the pipeline specs);
  // those import scripts/quality/run-nir1-retrieval.mjs and, through
  // electron/scripts, scripts/local-ci*.mjs, which the CI-assets set would
  // otherwise make skippable. Follow static relative imports from each lane's
  // test entries so a new import of a neutral path fails here instead of
  // silently skipping the lane. (electron/** is forced all and is skipped.)
  const laneEntries = {
    native: [
      ...(await listFiles("electron/native/grimodex-node/test", /\.(?:mjs|js|ts)$/u)),
      ...(await listFiles("electron/main", /\.pipeline\.spec\.ts$/u)),
    ],
    windows: await listFiles("electron", /^(?:main|preload|shared)\/.*\.test\.ts$/u),
    migration: [
      "electron/shared/ipcContract.test.ts",
      "src/features/workspace/store.test.ts",
      "src/features/workspace/recovery/RecoveryShell.test.tsx",
    ].map((file) => path.join(repoRoot, file)),
    browser: await listFiles("src", /\.browser\.test\.tsx?$/u),
  };
  for (const [lane, entries] of Object.entries(laneEntries)) {
    assert.ok(entries.length > 0, `${lane} must have test entries`);
    const closure = await importClosure(entries);
    if (lane === "native") {
      assert.ok(closure.includes("scripts/quality/run-nir1-retrieval.mjs"), "the walk must reach the retrieval harness");
      assert.ok(closure.includes("scripts/local-ci-xvfb.mjs"), "the walk must reach the local CI helpers");
    }
    for (const file of closure) {
      if (file.startsWith("electron/")) continue;
      assert.equal(lanesFor([file])[lane], true, `${lane}: ${file}`);
      assert.equal(lanesFor(["docs/a.md", file])[lane], true, `${lane}: docs + ${file}`);
    }
  }
  // Control: other scripts/quality files are still neutral for native.
  assert.equal(lanesFor(["scripts/quality/validate-run-kind-policy.mjs"]).native, false);
  assert.equal(lanesFor(["scripts/local-ci-registry.json"]).native, true);
});

test("a root markdown file the Windows installer packages keeps the windows lane", () => {
  assert.deepEqual(lanesFor(["LICENSING.md"]), only(["windows"]));
  assert.equal(lanesFor(["README.md"]).windows, false);
});

// ---------------------------------------------------------------------------
// Deny by default: doubt runs everything.
// ---------------------------------------------------------------------------

test("an empty, incomplete or unclassifiable diff runs every lane", () => {
  assert.deepEqual(lanesFor([]), ALL_RUN);
  assert.deepEqual(lanesFor(["docs/a.md"], { incompleteReason: "Base ref unavailable" }), ALL_RUN);
  assert.deepEqual(lanesFor(["docs/a.md"], { incompleteReason: " " }), lanesFor(["docs/a.md"]));
  for (const unsafe of ["docs/../src/a.ts", "/etc/passwd", "docs//a.md", "docs/./a.md", ""]) {
    assert.deepEqual(lanesFor(["README.md", unsafe]), ALL_RUN, JSON.stringify(unsafe));
  }
  const empty = decideScope({ rules, changedPaths: [] });
  assert.equal(empty.reasonKind, "empty-diff");
  assert.equal(decideScope({ rules, changedPaths: ["docs/a.md"], incompleteReason: "x" }).reasonKind, "incomplete-diff");
});

test("every event except pull_request runs every lane without looking at the diff", async () => {
  const collect = async () => {
    throw new Error("a non-pull_request event must not collect a diff");
  };
  for (const event of ["push", "schedule", "workflow_dispatch", "workflow_call", "", undefined, "pull_request_target"]) {
    const decision = await decideForEvent({ rules, event, base: "a".repeat(40), head: "b".repeat(40), collect });
    assert.equal(formatOutputs(rules, decision), `${LANES.map((lane) => `${lane}=true`).join("\n")}\n`, String(event));
    assert.equal(decision.reasonKind, "not-pull-request");
  }
});

test("a pull request with a missing base, an incomplete diff or a failing git runs every lane", async () => {
  const sha = "a".repeat(40);
  const docsOnly = async () => ({ paths: ["docs/a.md"], complete: true, reason: "Complete Git diff." });
  const run = async (options) => {
    const decision = await decideForEvent({ rules, event: "pull_request", ...options });
    return Object.fromEntries(LANES.map((lane) => [lane, decision.lanes[lane].run]));
  };
  // Control: a complete docs-only diff does skip.
  assert.deepEqual(await run({ base: sha, head: sha, collect: docsOnly }), only([]));
  assert.deepEqual(await run({ head: sha, collect: docsOnly }), ALL_RUN);
  assert.deepEqual(await run({ base: sha, collect: docsOnly }), ALL_RUN);
  assert.deepEqual(await run({ base: " ", head: sha, collect: docsOnly }), ALL_RUN);
  assert.deepEqual(
    await run({
      base: sha,
      head: sha,
      collect: async () => ({ paths: ["docs/a.md"], complete: false, reason: "Git diff incomplete: boom" }),
    }),
    ALL_RUN,
  );
  assert.deepEqual(
    await run({ base: sha, head: sha, collect: async () => { throw new Error("git exploded"); } }),
    ALL_RUN,
  );
  assert.deepEqual(await run({ base: sha, head: sha, collect: async () => ({ paths: [], complete: true }) }), ALL_RUN);
});

test("rule files that cannot be trusted are rejected instead of guessed at", async () => {
  const { compileScopeRules } = await import("./ci-change-scope.mjs");
  const clone = () => structuredClone(rawRules);
  const broken = [
    (rules) => { rules.version = 2; },
    (rules) => { rules.forceAll = []; },
    (rules) => { rules.lanes.rust.neutral = ["missing-set"]; },
    (rules) => { rules.lanes.rust.mode = "guess"; },
    (rules) => { rules.lanes.Rust = rules.lanes.rust; delete rules.lanes.rust; },
    (rules) => { delete rules.lanes.rust.gatedJobs; },
    (rules) => { rules.sets.docs = ["docs/{a,b}/**"]; },
    (rules) => { rules.lanes.lfm.triggers = []; },
  ];
  for (const mutate of broken) {
    const candidate = clone();
    mutate(candidate);
    assert.throws(() => compileScopeRules(candidate));
  }
  assert.doesNotThrow(() => compileScopeRules(clone()));
});

// ---------------------------------------------------------------------------
// The wrapped `if` expressions behave like the originals except on a skip.
// ---------------------------------------------------------------------------

const EVENTS = ["push", "schedule", "workflow_dispatch", "workflow_call", "pull_request"];
const defaultsFromDispatch = Object.fromEntries(
  Object.entries(ci.on.workflow_dispatch.inputs).map(([name, input]) => [name, input.default ?? ""]),
);
const INPUT_SETS = [
  defaultsFromDispatch,
  { product_journey_mode: "all" },
  { ...defaultsFromDispatch, independent_gates: true },
  { ...defaultsFromDispatch, source_focused: true },
  { ...defaultsFromDispatch, source_canonical_contracts: true },
  { ...defaultsFromDispatch, canonical_profile: "shared-rust" },
  { ...defaultsFromDispatch, canonical_profile: "c-query-workers" },
  { ...defaultsFromDispatch, canonical_profile: "migration-remaining" },
  { ...defaultsFromDispatch, canonical_profile: "native-development-tests" },
  { ...defaultsFromDispatch, canonical_profile: "quick" },
  { ...defaultsFromDispatch, canonical_profile: "os-check" },
  { ...defaultsFromDispatch, candidate_head: "b".repeat(40) },
  { ...defaultsFromDispatch, max_parallel_tasks: "4" },
];
const ALL_TRUE_OUTPUTS = Object.fromEntries(LANES.map((lane) => [lane, "true"]));
const originalOf = (id) => stripScopeGate(ci.jobs[id].if).original;
const admitted = (inputs, event, changes) =>
  Object.keys(ci.jobs).filter((id) => evaluateIf(ci.jobs[id].if, { inputs, event, changes }));
const admittedOriginals = (inputs, event) =>
  Object.keys(ci.jobs).filter((id) => evaluateIf(originalOf(id), { inputs, event }));

test("with empty or all-true change scope outputs every job is admitted exactly as before the gate", () => {
  for (const event of EVENTS) {
    for (const inputs of INPUT_SETS) {
      const expected = admittedOriginals(inputs, event);
      const label = `${event} ${JSON.stringify(inputs)}`;
      // Empty outputs model a skipped, failed or cancelled-before-output `changes`.
      assert.deepEqual(admitted(inputs, event, {}), expected, `empty outputs: ${label}`);
      assert.deepEqual(admitted(inputs, event, ALL_TRUE_OUTPUTS), expected, `true outputs: ${label}`);
      // Anything other than the exact string 'false' also runs the job.
      for (const odd of ["", "TRUE", "0", "no", " false", "False "]) {
        assert.deepEqual(
          admitted(inputs, event, Object.fromEntries(LANES.map((lane) => [lane, odd]))),
          expected,
          `output ${JSON.stringify(odd)}: ${label}`,
        );
      }
    }
  }
});

test("whenever a journey root is admitted, the changes job is admitted too", () => {
  const roots = rawRules.lanes.journeys.gatedJobs;
  for (const event of EVENTS) {
    for (const inputs of INPUT_SETS) {
      const running = admitted(inputs, event, {});
      if (roots.some((id) => running.includes(id))) {
        assert.ok(running.includes("changes"), `${event} ${JSON.stringify(inputs)}`);
      }
    }
  }
});

test("a false lane output drops exactly that lane's gated jobs and nothing else", () => {
  const inputs = defaultsFromDispatch;
  const baseline = admittedOriginals(inputs, "pull_request");
  assert.ok(baseline.includes("changes"));
  for (const [lane, definition] of Object.entries(rawRules.lanes)) {
    const dropped = admitted(inputs, "pull_request", { ...ALL_TRUE_OUTPUTS, [lane]: "false" });
    assert.deepEqual(
      baseline.filter((id) => !dropped.includes(id)).sort(),
      [...definition.gatedJobs].sort(),
      lane,
    );
    assert.deepEqual(dropped.filter((id) => !baseline.includes(id)), [], lane);
  }
  // Every lane false: only the always-run jobs, the cascade jobs (which skip
  // through needs on GitHub, outside this evaluator) and `changes` remain.
  const noLanes = admitted(inputs, "pull_request", Object.fromEntries(LANES.map((lane) => [lane, "false"])));
  const cascadeJobs = Object.values(rawRules.lanes).flatMap((definition) => definition.cascadeJobs ?? []);
  assert.deepEqual(
    [...noLanes].sort(),
    [...ALWAYS_RUN_JOBS, "changes", ...cascadeJobs].sort(),
  );
});

test("a false output never reaches a standalone canonical profile or an independent gates run", () => {
  // `changes` is skipped for these, so its outputs are empty and the selected
  // jobs must still run (and `!cancelled()` keeps them from being skipped).
  const standalone = { ...defaultsFromDispatch, canonical_profile: "shared-rust" };
  assert.deepEqual(admitted(standalone, "workflow_dispatch", {}), ["rust"]);
  const independent = admitted({ ...defaultsFromDispatch, independent_gates: true }, "workflow_dispatch", {});
  assert.ok(independent.includes("browser") && independent.includes("nir1-c-query-worker"));
  assert.ok(!independent.includes("changes"));
  assert.ok(!admitted(standalone, "workflow_dispatch", {}).includes("changes"));
});

test("Gate B2 required jobs run on every push and manual dispatch", async () => {
  const gate = yaml.load(await readFile(path.join(repoRoot, "evals/certifications/gate-b2.yaml"), "utf8"));
  const required = gate.fullCi.requiredJobs;
  assert.equal(required.length, 7);
  const idByName = new Map(Object.entries(ci.jobs).map(([id, definition]) => [definition.name, id]));
  const ids = required.map((name) => {
    assert.ok(idByName.has(name), `${name} must remain a job name`);
    return idByName.get(name);
  });
  const pushDecision = await decideForEvent({ rules, event: "push", base: "a".repeat(40), head: "b".repeat(40) });
  const pushOutputs = Object.fromEntries(LANES.map((lane) => [lane, pushDecision.lanes[lane].run ? "true" : "false"]));
  for (const event of gate.fullCi.acceptedEvents) {
    for (const changes of [{}, pushOutputs, ALL_TRUE_OUTPUTS]) {
      const running = admitted(defaultsFromDispatch, event, changes);
      for (const id of ids) assert.ok(running.includes(id), `${event}: ${id}`);
    }
  }
  // The aggregate is only skipped through its roots, which push never skips.
  assert.ok(ids.includes("electron-product-journeys-aggregate"));
});

// ---------------------------------------------------------------------------
// The workflow step and the CLI, end to end against real git repositories.
// ---------------------------------------------------------------------------

const scopeStep = ci.jobs.changes.steps.find(({ id }) => id === "scope");
const git = (cwd, ...args) =>
  execute("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });

async function makeRepository(root, baseFiles, headFiles) {
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-q");
  const write = async (files) => {
    for (const [relative, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(repo, relative)), { recursive: true });
      await writeFile(path.join(repo, relative), content);
    }
  };
  await write(baseFiles);
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");
  const base = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
  await write(headFiles);
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "head");
  const head = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
  return { repo, base, head };
}

async function runScopeStep({ root, repo, event, base, head, command }) {
  const files = {
    output: path.join(root, "github-output"),
    summary: path.join(root, "github-summary"),
    temp: path.join(root, "runner-temp"),
  };
  await mkdir(files.temp, { recursive: true });
  await writeFile(files.output, "");
  await writeFile(files.summary, "");
  const original = "node scripts/ci-change-scope.mjs";
  assert.ok(scopeStep.run.includes(original));
  const script = scopeStep.run.replace(original, command ?? `"${process.execPath}" "${scriptPath}"`);
  await execute("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
    cwd: repo ?? root,
    timeout: 60_000,
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: event,
      BASE_SHA: base ?? "",
      HEAD_SHA: head ?? "",
      GITHUB_OUTPUT: files.output,
      GITHUB_STEP_SUMMARY: files.summary,
      RUNNER_TEMP: files.temp,
    },
  });
  const outputs = Object.fromEntries(
    (await readFile(files.output, "utf8")).split("\n").filter(Boolean).map((line) => line.split("=")),
  );
  return { outputs, files, summary: await readFile(files.summary, "utf8") };
}

async function withTemp(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "ci-change-scope-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const asBooleans = (outputs) => Object.fromEntries(LANES.map((lane) => [lane, outputs[lane]]));
const ALL_TRUE_STRINGS = Object.fromEntries(LANES.map((lane) => [lane, "true"]));

test("the workflow step skips lanes for a real docs-only pull request diff and records evidence", async () => {
  await withTemp(async (root) => {
    const { repo, base, head } = await makeRepository(
      root,
      { "docs/a.md": "one\n", "src/a.ts": "export {};\n" },
      { "docs/a.md": "two\n", "README.md": "readme\n" },
    );
    const result = await runScopeStep({ root, repo, event: "pull_request", base, head });
    assert.deepEqual(asBooleans(result.outputs), Object.fromEntries(LANES.map((lane) => [lane, "false"])));
    assert.match(result.summary, /skipped/u);
    assert.match(result.summary, /not a pass/u);
    const record = JSON.parse(await readFile(path.join(result.files.temp, "ci-change-scope.json"), "utf8"));
    assert.equal(record.changedPathCount, 2);
    assert.deepEqual(record.changedPaths, ["README.md", "docs/a.md"]);
    assert.equal(record.lanes.rust.run, false);
    assert.equal(record.reasonKind, "classified");
    // The evidence lives outside the checkout so it can never become a changed path.
    await assert.rejects(access(path.join(repo, "ci-change-scope.json")));
  });
});

test("the workflow step runs every lane for a source change, but still skips lfm", async () => {
  await withTemp(async (root) => {
    const { repo, base, head } = await makeRepository(
      root,
      { "docs/a.md": "one\n", "src/a.ts": "export {};\n" },
      { "src/a.ts": "export const a = 1;\n" },
    );
    const result = await runScopeStep({ root, repo, event: "pull_request", base, head });
    assert.deepEqual(asBooleans(result.outputs), { ...ALL_TRUE_STRINGS, lfm: "false" });
  });
});

test("the workflow step runs every lane for push, schedule, dispatch and call without a checkout", async () => {
  for (const event of ["push", "schedule", "workflow_dispatch", "workflow_call"]) {
    await withTemp(async (root) => {
      // No repository, no base/head and (via the failing command) no usable node.
      const result = await runScopeStep({ root, event, command: "false" });
      assert.deepEqual(asBooleans(result.outputs), ALL_TRUE_STRINGS, event);
      assert.equal(Object.keys(result.outputs).length, LANES.length);
      await assert.rejects(access(path.join(result.files.temp, "ci-change-scope.json")));
    });
  }
});

test("the workflow step falls back to every lane when the script or its output is unusable", async () => {
  await withTemp(async (root) => {
    const { repo, base, head } = await makeRepository(root, { "docs/a.md": "one\n" }, { "docs/a.md": "two\n" });
    const sha = "0".repeat(40);
    const lanesOutput = (lines) => `printf '${lines.join("\\n")}\\n'`;
    const allFalse = LANES.map((lane) => `${lane}=false`);
    const attempts = {
      "unknown base": { command: undefined, base: sha, head },
      "unknown head": { command: undefined, base, head: sha },
      "missing base": { command: undefined, base: "", head },
      "script exits 1": { command: "false" },
      "script missing": { command: `"${process.execPath}" "${path.join(root, "no-such-script.mjs")}"` },
      "no output": { command: "true" },
      "partial output": { command: lanesOutput(allFalse.slice(0, 3)) },
      "unknown value": { command: lanesOutput(allFalse.map((line, index) => (index === 0 ? "journeys=maybe" : line))) },
      "extra line": { command: lanesOutput([...allFalse, "extra=false"]) },
      "duplicate lane": { command: lanesOutput([...allFalse.slice(0, 7), allFalse[0]]) },
      "garbage": { command: "echo 'journeys=false rust=false'" },
      "crash after output": { command: `${lanesOutput(allFalse)}; exit 3` },
    };
    for (const [label, attempt] of Object.entries(attempts)) {
      const result = await runScopeStep({
        root,
        repo,
        event: "pull_request",
        base: attempt.base ?? base,
        head: attempt.head ?? head,
        command: attempt.command,
      });
      assert.deepEqual(asBooleans(result.outputs), ALL_TRUE_STRINGS, label);
      assert.equal(Object.keys(result.outputs).length, LANES.length, label);
    }
    // Control: the same diff with the real script does skip, so the fallbacks above are what turned lanes on.
    const control = await runScopeStep({ root, repo, event: "pull_request", base, head });
    assert.deepEqual(asBooleans(control.outputs), Object.fromEntries(LANES.map((lane) => [lane, "false"])));
  });
});

test("the script prints only lane lines on stdout and exits nonzero when its rules cannot be loaded", async () => {
  await withTemp(async (root) => {
    const { repo, base, head } = await makeRepository(root, { "docs/a.md": "one\n" }, { ".github/workflows/x.yml": "a: 1\n" });
    const { stdout } = await execute(process.execPath, [scriptPath, "--event", "pull_request", "--base", base, "--head", head, "--repo", repo]);
    assert.equal(stdout, `${LANES.map((lane) => `${lane}=true`).join("\n")}\n`);
    const rulesPath = path.join(root, "bad-rules.json");
    await writeFile(rulesPath, "{\"version\":1}");
    await assert.rejects(
      execute(process.execPath, [scriptPath, "--rules", rulesPath, "--event", "push"]),
      (error) => error.stdout === "" && error.code === 1,
    );
    await assert.rejects(execute(process.execPath, [scriptPath, "--nonsense"]), (error) => error.stdout === "");
  });
});

test("unwrapIf and stripScopeGate round-trip the gate the workflow uses", () => {
  const original = "github.event_name != 'schedule' && !inputs.source_focused";
  const wrapped = `\${{ !cancelled() && (${original}) && needs.changes.outputs.browser != 'false' }}`;
  assert.deepEqual(stripScopeGate(wrapped), { gated: true, lane: "browser", original });
  assert.deepEqual(stripScopeGate(original), { gated: false, lane: undefined, original });
  assert.equal(unwrapIf(`\${{ ${original} }}`), original);
  assert.equal(evaluateIf(wrapped, { event: "pull_request", changes: { browser: "false" } }), false);
  assert.equal(evaluateIf(wrapped, { event: "pull_request", changes: {} }), true);
  assert.equal(evaluateIf(wrapped, { event: "schedule", changes: {} }), false);
});
