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
  assertBuildArtifacts,
  assertLifecycleTransitionOrder,
  resolveMcpArtifact,
  resolveMcpArtifactPath,
  resolveProductJourneyArtifact,
  resolveSelectedProductJourneys,
  runProductJourneys,
} from "../electron/scripts/product-journeys.mjs";
import { NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG } from "../electron/scripts/product-journey-catalog.mjs";

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

test("focused C2-ZC executes every independent lane once after an earlier lane fails", async (t) => {
  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-c2zc-lanes-"),
  );
  const resultsPath = path.join(outputRoot, "results.json");
  const events = [];
  const laneIds = NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG.map(
    (journey) => journey.id,
  );
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const mainPath = path.join(outputRoot, "dist-electron", "main.cjs");
  const rendererPath = path.join(outputRoot, "dist", "index.html");
  const nativePath = path.join(outputRoot, "custom", "grimodex-node.node");
  await mkdir(path.dirname(mainPath), { recursive: true });
  await mkdir(path.dirname(rendererPath), { recursive: true });
  await mkdir(path.dirname(nativePath), { recursive: true });
  await writeFile(mainPath, "main");
  await writeFile(rendererPath, "renderer");
  await writeFile(nativePath, "native");
  const environment = { GRIMODEX_NODE_PATH: nativePath };
  const artifacts = (
    await assertBuildArtifacts(
      laneIds.map((id) => ({ id })),
      {
        catalog: NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
        root: outputRoot,
        env: environment,
      },
    )
  ).artifacts;
  const candidate = {
    requestedBase: "origin/master",
    requestedHead: "HEAD",
    resolvedBaseSha: "a".repeat(40),
    resolvedHeadSha: "b".repeat(40),
    resolvedHeadTreeSha: "c".repeat(40),
    currentHeadSha: "b".repeat(40),
    worktreeClean: true,
    worktreeFingerprint: "d".repeat(64),
    worktreeStatusHash: "e".repeat(64),
  };

  await assert.rejects(
    runProductJourneys({
      catalog: NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
      journeys: laneIds.map((id, index) => ({
        id,
        run: async () => {
          events.push(`run:${id}`);
          if (index === laneIds.length - 1)
            throw new Error("deliberate DML failure");
        },
      })),
      selectionName: "c2-zc",
      assertArtifacts: () => ({ artifacts }),
      root: outputRoot,
      environment,
      buildReceipt: {
        version: 1,
        verified: true,
        source: "local-ci-candidate",
        candidate,
        artifacts,
      },
      rustAcceptanceEvidence: {
        required: true,
        verified: true,
        candidate,
        receipt: { candidate },
      },
      createHarness: () => ({
        dispose: async ({ success, name }) => {
          events.push(`dispose:${name}:${success}`);
        },
      }),
      clock: (() => {
        let value = 0;
        return () => (value += 10);
      })(),
      resultsPath,
    }),
    /deliberate DML failure/,
  );

  assert.deepEqual(events, [
    `run:${laneIds[0]}`,
    `dispose:${laneIds[0]}:true`,
    `run:${laneIds[1]}`,
    `dispose:${laneIds[1]}:true`,
    `run:${laneIds[2]}`,
    `dispose:${laneIds[2]}:false`,
  ]);
  const report = await readJson(resultsPath);
  assert.deepEqual(
    report.journeys.map((journey) => [journey.id, journey.status]),
    laneIds.map((id, index) => [
      id,
      index === laneIds.length - 1 ? "failed" : "passed",
    ]),
  );
  assert.equal(
    report.journeys.some((journey) => journey.status === "not-run"),
    false,
  );
  assert.equal(report.allPassed, false);
  assert.equal(report.acceptanceComplete, false);
  const manifest = await readJson(path.join(outputRoot, "manifest.json"));
  assert.deepEqual(report.buildReceipt.artifacts, artifacts);
  assert.deepEqual(manifest.artifacts, artifacts);
  assert.deepEqual(manifest.artifacts, report.buildReceipt.artifacts);
});

test("C2-ZC build preflight binds the three selected capability artifacts and omits MCP", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-c2zc-artifacts-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const mainPath = path.join(root, "dist-electron", "main.cjs");
  const rendererPath = path.join(root, "dist", "index.html");
  const nativePath = path.join(root, "custom", "grimodex-node.node");
  await mkdir(path.dirname(mainPath), { recursive: true });
  await mkdir(path.dirname(rendererPath), { recursive: true });
  await mkdir(path.dirname(nativePath), { recursive: true });
  await writeFile(mainPath, "main");
  await writeFile(rendererPath, "renderer");
  await writeFile(nativePath, "native");

  const result = await assertBuildArtifacts(
    NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
    {
      catalog: NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
      root,
      env: { GRIMODEX_NODE_PATH: nativePath },
    },
  );
  assert.deepEqual(
    result.artifacts.map((artifact) => artifact.name),
    ["Electron main", "renderer", "N-API native module"],
  );
  assert.ok(
    result.artifacts.every((artifact) => Number.isSafeInteger(artifact.size)),
  );
  assert.equal(
    result.artifacts.find((artifact) => artifact.name === "N-API native module")
      .realPath,
    await realpath(nativePath),
  );
});

test("C2-ZC rejects candidate-correct receipts with stale or mutated artifact identities", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-c2zc-artifact-mutations-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const mainPath = path.join(root, "dist-electron", "main.cjs");
  const rendererPath = path.join(root, "dist", "index.html");
  const nativePath = path.join(root, "custom", "grimodex-node.node");
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
  const environment = { GRIMODEX_NODE_PATH: nativePath };
  const journeys = NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG.map(({ id }) => ({
    id,
    run: async () => undefined,
  }));
  const artifacts = (
    await assertBuildArtifacts(journeys, {
      catalog: NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
      root,
      env: environment,
    })
  ).artifacts;
  const candidate = {
    requestedBase: "origin/master",
    requestedHead: "HEAD",
    resolvedBaseSha: "a".repeat(40),
    resolvedHeadSha: "b".repeat(40),
    resolvedHeadTreeSha: "c".repeat(40),
    currentHeadSha: "b".repeat(40),
    worktreeClean: true,
    worktreeFingerprint: "d".repeat(64),
    worktreeStatusHash: "e".repeat(64),
  };
  const receipt = {
    version: 1,
    verified: true,
    source: "local-ci-candidate",
    candidate,
    artifacts,
  };
  const rustAcceptanceEvidence = {
    required: true,
    verified: true,
    candidate,
    receipt: { candidate },
  };
  const mutations = [
    [
      "stale main hash",
      (entries) => (entries[0].sha256 = `sha256:${"f".repeat(64)}`),
    ],
    [
      "stale renderer hash",
      (entries) => (entries[1].sha256 = `sha256:${"f".repeat(64)}`),
    ],
    [
      "stale native hash",
      (entries) => (entries[2].sha256 = `sha256:${"f".repeat(64)}`),
    ],
    ["extra artifact", (entries) => entries.push(structuredClone(entries[0]))],
    ["missing artifact", (entries) => entries.pop()],
    ["name mutation", (entries) => (entries[0].name = "foreign")],
    ["order mutation", (entries) => entries.reverse()],
    ["path mutation", (entries) => (entries[0].path = rendererPath)],
    ["realPath mutation", (entries) => (entries[0].realPath = rendererPath)],
    ["size mutation", (entries) => (entries[0].size += 1)],
    [
      "hash mutation",
      (entries) => (entries[0].sha256 = `sha256:${"0".repeat(64)}`),
    ],
  ];

  for (const [label, mutate] of mutations) {
    const mutatedReceipt = structuredClone(receipt);
    mutate(mutatedReceipt.artifacts);
    await assert.rejects(
      runProductJourneys({
        catalog: NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
        journeys,
        selectionName: "c2-zc",
        assertArtifacts: () => ({ artifacts }),
        root,
        environment,
        buildReceipt: mutatedReceipt,
        rustAcceptanceEvidence,
        createHarness: () => {
          throw new Error(`${label} must fail before launch`);
        },
        resultsPath: path.join(
          root,
          label.replaceAll(" ", "-"),
          "results.json",
        ),
      }),
      /artifact|mismatch|exactly/i,
      label,
    );
  }
});

test("C2-ZC rehashes configured artifacts after every lane before acceptance", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-c2zc-post-run-artifacts-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const mainPath = path.join(root, "dist-electron", "main.cjs");
  const rendererPath = path.join(root, "dist", "index.html");
  const nativePath = path.join(root, "custom", "grimodex-node.node");
  await Promise.all([
    mkdir(path.dirname(mainPath), { recursive: true }),
    mkdir(path.dirname(rendererPath), { recursive: true }),
    mkdir(path.dirname(nativePath), { recursive: true }),
    writeFile(mainPath, "main"),
    writeFile(rendererPath, "renderer"),
    writeFile(nativePath, "native"),
  ]);
  const journeys = NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG.map(
    ({ id }, index) => ({
      id,
      run: async () => {
        if (index === 0)
          await writeFile(mainPath, "main replaced during lanes");
      },
    }),
  );
  const environment = { GRIMODEX_NODE_PATH: nativePath };
  const artifacts = (
    await assertBuildArtifacts(journeys, {
      catalog: NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
      root,
      env: environment,
    })
  ).artifacts;
  const candidate = {
    requestedBase: "origin/master",
    requestedHead: "HEAD",
    resolvedBaseSha: "a".repeat(40),
    resolvedHeadSha: "b".repeat(40),
    resolvedHeadTreeSha: "c".repeat(40),
    currentHeadSha: "b".repeat(40),
    worktreeClean: true,
    worktreeFingerprint: "d".repeat(64),
    worktreeStatusHash: "e".repeat(64),
  };
  const receipt = {
    version: 1,
    verified: true,
    source: "local-ci-candidate",
    candidate,
    artifacts,
  };

  await assert.rejects(
    runProductJourneys({
      catalog: NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
      journeys,
      selectionName: "c2-zc",
      assertArtifacts: () => ({ artifacts }),
      root,
      environment,
      buildReceipt: receipt,
      rustAcceptanceEvidence: {
        required: true,
        verified: true,
        candidate,
        receipt: { candidate },
      },
      createHarness: () => ({ dispose: async () => {} }),
      resultsPath: path.join(root, "results.json"),
    }),
    /artifact|mismatch/i,
  );
  const report = await readJson(path.join(root, "results.json"));
  assert.equal(report.status, "failed");
  assert.equal(report.acceptanceComplete, false);
  assert.equal(report.allPassed, false);
});

test("artifact requirements follow selected capabilities and resolve MCP only when selected", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-capability-artifacts-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const mainPath = path.join(root, "dist-electron", "main.cjs");
  const rendererPath = path.join(root, "dist", "index.html");
  const nativePath = path.join(root, "custom", "grimodex-node.node");
  const mcpTarget = path.join(root, "custom", "grimodex-mcp-target");
  const mcpPath = path.join(root, "custom", "grimodex-mcp");
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
  const c2zcArtifacts = (
    await assertBuildArtifacts(NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG, {
      catalog: NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
      root,
      env: { GRIMODEX_NODE_PATH: nativePath },
    })
  ).artifacts;
  assert.deepEqual(
    c2zcArtifacts.map((artifact) => artifact.name),
    ["Electron main", "renderer", "N-API native module"],
  );

  const mcpJourney = {
    id: "mcp-capability",
    capabilities: ["electron", "napi", "mcp"],
  };
  const mcpEnvironment = {
    GRIMODEX_NODE_PATH: nativePath,
    GRIMODEX_MCP_PATH: mcpPath,
  };
  await assert.rejects(
    assertBuildArtifacts([mcpJourney], {
      catalog: [mcpJourney],
      root,
      env: mcpEnvironment,
    }),
    /missing Electron product journey artifact|MCP/i,
  );
  await writeFile(mcpTarget, "mcp");
  await chmod(mcpTarget, 0o755);
  await symlink(path.basename(mcpTarget), mcpPath);
  const mcpArtifacts = (
    await assertBuildArtifacts([mcpJourney], {
      catalog: [mcpJourney],
      root,
      env: mcpEnvironment,
    })
  ).artifacts;
  assert.deepEqual(
    mcpArtifacts.map((artifact) => artifact.name),
    ["Electron main", "renderer", "N-API native module", "MCP sidecar"],
  );
  assert.equal(mcpArtifacts.at(-1).requestedPath, mcpPath);
  assert.equal(mcpArtifacts.at(-1).realPath, await realpath(mcpTarget));
});

test("C2-ZC artifact preflight keeps all lanes truthfully not-run", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-c2zc-preflight-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const journeys = NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG.map(({ id }) => ({
    id,
    run: async () => {
      throw new Error("lane must not launch");
    },
  }));
  const candidate = {
    requestedBase: "origin/master",
    requestedHead: "HEAD",
    resolvedBaseSha: "a".repeat(40),
    resolvedHeadSha: "b".repeat(40),
    resolvedHeadTreeSha: "c".repeat(40),
    currentHeadSha: "b".repeat(40),
    worktreeClean: true,
    worktreeFingerprint: "d".repeat(64),
    worktreeStatusHash: "e".repeat(64),
  };

  await assert.rejects(
    runProductJourneys({
      catalog: NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
      journeys,
      selectionName: "c2-zc",
      assertArtifacts: () => {
        throw new Error("missing C2-ZC build artifact");
      },
      root,
      buildReceipt: null,
      rustAcceptanceEvidence: {
        required: true,
        verified: true,
        candidate,
        receipt: { candidate },
      },
      createHarness: () => {
        throw new Error("harness must not be created");
      },
      resultsPath: path.join(root, "results.json"),
    }),
    /missing C2-ZC build artifact/,
  );
  const report = await readJson(path.join(root, "results.json"));
  assert.deepEqual(
    report.journeys.map(({ id, status }) => [id, status]),
    journeys.map(({ id }) => [id, "not-run"]),
  );
  assert.equal(report.allPassed, false);
  assert.equal(report.acceptanceComplete, false);
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

test("non-C2-ZC selection writes failed and fail-fast results before rethrowing", async (t) => {
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
      selectionName: "non-c2-zc",
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
