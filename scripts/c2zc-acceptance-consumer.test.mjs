import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as canonicalContract from "../electron/scripts/c2zc-canonical-product-journey.mjs";
import * as dmlContract from "../electron/scripts/c2zc-renderer-mcp-dml-denial-product-journey.mjs";
import * as harnessContract from "../electron/scripts/product-journey-harness.mjs";
import * as productRunner from "../electron/scripts/product-journeys.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function readRepo(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stateDigest(state) {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(state), "utf8")
    .digest("hex")}`;
}

test("DML consumer never invokes core quiescence request/read methods", async () => {
  const calls = { awaitQuiescence: 0, readQuiescence: 0 };
  const harness = {
    workspacePath: () => "/tmp/c2-zc-dml-consumer-red",
    async launch(phase) {
      return { app: { phase }, page: { phase } };
    },
    async close() {},
    recordTimeline() {},
    async waitUntil() {
      throw new Error("stop after renderer-only boundary");
    },
    async invokeOk(_page, command) {
      if (command === "open_workspace") return {};
      if (command === "narrative_extraction_capture_workspace_binding") {
        return {
          authorityId: "authority-red",
          generation: 1,
          authorityInstanceId: "1",
        };
      }
      throw new Error(`stop at ${command}`);
    },
    async awaitQuiescence() {
      calls.awaitQuiescence += 1;
      throw new Error("awaitQuiescence must not be called");
    },
    async readQuiescence() {
      calls.readQuiescence += 1;
      throw new Error("readQuiescence must not be called");
    },
  };

  await assert.rejects(dmlContract.runC2ZcRendererMcpDmlDenialJourney(harness));
  assert.deepEqual(calls, { awaitQuiescence: 0, readQuiescence: 0 });
});

test("DML consumer rejects protected renderer ledger drift during a denial", () => {
  const transition = dmlContract.classifyDmlSnapshotTransition({
    before: [{ id: "same" }],
    after: [{ id: "same" }],
    settledAfter: [{ id: "same" }],
    beforeLedger: { projects: ["A"], feedHead: 1 },
    afterLedger: { projects: ["A"], feedHead: 2 },
    settledAfterLedger: { projects: ["A"], feedHead: 2 },
    beforeFingerprint: "stable",
    afterFingerprint: "stable",
  });
  assert.equal(transition.ledgerChangedDuringProbe, true);
  assert.equal(transition.ok, false);
});

function heldEvidenceFixture() {
  const requestNonce = "00000000-0000-4000-8000-000000000021";
  const phase = "c2-zc-canonical-authority-cutover/open-held-freshness";
  const workspaceBinding = { authorityId: "authority-c2zc", generation: 7 };
  const projects = [
    {
      projectId: "project-a",
      currentEpochId: "epoch-a",
      feedHead: 4,
      cursor: {
        acknowledgedThrough: 4,
        reservedThrough: null,
        activeRunId: null,
        semanticEpochId: null,
        lastError: null,
      },
    },
    {
      projectId: "project-b",
      currentEpochId: "epoch-b",
      feedHead: 6,
      cursor: {
        acknowledgedThrough: 5,
        reservedThrough: 6,
        activeRunId: "run-b",
        semanticEpochId: "epoch-b",
        lastError: null,
      },
    },
  ];
  const state = {
    authorityId: workspaceBinding.authorityId,
    generation: workspaceBinding.generation,
    freshnessHoldProjectId: "project-b",
    heldProjectId: "project-b",
    marker: null,
    projects,
  };
  state.stateDigest = stateDigest(state);
  return {
    requestNonce,
    phase,
    workspaceBinding,
    secondaryProjectId: "project-b",
    event: {
      version: 1,
      type: "grimodex:narrative-maintenance-ci-held-freshness",
      nonce: "00000000-0000-4000-8000-000000000001",
      requestNonce,
      phase,
      requestedAt: "2026-08-29T00:00:00.000Z",
      sequence: 1,
      observedAt: "2026-08-29T00:00:00.002Z",
      monotonicObservedAtMs: 1,
      workspaceBinding,
      freshness: {
        cycleGeneration: 2,
        requestBarrierCycleGeneration: 1,
        requestPublishedAtMs: Date.parse("2026-08-29T00:00:00.000Z"),
        cycleStartedAtMs: Date.parse("2026-08-29T00:00:00.001Z"),
        observedAtMs: Date.parse("2026-08-29T00:00:00.002Z"),
        inFlight: false,
        hasMore: false,
        noWrite: true,
        heldProjectId: "project-b",
        cutoverNotReady: true,
        wakePending: false,
        timerScheduled: false,
        nextCycleGuardStateDigest: null,
      },
      state,
      stateDigest: state.stateDigest,
    },
    projectInventory: projects.map(({ projectId }) => projectId),
  };
}

test("pre-marker held-Freshness evidence is distinct from post-marker workspace receipt", () => {
  const fixture = heldEvidenceFixture();
  assert.equal(
    typeof canonicalContract.assertC2ZcPreMarkerHeldEvidence,
    "function",
  );
  assert.doesNotThrow(() =>
    canonicalContract.assertC2ZcPreMarkerHeldEvidence(fixture.event, {
      requestNonce: fixture.requestNonce,
      phase: fixture.phase,
      workspaceBinding: fixture.workspaceBinding,
      secondaryProjectId: fixture.secondaryProjectId,
      projectInventory: fixture.projectInventory,
    }),
  );
  assert.throws(
    () =>
      canonicalContract.assertC2ZcWorkspaceCutoverReceipt({
        markerBefore: { marker: null, markerRows: [] },
        markerAfter: { marker: null, markerRows: [] },
        projects: [],
        projectInventory: fixture.projectInventory,
        rustBoundaryEvidence: null,
        preMarkerHeldEvidence: fixture.event,
      }),
    /marker|project|Rust/i,
  );
});

test("pre-marker held-Freshness validator rejects marker-present, unheld, and wrong-binding events", () => {
  const fixture = heldEvidenceFixture();
  const assertValid = (event) =>
    canonicalContract.assertC2ZcPreMarkerHeldEvidence(event, {
      requestNonce: fixture.requestNonce,
      phase: fixture.phase,
      workspaceBinding: fixture.workspaceBinding,
      secondaryProjectId: fixture.secondaryProjectId,
      projectInventory: fixture.projectInventory,
    });
  assertValid(fixture.event);
  assert.throws(
    () =>
      assertValid({
        ...fixture.event,
        state: { ...fixture.event.state, marker: { migrationId: "marker" } },
      }),
    /marker|pre.?marker/i,
  );
  assert.throws(
    () =>
      assertValid({
        ...fixture.event,
        freshness: {
          ...fixture.event.freshness,
          heldProjectId: null,
          cutoverNotReady: false,
        },
        state: {
          ...fixture.event.state,
          heldProjectId: null,
          freshnessHoldProjectId: null,
        },
      }),
    /held|NOT_READY|cutover/i,
  );
  assert.throws(
    () =>
      assertValid({
        ...fixture.event,
        workspaceBinding: { authorityId: "other", generation: 7 },
      }),
    /binding|authority/i,
  );
  for (const cycleStartedAtMs of [
    Date.parse(fixture.event.requestedAt),
    fixture.event.freshness.requestPublishedAtMs,
    fixture.event.freshness.observedAtMs + 1,
  ]) {
    assert.throws(
      () =>
        assertValid({
          ...fixture.event,
          freshness: { ...fixture.event.freshness, cycleStartedAtMs },
        }),
      /timing|causal|requestedAt/i,
    );
  }
});

test("pre-marker held-Freshness rejection binds caller-owned request values", async () => {
  const fixture = heldEvidenceFixture();
  const canonical = await readRepo(
    "electron/scripts/c2zc-canonical-product-journey.mjs",
  );
  assert.match(
    canonical,
    /const heldRequestNonce = randomUUID\(\);/,
    "the journey must retain the caller-owned held request nonce",
  );
  assert.match(
    canonical,
    /const heldPhase = `\$\{phasePrefix\}\/open-held-freshness`;/,
    "the journey must retain the caller-owned held request phase",
  );
  assert.match(
    canonical,
    /const heldBinding = \{\s*authorityId: binding\.authorityId,\s*generation: binding\.generation,\s*\};/s,
    "the journey must retain the caller-owned held workspace binding",
  );
  const causalSource = canonical.match(
    /export function assertC2ZcPreMarkerCausalEvidence\([\s\S]*?^}\n\n\/\/ Compatibility export/m,
  )?.[0];
  assert.ok(
    causalSource,
    "the causal validator must be independently inspectable",
  );
  assert.match(
    causalSource,
    /requestNonce = null,[\s\S]*phase = null,[\s\S]*workspaceBinding = null/,
    "the causal validator must require caller-owned request values",
  );
  assert.match(
    causalSource,
    /assertC2ZcPreMarkerHeldEvidence\(receipt, \{\s*requestNonce,\s*phase,\s*workspaceBinding,/s,
    "the causal validator must forward caller-owned request values",
  );
  const assertAgainstRequest = (event) =>
    canonicalContract.assertC2ZcPreMarkerHeldEvidence(event, {
      requestNonce: fixture.requestNonce,
      phase: fixture.phase,
      workspaceBinding: fixture.workspaceBinding,
      secondaryProjectId: fixture.secondaryProjectId,
      projectInventory: fixture.projectInventory,
    });
  assertAgainstRequest(fixture.event);
  for (const [field, value, pattern] of [
    ["requestNonce", "00000000-0000-4000-8000-000000000099", /nonce/i],
    ["phase", `${fixture.phase}-wrong`, /phase/i],
    [
      "workspaceBinding",
      { authorityId: "authority-other", generation: 8 },
      /binding|authority/i,
    ],
  ]) {
    assert.throws(
      () => assertAgainstRequest({ ...fixture.event, [field]: value }),
      pattern,
      `must reject a receipt with a forged ${field}`,
    );
  }
});

test("failed acceptance report keeps Rust completion separate from final acceptance", () => {
  assert.equal(typeof productRunner.refreshProductJourneyOutcome, "function");
  const report = {
    status: "failed",
    journeyIds: ["dml", "canonical", "post-marker"],
    journeys: [
      { id: "dml", status: "failed", cleanPass: false },
      { id: "canonical", status: "not-run" },
      { id: "post-marker", status: "not-run" },
    ],
    acceptanceRequired: true,
    c2zcRustAcceptance: { required: true, verified: true },
    rustAcceptanceComplete: true,
    acceptanceComplete: true,
    allPassed: false,
    allClean: false,
  };
  productRunner.refreshProductJourneyOutcome(report);
  assert.equal(report.rustAcceptanceComplete, true);
  assert.equal(report.acceptanceComplete, false);
  assert.equal(report.allPassed, false);
  assert.equal(report.allClean, false);
});

test("clean non-required subset reports never claim final acceptance", () => {
  const report = {
    status: "passed",
    journeyIds: ["c2-zc-renderer-mcp-dml-denial"],
    journeys: [
      {
        id: "c2-zc-renderer-mcp-dml-denial",
        status: "passed",
        cleanPass: true,
      },
    ],
    acceptanceRequired: false,
    c2zcRustAcceptance: null,
    buildReceipt: null,
  };

  productRunner.refreshProductJourneyOutcome(report);

  assert.equal(report.allPassed, true);
  assert.equal(report.allClean, true);
  assert.equal(report.acceptanceComplete, false);
});

test("candidate-bound acceptance rejects a Rust/build candidate mismatch", () => {
  const candidate = (head) => ({
    requestedBase: "origin/master",
    requestedHead: "HEAD",
    resolvedBaseSha: "a".repeat(40),
    resolvedHeadSha: head,
    resolvedHeadTreeSha: "c".repeat(40),
    currentHeadSha: head,
    worktreeClean: true,
    worktreeFingerprint: "d".repeat(64),
    worktreeStatusHash: "e".repeat(64),
  });
  const rustCandidate = candidate("b".repeat(40));
  const buildCandidate = candidate("f".repeat(40));
  const report = {
    status: "passed",
    journeyIds: ["c2-zc-renderer-mcp-dml-denial"],
    journeys: [
      {
        id: "c2-zc-renderer-mcp-dml-denial",
        status: "passed",
        cleanPass: true,
      },
    ],
    acceptanceRequired: true,
    c2zcRustAcceptance: {
      required: true,
      verified: true,
      candidate: rustCandidate,
      receipt: { candidate: rustCandidate },
    },
    buildReceipt: {
      version: 1,
      verified: true,
      source: "local-ci-candidate",
      candidate: rustCandidate,
    },
  };
  productRunner.refreshProductJourneyOutcome(report);
  assert.equal(report.rustAcceptanceComplete, true);
  assert.equal(report.allPassed, true);
  assert.equal(report.allClean, true);
  assert.equal(report.acceptanceComplete, true);

  report.buildReceipt = {
    ...report.buildReceipt,
    candidate: buildCandidate,
  };
  productRunner.refreshProductJourneyOutcome(report);
  assert.equal(report.rustAcceptanceComplete, true);
  assert.equal(report.allPassed, false);
  assert.equal(report.allClean, false);
  assert.equal(report.acceptanceComplete, false);
});

test("standalone build receipts are exact, clean-candidate evidence only", () => {
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
  };
  const envKey = "GRIMODEX_PRODUCT_JOURNEY_BUILD_RECEIPT";
  const previous = process.env[envKey];
  const withReceipt = (value, assertion) => {
    process.env[envKey] = JSON.stringify(value);
    try {
      assertion();
    } finally {
      if (previous === undefined) delete process.env[envKey];
      else process.env[envKey] = previous;
    }
  };
  withReceipt(receipt, () => {
    assert.deepEqual(productRunner.readProductJourneyBuildReceipt(), receipt);
  });
  withReceipt({ ...receipt, foreignKey: true }, () => {
    assert.equal(productRunner.readProductJourneyBuildReceipt(), null);
  });
  withReceipt(
    {
      ...receipt,
      candidate: { ...candidate, worktreeClean: false },
    },
    () => {
      assert.equal(productRunner.readProductJourneyBuildReceipt(), null);
    },
  );
  withReceipt(
    {
      ...receipt,
      candidate: { ...candidate, currentHeadSha: "f".repeat(40) },
    },
    () => {
      assert.equal(productRunner.readProductJourneyBuildReceipt(), null);
    },
  );
});

test("harness held-Freshness receipt requires causally ordered cycle timing", () => {
  const fixture = heldEvidenceFixture();
  assert.doesNotThrow(() =>
    harnessContract.assertNarrativeMaintenanceCiHeldFreshnessReceipt(
      fixture.event,
      fixture.event.nonce,
      1,
    ),
  );
  assert.throws(
    () =>
      harnessContract.assertNarrativeMaintenanceCiHeldFreshnessReceipt(
        {
          ...fixture.event,
          freshness: Object.fromEntries(
            Object.entries(fixture.event.freshness).filter(
              ([key]) => key !== "cycleStartedAtMs",
            ),
          ),
        },
        fixture.event.nonce,
        1,
      ),
    /unexpected keys|freshness/i,
  );
  for (const cycleStartedAtMs of [
    -1,
    Date.parse(fixture.event.requestedAt),
    fixture.event.freshness.observedAtMs + 1,
  ]) {
    assert.throws(
      () =>
        harnessContract.assertNarrativeMaintenanceCiHeldFreshnessReceipt(
          {
            ...fixture.event,
            freshness: { ...fixture.event.freshness, cycleStartedAtMs },
          },
          fixture.event.nonce,
          1,
        ),
      /cycleStartedAtMs|held Freshness/i,
    );
  }
  assert.throws(
    () =>
      harnessContract.assertNarrativeMaintenanceCiHeldFreshnessReceipt(
        {
          ...fixture.event,
          freshness: {
            ...fixture.event.freshness,
            requestBarrierCycleGeneration:
              fixture.event.freshness.cycleGeneration,
          },
        },
        fixture.event.nonce,
        1,
      ),
    /cycle|barrier|causal|held|write/i,
  );
});

test("held-Freshness history rejects non-monotonic immutable observations", async () => {
  const fixture = heldEvidenceFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "c2-zc-held-history-red-"));
  const nonceDir = path.join(root, fixture.event.nonce);
  const request = {
    version: 1,
    type: "grimodex:narrative-maintenance-ci-held-freshness-request",
    nonce: fixture.event.nonce,
    requestNonce: fixture.event.requestNonce,
    phase: fixture.event.phase,
    requestedAt: fixture.event.requestedAt,
    workspaceBinding: fixture.event.workspaceBinding,
  };
  const launchReceipt = {
    version: 1,
    type: "grimodex:narrative-maintenance-ci-receipt",
    nonce: fixture.event.nonce,
    active: true,
    setup: null,
    freshness: null,
    freshnessHoldProjectId: null,
    fault: null,
    trigger: null,
    isPackaged: false,
    nativeAck: true,
  };
  const expected = launchReceipt;
  try {
    await mkdir(nonceDir, { recursive: true });
    await writeFile(
      path.join(nonceDir, "receipt.json"),
      canonicalJson(launchReceipt),
    );
    await writeFile(
      path.join(nonceDir, "held-freshness-request.json"),
      canonicalJson(request),
    );
    await writeFile(
      path.join(nonceDir, "held-freshness-0000000001.json"),
      canonicalJson(fixture.event),
    );
    await writeFile(
      path.join(nonceDir, "held-freshness-0000000002.json"),
      canonicalJson({
        ...fixture.event,
        sequence: 2,
      }),
    );
    await assert.rejects(
      harnessContract.readNarrativeMaintenanceCiHeldFreshness(
        root,
        expected,
        fixture.event.phase,
        {
          previousSequence: 0,
          requestNonce: fixture.event.requestNonce,
          workspaceBinding: fixture.event.workspaceBinding,
        },
      ),
      /strictly increasing|monotonic|observed/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("held-Freshness history rejects a non-adjacent request nonce replay", async () => {
  const fixture = heldEvidenceFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "c2-zc-held-replay-red-"));
  const nonceDir = path.join(root, fixture.event.nonce);
  const requestNonceB = "00000000-0000-4000-8000-000000000022";
  const request = {
    version: 1,
    type: "grimodex:narrative-maintenance-ci-held-freshness-request",
    nonce: fixture.event.nonce,
    requestNonce: fixture.event.requestNonce,
    phase: fixture.event.phase,
    requestedAt: fixture.event.requestedAt,
    workspaceBinding: fixture.event.workspaceBinding,
  };
  const launchReceipt = {
    version: 1,
    type: "grimodex:narrative-maintenance-ci-receipt",
    nonce: fixture.event.nonce,
    active: true,
    setup: null,
    freshness: null,
    freshnessHoldProjectId: null,
    fault: null,
    trigger: null,
    isPackaged: false,
    nativeAck: true,
  };
  const requestedAtMs = Date.parse(fixture.event.requestedAt);
  const eventB = {
    ...fixture.event,
    requestNonce: requestNonceB,
    phase: `${fixture.event.phase}-b`,
    sequence: 2,
    observedAt: new Date(requestedAtMs + 3).toISOString(),
    monotonicObservedAtMs: 2,
    freshness: {
      ...fixture.event.freshness,
      cycleGeneration: 3,
      requestBarrierCycleGeneration: 2,
      cycleStartedAtMs: requestedAtMs + 2,
      observedAtMs: requestedAtMs + 3,
    },
  };
  const replayedA = {
    ...fixture.event,
    sequence: 3,
    observedAt: new Date(requestedAtMs + 4).toISOString(),
    monotonicObservedAtMs: 3,
    freshness: {
      ...fixture.event.freshness,
      cycleGeneration: 4,
      requestBarrierCycleGeneration: 3,
      cycleStartedAtMs: requestedAtMs + 3,
      observedAtMs: requestedAtMs + 4,
    },
  };
  try {
    await mkdir(nonceDir, { recursive: true });
    await writeFile(
      path.join(nonceDir, "receipt.json"),
      canonicalJson(launchReceipt),
    );
    await writeFile(
      path.join(nonceDir, "held-freshness-request.json"),
      canonicalJson(request),
    );
    for (const [sequence, event] of [
      [1, fixture.event],
      [2, eventB],
      [3, replayedA],
    ]) {
      await writeFile(
        path.join(
          nonceDir,
          `held-freshness-${String(sequence).padStart(10, "0")}.json`,
        ),
        canonicalJson(event),
      );
    }
    await assert.rejects(
      harnessContract.readNarrativeMaintenanceCiHeldFreshness(
        root,
        launchReceipt,
        fixture.event.phase,
        {
          previousSequence: 0,
          requestNonce: fixture.event.requestNonce,
          workspaceBinding: fixture.event.workspaceBinding,
        },
      ),
      /duplicate|replay|request nonce/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("held-Freshness read binds the latest receipt to every durable request field", async () => {
  const fixture = heldEvidenceFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "c2-zc-held-binding-red-"));
  const nonceDir = path.join(root, fixture.event.nonce);
  const launchReceipt = {
    version: 1,
    type: "grimodex:narrative-maintenance-ci-receipt",
    nonce: fixture.event.nonce,
    active: true,
    setup: null,
    freshness: null,
    freshnessHoldProjectId: null,
    fault: null,
    trigger: null,
    isPackaged: false,
    nativeAck: true,
  };
  const request = {
    version: 1,
    type: "grimodex:narrative-maintenance-ci-held-freshness-request",
    nonce: fixture.event.nonce,
    requestNonce: fixture.event.requestNonce,
    phase: fixture.event.phase,
    requestedAt: fixture.event.requestedAt,
    workspaceBinding: fixture.event.workspaceBinding,
  };
  const requestPath = path.join(nonceDir, "held-freshness-request.json");
  try {
    await mkdir(nonceDir, { recursive: true });
    await writeFile(
      path.join(nonceDir, "receipt.json"),
      canonicalJson(launchReceipt),
    );
    await writeFile(requestPath, canonicalJson(request));
    await writeFile(
      path.join(nonceDir, "held-freshness-0000000001.json"),
      canonicalJson(fixture.event),
    );
    const readOptions = {
      previousSequence: 0,
      requestNonce: fixture.event.requestNonce,
      workspaceBinding: fixture.event.workspaceBinding,
    };
    await assert.doesNotReject(() =>
      harnessContract.readNarrativeMaintenanceCiHeldFreshness(
        root,
        launchReceipt,
        fixture.event.phase,
        readOptions,
      ),
    );
    for (const [field, value] of [
      ["requestNonce", "00000000-0000-4000-8000-000000000023"],
      ["phase", `${fixture.event.phase}-b`],
      ["requestedAt", "2026-08-29T00:00:01.000Z"],
      ["workspaceBinding", { authorityId: "authority-other", generation: 8 }],
    ]) {
      await writeFile(
        requestPath,
        canonicalJson({ ...request, [field]: value }),
      );
      await assert.rejects(
        harnessContract.readNarrativeMaintenanceCiHeldFreshness(
          root,
          launchReceipt,
          fixture.event.phase,
          readOptions,
        ),
        /stale request|binding|phase|nonce/i,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acceptance consumer avoids global-quiescence and atomic cross-connection claims", async () => {
  const [dml, canonical] = await Promise.all([
    readRepo(
      "electron/scripts/c2zc-renderer-mcp-dml-denial-product-journey.mjs",
    ),
    readRepo("electron/scripts/c2zc-canonical-product-journey.mjs"),
  ]);
  assert.doesNotMatch(dml, /awaitQuiescence|readQuiescence/);
  assert.doesNotMatch(dml, /secondaryConnectionProof|quiescenceArtifacts/);
  assert.doesNotMatch(canonical, /quiescenceReceipt|atomicityEvidence/);
  assert.match(canonical, /preMarkerHeldEvidence/);
  assert.match(canonical, /rustBoundaryEvidence/);
});
