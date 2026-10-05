import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import yaml from "js-yaml";

import { runLocalCiTasks } from "./local-ci-runner.mjs";

import {
  PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_CATALOG_DIGEST,
} from "../electron/scripts/product-journey-catalog.mjs";

import {
  assertOutsideRepository,
  buildLocalCiPlan,
  captureC2ZcRestoreFixtureEvidence,
  collectProductJourneyEvidence,
  createLocalCiPlanDescriptor,
  expectedC2ZcAcceptanceForPlan,
  acquireCheckoutLock,
  checkoutLockCleanupComplete,
  cleanupNativeCargoTargetAfterTask,
  finalizeCheckoutLock,
  finalizeLocalCiExecution,
  parseLocalCiArgs,
  prepareLocalCiArtifacts,
  recoverCheckoutLock,
  readC2ZcRestoreFixtureEvidence,
  resolveNativeCargoTargetDirectory,
  resolveLocalCiCandidate,
  runLocalCiInvocationTasks,
  runLocalCiPlan,
  validateLocalCiCandidate,
  validateLocalCiRegistry,
  verifyLocalCiFinalization,
  verifyLocalCiReceipt,
  verifyLocalCiTaskEvidence,
} from "./local-ci.mjs";
import {
  C2ZC_RUST_ACCEPTANCE_CATALOG_DIGEST,
  C2ZC_RUST_ACCEPTANCE_GATES,
  C2ZC_RUST_VERIFY_CONTRACT_VERSION,
  C2ZC_RUST_VERIFY_COVERAGE,
  createC2ZcRustAcceptanceReceipt,
} from "./c2zc-rust-acceptance-receipt.mjs";
import {
  createC2ZcFixtureManifest,
  createC2ZcFixtureSemantic,
} from "./c2zc-fixture-test-support.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const LOCAL_CI_TEST_RUN_ID = "99999999-9999-4999-8999-999999999999";

async function read(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

async function readRegistry() {
  return JSON.parse(await read("scripts/local-ci-registry.json"));
}

function productFixtureCommands(registry) {
  const commands = registry.stages["electron-product-journeys"].commands;
  const mcpBuild = commands.find(({ id }) => id === "journeys.mcp-build");
  const aggregate = commands.find(({ id }) => id === "journeys.run");
  assert.ok(mcpBuild, "product fixture requires journeys.mcp-build");
  assert.ok(aggregate, "product fixture requires journeys.run");
  return { aggregate, mcpBuild };
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

function c2zcFixtureManifest(candidate, fixtureBytes) {
  const digest = `sha256:${createHash("sha256")
    .update(fixtureBytes)
    .digest("hex")}`;
  return createC2ZcFixtureManifest({
    candidate: {
      requested: candidate.requestedHead,
      resolvedHeadSha: candidate.resolvedHeadSha,
      resolvedTreeSha: candidate.resolvedHeadTreeSha,
      headSha: candidate.resolvedHeadSha,
      treeSha: candidate.resolvedHeadTreeSha,
      clean: candidate.worktreeClean,
      statusSha256: `sha256:${candidate.worktreeStatusHash}`,
    },
    semantic: createC2ZcFixtureSemantic({
      projectId: "fixture-project",
      sceneId: "fixture-scene",
      applicationId: "fixture-application",
      applyRunId: "fixture-owner-run",
      backfillRunId: "fixture-backfill-run",
      sceneSourceRevision: "v1@2026-08-29T00:00:01.000Z",
    }),
    fixtureSha256: digest,
    fixtureSizeBytes: fixtureBytes.length,
    schemaVersion: 34,
    fixturePath: "c2zc-restore-fixture.backup.db",
    databasePath: "c2zc-restore-fixture.db",
    builderCommand: ["cargo", "run", "c2zc-restore-fixture", "build"],
  });
}

function c2zcFixtureEvidence(candidate) {
  const fixtureBytes = Buffer.from("offline-fixture", "utf8");
  const fixtureManifest = c2zcFixtureManifest(candidate, fixtureBytes);
  const fixturePath = `.artifacts/local-ci/c2-zc-restore-fixture/${LOCAL_CI_TEST_RUN_ID}/c2zc-restore-fixture.backup.db`;
  const databasePath = `.artifacts/local-ci/c2-zc-restore-fixture/${LOCAL_CI_TEST_RUN_ID}/c2zc-restore-fixture.db`;
  const manifestPath = `.artifacts/local-ci/c2-zc-restore-fixture/${LOCAL_CI_TEST_RUN_ID}/c2zc-restore-fixture.manifest.json`;
  const fixture = {
    path: fixturePath,
    realPath: `/repo/${fixturePath}`,
    size: fixtureBytes.length,
    sha256: fixtureManifest.fixtureSha256,
  };
  const database = {
    path: databasePath,
    realPath: `/repo/${databasePath}`,
    size: fixtureBytes.length,
    sha256: fixtureManifest.artifacts.database.sha256,
  };
  const manifest = {
    path: manifestPath,
    realPath: `/repo/${manifestPath}`,
    size: 1,
    sha256: `sha256:${"b".repeat(64)}`,
  };
  return {
    path: fixture.path,
    manifestPath: manifest.path,
    manifest,
    artifacts: { fixture, database },
    fixtureManifest,
    manifestVersion: fixtureManifest.manifestVersion,
    manifestSha256: manifest.sha256,
    manifestSizeBytes: manifest.size,
    fixtureSha256: fixtureManifest.fixtureSha256,
    fixtureSizeBytes: fixtureManifest.fixtureSizeBytes,
    semanticContentsDigest: fixtureManifest.semantic.contentsDigest,
    contractVersion: fixtureManifest.contractVersion,
    builderVersion: fixtureManifest.builderVersion,
    candidate: fixtureManifest.candidate,
    candidateHeadSha: fixtureManifest.candidate.resolvedHeadSha,
    candidateTreeSha: fixtureManifest.candidate.resolvedTreeSha,
    candidateStatusSha256: fixtureManifest.candidate.statusSha256,
  };
}

const VERIFY_OUTCOME = {
  verifyContractVersion: C2ZC_RUST_VERIFY_CONTRACT_VERSION,
  checkCoverage: C2ZC_RUST_VERIFY_COVERAGE,
};

function exactRustGateOutput(gateId) {
  const gate = C2ZC_RUST_ACCEPTANCE_GATES.find(({ id }) => id === gateId);
  assert.ok(gate, `unknown C2-ZC Rust gate: ${gateId}`);
  const { fullTestName } = gate;
  const sentinel =
    gateId === "c2-zc-production-verify-coverage"
      ? `C2ZC_RUST_VERIFY_OUTCOME=${JSON.stringify(VERIFY_OUTCOME)}\n\n`
      : "";
  return `${sentinel}test ${fullTestName} ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n`;
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
    acceptanceRequired: false,
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

function fullStageBindingPlan({ productJourneySet = "not-c2zc" } = {}) {
  return {
    profile: "full",
    comparison: { base: "origin/master", head: "HEAD" },
    stages: [
      "bootstrap",
      "migration-recovery-gate",
      "security",
      "frontend",
      "browser",
      "electron-native",
      "c2-zc-rust-acceptance-gate",
      "c2-zc-restore-fixture-builder",
      "quality",
      "electron-product-journeys",
      "lfm-encoder-phase0",
      "rust",
      "webgl",
      "storybook",
      "electron",
      "electron-runtime-performance",
    ].map((id, index) => ({
      id,
      label: `stage-${index}`,
      commands: [
        {
          label: `command-${index}`,
          command: "node",
          args: [`command-${index}`],
          env:
            id === "electron-product-journeys" && productJourneySet !== null
              ? { GRIMODEX_PRODUCT_JOURNEY_SET: productJourneySet }
              : {},
        },
      ],
    })),
  };
}

function passedStagesForPlan(plan) {
  return plan.stages.map((stage) => ({
    ...stage,
    status: "passed",
    durationMs: 1,
    commands: stage.commands.map((command) => ({
      ...command,
      durationMs: 1,
      exitCode: 0,
      signal: null,
      status: "passed",
    })),
  }));
}

test("local CI registry accounts for every hosted Full CI job", async () => {
  const registry = await readRegistry();
  const workflow = yaml.load(await read(".github/workflows/ci.yml"));

  validateLocalCiRegistry(registry);
  assert.deepEqual(
    Object.keys(registry.hostedJobs).sort(),
    Object.keys(workflow.jobs).sort(),
  );

  const workerScript = "scripts/nir1-c-query-worker-ci.sh";
  const allocatorTest =
    "q_s_origins_no_fallback_failed_realloc_and_zero_live_seal";
  const workerScriptBody = await read(workerScript);
  const allocatorSource = await read(
    "src-tauri/crates/grimodex-db/src/bin/support/c_query_fixed_allocator.rs",
  );
  assert.ok(
    workerScriptBody.includes(`--bin nir1-c-query-worker ${allocatorTest}`),
  );
  assert.match(allocatorSource, new RegExp(`fn ${allocatorTest}\\(`));
  assert.ok(
    workerScriptBody.includes(
      '"id":"Q512/R2/A3-eligible-shared","qualifiedMaterials":140,"qualifiedRevisions":1,"ineligibleCandidates":0',
    ),
  );
  assert.ok(
    workerScriptBody.includes(
      'fixture "$manifest_path" Q512/R2/A3-eligible-shared "$q512_fixture_builder_path"',
    ),
  );
  const q512Test =
    "native_worker_returns_canonical_512_a3_eligible_seed_local_graph";
  const q513Test =
    "native_worker_refuses_exact_513_seed_local_unrelated_reverse_index_edge";
  for (const testName of [q512Test, q513Test]) {
    assert.ok(
      workerScriptBody.includes(testName),
      `worker gate omits ${testName}`,
    );
  }
  assert.ok(
    workerScriptBody.indexOf(
      'NIR1_Q2_FIXTURE_PATH="$q512_worker_fixture_path"',
    ) < workerScriptBody.indexOf(q512Test),
    "Q512 Gold test must use its private copy of the canonical fixture",
  );
  assert.ok(
    workerScriptBody.indexOf(
      'NIR1_Q2_FIXTURE_PATH="$q513_worker_fixture_path"',
    ) < workerScriptBody.indexOf(q513Test),
    "Q513 test must use a separate disposable copy",
  );
  assert.ok(
    workerScriptBody.includes(
      'cp -- "$q512_fixture_file" "$q512_test_fixture_file"',
    ),
  );
  assert.ok(
    workerScriptBody.includes(
      'cp -- "$q512_fixture_file" "$q513_test_fixture_file"',
    ),
  );
  assert.ok(workerScriptBody.includes("-wal -shm -journal"));
  assert.equal(
    (workerScriptBody.match(/^assert_q512_source_unchanged$/gm) ?? []).length,
    2,
  );
  assert.ok(workerScriptBody.includes("trap cleanup_fixture EXIT"));
  assert.ok(workerScriptBody.includes('rm -rf -- "$fixture_dir"'));
  const workerStep = workflow.jobs["nir1-c-query-worker"].steps.find(
    ({ name }) =>
      name ===
      "Build private Q2/Q512 fixtures and run focused real-worker tests",
  );
  const workerTask = registry.stages.rust.commands.find(
    ({ id }) => id === "rust.c-query-worker",
  );
  assert.equal(workerStep.shell, "bash");
  assert.equal(workerStep.run, `bash ${workerScript}`);
  assert.equal(workerTask.command, "bash");
  assert.deepEqual(workerTask.args, [workerScript]);

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

test("C2-ZC fixture builder is candidate-bound and rejects a missing Cargo manifest path", async () => {
  const registry = await readRegistry();
  const fixtureStage = registry.stages["c2-zc-restore-fixture-builder"];
  assert.ok(fixtureStage);
  assert.deepEqual(
    registry.profiles.full.slice(
      registry.profiles.full.indexOf("c2-zc-rust-acceptance-gate"),
      registry.profiles.full.indexOf("c2-zc-restore-fixture-builder") + 1,
    ),
    ["c2-zc-rust-acceptance-gate", "c2-zc-restore-fixture-builder"],
  );
  for (const command of fixtureStage.commands) {
    const manifestPathIndex = command.args.indexOf("--manifest-path");
    assert.equal(manifestPathIndex >= 0, true);
    assert.equal(command.args[manifestPathIndex + 1], "src-tauri/Cargo.toml");
    assert.ok(command.args.includes("--repo-root"));
    assert.ok(command.args.includes("--candidate"));
  }
  assert.ok(
    fixtureStage.commands
      .find((command) => command.args.includes("build"))
      .args.includes("__C2ZC_RESTORE_FIXTURE_OUTPUT_DIR__"),
  );
  assert.ok(
    fixtureStage.commands
      .find((command) => command.args.includes("verify"))
      .args.includes("__C2ZC_RESTORE_FIXTURE_MANIFEST__"),
  );

  const mutated = structuredClone(registry);
  const buildCommand = mutated.stages[
    "c2-zc-restore-fixture-builder"
  ].commands.find((command) => command.args.includes("build"));
  const manifestPathIndex = buildCommand.args.indexOf("--manifest-path");
  buildCommand.args.splice(manifestPathIndex, 2);
  assert.throws(
    () => validateLocalCiRegistry(mutated),
    /manifest-path.*src-tauri\/Cargo\.toml/i,
  );

  const reordered = structuredClone(registry);
  const rustIndex = reordered.profiles.full.indexOf("rust");
  const fixtureIndex = reordered.profiles.full.indexOf(
    "c2-zc-restore-fixture-builder",
  );
  [reordered.profiles.full[rustIndex], reordered.profiles.full[fixtureIndex]] =
    [reordered.profiles.full[fixtureIndex], reordered.profiles.full[rustIndex]];
  assert.throws(
    () => validateLocalCiRegistry(reordered),
    /exact C2-ZC stage order/i,
  );
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
      "2",
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

test("local Full orders the candidate-bound Rust gate before Electron journeys and binds its receipt hash", async (t) => {
  const registry = await readRegistry();
  const full = buildLocalCiPlan(registry, {
    profile: "full",
    base: "origin/master",
    head: "HEAD",
  });
  const c2RustIndex = full.stages.findIndex(
    (stage) => stage.id === "c2-zc-rust-acceptance-gate",
  );
  const productIndex = full.stages.findIndex(
    (stage) => stage.id === "electron-product-journeys",
  );
  assert.ok(c2RustIndex >= 0);
  const fixtureIndex = full.stages.findIndex(
    (stage) => stage.id === "c2-zc-restore-fixture-builder",
  );
  assert.ok(fixtureIndex >= 0);
  assert.ok(c2RustIndex < fixtureIndex && fixtureIndex < productIndex);

  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-c2zc-receipt-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const candidate = completeCandidate();
  const receipt = await createC2ZcRustAcceptanceReceipt({
    root: temporaryRoot,
    candidate,
    catalogDigest: C2ZC_RUST_ACCEPTANCE_CATALOG_DIGEST,
    resolveCandidate: async () => candidate,
    execute: async (_command, { gate }) => ({
      exitCode: 0,
      signal: null,
      stdout: exactRustGateOutput(gate.id),
      stderr: "",
    }),
  });
  const executed = [];
  const plan = {
    ...full,
    stages: [full.stages[c2RustIndex], full.stages[productIndex]],
  };
  const result = await runLocalCiPlan(plan, {
    candidate,
    root: temporaryRoot,
    executeCommand: async (command) => {
      executed.push(command);
      return { durationMs: 1, exitCode: 0, signal: null };
    },
  });

  assert.equal(result.status, "passed");
  assert.equal(executed.length, 10);
  const rustCommand = executed.find(
    (command) =>
      command.command === "node" &&
      command.args[0].includes("c2zc-rust-acceptance-receipt"),
  );
  assert.ok(rustCommand);
  assert.deepEqual(
    JSON.parse(rustCommand.env.GRIMODEX_C2ZC_RUST_CANDIDATE_JSON),
    candidate,
  );
  assert.equal(
    rustCommand.env.GRIMODEX_C2ZC_RUST_REQUESTED_BASE,
    "origin/master",
  );
  assert.equal(rustCommand.env.GRIMODEX_C2ZC_RUST_REQUESTED_HEAD, "HEAD");
  const productCommands = executed.filter(({ id }) =>
    id?.startsWith("journeys."),
  );
  assert.deepEqual(
    productCommands.map(({ id }) => id),
    [
      "journeys.mcp-build",
      "journeys.shard-1",
      "journeys.shard-2",
      "journeys.shard-3",
      "journeys.shard-4",
      "journeys.shard-5",
      "journeys.shard-6",
      "journeys.shard-7",
      "journeys.run",
    ],
  );
  for (const command of productCommands.slice(1)) {
    assert.equal(
      command.env.GRIMODEX_C2ZC_RUST_RECEIPT_SHA256,
      receipt.receiptSha256,
    );
  }
  assert.equal(C2ZC_RUST_ACCEPTANCE_GATES.length, 17);
  assert.equal(C2ZC_RUST_ACCEPTANCE_GATES[0].argv.command, "cargo");
  assert.match(
    C2ZC_RUST_ACCEPTANCE_GATES[0].argv.args.join(" "),
    /canonical_read_has_no_legacy_fallback_after_generic_cutover/,
  );
  assert.equal(C2ZC_RUST_ACCEPTANCE_GATES[0].contract.noLegacyFallback, true);
  assert.equal(
    C2ZC_RUST_ACCEPTANCE_GATES[2].id,
    "c2-zc-readiness-corruption-fail-closed",
  );
  assert.deepEqual(C2ZC_RUST_ACCEPTANCE_GATES[2].argv.args, [
    "test",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "-p",
    "grimodex-db",
    "--lib",
    "narrative_extraction::c2z_preparation::tests::rebuild_outcome_tamper_and_missing_evidence_fail_closed",
    "--",
    "--exact",
  ]);
  assert.equal(
    C2ZC_RUST_ACCEPTANCE_GATES[2].source,
    "src-tauri/crates/grimodex-db/src/narrative_extraction/c2z_preparation.rs",
  );
  assert.equal(
    C2ZC_RUST_ACCEPTANCE_GATES[2].fullTestName,
    "narrative_extraction::c2z_preparation::tests::rebuild_outcome_tamper_and_missing_evidence_fail_closed",
  );
  assert.equal(
    C2ZC_RUST_ACCEPTANCE_GATES[2].contract.proof,
    "direct persisted Rebuild evidence corruption blocks readiness",
  );
});

test("C2-ZC fixture output boundary accepts external paths and rejects repository paths", () => {
  const temporaryRoot = path.resolve(os.tmpdir(), "grimodex-c2zc-boundary");
  const repository = path.join(temporaryRoot, "repository");
  const external = path.join(temporaryRoot, "runner-temp");

  assert.doesNotThrow(() =>
    assertOutsideRepository(repository, external, "C2-ZC fixture output"),
  );
  assert.throws(
    () =>
      assertOutsideRepository(
        repository,
        path.join(repository, "fixture"),
        "C2-ZC fixture output",
      ),
    /must be outside the candidate repository/u,
  );
});

test("local Full builds and verifies an external C2-ZC fixture before passing its manifest to product journeys", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-c2zc-fixture-wiring-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const nativePath = path.join(temporaryRoot, "custom", "grimodex-node.node");
  const mainPath = path.join(temporaryRoot, "dist-electron", "main.cjs");
  const rendererPath = path.join(temporaryRoot, "dist", "index.html");
  await Promise.all([
    mkdir(path.dirname(nativePath), { recursive: true }),
    mkdir(path.dirname(mainPath), { recursive: true }),
    mkdir(path.dirname(rendererPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(nativePath, "native"),
    writeFile(mainPath, "main"),
    writeFile(rendererPath, "renderer"),
  ]);

  const registry = await readRegistry();
  const { aggregate, mcpBuild } = productFixtureCommands(registry);
  registry.stages["electron-product-journeys"] = {
    label: "C2-ZC product journeys",
    env: {
      GRIMODEX_PRODUCT_JOURNEY_SET: "c2-zc",
      GRIMODEX_PRODUCT_JOURNEY_IDS: "",
      GRIMODEX_NODE_PATH: nativePath,
    },
    commands: [
      {
        ...mcpBuild,
        label: "Build MCP journey dependency",
        command: "pnpm",
        args: ["mcp:build"],
      },
      {
        ...aggregate,
        label: "Run every product journey",
        command: "pnpm",
        args: ["electron:product-journeys"],
        after: ["journeys.mcp-build"],
      },
    ],
  };
  const full = buildLocalCiPlan(registry, {
    profile: "full",
    base: "origin/master",
    head: "HEAD",
  });
  const fixtureStage = full.stages.find(
    (stage) => stage.id === "c2-zc-restore-fixture-builder",
  );
  const productStage = full.stages.find(
    (stage) => stage.id === "electron-product-journeys",
  );
  const candidate = completeCandidate();
  const fixtureBytes = Buffer.from("offline-fixture", "utf8");
  const executed = [];
  const result = await runLocalCiPlan(
    { ...full, stages: [fixtureStage, productStage] },
    {
      candidate,
      root: temporaryRoot,
      executeCommand: async (command) => {
        executed.push(command);
        if (command.args.includes("build")) {
          const outputDir =
            command.args[command.args.indexOf("--output-dir") + 1];
          const manifest = c2zcFixtureManifest(candidate, fixtureBytes);
          await mkdir(outputDir, { recursive: true });
          await writeFile(
            path.join(outputDir, manifest.artifacts.fixture.path),
            fixtureBytes,
          );
          await writeFile(
            path.join(outputDir, manifest.artifacts.database.path),
            fixtureBytes,
          );
          await writeFile(
            path.join(outputDir, "c2zc-restore-fixture.manifest.json"),
            `${JSON.stringify(manifest, null, 2)}\n`,
          );
        }
        return { durationMs: 1, exitCode: 0, signal: null };
      },
    },
  );

  assert.equal(result.status, "passed");
  const fixtureCommands = executed.filter((command) =>
    command.args.includes("c2zc-restore-fixture"),
  );
  assert.equal(fixtureCommands.length, 2);
  for (const command of fixtureCommands) {
    const manifestPathIndex = command.args.indexOf("--manifest-path");
    assert.equal(command.args[manifestPathIndex + 1], "src-tauri/Cargo.toml");
    assert.equal(
      command.args[command.args.indexOf("--repo-root") + 1],
      temporaryRoot,
    );
  }
  const fixtureBuild = fixtureCommands.find((command) =>
    command.args.includes("build"),
  );
  const fixtureVerify = fixtureCommands.find((command) =>
    command.args.includes("verify"),
  );
  assert.equal(
    fixtureBuild.args[fixtureBuild.args.indexOf("--expected-head") + 1],
    candidate.resolvedHeadSha,
  );
  assert.equal(
    fixtureBuild.args[fixtureBuild.args.indexOf("--expected-tree") + 1],
    candidate.resolvedHeadTreeSha,
  );
  const outputDir =
    fixtureBuild.args[fixtureBuild.args.indexOf("--output-dir") + 1];
  assert.equal(path.relative(temporaryRoot, outputDir).startsWith(".."), true);
  assert.equal(
    fixtureVerify.args[fixtureVerify.args.indexOf("--manifest") + 1],
    path.join(outputDir, "c2zc-restore-fixture.manifest.json"),
  );

  const productCommand = executed.find(
    (command) => command.label === "Run every product journey",
  );
  const fixtureInput = JSON.parse(
    productCommand.env.GRIMODEX_C2ZC_RESTORE_FIXTURE,
  );
  const publishedFixtureDirectory = path.join(
    temporaryRoot,
    ".artifacts/local-ci/c2-zc-restore-fixture",
    result.runId,
  );
  assert.equal(
    fixtureInput.path,
    path.join(publishedFixtureDirectory, "c2zc-restore-fixture.backup.db"),
  );
  assert.equal(
    fixtureInput.manifest,
    path.join(publishedFixtureDirectory, "c2zc-restore-fixture.manifest.json"),
  );
  assert.ok(result.c2zcRestoreFixture);
  assert.equal(
    result.c2zcRestoreFixture.path,
    `.artifacts/local-ci/c2-zc-restore-fixture/${result.runId}/c2zc-restore-fixture.backup.db`,
  );
  assert.equal(
    result.c2zcRestoreFixture.manifestPath,
    `.artifacts/local-ci/c2-zc-restore-fixture/${result.runId}/c2zc-restore-fixture.manifest.json`,
  );
  await assert.rejects(
    readFile(path.join(outputDir, "c2zc-restore-fixture.backup.db")),
    /ENOENT/,
    "the repo-external working fixture is removed after the product stage",
  );
  await access(fixtureInput.path);

  const copiedFixturePaths = {
    fixturePath: fixtureInput.path,
    databasePath: path.join(
      temporaryRoot,
      result.c2zcRestoreFixture.artifacts.database.path,
    ),
    manifestPath: fixtureInput.manifest,
  };
  await readC2ZcRestoreFixtureEvidence(copiedFixturePaths, {
    root: temporaryRoot,
    candidate,
  });
  await writeFile(copiedFixturePaths.databasePath, "tampered database", "utf8");
  await assert.rejects(
    readC2ZcRestoreFixtureEvidence(copiedFixturePaths, {
      root: temporaryRoot,
      candidate,
    }),
    /bytes|digest|manifest artifacts/i,
    "Full fixture evidence must re-read the copied database",
  );
});

test("C2-ZC evidence atomically replaces read-only existing fixture files", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-c2zc-atomic-success-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sourceDirectory = path.join(temporaryRoot, "source");
  const evidenceDirectory = path.join(
    temporaryRoot,
    ".artifacts/local-ci/c2-zc-restore-fixture",
  );
  await Promise.all([
    mkdir(sourceDirectory, { recursive: true }),
    mkdir(evidenceDirectory, { recursive: true }),
  ]);
  const candidate = completeCandidate();
  const sourceBytes = Buffer.from("new-fixture", "utf8");
  const sourceManifest = c2zcFixtureManifest(candidate, sourceBytes);
  const sourcePaths = {
    fixturePath: path.join(sourceDirectory, "c2zc-restore-fixture.backup.db"),
    databasePath: path.join(sourceDirectory, "c2zc-restore-fixture.db"),
    manifestPath: path.join(
      sourceDirectory,
      "c2zc-restore-fixture.manifest.json",
    ),
  };
  await Promise.all([
    writeFile(sourcePaths.fixturePath, sourceBytes),
    writeFile(sourcePaths.databasePath, sourceBytes),
    writeFile(
      sourcePaths.manifestPath,
      `${JSON.stringify(sourceManifest, null, 2)}\n`,
    ),
  ]);

  const oldBytes = Buffer.from("old-fixture", "utf8");
  const oldManifest = c2zcFixtureManifest(candidate, oldBytes);
  const destinationPaths = {
    fixturePath: path.join(evidenceDirectory, "c2zc-restore-fixture.backup.db"),
    databasePath: path.join(evidenceDirectory, "c2zc-restore-fixture.db"),
    manifestPath: path.join(
      evidenceDirectory,
      "c2zc-restore-fixture.manifest.json",
    ),
  };
  await Promise.all([
    writeFile(destinationPaths.fixturePath, oldBytes),
    writeFile(destinationPaths.databasePath, oldBytes),
    writeFile(
      destinationPaths.manifestPath,
      `${JSON.stringify(oldManifest, null, 2)}\n`,
    ),
  ]);
  await Promise.all(
    Object.values(destinationPaths).map((filePath) => chmod(filePath, 0o444)),
  );

  const runId = "11111111-1111-4111-8111-111111111111";
  const evidence = await captureC2ZcRestoreFixtureEvidence(
    {
      ...sourcePaths,
      candidate,
      input: { manifestPath: sourcePaths.manifestPath },
    },
    temporaryRoot,
    { runId },
  );

  const publishedDirectory = path.join(evidenceDirectory, runId);
  const publishedPaths = {
    fixturePath: path.join(
      publishedDirectory,
      "c2zc-restore-fixture.backup.db",
    ),
    databasePath: path.join(publishedDirectory, "c2zc-restore-fixture.db"),
    manifestPath: path.join(
      publishedDirectory,
      "c2zc-restore-fixture.manifest.json",
    ),
  };
  assert.equal(
    await readFile(destinationPaths.fixturePath, "utf8"),
    "old-fixture",
  );
  assert.equal(
    await readFile(destinationPaths.databasePath, "utf8"),
    "old-fixture",
  );
  assert.equal(
    await readFile(publishedPaths.fixturePath, "utf8"),
    "new-fixture",
  );
  assert.equal(
    await readFile(publishedPaths.databasePath, "utf8"),
    "new-fixture",
  );
  assert.equal(
    await readFile(destinationPaths.manifestPath, "utf8"),
    `${JSON.stringify(oldManifest, null, 2)}\n`,
  );
  assert.equal(
    await readFile(publishedPaths.manifestPath, "utf8"),
    `${JSON.stringify(sourceManifest, null, 2)}\n`,
  );
  assert.equal(
    evidence.path,
    `.artifacts/local-ci/c2-zc-restore-fixture/${runId}/c2zc-restore-fixture.backup.db`,
  );
  assert.deepEqual(
    (await readdir(evidenceDirectory)).sort(),
    [
      "c2zc-restore-fixture.backup.db",
      "c2zc-restore-fixture.db",
      "c2zc-restore-fixture.manifest.json",
      runId,
    ].sort(),
  );
});

test("C2-ZC evidence staging failure preserves existing evidence and removes temp files", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-c2zc-atomic-failure-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sourceDirectory = path.join(temporaryRoot, "source");
  const evidenceDirectory = path.join(
    temporaryRoot,
    ".artifacts/local-ci/c2-zc-restore-fixture",
  );
  await Promise.all([
    mkdir(sourceDirectory, { recursive: true }),
    mkdir(evidenceDirectory, { recursive: true }),
  ]);
  const candidate = completeCandidate();
  const sourceBytes = Buffer.from("new-fixture", "utf8");
  const sourceManifest = c2zcFixtureManifest(candidate, sourceBytes);
  const sourcePaths = {
    fixturePath: path.join(sourceDirectory, "c2zc-restore-fixture.backup.db"),
    databasePath: path.join(sourceDirectory, "c2zc-restore-fixture.db"),
    manifestPath: path.join(
      sourceDirectory,
      "c2zc-restore-fixture.manifest.json",
    ),
  };
  await Promise.all([
    writeFile(sourcePaths.fixturePath, sourceBytes),
    writeFile(
      sourcePaths.manifestPath,
      `${JSON.stringify(sourceManifest, null, 2)}\n`,
    ),
  ]);

  const oldBytes = Buffer.from("old-fixture", "utf8");
  const oldManifest = c2zcFixtureManifest(candidate, oldBytes);
  const destinationPaths = {
    fixturePath: path.join(evidenceDirectory, "c2zc-restore-fixture.backup.db"),
    databasePath: path.join(evidenceDirectory, "c2zc-restore-fixture.db"),
    manifestPath: path.join(
      evidenceDirectory,
      "c2zc-restore-fixture.manifest.json",
    ),
  };
  await Promise.all([
    writeFile(destinationPaths.fixturePath, oldBytes),
    writeFile(destinationPaths.databasePath, oldBytes),
    writeFile(
      destinationPaths.manifestPath,
      `${JSON.stringify(oldManifest, null, 2)}\n`,
    ),
  ]);
  const before = await Promise.all(
    Object.values(destinationPaths).map((filePath) => readFile(filePath)),
  );
  const runId = "22222222-2222-4222-8222-222222222222";

  await assert.rejects(
    captureC2ZcRestoreFixtureEvidence(
      {
        ...sourcePaths,
        candidate,
        input: { manifestPath: sourcePaths.manifestPath },
      },
      temporaryRoot,
      { runId },
    ),
    /ENOENT/,
  );

  const after = await Promise.all(
    Object.values(destinationPaths).map((filePath) => readFile(filePath)),
  );
  assert.deepEqual(after, before);
  assert.deepEqual((await readdir(evidenceDirectory)).sort(), [
    "c2zc-restore-fixture.backup.db",
    "c2zc-restore-fixture.db",
    "c2zc-restore-fixture.manifest.json",
  ]);
  await assert.rejects(
    readFile(
      path.join(evidenceDirectory, runId, "c2zc-restore-fixture.manifest.json"),
    ),
    /ENOENT/,
  );
});

test("C2-ZC evidence publish failure cleans only its staging directory", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-c2zc-publish-failure-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sourceDirectory = path.join(temporaryRoot, "source");
  const evidenceDirectory = path.join(
    temporaryRoot,
    ".artifacts/local-ci/c2-zc-restore-fixture",
  );
  await Promise.all([
    mkdir(sourceDirectory, { recursive: true }),
    mkdir(evidenceDirectory, { recursive: true }),
  ]);
  const candidate = completeCandidate();
  const sourceBytes = Buffer.from("publish-failure-fixture", "utf8");
  const sourceManifest = c2zcFixtureManifest(candidate, sourceBytes);
  const sourcePaths = {
    fixturePath: path.join(sourceDirectory, "c2zc-restore-fixture.backup.db"),
    databasePath: path.join(sourceDirectory, "c2zc-restore-fixture.db"),
    manifestPath: path.join(
      sourceDirectory,
      "c2zc-restore-fixture.manifest.json",
    ),
  };
  await Promise.all([
    writeFile(sourcePaths.fixturePath, sourceBytes),
    writeFile(sourcePaths.databasePath, sourceBytes),
    writeFile(
      sourcePaths.manifestPath,
      `${JSON.stringify(sourceManifest, null, 2)}\n`,
    ),
  ]);
  const runId = "33333333-3333-4333-8333-333333333333";
  const finalDirectory = path.join(evidenceDirectory, runId);
  await assert.rejects(
    captureC2ZcRestoreFixtureEvidence(
      {
        ...sourcePaths,
        candidate,
        input: { manifestPath: sourcePaths.manifestPath },
      },
      temporaryRoot,
      {
        runId,
        beforePublish: async ({ finalDirectory: publishDirectory }) => {
          assert.equal(publishDirectory, finalDirectory);
          await mkdir(publishDirectory);
          await writeFile(path.join(publishDirectory, "sentinel"), "keep");
        },
      },
    ),
    /EEXIST|ENOTEMPTY/,
  );
  assert.equal(
    await readFile(path.join(finalDirectory, "sentinel"), "utf8"),
    "keep",
  );
  assert.deepEqual(await readdir(evidenceDirectory), [runId]);
});

test("concurrent C2-ZC evidence captures publish independent self-contained run directories", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-c2zc-concurrent-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const evidenceDirectory = path.join(
    temporaryRoot,
    ".artifacts/local-ci/c2-zc-restore-fixture",
  );
  const candidate = completeCandidate();
  const contexts = await Promise.all(
    [
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "fixture-a"],
      ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "fixture-b"],
    ].map(async ([runId, value]) => {
      const sourceDirectory = await mkdtemp(
        path.join(os.tmpdir(), `grimodex-local-ci-c2zc-source-${value}-`),
      );
      t.after(() => rm(sourceDirectory, { recursive: true, force: true }));
      const bytes = Buffer.from(value, "utf8");
      const manifest = c2zcFixtureManifest(candidate, bytes);
      const paths = {
        fixturePath: path.join(
          sourceDirectory,
          "c2zc-restore-fixture.backup.db",
        ),
        databasePath: path.join(sourceDirectory, "c2zc-restore-fixture.db"),
        manifestPath: path.join(
          sourceDirectory,
          "c2zc-restore-fixture.manifest.json",
        ),
      };
      await Promise.all([
        writeFile(paths.fixturePath, bytes),
        writeFile(paths.databasePath, bytes),
        writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
      ]);
      return { paths, runId, value };
    }),
  );
  const evidence = await Promise.all(
    contexts.map(({ paths, runId }) =>
      captureC2ZcRestoreFixtureEvidence(
        {
          ...paths,
          candidate,
          input: { manifestPath: paths.manifestPath },
        },
        temporaryRoot,
        { runId },
      ),
    ),
  );
  assert.deepEqual(
    evidence.map(({ path: fixturePath }) => fixturePath).sort(),
    contexts
      .map(
        ({ runId }) =>
          `.artifacts/local-ci/c2-zc-restore-fixture/${runId}/c2zc-restore-fixture.backup.db`,
      )
      .sort(),
  );
  for (const { runId, value } of contexts) {
    const publishedFixturePath = path.join(
      temporaryRoot,
      ".artifacts/local-ci/c2-zc-restore-fixture",
      runId,
      "c2zc-restore-fixture.backup.db",
    );
    assert.equal(await readFile(publishedFixturePath, "utf8"), value);
  }
  assert.deepEqual(
    (await readdir(evidenceDirectory)).sort(),
    contexts.map(({ runId }) => runId).sort(),
  );
});

test("failed C2-ZC fixture cleanup is scoped to the current run evidence", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-c2zc-cleanup-scope-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const registry = await readRegistry();
  const full = buildLocalCiPlan(registry, {
    profile: "full",
    base: "origin/master",
    head: "HEAD",
  });
  const fixtureStage = full.stages.find(
    (stage) => stage.id === "c2-zc-restore-fixture-builder",
  );
  const candidate = completeCandidate();
  const fixtureBytes = Buffer.from("cleanup-scope-fixture", "utf8");
  const executeFixture =
    (failVerify = false) =>
    async (command) => {
      if (command.args.includes("build")) {
        const outputDir =
          command.args[command.args.indexOf("--output-dir") + 1];
        const manifest = c2zcFixtureManifest(candidate, fixtureBytes);
        await mkdir(outputDir, { recursive: true });
        await Promise.all([
          writeFile(
            path.join(outputDir, manifest.artifacts.fixture.path),
            fixtureBytes,
          ),
          writeFile(
            path.join(outputDir, manifest.artifacts.database.path),
            fixtureBytes,
          ),
          writeFile(
            path.join(outputDir, "c2zc-restore-fixture.manifest.json"),
            `${JSON.stringify(manifest, null, 2)}\n`,
          ),
        ]);
      }
      return {
        durationMs: 1,
        exitCode: failVerify && command.args.includes("verify") ? 17 : 0,
        signal: null,
      };
    };
  const first = await runLocalCiPlan(
    { ...full, stages: [fixtureStage] },
    {
      candidate,
      root: temporaryRoot,
      executeCommand: executeFixture(),
    },
  );
  assert.equal(first.status, "passed");
  assert.ok(first.c2zcRestoreFixture);
  await access(path.join(temporaryRoot, first.c2zcRestoreFixture.path));

  const second = await runLocalCiPlan(
    { ...full, stages: [fixtureStage] },
    {
      candidate,
      root: temporaryRoot,
      executeCommand: executeFixture(true),
    },
  );
  assert.equal(second.status, "failed");
  assert.equal(second.c2zcRestoreFixture, null);
  await access(path.join(temporaryRoot, first.c2zcRestoreFixture.path));
  assert.deepEqual(
    await readdir(
      path.join(temporaryRoot, ".artifacts/local-ci/c2-zc-restore-fixture"),
    ),
    [first.runId],
  );
});

test("same-run C2-ZC evidence collision never deletes pre-existing evidence", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-c2zc-collision-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const registry = await readRegistry();
  const full = buildLocalCiPlan(registry, {
    profile: "full",
    base: "origin/master",
    head: "HEAD",
  });
  const fixtureStage = full.stages.find(
    (stage) => stage.id === "c2-zc-restore-fixture-builder",
  );
  const candidate = completeCandidate();
  const runId = "44444444-4444-4444-8444-444444444444";
  const evidenceDirectory = path.join(
    temporaryRoot,
    ".artifacts/local-ci/c2-zc-restore-fixture",
    runId,
  );
  const existingBytes = Buffer.from("pre-existing-evidence", "utf8");
  const existingManifest = c2zcFixtureManifest(candidate, existingBytes);
  await mkdir(evidenceDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(evidenceDirectory, "c2zc-restore-fixture.backup.db"),
      existingBytes,
    ),
    writeFile(
      path.join(evidenceDirectory, "c2zc-restore-fixture.db"),
      existingBytes,
    ),
    writeFile(
      path.join(evidenceDirectory, "c2zc-restore-fixture.manifest.json"),
      `${JSON.stringify(existingManifest, null, 2)}\n`,
    ),
  ]);
  const existingPaths = {
    fixturePath: path.join(evidenceDirectory, "c2zc-restore-fixture.backup.db"),
    databasePath: path.join(evidenceDirectory, "c2zc-restore-fixture.db"),
    manifestPath: path.join(
      evidenceDirectory,
      "c2zc-restore-fixture.manifest.json",
    ),
  };
  const before = await Promise.all(
    Object.values(existingPaths).map((filePath) => readFile(filePath)),
  );
  const fixtureBytes = Buffer.from("collision-source", "utf8");
  const executeFixture = async (command) => {
    if (command.args.includes("build")) {
      const outputDir = command.args[command.args.indexOf("--output-dir") + 1];
      const manifest = c2zcFixtureManifest(candidate, fixtureBytes);
      await mkdir(outputDir, { recursive: true });
      await Promise.all([
        writeFile(
          path.join(outputDir, manifest.artifacts.fixture.path),
          fixtureBytes,
        ),
        writeFile(
          path.join(outputDir, manifest.artifacts.database.path),
          fixtureBytes,
        ),
        writeFile(
          path.join(outputDir, "c2zc-restore-fixture.manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
        ),
      ]);
    }
    return {
      durationMs: 1,
      exitCode: 0,
      signal: null,
    };
  };

  const result = await runLocalCiPlan(
    { ...full, stages: [fixtureStage] },
    {
      candidate,
      root: temporaryRoot,
      runId,
      executeCommand: executeFixture,
    },
  );
  assert.equal(result.runId, runId);
  assert.equal(result.status, "failed");
  assert.equal(result.c2zcRestoreFixture, null);
  assert.deepEqual(
    await Promise.all(
      Object.values(existingPaths).map((filePath) => readFile(filePath)),
    ),
    before,
  );
  const retained = await readC2ZcRestoreFixtureEvidence(existingPaths, {
    root: temporaryRoot,
    candidate,
  });
  assert.equal(
    retained.fixtureSha256,
    `sha256:${createHash("sha256").update(existingBytes).digest("hex")}`,
  );
});

test("legacy fixed-path C2-ZC receipts fail closed under run-bound verification", () => {
  const candidate = completeCandidate();
  const plan = fullStageBindingPlan({ productJourneySet: null });
  const legacy = c2zcFixtureEvidence(candidate);
  const legacyDirectory = ".artifacts/local-ci/c2-zc-restore-fixture";
  const legacyFixturePath = `${legacyDirectory}/c2zc-restore-fixture.backup.db`;
  const legacyDatabasePath = `${legacyDirectory}/c2zc-restore-fixture.db`;
  const legacyManifestPath = `${legacyDirectory}/c2zc-restore-fixture.manifest.json`;
  legacy.path = legacyFixturePath;
  legacy.manifestPath = legacyManifestPath;
  legacy.manifest.path = legacyManifestPath;
  legacy.artifacts.fixture.path = legacyFixturePath;
  legacy.artifacts.database.path = legacyDatabasePath;
  const productJourneyEvidence = completeProductJourneyEvidence({
    acceptanceRequired: true,
  });
  productJourneyEvidence.c2zcRestoreFixture = legacy;
  const receipt = {
    version: 3,
    profile: "full",
    coverage: { completeness: "complete", fromStage: null },
    candidate,
    runId: LOCAL_CI_TEST_RUN_ID,
    status: "passed",
    stages: passedStagesForPlan(plan),
    productJourneyEvidence,
    c2zcRestoreFixture: legacy,
  };

  assert.throws(
    () =>
      verifyLocalCiReceipt(receipt, {
        profile: "full",
        candidate,
        plan,
        currentProductJourneyEvidence: productJourneyEvidence,
        currentC2ZcRestoreFixtureEvidence: legacy,
      }),
    /run|bound/i,
  );
});

test("local Full passes the verified copied fixture to product journeys, never the mutable builder temp", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-c2zc-stable-fixture-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const nativePath = path.join(temporaryRoot, "custom", "grimodex-node.node");
  const mainPath = path.join(temporaryRoot, "dist-electron", "main.cjs");
  const rendererPath = path.join(temporaryRoot, "dist", "index.html");
  await Promise.all([
    mkdir(path.dirname(nativePath), { recursive: true }),
    mkdir(path.dirname(mainPath), { recursive: true }),
    mkdir(path.dirname(rendererPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(nativePath, "native"),
    writeFile(mainPath, "main"),
    writeFile(rendererPath, "renderer"),
  ]);
  const registry = await readRegistry();
  const { aggregate, mcpBuild } = productFixtureCommands(registry);
  registry.stages["electron-product-journeys"] = {
    label: "C2-ZC product journeys",
    env: {
      GRIMODEX_PRODUCT_JOURNEY_SET: "c2-zc",
      GRIMODEX_PRODUCT_JOURNEY_IDS: "",
      GRIMODEX_NODE_PATH: nativePath,
    },
    commands: [
      {
        ...mcpBuild,
        label: "build",
        command: "build",
        args: [],
        cwd: ".",
      },
      {
        ...aggregate,
        label: "journeys",
        command: "journeys",
        args: [],
        cwd: ".",
        after: ["journeys.mcp-build"],
      },
    ],
  };
  const full = buildLocalCiPlan(registry, {
    profile: "full",
    base: "origin/master",
    head: "HEAD",
  });
  const fixtureStage = full.stages.find(
    (stage) => stage.id === "c2-zc-restore-fixture-builder",
  );
  const productStage = full.stages.find(
    (stage) => stage.id === "electron-product-journeys",
  );
  const candidate = completeCandidate();
  const fixtureBytes = Buffer.from("offline-fixture", "utf8");
  const executed = [];
  const result = await runLocalCiPlan(
    { ...full, stages: [fixtureStage, productStage] },
    {
      candidate,
      root: temporaryRoot,
      executeCommand: async (command) => {
        executed.push(command);
        if (command.args.includes("build")) {
          const outputDir =
            command.args[command.args.indexOf("--output-dir") + 1];
          const manifest = c2zcFixtureManifest(candidate, fixtureBytes);
          await mkdir(outputDir, { recursive: true });
          await writeFile(
            path.join(outputDir, manifest.artifacts.fixture.path),
            fixtureBytes,
          );
          await writeFile(
            path.join(outputDir, manifest.artifacts.database.path),
            fixtureBytes,
          );
          await writeFile(
            path.join(outputDir, "c2zc-restore-fixture.manifest.json"),
            `${JSON.stringify(manifest, null, 2)}\n`,
          );
        }
        return { durationMs: 1, exitCode: 0, signal: null };
      },
    },
  );

  assert.equal(result.status, "passed");
  const productCommand = executed.find(
    (command) => command.label === "journeys",
  );
  const fixtureInput = JSON.parse(
    productCommand.env.GRIMODEX_C2ZC_RESTORE_FIXTURE,
  );
  const publishedFixtureDirectory = path.join(
    temporaryRoot,
    ".artifacts/local-ci/c2-zc-restore-fixture",
    result.runId,
  );
  assert.equal(
    fixtureInput.path,
    path.join(publishedFixtureDirectory, "c2zc-restore-fixture.backup.db"),
  );
  assert.equal(
    fixtureInput.manifest,
    path.join(publishedFixtureDirectory, "c2zc-restore-fixture.manifest.json"),
  );
  assert.notEqual(fixtureInput.path, result.c2zcRestoreFixture?.workingPath);
});

test("Full verify derives C2-ZC acceptance from the planned selection instead of receipt self-assertion", () => {
  const registry = JSON.parse(
    readFileSync(path.join(repoRoot, "scripts/local-ci-registry.json"), "utf8"),
  );
  const plan = buildLocalCiPlan(registry, {
    profile: "full",
    base: "origin/master",
    head: "HEAD",
  });
  assert.equal(expectedC2ZcAcceptanceForPlan(plan), true);
  const candidate = completeCandidate();
  const receipt = {
    version: 3,
    profile: "full",
    coverage: { completeness: "complete", fromStage: null },
    candidate,
    status: "passed",
    stages: passedStagesForPlan(plan),
    productJourneyEvidence: completeProductJourneyEvidence({
      acceptanceRequired: false,
    }),
  };

  assert.throws(
    () =>
      verifyLocalCiReceipt(receipt, {
        profile: "full",
        candidate,
        plan,
      }),
    /C2-ZC|acceptance|planned/i,
  );
});

test("fixture validation failure keeps only bounded candidate/run diagnostic metadata", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-c2zc-fixture-diagnostic-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const registry = await readRegistry();
  const full = buildLocalCiPlan(registry, {
    profile: "full",
    base: "origin/master",
    head: "HEAD",
  });
  const fixtureStage = full.stages.find(
    (stage) => stage.id === "c2-zc-restore-fixture-builder",
  );
  const candidate = completeCandidate();
  const result = await runLocalCiPlan(
    { ...full, stages: [fixtureStage] },
    {
      candidate,
      root: temporaryRoot,
      executeCommand: async (command) => {
        if (command.args.includes("build")) {
          const outputDir =
            command.args[command.args.indexOf("--output-dir") + 1];
          await mkdir(outputDir, { recursive: true });
          await writeFile(
            path.join(outputDir, "c2zc-restore-fixture.backup.db"),
            "not-a-valid-fixture",
          );
        }
        return { durationMs: 1, exitCode: 0, signal: null };
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.c2zcRestoreFixture, null);
  assert.equal(result.c2zcRestoreFixtureDiagnostic.schema, 1);
  assert.equal(
    result.c2zcRestoreFixtureDiagnostic.stage,
    "c2-zc-restore-fixture-builder",
  );
  assert.equal(
    result.c2zcRestoreFixtureDiagnostic.candidate.currentHeadSha,
    candidate.currentHeadSha,
  );
  assert.match(result.c2zcRestoreFixtureDiagnostic.runId, /^[0-9a-f-]{36}$/);
  assert.ok(result.c2zcRestoreFixtureDiagnostic.error.message.length < 512);
  assert.equal("database" in result.c2zcRestoreFixtureDiagnostic, false);
  await assert.rejects(
    readFile(
      path.join(
        temporaryRoot,
        ".artifacts/local-ci/c2-zc-restore-fixture/c2zc-restore-fixture.db",
      ),
    ),
    /ENOENT/,
    "invalid fixture diagnostics must not retain the copied database",
  );
});

test("local CI records the selected C2-ZC build artifact identities in the product receipt", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-c2zc-artifacts-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const buildRoot = path.join(temporaryRoot, "build");
  const mainPath = path.join(buildRoot, "dist-electron", "main.cjs");
  const rendererPath = path.join(buildRoot, "dist", "index.html");
  const nativePath = path.join(buildRoot, "custom", "grimodex-node.node");
  await Promise.all([
    mkdir(path.dirname(mainPath), { recursive: true }),
    mkdir(path.dirname(rendererPath), { recursive: true }),
    mkdir(path.dirname(nativePath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(mainPath, "main"),
    writeFile(rendererPath, "renderer"),
    writeFile(nativePath, "native"),
  ]);
  const registry = await readRegistry();
  const { aggregate, mcpBuild } = productFixtureCommands(registry);
  registry.stages["electron-product-journeys"] = {
    label: "C2-ZC product journeys",
    env: {
      GRIMODEX_PRODUCT_JOURNEY_SET: "c2-zc",
      GRIMODEX_PRODUCT_JOURNEY_IDS: "",
      GRIMODEX_NODE_PATH: nativePath,
    },
    commands: [
      {
        ...mcpBuild,
        label: "build",
        command: "build",
        args: [],
        cwd: ".",
      },
      {
        ...aggregate,
        label: "journeys",
        command: "journeys",
        args: [],
        cwd: ".",
        after: ["journeys.mcp-build"],
      },
    ],
  };
  const full = buildLocalCiPlan(registry, {
    profile: "full",
    base: "origin/master",
    head: "HEAD",
  });
  const productStage = full.stages.find(
    (stage) => stage.id === "electron-product-journeys",
  );
  const candidate = completeCandidate({
    requestedBase: "upstream/release-candidate",
    requestedHead: "feature/c2zc-review",
  });
  const executed = [];
  await runLocalCiPlan(
    { ...full, stages: [productStage] },
    {
      candidate,
      root: buildRoot,
      executeCommand: async (command) => {
        executed.push(command);
        return { durationMs: 1, exitCode: 0, signal: null };
      },
    },
  );
  const receipt = JSON.parse(
    executed[1].env.GRIMODEX_PRODUCT_JOURNEY_BUILD_RECEIPT,
  );
  assert.deepEqual(receipt.candidate, candidate);
  assert.deepEqual(
    receipt.artifacts.map((artifact) => artifact.name),
    ["Electron main", "renderer", "N-API native module"],
  );
  assert.ok(
    receipt.artifacts.every((artifact) => Number.isSafeInteger(artifact.size)),
  );
  assert.equal(
    receipt.artifacts.find(
      (artifact) => artifact.name === "N-API native module",
    ).realPath,
    await realpath(nativePath),
  );
});

test("local CI does not self-attest a product build receipt before the build command passes", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-build-stage-binding-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const mainPath = path.join(temporaryRoot, "dist-electron", "main.cjs");
  const rendererPath = path.join(temporaryRoot, "dist", "index.html");
  const nativePath = path.join(temporaryRoot, "custom", "grimodex-node.node");
  await Promise.all([
    mkdir(path.dirname(mainPath), { recursive: true }),
    mkdir(path.dirname(rendererPath), { recursive: true }),
    mkdir(path.dirname(nativePath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(mainPath, "main"),
    writeFile(rendererPath, "renderer"),
    writeFile(nativePath, "native"),
  ]);
  const registry = await readRegistry();
  const { aggregate, mcpBuild } = productFixtureCommands(registry);
  registry.stages["electron-product-journeys"] = {
    label: "C2-ZC product journeys",
    env: {
      GRIMODEX_PRODUCT_JOURNEY_SET: "c2-zc",
      GRIMODEX_PRODUCT_JOURNEY_IDS: "",
      GRIMODEX_NODE_PATH: nativePath,
    },
    commands: [
      {
        ...mcpBuild,
        label: "build",
        command: "build",
        args: [],
        cwd: ".",
      },
      {
        ...aggregate,
        label: "journeys",
        command: "journeys",
        args: [],
        cwd: ".",
        after: ["journeys.mcp-build"],
      },
    ],
  };
  const full = buildLocalCiPlan(registry, {
    profile: "full",
    base: "origin/master",
    head: "HEAD",
  });
  const productStage = full.stages.find(
    (stage) => stage.id === "electron-product-journeys",
  );
  const result = await runLocalCiPlan(
    { ...full, stages: [productStage] },
    {
      candidate: completeCandidate(),
      root: temporaryRoot,
      executeCommand: async (command) =>
        command.label === "build"
          ? { durationMs: 1, exitCode: 1, signal: null }
          : { durationMs: 1, exitCode: 0, signal: null },
    },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.stages[0].commands[1].status, "not-run");
  assert.equal(
    result.stages[0].commands[1].env.GRIMODEX_PRODUCT_JOURNEY_BUILD_RECEIPT,
    undefined,
  );
});

test("local CI binds custom comparison base/head into both Rust and product journey commands", async (t) => {
  const registry = await readRegistry();
  const base = "upstream/release-candidate";
  const head = "feature/c2zc-review";
  const full = buildLocalCiPlan(registry, {
    profile: "full",
    base,
    head,
  });
  const rustStage = full.stages.find(
    (stage) => stage.id === "c2-zc-rust-acceptance-gate",
  );
  const productStage = full.stages.find(
    (stage) => stage.id === "electron-product-journeys",
  );
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-custom-comparison-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const candidate = completeCandidate({
    requestedBase: base,
    requestedHead: head,
  });
  const receipt = await createC2ZcRustAcceptanceReceipt({
    root: temporaryRoot,
    candidate,
    catalogDigest: C2ZC_RUST_ACCEPTANCE_CATALOG_DIGEST,
    resolveCandidate: async () => candidate,
    execute: async (_command, { gate }) => ({
      exitCode: 0,
      signal: null,
      stdout: exactRustGateOutput(gate.id),
      stderr: "",
    }),
  });
  const executed = [];
  await runLocalCiPlan(
    {
      ...full,
      stages: [rustStage, productStage],
    },
    {
      candidate,
      root: temporaryRoot,
      executeCommand: async (command) => {
        executed.push(command);
        return { durationMs: 1, exitCode: 0, signal: null };
      },
    },
  );
  const rustCommand = executed.find((command) =>
    command.args?.[0]?.includes("c2zc-rust-acceptance-receipt"),
  );
  const productCommand = executed.find(
    (command) => command.label === "Run every product journey",
  );
  assert.equal(rustCommand.env.GRIMODEX_C2ZC_RUST_REQUESTED_BASE, base);
  assert.equal(rustCommand.env.GRIMODEX_C2ZC_RUST_REQUESTED_HEAD, head);
  assert.equal(productCommand.env.GRIMODEX_C2ZC_RUST_REQUESTED_BASE, base);
  assert.equal(productCommand.env.GRIMODEX_C2ZC_RUST_REQUESTED_HEAD, head);
  assert.equal(
    productCommand.env.GRIMODEX_C2ZC_RUST_RECEIPT_SHA256,
    receipt.receiptSha256,
  );
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
      maxParallelTasks: null,
      profile: "full",
      report: "/tmp/local-ci.json",
      recoverLock: false,
      verify: false,
    },
  );
  assert.equal(parseLocalCiArgs(["--verify", "full"]).verify, true);
  assert.equal(
    parseLocalCiArgs(["full", "--max-parallel-tasks", "1"]).maxParallelTasks,
    1,
  );
  for (const value of [
    "0",
    "-1",
    "1.5",
    "NaN",
    "Infinity",
    "1e1",
    "9007199254740992",
  ]) {
    assert.throws(
      () => parseLocalCiArgs(["full", "--max-parallel-tasks", value]),
      /positive integer/u,
    );
  }
  assert.throws(
    () => parseLocalCiArgs(["full", "--max-parallel-tasks"]),
    /requires a value/u,
  );
  assert.throws(
    () => parseLocalCiArgs(["--verify", "--verify-staging", "full"]),
    /Unknown argument: --verify-staging/u,
  );
  assert.equal(parseLocalCiArgs(["--recover-lock"]).recoverLock, true);
  assert.throws(
    () => parseLocalCiArgs(["quick", "--unknown"]),
    /Unknown argument/,
  );
});

test("local CI retains a lock for incomplete process-group cleanup and supports explicit recovery", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-lock-recovery-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const runId = "22222222-2222-4222-8222-222222222222";
  const lock = await acquireCheckoutLock(temporaryRoot, { runId });
  const result = {
    runId,
    tasks: [
      {
        cleanup: { complete: false, groupAlive: true },
        id: "worker",
        pid: 99999999,
        status: "failed",
      },
    ],
  };
  assert.equal(checkoutLockCleanupComplete(result), false);
  const retained = await finalizeCheckoutLock(lock, {
    result,
    runId,
    runStarted: true,
  });
  assert.equal(retained.retained, true);
  const lockPath = path.join(
    temporaryRoot,
    ".artifacts/local-ci/checkout.lock",
  );
  const metadata = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(metadata.state, "cleanup-incomplete");
  assert.equal(metadata.runId, runId);
  assert.equal(metadata.tasks[0].pid, 99999999);
  await assert.rejects(
    acquireCheckoutLock(temporaryRoot, {
      runId: "33333333-3333-4333-8333-333333333333",
    }),
    (error) => error?.code === "EEXIST",
  );

  const recovered = await recoverCheckoutLock(temporaryRoot);
  assert.equal(recovered.runId, runId);
  const nextLock = await acquireCheckoutLock(temporaryRoot, {
    runId: "33333333-3333-4333-8333-333333333333",
  });
  await finalizeCheckoutLock(nextLock, { runStarted: false });
});

test("local CI releases a lock when cleanup proves no process group survived a pre-spawn failure", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-lock-pre-spawn-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const lock = await acquireCheckoutLock(temporaryRoot, {
    runId: "77777777-7777-4777-8777-777777777777",
  });
  const result = {
    tasks: [
      {
        cleanup: { complete: true, groupAlive: false },
        id: "missing-tool",
        pid: null,
        status: "failed",
      },
    ],
  };
  assert.equal(checkoutLockCleanupComplete(result), true);
  const finalized = await finalizeCheckoutLock(lock, {
    result,
    runStarted: true,
  });
  assert.equal(finalized.released, true);
  await assert.rejects(
    readFile(path.join(temporaryRoot, ".artifacts/local-ci/checkout.lock")),
    /ENOENT/u,
  );
});

test("local CI refuses recovery while a retained process group is unknown", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-lock-live-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const lock = await acquireCheckoutLock(temporaryRoot, {
    runId: "44444444-4444-4444-8444-444444444444",
  });
  await finalizeCheckoutLock(lock, {
    result: {
      runId: "44444444-4444-4444-8444-444444444444",
      tasks: [
        {
          cleanup: { complete: false, groupAlive: true },
          id: "worker",
          pid: null,
          status: "failed",
        },
      ],
    },
    runStarted: true,
  });
  await assert.rejects(
    recoverCheckoutLock(temporaryRoot),
    /unknown process groups/u,
  );
});

test("local CI refuses to recover an aggregate result with an unknown process group", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-lock-unknown-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const runId = "88888888-8888-4888-8888-888888888888";
  const lock = await acquireCheckoutLock(temporaryRoot, { runId });
  await finalizeCheckoutLock(lock, { runId, runStarted: true });
  const lockPath = path.join(
    temporaryRoot,
    ".artifacts/local-ci/checkout.lock",
  );
  const metadata = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(metadata.state, "cleanup-unknown");
  assert.equal(metadata.tasks.length, 1);
  await assert.rejects(
    recoverCheckoutLock(temporaryRoot),
    /unknown process groups/u,
  );
});

test("local CI serializes concurrent lock recovery and replacement acquisition", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-lock-serialization-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const oldRunId = "12121212-1212-4121-8121-121212121212";
  const oldLock = await acquireCheckoutLock(temporaryRoot, {
    runId: oldRunId,
  });
  await finalizeCheckoutLock(oldLock, {
    result: {
      runId: oldRunId,
      tasks: [
        {
          cleanup: { complete: false, groupAlive: true },
          id: "worker",
          pid: 99999999,
          status: "failed",
        },
      ],
    },
    runStarted: true,
  });

  const recoveries = await Promise.allSettled([
    recoverCheckoutLock(temporaryRoot),
    recoverCheckoutLock(temporaryRoot),
  ]);
  const successfulRecoveries = recoveries.filter(
    ({ status }) => status === "fulfilled",
  );
  const failedRecoveries = recoveries.filter(
    ({ status }) => status === "rejected",
  );
  assert.equal(successfulRecoveries.length, 1);
  assert.equal(failedRecoveries.length, 1);
  assert.equal(successfulRecoveries[0].value.runId, oldRunId);
  const newRunId = "34343434-3434-4434-8434-343434343434";
  const replacement = await acquireCheckoutLock(temporaryRoot, {
    runId: newRunId,
  });
  const replacementMetadata = JSON.parse(
    await readFile(
      path.join(temporaryRoot, ".artifacts/local-ci/checkout.lock"),
      "utf8",
    ),
  );
  assert.equal(replacementMetadata.runId, newRunId);
  await finalizeCheckoutLock(replacement, { runStarted: false });
});

test("local CI treats an existing operation marker as an advisory lock file", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-lock-operation-marker-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const operationPath = path.join(
    temporaryRoot,
    ".artifacts/local-ci/checkout.lock.operation",
  );
  await mkdir(path.dirname(operationPath), { recursive: true });
  await writeFile(operationPath, "partial legacy marker\n");

  const lock = await acquireCheckoutLock(temporaryRoot, {
    runId: "56565656-5656-4565-8565-565656565656",
  });
  await finalizeCheckoutLock(lock, { runStarted: false });
  assert.equal(
    await readFile(operationPath, "utf8"),
    "partial legacy marker\n",
  );
});

function finalizationTestResult(runId) {
  return {
    coverage: { completeness: "complete", fromStage: null },
    profile: "quick",
    runId,
    status: "passed",
    tasks: [],
    version: 3,
  };
}

test("external staging verifier receives the parallel cap and rejects its omission", async (t) => {
  // Synthetic verifier fixture only: never publish a canonical Quick receipt.
  const runId = randomUUID();
  const directory = path.join(repoRoot, ".artifacts/local-ci/runs", runId);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const args = {
    profile: "quick",
    base: "HEAD",
    head: "HEAD",
    maxParallelTasks: 1,
  };
  const plan = buildLocalCiPlan(await readRegistry(), args);
  const candidate = await resolveLocalCiCandidate(plan);
  const tasks = [];
  for (const task of plan.tasks) {
    const logs = {};
    for (const stream of ["stdout", "stderr"]) {
      const relative = `.artifacts/local-ci/runs/${runId}/logs/${task.id}.${stream}.log`;
      await mkdir(path.dirname(path.join(repoRoot, relative)), {
        recursive: true,
      });
      await writeFile(
        path.join(repoRoot, relative),
        "synthetic verifier fixture\n",
      );
      logs[stream] = {
        path: relative,
        size: Buffer.byteLength("synthetic verifier fixture\n"),
        sha256: `sha256:${createHash("sha256").update("synthetic verifier fixture\n").digest("hex")}`,
      };
    }
    tasks.push({
      id: task.id,
      status: "passed",
      exitCode: 0,
      signal: null,
      durationMs: 1,
      cleanup: { complete: true },
      logs,
    });
  }
  const result = {
    ...finalizationTestResult(runId),
    candidate,
    candidateAfter: candidate,
    plan: createLocalCiPlanDescriptor(plan),
    registryDigest: plan.registryDigest,
    durationMs: 1,
    tasks,
  };
  const finalized = await finalizeLocalCiExecution({
    args,
    result,
    runId,
    root: repoRoot,
    reportPath: path.join(directory, "synthetic-quick.json"),
    stagingReceiptPath: path.join(directory, "synthetic-staging.json"),
    signal: new AbortController().signal,
    invocationStarted: performance.now(),
  });
  assert.equal(
    finalized.success,
    true,
    JSON.stringify(finalized.result.receiptError),
  );
  assert.equal(finalized.result.finalization.externalVerify.status, "passed");
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [
        path.join(repoRoot, "scripts/local-ci-staging-verifier.mjs"),
        "quick",
        "--base",
        "HEAD",
        "--head",
        "HEAD",
        "--report",
        finalized.reportPath,
      ],
      { timeout: 10000 },
    ),
    (error) => {
      assert.match(error.stderr, /exact task plan/u);
      return true;
    },
  );
});

async function fullFinalizationFixture(root, runId) {
  const candidate = completeCandidate();
  const plan = {
    ...fullStageBindingPlan(),
    coverage: { completeness: "complete", fromStage: null },
    maxSlots: 1,
    registryDigest: `sha256:${"a".repeat(64)}`,
    releaseOnlyJobs: [],
  };
  plan.tasks = plan.stages.map((stage, index) => ({
    id: `fixture.${index}`,
    stageId: stage.id,
    stageLabel: stage.label,
    commandIndex: 0,
    command: stage.commands[0],
    after: [],
  }));
  const tasks = [];
  for (const { id } of plan.tasks) {
    const logs = {};
    for (const stream of ["stdout", "stderr"]) {
      const logPath = `.artifacts/local-ci/runs/${runId}/logs/${id}.${stream}.log`;
      await mkdir(path.dirname(path.join(root, logPath)), { recursive: true });
      await writeFile(path.join(root, logPath), "");
      logs[stream] = {
        path: logPath,
        size: 0,
        sha256: `sha256:${createHash("sha256").update("").digest("hex")}`,
      };
    }
    tasks.push({
      id,
      status: "passed",
      exitCode: 0,
      signal: null,
      durationMs: 1,
      cleanup: { complete: true },
      logs,
    });
  }
  const receipt = {
    ...finalizationTestResult(runId),
    candidate,
    candidateAfter: candidate,
    profile: "full",
    durationMs: 0,
    registryDigest: plan.registryDigest,
    plan: createLocalCiPlanDescriptor(plan),
    stages: passedStagesForPlan(plan),
    tasks,
    productJourneyEvidence: completeProductJourneyEvidence(),
  };
  const verifyReceipt = (result) =>
    verifyLocalCiReceipt(result, {
      profile: "full",
      candidate,
      plan,
      currentProductJourneyEvidence: receipt.productJourneyEvidence,
      requireTaskEvidence: true,
    });
  return { receipt, verifyReceipt };
}

test("local CI final receipt measures external verification separately and retains its verified input", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-finalization-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const runId = "55555555-5555-4555-8555-555555555555";
  const reportPath = path.join(temporaryRoot, "reports", "quick.json");
  const stagingPath = path.join(temporaryRoot, "reports", ".quick.staging");
  const executionStarted = performance.now() - 7;
  let observedStagingReceipt;
  const finalized = await finalizeLocalCiExecution({
    executionDurationMs: 7,
    invocationStarted: executionStarted,
    reportPath,
    result: finalizationTestResult(runId),
    root: temporaryRoot,
    runId,
    stagingReceiptPath: stagingPath,
    validateFinal: async (receipt) => {
      assert.ok(receipt.finalization.verifiedReceipt);
    },
    verifyExternal: async ({ reportPath: inputPath }) => {
      observedStagingReceipt = JSON.parse(await readFile(inputPath, "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 25));
    },
  });
  assert.equal(finalized.success, true);
  assert.equal(observedStagingReceipt.durationMs, 7);
  assert.equal(finalized.result.executionDurationMs, 7);
  assert.ok(finalized.result.verificationDurationMs >= 20);
  assert.ok(
    finalized.result.durationMs >= finalized.result.executionDurationMs,
  );
  assert.ok(
    finalized.result.finalizationDurationMs >=
      finalized.result.verificationDurationMs,
  );
  assert.equal(finalized.result.finalization.externalVerify.status, "passed");
  assert.equal(
    finalized.result.finalization.durationCutoff,
    "before-canonical-receipt-persistence",
  );
  assert.equal(
    finalized.result.finalization.receiptDurationMs,
    finalized.result.durationMs,
  );
  assert.equal(
    finalized.result.finalization.verifiedReceipt,
    finalized.verifiedReceipt,
  );
  await access(reportPath);
  await access(path.join(temporaryRoot, finalized.verifiedReceipt.path));
  await verifyLocalCiFinalization(finalized.result, { root: temporaryRoot });
  const tampered = structuredClone(finalized.result);
  tampered.finalization.verifiedReceipt.sha256 = `sha256:${"0".repeat(64)}`;
  await assert.rejects(
    verifyLocalCiFinalization(tampered, { root: temporaryRoot }),
    /identity changed/u,
  );
  const impossibleDuration = structuredClone(finalized.result);
  impossibleDuration.verificationDurationMs =
    impossibleDuration.finalizationDurationMs + 1;
  impossibleDuration.finalization.externalVerify.durationMs =
    impossibleDuration.verificationDurationMs;
  await assert.rejects(
    verifyLocalCiFinalization(impossibleDuration, { root: temporaryRoot }),
    /finalization evidence is inconsistent/u,
  );
  await assert.rejects(readFile(stagingPath), /ENOENT/u);
});

test("local CI persists canonical publication time in the final receipt", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-finalization-duration-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  let clock = 0;
  const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const reportPath = path.join(temporaryRoot, "reports", "quick.json");
  const finalized = await finalizeLocalCiExecution({
    deadlineMs: 1_000,
    executionDurationMs: 0,
    invocationStarted: 0,
    now: () => clock,
    reportPath,
    result: finalizationTestResult(runId),
    root: temporaryRoot,
    runId,
    stagingReceiptPath: path.join(temporaryRoot, "reports", ".quick.staging"),
    timeoutMs: 1_000,
    verifyExternal: async () => {},
    writeReceipt: async (receiptPath, receipt) => {
      await mkdir(path.dirname(receiptPath), { recursive: true });
      await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
      if (receiptPath.endsWith(".final.staging")) clock = 25;
    },
  });
  assert.equal(finalized.success, true);
  assert.ok(finalized.result.durationMs >= 25);
  assert.equal(
    finalized.result.finalization.receiptDurationMs,
    finalized.result.durationMs,
  );
  const published = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(published.durationMs, finalized.result.durationMs);
  assert.equal(
    published.finalization.receiptDurationMs,
    finalized.result.finalization.receiptDurationMs,
  );
});

test("local CI accounts for a delayed canonical persistence rewrite", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-finalization-rewrite-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  let canonicalWrites = 0;
  const invocationStarted = performance.now();
  let nowCalls = 0;
  const now = () => {
    nowCalls += 1;
    return nowCalls >= 6 ? performance.now() : invocationStarted;
  };
  const writeReceipt = async (receiptPath, receipt) => {
    if (receiptPath.endsWith(".final.staging")) {
      canonicalWrites += 1;
      if (canonicalWrites === 2) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    }
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
  };
  const runId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const reportPath = path.join(temporaryRoot, "reports", "quick.json");
  const finalized = await finalizeLocalCiExecution({
    executionDurationMs: 1,
    invocationStarted,
    now,
    reportPath,
    result: finalizationTestResult(runId),
    root: temporaryRoot,
    runId,
    stagingReceiptPath: path.join(temporaryRoot, "reports", ".quick.staging"),
    verifyExternal: async () => {},
    writeReceipt,
  });
  assert.equal(finalized.success, true);
  assert.ok(canonicalWrites >= 2);
  const published = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(published.durationMs, finalized.result.durationMs);
  assert.equal(
    published.finalization.receiptDurationMs,
    finalized.result.finalization.receiptDurationMs,
  );
  assert.ok(finalized.result.durationMs >= 35);
});

test("complete Full work beyond the timing target passes ordinary receipt verification", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-finalization-expired-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  let verificationCalls = 0;
  const runId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const reportPath = path.join(temporaryRoot, "reports", "full.json");
  const { receipt, verifyReceipt } = await fullFinalizationFixture(
    temporaryRoot,
    runId,
  );
  let clock = 600_001;
  const finalized = await finalizeLocalCiExecution({
    executionDurationMs: 600_001,
    invocationStarted: 0,
    now: () => clock,
    reportPath,
    result: receipt,
    root: temporaryRoot,
    runId,
    stagingReceiptPath: path.join(temporaryRoot, "reports", ".full.staging"),
    verifyExternal: async ({ reportPath: inputPath, timeoutMs }) => {
      verificationCalls += 1;
      assert.equal(timeoutMs, Number.POSITIVE_INFINITY);
      const source = JSON.parse(await readFile(inputPath, "utf8"));
      verifyReceipt(source);
      await verifyLocalCiTaskEvidence(source, { root: temporaryRoot });
      clock = 600_010;
    },
    validateFinal: async (result) => {
      verifyReceipt(result);
      await verifyLocalCiTaskEvidence(result, {
        allowPrePublication: true,
        requireFinalization: true,
        root: temporaryRoot,
      });
    },
  });
  assert.equal(finalized.success, true);
  assert.equal(verificationCalls, 1);
  assert.equal(finalized.result.status, "passed");
  assert.equal(finalized.result.finalization.externalVerify.status, "passed");
  assert.equal(finalized.result.durationMs, 600_010);
  assert.equal(finalized.result.executionDurationMs, 600_001);
  assert.equal(finalized.result.verificationDurationMs, 9);
  assert.equal(finalized.result.finalizationDurationMs, 9);
  assert.equal(finalized.result.finalization.receiptDurationMs, 600_010);
  assert.ok(finalized.result.finalization.verifiedReceipt);
  assert.equal(finalized.reportPath, reportPath);
  const published = JSON.parse(await readFile(reportPath, "utf8"));
  verifyReceipt(published);
  await verifyLocalCiTaskEvidence(published, {
    requireFinalization: true,
    root: temporaryRoot,
  });
  assert.equal(published.durationMs, 600_010);

  for (const invalidDuration of [
    undefined,
    null,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "600010",
  ]) {
    assert.throws(
      () => verifyReceipt({ ...published, durationMs: invalidDuration }),
      /durationMs must be a non-negative safe integer/u,
    );
  }
  assert.throws(
    () =>
      verifyReceipt({
        ...published,
        coverage: { completeness: "partial", fromStage: "security" },
      }),
    /complete local CI receipt/u,
  );
  const missingTask = structuredClone(published);
  missingTask.tasks.pop();
  assert.throws(() => verifyReceipt(missingTask), /every exact task result/u);
  const invalidTotal = {
    ...published,
    executionDurationMs: published.durationMs + 1,
  };
  await assert.rejects(
    verifyLocalCiTaskEvidence(invalidTotal, {
      requireFinalization: true,
      root: temporaryRoot,
    }),
    /finalization evidence is inconsistent/u,
  );
  const unfinished = JSON.parse(
    await readFile(
      path.join(temporaryRoot, published.finalization.verifiedReceipt.path),
      "utf8",
    ),
  );
  await assert.rejects(
    verifyLocalCiTaskEvidence(unfinished, {
      requireFinalization: true,
      root: temporaryRoot,
    }),
    /finalization evidence is required/u,
  );
  await writeFile(
    path.join(temporaryRoot, published.tasks[0].logs.stdout.path),
    "changed",
  );
  await assert.rejects(
    verifyLocalCiTaskEvidence(published, {
      requireFinalization: true,
      root: temporaryRoot,
    }),
    /log identity changed/u,
  );
});

test("local CI retains a passing result when verification crosses the timing target", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-verifier-budget-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const runId = "12121212-1212-4212-8212-121212121212";
  const reportPath = path.join(temporaryRoot, "reports", "full.json");
  const { receipt, verifyReceipt } = await fullFinalizationFixture(
    temporaryRoot,
    runId,
  );
  let clock = 599_940;
  let verificationFinished = false;
  const finalized = await finalizeLocalCiExecution({
    executionDurationMs: 598_666,
    invocationStarted: 0,
    now: () => clock,
    reportPath,
    result: receipt,
    root: temporaryRoot,
    runId,
    stagingReceiptPath: path.join(temporaryRoot, "reports", ".full.staging"),
    timeoutMs: 120_000,
    validateFinal: verifyReceipt,
    verifyExternal: async ({ timeoutMs, signal }) => {
      assert.equal(timeoutMs, 120_000);
      assert.equal(signal?.aborted ?? false, false);
      clock = 601_000;
      verificationFinished = true;
    },
  });
  assert.equal(verificationFinished, true);
  assert.equal(finalized.success, true);
  assert.equal(finalized.result.status, "passed");
  assert.equal(finalized.result.finalization.externalVerify.status, "passed");
  assert.equal(finalized.result.executionDurationMs, 598_666);
  assert.equal(finalized.result.verificationDurationMs, 1_060);
  assert.equal(finalized.result.finalizationDurationMs, 2_334);
  assert.equal(finalized.result.durationMs, 601_000);
  assert.equal(finalized.result.finalization.receiptDurationMs, 601_000);
  assert.ok(finalized.result.finalization.verifiedReceipt);
  assert.equal(finalized.reportPath, reportPath);
  const published = JSON.parse(await readFile(reportPath, "utf8"));
  verifyReceipt(published);
  await verifyLocalCiTaskEvidence(published, {
    requireFinalization: true,
    root: temporaryRoot,
  });
  assert.equal(published.durationMs, 601_000);
});

test("local CI aborts finalization after external verification resolves", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-finalization-abort-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const controller = new AbortController();
  const runId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const reportPath = path.join(temporaryRoot, "reports", "quick.json");
  const finalized = await finalizeLocalCiExecution({
    reportPath,
    result: finalizationTestResult(runId),
    root: temporaryRoot,
    runId,
    signal: controller.signal,
    stagingReceiptPath: path.join(temporaryRoot, "reports", ".quick.staging"),
    verifyExternal: async () => {
      controller.abort(new Error("cancelled after verification"));
    },
  });
  assert.equal(finalized.success, false);
  assert.match(finalized.reportPath, /[\\/]failures[\\/]/u);
  await assert.rejects(readFile(reportPath), /ENOENT/u);
  const failedReceipt = JSON.parse(
    await readFile(finalized.reportPath, "utf8"),
  );
  assert.equal(failedReceipt.status, "failed");
  assert.equal(failedReceipt.finalization.externalVerify.status, "passed");
  assert.ok(failedReceipt.finalization.verifiedReceipt);
});

test("local CI honors an explicitly configured finalization deadline", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-finalization-deadline-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const runId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const reportPath = path.join(temporaryRoot, "reports", "quick.json");
  let clock = 1;
  const now = () => {
    if (existsSync(reportPath)) clock = 3;
    return clock;
  };
  const finalized = await finalizeLocalCiExecution({
    deadlineMs: 2,
    executionDurationMs: 1,
    invocationStarted: 0,
    now,
    reportPath,
    result: finalizationTestResult(runId),
    root: temporaryRoot,
    runId,
    stagingReceiptPath: path.join(temporaryRoot, "reports", ".quick.staging"),
    verifyExternal: async () => {},
  });
  assert.equal(finalized.success, false);
  assert.match(finalized.reportPath, /[\\/]failures[\\/]/u);
  await assert.rejects(readFile(reportPath), /ENOENT/u);
  const failedReceipt = JSON.parse(
    await readFile(finalized.reportPath, "utf8"),
  );
  assert.equal(failedReceipt.status, "failed");
  assert.equal(failedReceipt.durationMs, 3);
  assert.equal(failedReceipt.finalization.receiptDurationMs, 3);
  assert.equal(failedReceipt.finalization.externalVerify.status, "passed");
  assert.ok(failedReceipt.finalization.verifiedReceipt);
  await access(
    path.join(temporaryRoot, failedReceipt.finalization.verifiedReceipt.path),
  );
  const savedSource = JSON.parse(
    await readFile(
      path.join(temporaryRoot, failedReceipt.finalization.verifiedReceipt.path),
      "utf8",
    ),
  );
  assert.equal(savedSource.status, "passed");
  assert.equal(savedSource.finalization, undefined);
  await assert.doesNotReject(
    verifyLocalCiTaskEvidence(savedSource, {
      requireFinalization: false,
      root: temporaryRoot,
    }),
  );
  await assert.rejects(
    verifyLocalCiTaskEvidence(savedSource, {
      requireFinalization: true,
      root: temporaryRoot,
    }),
    /finalization evidence is required/u,
  );
});

test("local CI external verification failure writes run-specific failed evidence without publishing success", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-finalization-failure-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const runId = "66666666-6666-4666-8666-666666666666";
  const reportPath = path.join(temporaryRoot, "reports", "quick.json");
  const finalized = await finalizeLocalCiExecution({
    executionDurationMs: 11,
    reportPath,
    result: finalizationTestResult(runId),
    root: temporaryRoot,
    runId,
    stagingReceiptPath: path.join(temporaryRoot, "reports", ".quick.staging"),
    verifyExternal: async () => {
      const error = new Error("external verifier timed out");
      error.code = null;
      error.killed = true;
      error.signal = "SIGTERM";
      throw error;
    },
  });
  assert.equal(finalized.success, false);
  assert.match(finalized.reportPath, /[\\/]failures[\\/]/u);
  await assert.rejects(readFile(reportPath), /ENOENT/u);
  const failedReceipt = JSON.parse(
    await readFile(finalized.reportPath, "utf8"),
  );
  assert.equal(failedReceipt.status, "failed");
  assert.equal(failedReceipt.finalization.externalVerify.status, "timeout");
  assert.equal(failedReceipt.receiptError.code, "ETIMEDOUT");
  assert.ok(failedReceipt.finalization.verifiedReceipt);
  await access(
    path.join(temporaryRoot, failedReceipt.finalization.verifiedReceipt.path),
  );
  const savedSource = JSON.parse(
    await readFile(
      path.join(temporaryRoot, failedReceipt.finalization.verifiedReceipt.path),
      "utf8",
    ),
  );
  assert.equal(savedSource.status, "passed");
  assert.equal(savedSource.finalization, undefined);
  await assert.doesNotReject(
    verifyLocalCiTaskEvidence(savedSource, {
      requireFinalization: false,
      root: temporaryRoot,
    }),
  );
  await assert.rejects(
    verifyLocalCiTaskEvidence(savedSource, {
      requireFinalization: true,
      root: temporaryRoot,
    }),
    /finalization evidence is required/u,
  );
});

test("local CI never overwrites a run-specific verified receipt on finalization replay", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-local-ci-finalization-collision-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const runId = "99999999-9999-4999-8999-999999999999";
  const reportPath = path.join(temporaryRoot, "reports", "quick.json");
  const first = await finalizeLocalCiExecution({
    executionDurationMs: 1,
    reportPath,
    result: finalizationTestResult(runId),
    root: temporaryRoot,
    runId,
    stagingReceiptPath: path.join(temporaryRoot, "reports", ".first.staging"),
    verifyExternal: async () => {},
  });
  const verifiedPath = path.join(temporaryRoot, first.verifiedReceipt.path);
  const firstBytes = await readFile(verifiedPath, "utf8");
  const second = await finalizeLocalCiExecution({
    executionDurationMs: 2,
    reportPath,
    result: finalizationTestResult(runId),
    root: temporaryRoot,
    runId,
    stagingReceiptPath: path.join(temporaryRoot, "reports", ".second.staging"),
    verifyExternal: async () => {},
  });
  assert.equal(second.success, false);
  assert.match(second.reportPath, /[\\/]failures[\\/]/u);
  assert.equal(await readFile(verifiedPath, "utf8"), firstBytes);
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

test("the CLI task entrypoint completes dependent Full work after 600 seconds", async (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const commands = ["fixture.first", "fixture.later"].map((id) => ({
    id,
    label: id,
    command: "fixture",
    args: [],
    cwd: ".",
    env: {},
  }));
  const plan = {
    profile: "full",
    comparison: { base: "origin/master", head: "HEAD" },
    coverage: { completeness: "complete", fromStage: null },
    maxSlots: 1,
    releaseOnlyJobs: [],
    stages: commands.map((command) => ({
      id: command.id,
      label: command.label,
      commands: [command],
    })),
    tasks: commands.map((command, index) => ({
      id: command.id,
      stageId: command.id,
      stageLabel: command.label,
      command,
      after: index === 0 ? [] : [commands[0].id],
      timeoutMs: 700_000,
    })),
  };
  const started = [];
  const result = await runLocalCiInvocationTasks(plan, {
    candidate: completeCandidate(),
    // Even a caller carrying the old execution deadline cannot reapply it.
    deadlineMs: 600_000,
    executeCommand: async (_command, { signal, taskId, timeoutMs }) => {
      started.push({ id: taskId, at: clock });
      assert.equal(timeoutMs, 700_000);
      if (taskId === commands[0].id) {
        clock = 600_001;
        t.mock.timers.tick(clock);
      }
      assert.equal(signal.aborted, false);
      return {
        cleanup: { complete: true },
        durationMs: taskId === commands[0].id ? 600_001 : 0,
        exitCode: 0,
        signal: null,
      };
    },
  });
  assert.deepEqual(started, [
    { id: "fixture.first", at: 0 },
    { id: "fixture.later", at: 600_001 },
  ]);
  assert.equal(result.durationMs, 600_001);
  assert.equal(result.status, "passed");
  assert.equal(result.deadlineExceeded, false);
  assert.equal(result.interrupted, false);
  assert.deepEqual(
    result.tasks.map(({ status }) => status),
    ["passed", "passed"],
  );
  assert.deepEqual(
    result.stages.map(({ status }) => status),
    ["passed", "passed"],
  );
});

test("C2-ZC Full does not skip product journeys after runtime performance failure", async () => {
  const candidate = completeCandidate();
  const registry = await readRegistry();
  const full = buildLocalCiPlan(registry, {
    profile: "full",
    base: "origin/master",
    head: "HEAD",
  });
  const runtimeStage = full.stages.find(
    (stage) => stage.id === "electron-runtime-performance",
  );
  const productStage = full.stages.find(
    (stage) => stage.id === "electron-product-journeys",
  );
  const plan = { ...full, stages: [runtimeStage, productStage] };
  const executed = [];
  const result = await runLocalCiPlan(plan, {
    candidate,
    executeCommand: async (entry) => {
      executed.push(entry);
      return {
        durationMs: 1,
        exitCode: 124,
        signal: null,
      };
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(
    executed.at(-1).label,
    runtimeStage.commands[0].label,
    "the runtime performance failure must be the last executed command",
  );
  const recordedRuntimeStage = result.stages.find(
    (stage) => stage.id === "electron-runtime-performance",
  );
  const recordedProductStage = result.stages.find(
    (stage) => stage.id === "electron-product-journeys",
  );
  assert.equal(recordedRuntimeStage.status, "failed");
  assert.equal(recordedProductStage.status, "not-run");
  assert.ok(recordedProductStage.commands.length > 0);
  assert.equal(recordedProductStage.commands[0].status, "not-run");
  assert.match(recordedProductStage.commands[0].reason, /Fail-fast/i);
  assert.equal(result.productJourneyEvidence, null);
  assert.throws(
    () =>
      verifyLocalCiReceipt(result, {
        profile: "full",
        candidate,
        plan,
      }),
    /passed full local CI receipt/i,
  );
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
  const plan = fullStageBindingPlan();
  const receipt = {
    version: 3,
    profile: "full",
    coverage: { completeness: "complete", fromStage: null },
    candidate,
    status: "passed",
    stages: passedStagesForPlan(plan),
    productJourneyEvidence: completeProductJourneyEvidence(),
  };

  assert.doesNotThrow(() =>
    verifyLocalCiReceipt(receipt, { profile: "full", candidate, plan }),
  );
  assert.throws(
    () =>
      verifyLocalCiReceipt(
        {
          ...receipt,
          coverage: { completeness: "partial", fromStage: "security" },
        },
        { profile: "full", candidate, plan },
      ),
    /complete/,
  );
  assert.throws(
    () =>
      verifyLocalCiReceipt(receipt, {
        profile: "full",
        plan,
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
        plan,
        candidate: {
          ...candidate,
          worktreeFingerprint: "d".repeat(64),
        },
      }),
    /candidate/,
  );
});

test("Full receipt verification binds every planned stage and command", () => {
  const candidate = completeCandidate();
  const plan = fullStageBindingPlan();
  const receipt = {
    version: 3,
    profile: "full",
    coverage: { completeness: "complete", fromStage: null },
    candidate,
    status: "passed",
    productJourneyEvidence: completeProductJourneyEvidence({
      acceptanceRequired: false,
    }),
    stages: passedStagesForPlan(plan),
  };

  assert.doesNotThrow(() =>
    verifyLocalCiReceipt(receipt, { profile: "full", candidate, plan }),
  );

  const runOwnedPlan = fullStageBindingPlan();
  const artifactDirectory =
    ".artifacts/local-ci/runs/__LOCAL_CI_RUN_ID__/product-journeys";
  const runOwnedPlanCommand = runOwnedPlan.stages.find(
    ({ id }) => id === "electron-product-journeys",
  ).commands[0];
  runOwnedPlanCommand.env.GRIMODEX_PRODUCT_JOURNEY_ARTIFACT_DIR =
    artifactDirectory;
  const runOwnedReceipt = {
    ...receipt,
    runId: LOCAL_CI_TEST_RUN_ID,
    stages: passedStagesForPlan(runOwnedPlan),
  };
  const runOwnedReceiptCommand = runOwnedReceipt.stages.find(
    ({ id }) => id === "electron-product-journeys",
  ).commands[0];
  runOwnedReceiptCommand.env = {
    ...runOwnedReceiptCommand.env,
    GRIMODEX_PRODUCT_JOURNEY_ARTIFACT_DIR: artifactDirectory.replaceAll(
      "__LOCAL_CI_RUN_ID__",
      LOCAL_CI_TEST_RUN_ID,
    ),
  };
  assert.doesNotThrow(() =>
    verifyLocalCiReceipt(runOwnedReceipt, {
      profile: "full",
      candidate,
      plan: runOwnedPlan,
    }),
  );
  assert.equal(
    runOwnedPlanCommand.env.GRIMODEX_PRODUCT_JOURNEY_ARTIFACT_DIR,
    artifactDirectory,
  );

  const wrongRunReceipt = structuredClone(runOwnedReceipt);
  wrongRunReceipt.stages.find(
    ({ id }) => id === "electron-product-journeys",
  ).commands[0].env.GRIMODEX_PRODUCT_JOURNEY_ARTIFACT_DIR =
    artifactDirectory.replaceAll(
      "__LOCAL_CI_RUN_ID__",
      "88888888-8888-4888-8888-888888888888",
    );
  assert.throws(
    () =>
      verifyLocalCiReceipt(wrongRunReceipt, {
        profile: "full",
        candidate,
        plan: runOwnedPlan,
      }),
    /env does not match the planned command/u,
  );

  for (const runId of [undefined, "../wrong-run"]) {
    const invalidRunReceipt = structuredClone(runOwnedReceipt);
    if (runId === undefined) delete invalidRunReceipt.runId;
    else invalidRunReceipt.runId = runId;
    assert.throws(
      () =>
        verifyLocalCiReceipt(invalidRunReceipt, {
          profile: "full",
          candidate,
          plan: runOwnedPlan,
        }),
      /run must be a UUIDv4/u,
    );
  }

  for (const [label, mutate] of [
    ["missing stage", (mutated) => mutated.stages.pop()],
    ["reordered stage", (mutated) => mutated.stages.reverse()],
    [
      "failed stage",
      (mutated) => {
        mutated.stages[0].status = "failed";
      },
    ],
    [
      "missing command",
      (mutated) => {
        mutated.stages[0].commands.pop();
      },
    ],
    [
      "reordered command",
      (mutated) => {
        mutated.stages[0].commands.reverse();
        mutated.stages[0].commands.push({
          ...mutated.stages[0].commands[0],
          label: "unexpected-command",
        });
      },
    ],
    [
      "nonzero command",
      (mutated) => {
        mutated.stages[0].commands[0].exitCode = 1;
      },
    ],
    [
      "reduced command args",
      (mutated) => {
        mutated.stages[0].commands[0].args = [];
      },
    ],
    [
      "changed command cwd",
      (mutated) => {
        mutated.stages[0].commands[0].cwd = "unexpected";
      },
    ],
    [
      "changed planned env",
      (mutated) => {
        mutated.stages.at(-1).commands[0].env = {
          GRIMODEX_PRODUCT_JOURNEY_SET: "unexpected",
        };
      },
    ],
    [
      "signaled command",
      (mutated) => {
        mutated.stages[0].commands[0].signal = "SIGTERM";
      },
    ],
    [
      "unexpected dynamic-stage env",
      (mutated) => {
        mutated.stages[1].commands[0].env.UNEXPECTED_ACCEPTANCE_OVERRIDE =
          "true";
      },
    ],
  ]) {
    const mutated = structuredClone(receipt);
    mutate(mutated);
    assert.throws(
      () => verifyLocalCiReceipt(mutated, { profile: "full", candidate, plan }),
      /stage|command|passed|exitCode/i,
      label,
    );
  }

  assert.throws(
    () => verifyLocalCiReceipt(receipt, { profile: "full", candidate }),
    /plan/i,
    "Full receipt verification must reject a missing plan",
  );

  const customPlan = fullStageBindingPlan();
  customPlan.comparison = {
    base: "upstream/release-candidate",
    head: "feature/c2zc-review",
  };
  for (const stage of customPlan.stages.filter((entry) =>
    ["c2-zc-rust-acceptance-gate", "electron-product-journeys"].includes(
      entry.id,
    ),
  )) {
    stage.commands[0].env = {
      ...stage.commands[0].env,
      GRIMODEX_C2ZC_RUST_REQUESTED_BASE: "origin/master",
      GRIMODEX_C2ZC_RUST_REQUESTED_HEAD: "HEAD",
    };
  }
  const customReceipt = {
    ...receipt,
    stages: passedStagesForPlan(customPlan),
  };
  for (const stage of customReceipt.stages.filter((entry) =>
    ["c2-zc-rust-acceptance-gate", "electron-product-journeys"].includes(
      entry.id,
    ),
  )) {
    stage.commands[0].env.GRIMODEX_C2ZC_RUST_REQUESTED_BASE =
      customPlan.comparison.base;
    stage.commands[0].env.GRIMODEX_C2ZC_RUST_REQUESTED_HEAD =
      customPlan.comparison.head;
  }
  assert.doesNotThrow(() =>
    verifyLocalCiReceipt(customReceipt, {
      profile: "full",
      candidate,
      plan: customPlan,
    }),
  );
  customReceipt.stages.find(
    ({ id }) => id === "electron-product-journeys",
  ).commands[0].env.GRIMODEX_C2ZC_RUST_REQUESTED_BASE = "origin/master";
  assert.throws(
    () =>
      verifyLocalCiReceipt(customReceipt, {
        profile: "full",
        candidate,
        plan: customPlan,
      }),
    /env.*planned/i,
  );

  const fixturePlan = fullStageBindingPlan();
  const fixtureStage = fixturePlan.stages.find(
    (stage) => stage.id === "c2-zc-restore-fixture-builder",
  );
  fixtureStage.commands = [
    {
      label: "build fixture",
      command: "cargo",
      args: [
        "run",
        "--",
        "build",
        "--repo-root",
        ".",
        "--output-dir",
        "__C2ZC_RESTORE_FIXTURE_OUTPUT_DIR__",
        "--candidate",
        "HEAD",
        "--expected-head",
        "__C2ZC_RESTORE_FIXTURE_EXPECTED_HEAD__",
        "--expected-tree",
        "__C2ZC_RESTORE_FIXTURE_EXPECTED_TREE__",
      ],
      cwd: ".",
      env: {},
    },
    {
      label: "verify fixture",
      command: "cargo",
      args: [
        "run",
        "--",
        "verify",
        "--manifest",
        "__C2ZC_RESTORE_FIXTURE_MANIFEST__",
        "--repo-root",
        ".",
        "--candidate",
        "HEAD",
      ],
      cwd: ".",
      env: {},
    },
  ];
  const fixtureReceipt = {
    ...receipt,
    stages: passedStagesForPlan(fixturePlan),
  };
  const fixtureReceiptStage = fixtureReceipt.stages.find(
    (stage) => stage.id === "c2-zc-restore-fixture-builder",
  );
  const fixtureOutputDir = "/tmp/grimodex-c2zc-fixture-run";
  const replaceOption = (command, option, value) => {
    command.args[command.args.indexOf(option) + 1] = value;
  };
  const [buildFixture, verifyFixture] = fixtureReceiptStage.commands;
  for (const command of [buildFixture, verifyFixture]) {
    replaceOption(command, "--repo-root", "/repo");
    replaceOption(command, "--candidate", fixturePlan.comparison.head);
  }
  replaceOption(buildFixture, "--output-dir", fixtureOutputDir);
  replaceOption(buildFixture, "--expected-head", candidate.resolvedHeadSha);
  replaceOption(buildFixture, "--expected-tree", candidate.resolvedHeadTreeSha);
  replaceOption(
    verifyFixture,
    "--manifest",
    path.join(fixtureOutputDir, "c2zc-restore-fixture.manifest.json"),
  );
  assert.doesNotThrow(() =>
    verifyLocalCiReceipt(fixtureReceipt, {
      profile: "full",
      candidate,
      plan: fixturePlan,
    }),
  );
  replaceOption(
    verifyFixture,
    "--manifest",
    "/tmp/unrelated/c2zc-restore-fixture.manifest.json",
  );
  assert.throws(
    () =>
      verifyLocalCiReceipt(fixtureReceipt, {
        profile: "full",
        candidate,
        plan: fixturePlan,
      }),
    /fixture.*paths.*coherent/i,
  );
});

test("Full receipts require bound product journey results and artifact evidence", () => {
  const candidate = completeCandidate();
  const plan = fullStageBindingPlan();
  const receipt = {
    version: 3,
    profile: "full",
    coverage: { completeness: "complete", fromStage: null },
    candidate,
    status: "passed",
    stages: passedStagesForPlan(plan),
  };

  assert.throws(
    () => verifyLocalCiReceipt(receipt, { profile: "full", candidate, plan }),
    /product journey evidence/i,
  );
});

test("Full receipts fail closed when a C2-ZC-complete result omits its Rust receipt binding", () => {
  const candidate = completeCandidate();
  const plan = fullStageBindingPlan({ productJourneySet: null });
  const receipt = {
    version: 3,
    profile: "full",
    coverage: { completeness: "complete", fromStage: null },
    candidate,
    status: "passed",
    stages: passedStagesForPlan(plan),
    productJourneyEvidence: completeProductJourneyEvidence({
      acceptanceRequired: true,
      acceptanceComplete: true,
      c2zcRustAcceptance: null,
    }),
  };

  assert.throws(
    () => verifyLocalCiReceipt(receipt, { profile: "full", candidate, plan }),
    /C2-ZC|Rust|acceptance|evidence/i,
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
    "local-ci",
    "runs",
    LOCAL_CI_TEST_RUN_ID,
    "product-journeys",
  );
  const resultsPath = path.join(artifactRoot, "results.json");
  const manifestPath = path.join(artifactRoot, "manifest.json");
  const buildRoot = path.join(temporaryRoot, "build");
  const mainPath = path.join(temporaryRoot, "dist-electron", "main.cjs");
  const rendererPath = path.join(temporaryRoot, "dist", "index.html");
  const nativePath = path.join(buildRoot, "grimodex-node.node");
  const mcpRequestedPath = path.join(buildRoot, "grimodex-mcp");
  const mcpTargetA = path.join(buildRoot, "grimodex-mcp-a");
  const mcpTargetB = path.join(buildRoot, "grimodex-mcp-b");
  await Promise.all([
    mkdir(buildRoot, { recursive: true }),
    mkdir(path.dirname(mainPath), { recursive: true }),
    mkdir(path.dirname(rendererPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(mainPath, "electron main", "utf8"),
    writeFile(rendererPath, "renderer", "utf8"),
    writeFile(nativePath, "native module", "utf8"),
    writeFile(mcpTargetA, "mcp sidecar A", "utf8"),
    writeFile(mcpTargetB, "mcp sidecar B", "utf8"),
  ]);
  await Promise.all([chmod(mcpTargetA, 0o755), chmod(mcpTargetB, 0o755)]);
  await symlink(path.basename(mcpTargetA), mcpRequestedPath);
  await mkdir(artifactRoot, { recursive: true });
  const journeyIds = PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id);
  const results = {
    version: 5,
    status: "passed",
    catalogDigest: PRODUCT_JOURNEY_CATALOG_DIGEST,
    catalogJourneyIds: journeyIds,
    journeyIds,
    allPassed: true,
    allClean: true,
    rustAcceptanceComplete: true,
    buildReceipt: null,
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
    return {
      name,
      path: requestedPath,
      requestedPath,
      realPath,
      size: (await readFile(realPath)).byteLength,
      sha256,
    };
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
      rustAcceptanceComplete: true,
      buildReceipt: null,
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
                ".artifacts/local-ci/runs/__LOCAL_CI_RUN_ID__/product-journeys",
              GRIMODEX_NODE_PATH: nativePath,
              GRIMODEX_MCP_PATH: mcpRequestedPath,
            },
          },
        ],
      },
    ],
  };
  const collectEvidence = (options = {}) =>
    collectProductJourneyEvidence(plan, {
      root: temporaryRoot,
      runId: LOCAL_CI_TEST_RUN_ID,
      ...options,
    });
  await assert.rejects(
    collectProductJourneyEvidence(plan, { root: temporaryRoot }),
    /Product journey evidence run must be a UUIDv4/u,
  );
  const evidence = await collectEvidence();
  assert.equal(
    plan.stages[0].commands[0].env.GRIMODEX_PRODUCT_JOURNEY_ARTIFACT_DIR,
    ".artifacts/local-ci/runs/__LOCAL_CI_RUN_ID__/product-journeys",
  );
  assert.deepEqual(evidence.journeyIds, journeyIds);
  assert.equal(evidence.results.sha256, resultsSha256);
  assert.equal(evidence.artifacts.length, 6);
  assert.equal(
    evidence.manifest.path,
    `.artifacts/local-ci/runs/${LOCAL_CI_TEST_RUN_ID}/product-journeys/manifest.json`,
  );
  assert.match(evidence.artifactDigest, /^sha256:[0-9a-f]{64}$/);

  const candidate = completeCandidate();
  const receiptPlan = fullStageBindingPlan();
  const receipt = {
    version: 3,
    profile: "full",
    coverage: { completeness: "complete", fromStage: null },
    candidate,
    status: "passed",
    stages: passedStagesForPlan(receiptPlan),
    productJourneyEvidence: evidence,
  };
  assert.doesNotThrow(() =>
    verifyLocalCiReceipt(receipt, {
      profile: "full",
      candidate,
      plan: receiptPlan,
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
  await assert.rejects(collectEvidence(), /exactly .*build artifacts|missing/i);
  await writeFile(manifestPath, manifestText, "utf8");

  const reorderedManifest = JSON.parse(manifestText);
  reorderedManifest.artifacts.reverse();
  await writeFile(
    manifestPath,
    `${JSON.stringify(reorderedManifest, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    collectEvidence(),
    /exactly|order|artifact/i,
    "manifest artifact order mutation must be rejected",
  );
  await writeFile(manifestPath, manifestText, "utf8");

  const staleSizeManifest = JSON.parse(manifestText);
  staleSizeManifest.artifacts[0].size += 1;
  await writeFile(
    manifestPath,
    `${JSON.stringify(staleSizeManifest, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    collectEvidence(),
    /size|artifact/i,
    "manifest artifact size mutation must be rejected",
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
          plan: receiptPlan,
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
    collectEvidence(),
    /changed after preflight|artifact.*mismatch/i,
  );
  await writeFile(manifestPath, manifestText, "utf8");

  await writeFile(mainPath, "electron main tampered", "utf8");
  await assert.rejects(
    collectEvidence(),
    /changed after preflight|artifact.*mismatch/i,
  );
  await writeFile(mainPath, "electron main", "utf8");

  await rm(mcpRequestedPath);
  await symlink(path.basename(mcpTargetB), mcpRequestedPath);
  await assert.rejects(
    collectEvidence(),
    /changed after preflight|artifact.*mismatch/i,
  );
  await rm(mcpRequestedPath);
  await symlink(path.basename(mcpTargetA), mcpRequestedPath);

  await rm(nativePath);
  await assert.rejects(collectEvidence(), /ENOENT|regular file|artifact/i);

  await writeFile(nativePath, "native module", "utf8");
  const rustReceipt = await createC2ZcRustAcceptanceReceipt({
    root: temporaryRoot,
    candidate,
    catalogDigest: C2ZC_RUST_ACCEPTANCE_CATALOG_DIGEST,
    resolveCandidate: async () => candidate,
    execute: async (_command, { gate }) => ({
      exitCode: 0,
      signal: null,
      stdout: exactRustGateOutput(gate.id),
      stderr: "",
    }),
  });
  const rustEvidence = {
    required: true,
    verified: true,
    receiptPath: rustReceipt.receiptPath,
    receiptSha256: rustReceipt.receiptSha256,
    candidate,
    gates: rustReceipt.receipt.gates,
    verifyOutcome: rustReceipt.receipt.verifyOutcome,
    receipt: rustReceipt.receipt,
  };
  const acceptedReport = {
    ...results,
    acceptanceRequired: true,
    rustAcceptanceComplete: true,
    buildReceipt: {
      version: 1,
      verified: true,
      source: "local-ci-candidate",
      candidate,
      artifacts: buildArtifacts,
    },
    acceptanceComplete: true,
    c2zcRustAcceptance: rustEvidence,
  };
  const acceptedResultsText = `${JSON.stringify(acceptedReport, null, 2)}\n`;
  const acceptedResultsSha256 = `sha256:${createHash("sha256")
    .update(acceptedResultsText)
    .digest("hex")}`;
  const acceptedManifest = {
    ...JSON.parse(manifestText),
    acceptanceRequired: true,
    rustAcceptanceComplete: true,
    buildReceipt: {
      version: 1,
      verified: true,
      source: "local-ci-candidate",
      candidate,
      artifacts: buildArtifacts,
    },
    acceptanceComplete: true,
    c2zcRustAcceptance: rustEvidence,
  };
  acceptedManifest.results = {
    ...acceptedManifest.results,
    sha256: acceptedResultsSha256,
  };
  await writeFile(resultsPath, acceptedResultsText, "utf8");
  await writeFile(
    manifestPath,
    `${JSON.stringify(acceptedManifest, null, 2)}\n`,
    "utf8",
  );
  const acceptedEvidence = await collectEvidence({ candidate });
  assert.equal(acceptedEvidence.acceptanceRequired, true);
  assert.equal(acceptedEvidence.acceptanceComplete, true);
  assert.equal(
    acceptedEvidence.c2zcRustAcceptance.receiptSha256,
    rustReceipt.receiptSha256,
  );
  const acceptedFixtureEvidence = c2zcFixtureEvidence(candidate);
  const acceptedReceiptPlan = fullStageBindingPlan({
    productJourneySet: null,
  });
  // Full collection stores the complete, re-verifiable fixture evidence here;
  // only product results/manifests use the compact summary.
  acceptedEvidence.c2zcRestoreFixture = acceptedFixtureEvidence;
  const acceptedLocalReceipt = {
    version: 3,
    profile: "full",
    coverage: { completeness: "complete", fromStage: null },
    candidate,
    runId: LOCAL_CI_TEST_RUN_ID,
    status: "passed",
    stages: passedStagesForPlan(acceptedReceiptPlan),
    productJourneyEvidence: acceptedEvidence,
    c2zcRestoreFixture: acceptedFixtureEvidence,
  };
  assert.doesNotThrow(() =>
    verifyLocalCiReceipt(acceptedLocalReceipt, {
      profile: "full",
      candidate,
      plan: acceptedReceiptPlan,
      currentProductJourneyEvidence: acceptedEvidence,
      currentC2ZcRestoreFixtureEvidence: acceptedFixtureEvidence,
    }),
  );
  for (const mutate of [
    (evidence) => delete evidence.c2zcRustAcceptance.receipt,
    (evidence) => evidence.c2zcRustAcceptance.gates.pop(),
    (evidence) => {
      evidence.c2zcRustAcceptance.candidate = {
        ...evidence.c2zcRustAcceptance.candidate,
        currentHeadSha: "f".repeat(40),
      };
    },
    (evidence) => {
      evidence.buildReceipt.candidate = {
        ...evidence.buildReceipt.candidate,
        currentHeadSha: "f".repeat(40),
      };
    },
    (evidence) => {
      evidence.buildReceipt.foreignKey = "must-reject";
    },
    (evidence) => {
      delete evidence.buildReceipt.artifacts;
    },
    (evidence) => {
      evidence.artifacts[0].sha256 = `sha256:${"f".repeat(64)}`;
    },
    (evidence) => {
      evidence.buildReceipt.artifacts[0].sha256 = `sha256:${"f".repeat(64)}`;
    },
    (evidence) => {
      evidence.results.sha256 = `sha256:${"f".repeat(64)}`;
    },
    (evidence) => {
      evidence.manifest.sha256 = `sha256:${"f".repeat(64)}`;
    },
  ]) {
    const mutatedEvidence = structuredClone(acceptedEvidence);
    mutate(mutatedEvidence);
    assert.throws(
      () =>
        verifyLocalCiReceipt(
          {
            ...acceptedLocalReceipt,
            productJourneyEvidence: mutatedEvidence,
          },
          {
            profile: "full",
            candidate,
            plan: acceptedReceiptPlan,
            currentProductJourneyEvidence: acceptedEvidence,
            currentC2ZcRestoreFixtureEvidence: acceptedFixtureEvidence,
          },
        ),
      /Rust acceptance gates|candidate|evidence|artifact/i,
    );
  }
  const tamperedManifest = {
    ...acceptedManifest,
    c2zcRustAcceptance: {
      ...rustEvidence,
      receiptSha256: `sha256:${"0".repeat(64)}`,
    },
  };
  await writeFile(
    manifestPath,
    `${JSON.stringify(tamperedManifest, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    collectEvidence({ candidate }),
    /does not bind|match|receipt/i,
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
  assert.equal(
    packageJson.scripts["ci:build:desktop"],
    "node electron/scripts/build.mjs && pnpm exec vite build",
  );
  assert.equal(
    packageJson.scripts["ci:verify:quality"],
    packageJson.scripts["verify:quality"].replace(
      "pnpm eval:narrative",
      "pnpm ci:eval:narrative",
    ),
  );
  assert.equal(
    packageJson.scripts["ci:eval:narrative"]
      .replace(/^vitest --config vitest\.config\.ts /u, "")
      .replace(/ --maxWorkers 4$/u, ""),
    packageJson.scripts["eval:narrative"].replace(/^pnpm test:node /u, ""),
  );
  assert.doesNotMatch(
    packageJson.scripts["ci:eval:narrative"],
    /build:workspace:dependencies/u,
  );
  assert.match(packageJson.scripts["test:quality"], /local-ci\.test\.mjs/);
  assert.match(
    packageJson.scripts["test:quality"],
    /^node --test --test-concurrency=4 /u,
  );
  assert.match(
    packageJson.scripts["test:browser-ci"],
    /^node --test --test-concurrency=2 /u,
  );
  assert.match(
    packageJson.scripts["test:product-journey-contracts"],
    /electron\/scripts\/product-journey-shards\.test\.mjs/u,
  );
  assert.match(
    packageJson.scripts["test:quality"],
    /local-ci-runner\.test\.mjs/,
  );
  assert.match(
    packageJson.scripts["test:quality"],
    /local-ci-process-supervisor\.test\.mjs/,
  );
  assert.match(packageJson.scripts["test:quality"], /ci-pause\.test\.mjs/);
});

test("Full task plan preserves obligations across Cargo-native Rust shards", async () => {
  const registry = await readRegistry();
  const plan = buildLocalCiPlan(registry, {
    profile: "full",
    base: "origin/master",
    head: "HEAD",
  });
  const tasksById = new Map(plan.tasks.map((task) => [task.id, task]));
  const obligations = plan.tasks.flatMap(
    (task) => task.obligations ?? [task.id],
  );

  assert.deepEqual(
    plan.stages.map(({ id }) => id),
    [
      "bootstrap",
      "migration-recovery-gate",
      "security",
      "frontend",
      "browser",
      "electron-native",
      "c2-zc-rust-acceptance-gate",
      "c2-zc-restore-fixture-builder",
      "quality",
      "electron-product-journeys",
      "lfm-encoder-phase0",
      "rust",
      "webgl",
      "storybook",
      "electron",
      "electron-runtime-performance",
    ],
  );
  assert.deepEqual(
    plan.stages.find(({ id }) => id === "rust").commands.map(({ id }) => id),
    [
      "rust.supervisor-failpoints",
      "rust.c-query-worker",
      "rust.tests-db-integrations",
      "rust.tests-db-lib",
      "rust.tests-db-nir1-capacity",
      "rust.tests-db-nir1-capacity-binary",
      "rust.tests-other-workspace",
      "rust.check",
      "rust.clippy",
      "rust.tests-db-doctests",
      "rust.tests",
      "rust.runtime-authority",
      "rust.license",
    ],
  );
  const cQueryWorkerTask = tasksById.get("rust.c-query-worker");
  assert.equal(cQueryWorkerTask.command.command, "bash");
  assert.deepEqual(cQueryWorkerTask.command.args, [
    "scripts/nir1-c-query-worker-ci.sh",
  ]);
  assert.equal(cQueryWorkerTask.command.cwd, ".");
  assert.deepEqual(cQueryWorkerTask.after, ["bootstrap.install"]);
  assert.equal(cQueryWorkerTask.lane, "cargo-shared");
  assert.equal(cQueryWorkerTask.slots, 2);
  assert.equal(cQueryWorkerTask.timeoutMs, 2700000);
  assert.equal(cQueryWorkerTask.command.env.CARGO_BUILD_JOBS, "2");
  assert.deepEqual(cQueryWorkerTask.obligations, []);
  assert.deepEqual(
    plan.stages
      .find(({ id }) => id === "frontend")
      .commands.map(({ id }) => id),
    [
      "frontend.unit-shard-1",
      "frontend.unit-shard-2",
      "frontend.unit",
      "frontend.typecheck",
      "frontend.lint",
      "frontend.architecture",
      "frontend.browser-contracts",
      "frontend.web-build",
    ],
  );
  assert.deepEqual(
    plan.stages
      .find(({ id }) => id === "electron")
      .commands.map(({ id }) => id),
    [
      "electron.typecheck",
      "electron.build",
      "electron.budget",
      "electron.contracts",
      "electron.unit",
    ],
  );
  assert.deepEqual(
    plan.stages
      .find(({ id }) => id === "electron-native")
      .commands.map(({ id }) => id),
    [
      "native.build",
      "native.public-tests",
      "native.check",
      "native.clippy",
      "native.tests",
      "native.mcp-tests",
    ],
  );
  const nativeTestsTask = tasksById.get("native.tests");
  assert.equal(nativeTestsTask.command.command, "cargo");
  assert.deepEqual(nativeTestsTask.command.args, [
    "test",
    "--manifest-path",
    "electron/native/grimodex-node/Cargo.toml",
    "--features",
    "licensing,legacy-keyring-migration",
  ]);
  assert.equal(nativeTestsTask.command.cwd, ".");
  assert.deepEqual(nativeTestsTask.after, ["bootstrap.install"]);
  assert.equal(nativeTestsTask.lane, "cargo-native");
  assert.equal(nativeTestsTask.slots, 2);
  assert.ok(nativeTestsTask.timeoutMs > 0);
  assert.equal(nativeTestsTask.timeoutMs, 900_000);
  assert.equal(nativeTestsTask.command.env.CARGO_PROFILE_DEV_DEBUG, "0");
  assert.equal(nativeTestsTask.command.env.CARGO_PROFILE_TEST_DEBUG, "0");
  assert.equal(nativeTestsTask.command.env.CARGO_BUILD_JOBS, "2");
  assert.equal(nativeTestsTask.command.env.RUST_TEST_THREADS, "2");
  assert.equal(nativeTestsTask.obligations, undefined);
  assert.deepEqual(
    plan.stages.find(({ id }) => id === "webgl").commands.map(({ id }) => id),
    ["webgl.zen", "webgl.tests"],
  );
  assert.deepEqual(
    plan.stages
      .find(({ id }) => id === "electron-product-journeys")
      .commands.map(({ id }) => id),
    [
      "journeys.mcp-build",
      "journeys.shard-1",
      "journeys.shard-2",
      "journeys.shard-3",
      "journeys.shard-4",
      "journeys.shard-5",
      "journeys.shard-6",
      "journeys.shard-7",
      "journeys.run",
    ],
  );
  assert.equal(plan.tasks.length, 68);
  assert.equal(tasksById.size, 68);
  assert.equal(obligations.length, 52);
  assert.equal(new Set(obligations).size, 52);
  assert.equal(
    obligations.filter((obligation) => obligation === "frontend.unit").length,
    1,
  );
  for (const id of ["frontend.unit-shard-1", "frontend.unit-shard-2"]) {
    assert.equal(obligations.includes(id), false);
  }
  assert.deepEqual(tasksById.get("rust.supervisor-failpoints").obligations, [
    "rust.supervisor-failpoints",
    "migration.supervisor-failpoints",
  ]);
  assert.equal(
    obligations.filter((obligation) => obligation === "rust.tests").length,
    1,
  );

  const journeyArtifactDir =
    ".artifacts/local-ci/runs/__LOCAL_CI_RUN_ID__/product-journeys";
  const journeyEnv = {
    CI: "true",
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
    GRIMODEX_PRODUCT_JOURNEY_ARTIFACT_DIR: journeyArtifactDir,
    GRIMODEX_PRODUCT_JOURNEY_REQUIRE_ALL: "true",
    GRIMODEX_PRODUCT_JOURNEY_IDS: "",
    GRIMODEX_PRODUCT_JOURNEY_SET: "",
    GRIMODEX_C2ZC_RUST_RECEIPT_PATH:
      ".artifacts/local-ci/c2-zc-rust-acceptance.json",
    GRIMODEX_C2ZC_RUST_REQUESTED_BASE: "origin/master",
    GRIMODEX_C2ZC_RUST_REQUESTED_HEAD: "HEAD",
  };
  const shardDependencies = [
    "journeys.mcp-build",
    "native.public-tests",
    "c2zc.fixture-verify",
    "webgl.tests",
  ];
  const mcpBuildTask = tasksById.get("journeys.mcp-build");
  const electronBinaryTask = tasksById.get("bootstrap.electron-binary");
  assert.equal(electronBinaryTask.command.command, "node");
  assert.deepEqual(electronBinaryTask.command.args, [
    "scripts/ensure-electron-binary.mjs",
  ]);
  assert.deepEqual(electronBinaryTask.after, ["bootstrap.install"]);
  assert.equal(electronBinaryTask.timeoutMs, 180_000);
  assert.deepEqual(electronBinaryTask.obligations, []);
  assert.equal(mcpBuildTask.command.command, "pnpm");
  assert.deepEqual(mcpBuildTask.command.args, ["mcp:build"]);
  assert.deepEqual(mcpBuildTask.after, [
    "electron.build",
    "native.build",
    "bootstrap.electron-binary",
  ]);
  assert.equal(mcpBuildTask.lane, "cargo-shared");
  assert.equal(mcpBuildTask.slots, 2);
  assert.equal(mcpBuildTask.timeoutMs, 180_000);
  assert.equal(mcpBuildTask.command.env.CARGO_PROFILE_DEV_DEBUG, "0");
  assert.equal(mcpBuildTask.command.env.CARGO_PROFILE_TEST_DEBUG, "0");
  assert.equal(mcpBuildTask.command.env.CARGO_BUILD_JOBS, "2");
  for (const shard of ["1", "2", "3", "4", "5", "6", "7"]) {
    const task = tasksById.get(`journeys.shard-${shard}`);
    assert.equal(task.command.command, "node");
    assert.deepEqual(task.command.args, [
      "scripts/local-ci-xvfb.mjs",
      "node",
      "electron/scripts/product-journey-shards.mjs",
      "run",
      "--shard",
      shard,
      "--output-dir",
      journeyArtifactDir,
    ]);
    assert.deepEqual(task.command.env, journeyEnv);
    assert.deepEqual(
      task.after,
      Number(shard) <= 3
        ? shardDependencies
        : [...shardDependencies, `journeys.shard-${Number(shard) - 3}`],
    );
    assert.deepEqual(task.obligations, []);
    assert.equal(task.lane, `journey-shard-${shard}`);
    assert.equal(task.slots, 2);
    assert.equal(task.timeoutMs, 240_000);
  }
  const calibratedJourneyCoLoad = [
    ...["1", "2", "3"].map((shard) => tasksById.get(`journeys.shard-${shard}`)),
    tasksById.get("quality.contracts"),
    tasksById.get("browser.tests"),
  ];
  assert.deepEqual(
    calibratedJourneyCoLoad.map(({ id, slots }) => [id, slots]),
    [
      ["journeys.shard-1", 2],
      ["journeys.shard-2", 2],
      ["journeys.shard-3", 2],
      ["quality.contracts", 4],
      ["browser.tests", 2],
    ],
  );
  assert.equal(
    calibratedJourneyCoLoad.reduce(
      (usedSlots, task) => usedSlots + task.slots,
      0,
    ),
    registry.maxSlots,
  );
  const aggregate = tasksById.get("journeys.run");
  assert.equal(aggregate.command.command, "node");
  assert.deepEqual(aggregate.command.args, [
    "electron/scripts/product-journey-shards.mjs",
    "aggregate",
    "--output-dir",
    journeyArtifactDir,
  ]);
  assert.deepEqual(aggregate.command.env, journeyEnv);
  assert.deepEqual(aggregate.after, [
    "journeys.shard-1",
    "journeys.shard-2",
    "journeys.shard-3",
    "journeys.shard-4",
    "journeys.shard-5",
    "journeys.shard-6",
    "journeys.shard-7",
  ]);
  assert.equal(aggregate.obligations, undefined);
  assert.equal(
    obligations.filter((obligation) => obligation === "journeys.run").length,
    1,
  );

  const cargoShardExpectations = new Map([
    ["rust.tests-db-lib", ["test", "-p", "grimodex-db", "--lib"]],
    [
      "rust.tests-db-nir1-capacity",
      [
        "test",
        "-p",
        "grimodex-db",
        "--features",
        "nir1-material-diagnostics",
        "--lib",
        "narrative_extraction::nir1_capacity",
      ],
    ],
    [
      "rust.tests-db-nir1-capacity-binary",
      [
        "test",
        "-p",
        "grimodex-db",
        "--features",
        "nir1-material-diagnostics",
        "--test",
        "nir1_capacity_binary",
      ],
    ],
    [
      "rust.tests-db-integrations",
      ["test", "-p", "grimodex-db", "--test", "*", "--bin", "schema-contract"],
    ],
    [
      "rust.tests-other-workspace",
      [
        "test",
        "--workspace",
        "--exclude",
        "grimodex",
        "--exclude",
        "grimodex-db",
        "--features",
        "grimodex-semantic/semantic-embedding",
      ],
    ],
  ]);
  const shardLanes = new Set();
  for (const [id, args] of cargoShardExpectations) {
    const task = tasksById.get(id);
    assert.equal(task.command.command, "cargo");
    assert.deepEqual(task.command.args, args);
    assert.equal(task.command.cwd, "src-tauri");
    assert.equal(task.command.env.CARGO_PROFILE_DEV_DEBUG, "0");
    assert.equal(task.command.env.CARGO_PROFILE_TEST_DEBUG, "0");
    assert.equal(task.command.env.CARGO_BUILD_JOBS, "2");
    assert.equal(task.command.env.RUST_TEST_THREADS, "2");
    assert.equal(task.slots, 2);
    assert.deepEqual(task.obligations, []);
    shardLanes.add(task.lane);
  }
  assert.equal(shardLanes.size, cargoShardExpectations.size);

  assert.deepEqual(tasksById.get("rust.tests-db-doctests").command.args, [
    "test",
    "-p",
    "grimodex-db",
    "--doc",
  ]);
  assert.deepEqual(tasksById.get("rust.tests-db-doctests").after, [
    "rust.tests-db-lib",
  ]);
  assert.deepEqual(tasksById.get("rust.tests").command.args, [
    "test",
    "--workspace",
    "--exclude",
    "grimodex",
    "--features",
    "grimodex-semantic/semantic-embedding",
    "--no-run",
  ]);
  const rustTestsTask = tasksById.get("rust.tests");
  assert.equal(rustTestsTask.lane, "cargo-shared");
  assert.equal(rustTestsTask.slots, 2);
  assert.deepEqual(rustTestsTask.after, [
    "rust.tests-db-lib",
    "rust.tests-db-integrations",
    "rust.tests-db-nir1-capacity",
    "rust.tests-db-nir1-capacity-binary",
    "rust.tests-other-workspace",
    "rust.tests-db-doctests",
  ]);
  assert.deepEqual(rustTestsTask.obligations, ["rust.tests"]);
  const c2Task = tasksById.get("c2zc.rust-acceptance");
  assert.equal(rustTestsTask.lane, c2Task.lane);
  assert.deepEqual(c2Task.after, ["rust.supervisor-failpoints"]);
  assert.equal(c2Task.slots, registry.maxSlots);
  assert.equal(c2Task.command.env.CARGO_PROFILE_DEV_DEBUG, "0");
  assert.equal(c2Task.command.env.CARGO_PROFILE_TEST_DEBUG, "0");
  assert.equal(c2Task.command.env.CARGO_BUILD_JOBS, "2");
  assert.equal(c2Task.command.env.RUST_TEST_THREADS, "2");
  const c2Dependencies = new Set();
  const visitC2Dependency = (id) => {
    for (const dependency of tasksById.get(id).after) {
      if (c2Dependencies.has(dependency)) continue;
      c2Dependencies.add(dependency);
      visitC2Dependency(dependency);
    }
  };
  visitC2Dependency("c2zc.rust-acceptance");
  assert.deepEqual([...c2Dependencies].sort(), [
    "bootstrap.install",
    "rust.supervisor-failpoints",
  ]);
  for (const id of [
    ...cargoShardExpectations.keys(),
    "rust.tests-db-doctests",
    "rust.tests",
    "rust.check",
    "rust.clippy",
    "rust.runtime-authority",
    "rust.license",
  ]) {
    assert.equal(
      c2Dependencies.has(id),
      false,
      `${id} must not gate C2-ZC Rust acceptance`,
    );
  }

  for (const id of ["c2zc.fixture-build", "c2zc.fixture-verify"]) {
    const task = tasksById.get(id);
    assert.equal(task.slots, 2);
    assert.equal(task.command.env.CARGO_PROFILE_DEV_DEBUG, "0");
    assert.equal(task.command.env.CARGO_PROFILE_TEST_DEBUG, "0");
    assert.equal(task.command.env.CARGO_BUILD_JOBS, "2");
  }

  assert.equal(
    tasksById.get("rust.supervisor-failpoints").lane,
    "cargo-recovery",
  );
  assert.deepEqual(tasksById.get("rust.supervisor-failpoints").after, [
    "bootstrap.install",
  ]);
  assert.deepEqual(tasksById.get("migration.supervisor").after, [
    "rust.supervisor-failpoints",
  ]);
  for (const id of [
    "rust.supervisor-failpoints",
    "migration.supervisor",
    "migration.failpoints-lib",
    "migration.safe-mode",
    "migration.release-schema",
    "migration.crash",
  ]) {
    const task = tasksById.get(id);
    assert.equal(task.lane, "cargo-recovery");
    assert.equal(task.slots, 2);
    assert.equal(task.command.env.CARGO_BUILD_JOBS, "2");
    assert.equal(task.command.env.RUST_TEST_THREADS, "2");
  }
  assert.equal(tasksById.get("migration.ipc").slots, 2);
  assert.equal(tasksById.get("migration.ui").slots, 4);

  assert.equal(registry.maxSlots, 12);
  assert.equal(plan.stages.at(-1).id, "electron-runtime-performance");
  const runtimeContracts = tasksById.get("runtime.contracts");
  const runtimeBenchmark = tasksById.get("runtime.benchmark");
  assert.equal(plan.tasks.at(-1).id, "runtime.benchmark");
  assert.deepEqual(runtimeContracts.after, ["bootstrap.workspace-build"]);
  assert.equal(runtimeContracts.slots, 4);
  assert.equal(runtimeBenchmark.slots, registry.maxSlots);
  assert.ok(runtimeBenchmark.after.includes("runtime.contracts"));
  const preRuntimeTasks = plan.tasks.filter(
    ({ id }) => !id.startsWith("runtime."),
  );
  const dependedOnBeforeRuntime = new Set(
    preRuntimeTasks.flatMap(({ after }) => after),
  );
  const preRuntimeTerminals = preRuntimeTasks
    .filter(({ id }) => !dependedOnBeforeRuntime.has(id))
    .map(({ id }) => id)
    .sort();
  assert.deepEqual(
    [...runtimeBenchmark.after].sort(),
    [...preRuntimeTerminals, "runtime.contracts"].sort(),
  );
  const directRuntimeRustDependencies = [
    "rust.check",
    "rust.clippy",
    "rust.tests",
    "rust.runtime-authority",
    "rust.license",
  ];
  for (const id of directRuntimeRustDependencies) {
    assert.ok(
      runtimeBenchmark.after.includes(id),
      `${id} must directly gate runtime benchmark`,
    );
  }
  for (const id of ["browser.tests", "storybook.tests", "migration.ui"]) {
    assert.ok(
      runtimeBenchmark.after.includes(id),
      `${id} must directly gate runtime benchmark`,
    );
  }
  const runtimeDependencies = new Set();
  const visitRuntimeDependency = (id) => {
    for (const dependency of tasksById.get(id).after) {
      if (runtimeDependencies.has(dependency)) continue;
      runtimeDependencies.add(dependency);
      visitRuntimeDependency(dependency);
    }
  };
  visitRuntimeDependency("runtime.benchmark");
  for (const { id } of plan.stages.find(({ id }) => id === "rust").commands) {
    assert.ok(runtimeDependencies.has(id), `${id} must gate runtime benchmark`);
  }
  assert.match(
    plan.tasks
      .find(({ id }) => id === "frontend.web-build")
      .command.args.join(" "),
    /__LOCAL_CI_RUN_ID__\/web-editor/u,
  );
  assert.deepEqual(
    plan.tasks.find(({ id }) => id === "electron.build").command.args,
    ["ci:build:desktop"],
  );
  assert.deepEqual(plan.tasks.find(({ id }) => id === "electron.build").after, [
    "electron.typecheck",
  ]);
  assert.equal(
    plan.tasks.find(({ id }) => id === "electron.build").lane,
    undefined,
  );
  assert.equal(
    plan.tasks.find(({ id }) => id === "frontend.web-build").lane,
    undefined,
  );
  assert.deepEqual(
    plan.tasks.find(({ id }) => id === "quality.contracts").command.args,
    ["ci:verify:quality"],
  );
  assert.equal(
    plan.tasks.find(({ id }) => id === "frontend.browser-contracts").slots,
    2,
  );
  const frontendUnitArgs = [
    "exec",
    "vitest",
    "--config",
    "vitest.config.ts",
    "--run",
    "--maxWorkers",
    "2",
  ];
  const frontendUnitShardExpectations = [
    ["frontend.unit-shard-1", "1/3", []],
    ["frontend.unit-shard-2", "2/3", []],
    ["frontend.unit", "3/3", undefined],
  ];
  for (const [id, shard, taskObligations] of frontendUnitShardExpectations) {
    const task = tasksById.get(id);
    assert.equal(task.command.command, "pnpm");
    assert.deepEqual(task.command.args, [
      ...frontendUnitArgs,
      "--shard",
      shard,
    ]);
    assert.equal(
      task.command.args[task.command.args.indexOf("--maxWorkers") + 1],
      "2",
    );
    assert.equal(
      task.command.args[task.command.args.indexOf("--shard") + 1],
      shard,
    );
    assert.deepEqual(task.after, ["bootstrap.workspace-build"]);
    assert.equal(task.slots, 2);
    assert.equal(task.lane, undefined);
    assert.deepEqual(task.obligations, taskObligations);
    assert.ok(
      runtimeBenchmark.after.includes(id),
      `${id} must directly gate runtime benchmark`,
    );
  }
  const browserTask = plan.tasks.find(({ id }) => id === "browser.tests");
  const browserWorkerIndex = browserTask.command.args.indexOf("--max-workers");
  assert.equal(browserTask.command.args[browserWorkerIndex + 1], "2");
  assert.equal(browserTask.slots, 2);
  assert.ok(
    plan.tasks
      .find(({ id }) => id === "electron.contracts")
      .command.args.includes("--test-concurrency=4"),
  );
  assert.deepEqual(
    plan.tasks.find(({ id }) => id === "electron.unit").command.args.slice(-2),
    ["--maxWorkers", "4"],
  );
  assert.deepEqual(
    plan.tasks.find(({ id }) => id === "migration.ui").command.args.slice(0, 5),
    ["exec", "vitest", "--run", "--maxWorkers", "4"],
  );
  assert.equal(
    plan.tasks.find(({ id }) => id === "journeys.run").command.env
      .GRIMODEX_PRODUCT_JOURNEY_WORKERS,
    undefined,
  );
});

test("Full priority admits ready browser work when two slots reopen before later bulk tasks", async () => {
  const registry = await readRegistry();
  const plan = buildLocalCiPlan(registry, {
    profile: "full",
    base: "origin/master",
    head: "HEAD",
  });
  const selectedIds = new Set([
    "browser.tests",
    "native.tests",
    "lfm.dataset",
    "runtime.benchmark",
  ]);
  // Keep real priority, lanes, and slot weights; other prerequisites have passed.
  const readyTasks = plan.tasks
    .filter(({ id }) => selectedIds.has(id))
    .map((task) => ({
      ...task,
      after: task.after.filter((id) => selectedIds.has(id)),
    }));
  const tasks = [
    { id: "fixture.capacity-holder", slots: 10 },
    { id: "fixture.release-two-slots", slots: 2 },
    ...readyTasks,
  ];
  const started = [];
  const completed = new Set();
  const release = new Map();
  const settleAdmissions = () =>
    new Promise((resolve) => setImmediate(resolve));
  const running = runLocalCiTasks(tasks, {
    maxSlots: registry.maxSlots,
    executeTask(task) {
      started.push(task.id);
      return new Promise((resolve) => {
        release.set(task.id, () => {
          completed.add(task.id);
          resolve({ cleanup: { complete: true }, exitCode: 0, signal: null });
        });
      });
    },
  });

  await settleAdmissions();
  assert.deepEqual(started, [
    "fixture.capacity-holder",
    "fixture.release-two-slots",
  ]);
  release.get("fixture.release-two-slots")();
  await settleAdmissions();
  assert.equal(started.at(-1), "browser.tests");
  assert.equal(started.includes("native.tests"), false);
  assert.equal(started.includes("lfm.dataset"), false);

  for (const [finished, next] of [
    ["browser.tests", "native.tests"],
    ["native.tests", "lfm.dataset"],
  ]) {
    release.get(finished)();
    await settleAdmissions();
    assert.equal(started.at(-1), next);
    assert.equal(started.includes("runtime.benchmark"), false);
  }
  release.get("fixture.capacity-holder")();
  await settleAdmissions();
  assert.equal(started.includes("runtime.benchmark"), false);
  release.get("lfm.dataset")();
  await settleAdmissions();
  assert.equal(started.at(-1), "runtime.benchmark");
  assert.deepEqual(
    [...completed].sort(),
    tasks
      .filter(({ id }) => id !== "runtime.benchmark")
      .map(({ id }) => id)
      .sort(),
  );
  release.get("runtime.benchmark")();
  assert.equal((await running).status, "passed");
});

test("parallel task cap preserves the complete plan and default slot budget", async () => {
  const registry = await readRegistry();
  const options = { profile: "full", base: "origin/master", head: "HEAD" };
  const normal = buildLocalCiPlan(registry, options);
  const serial = buildLocalCiPlan(registry, {
    ...options,
    maxParallelTasks: 1,
  });
  assert.equal(normal.maxParallelTasks, 12);
  assert.equal(serial.maxSlots, 12);
  assert.equal(serial.maxParallelTasks, 1);
  assert.deepEqual(serial.tasks, normal.tasks);
  assert.deepEqual(serial.stages, normal.stages);
  assert.deepEqual(serial.coverage, normal.coverage);
  assert.equal(serial.registryDigest, normal.registryDigest);
  for (const maxParallelTasks of [0, -1, 1.5, 13, NaN, Infinity]) {
    assert.throws(
      () => buildLocalCiPlan(registry, { ...options, maxParallelTasks }),
      /--max-parallel-tasks/u,
    );
  }
});

test("receipt plan binding rejects descriptor changes and unclean task results", async () => {
  const registry = await readRegistry();
  const plan = buildLocalCiPlan(registry, {
    profile: "quick",
    base: "origin/master",
    head: "HEAD",
  });
  const candidate = completeCandidate();
  const receipt = {
    version: 3,
    profile: "quick",
    status: "passed",
    coverage: plan.coverage,
    candidate,
    candidateAfter: candidate,
    runId: LOCAL_CI_TEST_RUN_ID,
    durationMs: 10,
    registryDigest: plan.registryDigest,
    plan: createLocalCiPlanDescriptor(plan),
    tasks: [
      {
        id: "impact.select",
        status: "passed",
        exitCode: 0,
        signal: null,
        cleanup: { complete: true },
        durationMs: 1,
        logs: {
          stdout: {
            path: `.artifacts/local-ci/runs/${LOCAL_CI_TEST_RUN_ID}/logs/impact.select.stdout.log`,
            size: 0,
            sha256: `sha256:${"0".repeat(64)}`,
          },
          stderr: {
            path: `.artifacts/local-ci/runs/${LOCAL_CI_TEST_RUN_ID}/logs/impact.select.stderr.log`,
            size: 0,
            sha256: `sha256:${"0".repeat(64)}`,
          },
        },
      },
    ],
  };
  assert.equal(
    verifyLocalCiReceipt(receipt, { candidate, plan, profile: "quick" }),
    receipt,
  );

  const tampered = structuredClone(receipt);
  const serialPlan = buildLocalCiPlan(registry, {
    profile: "quick",
    base: "origin/master",
    head: "HEAD",
    maxParallelTasks: 1,
  });
  assert.throws(
    () =>
      verifyLocalCiReceipt(receipt, {
        candidate,
        plan: serialPlan,
        profile: "quick",
      }),
    /exact task plan/u,
  );
  const serialReceipt = structuredClone(receipt);
  serialReceipt.plan = createLocalCiPlanDescriptor(serialPlan);
  assert.equal(
    verifyLocalCiReceipt(serialReceipt, {
      candidate,
      plan: serialPlan,
      profile: "quick",
    }),
    serialReceipt,
  );
  assert.throws(
    () =>
      verifyLocalCiReceipt(serialReceipt, {
        candidate,
        plan,
        profile: "quick",
      }),
    /exact task plan/u,
  );
  tampered.plan.tasks[0].command.args.push("--changed");
  assert.throws(
    () => verifyLocalCiReceipt(tampered, { candidate, plan, profile: "quick" }),
    /exact task plan/u,
  );

  const missingCandidateAfter = structuredClone(receipt);
  delete missingCandidateAfter.candidateAfter;
  assert.throws(
    () =>
      verifyLocalCiReceipt(missingCandidateAfter, {
        candidate,
        plan,
        profile: "quick",
      }),
    /post-run candidate binding/u,
  );

  const timedOut = structuredClone(receipt);
  timedOut.tasks[0].timedOut = true;
  assert.throws(
    () => verifyLocalCiReceipt(timedOut, { candidate, plan, profile: "quick" }),
    /did not pass cleanly/u,
  );
});

test("task log verification detects tampering and does not rewrite evidence", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-ci-log-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const relativeLogRoot = `.artifacts/local-ci/runs/${LOCAL_CI_TEST_RUN_ID}/logs`;
  const stdoutPath = path.join(
    temporaryRoot,
    relativeLogRoot,
    "task.stdout.log",
  );
  const stderrPath = path.join(
    temporaryRoot,
    relativeLogRoot,
    "task.stderr.log",
  );
  await mkdir(path.dirname(stdoutPath), { recursive: true });
  await Promise.all([
    writeFile(stdoutPath, "original"),
    writeFile(stderrPath, "original"),
  ]);
  const identity = (stream) => ({
    path: `${relativeLogRoot}/task.${stream}.log`,
    size: 8,
    sha256: `sha256:${createHash("sha256").update("original").digest("hex")}`,
  });
  const receipt = {
    runId: LOCAL_CI_TEST_RUN_ID,
    tasks: [
      {
        id: "task",
        status: "passed",
        exitCode: 0,
        signal: null,
        cleanup: { complete: true },
        logs: { stdout: identity("stdout"), stderr: identity("stderr") },
      },
    ],
  };
  const before = JSON.stringify(receipt);
  await verifyLocalCiTaskEvidence(receipt, { root: temporaryRoot });
  assert.equal(JSON.stringify(receipt), before);

  await writeFile(stdoutPath, "tampered");
  await assert.rejects(
    verifyLocalCiTaskEvidence(receipt, { root: temporaryRoot }),
    /log identity changed/u,
  );
});

test("concurrent plan execution preserves dependency and receipt ordering", async () => {
  const runId = LOCAL_CI_TEST_RUN_ID;
  const command = (id, argument) => ({
    id,
    label: id,
    command: "test-command",
    args: [argument],
    cwd: ".",
    env: {},
  });
  const prepare = command("prepare", "__LOCAL_CI_RUN_ID__");
  const fails = command("fails", "fails");
  const later = command("later", "later");
  const task = (entry, stageId, commandIndex, after = []) => ({
    id: entry.id,
    stageId,
    stageLabel: stageId,
    commandIndex,
    command: {
      label: entry.label,
      command: entry.command,
      args: entry.args,
      cwd: entry.cwd,
      env: entry.env,
    },
    after,
  });
  const plan = {
    profile: "quick",
    comparison: { base: "origin/master", head: "HEAD" },
    coverage: { completeness: "complete", fromStage: null },
    maxSlots: 2,
    registryDigest: `sha256:${"a".repeat(64)}`,
    releaseOnlyJobs: [],
    stages: [
      { id: "first", label: "first", commands: [prepare] },
      { id: "second", label: "second", commands: [fails, later] },
    ],
    tasks: [
      task(prepare, "first", 0),
      task(fails, "second", 0, ["prepare"]),
      task(later, "second", 1, ["fails"]),
    ],
  };
  const executed = [];
  const result = await runLocalCiPlan(plan, {
    candidate: completeCandidate(),
    concurrent: true,
    runId,
    async executeCommand(entry, { taskId }) {
      executed.push({ id: taskId, args: entry.args });
      const logs = Object.fromEntries(
        ["stdout", "stderr"].map((stream) => [
          stream,
          {
            path: `.artifacts/local-ci/runs/${runId}/logs/${taskId}.${stream}.log`,
            size: 0,
            sha256: `sha256:${"0".repeat(64)}`,
          },
        ]),
      );
      return {
        cleanup: { complete: true },
        durationMs: 1,
        exitCode: taskId === "fails" ? 1 : 0,
        logs,
        signal: null,
      };
    },
  });

  assert.deepEqual(executed, [
    { id: "prepare", args: [runId] },
    { id: "fails", args: ["fails"] },
  ]);
  assert.deepEqual(
    result.tasks.map(({ id, status }) => [id, status]),
    [
      ["prepare", "passed"],
      ["fails", "failed"],
      ["later", "not-run"],
    ],
  );
  assert.deepEqual(
    result.stages.map((stage) => [
      stage.id,
      stage.status,
      stage.commands.map(({ id }) => id),
    ]),
    [
      ["first", "passed", ["prepare"]],
      ["second", "failed", ["fails", "later"]],
    ],
  );
  assert.equal(result.stages[0].commands[0].args[0], runId);
  assert.equal(result.tasks[0].cleanup.complete, true);
});

test("concurrent plan forwards run scope and external abort to the supervisor", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-ci-run-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const runId = LOCAL_CI_TEST_RUN_ID;
  const ready = path.join(temporaryRoot, "ready");
  const command = {
    id: "node-command",
    label: "node command",
    command: process.execPath,
    args: [
      "--input-type=commonjs",
      "-e",
      `process.stdout.write('scoped');require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`,
    ],
    cwd: ".",
    env: {},
  };
  const plan = {
    profile: "quick",
    comparison: { base: "origin/master", head: "HEAD" },
    coverage: { completeness: "complete", fromStage: null },
    maxSlots: 1,
    registryDigest: `sha256:${"a".repeat(64)}`,
    releaseOnlyJobs: [],
    stages: [{ id: "only", label: "only", commands: [command] }],
    tasks: [
      {
        id: command.id,
        stageId: "only",
        stageLabel: "only",
        commandIndex: 0,
        command: {
          label: command.label,
          command: command.command,
          args: command.args,
          cwd: command.cwd,
          env: command.env,
        },
        after: [],
      },
    ],
  };

  const controller = new AbortController();
  const running = runLocalCiPlan(plan, {
    candidate: completeCandidate(),
    concurrent: true,
    root: temporaryRoot,
    runId,
    signal: controller.signal,
  });
  while (true) {
    try {
      await readFile(ready);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  controller.abort(new Error("test interrupt"));
  const result = await running;

  const task = result.tasks[0];
  assert.equal(result.status, "failed");
  assert.equal(result.interrupted, true);
  assert.equal(task.interrupted, true);
  assert.equal(task.cleanup.complete, true);
  assert.equal(
    task.logs.stdout.path,
    `.artifacts/local-ci/runs/${runId}/logs/node-command.stdout.log`,
  );
  assert.equal(
    await readFile(path.join(temporaryRoot, task.logs.stdout.path), "utf8"),
    "scoped",
  );
  assert.throws(
    () => process.kill(-task.pid, 0),
    (error) => error?.code === "ESRCH",
  );
});

async function nativeCleanupFixture(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-native-ci-cleanup-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = path.join(root, "electron/native/grimodex-node");
  const release = path.join(native, "target/release");
  const debug = path.join(native, "target/debug");
  const binary = path.join(native, "grimodex-node.node");
  const protectedPaths = [
    path.join(root, "src-tauri/target/debug/deps/shared.rlib"),
    path.join(root, "fixtures/restore.json"),
    path.join(root, ".artifacts/local-ci/full.json"),
    path.join(
      root,
      ".artifacts/local-ci/runs/test/logs/native.build.stdout.log",
    ),
  ];
  for (const file of [
    binary,
    path.join(release, "deps/native.rlib"),
    path.join(debug, "deps/native-test"),
    ...protectedPaths,
  ]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, file);
  }
  return { root, native, release, debug, binary, protectedPaths };
}

function nativeCleanupPlan() {
  const commands = [
    ["native.build", "electron-native", []],
    ["native.public-tests", "electron-native", ["native.build"]],
    [
      "c2zc.rust-acceptance",
      "c2-zc-rust-acceptance-gate",
      ["native.public-tests"],
    ],
    ["after-c2zc", "after", ["c2zc.rust-acceptance"]],
  ];
  const stages = [];
  const tasks = [];
  for (const [id, stageId, after] of commands) {
    const command = {
      id,
      label: id,
      command: "mock",
      args: [],
      cwd: ".",
      env: {},
    };
    let stage = stages.find((entry) => entry.id === stageId);
    if (!stage) {
      stage = { id: stageId, label: stageId, commands: [] };
      stages.push(stage);
    }
    const commandIndex = stage.commands.length;
    stage.commands.push(command);
    tasks.push({
      id,
      stageId,
      stageLabel: stageId,
      commandIndex,
      command: { label: id, command: "mock", args: [], cwd: ".", env: {} },
      after,
    });
  }
  return {
    profile: "full",
    comparison: { base: "base", head: "head" },
    coverage: { completeness: "complete", fromStage: null },
    maxSlots: 1,
    maxParallelTasks: 1,
    registryDigest: `sha256:${"a".repeat(64)}`,
    releaseOnlyJobs: [],
    stages,
    tasks,
  };
}

test("Full awaits native build-target cleanup at both last-consumer boundaries", async (t) => {
  const fixture = await nativeCleanupFixture(t);
  const outside = path.join(fixture.root, "outside.txt");
  await writeFile(outside, "keep");
  await symlink(outside, path.join(fixture.debug, "external-link"));
  const observed = [];
  const result = await runLocalCiPlan(nativeCleanupPlan(), {
    candidate: completeCandidate(),
    concurrent: true,
    resolveNativeTargetDirectory: async () =>
      path.join(fixture.native, "target"),
    root: fixture.root,
    runId: LOCAL_CI_TEST_RUN_ID,
    async executeCommand(_command, { taskId }) {
      observed.push(taskId);
      if (taskId === "native.public-tests") {
        await assert.rejects(access(fixture.release), { code: "ENOENT" });
        assert.equal(await readFile(fixture.binary, "utf8"), fixture.binary);
      }
      if (taskId === "after-c2zc") {
        await assert.rejects(access(fixture.debug), { code: "ENOENT" });
      }
      return {
        cleanup: { complete: true, groupAlive: false },
        exitCode: 0,
        signal: null,
      };
    },
  });
  assert.equal(result.status, "passed");
  assert.deepEqual(
    observed,
    nativeCleanupPlan().tasks.map((task) => task.id),
  );
  assert.equal(await readFile(outside, "utf8"), "keep");
  assert.equal(await readFile(fixture.binary, "utf8"), fixture.binary);
  for (const file of fixture.protectedPaths) {
    assert.equal(await readFile(file, "utf8"), file);
  }
});

test("native Cargo cleanup rejects symlinked parents and targets", async (t) => {
  const fixture = await nativeCleanupFixture(t);
  const external = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-native-ci-external-"),
  );
  t.after(() => rm(external, { recursive: true, force: true }));
  const marker = path.join(external, "marker");
  await writeFile(marker, "keep");
  await rm(fixture.release, { recursive: true });
  await symlink(external, fixture.release);
  await assert.rejects(
    cleanupNativeCargoTargetAfterTask("native.build", { root: fixture.root }),
    /target is not a real directory/u,
  );
  assert.equal(await readFile(marker, "utf8"), "keep");
  await rm(fixture.release);
  await rm(path.join(fixture.native, "target"), { recursive: true });
  await symlink(external, path.join(fixture.native, "target"));
  await assert.rejects(
    cleanupNativeCargoTargetAfterTask("native.build", { root: fixture.root }),
    /parent is not a real directory/u,
  );
  assert.equal(await readFile(marker, "utf8"), "keep");
  const linkedRoot = `${fixture.root}-link`;
  await symlink(fixture.root, linkedRoot);
  t.after(() => rm(linkedRoot));
  await assert.rejects(
    cleanupNativeCargoTargetAfterTask("native.build", { root: linkedRoot }),
    /root must not be a symlink/u,
  );
});

test("native Cargo cleanup fails closed on missing binary and unfinished process cleanup", async (t) => {
  const fixture = await nativeCleanupFixture(t);
  await rm(fixture.binary);
  await assert.rejects(
    cleanupNativeCargoTargetAfterTask("native.build", { root: fixture.root }),
    /requires the copied N-API binary/u,
  );
  await access(fixture.release);
  await writeFile(fixture.binary, "native");
  const result = await runLocalCiPlan(nativeCleanupPlan(), {
    candidate: completeCandidate(),
    concurrent: true,
    resolveNativeTargetDirectory: async () =>
      path.join(fixture.native, "target"),
    root: fixture.root,
    runId: LOCAL_CI_TEST_RUN_ID,
    async executeCommand() {
      return {
        cleanup: { complete: true, groupAlive: true },
        exitCode: 0,
        signal: null,
      };
    },
  });
  assert.equal(result.status, "failed");
  assert.match(result.tasks[0].error, /requires process-group exit/u);
  assert.equal(result.tasks[1].status, "not-run");
  await access(fixture.release);
  await access(fixture.debug);
});

test("failed native and C2-ZC commands never trigger build-target cleanup", async (t) => {
  const fixture = await nativeCleanupFixture(t);
  const failedBuild = await runLocalCiPlan(nativeCleanupPlan(), {
    candidate: completeCandidate(),
    concurrent: true,
    resolveNativeTargetDirectory: async () =>
      path.join(fixture.native, "target"),
    root: fixture.root,
    runId: LOCAL_CI_TEST_RUN_ID,
    async executeCommand() {
      return {
        cleanup: { complete: true, groupAlive: false },
        exitCode: 1,
        signal: null,
      };
    },
  });
  assert.equal(failedBuild.tasks[0].status, "failed");
  await access(fixture.release);
  await access(fixture.debug);

  const failedGate = await runLocalCiPlan(nativeCleanupPlan(), {
    candidate: completeCandidate(),
    concurrent: true,
    resolveNativeTargetDirectory: async () =>
      path.join(fixture.native, "target"),
    root: fixture.root,
    runId: LOCAL_CI_TEST_RUN_ID,
    async executeCommand(_command, { taskId }) {
      return {
        cleanup: { complete: true, groupAlive: false },
        exitCode: taskId === "c2zc.rust-acceptance" ? 1 : 0,
        signal: null,
      };
    },
  });
  assert.equal(failedGate.tasks[2].status, "failed");
  assert.equal(failedGate.tasks[3].status, "not-run");
  await assert.rejects(access(fixture.release), { code: "ENOENT" });
  await access(fixture.debug);
  assert.equal(await readFile(fixture.binary, "utf8"), fixture.binary);
});

test("redirected Cargo targets leave the default native build tree intact", async (t) => {
  const fixture = await nativeCleanupFixture(t);
  const redirected = path.join(fixture.root, "redirected-cargo-target");
  await mkdir(redirected);
  const events = [];
  const result = await runLocalCiPlan(nativeCleanupPlan(), {
    candidate: completeCandidate(),
    concurrent: true,
    resolveNativeTargetDirectory: async () => redirected,
    root: fixture.root,
    runId: LOCAL_CI_TEST_RUN_ID,
    notify(event) {
      events.push(event);
    },
    async executeCommand() {
      return {
        cleanup: { complete: true, groupAlive: false },
        exitCode: 0,
        signal: null,
      };
    },
  });
  assert.equal(result.status, "passed");
  assert.equal(
    events.filter((event) => event.type === "build-cache-cleanup-skipped")
      .length,
    2,
  );
  await access(fixture.release);
  await access(fixture.debug);
  assert.equal(await readFile(fixture.binary, "utf8"), fixture.binary);
});

test("native target metadata uses each Cargo consumer's working directory", async (t) => {
  const fixture = await nativeCleanupFixture(t);
  const redirected = path.join(fixture.root, "redirected-cargo-target");
  const nativeCwd = fixture.native;
  const seen = [];
  const runMetadata = async (command, args, options) => {
    seen.push({ command, args, cwd: options.cwd });
    return {
      stdout: JSON.stringify({
        target_directory:
          options.cwd === nativeCwd
            ? redirected
            : path.join(fixture.native, "target"),
      }),
    };
  };
  assert.equal(
    await resolveNativeCargoTargetDirectory(
      fixture.root,
      { env: {} },
      null,
      "native.build",
      runMetadata,
    ),
    redirected,
  );
  assert.equal(
    await resolveNativeCargoTargetDirectory(
      fixture.root,
      { env: {} },
      null,
      "c2zc.rust-acceptance",
      runMetadata,
    ),
    path.join(fixture.native, "target"),
  );
  assert.deepEqual(
    seen.map(({ cwd }) => cwd),
    [fixture.native, fixture.root],
  );
  assert.ok(
    seen.every(
      ({ command, args }) =>
        command === "cargo" &&
        args.includes("--locked") &&
        args.includes("--offline"),
    ),
  );
});

test("AI workflow authorities require local Quick and complete Full evidence", async () => {
  const [
    agents,
    impactGate,
    shipBranch,
    bumpVersion,
    implementFeature,
    debugIssue,
    policy,
    packageSource,
  ] = await Promise.all([
    read("AGENTS.md"),
    read(".agents/skills/grimodex-impact-gate/SKILL.md"),
    read(".agents/skills/ship-branch/SKILL.md"),
    read(".agents/skills/bump-version/SKILL.md"),
    read(".agents/skills/implement-feature/SKILL.md"),
    read(".agents/skills/debug-issue/SKILL.md"),
    read("policies/quality/iron-laws.md"),
    read("package.json"),
  ]);

  const packageJson = JSON.parse(packageSource);
  for (const [script, argument] of [
    ["ci:local:quick", "quick"],
    ["ci:local:full", "full"],
    ["ci:local:list", "--list"],
    ["ci:local:verify", "--verify"],
  ]) {
    assert.equal(packageJson.scripts[script], `node scripts/local-ci.mjs ${argument}`);
  }
  for (const [sourcePath, source] of [
    ["AGENTS.md", agents],
    [".agents/skills/implement-feature/SKILL.md", implementFeature],
    [".agents/skills/debug-issue/SKILL.md", debugIssue],
  ]) {
    for (const anchor of ["agent-validation", "GDX-TRACE-001"]) {
      const destinations = [...source.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)]
        .map((match) => match[1].split("#"));
      assert.ok(destinations.some(([target, fragment]) => (
        path.resolve(repoRoot, path.dirname(sourcePath), target) ===
          path.join(repoRoot, "policies/quality/iron-laws.md") &&
        fragment === anchor
      )), `${sourcePath} must route CI scope to the canonical ${anchor} section`);
      assert.ok(policy.includes(`<a id="${anchor}"></a>`));
    }
  }
  assert.match(impactGate, /pnpm ci:local:quick/);
  assert.match(impactGate, /pnpm ci:local:verify -- quick/);
  assert.match(shipBranch, /pnpm ci:local:full/);
  assert.match(shipBranch, /pnpm ci:local:verify/);
  assert.match(shipBranch, /--from/);
  assert.match(bumpVersion, /pnpm ci:local:full/);
  assert.match(bumpVersion, /release commit/);
  assert.match(policy, /clean candidate run local Quick.*immediately verified/s);
  assert.match(policy, /Partial `--from` runs.*never\s+converted into merge or release passes/s);
});
