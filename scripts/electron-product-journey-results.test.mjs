import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
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

import {
  PRODUCT_JOURNEYS,
  assertLifecycleTransitionOrder,
  resolveMcpArtifact,
  resolveMcpArtifactPath,
  resolveProductJourneyArtifact,
  resolveSelectedProductJourneys,
  runProductJourneys,
} from "../electron/scripts/product-journeys.mjs";

function deterministicClock(values) {
  let index = 0;
  return () => {
    assert.ok(index < values.length, "clock was read more often than expected");
    return values[index++];
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

test("runner MCP artifact resolution honors override, CARGO_TARGET_DIR, and default with identity evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-product-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const targetDir = path.join(root, "cargo-target");
  const targetBinary = path.join(targetDir, "debug", "grimodex-mcp");
  const defaultBinary = path.join(
    root,
    "src-tauri",
    "target",
    "debug",
    "grimodex-mcp",
  );
  const canonicalBinary = path.join(root, "canonical-mcp");
  const override = path.join(root, "override-mcp");
  await writeFile(canonicalBinary, "runner mcp artifact");
  await chmod(canonicalBinary, 0o755);
  await symlink(canonicalBinary, override);
  await mkdir(path.dirname(targetBinary), { recursive: true });
  await mkdir(path.dirname(defaultBinary), { recursive: true });
  await writeFile(targetBinary, "cargo mcp artifact");
  await writeFile(defaultBinary, "default mcp artifact");
  await chmod(targetBinary, 0o755);
  await chmod(defaultBinary, 0o755);

  assert.equal(
    resolveMcpArtifactPath({
      root,
      overridePath: override,
      cargoTargetDir: targetDir,
      platform: "linux",
    }),
    override,
  );
  assert.equal(
    resolveMcpArtifactPath({
      root,
      overridePath: "",
      cargoTargetDir: "cargo-target",
      platform: "linux",
    }),
    targetBinary,
  );
  assert.equal(
    resolveMcpArtifactPath({
      root,
      overridePath: "",
      cargoTargetDir: "",
      platform: "linux",
    }),
    path.join(root, "src-tauri", "target", "debug", "grimodex-mcp"),
  );
  assert.equal(
    resolveMcpArtifactPath({
      root: "C:\\grimodex",
      overridePath: "",
      cargoTargetDir: "target",
      platform: "win32",
    }),
    "C:\\grimodex\\target\\debug\\grimodex-mcp.exe",
  );
  assert.throws(
    () =>
      resolveMcpArtifactPath({
        root,
        overridePath: "relative-mcp",
        cargoTargetDir: "",
        platform: "linux",
      }),
    /absolute path/,
  );

  const cargoIdentity = await resolveMcpArtifact({
    root,
    overridePath: "",
    cargoTargetDir: targetDir,
    platform: "linux",
  });
  assert.equal(cargoIdentity.path, targetBinary);
  assert.equal(cargoIdentity.requestedPath, targetBinary);
  assert.equal(cargoIdentity.realPath, await realpath(targetBinary));
  assert.equal(
    cargoIdentity.sha256,
    `sha256:${createHash("sha256").update("cargo mcp artifact").digest("hex")}`,
  );

  const defaultIdentity = await resolveMcpArtifact({
    root,
    overridePath: "",
    cargoTargetDir: "",
    platform: "linux",
  });
  assert.equal(defaultIdentity.path, defaultBinary);
  assert.equal(defaultIdentity.requestedPath, defaultBinary);
  assert.equal(defaultIdentity.realPath, await realpath(defaultBinary));
  assert.equal(
    defaultIdentity.sha256,
    `sha256:${createHash("sha256")
      .update("default mcp artifact")
      .digest("hex")}`,
  );

  const identity = await resolveProductJourneyArtifact(override, {
    executable: true,
  });
  assert.equal(identity.path, override);
  assert.equal(identity.requestedPath, override);
  assert.equal(identity.realPath, await realpath(canonicalBinary));
  assert.equal(
    identity.sha256,
    `sha256:${createHash("sha256").update("runner mcp artifact").digest("hex")}`,
  );
});

test("product runner records deterministic results while preserving serial fresh harnesses", async (t) => {
  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-results-"),
  );
  const resultsPath = path.join(outputRoot, "results.json");
  const events = [];
  let harnessIndex = 0;
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  await runProductJourneys({
    catalog: [{ id: "first" }, { id: "second" }],
    journeys: [
      {
        id: "first",
        run: async (harness) => {
          events.push(`run:first:${harness.index}`);
        },
      },
      {
        id: "second",
        run: async (harness) => {
          events.push(`run:second:${harness.index}`);
        },
      },
    ],
    assertArtifacts: () => events.push("assert-artifacts"),
    createHarness: () => {
      const index = ++harnessIndex;
      events.push(`create:${index}`);
      return {
        index,
        finalizeDiagnostics: async () => ({
          rendererErrorCount: 0,
          pageErrors: [],
          mainErrorCount: index === 1 ? 1 : 0,
          unallowedMainErrors: [],
          mainCleanPass: true,
          cleanPass: true,
        }),
        dispose: async ({ success, name }) => {
          events.push(`dispose:${index}:${success}:${name}`);
        },
      };
    },
    clock: deterministicClock([100, 125, 200, 260]),
    resultsPath,
  });

  assert.deepEqual(events, [
    "assert-artifacts",
    "create:1",
    "run:first:1",
    "dispose:1:true:first",
    "create:2",
    "run:second:2",
    "dispose:2:true:second",
  ]);
  const report = await readJson(resultsPath);
  assert.equal(report.version, 4);
  assert.equal(report.status, "passed");
  assert.deepEqual(report.journeyIds, ["first", "second"]);
  assert.equal(report.allPassed, true);
  assert.equal(report.allClean, true);
  assert.deepEqual(report.journeys, [
    {
      id: "first",
      status: "passed",
      durationMs: 25,
      rendererErrorCount: 0,
      pageErrors: [],
      mainErrorCount: 1,
      unallowedMainErrors: [],
      mainCleanPass: true,
      cleanPass: true,
    },
    {
      id: "second",
      status: "passed",
      durationMs: 60,
      rendererErrorCount: 0,
      pageErrors: [],
      mainErrorCount: 0,
      unallowedMainErrors: [],
      mainCleanPass: true,
      cleanPass: true,
    },
  ]);
  const manifest = await readJson(path.join(outputRoot, "manifest.json"));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.status, "passed");
  assert.deepEqual(manifest.journeyIds, ["first", "second"]);
  assert.equal(manifest.allPassed, true);
  assert.equal(manifest.allClean, true);
  assert.equal(manifest.results.path, "results.json");
  assert.match(manifest.results.sha256, /^sha256:[0-9a-f]{64}$/);
});

test("product runner persists a journey evidence result and binds results path/hash in manifest", async (t) => {
  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-evidence-results-"),
  );
  const resultsPath = path.join(outputRoot, "results.json");
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  const evidence = {
    receiptVersion: 2,
    probeCount: 36,
    probes: Array.from({ length: 36 }, (_, index) => ({ index: index + 1 })),
    terminalLedger: { ready: true, obligations: [] },
  };
  const quiescenceArtifacts = {
    before: {
      receipt: {
        type: "grimodex:narrative-maintenance-ci-quiescence",
        sequence: 1,
      },
      path: "/tmp/receipt/quiescence-0000000001.json",
      realPath: "/tmp/receipt/quiescence-0000000001.json",
      sha256: `sha256:${"a".repeat(64)}`,
      byteLength: 321,
    },
    after: {
      receipt: {
        type: "grimodex:narrative-maintenance-ci-quiescence",
        sequence: 2,
      },
      path: "/tmp/receipt/quiescence-0000000002.json",
      realPath: "/tmp/receipt/quiescence-0000000002.json",
      sha256: `sha256:${"b".repeat(64)}`,
      byteLength: 654,
    },
  };
  await runProductJourneys({
    catalog: [{ id: "dml-evidence" }],
    journeys: [
      {
        id: "dml-evidence",
        run: async () => ({
          settledEvidence: evidence,
          quiescenceArtifacts,
        }),
      },
    ],
    assertArtifacts: () => undefined,
    createHarness: () => ({
      finalizeDiagnostics: async () => ({ cleanPass: true }),
      dispose: async () => undefined,
    }),
    clock: deterministicClock([100, 125]),
    resultsPath,
  });

  const report = await readJson(resultsPath);
  assert.deepEqual(report.journeys[0].result, {
    settledEvidence: evidence,
    quiescenceArtifacts,
  });
  assert.deepEqual(
    report.journeys[0].result.quiescenceArtifacts,
    quiescenceArtifacts,
    "the result must persist core quiescence receipt identity before artifact disposal",
  );
  const manifest = await readJson(path.join(outputRoot, "manifest.json"));
  assert.equal(manifest.results.realPath, await realpath(resultsPath));
  assert.equal(
    manifest.results.sha256,
    `sha256:${createHash("sha256")
      .update(await readFile(resultsPath))
      .digest("hex")}`,
  );
});

test("product runner writes the failed and fail-fast results before rethrowing", async (t) => {
  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-results-"),
  );
  const resultsPath = path.join(outputRoot, "results.json");
  const events = [];
  let failureDiagnostics = {
    rendererErrorCount: 0,
    pageErrors: [],
    cleanPass: true,
  };
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  await assert.rejects(
    runProductJourneys({
      catalog: [{ id: "broken" }, { id: "never" }],
      journeys: [
        {
          id: "broken",
          run: async () => {
            events.push("run:broken");
            throw new TypeError("boom");
          },
        },
        {
          id: "never",
          run: async () => {
            events.push("run:never");
          },
        },
      ],
      assertArtifacts: () => undefined,
      createHarness: () => {
        events.push("create");
        return {
          diagnostics: () => failureDiagnostics,
          dispose: async ({ success, name }) => {
            events.push(`dispose:${success}:${name}`);
            failureDiagnostics = {
              rendererErrorCount: 1,
              pageErrors: [
                {
                  phase: `failure:${name}`,
                  message: "late shutdown error",
                },
              ],
              cleanPass: false,
            };
          },
        };
      },
      clock: deterministicClock([10, 22]),
      resultsPath,
    }),
    /broken: TypeError: boom/,
  );

  assert.deepEqual(events, ["create", "run:broken", "dispose:false:broken"]);
  const report = await readJson(resultsPath);
  assert.equal(report.version, 4);
  assert.equal(report.status, "failed");
  assert.ok(
    report.journeys.every(
      (journey) => journey.cleanPass !== true || journey.status === "passed",
    ),
    "only passed journeys may report cleanPass=true",
  );
  assert.deepEqual(report.journeys, [
    {
      id: "broken",
      status: "failed",
      durationMs: 12,
      error: { name: "TypeError", message: "boom" },
      rendererErrorCount: 1,
      pageErrors: [
        {
          phase: "failure:broken",
          message: "late shutdown error",
        },
      ],
      mainErrorCount: 0,
      unallowedMainErrors: [],
      mainCleanPass: true,
      cleanPass: false,
    },
    {
      id: "never",
      status: "not-run",
      durationMs: 0,
      reason: "Fail-fast after broken.",
    },
  ]);
});

test("product runner still writes a versioned report when artifact preflight fails", async (t) => {
  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-results-"),
  );
  const resultsPath = path.join(outputRoot, "results.json");
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  await assert.rejects(
    runProductJourneys({
      catalog: [{ id: "never" }],
      journeys: [{ id: "never", run: async () => undefined }],
      assertArtifacts: () => {
        throw new Error("missing build");
      },
      createHarness: () => {
        throw new Error("harness must not be created");
      },
      clock: deterministicClock([]),
      resultsPath,
    }),
    /missing build/,
  );

  const report = await readJson(resultsPath);
  assert.equal(report.version, 4);
  assert.equal(report.status, "failed");
  assert.deepEqual(report.error, {
    name: "Error",
    message: "missing build",
  });
  assert.deepEqual(report.journeys, [
    {
      id: "never",
      status: "not-run",
      durationMs: 0,
      reason: "Artifact preflight failed.",
    },
  ]);
});

test("product runner fails closed when renderer diagnostics are not clean", async (t) => {
  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-results-"),
  );
  const resultsPath = path.join(outputRoot, "results.json");
  const events = [];
  const diagnostics = {
    rendererErrorCount: 1,
    pageErrors: [
      {
        phase: "close",
        message: "unhandled renderer rejection",
      },
    ],
    mainErrorCount: 0,
    unallowedMainErrors: [],
    mainCleanPass: true,
    cleanPass: false,
  };
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  await assert.rejects(
    runProductJourneys({
      catalog: [{ id: "renderer-broken" }],
      journeys: [{ id: "renderer-broken", run: async () => undefined }],
      assertArtifacts: () => undefined,
      createHarness: () => ({
        finalizeDiagnostics: async () => {
          events.push("finalize");
          const error = new Error("renderer diagnostics failed");
          error.diagnostics = diagnostics;
          throw error;
        },
        diagnostics: () => diagnostics,
        dispose: async ({ success, name }) => {
          events.push(`dispose:${success}:${name}`);
        },
      }),
      clock: deterministicClock([10, 22]),
      resultsPath,
    }),
    /renderer-broken: Error: renderer diagnostics failed/,
  );

  assert.deepEqual(events, ["finalize", "dispose:false:renderer-broken"]);
  const report = await readJson(resultsPath);
  assert.equal(report.version, 4);
  assert.equal(report.status, "failed");
  assert.deepEqual(report.journeys, [
    {
      id: "renderer-broken",
      status: "failed",
      durationMs: 12,
      error: {
        name: "Error",
        message: "renderer diagnostics failed",
      },
      ...diagnostics,
    },
  ]);
});

test("lifecycle journey assertion requires one transition id with the exact six-phase order", async () => {
  const phases = [
    "switch-requested",
    "quiescence-started",
    "old-stream-completed",
    "old-scope-persisted",
    "authority-commit",
    "new-scope-hydrated",
  ];
  const events = phases.map((phase, sequence) => ({
    schemaVersion: 1,
    transitionId: "project:one",
    sequence,
    timestampMs: 100 + sequence,
    kind: "project",
    phase,
    from: {
      workspacePath: "/novel",
      workspaceOpenRevision: 1,
      projectId: "project-a",
    },
    to: {
      workspacePath: "/novel",
      workspaceOpenRevision: 1,
      projectId: "project-b",
    },
  }));
  const recorded = [];
  const harness = {
    readLifecycleTrace: async () => events,
    recordTimeline: (event, details) => recorded.push({ event, details }),
  };

  const matched = await assertLifecycleTransitionOrder(
    harness,
    {},
    {
      kind: "project",
      from: { projectId: "project-a" },
      to: { projectId: "project-b" },
      label: "project switch",
    },
  );
  assert.deepEqual(matched, events);
  assert.equal(recorded[0].event, "application-lifecycle-order-verified");
  assert.deepEqual(recorded[0].details.lifecyclePhases, phases);

  const outOfOrderHarness = {
    ...harness,
    readLifecycleTrace: async () =>
      events.map((event, index) =>
        index === 1
          ? { ...event, phase: "old-stream-completed" }
          : index === 2
            ? { ...event, phase: "quiescence-started" }
            : event,
      ),
  };
  await assert.rejects(
    assertLifecycleTransitionOrder(
      outOfOrderHarness,
      {},
      {
        kind: "project",
        from: { projectId: "project-a" },
        to: { projectId: "project-b" },
        label: "project switch",
      },
    ),
    /did not emit the required lifecycle order/,
  );
});

test("affected execution resolves a strict catalog-ordered runner subset", () => {
  const selected = resolveSelectedProductJourneys(
    PRODUCT_JOURNEYS,
    JSON.stringify([
      "map-native-roundtrip",
      "editor-persistence",
      "mcp-external-write-conflict",
    ]),
  );

  assert.deepEqual(
    selected.map((journey) => journey.id),
    [
      "editor-persistence",
      "mcp-external-write-conflict",
      "map-native-roundtrip",
    ],
  );
});

test("runner selection rejects malformed, duplicate, empty, and unknown IDs", () => {
  assert.throws(
    () => resolveSelectedProductJourneys(PRODUCT_JOURNEYS, "not-json"),
    /valid JSON array/i,
  );
  assert.throws(
    () =>
      resolveSelectedProductJourneys(
        PRODUCT_JOURNEYS,
        JSON.stringify(["editor-persistence", "editor-persistence"]),
      ),
    /duplicate.*editor-persistence/i,
  );
  assert.throws(
    () => resolveSelectedProductJourneys(PRODUCT_JOURNEYS, "[]"),
    /at least one journey ID/i,
  );
  assert.throws(
    () =>
      resolveSelectedProductJourneys(
        PRODUCT_JOURNEYS,
        JSON.stringify(["deleted-journey"]),
      ),
    /unknown.*deleted-journey/i,
  );
  assert.equal(
    resolveSelectedProductJourneys(PRODUCT_JOURNEYS, undefined),
    PRODUCT_JOURNEYS,
  );
});

test("Full product journey execution rejects a subset even when IDs are supplied", async (t) => {
  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-results-full-"),
  );
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  await assert.rejects(
    runProductJourneys({
      catalog: [
        { id: "first", capabilities: [] },
        { id: "second", capabilities: [] },
      ],
      journeys: [{ id: "first", run: async () => undefined }],
      requireAll: true,
      assertArtifacts: () => undefined,
      createHarness: () => ({
        dispose: async () => undefined,
      }),
      resultsPath: path.join(outputRoot, "results.json"),
    }),
    /all canonical product journey IDs/i,
  );
});
