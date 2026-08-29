import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  C2ZC_MCP_GENERIC_SQL_CONTRACT,
  C2ZC_NATIVE_OWNED_TABLE_NAMES,
  C2ZC_RENDERER_DML_OPERATIONS,
  C2ZC_RENDERER_DML_PHASE_ALLOWLIST,
  C2ZC_RENDERER_MCP_DML_DENIAL_CATALOG_ENTRY,
  C2ZC_RENDERER_MCP_DML_DENIAL_ID,
  C2ZC_RENDERER_MCP_DML_DENIAL_JOURNEY,
  C2ZC_RENDERER_MCP_DML_DENIAL_PHASES,
  C2ZC_RENDERER_SETTLEMENT_MIN_STABLE_MS,
  C2ZC_RENDERER_SETTLEMENT_REDISCOVERY_DELAY_MS,
  C2ZC_RENDERER_DURABLE_SETTLEMENT_QUERIES,
  C2ZC_RENDERER_DML_EVIDENCE_VERSION,
  C2ZC_RENDERER_DML_TIMELINE_EVENT,
  C2ZC_RENDERER_TABLE_CONTRACTS,
  assessDurableRendererSettlementSamples,
  assertRendererLedgerMatches,
  classifyDmlSnapshotTransition,
  inspectDurableTerminalLedger,
  validateDurableRendererSettlementObservation,
  runC2ZcRendererMcpDmlDenialJourney,
} from "../electron/scripts/c2zc-renderer-mcp-dml-denial-product-journey.mjs";
import * as dmlContract from "../electron/scripts/c2zc-renderer-mcp-dml-denial-product-journey.mjs";
import {
  NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_CATALOG_DIGEST,
  digestProductJourneyCatalog,
} from "../electron/scripts/product-journey-catalog.mjs";
import { resolveProductJourneyImpactCatalog } from "../electron/scripts/product-journey-impact.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function readRepo(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("C2-ZC renderer/MCP DML denial journey is declared", async () => {
  assert.equal(
    C2ZC_RENDERER_MCP_DML_DENIAL_JOURNEY.id,
    "c2-zc-renderer-mcp-dml-denial",
  );
  assert.equal(
    C2ZC_RENDERER_MCP_DML_DENIAL_CATALOG_ENTRY.id,
    "c2-zc-renderer-mcp-dml-denial",
  );
  assert.deepEqual(C2ZC_NATIVE_OWNED_TABLE_NAMES, [
    "narrative_semantic_epochs",
    "narrative_extraction_runs",
    "narrative_dependency_edges",
    "narrative_dependency_edge_states",
    "narrative_consumer_freshness",
    "narrative_semantic_index_metadata",
    "narrative_maintenance_finding_lifecycle",
    "narrative_maintenance_finding_observations",
    "narrative_maintenance_repair_leases",
  ]);
  assert.deepEqual(
    C2ZC_RENDERER_TABLE_CONTRACTS.map((table) => table.name),
    C2ZC_NATIVE_OWNED_TABLE_NAMES,
  );
  assert.equal(C2ZC_RENDERER_TABLE_CONTRACTS.length, 9);
  assert.deepEqual(C2ZC_RENDERER_MCP_DML_DENIAL_CATALOG_ENTRY.capabilities, [
    "electron",
    "napi",
  ]);
  assert.deepEqual(
    C2ZC_RENDERER_MCP_DML_DENIAL_CATALOG_ENTRY.phases,
    C2ZC_RENDERER_MCP_DML_DENIAL_PHASES,
  );
  assert.equal(
    C2ZC_RENDERER_MCP_DML_DENIAL_CATALOG_ENTRY.mcpGeneric,
    C2ZC_MCP_GENERIC_SQL_CONTRACT,
  );
  const catalogEntry = NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG.find(
    (journey) => journey.id === C2ZC_RENDERER_MCP_DML_DENIAL_ID,
  );
  assert.ok(catalogEntry);
  assert.deepEqual(catalogEntry, C2ZC_RENDERER_MCP_DML_DENIAL_CATALOG_ENTRY);
  const protectedWriters = JSON.parse(
    await readRepo("policies/narrative/protected-writers.json"),
  );
  const c2zcProtectedEntries = protectedWriters.filter(
    (entry) =>
      entry.aggregate?.startsWith("narrative-c2zc-") &&
      entry.enforcement === "active",
  );
  assert.deepEqual(
    c2zcProtectedEntries.map((entry) => entry.table),
    C2ZC_NATIVE_OWNED_TABLE_NAMES,
  );
  assert.ok(
    c2zcProtectedEntries.every(
      (entry) =>
        entry.protection === "table" && entry.writer === "narrative.authority",
    ),
  );
});

test("DML acceptance uses a unique phase namespace and explicit allowlist", () => {
  assert.deepEqual(C2ZC_RENDERER_MCP_DML_DENIAL_PHASES, [
    "c2-zc-renderer-mcp-dml-denial/open",
    "c2-zc-renderer-mcp-dml-denial/restart",
  ]);
  assert.deepEqual(C2ZC_RENDERER_DML_PHASE_ALLOWLIST, [
    ...C2ZC_RENDERER_MCP_DML_DENIAL_PHASES,
  ]);
  assert.equal(
    new Set(C2ZC_RENDERER_DML_PHASE_ALLOWLIST).size,
    C2ZC_RENDERER_DML_PHASE_ALLOWLIST.length,
  );
  assert.ok(
    C2ZC_RENDERER_DML_PHASE_ALLOWLIST.every((phase) =>
      phase.startsWith(`${C2ZC_RENDERER_MCP_DML_DENIAL_ID}/`),
    ),
  );
  assert.ok(
    C2ZC_RENDERER_DML_PHASE_ALLOWLIST.every(
      (phase) => !phase.startsWith("c2-zc-canonical-authority-cutover/"),
    ),
  );
});

test("DML acceptance uses renderer-visible durable settlement only", async () => {
  const source = await readRepo(
    "electron/scripts/c2zc-renderer-mcp-dml-denial-product-journey.mjs",
  );
  assert.doesNotMatch(source, /awaitQuiescence|readQuiescence/);
  assert.match(source, /narrative_extraction_capture_workspace_binding/);
  assert.match(source, /rendererSettlementEvidence|settledEvidence/);
  assert.match(source, /withLaunchEnvironmentForTest/);
  assert.doesNotMatch(source, /readRuntimeQuiescenceReceipt/);
  assert.doesNotMatch(source, /assertRuntimeQuiescenceReceipt/);
  assert.doesNotMatch(source, /C2ZC_RUNTIME_QUIESCENCE/);
});

test("DML settlement projects the exact Native binding from three keys", () => {
  const binding = dmlContract.assertC2ZcRendererWorkspaceBinding({
    authorityId: "authority-c2zc",
    generation: 7,
    authorityInstanceId: "11",
  });
  assert.deepEqual(binding, {
    authorityId: "authority-c2zc",
    generation: 7,
  });
  assert.throws(
    () =>
      dmlContract.assertC2ZcRendererWorkspaceBinding({
        authorityId: "authority-c2zc",
        generation: 7,
      }),
    /authorityInstanceId|invalid binding/i,
  );
});

test("settlement stability window is strictly longer than scheduler rediscovery", () => {
  assert.ok(
    C2ZC_RENDERER_SETTLEMENT_MIN_STABLE_MS >
      C2ZC_RENDERER_SETTLEMENT_REDISCOVERY_DELAY_MS,
  );
  assert.ok(C2ZC_RENDERER_SETTLEMENT_MIN_STABLE_MS >= 500);
});

test("durable settlement does not accept a settled sample before a delayed writer", () => {
  const sample = (observedAt, monotonicMs, fingerprint, settled = true) => ({
    observedAt,
    monotonicMs,
    fingerprint,
    settled,
    terminalLedger: {
      ready: settled,
      obligations: [],
      completed: [],
    },
  });
  const firstSamples = [
    sample("2026-08-28T00:00:00.000Z", 0, "A"),
    sample("2026-08-28T00:00:00.100Z", 100, "A"),
  ];
  assert.equal(
    assessDurableRendererSettlementSamples(firstSamples),
    null,
    "two 100ms polls must not be accepted as durable settlement",
  );
  const delayedWriterSamples = [
    ...firstSamples,
    sample("2026-08-28T00:00:00.250Z", 250, "B", false),
    sample("2026-08-28T00:00:00.350Z", 350, "A"),
    sample("2026-08-28T00:00:00.600Z", 600, "A"),
    sample("2026-08-28T00:00:00.850Z", 850, "A"),
  ];
  const evidence = assessDurableRendererSettlementSamples(delayedWriterSamples);
  assert.ok(evidence);
  assert.equal(evidence.fingerprint, "A");
  assert.ok(evidence.durationMs >= C2ZC_RENDERER_SETTLEMENT_MIN_STABLE_MS);
  assert.equal(evidence.stableSampleCount, 3);
  assert.equal(evidence.startAt, "2026-08-28T00:00:00.350Z");
  assert.equal(evidence.endAt, "2026-08-28T00:00:00.850Z");
});

test("durable settlement resets on an unstable fingerprint and never reports a partial interval", () => {
  const sample = (observedAt, monotonicMs, fingerprint) => ({
    observedAt,
    monotonicMs,
    fingerprint,
    settled: true,
    terminalLedger: { ready: true, obligations: [], completed: [] },
  });
  const evidence = assessDurableRendererSettlementSamples([
    sample("2026-08-28T00:00:00.000Z", 0, "A"),
    sample("2026-08-28T00:00:00.250Z", 250, "A"),
    sample("2026-08-28T00:00:00.500Z", 500, "B"),
    sample("2026-08-28T00:00:00.750Z", 750, "A"),
    sample("2026-08-28T00:00:00.950Z", 950, "A"),
    sample("2026-08-28T00:00:01.200Z", 1200, "A"),
    sample("2026-08-28T00:00:01.450Z", 1450, "A"),
  ]);
  assert.ok(evidence);
  assert.equal(evidence.fingerprint, "A");
  assert.equal(evidence.startAt, "2026-08-28T00:00:00.750Z");
  assert.equal(evidence.stableSampleCount, 4);
  assert.ok(evidence.durationMs >= C2ZC_RENDERER_SETTLEMENT_MIN_STABLE_MS);
});

test("durable quiescence rejects a 60-second sample gap instead of treating it as continuous", () => {
  const sample = (observedAt, monotonicMs) => ({
    observedAt,
    monotonicMs,
    fingerprint: "stable",
    settled: true,
    terminalLedger: { ready: true, obligations: [], completed: [] },
  });
  assert.equal(
    assessDurableRendererSettlementSamples([
      sample("2026-08-28T00:00:00.000Z", 0),
      sample("2026-08-28T00:00:00.100Z", 100),
      sample("2026-08-28T00:01:00.100Z", 60_100),
      sample("2026-08-28T00:01:00.200Z", 60_200),
    ]),
    null,
    "a rediscovery-sized gap must break the stable segment",
  );
});

test("durable quiescence uses monotonic samples and preserves monotonic receipt timing", () => {
  const sample = (observedAt, monotonicMs) => ({
    observedAt,
    monotonicMs,
    fingerprint: "stable",
    settled: true,
    terminalLedger: { ready: true, obligations: [], completed: [] },
  });
  const evidence = assessDurableRendererSettlementSamples([
    sample("2099-01-01T00:00:00.000Z", 1_000),
    sample("2026-01-01T00:00:00.100Z", 1_100),
    sample("2026-01-01T00:00:00.350Z", 1_350),
    sample("2026-01-01T00:00:00.600Z", 1_600),
  ]);
  assert.ok(evidence);
  assert.equal(evidence.monotonicStartMs, 1_000);
  assert.equal(evidence.monotonicEndMs, 1_600);
  assert.equal(evidence.monotonicDurationMs, 600);
  assert.equal(evidence.durationMs, 600);
});

test("durable quiescence resets on a non-monotonic observation clock", () => {
  const sample = (observedAt, monotonicMs, fingerprint) => ({
    observedAt,
    monotonicMs,
    fingerprint,
    settled: true,
    terminalLedger: { ready: true, obligations: [], completed: [] },
  });
  const evidence = assessDurableRendererSettlementSamples([
    sample("2026-08-28T00:00:00.000Z", 0, "A"),
    sample("2026-08-28T00:00:00.400Z", 400, "A"),
    sample("2026-08-28T00:00:00.100Z", 100, "A"),
    sample("2026-08-28T00:00:00.550Z", 550, "A"),
  ]);
  assert.equal(evidence, null);
});

test("core quiescence ledger binding rejects empty, missing, extra, or mismatched projects", () => {
  const ledger = {
    projects: [
      {
        projectId: "project-a",
        currentEpochId: "epoch-a",
        feedHead: 4,
        cursor: {
          acknowledgedThrough: 4,
          reservedThrough: null,
          activeRunId: null,
          semanticEpochId: "epoch-a",
          lastError: null,
        },
      },
      {
        projectId: "project-b",
        currentEpochId: "epoch-b",
        feedHead: 0,
        cursor: {
          acknowledgedThrough: null,
          reservedThrough: null,
          activeRunId: null,
          semanticEpochId: "epoch-b",
          lastError: null,
        },
      },
    ],
    marker: null,
  };
  const receipt = {
    state: {
      projects: ledger.projects,
      marker: ledger.marker,
    },
  };
  assert.doesNotThrow(() =>
    assertRendererLedgerMatches(receipt, ledger, "exact ledger"),
  );
  for (const [label, projects] of [
    ["empty", []],
    ["missing", ledger.projects.slice(0, 1)],
    [
      "extra",
      [...ledger.projects, { ...ledger.projects[1], projectId: "project-c" }],
    ],
  ]) {
    assert.throws(
      () =>
        assertRendererLedgerMatches(
          { state: { projects, marker: null } },
          ledger,
          `${label} ledger`,
        ),
      /state\.projects does not match the live DB ledger/,
      `${label} project set must be rejected`,
    );
  }
  assert.throws(
    () =>
      assertRendererLedgerMatches(
        {
          state: {
            projects: ledger.projects,
            marker: {
              migrationId: "narrative-c2-canonical-freshness-v1",
              contractVersion: 1,
              appliedAt: "2026-08-28T00:00:00.000Z",
            },
          },
        },
        ledger,
        "marker mismatch ledger",
      ),
    /marker does not match the live DB ledger/,
    "marker mismatch must be rejected",
  );
});

test("durable quiescence rejects a missing terminal ledger obligation", () => {
  assert.throws(
    () =>
      validateDurableRendererSettlementObservation({
        settled: true,
        feedAndCursor: { consistent: true },
        active: {
          runs: [],
          tasks: [],
          attempts: [],
          reservations: [],
          repairLeases: [],
          pendingWakeOutbox: [],
        },
        terminalLedger: {
          ready: false,
          obligations: [
            { kind: "dependency-verify", status: "missing", runId: null },
          ],
          completed: [],
        },
      }),
    /terminal ledger obligation|missing/i,
  );
});

test("DML snapshot attribution does not blame a durable production writer", () => {
  const unchanged = classifyDmlSnapshotTransition({
    before: [{ id: "before" }],
    after: [{ id: "before" }],
    settledAfter: [{ id: "before" }],
    beforeFingerprint: "A",
    afterFingerprint: "A",
  });
  assert.deepEqual(
    {
      ok: unchanged.ok,
      snapshotUnchanged: unchanged.snapshotUnchanged,
      backgroundWriterDetected: unchanged.backgroundWriterDetected,
    },
    { ok: true, snapshotUnchanged: true, backgroundWriterDetected: false },
  );

  const writer = classifyDmlSnapshotTransition({
    before: [{ id: "before" }],
    after: [{ id: "writer" }],
    settledAfter: [{ id: "writer" }],
    beforeFingerprint: "A",
    afterFingerprint: "B",
  });
  assert.deepEqual(
    {
      ok: writer.ok,
      snapshotUnchanged: writer.snapshotUnchanged,
      backgroundWriterDetected: writer.backgroundWriterDetected,
    },
    { ok: false, snapshotUnchanged: false, backgroundWriterDetected: false },
  );

  const delayedWriter = classifyDmlSnapshotTransition({
    before: [{ id: "before" }],
    after: [{ id: "before" }],
    settledAfter: [{ id: "writer" }],
    beforeFingerprint: "A",
    afterFingerprint: "B",
  });
  assert.deepEqual(
    {
      ok: delayedWriter.ok,
      snapshotUnchanged: delayedWriter.snapshotUnchanged,
      backgroundWriterDetected: delayedWriter.backgroundWriterDetected,
    },
    { ok: true, snapshotUnchanged: true, backgroundWriterDetected: true },
  );

  const unaccountedDelayedChange = classifyDmlSnapshotTransition({
    before: [{ id: "before" }],
    after: [{ id: "before" }],
    settledAfter: [{ id: "unaccounted" }],
    beforeFingerprint: "A",
    afterFingerprint: "A",
  });
  assert.equal(
    unaccountedDelayedChange.ok,
    false,
    "an after->settled change without a durable writer transition is not exculpatory",
  );

  const unaccounted = classifyDmlSnapshotTransition({
    before: [{ id: "before" }],
    after: [{ id: "unexpected" }],
    settledAfter: [{ id: "unexpected" }],
    beforeFingerprint: "A",
    afterFingerprint: "A",
  });
  assert.equal(unaccounted.ok, false);
  assert.equal(unaccounted.backgroundWriterDetected, false);
});

test("ledger lifecycle requires completion before the next run starts", () => {
  assert.equal(
    typeof dmlContract.validateMandatoryLifecycleSequence,
    "function",
  );
  const valid = dmlContract.validateMandatoryLifecycleSequence([
    {
      id: "backfill",
      runKind: "backfill",
      startedAt: "2026-08-28T00:00:00.100Z",
      completedAt: "2026-08-28T00:00:01.000Z",
    },
    {
      id: "verify",
      runKind: "dependency-verify",
      startedAt: "2026-08-28T00:00:01.001Z",
      completedAt: "2026-08-28T00:00:02.000Z",
    },
    {
      id: "rebuild",
      runKind: "semantic-index-rebuild",
      startedAt: "2026-08-28T00:00:02.001Z",
      completedAt: "2026-08-28T00:00:03.000Z",
    },
    {
      id: "confirmation",
      runKind: "dependency-verify",
      startedAt: "2026-08-28T00:00:03.001Z",
      completedAt: "2026-08-28T00:00:04.000Z",
    },
  ]);
  assert.equal(valid.valid, true);
  const overlapping = dmlContract.validateMandatoryLifecycleSequence([
    {
      id: "backfill",
      runKind: "backfill",
      startedAt: "2026-08-28T00:00:00.100Z",
      completedAt: "2026-08-28T00:00:02.000Z",
    },
    {
      id: "verify",
      runKind: "dependency-verify",
      startedAt: "2026-08-28T00:00:01.500Z",
      completedAt: "2026-08-28T00:00:03.000Z",
    },
    {
      id: "rebuild",
      runKind: "semantic-index-rebuild",
      startedAt: "2026-08-28T00:00:03.001Z",
      completedAt: "2026-08-28T00:00:04.000Z",
    },
    {
      id: "confirmation",
      runKind: "dependency-verify",
      startedAt: "2026-08-28T00:00:04.001Z",
      completedAt: "2026-08-28T00:00:05.000Z",
    },
  ]);
  assert.equal(overlapping.valid, false);
  assert.match(overlapping.reason, /backfill|verify|start|complete|overlap/i);
});

test("terminal ledger derives missing Verify/confirmation obligations instead of trusting a clean cursor", () => {
  const ledger = inspectDurableTerminalLedger({
    epochs: [
      {
        id: "epoch-1",
        projectId: "project-1",
        epochNumber: 1,
        createdAt: "2026-08-28T00:00:00.000Z",
      },
    ],
    runs: [
      {
        id: "backfill-1",
        projectId: "project-1",
        runKind: "backfill",
        status: "completed",
        semanticEpochId: "epoch-1",
        completedAt: "2026-08-28T00:00:01.000Z",
      },
      {
        id: "rebuild-1",
        projectId: "project-1",
        runKind: "semantic-index-rebuild",
        status: "completed",
        semanticEpochId: "epoch-1",
        completedAt: "2026-08-28T00:00:02.000Z",
      },
    ],
    freshnessEvidence: [],
    feedAndCursor: {
      feed: [],
      cursors: [],
    },
  });
  assert.equal(ledger.ready, false);
  assert.ok(
    ledger.obligations.some(
      (obligation) =>
        obligation.kind === "dependency-verify" &&
        obligation.status === "missing",
    ),
  );
  assert.ok(
    ledger.obligations.some(
      (obligation) =>
        obligation.kind === "confirmation-verify" &&
        obligation.status === "missing",
    ),
  );

  const missingEpoch = inspectDurableTerminalLedger({
    runs: [
      {
        id: "backfill-without-epoch",
        projectId: "project-2",
        runKind: "backfill",
        status: "completed",
        semanticEpochId: null,
        completedAt: "2026-08-28T00:00:01.000Z",
      },
      {
        id: "verify-without-epoch",
        projectId: "project-2",
        runKind: "dependency-verify",
        status: "completed",
        semanticEpochId: null,
        completedAt: "2026-08-28T00:00:02.000Z",
      },
    ],
  });
  assert.equal(missingEpoch.ready, false);
  assert.ok(
    missingEpoch.obligations.some(
      (obligation) =>
        obligation.kind === "dependency-verify" &&
        obligation.status === "missing",
    ),
  );
});

test("terminal ledger enumerates projects as authority and rejects an empty project set", () => {
  const ledger = inspectDurableTerminalLedger({
    projects: [],
    epochs: [],
    runs: [],
    tasks: [],
    attempts: [],
    freshnessEvidence: [],
    feedAndCursor: { feed: [], cursors: [], consistent: true, mismatches: [] },
  });
  assert.equal(ledger.ready, false);
  assert.ok(
    ledger.obligations.some(
      (obligation) => obligation.reason === "project-authority-empty",
    ),
  );

  const noAuthorityRows = inspectDurableTerminalLedger({
    epochs: [],
    runs: [],
    tasks: [],
    attempts: [],
    freshnessEvidence: [],
    feedAndCursor: { feed: [], cursors: [], consistent: true, mismatches: [] },
  });
  assert.equal(
    noAuthorityRows.ready,
    false,
    "an empty obligation set cannot prove durable terminal readiness",
  );
});

test("terminal ledger does not derive obligations from rows belonging to a forged project", () => {
  const ledger = inspectDurableTerminalLedger({
    projects: [{ id: "authoritative-project" }],
    epochs: [
      {
        id: "forged-epoch",
        projectId: "forged-project",
        epochNumber: 1,
        createdAt: "2026-08-28T00:00:00.000Z",
      },
    ],
    runs: [
      {
        id: "forged-run",
        projectId: "forged-project",
        runKind: "backfill",
        status: "completed",
        semanticEpochId: "forged-epoch",
        workKey: "legacy-dependency-backfill:v3",
        completedAt: "2026-08-28T00:00:01.000Z",
      },
    ],
    tasks: [],
    attempts: [],
    freshnessEvidence: [],
    feedAndCursor: { feed: [], cursors: [], consistent: true, mismatches: [] },
  });
  assert.equal(ledger.ready, false);
  assert.ok(
    ledger.obligations.every(
      (obligation) => obligation.projectId === "authoritative-project",
    ),
  );
  assert.ok(
    ledger.obligations.some(
      (obligation) =>
        obligation.kind === "current-epoch" && obligation.status === "missing",
    ),
  );
});

test("Generic freshness provenance separates idle scheduler checkpoints from publisher evidence", () => {
  assert.equal(
    typeof dmlContract.validateGenericFreshnessPublisherProvenance,
    "function",
  );
  const idle = {
    id: "freshness-1",
    projectId: "project-1",
    consumerId: "narrative-incremental-freshness/v1",
    status: "completed",
    completedAt: "2026-08-28T00:00:01.000Z",
    runKind: "freshness-evaluation",
    semanticEpochId: "epoch-1",
    workKey: "incremental-freshness:epoch-1:0:0:idle-checkpoint",
    specJson: JSON.stringify({ idleCheckpoint: { from: 0, through: 0 } }),
    outcomeSummaryJson: JSON.stringify({ from: 0, through: 0, hasMore: false }),
  };
  const feedSpec = {
    affectedObjects: ["edge-1"],
    eventIds: ["event-1"],
    feedPageDigest: "sha256:" + "a".repeat(64),
    fromSequenceExclusive: 1,
    projectId: "project-1",
    throughSequenceInclusive: 3,
  };
  const feedSpecJson = JSON.stringify(feedSpec);
  const feedSpecDigest = `sha256:${createHash("sha256")
    .update(feedSpecJson)
    .digest("hex")}`;
  const feed = {
    ...idle,
    workKey: `incremental-freshness:epoch-1:1:3:${feedSpecDigest.slice("sha256:".length)}`,
    specJson: feedSpecJson,
    specDigest: feedSpecDigest,
    outcomeSummaryJson: JSON.stringify({
      projectId: "project-1",
      runId: "freshness-1",
      fromSequenceExclusive: 1,
      throughSequenceInclusive: 3,
      affectedEdgeCount: 1,
      affectedConsumerCount: 1,
      hasMore: false,
    }),
    createdAt: "2026-08-28T00:00:00.100Z",
    startedAt: "2026-08-28T00:00:00.200Z",
  };
  assert.equal(
    dmlContract.validateGenericFreshnessPublisherProvenance(idle).valid,
    false,
  );
  assert.equal(
    dmlContract.validateGenericFreshnessPublisherProvenance(feed).valid,
    false,
    "a feed publisher without its durable Task/Attempt lifecycle is not sufficient",
  );
  const feedTask = {
    id: "feed-task",
    runId: feed.id,
    taskKind: "incremental-freshness-batch",
    status: "completed",
    inputJson: JSON.stringify({
      changeSetId: "change-set-1",
      fromSequenceExclusive: 1,
      throughSequenceInclusive: 3,
    }),
    outputJson: feed.outcomeSummaryJson,
    attemptCount: 1,
    createdAt: "2026-08-28T00:00:00.200Z",
    startedAt: "2026-08-28T00:00:00.300Z",
    completedAt: "2026-08-28T00:00:00.800Z",
  };
  const feedAttempt = {
    id: "feed-attempt",
    taskId: feedTask.id,
    attemptNumber: 1,
    status: "completed",
    startedAt: "2026-08-28T00:00:00.400Z",
    completedAt: "2026-08-28T00:00:00.700Z",
    outputJson: feed.outcomeSummaryJson,
    failureCode: null,
    retryDisposition: null,
    policyVersion: null,
    nextAttemptAt: null,
  };
  assert.equal(
    dmlContract.validateGenericFreshnessPublisherProvenance({
      run: feed,
      projectId: "project-1",
      epochId: "epoch-1",
      tasks: [feedTask],
      attempts: [feedAttempt],
    }).valid,
    true,
  );
  const feedContext = {
    run: feed,
    projectId: "project-1",
    epochId: "epoch-1",
    tasks: [feedTask],
    attempts: [feedAttempt],
  };
  const feedSpecBoundaryMutations = [
    {
      label:
        "a feed publisher cannot carry an authority-forged systemWork marker",
      spec: {
        ...feedSpec,
        systemWork: {
          trigger: "workspace-opened",
          canonicalWorkKey:
            "narrative-maintenance:v1/freshness-evaluation/project-1/forged",
          authorityId: "authority-forged",
          generation: 999,
          productJourneyBarrierId: "barrier-forged",
          correlation: "correlation-forged",
        },
      },
    },
    {
      label: "a feed publisher cannot carry an unknown producer spec field",
      spec: { ...feedSpec, unknownProducerField: "forged" },
    },
  ];
  assert.deepEqual(
    feedSpecBoundaryMutations.map(
      ({ spec }) =>
        dmlContract.validateGenericFreshnessPublisherProvenance({
          ...feedContext,
          run: { ...feed, specJson: JSON.stringify(spec) },
        }).valid,
    ),
    [false, false],
    feedSpecBoundaryMutations.map(({ label }) => label).join("; "),
  );
  assert.equal(
    dmlContract.validateGenericFreshnessPublisherProvenance({
      ...feedContext,
      tasks: [{ ...feedTask, createdAt: "2026-08-28T00:00:00.900Z" }],
    }).valid,
    false,
    "a Task cannot be created after it has already started or completed",
  );

  const retryRunId = "freshness-with-retry";
  const retryOutcome = JSON.stringify({
    ...JSON.parse(feed.outcomeSummaryJson),
    runId: retryRunId,
  });
  const retryRun = {
    ...feed,
    id: retryRunId,
    outcomeSummaryJson: retryOutcome,
  };
  const retryTask = {
    ...feedTask,
    id: "freshness-with-retry-task",
    runId: retryRunId,
    outputJson: retryOutcome,
    attemptCount: 2,
  };
  const retryAttempts = [
    {
      id: "freshness-with-retry-attempt-1",
      taskId: retryTask.id,
      attemptNumber: 1,
      status: "failed",
      startedAt: "2026-08-28T00:00:00.400Z",
      completedAt: "2026-08-28T00:00:00.500Z",
      outputJson: null,
      failureCode: "NEX_TRANSIENT_FAILURE",
      retryDisposition: "retryable",
      policyVersion: "v1",
      nextAttemptAt: "2026-08-28T00:00:00.600Z",
    },
    {
      id: "freshness-with-retry-attempt-2",
      taskId: retryTask.id,
      attemptNumber: 2,
      status: "completed",
      startedAt: "2026-08-28T00:00:00.601Z",
      completedAt: "2026-08-28T00:00:00.700Z",
      outputJson: retryOutcome,
      failureCode: null,
      retryDisposition: null,
      policyVersion: null,
      nextAttemptAt: null,
    },
  ];
  const retryContext = {
    run: retryRun,
    projectId: "project-1",
    epochId: "epoch-1",
    tasks: [retryTask],
    attempts: retryAttempts,
  };
  assert.equal(
    dmlContract.validateGenericFreshnessPublisherProvenance(retryContext).valid,
    true,
    "a canonical retryable failed Attempt followed by completion is valid",
  );
  assert.equal(
    dmlContract.validateGenericFreshnessPublisherProvenance({
      ...retryContext,
      attempts: [
        {
          ...retryAttempts[0],
          retryDisposition: "v1",
          policyVersion: "retryable",
        },
        retryAttempts[1],
      ],
    }).valid,
    false,
    "swapped retry disposition and policy values are not canonical metadata",
  );
  assert.equal(
    dmlContract.validateGenericFreshnessPublisherProvenance({
      ...retryContext,
      attempts: [
        { ...retryAttempts[0], policyVersion: null },
        retryAttempts[1],
      ],
    }).valid,
    false,
    "a failed Attempt without its policy version is not valid provenance",
  );
  const retryTopologyMutations = [
    {
      label:
        "a retry Attempt cannot start before the prior completion or retry deadline",
      attempts: [
        retryAttempts[0],
        {
          ...retryAttempts[1],
          startedAt: "2026-08-28T00:00:00.450Z",
        },
      ],
    },
    {
      label: "a completed final Attempt cannot retain retry metadata",
      attempts: [
        retryAttempts[0],
        {
          ...retryAttempts[1],
          retryDisposition: "retryable",
          policyVersion: "v1",
          nextAttemptAt: "2026-08-28T00:00:00.800Z",
          errorMessage: "stale retry metadata",
        },
      ],
    },
  ];
  assert.deepEqual(
    retryTopologyMutations.map(
      ({ attempts }) =>
        dmlContract.validateGenericFreshnessPublisherProvenance({
          ...retryContext,
          attempts,
        }).valid,
    ),
    [false, false],
    retryTopologyMutations.map(({ label }) => label).join("; "),
  );
  assert.equal(
    dmlContract.validateGenericFreshnessPublisherProvenance({
      id: "rebuild-1",
      status: "completed",
      runKind: "semantic-index-rebuild",
      workKey: "dependency-rebuild-derived",
      projectId: "project-1",
      semanticEpochId: "epoch-1",
      specJson: JSON.stringify({
        systemWork: {
          trigger: "workspace-opened",
          canonicalWorkKey:
            "narrative-maintenance:v1/semantic-index-rebuild/project-1/dependency-rebuild-derived/epoch/epoch-1",
          authorityId: "authority-1",
          generation: 1,
          productJourneyBarrierId: "barrier-1",
          correlation: "correlation-1",
        },
      }),
      specDigest: `sha256:${createHash("sha256").update("{}").digest("hex")}`,
      completedAt: "2026-08-28T00:00:01.000Z",
      createdAt: "2026-08-28T00:00:00.100Z",
      startedAt: "2026-08-28T00:00:00.200Z",
      task: {
        id: "rebuild-task",
        runId: "rebuild-1",
        taskKind: "maintenance-semantic-index-rebuild",
        status: "completed",
        inputJson: JSON.stringify({
          systemWork: {
            trigger: "workspace-opened",
            canonicalWorkKey:
              "narrative-maintenance:v1/semantic-index-rebuild/project-1/dependency-rebuild-derived/epoch/epoch-1",
            authorityId: "authority-1",
            generation: 1,
            productJourneyBarrierId: "barrier-1",
            correlation: "correlation-1",
          },
        }),
        attemptCount: 1,
        createdAt: "2026-08-28T00:00:00.300Z",
        startedAt: "2026-08-28T00:00:00.400Z",
        completedAt: "2026-08-28T00:00:00.800Z",
      },
      attempt: {
        id: "rebuild-attempt",
        taskId: "rebuild-task",
        attemptNumber: 1,
        status: "completed",
        startedAt: "2026-08-28T00:00:00.500Z",
        completedAt: "2026-08-28T00:00:00.700Z",
        failureCode: null,
        retryDisposition: null,
        nextAttemptAt: null,
      },
      tasks: [],
      attempts: [],
    }).valid,
    false,
    "a bare or forged Rebuild row is not a publisher alternative",
  );
  const rebuildMarker = {
    trigger: "workspace-opened",
    canonicalWorkKey:
      "narrative-maintenance:v1/semantic-index-rebuild/project-1/dependency-rebuild-derived/epoch/epoch-1",
    authorityId: "authority-1",
    generation: 1,
    productJourneyBarrierId: "barrier-1",
    correlation: "correlation-1",
  };
  const rebuildSpecJson = JSON.stringify({ systemWork: rebuildMarker });
  const rebuild = {
    id: "rebuild-valid",
    status: "completed",
    runKind: "semantic-index-rebuild",
    workKey: "dependency-rebuild-derived",
    projectId: "project-1",
    semanticEpochId: "epoch-1",
    specJson: rebuildSpecJson,
    specDigest: `sha256:${createHash("sha256").update("{}").digest("hex")}`,
    createdAt: "2026-08-28T00:00:00.100Z",
    startedAt: "2026-08-28T00:00:00.200Z",
    completedAt: "2026-08-28T00:00:01.000Z",
  };
  const rebuildTask = {
    id: "rebuild-valid-task",
    runId: rebuild.id,
    taskKind: "maintenance-semantic-index-rebuild",
    status: "completed",
    inputJson: rebuildSpecJson,
    attemptCount: 1,
    createdAt: "2026-08-28T00:00:00.300Z",
    startedAt: "2026-08-28T00:00:00.400Z",
    completedAt: "2026-08-28T00:00:00.800Z",
  };
  const rebuildAttempt = {
    id: "rebuild-valid-attempt",
    taskId: rebuildTask.id,
    attemptNumber: 1,
    status: "completed",
    startedAt: "2026-08-28T00:00:00.500Z",
    completedAt: "2026-08-28T00:00:00.700Z",
    failureCode: null,
    retryDisposition: null,
    policyVersion: null,
    nextAttemptAt: null,
  };
  assert.equal(
    dmlContract.validateGenericFreshnessPublisherProvenance({
      run: rebuild,
      projectId: "project-1",
      epochId: "epoch-1",
      tasks: [rebuildTask],
      attempts: [rebuildAttempt],
    }).valid,
    true,
    "the exact completed Rebuild lifecycle is the only alternative publisher",
  );
});

test("Generic freshness validates every current project/Epoch row and publisher lifecycle", () => {
  assert.equal(typeof dmlContract.validateGenericFreshnessRows, "function");
  const spec = {
    affectedObjects: ["edge-1"],
    eventIds: ["event-1"],
    feedPageDigest: "sha256:" + "b".repeat(64),
    fromSequenceExclusive: 1,
    projectId: "project-1",
    throughSequenceInclusive: 3,
  };
  const specJson = JSON.stringify(spec);
  const specDigest = `sha256:${createHash("sha256")
    .update(specJson)
    .digest("hex")}`;
  const run = {
    id: "feed-publisher",
    projectId: "project-1",
    consumerId: "narrative-incremental-freshness/v1",
    runKind: "freshness-evaluation",
    semanticEpochId: "epoch-1",
    workKey: `incremental-freshness:epoch-1:1:3:${specDigest.slice("sha256:".length)}`,
    status: "completed",
    specJson,
    specDigest,
    outcomeSummaryJson: JSON.stringify({
      projectId: "project-1",
      runId: "feed-publisher",
      fromSequenceExclusive: 1,
      throughSequenceInclusive: 3,
      affectedEdgeCount: 1,
      affectedConsumerCount: 1,
      hasMore: false,
    }),
    createdAt: "2026-08-28T00:00:00.100Z",
    startedAt: "2026-08-28T00:00:00.200Z",
    completedAt: "2026-08-28T00:00:00.900Z",
  };
  const task = {
    id: "feed-publisher-task",
    runId: run.id,
    taskKind: "incremental-freshness-batch",
    status: "completed",
    inputJson: JSON.stringify({
      changeSetId: "change-set-1",
      fromSequenceExclusive: 1,
      throughSequenceInclusive: 3,
    }),
    outputJson: JSON.stringify({
      projectId: "project-1",
      runId: "feed-publisher",
      fromSequenceExclusive: 1,
      throughSequenceInclusive: 3,
      affectedEdgeCount: 1,
      affectedConsumerCount: 1,
      hasMore: false,
    }),
    attemptCount: 1,
    createdAt: "2026-08-28T00:00:00.200Z",
    startedAt: "2026-08-28T00:00:00.300Z",
    completedAt: "2026-08-28T00:00:00.800Z",
  };
  const attempt = {
    id: "feed-publisher-attempt",
    taskId: task.id,
    attemptNumber: 1,
    status: "completed",
    startedAt: "2026-08-28T00:00:00.400Z",
    completedAt: "2026-08-28T00:00:00.700Z",
    outputJson: run.outcomeSummaryJson,
    failureCode: null,
    retryDisposition: null,
    nextAttemptAt: null,
  };
  const row = {
    projectId: "project-1",
    consumerKind: "narrative",
    consumerKey: "default",
    evidenceFreshness: "fresh",
    buildAction: "none",
    semanticEpochId: "epoch-1",
    lastEvaluatedRunId: run.id,
    updatedAt: "2026-08-28T00:00:01.000Z",
  };
  const context = {
    projectId: "project-1",
    epochId: "epoch-1",
    runs: [run],
    tasks: [task],
    attempts: [attempt],
  };
  assert.equal(
    dmlContract.validateGenericFreshnessRows([row], context).valid,
    true,
  );
  assert.equal(
    dmlContract.validateGenericFreshnessRows(
      [
        row,
        {
          ...row,
          consumerKey: "other-consumer",
          lastEvaluatedRunId: "bad-feed-publisher",
        },
      ],
      {
        ...context,
        runs: [
          run,
          { ...run, id: "bad-feed-publisher", consumerId: "wrong-consumer" },
        ],
      },
    ).valid,
    false,
    "a valid row must not hide a duplicate/other Generic row",
  );
  assert.equal(
    dmlContract.validateGenericFreshnessRows([row], {
      ...context,
      runs: [{ ...run, consumerId: "wrong-consumer" }],
    }).valid,
    false,
    "the publisher consumerId is part of the Rust provenance contract",
  );
  assert.equal(
    dmlContract.validateGenericFreshnessRows(
      [row, { ...row, consumerKey: "historical", semanticEpochId: "epoch-0" }],
      context,
    ).valid,
    false,
    "a stale current-project Generic row cannot be hidden by a valid current-Epoch row",
  );
});

test("protected table snapshots use declared stable primary-key ordering", () => {
  const expectedOrder = {
    narrative_semantic_epochs: ["id"],
    narrative_extraction_runs: ["id"],
    narrative_dependency_edges: ["id"],
    narrative_dependency_edge_states: ["edge_id"],
    narrative_consumer_freshness: [
      "project_id",
      "consumer_kind",
      "consumer_key",
    ],
    narrative_semantic_index_metadata: ["project_id", "index_key"],
    narrative_maintenance_finding_lifecycle: ["id"],
    narrative_maintenance_finding_observations: ["id"],
    narrative_maintenance_repair_leases: ["project_id"],
  };
  for (const table of C2ZC_RENDERER_TABLE_CONTRACTS) {
    assert.deepEqual(
      table.primaryKeyColumns,
      expectedOrder[table.name],
      table.name,
    );
    assert.ok(table.snapshotOrderSql.includes("ASC"), table.name);
    assert.doesNotMatch(table.snapshotOrderSql, /rowid/i, table.name);
  }
});

test("catalog, runner, impact map, and contract command are wired", async () => {
  const [packageSource, runnerSource, impactManifest] = await Promise.all([
    readRepo("package.json"),
    readRepo("electron/scripts/product-journeys.mjs"),
    readRepo("evals/impact-map.yaml"),
  ]);
  const packageJson = JSON.parse(packageSource);
  assert.match(
    packageJson.scripts["test:product-journey-contracts"],
    /scripts\/c2zc-renderer-mcp-dml-denial\.test\.mjs/,
  );
  assert.match(runnerSource, /runC2ZcRendererMcpDmlDenialJourney/);
  assert.match(runnerSource, /c2-zc-renderer-mcp-dml-denial/);
  assert.deepEqual(
    resolveProductJourneyImpactCatalog("c2-zc").map((journey) => journey.id),
    [
      "c2-zc-renderer-mcp-dml-denial",
      "c2-zc-canonical-authority-cutover",
      "c2-zc-post-marker-lifecycle",
    ],
  );
  assert.match(
    impactManifest,
    /c2zc-renderer-mcp-dml-denial-product-journey\.mjs/,
  );
  assert.match(impactManifest, /c2zc-renderer-mcp-dml-denial\.test\.mjs/);
  assert.match(
    impactManifest,
    /src-tauri\/crates\/grimodex-db\/src\/execute\.rs/,
  );
});

test("catalog nested contract values are immutable and digest-bound", () => {
  const dmlEntry = PRODUCT_JOURNEY_CATALOG.find(
    (journey) => journey.id === C2ZC_RENDERER_MCP_DML_DENIAL_ID,
  );
  assert.ok(dmlEntry);
  assert.ok(dmlEntry.mcpGeneric);
  assert.throws(
    () => {
      dmlEntry.mcpGeneric.status = "forged";
    },
    TypeError,
    "nested catalog values must not be mutable after digest binding",
  );
  assert.equal(
    digestProductJourneyCatalog(PRODUCT_JOURNEY_CATALOG),
    PRODUCT_JOURNEY_CATALOG_DIGEST,
    "recomputed catalog digest must remain bound to the exported digest",
  );
});

test("renderer DML cases are safe zero-row authorizer probes for every table", () => {
  assert.deepEqual(
    C2ZC_RENDERER_DML_OPERATIONS.map((operation) => operation.name),
    ["INSERT", "UPDATE", "DELETE", "REPLACE"],
  );
  for (const table of C2ZC_RENDERER_TABLE_CONTRACTS) {
    for (const operation of C2ZC_RENDERER_DML_OPERATIONS) {
      const sql = operation.sql(table.name, table.updateColumn);
      assert.match(sql, /WHERE 0 = \?/);
      if (operation.name === "UPDATE") {
        assert.match(
          sql,
          new RegExp(`SET "${table.updateColumn}" = "${table.updateColumn}"`),
        );
      } else if (operation.name === "INSERT" || operation.name === "REPLACE") {
        assert.match(sql, /SELECT \* FROM/);
      }
    }
  }
});

test("journey executes its real renderer contract without requiring a dependency install", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "c2zc-renderer-mcp-dml-contract-"),
  );
  const workspace = path.join(temporaryRoot, "workspace");
  const events = [];
  const selectCalls = [];
  const dmlCalls = [];
  const timeline = [];
  const mutableSnapshots = Object.fromEntries(
    C2ZC_NATIVE_OWNED_TABLE_NAMES.map((table) => [table, []]),
  );
  const settlementQueries = new Set(
    Object.values(C2ZC_RENDERER_DURABLE_SETTLEMENT_QUERIES),
  );
  let rendererOpen = false;
  let activeMaintenance = false;
  let backgroundMutationInjected = false;
  let waitUntilRetries = 0;
  let fakeNowMs = Date.parse("2026-08-28T00:00:00.000Z");
  let fakeMonotonicMs = 0;
  const canonicalJson = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  };
  const specDigest = (value) =>
    `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
  const markerFor = (runKind, projectId, workKey, epochId) => ({
    trigger: "workspace-opened",
    canonicalWorkKey: `narrative-maintenance:v1/${runKind}/${projectId}/${workKey}${
      runKind === "backfill" ? "" : `/epoch/${epochId}`
    }`,
    authorityId: "authority-1",
    generation: 1,
    productJourneyBarrierId: "dml-barrier",
    correlation: "dml-correlation",
  });
  const makeRun = ({ id, runKind, workKey, epochId, at, baseSpec }) => {
    const specJson = JSON.stringify({
      ...baseSpec,
      systemWork: markerFor(runKind, "background-project", workKey, epochId),
    });
    const taskKind = {
      backfill: "maintenance-backfill",
      "dependency-verify": "maintenance-dependency-verify",
      "semantic-index-rebuild": "maintenance-semantic-index-rebuild",
    }[runKind];
    return {
      id,
      projectId: "background-project",
      runKind,
      workKey,
      status: "completed",
      semanticEpochId: epochId,
      specJson,
      specDigest: specDigest(baseSpec),
      createdAt: `2026-08-28T00:00:0${at}.000Z`,
      startedAt: `2026-08-28T00:00:0${at}.100Z`,
      completedAt: `2026-08-28T00:00:0${at}.900Z`,
      task: {
        id: `${id}-task`,
        runId: id,
        taskKind,
        status: "completed",
        inputJson: specJson,
        attemptCount: 1,
        createdAt: `2026-08-28T00:00:0${at}.100Z`,
        startedAt: `2026-08-28T00:00:0${at}.200Z`,
        completedAt: `2026-08-28T00:00:0${at}.800Z`,
      },
      attempt: {
        id: `${id}-attempt-1`,
        taskId: `${id}-task`,
        attemptNumber: 1,
        status: "completed",
        startedAt: `2026-08-28T00:00:0${at}.300Z`,
        completedAt: `2026-08-28T00:00:0${at}.700Z`,
        failureCode: null,
        retryDisposition: null,
        nextAttemptAt: null,
      },
    };
  };
  const ledgerBackfill = makeRun({
    id: "ledger-backfill",
    runKind: "backfill",
    workKey: "legacy-dependency-backfill:v3",
    epochId: "epoch-1",
    at: 1,
    baseSpec: { backfillAlgorithmVersion: "3" },
  });
  const ledgerVerify = makeRun({
    id: "ledger-verify",
    runKind: "dependency-verify",
    workKey: "dependency-verify:epoch-1",
    epochId: "epoch-1",
    at: 2,
    baseSpec: { verifyContractVersion: "1" },
  });
  const ledgerRebuild = makeRun({
    id: "ledger-rebuild",
    runKind: "semantic-index-rebuild",
    workKey: "dependency-rebuild-derived",
    epochId: "epoch-1",
    at: 3,
    baseSpec: {},
  });
  const ledgerConfirmation = makeRun({
    id: "ledger-confirmation",
    runKind: "dependency-verify",
    workKey: "dependency-verify:epoch-1",
    epochId: "epoch-1",
    at: 4,
    baseSpec: { verifyContractVersion: "1" },
  });
  const ledgerFreshnessSpecJson = JSON.stringify({
    affectedObjects: ["edge-1"],
    eventIds: ["event-1"],
    feedPageDigest: "sha256:" + "c".repeat(64),
    fromSequenceExclusive: 0,
    projectId: "background-project",
    throughSequenceInclusive: 1,
  });
  const ledgerFreshnessSpecDigest = `sha256:${createHash("sha256")
    .update(ledgerFreshnessSpecJson)
    .digest("hex")}`;
  const ledgerFreshness = {
    id: "ledger-freshness",
    projectId: "background-project",
    consumerId: "narrative-incremental-freshness/v1",
    runKind: "freshness-evaluation",
    workKey: `incremental-freshness:epoch-1:0:1:${ledgerFreshnessSpecDigest.slice("sha256:".length)}`,
    status: "completed",
    semanticEpochId: "epoch-1",
    specJson: ledgerFreshnessSpecJson,
    specDigest: ledgerFreshnessSpecDigest,
    outcomeSummaryJson: JSON.stringify({
      projectId: "background-project",
      runId: "ledger-freshness",
      fromSequenceExclusive: 0,
      throughSequenceInclusive: 1,
      affectedEdgeCount: 1,
      affectedConsumerCount: 1,
      hasMore: false,
    }),
    createdAt: "2026-08-28T00:00:05.000Z",
    startedAt: "2026-08-28T00:00:05.100Z",
    completedAt: "2026-08-28T00:00:05.900Z",
    task: {
      id: "ledger-freshness-task",
      runId: "ledger-freshness",
      taskKind: "incremental-freshness-batch",
      status: "completed",
      inputJson: JSON.stringify({
        changeSetId: "change-set-1",
        fromSequenceExclusive: 0,
        throughSequenceInclusive: 1,
      }),
      outputJson: JSON.stringify({
        projectId: "background-project",
        runId: "ledger-freshness",
        fromSequenceExclusive: 0,
        throughSequenceInclusive: 1,
        affectedEdgeCount: 1,
        affectedConsumerCount: 1,
        hasMore: false,
      }),
      attemptCount: 1,
      createdAt: "2026-08-28T00:00:05.100Z",
      startedAt: "2026-08-28T00:00:05.200Z",
      completedAt: "2026-08-28T00:00:05.800Z",
    },
    attempt: {
      id: "ledger-freshness-attempt-1",
      taskId: "ledger-freshness-task",
      attemptNumber: 1,
      status: "completed",
      startedAt: "2026-08-28T00:00:05.300Z",
      completedAt: "2026-08-28T00:00:05.700Z",
      outputJson: JSON.stringify({
        projectId: "background-project",
        runId: "ledger-freshness",
        fromSequenceExclusive: 0,
        throughSequenceInclusive: 1,
        affectedEdgeCount: 1,
        affectedConsumerCount: 1,
        hasMore: false,
      }),
      failureCode: null,
      retryDisposition: null,
      nextAttemptAt: null,
    },
  };
  const ledgerRuns = [
    ledgerBackfill,
    ledgerVerify,
    ledgerRebuild,
    ledgerConfirmation,
    ledgerFreshness,
  ];
  const ledgerTasks = ledgerRuns.map((run) => run.task).filter(Boolean);
  const ledgerAttempts = ledgerRuns.map((run) => run.attempt).filter(Boolean);
  const ledgerProjects = [{ id: "background-project" }];
  const ledgerEpochs = [
    {
      id: "epoch-1",
      projectId: "background-project",
      epochNumber: 1,
      createdAt: "2026-08-28T00:00:00.000Z",
    },
  ];
  const ledgerFreshnessEvidence = [
    {
      projectId: "background-project",
      consumerKind: "narrative",
      consumerKey: "default",
      evidenceFreshness: "fresh",
      buildAction: "none",
      semanticEpochId: "epoch-1",
      lastEvaluatedRunId: "ledger-freshness",
      dependencySetDigest: "sha256:" + "b".repeat(64),
      updatedAt: "2026-08-28T00:00:06.000Z",
    },
  ];
  const previousCi = process.env.CI;
  process.env.CI = "true";
  try {
    const harness = {
      workspacePath(name) {
        assert.equal(name, "c2-zc-renderer-mcp-dml-denial");
        return workspace;
      },
      async launch(phase) {
        assert.equal(rendererOpen, false);
        rendererOpen = true;
        events.push(`launch:${phase}`);
        return { app: { phase }, page: { phase } };
      },
      async close(app, page, phase) {
        assert.equal(app.phase, page.phase);
        events.push(`close:${phase}`);
        rendererOpen = false;
      },
      recordTimeline(event, details) {
        timeline.push({ event, details });
      },
      async waitUntil(fn, label) {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          // Simulate the legitimate open-time writer completing between two
          // denial probes. The new per-probe pairing must observe this only
          // after the writer has settled, not compare it to a stale global
          // baseline.
          if (
            !backgroundMutationInjected &&
            label.includes("before") &&
            dmlCalls.length === 0
          ) {
            backgroundMutationInjected = true;
            activeMaintenance = true;
            mutableSnapshots.narrative_semantic_epochs = [
              { id: "legitimate-background-write" },
            ];
          }
          try {
            const value = await fn();
            if (value) return value;
          } catch {
            waitUntilRetries += 1;
          }
          if (activeMaintenance) activeMaintenance = false;
        }
        throw new Error(`fake waitUntil timed out for ${label}`);
      },
      now() {
        const observedAt = fakeNowMs;
        fakeNowMs += 100;
        return observedAt;
      },
      monotonicNow() {
        const observedAt = fakeMonotonicMs;
        fakeMonotonicMs += 100;
        return observedAt;
      },
      async invokeOk(page, command, args) {
        assert.equal(
          page.phase.endsWith("open") || page.phase.endsWith("restart"),
          true,
        );
        if (command === "open_workspace") return { path: args.path };
        if (command === "narrative_extraction_capture_workspace_binding") {
          assert.equal(args.expectedWorkspacePath, workspace);
          return {
            authorityId: "authority-1",
            generation: 1,
            authorityInstanceId: "1",
          };
        }
        assert.equal(command, "db_execute");
        if (args.method === "all") {
          selectCalls.push(args);
          const snapshotMatch = args.sql.match(
            /^SELECT \* FROM "([^"]+)" ORDER BY .+$/,
          );
          if (snapshotMatch) {
            return {
              rows: mutableSnapshots[snapshotMatch[1]].map((row) => ({
                ...row,
              })),
            };
          }
          assert.ok(settlementQueries.has(args.sql), args.sql);
          if (args.sql === C2ZC_RENDERER_DURABLE_SETTLEMENT_QUERIES.projects) {
            return { rows: ledgerProjects };
          }
          if (args.sql === C2ZC_RENDERER_DURABLE_SETTLEMENT_QUERIES.feed) {
            return { rows: [{ projectId: "background-project", feedHead: 1 }] };
          }
          if (
            args.sql ===
            C2ZC_RENDERER_DURABLE_SETTLEMENT_QUERIES.freshnessCursors
          ) {
            return {
              rows: [
                {
                  projectId: "background-project",
                  consumerId: "narrative-incremental-freshness/v1",
                  acknowledgedThrough: 1,
                  semanticEpochId: null,
                  activeRunId: null,
                  reservedThrough: null,
                  leaseOwner: null,
                  leaseExpiresAt: null,
                  lastError: null,
                },
              ],
            };
          }
          if (
            args.sql === C2ZC_RENDERER_DURABLE_SETTLEMENT_QUERIES.activeRuns
          ) {
            return {
              rows: activeMaintenance
                ? [
                    {
                      id: "background-run",
                      projectId: "background-project",
                      runKind: "freshness-evaluation",
                      status: "running",
                      startedAt: "2026-08-28T00:00:00.000Z",
                    },
                  ]
                : [],
            };
          }
          if (args.sql === C2ZC_RENDERER_DURABLE_SETTLEMENT_QUERIES.epochs) {
            return { rows: ledgerEpochs };
          }
          if (
            args.sql === C2ZC_RENDERER_DURABLE_SETTLEMENT_QUERIES.terminalRuns
          ) {
            return { rows: ledgerRuns };
          }
          if (args.sql === C2ZC_RENDERER_DURABLE_SETTLEMENT_QUERIES.tasks) {
            return { rows: ledgerTasks };
          }
          if (args.sql === C2ZC_RENDERER_DURABLE_SETTLEMENT_QUERIES.attempts) {
            return { rows: ledgerAttempts };
          }
          if (
            args.sql ===
            C2ZC_RENDERER_DURABLE_SETTLEMENT_QUERIES.freshnessEvidence
          ) {
            return { rows: ledgerFreshnessEvidence };
          }
          return { rows: [] };
        }
        dmlCalls.push(args);
        throw new Error(
          "db_execute rejected: " +
            "PROTECTED_WRITER_SQL: denied mutation of protected narrative table",
        );
      },
    };

    const result = await runC2ZcRendererMcpDmlDenialJourney(harness);
    assert.equal(result.rendererDenials, 36);
    assert.equal(result.protectedTableCount, 9);
    assert.equal(backgroundMutationInjected, true);
    assert.ok(waitUntilRetries > 0);
    assert.equal(
      result.settledEvidence.evidenceVersion,
      C2ZC_RENDERER_DML_EVIDENCE_VERSION,
    );
    assert.equal(result.settledEvidence.kind, C2ZC_RENDERER_DML_TIMELINE_EVENT);
    assert.equal(result.settledEvidence.settled, true);
    assert.equal(result.settledEvidence.probeCount, 36);
    assert.equal("secondaryConnectionProof" in result, false);
    assert.equal("quiescenceArtifacts" in result, false);
    assert.equal(result.settledEvidence.openingSettlement.settled, true);
    assert.equal(result.settledEvidence.finalSettlement.settled, true);
    for (const field of [
      "startAt",
      "endAt",
      "durationMs",
      "stableSampleCount",
      "fingerprint",
      "terminalLedger",
    ]) {
      assert.ok(
        result.settledEvidence[field] !== undefined,
        `settled receipt must include ${field}`,
      );
    }
    assert.ok(result.settledEvidence.durationMs >= 500);
    assert.ok(result.settledEvidence.stableSampleCount >= 2);
    assert.deepEqual(result.settledEvidence.finalSettlement.feedAndCursor, {
      feed: [{ projectId: "background-project", feedHead: 1 }],
      cursors: [
        {
          projectId: "background-project",
          consumerId: "narrative-incremental-freshness/v1",
          acknowledgedThrough: 1,
          semanticEpochId: null,
          activeRunId: null,
          reservedThrough: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
        },
      ],
      mismatches: [],
      consistent: true,
    });
    assert.equal(result.settledEvidence.probes.length, 36);
    assert.ok(
      result.settledEvidence.probes.every(
        (probe) =>
          probe.unchanged &&
          probe.denial ===
            "PROTECTED_WRITER_SQL: denied mutation of protected narrative table" &&
          JSON.stringify(probe.beforeSnapshot) ===
            JSON.stringify(probe.afterSnapshot) &&
          JSON.stringify(probe.afterSnapshot) ===
            JSON.stringify(probe.settledAfterSnapshot) &&
          JSON.stringify(probe.beforeSnapshot[probe.table]) ===
            JSON.stringify(probe.afterSnapshot[probe.table]) &&
          probe.snapshotUnchanged &&
          !probe.backgroundWriterDetected &&
          probe.beforeSettlement.settled &&
          probe.afterSettlement.settled,
      ),
    );
    assert.equal(result.settledEvidence.finalSettlement.settled, true);
    assert.deepEqual(result.settledEvidence.finalSettlement.active, {
      runs: [],
      tasks: [],
      attempts: [],
      reservations: [],
      repairLeases: [],
      pendingWakeOutbox: [],
    });
    assert.deepEqual(
      result.settledEvidence.finalSnapshot.narrative_semantic_epochs,
      [{ id: "legitimate-background-write" }],
    );
    assert.deepEqual(
      Object.keys(result.settledEvidence.finalSnapshot),
      C2ZC_NATIVE_OWNED_TABLE_NAMES,
    );
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].event, C2ZC_RENDERER_DML_TIMELINE_EVENT);
    assert.deepEqual(timeline[0].details.evidence, result.settledEvidence);

    const snapshotCalls = selectCalls.filter((call) =>
      /^SELECT \* FROM "[^"]+" ORDER BY .+$/.test(call.sql),
    );
    assert.equal(snapshotCalls.length, 990);
    const selectsByTable = new Map();
    for (const call of snapshotCalls) {
      assert.deepEqual(call.params, []);
      assert.equal(call.method, "all");
      const match = call.sql.match(/^SELECT \* FROM "([^"]+)" ORDER BY .+$/);
      assert.ok(match, call.sql);
      const calls = selectsByTable.get(match[1]) ?? [];
      calls.push(call);
      selectsByTable.set(match[1], calls);
    }
    assert.deepEqual([...selectsByTable.keys()], C2ZC_NATIVE_OWNED_TABLE_NAMES);
    for (const table of C2ZC_NATIVE_OWNED_TABLE_NAMES) {
      assert.equal(selectsByTable.get(table)?.length, 110, table);
    }
    const settlementCalls = selectCalls.filter((call) =>
      settlementQueries.has(call.sql),
    );
    assert.ok(
      settlementCalls.length >=
        Object.keys(C2ZC_RENDERER_DURABLE_SETTLEMENT_QUERIES).length,
    );
    assert.ok(
      selectCalls.every(
        (call) =>
          call.method === "all" &&
          Array.isArray(call.params) &&
          call.params.length === 0,
      ),
    );
    assert.equal(dmlCalls.length, 36);
    for (const table of C2ZC_RENDERER_TABLE_CONTRACTS) {
      const tableCalls = dmlCalls.filter((call) =>
        call.sql.includes(`"${table.name}"`),
      );
      assert.equal(tableCalls.length, 4, table.name);
      assert.deepEqual(
        tableCalls.map((call) => call.params),
        [[1], [1], [1], [1]],
      );
      assert.ok(tableCalls.every((call) => call.method === "run"));
      for (const operation of ["INSERT", "UPDATE", "DELETE", "REPLACE"]) {
        assert.ok(
          tableCalls.some((call) => call.sql.startsWith(`${operation} `)),
          `${operation} ${table.name}`,
        );
      }
    }
    assert.deepEqual(events, [
      `launch:${C2ZC_RENDERER_MCP_DML_DENIAL_PHASES[0]}`,
      `close:${C2ZC_RENDERER_MCP_DML_DENIAL_PHASES[0]}`,
      `launch:${C2ZC_RENDERER_MCP_DML_DENIAL_PHASES[1]}`,
      `close:${C2ZC_RENDERER_MCP_DML_DENIAL_PHASES[1]}`,
    ]);
    assert.equal(rendererOpen, false);
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("renderer denial journey stays outside fixture seam and production IPC/preload", async () => {
  const journeySource = await readRepo(
    "electron/scripts/c2zc-renderer-mcp-dml-denial-product-journey.mjs",
  );
  const harnessSource = await readRepo(
    "electron/scripts/product-journey-harness.mjs",
  );
  assert.match(journeySource, /db_execute/);
  assert.doesNotMatch(journeySource, /db_execute_batch/);
  assert.doesNotMatch(journeySource, /executeFixtureDml/);
  assert.doesNotMatch(journeySource, /app_settings/);
  assert.doesNotMatch(journeySource, /C2ZC_FIXTURE_DML_CONTRACT/);
  assert.match(journeySource, /waitForRendererDurableSettlement/);
  assert.match(journeySource, /recordTimeline/);
  assert.doesNotMatch(journeySource, /scheduler.*(?:disable|disabled|off)/i);
  assert.doesNotMatch(journeySource, /(?:disable|disabled|off).*scheduler/i);
  for (const [name, sql] of Object.entries(
    C2ZC_RENDERER_DURABLE_SETTLEMENT_QUERIES,
  )) {
    assert.match(sql, /^\s*SELECT\b/i, name);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i, name);
  }
  assert.match(
    C2ZC_RENDERER_DURABLE_SETTLEMENT_QUERIES.activeRuns,
    /run_kind <> 'interpretation'/,
  );
  assert.match(
    C2ZC_RENDERER_DURABLE_SETTLEMENT_QUERIES.reservations,
    /reserved_through_sequence/,
  );
  assert.match(
    C2ZC_RENDERER_DURABLE_SETTLEMENT_QUERIES.repairLeases,
    /narrative_maintenance_repair_leases/,
  );
  assert.match(harnessSource, /C2ZC_RENDERER_DML_PHASE_ALLOWLIST/);
  const productionSources = await Promise.all(
    [
      "electron/main/index.ts",
      "electron/preload/index.ts",
      "electron/shared/ipcContract.ts",
      "electron/scripts/build.mjs",
    ].map(readRepo),
  );
  for (const source of productionSources) {
    assert.doesNotMatch(source, /executeFixtureDml/);
    assert.doesNotMatch(source, /c2-zc-renderer-mcp-dml-denial/);
  }
});

test("McpGeneric remains a Rust-only canonical regression because MCP exposes no generic SQL tool", async () => {
  assert.equal(C2ZC_MCP_GENERIC_SQL_CONTRACT.productionToolName, null);
  assert.equal(C2ZC_MCP_GENERIC_SQL_CONTRACT.productionRoute, null);
  assert.equal(C2ZC_MCP_GENERIC_SQL_CONTRACT.status, "not-exposed");

  const [mcpServer, executeSource] = await Promise.all([
    readRepo("src-tauri/crates/grimodex-mcp/src/server.rs"),
    readRepo("src-tauri/crates/grimodex-db/src/execute.rs"),
  ]);
  assert.doesNotMatch(mcpServer, /async fn\s+\w*(?:sql|execute)\w*\s*\(/i);
  assert.doesNotMatch(mcpServer, /SqlOrigin::McpGeneric/);
  assert.match(executeSource, /SqlOrigin::McpGeneric/);
  assert.match(
    executeSource,
    /fn c2zc_native_owned_tables_reject_all_untrusted_dml_but_allow_reads_and_trusted_writes\(\)/,
  );
  assert.match(executeSource, /PROTECTED_WRITER_SQL_ERROR/);
  for (const operation of ["INSERT", "UPDATE", "DELETE", "REPLACE"]) {
    assert.match(executeSource, new RegExp(`"${operation.toLowerCase()}"`));
  }
});
