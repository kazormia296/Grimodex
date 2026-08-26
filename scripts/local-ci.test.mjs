import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

import {
  buildLocalCiPlan,
  parseLocalCiArgs,
  prepareLocalCiArtifacts,
  resolveLocalCiCandidate,
  runLocalCiPlan,
  validateLocalCiCandidate,
  validateLocalCiRegistry,
  verifyLocalCiReceipt,
} from "./local-ci.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function read(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

async function readRegistry() {
  return JSON.parse(await read("scripts/local-ci-registry.json"));
}

function completeCandidate(overrides = {}) {
  return {
    requestedBase: "origin/master",
    requestedHead: "HEAD",
    resolvedBaseSha: "a".repeat(40),
    resolvedHeadSha: "b".repeat(40),
    resolvedHeadTreeSha: "c".repeat(40),
    currentHeadSha: "b".repeat(40),
    worktreeClean: true,
    worktreeFingerprint:
      "47b2eeb99ef8e6aa14da7a4d2afa2ad06491c1355288e6d44fcb5717ceebc232",
    worktreeStatusHash:
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ...overrides,
  };
}

test("local CI registry accounts for every hosted Full CI job", async () => {
  const registry = await readRegistry();
  const workflow = yaml.load(await read(".github/workflows/ci.yml"));

  validateLocalCiRegistry(registry);
  assert.deepEqual(
    Object.keys(registry.hostedJobs).sort(),
    Object.keys(workflow.jobs).sort(),
  );

  for (const [jobId, coverage] of Object.entries(registry.hostedJobs)) {
    if (coverage.releaseOnly) {
      assert.match(coverage.reason, /Windows|release/i, jobId);
      continue;
    }
    assert.ok(
      registry.profiles.full.includes(coverage.localStage),
      `${jobId} must map to a stage in the full local profile`,
    );
  }
});

test("quick and full profiles resolve deterministic command plans", async () => {
  const registry = await readRegistry();
  assert.equal(
    registry.stages["electron-product-journeys"].env.CI,
    "true",
    "local product journeys must activate the same unpackaged CI seam as hosted CI",
  );
  const quick = buildLocalCiPlan(registry, {
    profile: "quick",
    base: "origin/master",
    head: "HEAD",
  });
  const full = buildLocalCiPlan(registry, {
    profile: "full",
    base: "origin/master",
    head: "HEAD",
  });

  assert.deepEqual(
    quick.stages.map((stage) => stage.id),
    ["impact"],
  );
  assert.deepEqual(
    full.stages.map((stage) => stage.id),
    registry.profiles.full,
  );
  assert.deepEqual(
    full.stages.find((stage) => stage.id === "browser").commands[0].args,
    [
      "benchmark:browser-ci",
      "--",
      "--suite",
      "browser",
      "--runs",
      "1",
      "--max-workers",
      "4",
      "--output",
      ".artifacts/browser-ci/browser.json",
    ],
    "local Full must cap browser pages without changing hosted runner auto sizing",
  );
  assert.deepEqual(
    full.releaseOnlyJobs.map((job) => job.id),
    ["electron-windows-installer-contract"],
  );
  assert.deepEqual(quick.coverage, {
    completeness: "complete",
    fromStage: null,
  });
  assert.deepEqual(full.coverage, {
    completeness: "complete",
    fromStage: null,
  });

  const resumed = buildLocalCiPlan(registry, {
    profile: "full",
    base: "origin/master",
    head: "HEAD",
    from: "security",
  });
  assert.deepEqual(resumed.coverage, {
    completeness: "partial",
    fromStage: "security",
  });

  const impactArgs = quick.stages[0].commands[0].args;
  assert.deepEqual(impactArgs.slice(-7), [
    "--base",
    "origin/master",
    "--head",
    "HEAD",
    "--run",
    "--report",
    ".artifacts/local-ci/impact.json",
  ]);
});

test("local CI argument parsing supports comparison, resume, and dry-run", () => {
  assert.deepEqual(
    parseLocalCiArgs([
      "full",
      "--base",
      "upstream/master",
      "--head",
      "topic",
      "--from",
      "security",
      "--dry-run",
      "--report",
      "/tmp/local-ci.json",
    ]),
    {
      base: "upstream/master",
      dryRun: true,
      from: "security",
      head: "topic",
      list: false,
      profile: "full",
      report: "/tmp/local-ci.json",
      verify: false,
    },
  );
  assert.equal(parseLocalCiArgs(["--verify", "full"]).verify, true);
  assert.throws(
    () => parseLocalCiArgs(["quick", "--unknown"]),
    /Unknown argument/,
  );
});

test("local CI execution is fail-fast and records later stages as not run", async () => {
  const executed = [];
  const plan = {
    profile: "full",
    comparison: { base: "origin/master", head: "HEAD" },
    coverage: { completeness: "complete", fromStage: null },
    releaseOnlyJobs: [],
    stages: [
      {
        id: "first",
        label: "First",
        commands: [
          { label: "pass", command: "pass", args: [], cwd: ".", env: {} },
          { label: "fail", command: "fail", args: [], cwd: ".", env: {} },
        ],
      },
      {
        id: "second",
        label: "Second",
        commands: [
          { label: "late", command: "late", args: [], cwd: ".", env: {} },
        ],
      },
    ],
  };

  const result = await runLocalCiPlan(plan, {
    candidate: completeCandidate(),
    executeCommand: async (entry) => {
      executed.push(entry.command);
      return {
        durationMs: 1,
        exitCode: entry.command === "fail" ? 7 : 0,
        signal: null,
      };
    },
  });

  assert.deepEqual(executed, ["pass", "fail"]);
  assert.equal(result.version, 2);
  assert.equal(result.coverage.completeness, "complete");
  assert.equal(result.candidate.resolvedHeadSha, "b".repeat(40));
  assert.equal(result.status, "failed");
  assert.equal(result.stages[0].status, "failed");
  assert.equal(result.stages[1].status, "not-run");
});

test("local CI resolves Git refs and rejects dirty or mismatched Full candidates", async () => {
  const registry = await readRegistry();
  const plan = buildLocalCiPlan(registry, {
    profile: "full",
    base: "origin/master",
    head: "HEAD",
  });
  const values = new Map([
    ["rev-parse --verify origin/master^{commit}", `${"a".repeat(40)}\n`],
    ["rev-parse --verify HEAD^{commit}", `${"b".repeat(40)}\n`],
    ["rev-parse --verify HEAD", `${"b".repeat(40)}\n`],
    ["rev-parse --verify HEAD^{tree}", `${"c".repeat(40)}\n`],
    ["status --porcelain=v1 -z --untracked-files=all", ""],
    ["diff --binary --no-ext-diff HEAD --", ""],
    ["ls-files --others --exclude-standard -z", ""],
  ]);
  const candidate = await resolveLocalCiCandidate(plan, {
    git: async (args) => {
      const key = args.join(" ");
      assert.ok(values.has(key), `unexpected git invocation: ${key}`);
      return values.get(key);
    },
  });

  assert.deepEqual(candidate, completeCandidate());
  assert.doesNotThrow(() => validateLocalCiCandidate(plan, candidate));
  assert.throws(
    () =>
      validateLocalCiCandidate(plan, {
        ...candidate,
        worktreeClean: false,
      }),
    /clean worktree/,
  );
  assert.throws(
    () =>
      validateLocalCiCandidate(plan, {
        ...candidate,
        currentHeadSha: "d".repeat(40),
      }),
    /current HEAD/,
  );
});

test("dirty candidate fingerprints change when file content changes", async () => {
  const registry = await readRegistry();
  const plan = buildLocalCiPlan(registry, {
    profile: "quick",
    base: "origin/master",
    head: "HEAD",
  });
  const resolveWithDiff = (trackedDiff) =>
    resolveLocalCiCandidate(plan, {
      git: async (args) => {
        const key = args.join(" ");
        const values = new Map([
          ["rev-parse --verify origin/master^{commit}", `${"a".repeat(40)}\n`],
          ["rev-parse --verify HEAD^{commit}", `${"b".repeat(40)}\n`],
          ["rev-parse --verify HEAD", `${"b".repeat(40)}\n`],
          ["rev-parse --verify HEAD^{tree}", `${"c".repeat(40)}\n`],
          [
            "status --porcelain=v1 -z --untracked-files=all",
            " M package.json\0",
          ],
          ["diff --binary --no-ext-diff HEAD --", trackedDiff],
          ["ls-files --others --exclude-standard -z", ""],
        ]);
        assert.ok(values.has(key), `unexpected git invocation: ${key}`);
        return values.get(key);
      },
    });

  const before = await resolveWithDiff("before");
  const after = await resolveWithDiff("after");

  assert.equal(before.worktreeStatusHash, after.worktreeStatusHash);
  assert.notEqual(before.worktreeFingerprint, after.worktreeFingerprint);
});

test("only complete candidate-bound receipts satisfy merge and release gates", () => {
  const candidate = completeCandidate();
  const receipt = {
    version: 2,
    profile: "full",
    coverage: { completeness: "complete", fromStage: null },
    candidate,
    status: "passed",
  };

  assert.doesNotThrow(() =>
    verifyLocalCiReceipt(receipt, { profile: "full", candidate }),
  );
  assert.throws(
    () =>
      verifyLocalCiReceipt(
        {
          ...receipt,
          coverage: { completeness: "partial", fromStage: "security" },
        },
        { profile: "full", candidate },
      ),
    /complete/,
  );
  assert.throws(
    () =>
      verifyLocalCiReceipt(receipt, {
        profile: "full",
        candidate: {
          ...candidate,
          resolvedHeadSha: "d".repeat(40),
        },
      }),
    /candidate/,
  );
  assert.throws(
    () =>
      verifyLocalCiReceipt(receipt, {
        profile: "full",
        candidate: {
          ...candidate,
          worktreeFingerprint: "d".repeat(64),
        },
      }),
    /candidate/,
  );
});

test("local CI prepares nested report directories before child execution", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const registry = await readRegistry();
  const plan = buildLocalCiPlan(registry, {
    profile: "quick",
    base: "origin/master",
    head: "HEAD",
  });

  await prepareLocalCiArtifacts(plan, { root: temporaryRoot });

  await access(path.join(temporaryRoot, ".artifacts/local-ci"));
});

test("package scripts expose canonical local CI entrypoints", async () => {
  const packageJson = JSON.parse(await read("package.json"));

  assert.equal(
    packageJson.scripts["ci:local:quick"],
    "node scripts/local-ci.mjs quick",
  );
  assert.equal(
    packageJson.scripts["ci:local:full"],
    "node scripts/local-ci.mjs full",
  );
  assert.equal(
    packageJson.scripts["ci:local:list"],
    "node scripts/local-ci.mjs --list",
  );
  assert.equal(
    packageJson.scripts["ci:local:verify"],
    "node scripts/local-ci.mjs --verify",
  );
  assert.match(packageJson.scripts["test:quality"], /local-ci\.test\.mjs/);
  assert.match(packageJson.scripts["test:quality"], /ci-pause\.test\.mjs/);
});

test("AI workflow authorities require local Quick and complete Full evidence", async () => {
  const [
    agents,
    impactGate,
    shipBranch,
    bumpVersion,
    implementFeature,
    debugIssue,
  ] = await Promise.all([
    read("AGENTS.md"),
    read(".agents/skills/grimodex-impact-gate/SKILL.md"),
    read(".agents/skills/ship-branch/SKILL.md"),
    read(".agents/skills/bump-version/SKILL.md"),
    read(".agents/skills/implement-feature/SKILL.md"),
    read(".agents/skills/debug-issue/SKILL.md"),
  ]);

  for (const command of [
    "pnpm ci:local:quick",
    "pnpm ci:local:full",
    "pnpm ci:local:list",
    "pnpm ci:local:verify",
  ]) {
    assert.match(agents, new RegExp(command.replaceAll(":", "\\:")));
  }
  assert.match(impactGate, /pnpm ci:local:quick/);
  assert.match(shipBranch, /pnpm ci:local:full/);
  assert.match(shipBranch, /pnpm ci:local:verify/);
  assert.match(shipBranch, /--from/);
  assert.match(bumpVersion, /pnpm ci:local:full/);
  assert.match(bumpVersion, /release commit/);
  assert.match(implementFeature, /pnpm ci:local:quick/);
  assert.match(debugIssue, /pnpm ci:local:quick/);
});
