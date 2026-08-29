import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  parseLocalCiArgs,
  prepareLocalCiArtifacts,
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

function exactRustGateOutput(gateId) {
  const fullTestName =
    gateId === "c2-zc-dml-native-owned-table-denial"
      ? "execute::tests::c2zc_native_owned_tables_reject_all_untrusted_dml_but_allow_reads_and_trusted_writes"
      : gateId === "c2-zc-readiness-corruption-fail-closed"
        ? "narrative_extraction::c2z_preparation::tests::rebuild_outcome_tamper_and_missing_evidence_fail_closed"
        : "canonical_read_has_no_legacy_fallback_after_generic_cutover";
  return `test ${fullTestName} ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n`;
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
  assert.ok(rustIndex < productIndex);

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
  assert.equal(C2ZC_RUST_ACCEPTANCE_GATES.length, 3);
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

test("Full receipts fail closed when a C2-ZC-complete result omits its Rust receipt binding", () => {
  const candidate = completeCandidate();
  const receipt = {
    version: 3,
    profile: "full",
    coverage: { completeness: "complete", fromStage: null },
    candidate,
    status: "passed",
    productJourneyEvidence: completeProductJourneyEvidence({
      acceptanceRequired: true,
      acceptanceComplete: true,
      c2zcRustAcceptance: null,
    }),
  };

  assert.throws(
    () => verifyLocalCiReceipt(receipt, { profile: "full", candidate }),
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
    version: 4,
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
  const acceptedLocalReceipt = {
    version: 3,
    profile: "full",
    coverage: { completeness: "complete", fromStage: null },
    candidate,
    status: "passed",
    productJourneyEvidence: acceptedEvidence,
  };
  assert.doesNotThrow(() =>
    verifyLocalCiReceipt(acceptedLocalReceipt, {
      profile: "full",
      candidate,
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
          { profile: "full", candidate },
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
