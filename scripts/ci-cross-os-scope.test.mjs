// The master-push decision for the C-query worker's macOS and Windows legs
// (scripts/ci-cross-os-scope.mjs and .json, the `crossos` step of the `changes`
// job and the worker job's matrix in .github/workflows/ci.yml). It is imported
// by scripts/ci-pause.test.mjs (verify:quality) and also runs on its own with
// `node --test scripts/ci-cross-os-scope.test.mjs`. It starts only git, bash and
// node child processes on temporary repositories: no cargo, pnpm or Electron.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import yaml from "js-yaml";

import {
  BASE_RULES_RELATIVE_PATH,
  collectPushPaths,
  compileCrossOsRules,
  decideForPush,
  formatOutput,
  loadBaseCrossOsRules,
  loadCrossOsRules,
} from "./ci-cross-os-scope.mjs";
import { compileGlob } from "./impact/core.mjs";

const execute = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts/ci-cross-os-scope.mjs");
const MASTER = "refs/heads/master";
const ZEROS = "0".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);

const ci = yaml.load(await readFile(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8"));
const rawRules = JSON.parse(await readFile(path.join(repoRoot, "scripts/ci-cross-os-scope.json"), "utf8"));
const rules = await loadCrossOsRules();
const rulesSource = await readFile(path.join(repoRoot, "scripts/ci-cross-os-scope.json"), "utf8");

const decide = (changedPaths, extra = {}) =>
  decideForPush({
    rules,
    event: "push",
    ref: MASTER,
    before: A,
    after: B,
    collect: async () => changedPaths,
    loadBaseRules: async () => rules,
    ...extra,
  });
const runsOf = async (changedPaths, extra) => (await decide(changedPaths, extra)).run;
const triggered = (candidate) => rules.triggers.matchers.some((matcher) => matcher.test(candidate));

// ---------------------------------------------------------------------------
// The rules file.
// ---------------------------------------------------------------------------

test("the rules compile and name the paths the worker is built from", () => {
  assert.equal(rawRules.version, 1);
  for (const required of [
    "src-tauri/crates/grimodex-db/**",
    "src-tauri/crates/grimodex-core/**",
    "**/Cargo.toml",
    "**/Cargo.lock",
    ".cargo/**",
    // Windows checks out with the text attributes: a change reaches fixture bytes and the shell script.
    ".gitattributes",
    "scripts/nir1-c-query-worker-ci.sh",
    "scripts/ci-cross-os-scope.*",
    "scripts/impact/**",
    ".github/workflows/**",
    "evals/nir1-capacity/**",
  ]) {
    assert.ok(rawRules.triggers.includes(required), required);
  }
  assert.equal(new Set(rawRules.triggers).size, rawRules.triggers.length, "no duplicate trigger");
  assert.ok(rules.triggers.matchers.length === rawRules.triggers.length);
  assert.throws(() => compileCrossOsRules({ version: 2, triggers: ["a"] }));
  assert.throws(() => compileCrossOsRules({ version: 1, triggers: [] }));
  assert.throws(() => compileCrossOsRules({ version: 1, triggers: ["a", ""] }));
  assert.throws(() => compileCrossOsRules({ version: 1, triggers: ["a/{b,c}"] }));
  assert.throws(() => compileCrossOsRules(null));
});

test("every trigger fires for a representative path", () => {
  const sample = (glob) => glob.replaceAll("**", "sample/x").replaceAll("*", "x");
  for (const glob of rawRules.triggers) {
    const candidate = glob.startsWith("**/") ? glob.slice(3) : sample(glob);
    assert.ok(compileGlob(glob).test(candidate), `${glob} must match ${candidate}`);
    assert.ok(triggered(candidate), candidate);
  }
  assert.ok(triggered("Cargo.toml") && triggered("src-tauri/Cargo.lock"));
  assert.ok(triggered("src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_graph/c_query_worker.rs"));
  assert.ok(triggered(".gitattributes"));
});

// ---------------------------------------------------------------------------
// The decision.
// ---------------------------------------------------------------------------

test("paths no worker input reaches skip the macOS and Windows legs", async () => {
  for (const changedPaths of [
    ["docs/local-ci-runner.md"],
    ["README.md", "docs/a.md", "public/RELEASE_NOTES/a.md"],
    ["src/features/x.ts"],
    ["electron/main/index.ts"],
    ["src-tauri/crates/grimodex-ai/src/lib.rs"],
    ["src-tauri/src/lib.rs"],
    ["scripts/quality/nir1-retrieval/contract.mjs", ".agents/skills/x/SKILL.md"],
  ]) {
    const result = await decide(changedPaths);
    assert.equal(result.run, false, changedPaths.join(","));
    assert.equal(result.reasonKind, "no-trigger");
    assert.equal(formatOutput(result), "cquery_cross_os=false\n");
  }
});

test("one worker path in a mixed push runs the legs, whatever else changed", async () => {
  for (const hit of [
    "src-tauri/crates/grimodex-db/src/lib.rs",
    "src-tauri/crates/grimodex-core/src/lib.rs",
    "src-tauri/Cargo.lock",
    "src-tauri/crates/grimodex-db/Cargo.toml",
    ".cargo/config.toml",
    ".gitattributes",
    "scripts/nir1-c-query-worker-ci.sh",
    "scripts/ci-cross-os-scope.json",
    "scripts/ci-cross-os-scope.mjs",
    "scripts/impact/core.mjs",
    ".github/workflows/ci.yml",
    "evals/nir1-capacity/manifest.v1.json",
    "src/db/generated/schema-contract.json",
    "src-tauri/resources/sample_project/v2.sql",
  ]) {
    for (const changedPaths of [[hit], ["docs/a.md", hit], [hit, "src/a.ts", "docs/b.md"]]) {
      const result = await decide(changedPaths);
      assert.equal(result.run, true, changedPaths.join(","));
      assert.equal(result.reasonKind, "trigger");
      assert.deepEqual(result.hits, [hit]);
      assert.equal(formatOutput(result), "cquery_cross_os=true\n");
    }
  }
});

test("an empty, unsafe or unreadable diff runs the legs", async () => {
  assert.equal((await decide([])).reasonKind, "empty-diff");
  for (const unsafe of ["docs/../src/a.ts", "/etc/passwd", "docs//a.md", "docs/./a.md"]) {
    const result = await decide(["docs/a.md", unsafe]);
    assert.equal(result.run, true, unsafe);
    assert.equal(result.reasonKind, "unsafe-path", unsafe);
  }
  const failing = await decide(["docs/a.md"], { collect: async () => { throw new Error("git exploded"); } });
  assert.equal(failing.run, true);
  assert.equal(failing.reasonKind, "error");
  const rulesFailing = await decide(["docs/a.md"], { loadBaseRules: async () => { throw new Error("rules broken"); } });
  assert.equal(rulesFailing.run, true);
  assert.equal(rulesFailing.reasonKind, "error");
});

test("any event, ref or commit id that is not a master push with two real commits runs the legs without a diff", async () => {
  const collect = async () => {
    throw new Error("the diff must not be collected");
  };
  const docs = async (extra) => {
    const calls = [];
    const result = await decideForPush({
      rules,
      event: "push",
      ref: MASTER,
      before: A,
      after: B,
      repoRoot,
      collect: async (...args) => {
        calls.push(args);
        return ["docs/a.md"];
      },
      loadBaseRules: async () => rules,
      ...extra,
    });
    return { result, calls: calls.length };
  };
  // Control: the same inputs with a docs-only diff skip.
  assert.equal((await docs()).result.run, false);
  for (const extra of [
    { event: "pull_request" },
    { event: "schedule" },
    { event: "workflow_dispatch" },
    { event: "workflow_call" },
    { event: "" },
    { event: undefined },
    { ref: "refs/heads/feature" },
    { ref: "refs/heads/master2" },
    { ref: "refs/tags/v1.0.0" },
    { ref: "" },
    { ref: undefined },
    { before: ZEROS },
    { before: "0".repeat(64) },
    { before: "" },
    { before: undefined },
    { after: "" },
    { before: "abc" },
    { before: "A".repeat(40) },
    { before: `${"a".repeat(39)}g` },
    { before: "-".repeat(40) },
    { after: "not-a-sha" },
  ]) {
    const { result } = await docs({ ...extra, collect });
    assert.equal(result.run, true, JSON.stringify(extra));
  }
  // The non-push and non-master cases never touch git.
  for (const extra of [{ event: "schedule" }, { ref: "refs/tags/v1" }, { before: ZEROS }, { before: "abc" }]) {
    assert.equal((await docs({ ...extra })).calls, 0, JSON.stringify(extra));
  }
});

test("the before commit's copy of the rules also runs the legs, so a push cannot skip them by editing the trigger list", async () => {
  const withoutDb = structuredClone(rawRules);
  withoutDb.triggers = withoutDb.triggers.filter((entry) => !entry.startsWith("src-tauri/crates/grimodex-db"));
  const weak = compileCrossOsRules(withoutDb);
  const dbFile = "src-tauri/crates/grimodex-db/src/lib.rs";
  // Control: the weakened head rules alone would skip the db change.
  assert.equal((await decideForPush({ rules: weak, event: "push", ref: MASTER, before: A, after: B, collect: async () => [dbFile], loadBaseRules: async () => weak })).run, false);
  // The before commit's rules still have the trigger.
  const result = await decideForPush({ rules: weak, event: "push", ref: MASTER, before: A, after: B, collect: async () => [dbFile], loadBaseRules: async () => rules });
  assert.equal(result.run, true);
  assert.equal(result.baseRules, "combined");
  // The before commit has no rules (the first push): the legs run.
  const absent = await decide(["docs/a.md"], { loadBaseRules: async () => null });
  assert.equal(absent.run, true);
  assert.equal(absent.reasonKind, "no-base-rules");
});

// ---------------------------------------------------------------------------
// Against real git history.
// ---------------------------------------------------------------------------

const git = (cwd, ...args) =>
  execute("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });

async function withTemp(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "ci-cross-os-scope-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A repository on `master` whose first commit already has the real rules file. */
async function newHistory(root, { withRules = true } = {}) {
  const repo = path.join(root, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "master");
  const commit = async (files, message, removed = []) => {
    for (const [relative, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(repo, relative)), { recursive: true });
      await writeFile(path.join(repo, relative), content);
    }
    for (const relative of removed) await rm(path.join(repo, relative), { force: true });
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", message);
    return (await git(repo, "rev-parse", "HEAD")).stdout.trim();
  };
  const seed = {
    "docs/a.md": "one\n",
    "src/a.ts": "export {};\n",
    "scripts/ci-cross-os-scope.mjs": "// stand-in\n",
    "scripts/impact/core.mjs": "// stand-in\n",
    ".github/workflows/x.yml": "a: 1\n",
    ...(withRules ? { [BASE_RULES_RELATIVE_PATH]: rulesSource } : {}),
  };
  const base = await commit(seed, "base");
  return { repo, commit, base };
}

const longBody = "export const value = 'long enough for git to see the same file after a move';\n".repeat(20);

test("a docs-only master push skips the legs and a worker push runs them, against real commits", async () => {
  await withTemp(async (root) => {
    const { repo, commit, base } = await newHistory(root);
    const docs = await commit({ "docs/a.md": "two\n", "src/a.ts": "export const a = 1;\n" }, "docs and src");
    const skipped = await decideForPush({ rules, event: "push", ref: MASTER, before: base, after: docs, repoRoot: repo });
    assert.equal(skipped.run, false);
    assert.deepEqual(skipped.changedPaths, ["docs/a.md", "src/a.ts"]);
    assert.equal(skipped.baseRules, "combined");

    const db = await commit({ "src-tauri/crates/grimodex-db/src/lib.rs": "pub fn a() {}\n" }, "db");
    const ran = await decideForPush({ rules, event: "push", ref: MASTER, before: docs, after: db, repoRoot: repo });
    assert.equal(ran.run, true);
    assert.deepEqual(ran.hits, ["src-tauri/crates/grimodex-db/src/lib.rs"]);

    // A rebase merge pushes several commits at once: before..after holds all of them.
    const first = await commit({ "docs/a.md": "three\n" }, "docs");
    const second = await commit({ ".cargo/config.toml": "[env]\n" }, "cargo config");
    const third = await commit({ "docs/a.md": "four\n" }, "docs again");
    const range = await decideForPush({ rules, event: "push", ref: MASTER, before: db, after: third, repoRoot: repo });
    assert.equal(range.run, true);
    assert.deepEqual(range.hits, [".cargo/config.toml"]);
    // Control: each commit alone, the middle one is the one that matters.
    assert.equal((await decideForPush({ rules, event: "push", ref: MASTER, before: db, after: first, repoRoot: repo })).run, false);
    assert.equal((await decideForPush({ rules, event: "push", ref: MASTER, before: first, after: second, repoRoot: repo })).run, true);
    assert.equal((await decideForPush({ rules, event: "push", ref: MASTER, before: second, after: third, repoRoot: repo })).run, false);
  });
});

test("an unresolvable before commit, an all-zero before and an identical before and after run the legs", async () => {
  await withTemp(async (root) => {
    const { repo, commit, base } = await newHistory(root);
    const docs = await commit({ "docs/a.md": "two\n" }, "docs");
    const run = (before, after) => decideForPush({ rules, event: "push", ref: MASTER, before, after, repoRoot: repo });
    assert.equal((await run(base, docs)).run, false, "control");
    // A force push leaves a `before` that the clone no longer has.
    const missing = await run("c".repeat(40), docs);
    assert.equal(missing.run, true);
    assert.equal(missing.reasonKind, "error");
    assert.equal((await run(ZEROS, docs)).reasonKind, "no-before");
    assert.equal((await run(base, "d".repeat(40))).run, true);
    // A tree that did not change (an empty diff) is not a docs change.
    assert.equal((await run(docs, docs)).reasonKind, "empty-diff");
    // Not a git repository at all.
    const notRepo = path.join(root, "plain");
    await mkdir(notRepo, { recursive: true });
    assert.equal((await decideForPush({ rules, event: "push", ref: MASTER, before: base, after: docs, repoRoot: notRepo })).run, true);
  });
});

test("a rename counts both its old and its new path", async () => {
  await withTemp(async (root) => {
    const { repo, commit, base } = await newHistory(root);
    const seeded = await commit({ "docs/a.ts": longBody, "src-tauri/crates/grimodex-db/src/m.rs": longBody.replace("value", "other") }, "seed");
    // Out of the worker's crate: the old side is the trigger.
    await git(repo, "mv", "src-tauri/crates/grimodex-db/src/m.rs", "docs/m.rs");
    const out = await commit({}, "move out of the crate");
    // Control: git reports one rename, not an add and a delete.
    assert.match((await git(repo, "diff", "--name-status", "--find-renames", seeded, out)).stdout, /^R\d+\t/u);
    const outDecision = await decideForPush({ rules, event: "push", ref: MASTER, before: seeded, after: out, repoRoot: repo });
    assert.equal(outDecision.run, true);
    assert.deepEqual(outDecision.changedPaths, ["docs/m.rs", "src-tauri/crates/grimodex-db/src/m.rs"]);
    // Into the crate: the new side is the trigger.
    await git(repo, "mv", "docs/a.ts", "src-tauri/crates/grimodex-db/src/a.rs");
    const into = await commit({}, "move into the crate");
    assert.equal((await decideForPush({ rules, event: "push", ref: MASTER, before: out, after: into, repoRoot: repo })).run, true);
    // Within docs: neither side is a trigger.
    await git(repo, "mv", "docs/m.rs", "docs/n.rs");
    const inside = await commit({}, "rename in docs");
    assert.equal((await decideForPush({ rules, event: "push", ref: MASTER, before: into, after: inside, repoRoot: repo })).run, false);
    void base;
  });
});

test("collectPushPaths is a two-point diff with every side of a rename", async () => {
  await withTemp(async (root) => {
    const { repo, commit } = await newHistory(root);
    const before = await commit({ "docs/b.ts": longBody }, "add");
    await git(repo, "mv", "docs/b.ts", "docs/c.ts");
    const head = await commit({ "docs/new file.md": "x\n" }, "rename and add a name with a space");
    assert.deepEqual(
      (await collectPushPaths({ repoRoot: repo, before, after: head })).sort(),
      ["docs/b.ts", "docs/c.ts", "docs/new file.md"].sort(),
    );
    await assert.rejects(collectPushPaths({ repoRoot: repo, before: "e".repeat(40), after: head }));
  });
});

test("the before commit's rules file is read from its tree, and only a plain file counts", async () => {
  await withTemp(async (root) => {
    const { repo, commit, base } = await newHistory(root);
    const loaded = await loadBaseCrossOsRules({ repoRoot: repo, before: base });
    assert.deepEqual(loaded.triggers.patterns, rawRules.triggers);
    // A later edit does not change what the earlier commit says.
    const edited = await commit({ [BASE_RULES_RELATIVE_PATH]: JSON.stringify({ version: 1, triggers: ["only/**"] }) }, "weaken");
    assert.deepEqual((await loadBaseCrossOsRules({ repoRoot: repo, before: edited })).triggers.patterns, ["only/**"]);
    assert.deepEqual((await loadBaseCrossOsRules({ repoRoot: repo, before: base })).triggers.patterns, rawRules.triggers);
    // Broken JSON and invalid rules throw (the caller then runs the legs).
    const broken = await commit({ [BASE_RULES_RELATIVE_PATH]: "{not json" }, "broken");
    await assert.rejects(loadBaseCrossOsRules({ repoRoot: repo, before: broken }));
    const invalid = await commit({ [BASE_RULES_RELATIVE_PATH]: JSON.stringify({ version: 1, triggers: [] }) }, "invalid");
    await assert.rejects(loadBaseCrossOsRules({ repoRoot: repo, before: invalid }));
    await assert.rejects(loadBaseCrossOsRules({ repoRoot: repo, before: "not-a-commit" }));
    // A commit without the file resolves to null.
    const fresh = await newHistory(path.join(root, "second"), { withRules: false });
    assert.equal(await loadBaseCrossOsRules({ repoRoot: fresh.repo, before: fresh.base }), null);
  });
});

// ---------------------------------------------------------------------------
// The CLI: one stdout line, and nothing on stdout when the rules are unreadable.
// ---------------------------------------------------------------------------

test("the CLI prints exactly one cquery_cross_os line, writes the summary, and prints nothing when it cannot decide", async () => {
  await withTemp(async (root) => {
    const { repo, commit, base } = await newHistory(root);
    const docs = await commit({ "docs/a.md": "two\n" }, "docs");
    const db = await commit({ "src-tauri/crates/grimodex-db/src/lib.rs": "pub fn a() {}\n" }, "db");
    const summary = path.join(root, "summary.md");
    await writeFile(summary, "");
    const cli = (...args) => execute(process.execPath, [scriptPath, "--repo", repo, "--event", "push", "--ref", MASTER, ...args]);
    const skipped = await cli("--before", base, "--after", docs, "--summary", summary);
    assert.equal(skipped.stdout, "cquery_cross_os=false\n");
    const ran = await cli("--before", docs, "--after", db, "--summary", summary);
    assert.equal(ran.stdout, "cquery_cross_os=true\n");
    const text = await readFile(summary, "utf8");
    assert.match(text, /macOS and Windows are not verified by it/u);
    assert.match(text, /not a pass/u);
    assert.match(text, /grimodex-db\/src\/lib\.rs/u);
    // Rules that cannot be read: a non-zero exit and an empty stdout.
    await assert.rejects(
      execute(process.execPath, [scriptPath, "--rules", path.join(root, "missing.json"), "--event", "push"]),
      (error) => error.stdout === "" && error.code === 1,
    );
    await assert.rejects(execute(process.execPath, [scriptPath, "--nonsense"]), (error) => error.stdout === "");
    // No arguments at all is not a master push: the legs run.
    const bare = await execute(process.execPath, [scriptPath, "--repo", repo]);
    assert.equal(bare.stdout, "cquery_cross_os=true\n");
  });
});

// ---------------------------------------------------------------------------
// What the rules cover: derived from the two crates, not listed by hand.
// ---------------------------------------------------------------------------

async function listFiles(directory, pattern) {
  const found = [];
  for (const entry of await readdir(path.join(repoRoot, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await listFiles(relative, pattern)));
    else if (pattern.test(entry.name)) found.push(relative);
  }
  return found;
}

/** A regular file of the checkout (no git needed, so a missing `.git` or an unstaged file cannot hide one). */
const isFile = (relative) => stat(path.join(repoRoot, relative)).then((info) => info.isFile(), () => false);

const CRATES = ["src-tauri/crates/grimodex-db", "src-tauri/crates/grimodex-core"];
const insideACrate = (candidate) => CRATES.some((crate) => candidate === crate || candidate.startsWith(`${crate}/`));

test("every repository file the two crates include or address by a `../` path from outside themselves is a trigger, and so is every crate they depend on", async () => {
  // include_str!/include_bytes! (relative to the source file) and
  // `CARGO_MANIFEST_DIR` plus "/../..." or `.join("../...")` (relative to the crate). Files that a test names
  // without a `../` (`root.join("scripts/...")` in tests/) are not found here; the worker script runs only
  // `--lib` and `--bin` targets, which do not read them.
  const literal = /"(\/?(?:\.\.\/)+[^"\n]*)"/gu;
  const found = new Map();
  for (const crate of CRATES) {
    for (const file of await listFiles(crate, /\.rs$/u)) {
      const source = await readFile(path.join(repoRoot, file), "utf8");
      for (const match of source.matchAll(literal)) {
        const reference = match[1].replace(/^\//u, "");
        for (const base of [path.posix.dirname(file), crate]) {
          const resolved = path.posix.normalize(path.posix.join(base, reference));
          if (!insideACrate(resolved) && (await isFile(resolved))) found.set(resolved, file);
        }
      }
    }
  }
  // The derivation itself: these exist today and must keep being found.
  for (const expected of [
    "evals/nir1-capacity/manifest.v1.json",
    "src/db/generated/schema-contract.json",
    "scripts/schema-seed-ja.sql",
    "policies/narrative/narrative-dependency-role-registry.json",
    "src-tauri/resources/sample_project/v2.sql",
  ]) {
    assert.ok(found.has(expected), `the scan must find ${expected}`);
  }
  assert.ok(found.size >= 15, `only ${found.size} external files found`);
  const missing = [...found].filter(([candidate]) => !triggered(candidate)).map(([candidate, from]) => `${candidate} (read by ${from})`);
  assert.deepEqual(missing, [], "an external file the crates read is not a trigger");
  for (const candidate of found.keys()) {
    assert.equal(await runsOf(["docs/a.md", candidate]), true, candidate);
  }

  // Path dependencies of either crate (dependencies, dev-, build- and target-specific tables).
  const depended = new Set();
  for (const crate of CRATES) {
    const manifest = await readFile(path.join(repoRoot, crate, "Cargo.toml"), "utf8");
    for (const match of manifest.matchAll(/\bpath\s*=\s*"(\.\.[^"]*)"/gu)) {
      depended.add(path.posix.normalize(path.posix.join(crate, match[1])));
    }
  }
  assert.ok(depended.has("src-tauri/crates/grimodex-core"), "grimodex-db depends on grimodex-core by path");
  for (const crateDirectory of depended) {
    assert.ok(triggered(`${crateDirectory}/src/lib.rs`), `${crateDirectory} is a path dependency but not a trigger`);
  }
  // The workspace files are what lock the build.
  for (const candidate of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]) {
    assert.ok((await isFile(candidate)) && triggered(candidate), candidate);
  }
});

// ---------------------------------------------------------------------------
// The workflow: the `crossos` step, the worker's `if` and its matrix.
// ---------------------------------------------------------------------------

const changes = ci.jobs.changes;
const crossos = changes.steps.find(({ id }) => id === "crossos");
const worker = ci.jobs["nir1-c-query-worker"];

test("the changes job exposes the decision and keeps it last, separate from the lane step", () => {
  assert.equal(changes.outputs.cquery_cross_os, "${{ steps.crossos.outputs.cquery_cross_os }}");
  assert.equal(changes.steps.at(-1), crossos);
  assert.equal(crossos.if, "github.event_name == 'push' && github.ref == 'refs/heads/master'");
  assert.equal(crossos["continue-on-error"], true);
  assert.equal(crossos["timeout-minutes"], 1);
  assert.equal(crossos.shell, "bash");
  // The shell reads the event only from env; no expression is interpolated into the script.
  assert.deepEqual(crossos.env, {
    PUSH_REF: "${{ github.ref }}",
    BEFORE_SHA: "${{ github.event.before }}",
    AFTER_SHA: "${{ github.sha }}",
  });
  assert.doesNotMatch(crossos.run, /\$\{\{/u);
  assert.doesNotMatch(crossos.run, /\|\|\s*true/u);
  // The worker waits for `changes` (already pinned by the change-scope tests) and the scope step is untouched.
  assert.deepEqual(worker.needs, ["changes"]);
  // Checkout and Node are available to a master push (its diff needs the full history).
  const [checkout, setup] = changes.steps;
  for (const step of [checkout, setup]) {
    assert.match(step.if, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/master'/u);
  }
  assert.equal(checkout.with["fetch-depth"], 0);
});

test("the worker job runs on the nightly schedule, and its matrix follows the decision", () => {
  assert.doesNotMatch(worker.if, /github\.event_name != 'schedule'/u);
  assert.match(worker.if, /needs\.changes\.outputs\.rust != 'false'/u);
  assert.match(worker.strategy.matrix.os, /needs\.changes\.outputs\.cquery_cross_os == 'false'/u);
  // Only an exact 'false' is read; the expression names no other output and no event but schedule and pull_request.
  assert.deepEqual([...new Set(worker.strategy.matrix.os.match(/needs\.[\w.]+/gu))], ["needs.changes.outputs.cquery_cross_os"]);
  assert.deepEqual([...new Set(worker.strategy.matrix.os.match(/github\.event_name == '[a-z_]+'/gu))].sort(), [
    "github.event_name == 'pull_request'",
    "github.event_name == 'schedule'",
  ]);
});

/** Runs the real `crossos` step in `repo`, with the decision command replaced by `command` when given. */
async function runCrossosStep({ root, repo, event = "push", ref = MASTER, before, after, command }) {
  const files = { output: path.join(root, "github-output"), summary: path.join(root, "github-summary") };
  await writeFile(files.output, "");
  await writeFile(files.summary, "");
  const original = "node scripts/ci-cross-os-scope.mjs";
  assert.ok(crossos.run.includes(original));
  const script = crossos.run.replace(original, command ?? `"${process.execPath}" "${scriptPath}"`);
  await execute("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
    cwd: repo ?? root,
    timeout: 60_000,
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: event,
      PUSH_REF: ref,
      BEFORE_SHA: before ?? "",
      AFTER_SHA: after ?? "",
      GITHUB_OUTPUT: files.output,
      GITHUB_STEP_SUMMARY: files.summary,
    },
  });
  return { output: await readFile(files.output, "utf8"), summary: await readFile(files.summary, "utf8") };
}

const SAYS_FALSE = "printf 'cquery_cross_os=false\\n'";

test("the step's shell never lets a changed decision code, rules, impact helper or workflow judge itself", async () => {
  await withTemp(async (root) => {
    const { repo, commit, base } = await newHistory(root);
    // Control: a docs-only push, with a stand-in command that always says false, skips.
    const docs = await commit({ "docs/a.md": "two\n" }, "docs");
    const control = await runCrossosStep({ root, repo, before: base, after: docs, command: SAYS_FALSE });
    assert.equal(control.output, "cquery_cross_os=false\n");

    let before = docs;
    const guarded = [
      ["the decision script", { "scripts/ci-cross-os-scope.mjs": "// changed\n" }, []],
      ["its rules", { "scripts/ci-cross-os-scope.json": rulesSource.replace("version\": 1", "version\": 1") + " " }, []],
      ["its test", { "scripts/ci-cross-os-scope.test.mjs": "// new\n" }, []],
      ["the impact helper", { "scripts/impact/core.mjs": "// changed\n" }, []],
      ["a file below scripts/impact", { "scripts/impact/other/deep.mjs": "// new\n" }, []],
      ["a workflow", { ".github/workflows/x.yml": "a: 2\n" }, []],
      ["a new workflow", { ".github/workflows/new.yml": "a: 1\n" }, []],
    ];
    for (const [label, files, removed] of guarded) {
      const after = await commit(files, label, removed);
      const result = await runCrossosStep({ root, repo, before, after, command: SAYS_FALSE });
      assert.equal(result.output, "cquery_cross_os=true\n", label);
      assert.match(result.summary, /legs run/u, label);
      before = after;
    }
    // A deleted script or workflow: the quoted pathspec still sees the deletion.
    for (const removed of ["scripts/ci-cross-os-scope.mjs", "scripts/impact/core.mjs", ".github/workflows/x.yml"]) {
      const after = await commit({}, `delete ${removed}`, [removed]);
      const result = await runCrossosStep({ root, repo, before, after, command: SAYS_FALSE });
      assert.equal(result.output, "cquery_cross_os=true\n", `delete ${removed}`);
      before = after;
    }
    // Control after all of that: a docs-only push still skips.
    const later = await commit({ "docs/a.md": "three\n" }, "docs again");
    assert.equal((await runCrossosStep({ root, repo, before, after: later, command: SAYS_FALSE })).output, "cquery_cross_os=false\n");
  });
});

test("the step's shell runs the legs when the push, the commits or the decision are anything but a clean false", async () => {
  await withTemp(async (root) => {
    const { repo, commit, base } = await newHistory(root);
    const docs = await commit({ "docs/a.md": "two\n" }, "docs");
    const step = (extra) => runCrossosStep({ root, repo, before: base, after: docs, command: SAYS_FALSE, ...extra });
    assert.equal((await step()).output, "cquery_cross_os=false\n", "control");
    for (const [label, extra] of [
      ["an empty before", { before: "" }],
      ["an all-zero before", { before: ZEROS }],
      ["an unknown before", { before: "c".repeat(40) }],
      ["an empty after", { after: "" }],
      ["an unknown after", { after: "d".repeat(40) }],
      ["a pull request event", { event: "pull_request" }],
      ["a schedule event", { event: "schedule" }],
      ["a feature branch", { ref: "refs/heads/feature" }],
      ["a tag", { ref: "refs/tags/v1.0.0" }],
      ["a directory that is not a repository", { repo: path.join(root, "plain") }],
    ]) {
      if (extra.repo) await mkdir(extra.repo, { recursive: true });
      const result = await step(extra);
      assert.equal(result.output, "cquery_cross_os=true\n", label);
    }
    // The decision command fails, prints nothing, prints noise, prints two lines, or prints something other than the exact false.
    for (const [label, command] of [
      ["a failing command", "false"],
      ["a missing command", "this-command-does-not-exist-anywhere"],
      ["an empty output", "true"],
      ["a true", "printf 'cquery_cross_os=true\\n'"],
      ["a misspelled name", "printf 'cquery_cross_os_x=false\\n'"],
      ["an uppercase value", "printf 'cquery_cross_os=FALSE\\n'"],
      ["a padded value", "printf 'cquery_cross_os=false \\n'"],
      ["a prefixed line", "printf 'x\\ncquery_cross_os=false\\n'"],
      ["two lines", "printf 'cquery_cross_os=false\\ncquery_cross_os=false\\n'"],
      ["a false and a failure", "printf 'cquery_cross_os=false\\n'; false"],
    ]) {
      const result = await step({ command });
      assert.equal(result.output, "cquery_cross_os=true\n", label);
      assert.equal(result.output.split("\n").filter(Boolean).length, 1, label);
    }
  });
});

test("the step's shell, with the real decision script, skips a docs-only push and runs for a worker path", async () => {
  await withTemp(async (root) => {
    const { repo, commit, base } = await newHistory(root);
    const docs = await commit({ "docs/a.md": "two\n", "src/a.ts": "export const a = 1;\n" }, "docs and src");
    const skipped = await runCrossosStep({ root, repo, before: base, after: docs });
    assert.equal(skipped.output, "cquery_cross_os=false\n");
    assert.match(skipped.summary, /legs are skipped/u);
    assert.match(skipped.summary, /not a pass/u);
    const db = await commit({ "src-tauri/crates/grimodex-core/src/lib.rs": "pub fn a() {}\n" }, "core");
    const ran = await runCrossosStep({ root, repo, before: docs, after: db });
    assert.equal(ran.output, "cquery_cross_os=true\n");
    assert.match(ran.summary, /grimodex-core\/src\/lib\.rs/u);
    // The decision script that is checked in, not the stand-in: its own change is never judged by itself.
    const selfEdit = await commit({ "scripts/ci-cross-os-scope.mjs": "// a script that would say false\n" }, "edit the script");
    const result = await runCrossosStep({ root, repo, before: db, after: selfEdit });
    assert.equal(result.output, "cquery_cross_os=true\n");
    assert.match(result.summary, /changes the decision code/u);
    // Exactly one output line each time.
    for (const output of [skipped.output, ran.output, result.output]) assert.equal(output.split("\n").filter(Boolean).length, 1);
  });
});

test("the nightly and the release call never reach the decision step", () => {
  // The step is for a push to master only: a tag push (the release call), the schedule and a dispatch skip it,
  // leave the output empty, and the matrix reads an empty output as "run all three".
  assert.match(crossos.if, /github\.ref == 'refs\/heads\/master'/u);
  assert.ok(!/schedule|workflow_dispatch|workflow_call|pull_request/u.test(crossos.if));
});
