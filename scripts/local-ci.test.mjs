import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  access,
  chmod,
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
  expectedC2ZcAcceptanceForPlan,
  parseLocalCiArgs,
  prepareLocalCiArtifacts,
  readC2ZcRestoreFixtureEvidence,
  resolveLocalCiCandidate,
  runLocalCiPlan,
  validateLocalCiCandidate,
  validateLocalCiRegistry,
  verifyLocalCiReceipt,
} from "./local-ci.mjs";
import {
  C2ZC_RUST_ACCEPTANCE_CATALOG_DIGEST,
  C2ZC_RUST_ACCEPTANCE_GATES,
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
  const fixturePath =
    ".artifacts/local-ci/c2-zc-restore-fixture/c2zc-restore-fixture.backup.db";
  const databasePath =
    ".artifacts/local-ci/c2-zc-restore-fixture/c2zc-restore-fixture.db";
  const manifestPath =
    ".artifacts/local-ci/c2-zc-restore-fixture/c2zc-restore-fixture.manifest.json";
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
  verifyContractVersion: "9",
  checkCoverage: {
    complete: true,
    required: Array.from({ length: 13 }, (_, index) => `rust-check-${index}`),
    covered: Array.from({ length: 13 }, (_, index) => `rust-check-${index}`),
    missing: [],
  },
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
      "rust",
      "c2-zc-rust-acceptance-gate",
      "c2-zc-restore-fixture-builder",
      "migration-recovery-gate",
      "electron-runtime-performance",
      "electron-product-journeys",
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

test("local Full orders the candidate-bound Rust gate before Electron journeys and binds its receipt hash", async (t) => {
  const registry = await readRegistry();
  const full = buildLocalCiPlan(registry, {
    profile: "full",
    base: "origin/master",
    head: "HEAD",
  });
  const rustIndex = full.stages.findIndex(
    (stage) => stage.id === "c2-zc-rust-acceptance-gate",
  );
  const sharedRustIndex = full.stages.findIndex((stage) => stage.id === "rust");
  const productIndex = full.stages.findIndex(
    (stage) => stage.id === "electron-product-journeys",
  );
  assert.ok(rustIndex >= 0);
  assert.ok(sharedRustIndex >= 0 && sharedRustIndex < rustIndex);
  const fixtureIndex = full.stages.findIndex(
    (stage) => stage.id === "c2-zc-restore-fixture-builder",
  );
  assert.ok(fixtureIndex >= 0);
  assert.ok(rustIndex < fixtureIndex && fixtureIndex < productIndex);

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
    stages: [full.stages[rustIndex], full.stages[productIndex]],
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
  assert.equal(executed.length, 3);
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
  const productCommand = executed.find(
    (command) => command.label === "Run every product journey",
  );
  assert.equal(
    productCommand.env.GRIMODEX_C2ZC_RUST_RECEIPT_SHA256,
    receipt.receiptSha256,
  );
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
    writeFile(nativePath, "native"),
    writeFile(mainPath, "main"),
    writeFile(rendererPath, "renderer"),
  ]);

  const registry = await readRegistry();
  registry.stages["electron-product-journeys"] = {
    label: "C2-ZC product journeys",
    env: {
      GRIMODEX_PRODUCT_JOURNEY_SET: "c2-zc",
      GRIMODEX_PRODUCT_JOURNEY_IDS: "",
      GRIMODEX_NODE_PATH: nativePath,
    },
    commands: [
      {
        label: "Build MCP journey dependency",
        command: "pnpm",
        args: ["mcp:build"],
      },
      {
        label: "Run every product journey",
        command: "pnpm",
        args: ["electron:product-journeys"],
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
  assert.equal(
    fixtureInput.path,
    path.join(
      temporaryRoot,
      ".artifacts/local-ci/c2-zc-restore-fixture/c2zc-restore-fixture.backup.db",
    ),
  );
  assert.equal(
    fixtureInput.manifest,
    path.join(
      temporaryRoot,
      ".artifacts/local-ci/c2-zc-restore-fixture/c2zc-restore-fixture.manifest.json",
    ),
  );
  assert.ok(result.c2zcRestoreFixture);
  assert.equal(
    result.c2zcRestoreFixture.path,
    ".artifacts/local-ci/c2-zc-restore-fixture/c2zc-restore-fixture.backup.db",
  );
  assert.equal(
    result.c2zcRestoreFixture.manifestPath,
    ".artifacts/local-ci/c2-zc-restore-fixture/c2zc-restore-fixture.manifest.json",
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
    writeFile(nativePath, "native"),
    writeFile(mainPath, "main"),
    writeFile(rendererPath, "renderer"),
  ]);
  const registry = await readRegistry();
  registry.stages["electron-product-journeys"] = {
    label: "C2-ZC product journeys",
    env: {
      GRIMODEX_PRODUCT_JOURNEY_SET: "c2-zc",
      GRIMODEX_PRODUCT_JOURNEY_IDS: "",
      GRIMODEX_NODE_PATH: nativePath,
    },
    commands: [
      { label: "build", command: "build", args: [], cwd: "." },
      { label: "journeys", command: "journeys", args: [], cwd: "." },
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
  assert.equal(
    fixtureInput.path,
    path.join(
      temporaryRoot,
      ".artifacts/local-ci/c2-zc-restore-fixture/c2zc-restore-fixture.backup.db",
    ),
  );
  assert.equal(
    fixtureInput.manifest,
    path.join(
      temporaryRoot,
      ".artifacts/local-ci/c2-zc-restore-fixture/c2zc-restore-fixture.manifest.json",
    ),
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
  registry.stages["electron-product-journeys"] = {
    label: "C2-ZC product journeys",
    env: {
      GRIMODEX_PRODUCT_JOURNEY_SET: "c2-zc",
      GRIMODEX_PRODUCT_JOURNEY_IDS: "",
      GRIMODEX_NODE_PATH: nativePath,
    },
    commands: [
      { label: "build", command: "build", args: [], cwd: "." },
      { label: "journeys", command: "journeys", args: [], cwd: "." },
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
    writeFile(mainPath, "main"),
    writeFile(rendererPath, "renderer"),
    writeFile(nativePath, "native"),
  ]);
  const registry = await readRegistry();
  registry.stages["electron-product-journeys"] = {
    label: "C2-ZC product journeys",
    env: {
      GRIMODEX_PRODUCT_JOURNEY_SET: "c2-zc",
      GRIMODEX_PRODUCT_JOURNEY_IDS: "",
      GRIMODEX_NODE_PATH: nativePath,
    },
    commands: [
      { label: "build", command: "build", args: [], cwd: "." },
      { label: "journeys", command: "journeys", args: [], cwd: "." },
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
  customReceipt.stages.at(
    -1,
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
                ".artifacts/product-journeys",
              GRIMODEX_NODE_PATH: nativePath,
              GRIMODEX_MCP_PATH: mcpRequestedPath,
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
  await assert.rejects(
    collectProductJourneyEvidence(plan, { root: temporaryRoot }),
    /exactly .*build artifacts|missing/i,
  );
  await writeFile(manifestPath, manifestText, "utf8");

  const reorderedManifest = JSON.parse(manifestText);
  reorderedManifest.artifacts.reverse();
  await writeFile(
    manifestPath,
    `${JSON.stringify(reorderedManifest, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    collectProductJourneyEvidence(plan, { root: temporaryRoot }),
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
    collectProductJourneyEvidence(plan, { root: temporaryRoot }),
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
    collectProductJourneyEvidence(plan, { root: temporaryRoot }),
    /changed after preflight|artifact.*mismatch/i,
  );
  await writeFile(manifestPath, manifestText, "utf8");

  await writeFile(mainPath, "electron main tampered", "utf8");
  await assert.rejects(
    collectProductJourneyEvidence(plan, { root: temporaryRoot }),
    /changed after preflight|artifact.*mismatch/i,
  );
  await writeFile(mainPath, "electron main", "utf8");

  await rm(mcpRequestedPath);
  await symlink(path.basename(mcpTargetB), mcpRequestedPath);
  await assert.rejects(
    collectProductJourneyEvidence(plan, { root: temporaryRoot }),
    /changed after preflight|artifact.*mismatch/i,
  );
  await rm(mcpRequestedPath);
  await symlink(path.basename(mcpTargetA), mcpRequestedPath);

  await rm(nativePath);
  await assert.rejects(
    collectProductJourneyEvidence(plan, { root: temporaryRoot }),
    /ENOENT|regular file|artifact/i,
  );

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
  const acceptedEvidence = await collectProductJourneyEvidence(plan, {
    candidate,
    root: temporaryRoot,
  });
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
    collectProductJourneyEvidence(plan, { candidate, root: temporaryRoot }),
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
