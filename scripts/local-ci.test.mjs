import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

import {
  PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_CATALOG_DIGEST,
} from "../electron/scripts/product-journey-catalog.mjs";

import {
  buildLocalCiPlan,
  collectProductJourneyEvidence,
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

function completeProductJourneyEvidence(overrides = {}) {
  const identity = {
    path: ".artifacts/product-journeys/results.json",
    realPath: "/repo/.artifacts/product-journeys/results.json",
    sha256: `sha256:${"d".repeat(64)}`,
  };
  return {
    catalogDigest: PRODUCT_JOURNEY_CATALOG_DIGEST,
    journeyIds: PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
    allPassed: true,
    allClean: true,
    results: identity,
    manifest: {
      ...identity,
      path: ".artifacts/product-journeys/manifest.json",
    },
    artifacts: [identity],
    artifactDigest: `sha256:${"e".repeat(64)}`,
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
  assert.equal(
    registry.stages["electron-product-journeys"].env
      .GRIMODEX_PRODUCT_JOURNEY_REQUIRE_ALL,
    "true",
  );
  assert.equal(
    registry.stages["electron-product-journeys"].env
      .GRIMODEX_PRODUCT_JOURNEY_IDS,
    "",
    "local Full must mask inherited journey ID subsets",
  );
  assert.equal(
    registry.stages["electron-product-journeys"].env
      .GRIMODEX_PRODUCT_JOURNEY_SET,
    "",
    "local Full must mask inherited journey set subsets",
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

test("local Full product stage masks both inherited journey subset selectors", async () => {
  const registry = await readRegistry();
  const full = buildLocalCiPlan(registry, {
    profile: "full",
    base: "origin/master",
    head: "HEAD",
  });
  const productStage = full.stages.find(
    (stage) => stage.id === "electron-product-journeys",
  );
  const inherited = {
    GRIMODEX_PRODUCT_JOURNEY_IDS: '["editor-persistence"]',
    GRIMODEX_PRODUCT_JOURNEY_SET: "c2-zc",
  };
  const observed = [];

  await runLocalCiPlan(
    {
      ...full,
      stages: [productStage],
    },
    {
      executeCommand: async (command) => {
        observed.push({ ...inherited, ...command.env });
        return { durationMs: 1, exitCode: 0, signal: null };
      },
    },
  );

  assert.equal(observed.length, productStage.commands.length);
  for (const env of observed) {
    assert.equal(env.GRIMODEX_PRODUCT_JOURNEY_IDS, "");
    assert.equal(env.GRIMODEX_PRODUCT_JOURNEY_SET, "");
  }
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
  assert.equal(result.version, 3);
  assert.equal(result.coverage.completeness, "complete");
  assert.equal(result.candidate.resolvedHeadSha, "b".repeat(40));
  assert.equal(result.productJourneyEvidence, null);
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
    version: 3,
    profile: "full",
    coverage: { completeness: "complete", fromStage: null },
    candidate,
    status: "passed",
    productJourneyEvidence: completeProductJourneyEvidence(),
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

test("Full receipts require bound product journey results and artifact evidence", () => {
  const candidate = completeCandidate();
  const receipt = {
    version: 3,
    profile: "full",
    coverage: { completeness: "complete", fromStage: null },
    candidate,
    status: "passed",
  };

  assert.throws(
    () => verifyLocalCiReceipt(receipt, { profile: "full", candidate }),
    /product journey evidence/i,
  );
});

test("Full product journey evidence binds result and manifest bytes to the receipt", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-product-evidence-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const artifactRoot = path.join(
    temporaryRoot,
    ".artifacts",
    "product-journeys",
  );
  const resultsPath = path.join(artifactRoot, "results.json");
  const manifestPath = path.join(artifactRoot, "manifest.json");
  const buildRoot = path.join(temporaryRoot, "build");
  const mainPath = path.join(buildRoot, "main.cjs");
  const rendererPath = path.join(buildRoot, "index.html");
  const nativePath = path.join(buildRoot, "grimodex-node.node");
  const mcpRequestedPath = path.join(buildRoot, "grimodex-mcp");
  const mcpTargetA = path.join(buildRoot, "grimodex-mcp-a");
  const mcpTargetB = path.join(buildRoot, "grimodex-mcp-b");
  await mkdir(buildRoot, { recursive: true });
  await Promise.all([
    writeFile(mainPath, "electron main", "utf8"),
    writeFile(rendererPath, "renderer", "utf8"),
    writeFile(nativePath, "native module", "utf8"),
    writeFile(mcpTargetA, "mcp sidecar A", "utf8"),
    writeFile(mcpTargetB, "mcp sidecar B", "utf8"),
  ]);
  await symlink(path.basename(mcpTargetA), mcpRequestedPath);
  await mkdir(artifactRoot, { recursive: true });
  const journeyIds = PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id);
  const results = {
    version: 4,
    status: "passed",
    catalogDigest: PRODUCT_JOURNEY_CATALOG_DIGEST,
    catalogJourneyIds: journeyIds,
    journeyIds,
    allPassed: true,
    allClean: true,
    journeys: journeyIds.map((id) => ({
      id,
      status: "passed",
      cleanPass: true,
    })),
  };
  const resultsText = `${JSON.stringify(results, null, 2)}\n`;
  const resultsSha256 = `sha256:${createHash("sha256")
    .update(resultsText)
    .digest("hex")}`;
  await writeFile(resultsPath, resultsText, "utf8");
  const buildArtifact = async (name, requestedPath) => {
    const realPath = await realpath(requestedPath);
    const sha256 = `sha256:${createHash("sha256")
      .update(await readFile(realPath))
      .digest("hex")}`;
    return { name, path: requestedPath, requestedPath, realPath, sha256 };
  };
  const buildArtifacts = await Promise.all([
    buildArtifact("Electron main", mainPath),
    buildArtifact("renderer", rendererPath),
    buildArtifact("N-API native module", nativePath),
    buildArtifact("MCP sidecar", mcpRequestedPath),
  ]);
  const manifestText = `${JSON.stringify(
    {
      version: 1,
      status: "passed",
      catalogDigest: PRODUCT_JOURNEY_CATALOG_DIGEST,
      journeyIds,
      allPassed: true,
      allClean: true,
      results: {
        path: "results.json",
        realPath: resultsPath,
        sha256: resultsSha256,
      },
      artifacts: buildArtifacts,
    },
    null,
    2,
  )}\n`;
  await writeFile(manifestPath, manifestText, "utf8");

  const plan = {
    stages: [
      {
        id: "electron-product-journeys",
        commands: [
          {
            env: {
              GRIMODEX_PRODUCT_JOURNEY_ARTIFACT_DIR:
                ".artifacts/product-journeys",
            },
          },
        ],
      },
    ],
  };
  const evidence = await collectProductJourneyEvidence(plan, {
    root: temporaryRoot,
  });
  assert.deepEqual(evidence.journeyIds, journeyIds);
  assert.equal(evidence.results.sha256, resultsSha256);
  assert.equal(evidence.artifacts.length, 6);
  assert.equal(
    evidence.manifest.path,
    ".artifacts/product-journeys/manifest.json",
  );
  assert.match(evidence.artifactDigest, /^sha256:[0-9a-f]{64}$/);

  const candidate = completeCandidate();
  const receipt = {
    version: 3,
    profile: "full",
    coverage: { completeness: "complete", fromStage: null },
    candidate,
    status: "passed",
    productJourneyEvidence: evidence,
  };
  assert.doesNotThrow(() =>
    verifyLocalCiReceipt(receipt, {
      profile: "full",
      candidate,
      currentProductJourneyEvidence: evidence,
    }),
  );

  const missingManifestArtifact = JSON.parse(manifestText);
  missingManifestArtifact.artifacts.pop();
  await writeFile(
    manifestPath,
    `${JSON.stringify(missingManifestArtifact, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    collectProductJourneyEvidence(plan, { root: temporaryRoot }),
    /exactly the canonical build artifacts/i,
  );
  await writeFile(manifestPath, manifestText, "utf8");

  assert.throws(
    () =>
      verifyLocalCiReceipt(
        {
          ...receipt,
          productJourneyEvidence: {
            ...evidence,
            results: {
              ...evidence.results,
              sha256: `sha256:${"f".repeat(64)}`,
            },
          },
        },
        {
          profile: "full",
          candidate,
          currentProductJourneyEvidence: evidence,
        },
      ),
    /does not match current artifacts/i,
  );

  const mismatchedRequestedPath = JSON.parse(manifestText);
  mismatchedRequestedPath.artifacts[0].requestedPath = rendererPath;
  await writeFile(
    manifestPath,
    `${JSON.stringify(mismatchedRequestedPath, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    collectProductJourneyEvidence(plan, { root: temporaryRoot }),
    /changed after preflight/i,
  );
  await writeFile(manifestPath, manifestText, "utf8");

  await writeFile(mainPath, "electron main tampered", "utf8");
  await assert.rejects(
    collectProductJourneyEvidence(plan, { root: temporaryRoot }),
    /changed after preflight/i,
  );
  await writeFile(mainPath, "electron main", "utf8");

  await rm(mcpRequestedPath);
  await symlink(path.basename(mcpTargetB), mcpRequestedPath);
  await assert.rejects(
    collectProductJourneyEvidence(plan, { root: temporaryRoot }),
    /changed after preflight/i,
  );
  await rm(mcpRequestedPath);
  await symlink(path.basename(mcpTargetA), mcpRequestedPath);

  await rm(nativePath);
  await assert.rejects(
    collectProductJourneyEvidence(plan, { root: temporaryRoot }),
    /ENOENT|regular file|artifact/i,
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
