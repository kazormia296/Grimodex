import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import yaml from "js-yaml";

import { PRODUCT_DOMAIN_RULES } from "../electron/scripts/product-journey-catalog.mjs";
import {
  compileScopeRules,
  decideForEvent,
  decideScope,
  formatOutputs,
  laneNames,
  loadBaseScopeRules,
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
// The Frontend jobs are no longer here: they belong to the `frontend` lane (docs-only pull requests skip them).
const ALWAYS_RUN_JOBS = ["quality", "electron"];
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
  // The lane outputs come from the `scope` step; the one extra output is the
  // separate master-push decision of the `crossos` step (scripts/ci-cross-os-scope.test.mjs).
  assert.deepEqual(Object.keys(changes.outputs).sort(), [...LANES, "cquery_cross_os"].sort());
  for (const lane of LANES) {
    assert.equal(changes.outputs[lane], `\${{ steps.scope.outputs.${lane} }}`, lane);
  }
  assert.equal(changes.outputs.cquery_cross_os, "${{ steps.crossos.outputs.cquery_cross_os }}");
  const scope = changes.steps.find(({ id }) => id === "scope");
  const listed = /^lanes="([^"]+)"$/mu.exec(scope.run);
  assert.ok(listed, "the shell fallback must list the lanes literally");
  assert.deepEqual(listed[1].split(" ").sort(), [...LANES].sort());
  assert.match(scope.run, /grep -c \.\)" = "9"/u, "the shell checks for exactly nine lines");
  assert.equal(LANES.length, 9);
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
  // An always-run job may wait only for other always-run jobs, never for the change scope.
  for (const id of ALWAYS_RUN_JOBS) {
    for (const need of [jobOf(id).needs ?? []].flat()) {
      assert.ok(ALWAYS_RUN_JOBS.includes(need), `${id} must not wait for ${need}`);
    }
  }
  // The frontend aggregate is a cascade of the frontend lane: it waits for its two gated jobs, not for `changes`.
  assert.deepEqual(jobOf("frontend").needs, ["frontend-static", "frontend-unit"]);
  assert.equal(laneOfJob["frontend-static"], "frontend");
  assert.equal(laneOfJob["frontend-unit"], "frontend");
  assert.equal(cascade.get("frontend"), "frontend");
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

test("the changes job never fails the run and diffs only for pull requests and master pushes", () => {
  const changes = jobOf("changes");
  assert.equal(changes.name, "Change scope");
  assert.equal(changes["runs-on"], "ubuntu-24.04");
  // The checkout is the only step that can hang on the network; it has its own
  // step timeout, and the job timeout covers checkout, setup, script and upload.
  assert.equal(changes["timeout-minutes"], 10);
  // Same guard as the journey roots, so a root that runs always has `changes`.
  assert.equal(
    changes.if,
    "${{ !inputs.source_focused && !inputs.source_canonical_contracts && !inputs.canonical_profile && !inputs.candidate_base && !inputs.candidate_head && !inputs.max_parallel_tasks && !inputs.independent_gates }}",
  );
  // `crossos` is last so that the destructuring of the first four steps stays put.
  const [checkout, setup, scope, upload, crossos] = changes.steps;
  assert.equal(changes.steps.length, 5);
  assert.match(checkout.uses, /^actions\/checkout@[0-9a-f]{40}$/u);
  assert.equal(checkout["timeout-minutes"], 3);
  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(checkout.with["persist-credentials"], false);
  assert.match(setup.uses, /^actions\/setup-node@[0-9a-f]{40}$/u);
  assert.match(upload.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/u);
  // The checkout and Node are shared with the master-push decision of the `crossos` step; the scope step
  // itself still diffs only for a pull request (its shell guard), and the evidence upload is for pull requests.
  for (const step of [checkout, setup]) {
    assert.equal(step.if, "github.event_name == 'pull_request' || (github.event_name == 'push' && github.ref == 'refs/heads/master')");
  }
  assert.equal(upload.if, "github.event_name == 'pull_request'");
  assert.equal(crossos.id, "crossos");
  assert.equal(crossos.if, "github.event_name == 'push' && github.ref == 'refs/heads/master'");
  assert.equal(crossos["timeout-minutes"], 1);
  assert.deepEqual(crossos.env, {
    PUSH_REF: "${{ github.ref }}",
    BEFORE_SHA: "${{ github.event.before }}",
    AFTER_SHA: "${{ github.sha }}",
  });
  assert.doesNotMatch(crossos.run, /\$\{\{/u, "no expression is interpolated into the script");
  assert.doesNotMatch(crossos.run, /\|\|\s*true/u);
  // A failed step would fail `changes`, and a job-level failure also skips the
  // unchanged shard/aggregate/runtime-performance jobs (their implicit
  // success() sees the failed ancestor), so every step may fail softly.
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
    lanesFor(["docs/local-ci-runner.md", "README.md", "experiments/notes/a.py"]),
    only([]),
  );
});

test("release notes are docs for every lane except windows, whose installer bundles public/", () => {
  // vite's publicDir (public/) is copied into dist/, which electron-builder
  // packs, so the Windows installer contract reads public/RELEASE_NOTES/**.
  // The frontend lane also runs: vite copies public/ into dist/, and the web editor artifact check scans the .md files there.
  assert.deepEqual(lanesFor(["public/RELEASE_NOTES/v2.0.0.ja.md"]), only(["windows", "frontend"]));
  assert.deepEqual(lanesFor(["docs/a.md", "public/RELEASE_NOTES/v2.0.0.ja.md"]), only(["windows", "frontend"]));
});

test("CI, scripts and AI instruction changes skip the Rust, native, migration, windows, browser, lfm and security lanes but run journeys and frontend", () => {
  assert.deepEqual(
    lanesFor([
      "scripts/quality/impact-map.mjs",
      ".agents/skills/review-code/SKILL.md",
      ".claude/hooks/block-push-to-main.sh",
      "policies/quality/iron-laws.md",
      "evals/quality-manifest.yaml",
      "evals/impact-map.yaml",
    ]),
    only(["journeys", "frontend"]),
  );
  // scripts/local-ci*.mjs are imported by the native and Windows lanes' own
  // JS tests (through electron/scripts), so those two lanes keep running.
  assert.deepEqual(lanesFor(["scripts/local-ci-runner.mjs"]), only(["journeys", "native", "windows", "frontend"]));
  // Docs plus CI assets: journeys and frontend run because the CI assets are not docs.
  assert.deepEqual(lanesFor(["docs/a.md", "scripts/quality/x.mjs"]), only(["journeys", "frontend"]));
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
  // Docs plus renderer code: only the lanes a renderer change cannot reach are skipped. No Rust crate reads
  // a TypeScript source, so rust and migration (Gate A2) skip; native stays (its pipeline specs import renderer code).
  assert.deepEqual(
    lanesFor(["docs/a.md", "src/features/editor/a.ts"]),
    only(["journeys", "native", "windows", "browser", "security", "frontend"]),
  );
  // CI assets plus an unclassified script still run everything but lfm.
  assert.deepEqual(
    lanesFor(["scripts/quality/x.mjs", "scripts/browser-ci-benchmark.mjs"]),
    only(["journeys", "rust", "native", "migration", "windows", "browser", "security", "frontend"]),
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

// Files only: a recursive readdir also lists directories, and a directory whose
// name matches the pattern (a build or test output named like `x.spec.ts/`)
// must not become an entry (it failed Full 43604272959 with EISDIR).
async function listFiles(directory, pattern) {
  const root = path.join(repoRoot, directory);
  const matches = (await readdir(root, { recursive: true }))
    .filter((name) => pattern.test(name.split(path.sep).join("/")))
    .map((name) => path.join(root, name));
  const kept = await Promise.all(matches.map((file) => isFile(file)));
  return matches.filter((_, index) => kept[index]);
}

const SOURCE_FILE = /\.(?:mjs|cjs|js|jsx|mts|cts|ts|tsx)$/u;
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx", ".json"];
// A `.js` specifier may name a `.ts` source (and so on); try those first.
const EXTENSION_SWAPS = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
const IMPORT_PATTERNS = [
  /\bfrom\s*["']([^"'\n]+)["']/gu,
  /\bimport\s*\(\s*["']([^"'\n]+)["']/gu,
  /\bimport\s+["']([^"'\n]+)["']/gu,
  /\brequire\(\s*["']([^"'\n]+)["']/gu,
  /\bvi\.(?:mock|doMock|unmock|importActual|importMock)\(\s*["']([^"'\n]+)["']/gu,
  /\bimport\.meta\.glob\(\s*["']([^"'\n]+)["']/gu,
];

const isFile = (candidate) => stat(candidate).then((info) => info.isFile(), () => false);

/**
 * Resolves one specifier the way Vite and TypeScript (moduleResolution:
 * bundler, `@/*` -> `src/*`) do. `null`: not a repository path (a package, a
 * Node built-in, a virtual module). `undefined`: a repository path that does
 * not resolve to a file, which the closure test refuses to ignore.
 */
async function resolveSpecifier({ root, from, specifier }) {
  let base;
  if (specifier.startsWith(".")) base = path.resolve(path.dirname(from), specifier);
  else if (specifier.startsWith("@/")) base = path.join(root, "src", specifier.slice(2));
  else if (specifier.startsWith("/") && !specifier.startsWith("//")) base = path.join(root, specifier);
  else return null;
  base = base.replace(/[?#].*$/u, "");
  const swaps = (EXTENSION_SWAPS[path.extname(base)] ?? []).map(
    (extension) => base.slice(0, -path.extname(base).length) + extension,
  );
  const candidates = [
    base,
    ...swaps,
    ...RESOLVE_EXTENSIONS.map((extension) => base + extension),
    ...RESOLVE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Static import closure from `entries`: every file the entries can load
 * through import/require/vi.mock/import.meta.glob, with extensionless, `.js`
 * -> `.ts`, `@/` alias, `/index` and `?query` specifiers resolved. The result
 * lists the repository-relative files reached and the specifiers that look
 * like repository paths but did not resolve. Edges are cached per walker.
 */
function createImportWalker(root) {
  const edges = new Map();
  const edgesOf = async (file) => {
    if (edges.has(file)) return edges.get(file);
    const targets = [];
    const unresolved = [];
    if (SOURCE_FILE.test(file)) {
      const source = await readFile(file, "utf8");
      const specifiers = new Set(
        IMPORT_PATTERNS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1])),
      );
      for (const specifier of specifiers) {
        const target = await resolveSpecifier({ root, from: file, specifier });
        if (target) targets.push(target);
        else if (target === undefined) unresolved.push(`${path.relative(root, file).split(path.sep).join("/")} -> ${specifier}`);
      }
    }
    const result = { targets, unresolved };
    edges.set(file, result);
    return result;
  };
  return async (entries) => {
    const pending = [...entries];
    const seen = new Set();
    const unresolved = new Set();
    while (pending.length > 0) {
      const file = pending.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const edge = await edgesOf(file);
      pending.push(...edge.targets);
      for (const entry of edge.unresolved) unresolved.add(entry);
    }
    return {
      files: [...seen].map((file) => path.relative(root, file).split(path.sep).join("/")).sort(),
      unresolved: [...unresolved].sort(),
    };
  };
}

const importClosure = createImportWalker(repoRoot);

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The subset of globs Storybook's `stories` uses: `**` segments, `*` and `@(a|b)`. */
function storyGlobToRegExp(glob) {
  let source = "";
  for (let index = 0; index < glob.length; ) {
    if (glob.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
    } else if (glob.startsWith("@(", index)) {
      const close = glob.indexOf(")", index);
      assert.ok(close > index, `unterminated @( in ${glob}`);
      source += `(?:${glob.slice(index + 2, close).split("|").map(escapeRegExp).join("|")})`;
      index = close + 1;
    } else if (glob[index] === "*") {
      source += "[^/]*";
      index += 1;
    } else {
      source += escapeRegExp(glob[index]);
      index += 1;
    }
  }
  return new RegExp(`^${source}$`, "u");
}

/** Files Storybook's `stories` globs (relative to .storybook/) select. */
async function storybookEntries() {
  const main = await readFile(path.join(repoRoot, ".storybook/main.ts"), "utf8");
  const listed = /\bstories:\s*\[([^\]]*)\]/u.exec(main);
  assert.ok(listed, ".storybook/main.ts must list its stories globs");
  const globs = [...listed[1].matchAll(/["']([^"']+)["']/gu)].map((match) => match[1]);
  assert.ok(globs.length > 0);
  const found = [];
  for (const glob of globs) {
    const relative = path.posix.normalize(path.posix.join(".storybook", glob));
    const parts = relative.split("/");
    const wildcard = parts.findIndex((part) => /[*@]/u.test(part));
    assert.ok(wildcard > 0, `${glob} must name a directory before its wildcard`);
    const matcher = storyGlobToRegExp(relative);
    found.push(
      ...(await listFiles(parts.slice(0, wildcard).join("/"), /./u)).filter((file) =>
        matcher.test(path.relative(repoRoot, file).split(path.sep).join("/")),
      ),
    );
  }
  return found;
}

/** `setupFiles` of the vitest configs the browser lane's jobs run. */
async function browserSetupEntries() {
  const entries = [];
  for (const config of ["vitest.browser.config.ts", "vitest.storybook.config.ts", "vitest.webgl.config.ts"]) {
    const source = await readFile(path.join(repoRoot, config), "utf8");
    const listed = /\bsetupFiles:\s*\[([^\]]*)\]/u.exec(source);
    assert.ok(listed, `${config} must list setupFiles`);
    for (const match of listed[1].matchAll(/["']([^"']+)["']/gu)) entries.push(path.join(repoRoot, match[1]));
  }
  return entries;
}

async function rendererEntries() {
  const html = await readFile(path.join(repoRoot, "index.html"), "utf8");
  const sources = [...html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(sources, ["/src/main.tsx"], "index.html must load exactly the renderer entry");
  return sources.map((source) => path.join(repoRoot, source));
}

test("the import closure resolves extensionless, .js to .ts, @/ alias, index and query specifiers and reports what it cannot", async () => {
  await withTemp(async (root) => {
    const write = async (relative, content = "export {};\n") => {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), content);
    };
    await write("src/entry.test.ts", [
      'import a from "./plain";',
      'import b from "./swapped.js";',
      'import c from "@/lib/aliased";',
      'import d from "./folder";',
      'import e from "./notes.md?raw";',
      'import f from "../docs/extra.json";',
      'export * from "./reexported";',
      'const lazy = () => import("./lazy.tsx");',
      'vi.mock("./mocked", () => ({}));',
      'import "node:fs";',
      'import react from "react";',
      'import scoped from "@scope/package";',
    ].join("\n"));
    await write("src/plain.ts");
    await write("src/swapped.ts");
    await write("src/lib/aliased.tsx");
    await write("src/folder/index.ts");
    await write("src/notes.md", "# notes\n");
    await write("docs/extra.json", "{}\n");
    await write("src/reexported.mts");
    await write("src/lazy.tsx");
    await write("src/mocked.ts", 'import "./missing";\n');
    const { files, unresolved } = await createImportWalker(root)([path.join(root, "src/entry.test.ts")]);
    assert.deepEqual(files, [
      "docs/extra.json",
      "src/entry.test.ts",
      "src/folder/index.ts",
      "src/lazy.tsx",
      "src/lib/aliased.tsx",
      "src/mocked.ts",
      "src/notes.md",
      "src/plain.ts",
      "src/reexported.mts",
      "src/swapped.ts",
    ]);
    assert.deepEqual(unresolved, ["src/mocked.ts -> ./missing"]);
  });
});

test("every file a skippable lane's JS tests import stays outside that lane's neutral sets", async () => {
  // `pnpm --dir electron/native/grimodex-node test` runs node --test over the
  // native test directory (and main-pipeline-specs spawns the pipeline specs);
  // those import scripts/quality/run-nir1-retrieval.mjs and, through
  // electron/scripts, scripts/local-ci*.mjs, which the CI-assets set would
  // otherwise make skippable. Follow static imports from each lane's entries
  // so a new import of a neutral path fails here instead of silently skipping
  // the lane. Every relative or `@/` specifier must resolve (a specifier the
  // walker cannot follow would be a silent hole), and each lane has a file it
  // can only reach through resolution as a positive control.
  // (electron/** is forced all and is skipped.)
  const laneEntries = {
    native: [
      ...(await listFiles("electron/native/grimodex-node/test", /\.(?:mjs|js|ts)$/u)),
      ...(await listFiles("electron/main", /\.pipeline\.spec\.ts$/u)),
    ],
    windows: await listFiles("electron", /^(?:main|preload|shared)\/.*\.test\.ts$/u),
    // The frontend lane runs vitest.config.ts (every non-browser unit test and its setup file), and its static job
    // type-checks all of src (tsconfig include), lints it and builds the renderer: every TS/TSX file under src and
    // the renderer entry are entries too, so an import of a docs-set file (`?raw`, JSON, fixtures) from anywhere in
    // src would fail here instead of letting a docs-only change skip the lane.
    frontend: [
      ...(await listFiles("src", /\.tsx?$/u)),
      ...(await rendererEntries()),
      path.join(repoRoot, "vite.config.ts"),
    ],
    browser: [
      ...(await listFiles("src", /\.browser\.test\.tsx?$/u)),
      ...(await storybookEntries()),
      ...(await browserSetupEntries()),
      ...[".storybook/main.ts", ".storybook/preview.ts"].map((file) => path.join(repoRoot, file)),
    ],
    // The journeys build packs the renderer (index.html -> src/main.tsx).
    journeys: await rendererEntries(),
  };
  // Files only reachable through an extensionless, `@/` or `/index` specifier,
  // and a floor on the closure size (the walk at the time of writing reaches
  // about 750, 210, 640, 2000 and 2100 files, so a walker that stops following
  // imports fails here).
  const controls = {
    native: { includes: ["scripts/quality/run-nir1-retrieval.mjs", "scripts/local-ci-xvfb.mjs"], atLeast: 500 },
    windows: { includes: ["electron/main/aiKeyNaming.ts", "scripts/local-ci-xvfb.mjs"], atLeast: 150 },
    // `unresolved` is the exact list of specifiers the walker may not follow. For the frontend lane these are
    // import-shaped text that is not a real import (an assertion on another file's source in AiAuditLazyImport.test.ts)
    // and vi.mock or type-only specifiers of modules that do not exist (the mock is a no-op), all inside src/. None
    // can reach a docs, experiments or public path, which is the only thing the frontend lane's neutral set contains.
    // A new entry here must be checked by a person, not added blindly.
    frontend: {
      includes: ["src/lib/i18n.ts", "src/features/workspace/store.ts"],
      atLeast: 1500,
      unresolved: [
        "src/AiAuditLazyImport.test.ts -> ./aiScaffold/AiTreeDialog",
        "src/AiAuditLazyImport.test.ts -> ./chatStreamTransport",
        "src/AiAuditLazyImport.test.ts -> ./cliApi",
        "src/AiAuditLazyImport.test.ts -> ./codexAppApi",
        "src/AiAuditLazyImport.test.ts -> ./lazyTransportApi",
        "src/AiAuditLazyImport.test.ts -> ./singleShotTransport",
        "src/features/codex/components/CodexDetailContent.test.tsx -> ./CodexEditLockBanner",
        "src/features/editor/sceneEditorSurfaceParity.test.tsx -> @/features/editor/useInsertHighlight",
        "src/features/legal/EulaConsentDialog.test.tsx -> ./MarkdownDocPlaceholder",
        "src/features/related-scenes/useNir1EvidenceNavigation.lazy.test.ts -> ./nir1GraphApi",
        "src/features/related-scenes/useNir1EvidenceNavigation.lazy.test.ts -> ./types",
      ],
    },
    browser: { includes: ["src/index.css", "src/lib/i18n.ts"], atLeast: 1500 },
    journeys: { includes: ["src/main.tsx", "src/lib/i18n.ts"], atLeast: 1500 },
  };
  for (const [lane, entries] of Object.entries(laneEntries)) {
    assert.ok(entries.length > 0, `${lane} must have test entries`);
    const closure = await importClosure(entries);
    assert.deepEqual(closure.unresolved, controls[lane].unresolved ?? [], `${lane}: relative or @/ specifiers the walker could not resolve`);
    assert.ok(closure.files.length >= controls[lane].atLeast, `${lane}: closure has only ${closure.files.length} files`);
    for (const included of controls[lane].includes) {
      assert.ok(closure.files.includes(included), `${lane}: the walk must reach ${included}`);
    }
    for (const file of closure.files) {
      if (file.startsWith("electron/")) continue;
      assert.equal(lanesFor([file])[lane], true, `${lane}: ${file}`);
      assert.equal(lanesFor(["docs/a.md", file])[lane], true, `${lane}: docs + ${file}`);
    }
  }
  const browser = await importClosure(laneEntries.browser);
  assert.ok(browser.files.some((file) => /\.stories\.tsx?$/u.test(file)), "the browser walk must start from the stories");
  assert.ok(browser.files.includes(".storybook/preview.ts"));
  // Control: other scripts/quality files are still neutral for native.
  assert.equal(lanesFor(["scripts/quality/validate-run-kind-policy.mjs"]).native, false);
  assert.equal(lanesFor(["scripts/local-ci-registry.json"]).native, true);
});

test("a root markdown file the Windows installer packages keeps the windows lane", () => {
  assert.deepEqual(lanesFor(["LICENSING.md"]), only(["windows"]));
  assert.equal(lanesFor(["README.md"]).windows, false);
});

/** A concrete path a glob matches (`**` and `*` filled with plain segments). */
const sampleOf = (glob) => glob.replaceAll("**", "sample/x").replaceAll("*", "x");

async function trackedFiles() {
  try {
    const { stdout } = await execute("git", ["ls-files", "-z"], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
    return stdout.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Representative paths for a derived glob: its own sample, the samples of the
 * neutral globs that fall inside it, and the tracked files it matches. A single
 * sample of `public/**` would miss `public/RELEASE_NOTES/**`.
 */
function representativesOf(derived, neutralGlobs, tracked) {
  const matcher = compileGlob(derived);
  return [
    ...new Set([
      sampleOf(derived),
      ...neutralGlobs.map(sampleOf).filter((candidate) => matcher.test(candidate)),
      ...tracked.filter((file) => matcher.test(file)),
    ]),
  ];
}

test("every path the Windows installer packs keeps the windows lane, derived from electron-builder.yml and vite", async () => {
  const builder = yaml.load(await readFile(path.join(repoRoot, "electron-builder.yml"), "utf8"));
  const viteSource = await readFile(path.join(repoRoot, "vite.config.ts"), "utf8");
  // vite copies publicDir into dist/, and `files` packs dist/**.
  assert.ok(builder.files.includes("dist/**"));
  assert.doesNotMatch(viteSource, /copyPublicDir\s*:\s*false/u);
  let publicDir = "public";
  if (/\bpublicDir\b/u.test(viteSource)) {
    const configured = /\bpublicDir\s*:\s*["']([^"']+)["']/u.exec(viteSource);
    assert.ok(configured, "vite.config.ts sets publicDir in a form this test cannot read");
    publicDir = configured[1];
  }
  const plain = (value) => value.replace(/^\.\//u, "").replace(/\/+$/u, "");
  const derived = new Set([
    ...builder.files.filter((entry) => !entry.startsWith("!")).map(plain),
    ...builder.extraResources.map((resource) => `${plain(resource.from)}/**`),
    plain(builder.nsis.include),
    `${plain(publicDir)}/**`,
  ]);
  // Guard the derivation itself: these exist today and must keep being found.
  for (const expected of [
    "LICENSING.md",
    "dist/**",
    "public/**",
    "experiments/lfm25-encoder-phase0/local/**",
    "electron/installer/tauri-v1-migration.nsh",
  ]) {
    assert.ok(derived.has(expected), `derivation must produce ${expected}`);
  }

  const neutralGlobs = [...rawRules.sets.docs, ...rawRules.sets["ci-and-ai"]];
  const tracked = await trackedFiles();
  const representatives = [...derived].flatMap((glob) => representativesOf(glob, neutralGlobs, tracked));
  for (const candidate of representatives) {
    assert.equal(lanesFor([candidate]).windows, true, candidate);
    assert.equal(lanesFor(["docs/a.md", candidate]).windows, true, `docs + ${candidate}`);
  }

  // Control: without windows' neverNeutral the same paths would be neutral, so
  // the entries in the rules file are what keeps them running.
  const weakened = structuredClone(rawRules);
  delete weakened.lanes.windows.neverNeutral;
  const weakRules = compileScopeRules(weakened);
  const skippable = representatives.filter(
    (candidate) => decideScope({ rules: weakRules, changedPaths: [candidate] }).lanes.windows.run === false,
  );
  assert.ok(skippable.includes("LICENSING.md"));
  assert.ok(skippable.some((candidate) => candidate.startsWith("public/RELEASE_NOTES/")));
  assert.ok(skippable.some((candidate) => candidate.startsWith("experiments/lfm25-encoder-phase0/local/")));
  // The rest of experiments/ and the release notes' neighbours stay neutral.
  assert.equal(lanesFor(["experiments/lfm25-encoder-phase0/src/encoder.py"]).windows, false);
  assert.equal(lanesFor(["experiments/other/a.py"]).windows, false);
});

test("every repository path the native crate reads from outside its directory keeps the native lane", async () => {
  // freeze.rs binds scripts/quality/nir1-packing/final-request/*.mjs by sha256,
  // and other sources include_str! files from evals/, policies/ and src/. A
  // path in a neutral set that the crate reads would let a change skip the lane.
  const literal = /"(?:\.{1,2}\/|\/)*((?:scripts|evals|policies|docs|experiments|public|\.agents|\.claude)\/[^"\n]*)"/gu;
  const found = new Set();
  const sources = [
    ...(await listFiles("electron/native/grimodex-node/src", /\.rs$/u)),
    path.join(repoRoot, "electron/native/grimodex-node/build.rs"),
  ];
  for (const file of sources) {
    if (!(await stat(file).then((info) => info.isFile(), () => false))) continue;
    for (const match of (await readFile(file, "utf8")).matchAll(literal)) {
      const concrete = match[1].replace(/\{[^}]*\}/gu, "x");
      found.add(concrete.endsWith("/") ? `${concrete}x` : concrete);
    }
  }
  assert.ok(found.has("scripts/quality/nir1-packing/final-request/x"), "the scan must find the freeze.rs directory");
  assert.ok(found.size >= 5, `only ${found.size} paths found`);
  for (const candidate of found) {
    assert.equal(lanesFor([candidate]).native, true, candidate);
    assert.equal(lanesFor(["docs/a.md", candidate]).native, true, `docs + ${candidate}`);
  }
  // Control: another scripts/quality directory is still neutral for native.
  assert.equal(lanesFor(["scripts/quality/nir1-other/x.mjs"]).native, false);
});

test("renderer-code (src TypeScript, TSX and CSS) skips Rust and Gate A2 only; everything else still reaches them", () => {
  // Renderer code alone, and beside docs: no Rust crate reads these files.
  for (const sample of ["src/features/foo/Bar.tsx", "src/lib/x.ts", "src/index.css", "src/features/editor/useThing.test.ts"]) {
    for (const paths of [[sample], ["docs/a.md", sample]]) {
      const lanes = lanesFor(paths);
      assert.equal(lanes.rust, false, paths.join(" + "));
      assert.equal(lanes.migration, false, paths.join(" + "));
      // Every other lane that reads the renderer still runs, and lfm is a trigger lane.
      for (const lane of ["journeys", "native", "windows", "browser", "security", "frontend"]) {
        assert.equal(lanes[lane], true, `${lane}: ${paths.join(" + ")}`);
      }
      assert.equal(lanes.lfm, false, paths.join(" + "));
    }
  }
  // Anything under src that is not code (JSON, markdown, SQL, images, other languages) or that sits in a fixture
  // directory keeps both lanes: Rust crates read src fixtures (src/db/generated/schema-contract.json and others).
  for (const sample of [
    "src/features/settings/README.md",
    "src/x.fixture.json",
    "src/db/generated/schema-contract.json",
    "src/features/a/data.sql",
    "src/assets/logo.png",
    "src/features/chronicle/fixtures/chronicle-snapshot/x.ts",
    "src/features/chat/agent/__fixtures__/x.ts",
    "src/features/agent-writes/parity/x.ts",
    "src/features/a/fixtures/deep/x.css",
  ]) {
    for (const paths of [[sample], ["docs/a.md", sample]]) {
      const lanes = lanesFor(paths);
      assert.equal(lanes.rust, true, paths.join(" + "));
      assert.equal(lanes.migration, true, paths.join(" + "));
    }
  }
  // A Rust change, an electron change (forced) or a renderer change beside a Rust one runs both.
  for (const paths of [
    ["src/a.ts", "src-tauri/crates/grimodex-db/src/lib.rs"],
    ["src/a.ts", "electron/main/index.ts"],
    ["src/a.ts", "electron/native/grimodex-node/src/lib.rs"],
    ["src/a.ts", "scripts/schema-seed-ja.sql"],
  ]) {
    const lanes = lanesFor(paths);
    assert.equal(lanes.rust && lanes.migration, true, paths.join(" + "));
  }
  // electron/** stays forced for every lane (a separate decision; see docs/local-ci-runner.md).
  assert.deepEqual(lanesFor(["electron/main/index.ts"]), ALL_RUN);
  assert.deepEqual(lanesFor(["electron/shared/ipcContract.ts"]), ALL_RUN);
  // Control: without the rust and migration neverNeutral entries, fixture directories would be skippable.
  const weakened = structuredClone(rawRules);
  delete weakened.lanes.rust.neverNeutral;
  delete weakened.lanes.migration.neverNeutral;
  const weakRules = compileScopeRules(weakened);
  const weak = decideScope({ rules: weakRules, changedPaths: ["src/features/chronicle/fixtures/chronicle-snapshot/x.ts"] });
  assert.equal(weak.lanes.rust.run, false);
  assert.equal(weak.lanes.migration.run, false);
});

test("the frontend lane skips for docs only, and docs/lp, docs/screenshots and public stay in it", () => {
  assert.equal(lanesFor(["docs/a.md", "README.md", "experiments/x.py"]).frontend, false);
  assert.equal(lanesFor(["docs/plans/nir1-continuation-2026-10.md"]).frontend, false);
  // What the frontend jobs read from the docs set: LP sources and assets, screenshots, and public/ (vite copies it into dist/).
  for (const sample of [
    "docs/lp/lp-variant-h.jsx",
    "docs/lp/assets/lp-app.js",
    "docs/lp/x.html",
    "docs/screenshots/generated/x.png",
    "public/RELEASE_NOTES/v1.md",
    "public/TERMS_ja.md",
    "public/PRIVACY_en.md",
  ]) {
    assert.equal(lanesFor([sample]).frontend, true, sample);
    assert.equal(lanesFor(["docs/a.md", sample]).frontend, true, `docs + ${sample}`);
  }
  // Code and CI assets are not docs: the frontend lane runs. (experiments/** is docs, the lfm lane aside.)
  for (const sample of ["src/a.ts", "scripts/quality/x.mjs", ".agents/skills/x/SKILL.md", "policies/quality/iron-laws.md"]) {
    assert.equal(lanesFor(["docs/a.md", sample]).frontend, true, sample);
  }
  // Control: with docs as the only neutral set and no neverNeutral, the LP assets would be skippable.
  const weakened = structuredClone(rawRules);
  delete weakened.lanes.frontend.neverNeutral;
  const weak = decideScope({ rules: compileScopeRules(weakened), changedPaths: ["docs/lp/lp-variant-h.jsx", "public/RELEASE_NOTES/v1.md"] });
  assert.equal(weak.lanes.frontend.run, false);
});

/** Comment lines are dropped; a literal in a comment or a doc string says nothing about what a crate reads. */
const withoutCommentLines = (source) => source.split("\n").filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line));

/** A literal path and, for a directory (no extension in the last segment), the files a read of it can reach. */
function literalCandidates(literal, { directoryChildren }) {
  const trimmed = literal.replace(/\/+$/u, "");
  const last = trimmed.split("/").pop();
  if (/\.[A-Za-z0-9]+$/u.test(last) || !directoryChildren) return [trimmed];
  return [trimmed, `${trimmed}/x.json`, `${trimmed}/x.ts`, `${trimmed}/x.css`];
}

test("every repository path the shared Rust workspace reads from outside its directory keeps the rust and migration lanes", async () => {
  // The rust and migration lanes run the src-tauri workspace (cargo). Rust may read repository files outside
  // src-tauri by relative path (include_str!, CARGO_MANIFEST_DIR joins, build.rs, fixtures). A path the lane skips
  // for a docs, CI-assets or renderer-code change would let that change skip the tests that read it.
  // The scan finds string literals; it cannot see a path assembled from segments. A grep of src-tauri (2026-11-21) found
  // no bare `"../.."` directory handed to a walk beyond src-tauri and electron/native (repo_root() joins only
  // `src-tauri/**` and `electron/native/**`), no `.join("src")` other than the crate's own src, and no read of a `.ts`,
  // `.tsx` or `.css` file. A new such read would need this test and the renderer-code set reviewed together.
  // Only src-tauri is scanned: electron/native is the native lane's crate (its reads are the native scan above, and
  // electron/** is forced for every lane anyway).
  const top = "(?:src|electron|scripts|policies|evals|docs|public|test-fixtures|ime-contract|experiments|\\.agents|\\.claude)";
  const repoLiteral = new RegExp(`"((?:\\.{1,2}/|/)*)(${top}/[^"\\s]*)"`, "gu");
  const rootFile = /"(?:\.\.\/)+(agent-tool-manifest[^"\s]*|[A-Za-z0-9_.-]+\.(?:json|ya?ml|toml))"/gu;
  const tracked = (await trackedFiles()).filter((file) => /^src-tauri\/.*\.rs$/u.test(file));
  assert.ok(tracked.length > 200, `only ${tracked.length} Rust files were scanned`);
  const found = new Map();
  for (const file of tracked) {
    for (const line of withoutCommentLines(await readFile(path.join(repoRoot, file), "utf8"))) {
      for (const match of line.matchAll(repoLiteral)) {
        const [, prefix, rest] = match;
        const concrete = rest.replace(/\{[^}]*\}/gu, "x");
        // `"src/lib.rs"` without a `../` is relative to the crate itself, not to the repository's src/.
        const crateRelative = concrete.startsWith("src/") && !/\.\.\//u.test(prefix);
        found.set(concrete, { file, directoryChildren: !crateRelative, ...found.get(concrete) });
      }
      for (const match of line.matchAll(rootFile)) found.set(match[1], { file, directoryChildren: false, ...found.get(match[1]) });
    }
  }
  // Controls: the scan finds the known reads of each kind.
  for (const expected of [
    "src/db/generated/schema-contract.json",
    "src/features/timelapse/hash-vectors.json",
    "src/features/chronicle/fixtures/chronicle-snapshot",
    "electron/main/mastra/__fixtures__/wire-args",
    "agent-tool-manifest.json",
    "policies/narrative/protected-writers.json",
    "scripts/schema-seed-ja.sql",
    "evals/nir1-capacity/manifest.v1.json",
  ]) {
    assert.ok(found.has(expected), `the scan must find ${expected}`);
  }
  assert.ok(found.size >= 20, `only ${found.size} paths found`);
  const checked = [];
  for (const [literal, { file, directoryChildren }] of found) {
    // Renderer code is the one skippable class, so a read of a TypeScript, TSX or CSS file would be a hole.
    assert.doesNotMatch(literal, /\.(?:tsx?|css)$/u, `${literal} (read in ${file}) is renderer code; Rust must not skip for it`);
    for (const candidate of literalCandidates(literal, { directoryChildren })) {
      checked.push(candidate);
      for (const lane of ["rust", "migration"]) {
        assert.equal(lanesFor([candidate])[lane], true, `${lane}: ${candidate} (read in ${file})`);
        assert.equal(lanesFor(["docs/a.md", candidate])[lane], true, `${lane}: docs + ${candidate} (read in ${file})`);
        assert.equal(lanesFor(["docs/a.md", "scripts/quality/x.mjs", candidate])[lane], true, `${lane}: docs + ci + ${candidate}`);
      }
    }
  }
  assert.ok(checked.includes("src/features/chronicle/fixtures/chronicle-snapshot/x.ts"), "directory reads are checked with their children");
  // Controls (the rules still skip what Rust does not read).
  assert.equal(lanesFor(["src/lib/x.ts"]).rust, false);
  assert.equal(lanesFor(["docs/a.md", "src/a.ts"]).migration, false);
});

test("every path the frontend jobs read from the docs set keeps the frontend lane", async () => {
  // frontend-static (tsc, eslint, architecture, browser CI contracts, web editor build) and frontend-unit (vitest over
  // src) can read files of the docs set: LP sources, screenshots and public/. Scan what they run for such literals.
  const tracked = await trackedFiles();
  const scanned = tracked.filter((file) =>
    /^src\/.*\.tsx?$/u.test(file)
    || /^packages\/.*\.(?:[cm]?[jt]sx?)$/u.test(file)
    || /^(?:vite|vitest[A-Za-z.-]*|eslint)\.config\.[cm]?[jt]s$/u.test(file)
    || /^scripts\/(?:validate-architecture|browser-ci-|check-performance-budgets|runtime-performance-budget|validate-web-editor-artifact)/u.test(file),
  );
  assert.ok(scanned.length > 500, `only ${scanned.length} files were scanned`);
  const literal = /["'`]((?:\.{1,2}\/)*(?:docs|experiments|public)\/[^"'`\s]*)["'`]/gu;
  // A root-level Markdown file name is also docs-set content; only names of files that really exist in the repository root count.
  const rootMarkdown = /["'`](?:\.\.\/)*([A-Za-z0-9_-]+\.md)["'`]/gu;
  const rootFiles = new Set(tracked.filter((file) => /^[A-Za-z0-9_-]+\.md$/u.test(file)));
  assert.ok(rootFiles.has("README.md"));
  // Names that match a root file but are not reads of it (checked by a person; add nothing here blindly).
  const notReads = new Set([
    "src/features/ai-audit/exportBundle.ts::README.md", // a zip entry name the export bundle writes
    "src/features/ai-audit/exportBundle.test.ts::README.md", // the same zip entry, read back from the archive
    "src/features/legal/constants.test.ts::LICENSING.md", // a phrase the bundled Terms must contain, not a read of the file
  ]);
  const found = new Map();
  for (const file of scanned) {
    for (const line of withoutCommentLines(await readFile(path.join(repoRoot, file), "utf8"))) {
      for (const match of line.matchAll(literal)) {
        const concrete = match[1].replace(/^(?:\.{1,2}\/)+/u, "").replace(/\$\{[^}]*\}/gu, "x");
        if (!found.has(concrete)) found.set(concrete, file);
      }
      for (const match of line.matchAll(rootMarkdown)) {
        if (rootFiles.has(match[1]) && !notReads.has(`${file}::${match[1]}`) && !found.has(match[1])) found.set(match[1], file);
      }
    }
  }
  for (const expected of ["docs/lp/lp-variant-h.jsx", "docs/lp/assets", "docs/lp/assets/lp-app.js", "docs/screenshots/generated", "public/TERMS_x.md"]) {
    assert.ok(found.has(expected), `the scan must find ${expected}`);
  }
  for (const [concrete, file] of found) {
    for (const candidate of literalCandidates(concrete, { directoryChildren: true })) {
      assert.equal(lanesFor([candidate]).frontend, true, `${candidate} (read in ${file})`);
      assert.equal(lanesFor(["docs/a.md", candidate]).frontend, true, `docs + ${candidate} (read in ${file})`);
    }
  }
  // The web editor artifact check scans the .md files vite copies from public/ into dist/.
  assert.equal(lanesFor(["public/RELEASE_NOTES/v2.0.0.ja.md"]).frontend, true);
  // Other root and docs markdown is not read by any frontend job.
  assert.equal(lanesFor(["README.md", "docs/plans/a.md", "experiments/x.py"]).frontend, false);
});

test("Gate A2's JS tests also run in jobs the renderer-code skip leaves running, and the frontend lane runs for every non-docs change", async () => {
  // Gate A2 (migration lane) runs two JS commands besides cargo. A renderer-only change skips the migration lane, so the
  // same files must be run by another job that this change still reaches. The closure of these tests lies in
  // `src` (renderer code the migration lane no longer sees) and in electron (forced for every lane).
  const a2 = jobOf("migration-recovery-gate");
  const commands = a2.steps
    .map((step) => String(step.run ?? "").replace(/\s+/gu, " ").trim())
    .filter((command) => /^pnpm test(?::electron)? --run /u.test(command));
  assert.deepEqual(commands, [
    "pnpm test:electron --run electron/shared/ipcContract.test.ts",
    "pnpm test --run src/features/workspace/store.test.ts src/features/workspace/recovery/RecoveryShell.test.tsx",
  ]);
  const electronFiles = ["electron/shared/ipcContract.test.ts"];
  const srcFiles = ["src/features/workspace/store.test.ts", "src/features/workspace/recovery/RecoveryShell.test.tsx"];
  for (const file of [...electronFiles, ...srcFiles]) assert.ok(await isFile(path.join(repoRoot, file)), file);

  // `pnpm test` is plain vitest: the default config is vitest.config.ts, whose include/exclude select the src tests.
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.match(pkg.scripts.test, /&& vitest$/u);
  const unitConfig = await readFile(path.join(repoRoot, "vitest.config.ts"), "utf8");
  assert.match(unitConfig, /include:\s*\["src\/\*\*\/\*\.test\.\{ts,tsx\}"\]/u);
  assert.match(unitConfig, /exclude:\s*\["src\/\*\*\/\*\.browser\.test\.\{ts,tsx\}"\]/u);
  for (const file of srcFiles) {
    assert.match(file, /^src\/.*\.test\.tsx?$/u, file);
    assert.doesNotMatch(file, /\.browser\.test\.tsx?$/u, file);
  }
  const frontendUnit = jobOf("frontend-unit");
  assert.ok(frontendUnit.steps.some((step) => /^pnpm test:node --run\b/u.test(String(step.run ?? ""))));
  assert.equal(stripScopeGate(frontendUnit.if).lane, "frontend");

  // `pnpm test:electron` is vitest.electron.config.ts; the electron job runs it whole and is not behind any lane.
  const electronConfig = await readFile(path.join(repoRoot, "vitest.electron.config.ts"), "utf8");
  assert.match(electronConfig, /include:\s*\["electron\/\{main,preload,shared\}\/\*\*\/\*\.test\.ts"\]/u);
  for (const file of electronFiles) assert.match(file, /^electron\/(?:main|preload|shared)\/.*\.test\.ts$/u);
  const electronJob = jobOf("electron");
  const electronTestStep = electronJob.steps.find((step) => String(step.run ?? "").trim() === "pnpm test:electron --run");
  assert.ok(electronTestStep);
  // The step runs on a pull request with the default inputs (its own `if`, and the job's).
  assert.equal(evaluateIf(electronTestStep.if, { inputs: defaultsFromDispatch, event: "pull_request" }), true);
  assert.equal(evaluateIf(electronJob.if, { inputs: defaultsFromDispatch, event: "pull_request" }), true);
  assert.equal(stripScopeGate(electronJob.if).gated, false);
  assert.ok(ALWAYS_RUN_JOBS.includes("electron"));
  for (const file of electronFiles) {
    assert.deepEqual(lanesFor([file]), ALL_RUN, file);
    assert.deepEqual(lanesFor(["docs/a.md", file]), ALL_RUN, `docs + ${file}`);
  }

  // The frontend lane runs for these files, alone and beside docs, and for every file of their import closure under src.
  const closure = await importClosure([...electronFiles, ...srcFiles].map((file) => path.join(repoRoot, file)));
  assert.deepEqual(closure.unresolved, []);
  assert.ok(closure.files.includes("src/features/workspace/store.ts"));
  assert.ok(closure.files.length >= 100, `closure has only ${closure.files.length} files`);
  for (const file of [...srcFiles, ...closure.files.filter((candidate) => candidate.startsWith("src/"))]) {
    assert.equal(lanesFor([file]).frontend, true, file);
    assert.equal(lanesFor(["docs/a.md", file]).frontend, true, `docs + ${file}`);
  }
  // The only change that skips the frontend lane is docs only, which Gate A2 does not cover either.
  const docsOnly = lanesFor(["docs/a.md"]);
  assert.equal(docsOnly.frontend, false);
  assert.equal(docsOnly.migration, false);
});

test("the lfm lane trigger is the lfm job's own working directory", () => {
  const job = jobOf("lfm-encoder-phase0");
  const directory = job.defaults.run["working-directory"];
  assert.equal(directory, "experiments/lfm25-encoder-phase0");
  assert.deepEqual(rawRules.lanes.lfm.triggers, [`${directory}/**`]);
  assert.deepEqual(rawRules.lanes.lfm.gatedJobs, ["lfm-encoder-phase0"]);
  assert.equal(lanesFor([`${directory}/README.md`]).lfm, true);
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
    const decision = await decideForEvent({
      rules,
      event: "pull_request",
      loadBaseRules: async () => null,
      ...options,
    });
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
  const clone = () => structuredClone(rawRules);
  const broken = [
    (rules) => { rules.version = 2; },
    (rules) => { rules.forceAll = []; },
    (rules) => { rules.lanes.rust.neutral = ["missing-set"]; },
    (rules) => { rules.lanes.frontend.neutral = ["missing-set"]; },
    (rules) => { rules.lanes.frontend.neverNeutral = ["docs/{a,b}/**"]; },
    (rules) => { delete rules.lanes.frontend.gatedJobs; },
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
// `rust-aggregate` needs `rust`: when `rust` is not admitted it is skipped and
// the aggregate's `needs.rust.result != 'skipped'` keeps the aggregate out too.
// The `frontend` aggregate does the same with `frontend-static`.
// The result fed to each aggregate is derived from the admission of its first child itself.
const MODELLED_CASCADE_JOBS = ["rust-aggregate", "frontend"];
const resultOf = (id, inputs, event, changes) =>
  evaluateIf(ci.jobs[id].if, { inputs, event, changes }) ? "success" : "skipped";
const admitted = (inputs, event, changes) => {
  const rustResult = resultOf("rust", inputs, event, changes);
  const staticResult = resultOf("frontend-static", inputs, event, changes);
  return Object.keys(ci.jobs).filter((id) => evaluateIf(ci.jobs[id].if, { inputs, event, changes, rustResult, staticResult }));
};
const admittedOriginals = (inputs, event) => {
  const rustResult = evaluateIf(originalOf("rust"), { inputs, event }) ? "success" : "skipped";
  const staticResult = evaluateIf(originalOf("frontend-static"), { inputs, event }) ? "success" : "skipped";
  return Object.keys(ci.jobs).filter((id) => evaluateIf(originalOf(id), { inputs, event, rustResult, staticResult }));
};

test("with empty or all-true change scope outputs every job is admitted exactly as before the gate", () => {
  for (const event of EVENTS) {
    for (const inputs of INPUT_SETS) {
      const expected = admittedOriginals(inputs, event);
      const label = `${event} ${JSON.stringify(inputs)}`;
      // Empty outputs model a skipped `changes` job only. A job-level failure
      // would also skip the shard/aggregate/runtime-performance dependents,
      // which this evaluator does not model (the job is built not to fail).
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
    // `rust-aggregate` and `frontend` are cascade jobs this evaluator models: each follows the
    // admission of its lane's gated job, so it drops with its lane.
    assert.deepEqual(
      baseline.filter((id) => !dropped.includes(id)).sort(),
      [...definition.gatedJobs, ...(definition.cascadeJobs ?? []).filter((id) => MODELLED_CASCADE_JOBS.includes(id))].sort(),
      lane,
    );
    assert.deepEqual(dropped.filter((id) => !baseline.includes(id)), [], lane);
  }
  // Every lane false: only the always-run jobs, the cascade jobs (which skip
  // through needs on GitHub, outside this evaluator; the modelled
  // `rust-aggregate` is skipped with `rust`) and `changes` remain.
  const noLanes = admitted(inputs, "pull_request", Object.fromEntries(LANES.map((lane) => [lane, "false"])));
  // Runtime performance is not a pull request check, so the pull request never
  // admits it; every other cascade job (shards, aggregate) must still be admitted.
  const PULL_REQUEST_EXCLUDED_CASCADE_JOBS = ["electron-runtime-performance"];
  assert.deepEqual(
    baseline.filter((id) => PULL_REQUEST_EXCLUDED_CASCADE_JOBS.includes(id)),
    [],
  );
  const cascadeJobs = Object.values(rawRules.lanes)
    .flatMap((definition) => definition.cascadeJobs ?? [])
    .filter((id) => !PULL_REQUEST_EXCLUDED_CASCADE_JOBS.includes(id) && !MODELLED_CASCADE_JOBS.includes(id));
  assert.deepEqual(
    [...noLanes].sort(),
    [...ALWAYS_RUN_JOBS, "changes", ...cascadeJobs].sort(),
  );
});

test("a false frontend output skips both Frontend jobs and the aggregate; only a lane run keeps the check", () => {
  const inputs = defaultsFromDispatch;
  const FRONTEND = ["frontend-static", "frontend-unit", "frontend"];
  const off = admitted(inputs, "pull_request", { ...ALL_TRUE_OUTPUTS, frontend: "false" });
  for (const id of FRONTEND) assert.ok(!off.includes(id), `${id} must skip with the lane`);
  const on = admitted(inputs, "pull_request", ALL_TRUE_OUTPUTS);
  for (const id of FRONTEND) assert.ok(on.includes(id), `${id} must run with the lane`);
  // A skipped `changes` job (a standalone canonical profile or independent gates) and every non-pull-request event keep the jobs
  // where they were before the lane existed.
  // (A reusable call from release.yml inherits the caller's `push` event, so `push` covers it.)
  for (const event of ["push", "workflow_dispatch"]) {
    const ran = admitted(inputs, event, {});
    for (const id of FRONTEND) assert.ok(ran.includes(id), `${event}: ${id}`);
  }
  // The aggregate itself: skipped when its first child is skipped, run (and judged by its fail-closed step) otherwise.
  const aggregate = jobOf("frontend");
  assert.equal(stripScopeGate(aggregate.if).gated, false);
  assert.match(aggregate.if, /&& needs\.frontend-static\.result != 'skipped' \}\}$/u);
  for (const [staticResult, expected] of [["skipped", false], ["success", true], ["failure", true], ["cancelled", true]]) {
    assert.equal(evaluateIf(aggregate.if, { inputs, event: "pull_request", staticResult }), expected, staticResult);
  }
  // Fail closed: the aggregate's step is red unless both children succeeded (a skipped child included).
  const verify = aggregate.steps.find((step) => /STATIC_RESULT/u.test(String(step.run)));
  assert.match(verify.run, /\[ "\$STATIC_RESULT" != "success" \] \|\| \[ "\$UNIT_RESULT" != "success" \]/u);
  assert.match(verify.run, /exit 1/u);
  // A standalone canonical profile or independent gates run excludes the Frontend jobs, as before.
  for (const excluded of [{ ...inputs, canonical_profile: "shared-rust" }, { ...inputs, source_focused: true }]) {
    assert.deepEqual(admitted(excluded, "workflow_dispatch", {}).filter((id) => FRONTEND.includes(id)), []);
  }
});

test("runtime performance is not a pull request check and is unchanged for every other event", () => {
  // The guard before the pull request was excluded; only the event may differ.
  const beforeGuard =
    "github.event_name != 'schedule' && !inputs.source_focused && !inputs.source_canonical_contracts && !inputs.canonical_profile && !inputs.candidate_base && !inputs.candidate_head && !inputs.max_parallel_tasks && !inputs.independent_gates";
  const job = jobOf("electron-runtime-performance");
  assert.equal(job.needs, "electron-product-journeys-build");
  assert.equal(stripScopeGate(job.if).gated, false, "a cascade job never names the change scope");
  for (const event of EVENTS) {
    for (const inputs of INPUT_SETS) {
      const label = `${event} ${JSON.stringify(inputs)}`;
      assert.equal(
        evaluateIf(job.if, { inputs, event }),
        evaluateIf(beforeGuard, { inputs, event }) && event !== "pull_request",
        label,
      );
    }
  }
  // Spelled out for the default dispatch inputs: pull_request is the only event that changes.
  const truth = Object.fromEntries(
    EVENTS.map((event) => [event, evaluateIf(job.if, { inputs: defaultsFromDispatch, event })]),
  );
  assert.deepEqual(truth, {
    push: true,
    schedule: false,
    workflow_dispatch: true,
    workflow_call: true,
    pull_request: false,
  });
});

test("a false output never reaches a standalone canonical profile or an independent gates run", () => {
  // `changes` is skipped for these, so its outputs are empty and the selected
  // jobs must still run (and `!cancelled()` keeps them from being skipped).
  const standalone = { ...defaultsFromDispatch, canonical_profile: "shared-rust" };
  assert.deepEqual(admitted(standalone, "workflow_dispatch", {}), ["rust", "rust-aggregate"]);
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
    // `{}` is a `changes` job that was skipped. A `changes` job that failed as
    // a whole is not modeled here: it keeps the journey roots running (`!cancelled()`)
    // but skips the shard/aggregate dependents, which is why the job is built
    // not to fail (see the changes job test) and why the docs name that loss.
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

/** The job summary's last section lists the final lane lines the jobs read. */
function assertFinalOutputsSummary(summary, finalOutputs, label) {
  const section = summary.slice(summary.lastIndexOf("### Final outputs"));
  assert.match(section, /^### Final outputs/u, label);
  assert.match(section, /authoritative/u, label);
  const fenced = /```\n([^`]*)```/u.exec(section);
  assert.ok(fenced, `${label}: final outputs must be fenced`);
  assert.equal(fenced[1], `${LANES.map((lane) => `${lane}=${finalOutputs[lane]}`).join("\n")}\n`, label);
}

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
    assert.equal(record.baseRules, "absent");
    for (const lane of LANES) assert.equal(String(record.lanes[lane].run), result.outputs[lane], lane);
    assertFinalOutputsSummary(result.summary, result.outputs, "docs-only");
    // The evidence lives outside the checkout so it can never become a changed path.
    await assert.rejects(access(path.join(repo, "ci-change-scope.json")));
  });
});

test("the workflow step runs every lane but lfm for an unclassified source change, and also skips Rust and Gate A2 for renderer code", async () => {
  await withTemp(async (root) => {
    const { repo, base, head } = await makeRepository(
      root,
      { "docs/a.md": "one\n", "src/a.json": "{}\n", "src/a.ts": "export {};\n" },
      { "src/a.json": "{\"a\":1}\n" },
    );
    const result = await runScopeStep({ root, repo, event: "pull_request", base, head });
    // A src JSON file is not renderer code: Rust crates read such fixtures, so rust and migration run.
    assert.deepEqual(asBooleans(result.outputs), { ...ALL_TRUE_STRINGS, lfm: "false" });
  });
  await withTemp(async (root) => {
    const { repo, base, head } = await makeRepository(
      root,
      { "docs/a.md": "one\n", "src/a.ts": "export {};\n" },
      { "src/a.ts": "export const a = 1;\n" },
    );
    const result = await runScopeStep({ root, repo, event: "pull_request", base, head });
    assert.deepEqual(asBooleans(result.outputs), { ...ALL_TRUE_STRINGS, lfm: "false", rust: "false", migration: "false" });
    assertFinalOutputsSummary(result.summary, result.outputs, "renderer code only");
  });
  // A docs-only diff (LP assets and release notes excepted) now skips the Frontend jobs too; those two paths keep them.
  for (const [changed, frontend] of [["docs/lp/lp-variant-h.jsx", "true"], ["public/TERMS_ja.md", "true"], ["docs/guide.md", "false"]]) {
    await withTemp(async (root) => {
      const { repo, base, head } = await makeRepository(root, { [changed]: "one\n" }, { [changed]: "two\n" });
      const result = await runScopeStep({ root, repo, event: "pull_request", base, head });
      assert.equal(result.outputs.frontend, frontend, changed);
    });
  }
});

test("the workflow step never lets a pull request's own decision code or workflow judge it", async () => {
  await withTemp(async (root) => {
    for (const changed of [
      "scripts/ci-change-scope.mjs",
      "scripts/impact/core.mjs",
      ".github/workflows/ci.yml",
    ]) {
      const { repo, base, head } = await makeRepository(
        path.join(root, changed.replaceAll("/", "_")),
        { "docs/a.md": "one\n", [changed]: "// base\n" },
        { "docs/a.md": "two\n", [changed]: "// head\n" },
      );
      // A stand-in "script" that would skip everything must not even be consulted.
      const result = await runScopeStep({
        root: path.join(root, changed.replaceAll("/", "_")),
        repo,
        event: "pull_request",
        base,
        head,
        command: `printf '${LANES.map((lane) => `${lane}=false`).join("\\n")}\\n'`,
      });
      // All nine lanes, frontend included, run: this is the only observation of the shell guard for the new lane.
      assert.deepEqual(asBooleans(result.outputs), ALL_TRUE_STRINGS, changed);
      assertFinalOutputsSummary(result.summary, result.outputs, changed);
    }
    // Control: with only docs changed, the same stand-in script is consulted and skips.
    const control = await makeRepository(path.join(root, "control"), { "docs/a.md": "one\n" }, { "docs/a.md": "two\n" });
    const skipped = await runScopeStep({
      root: path.join(root, "control"),
      repo: control.repo,
      event: "pull_request",
      base: control.base,
      head: control.head,
      command: `printf '${LANES.map((lane) => `${lane}=false`).join("\\n")}\\n'`,
    });
    assert.deepEqual(asBooleans(skipped.outputs), Object.fromEntries(LANES.map((lane) => [lane, "false"])));
  });
});

test("every step of the changes job has its own timeout inside the job's timeout", () => {
  const job = ci.jobs.changes;
  let total = 0;
  for (const step of job.steps) {
    assert.ok(Number.isInteger(step["timeout-minutes"]) && step["timeout-minutes"] > 0, step.name);
    assert.equal(step["continue-on-error"], true, step.name);
    total += step["timeout-minutes"];
  }
  assert.ok(total < job["timeout-minutes"], `step timeouts ${total} must stay below the job timeout ${job["timeout-minutes"]}`);
});

test("the workflow scope step runs every lane for push, schedule, dispatch and call without diffing (its own step; the crossos step is separate)", async () => {
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
      "duplicate lane": { command: lanesOutput([...allFalse.slice(0, LANES.length - 1), allFalse[0]]) },
      "garbage": { command: "echo 'journeys=false rust=false'" },
      "crash after output": { command: `${lanesOutput(allFalse)}; exit 3` },
    };
    // A script that wrote its own record and summary (saying "skipped") and then died.
    const staleThenCrash = `sh -c 'printf "{\\"stale\\":true}\\n" > "$RUNNER_TEMP/ci-change-scope.json"; printf "## Change scope\\nall skipped\\n" >> "$GITHUB_STEP_SUMMARY"; printf "${allFalse.join("\\n")}\\n"; exit 3' --`;
    attempts["stale evidence then crash"] = { command: staleThenCrash };
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
      // The summary ends with the final outputs, and the JSON artifact holds the
      // final values rather than whatever a failed script left behind.
      assertFinalOutputsSummary(result.summary, ALL_TRUE_STRINGS, label);
      const record = JSON.parse(await readFile(path.join(result.files.temp, "ci-change-scope.json"), "utf8"));
      assert.equal(record.allSelected, true, label);
      assert.equal(record.stale, undefined, label);
      assert.deepEqual(Object.keys(record.lanes), LANES, label);
      for (const lane of LANES) assert.equal(record.lanes[lane].run, true, `${label}: ${lane}`);
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

// ---------------------------------------------------------------------------
// The base commit's rules: a pull request cannot skip a lane with its own edit
// of the rules.
// ---------------------------------------------------------------------------

/** Head rules that no longer treat the rules file itself as a forced-all path and make it CI-neutral. */
function weakenedRules() {
  const weakened = structuredClone(rawRules);
  weakened.forceAll = weakened.forceAll.filter((glob) => glob !== "scripts/ci-change-scope.*");
  weakened.sets["ci-and-ai"] = [...weakened.sets["ci-and-ai"], "scripts/ci-change-scope.*"];
  return weakened;
}

const SHA = "a".repeat(40);
const pullRequestRun = async (options) => {
  const decision = await decideForEvent({ event: "pull_request", base: SHA, head: SHA, ...options });
  return { decision, lanes: Object.fromEntries(LANES.map((lane) => [lane, decision.lanes[lane].run])) };
};
const collectPaths = (paths) => async () => ({ paths, complete: true, reason: "Complete Git diff." });

test("a pull request that weakens the rules cannot skip a lane the base commit's rules run", async () => {
  const headRules = compileScopeRules(weakenedRules());
  const collect = collectPaths(["scripts/ci-change-scope.json"]);
  // Control: judged by its own rules alone, the edit skips everything but journeys and frontend
  // (the weakened rules make it CI-neutral, and the frontend lane's neutral set is docs only).
  const alone = await pullRequestRun({ rules: headRules, collect, loadBaseRules: async () => null });
  assert.deepEqual(alone.lanes, only(["journeys", "frontend"]));
  assert.equal(alone.decision.baseRules, "absent");
  // With the base commit's rules, the rules file is a forced-all path.
  const combined = await pullRequestRun({ rules, collect, loadBaseRules: async () => rules });
  assert.deepEqual(combined.lanes, ALL_RUN);
  const merged = await pullRequestRun({ rules: headRules, collect, loadBaseRules: async () => rules });
  assert.deepEqual(merged.lanes, ALL_RUN);
  assert.equal(merged.decision.allSelected, true);
  assert.equal(merged.decision.reasonKind, "policy-all");
  assert.match(merged.decision.reason, /^Base commit rules: /u);
  assert.deepEqual(merged.decision.forcedPaths, ["scripts/ci-change-scope.json"]);
  assert.equal(merged.decision.baseRules, "combined");
});

test("each lane runs when either the head rules or the base commit's rules run it", async () => {
  const collect = collectPaths(["scripts/quality/x.mjs"]);
  // Base rules that keep Rust strict, drop the security lane and agree elsewhere.
  const baseRaw = structuredClone(rawRules);
  baseRaw.lanes.rust.neutral = ["docs"];
  delete baseRaw.lanes.security;
  const baseRules = compileScopeRules(baseRaw);
  const loadBaseRules = async () => baseRules;
  // Control: the head rules alone skip every lane except journeys and frontend.
  assert.deepEqual((await pullRequestRun({ rules, collect, loadBaseRules: async () => null })).lanes, only(["journeys", "frontend"]));
  const { decision, lanes } = await pullRequestRun({ rules, collect, loadBaseRules });
  assert.deepEqual(lanes, only(["journeys", "rust", "security", "frontend"]));
  assert.match(decision.lanes.rust.reason, /^Base commit rules: /u);
  assert.match(decision.lanes.security.reason, /do not know this lane/u);
  assert.match(decision.lanes.browser.reason, /The base commit's rules agree\.$/u);
  assert.equal(decision.allSelected, false);
  assert.equal(decision.reasonKind, "classified");
  // A head decision that runs a lane is never turned off by the base rules.
  const loose = structuredClone(rawRules);
  loose.sets["ci-and-ai"] = ["scripts/quality/**", ".agents/**", ".claude/**", "policies/quality/**", "evals/impact-map.yaml", "scripts/other/**"];
  const looseRules = compileScopeRules(loose);
  const stricter = await pullRequestRun({ rules, collect: collectPaths(["scripts/other/a.mjs"]), loadBaseRules: async () => looseRules });
  assert.deepEqual(stricter.lanes, { ...ALL_RUN, lfm: false });
  // Control: the loose rules alone would have skipped these lanes.
  const looseAlone = await pullRequestRun({ rules: looseRules, collect: collectPaths(["scripts/other/a.mjs"]), loadBaseRules: async () => null });
  assert.deepEqual(looseAlone.lanes, only(["journeys", "frontend"]));
});

test("base rules that cannot be read or trusted run every lane, and head rules that already run everything skip the lookup", async () => {
  const collect = collectPaths(["docs/a.md"]);
  const failures = {
    "git failed": async () => { throw new Error("fatal: bad object"); },
    "rules do not compile": async () => compileScopeRules({ version: 1 }),
  };
  // Control: with no base rules the docs-only diff skips.
  assert.deepEqual((await pullRequestRun({ rules, collect, loadBaseRules: async () => null })).lanes, only([]));
  for (const [label, loadBaseRules] of Object.entries(failures)) {
    const { decision, lanes } = await pullRequestRun({ rules, collect, loadBaseRules });
    assert.deepEqual(lanes, ALL_RUN, label);
    assert.equal(decision.reasonKind, "error", label);
  }
  const lookups = [];
  const forced = await pullRequestRun({
    rules,
    collect: collectPaths([".github/workflows/ci.yml"]),
    loadBaseRules: async () => { lookups.push("called"); return rules; },
  });
  assert.deepEqual(forced.lanes, ALL_RUN);
  assert.deepEqual(lookups, []);
  assert.equal(forced.decision.baseRules, "not-needed");
});

test("loadBaseScopeRules tells a base commit without the file from a git failure or an untrusted entry", async () => {
  await withTemp(async (root) => {
    const repo = path.join(root, "repo");
    await mkdir(path.join(repo, "scripts"), { recursive: true });
    await git(repo, "init", "-q");
    const commit = async (message) => {
      await git(repo, "add", "-A");
      await git(repo, "commit", "-q", "-m", message);
      return (await git(repo, "rev-parse", "HEAD")).stdout.trim();
    };
    const rulesFile = path.join(repo, "scripts/ci-change-scope.json");
    await writeFile(path.join(repo, "README.md"), "x\n");
    const without = await commit("no rules");
    await writeFile(rulesFile, JSON.stringify(rawRules));
    const regular = await commit("regular file");
    await writeFile(rulesFile, "{ not json");
    const garbled = await commit("garbled");
    await writeFile(rulesFile, JSON.stringify({ version: 1 }));
    const incomplete = await commit("incomplete rules");
    await rm(rulesFile);
    await symlink("../README.md", rulesFile);
    const linked = await commit("symlink");

    assert.equal(await loadBaseScopeRules({ repoRoot: repo, base: without }), null);
    const loaded = await loadBaseScopeRules({ repoRoot: repo, base: regular });
    assert.deepEqual(laneNames(loaded), LANES);
    for (const base of [garbled, incomplete, linked, "0".repeat(40), "no-such-ref", "-x", ""]) {
      await assert.rejects(loadBaseScopeRules({ repoRoot: repo, base }), undefined, JSON.stringify(base));
    }
    // From a subdirectory the path is still relative to the repository root.
    assert.deepEqual(
      laneNames(await loadBaseScopeRules({ repoRoot: path.join(repo, "scripts"), base: regular })),
      LANES,
    );
  });
});

test("the workflow step applies the base commit's rules read from git, not the checkout's", async () => {
  await withTemp(async (root) => {
    const weakPath = path.join(root, "weak-head-rules.json");
    await writeFile(weakPath, JSON.stringify(weakenedRules()));
    const command = `"${process.execPath}" "${scriptPath}" --rules "${weakPath}"`;
    // The base commit carries the real rules; the head commit rewrites the file.
    const { repo, base, head } = await makeRepository(
      root,
      { "scripts/ci-change-scope.json": JSON.stringify(rawRules), "docs/a.md": "one\n" },
      { "scripts/ci-change-scope.json": JSON.stringify(weakenedRules()) },
    );
    const strict = await runScopeStep({ root, repo, event: "pull_request", base, head, command });
    assert.deepEqual(asBooleans(strict.outputs), ALL_TRUE_STRINGS);
    const record = JSON.parse(await readFile(path.join(strict.files.temp, "ci-change-scope.json"), "utf8"));
    assert.equal(record.baseRules, "combined");
    assert.match(record.reason, /^Base commit rules: /u);
    assert.match(strict.summary, /combined with the base commit's copy/u);
    assertFinalOutputsSummary(strict.summary, ALL_TRUE_STRINGS, "strict base");

    // Control: when the base commit has no rules file, the head's weakened rules decide alone.
    await rm(path.join(root, "repo"), { recursive: true, force: true });
    const bare = await makeRepository(
      root,
      { "docs/a.md": "one\n" },
      { "scripts/ci-change-scope.json": JSON.stringify(weakenedRules()) },
    );
    const alone = await runScopeStep({ root, repo: bare.repo, event: "pull_request", base: bare.base, head: bare.head, command });
    assert.deepEqual(asBooleans(alone.outputs), { ...Object.fromEntries(LANES.map((lane) => [lane, "false"])), journeys: "true", frontend: "true" });
    assert.equal(JSON.parse(await readFile(path.join(alone.files.temp, "ci-change-scope.json"), "utf8")).baseRules, "absent");
    assert.match(alone.summary, /base commit has no/u);
  });
});

// ---------------------------------------------------------------------------
// GitHub compares strings case-insensitively, `needs.*` included.
// ---------------------------------------------------------------------------

test("a needs output of any casing of false skips the job, and anything else runs it", () => {
  const wrapped = "${{ !cancelled() && (github.event_name != 'schedule') && needs.changes.outputs.browser != 'false' }}";
  const outcome = (value) => evaluateIf(wrapped, { event: "pull_request", changes: { browser: value } });
  for (const skipped of ["false", "FALSE", "False", "fAlSe"]) assert.equal(outcome(skipped), false, skipped);
  for (const runs of ["true", "TRUE", "", " false", "False ", "0", undefined]) assert.equal(outcome(runs), true, String(runs));
});

// ---------------------------------------------------------------------------
// What `base...head` means, against real git history.
// ---------------------------------------------------------------------------

async function newHistory(root) {
  const repo = path.join(root, "history");
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
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
  return { repo, commit };
}

const longBody = "export const value = 'long enough for git to see the same file after a move';\n".repeat(20);
const names = async (repo, ...args) => (await git(repo, "diff", "--name-only", ...args)).stdout.split("\n").filter(Boolean).sort();
const decideReal = async (repo, base, head) => {
  const decision = await decideForEvent({ rules, event: "pull_request", base, head, repoRoot: repo });
  return { decision, lanes: Object.fromEntries(LANES.map((lane) => [lane, decision.lanes[lane].run])) };
};

test("a rename from a neutral path to a docs path (or back) counts the neutral side, and a rename within docs does not", async () => {
  await withTemp(async (root) => {
    const { repo, commit } = await newHistory(root);
    const base = await commit({ "src/a.ts": longBody, "docs/keep.md": "keep\n", "docs/b.ts": longBody.replace("value", "other") }, "base");
    await git(repo, "mv", "src/a.ts", "docs/a.ts");
    const head = await commit({}, "move out of src");
    // Control: git reports one rename, not an add and a delete.
    assert.match((await git(repo, "diff", "--name-status", "--find-renames", `${base}...${head}`)).stdout, /^R\d+\tsrc\/a\.ts\tdocs\/a\.ts\n$/u);
    const out = await decideReal(repo, base, head);
    assert.deepEqual(out.decision.changedPaths, ["docs/a.ts", "src/a.ts"]);
    // src/a.ts is renderer code (no Rust crate reads it), so rust and migration skip; the docs side alone never decides a lane.
    assert.deepEqual(out.lanes, { ...ALL_RUN, lfm: false, rust: false, migration: false });

    // The same move back into src: the docs side is neutral, the src side is not.
    const back = await decideReal(repo, head, await (async () => {
      await git(repo, "mv", "docs/a.ts", "src/a.ts");
      return commit({}, "move back");
    })());
    assert.deepEqual(back.decision.changedPaths, ["docs/a.ts", "src/a.ts"]);
    assert.deepEqual(back.lanes, { ...ALL_RUN, lfm: false, rust: false, migration: false });

    // Control: a rename inside docs touches only neutral paths, so every lane skips.
    const before = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
    await git(repo, "mv", "docs/b.ts", "docs/c.ts");
    const inside = await decideReal(repo, before, await commit({}, "rename in docs"));
    assert.deepEqual(inside.decision.changedPaths, ["docs/b.ts", "docs/c.ts"]);
    assert.deepEqual(inside.lanes, only([]));
  });
});

test("the diff is the merge-base diff: changes that landed on the base branch after the branch point are not the pull request's", async () => {
  await withTemp(async (root) => {
    const { repo, commit } = await newHistory(root);
    await commit({ "docs/a.md": "one\n", "src/a.ts": "export {};\n" }, "common ancestor");
    await git(repo, "checkout", "-q", "-b", "pr");
    const head = await commit({ "docs/a.md": "two\n" }, "docs only");
    await git(repo, "checkout", "-q", "main");
    const base = await commit({ "src/a.ts": "export const changedOnMain = 1;\n" }, "main moved on");
    await git(repo, "checkout", "-q", "pr");
    // Control: a two-dot diff would charge the pull request with main's source change.
    assert.deepEqual(await names(repo, base, head), ["docs/a.md", "src/a.ts"]);
    const out = await decideReal(repo, base, head);
    assert.deepEqual(out.decision.changedPaths, ["docs/a.md"]);
    assert.deepEqual(out.lanes, only([]));
  });
});

test("a pull request that merged the base branch is judged by its own changes, before and after the base moves on", async () => {
  await withTemp(async (root) => {
    const { repo, commit } = await newHistory(root);
    await commit({ "docs/a.md": "one\n", "src/a.ts": "export {};\n", "src/b.ts": "export {};\n" }, "common ancestor");
    await git(repo, "checkout", "-q", "-b", "pr");
    await commit({ "docs/a.md": "two\n" }, "docs only");
    await git(repo, "checkout", "-q", "main");
    const merged = await commit({ "src/a.ts": "export const fromMain = 1;\n" }, "main change merged into the pull request");
    await git(repo, "checkout", "-q", "pr");
    await git(repo, "merge", "--no-ff", "-m", "merge main", "main");
    const head = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
    // Control: against the ancestor, the same head carries main's change too.
    const ancestor = (await git(repo, "rev-list", "--max-parents=0", "HEAD")).stdout.trim();
    assert.deepEqual(await names(repo, `${ancestor}...${head}`), ["docs/a.md", "src/a.ts"]);

    const upToDate = await decideReal(repo, merged, head);
    assert.deepEqual(upToDate.decision.changedPaths, ["docs/a.md"]);
    assert.deepEqual(upToDate.lanes, only([]));

    // Main moves on again after the merge: the base is newer, the merge-base is still `merged`.
    await git(repo, "checkout", "-q", "main");
    const later = await commit({ "src/b.ts": "export const laterOnMain = 1;\n" }, "main moved on after the merge");
    await git(repo, "checkout", "-q", "pr");
    assert.deepEqual(await names(repo, later, head), ["docs/a.md", "src/b.ts"]);
    const behind = await decideReal(repo, later, head);
    assert.deepEqual(behind.decision.changedPaths, ["docs/a.md"]);
    assert.deepEqual(behind.lanes, only([]));
  });
});
