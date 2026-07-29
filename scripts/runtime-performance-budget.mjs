#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_PERFORMANCE_FIXTURE,
  buildRuntimePerformanceFixtureForReview,
  measureRuntimeEditorSerializedBytesAfterInput,
} from "../electron/scripts/runtime-performance-fixture.mjs";
import { APP_MEMORY_MEASUREMENT_BY_PLATFORM } from "../electron/scripts/process-memory.mjs";

const BASE_RUNTIME_BUDGETS = Object.freeze({
  coldStartMs: 4_000,
  projectOpenMs: 3_000,
  editorInputP95Ms: 8,
  autosaveDeriveSnapshotCpuMs: 50,
  autosaveInvokeSaveWallMs: 250,
  autosaveDomainIpcCount: 1,
  autosaveDbTransactionCount: 1,
  startupMemoryBytes: 1_000_000_000,
  peakMemoryBytes: 2_500_000_000,
  mapPeakMemoryBytes: 2_500_000_000,
  timelinePeakMemoryBytes: 2_500_000_000,
  linearPeakMemoryBytes: 2_500_000_000,
  chatPeakMemoryBytes: 2_500_000_000,
  longTaskCount: 2,
  longTaskMaxMs: 75,
  treeFilterLongTaskCount: 0,
  treeFilterLongTaskMaxMs: 50,
  linearMaxVisibleRects: 64,
  chatMaxRenderedRows: 64,
  chatDraftMessageRenderCount: 1,
  linearSceneRectReads: 0,
  interactionFrameMinimumSamples: 120,
  interactionWorkFrameMinimumSamples: 120,
  interactionWorkCoverageMinimum: 0.9,
  interactionFrameMeanMs: 17.5,
  interactionFrameP95Ms: 17.5,
  interactionFrameCatastrophicMaxMs: 50.1,
  interactionGestureLongTaskCount: 0,
  interactionGestureLongTaskMaxMs: 50.1,
  timelineDragStartRenderMaxMs: 50.1,
});

export const RUNTIME_AUTOSAVE_SERIALIZATION_OVERHEAD = Object.freeze({
  fixedBytes: 1_024,
  ratio: 0.02,
});

export function buildRuntimeBudgets(fixture = RUNTIME_PERFORMANCE_FIXTURE) {
  const reviewCardinality = fixture.reviewCardinalityJson
    ? JSON.parse(fixture.reviewCardinalityJson)
    : null;
  const treeScale =
    fixture.reviewScenario === "treeGrid"
      ? reviewCardinality.nodeCount
      : fixture.collectionSceneCount;
  const autosaveSerializeExpectedBytes =
    measureRuntimeEditorSerializedBytesAfterInput(fixture);
  const autosaveSerializeOverheadBytes =
    RUNTIME_AUTOSAVE_SERIALIZATION_OVERHEAD.fixedBytes +
    Math.ceil(
      autosaveSerializeExpectedBytes *
        RUNTIME_AUTOSAVE_SERIALIZATION_OVERHEAD.ratio,
    );
  return Object.freeze({
    ...BASE_RUNTIME_BUDGETS,
    autosaveSerializeExpectedBytes,
    autosaveSerializeOverheadBytes,
    // The expected value is the actual seeded JSON after PERF_INPUT_TEXT.
    // A small bounded allowance prevents a legitimate schema mark or wrapper
    // from false-failing while remaining far below a second serialization.
    autosaveSerializeBytes:
      autosaveSerializeExpectedBytes + autosaveSerializeOverheadBytes,
    // Tree derivation can visit the selected seed plus a small fixed set of
    // support/smoke rows, twice (filter + visibility projection).
    treeFilterMaxNodesVisited: (treeScale + 4) * 2,
  });
}

export const DEFAULT_RUNTIME_BUDGETS = buildRuntimeBudgets();

/**
 * Expected rows after the fixture seed has committed to SQLite.
 *
 * These values intentionally include support rows (the primary editor scene
 * and fixture folder), unlike the higher-level profile fields that describe
 * only the generated collection.
 */
export function buildExpectedRuntimeActualCardinality(
  fixture = RUNTIME_PERFORMANCE_FIXTURE,
) {
  return Object.freeze({
    textChars: fixture.seededTextChars,
    beatCount: fixture.seededBeatCount,
    treeNodeCount: fixture.collectionSceneCount + 2,
    sceneCount: fixture.collectionSceneCount + 1,
    threadCount: fixture.timelineThreadCount,
    markerLinkCount: fixture.timelineMarkerLinkCount,
    eventCount: fixture.chronicleEventCount,
    mapNodeCount: fixture.mapNodeCount,
    mapEdgeCount: fixture.mapEdgeCount,
    chatSessionCount: fixture.chatSessionId == null ? 0 : 1,
    chatMessageCount: fixture.chatMessageCount,
  });
}

const REVIEW_ACTUAL_CARDINALITY_FIELDS = Object.freeze({
  editor: Object.freeze({ textChars: "textChars" }),
  beatEditor: Object.freeze({ beatCount: "beatCount" }),
  treeGrid: Object.freeze({ nodeCount: "treeNodeCount" }),
  linear: Object.freeze({ sceneCount: "sceneCount" }),
  chat: Object.freeze({ messageCount: "chatMessageCount" }),
  timeline: Object.freeze({
    sceneCount: "sceneCount",
    threadCount: "threadCount",
    markerLinkCount: "markerLinkCount",
  }),
  chronicle: Object.freeze({ eventCount: "eventCount" }),
  map: Object.freeze({
    nodeCount: "mapNodeCount",
    edgeCount: "mapEdgeCount",
  }),
});

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function summarizeMemoryProcessEvidence(processes) {
  if (!Array.isArray(processes) || processes.length === 0) {
    return {
      valid: false,
      processCount: Array.isArray(processes) ? processes.length : null,
      fallbackProcessCount: null,
      measuredBytes: null,
    };
  }
  const pids = new Set();
  let measuredBytes = 0;
  let fallbackProcessCount = 0;
  let valid = true;
  for (const entry of processes) {
    const pid = entry?.pid;
    const source = entry?.source;
    const isFallback =
      typeof source === "string" && source.endsWith("fallback");
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      pids.has(pid) ||
      !finite(entry?.measuredBytes) ||
      entry.measuredBytes < 0 ||
      !finite(entry?.workingSetBytes) ||
      entry.workingSetBytes < 0 ||
      typeof source !== "string" ||
      source.length === 0 ||
      (isFallback
        ? typeof entry?.fallbackReason !== "string" ||
          entry.fallbackReason.length === 0
        : entry?.fallbackReason !== null)
    ) {
      valid = false;
    }
    pids.add(pid);
    if (finite(entry?.measuredBytes)) measuredBytes += entry.measuredBytes;
    if (isFallback) fallbackProcessCount += 1;
  }
  return {
    valid: valid && measuredBytes > 0,
    processCount: processes.length,
    fallbackProcessCount,
    measuredBytes,
  };
}

function findMark(perfSession, label) {
  return perfSession?.markStats?.find((entry) => entry.label === label) ?? null;
}

/**
 * Build autosave metrics without inferring logical operation counts from timing
 * marks. A mark measures elapsed work and may legitimately occur more than once;
 * the domain IPC / DB transaction counters are the canonical cardinality.
 */
export function extractAutosaveMetrics(perfSession) {
  const deriveSnapshot = findMark(
    perfSession,
    "editor.coreSave.deriveSnapshot",
  );
  const invokeSave = findMark(perfSession, "editor.coreSave.invokeSave");
  const serializeBytes =
    perfSession?.counters?.["editor.coreSave.serializeBytes"] ?? null;
  const domainIpcCount =
    perfSession?.counters?.["editor.coreSave.domainIpc"] ?? null;
  const dbTransactionCount =
    perfSession?.counters?.["editor.coreSave.dbTransaction"] ?? null;

  if (
    !deriveSnapshot ||
    !invokeSave ||
    !finite(serializeBytes) ||
    serializeBytes <= 0 ||
    !finite(domainIpcCount) ||
    !finite(dbTransactionCount)
  ) {
    return null;
  }

  return {
    deriveSnapshotCpuMs: deriveSnapshot.totalMs,
    invokeSaveWallMs: invokeSave.totalMs,
    serializeBytes,
    domainIpcCount,
    dbTransactionCount,
  };
}

/**
 * A frame measurement is usable only when the deterministic counter and the
 * duration mark agree that the instrumented rAF path actually ran.
 */
export function extractInteractionFrameMetrics(
  perfSession,
  intervalLabel,
  workLabel,
) {
  const frame = findMark(perfSession, intervalLabel);
  const workFrame = findMark(perfSession, workLabel);
  const frameCount = perfSession?.counters?.[`${intervalLabel}.count`] ?? null;
  const workFrameCount = perfSession?.counters?.[`${workLabel}.count`] ?? null;
  if (
    !frame ||
    !workFrame ||
    !finite(frame.count) ||
    !finite(frame.totalMs) ||
    !finite(frame.p50Ms) ||
    !finite(frame.p95Ms) ||
    !finite(frame.maxMs) ||
    !finite(frameCount) ||
    !finite(workFrame.count) ||
    !finite(workFrameCount) ||
    frameCount < 1 ||
    workFrameCount < 1 ||
    frame.count !== frameCount ||
    workFrame.count !== workFrameCount
  ) {
    return null;
  }
  return {
    frameCount,
    workFrameCount,
    // The first work callback is the interval anchor and can make work count
    // one larger than duration count. Keep the reported participation ratio
    // bounded while still rejecting idle-clock dilution below.
    workCoverage: workFrameCount / Math.max(frameCount, workFrameCount),
    p50FrameMs: frame.p50Ms,
    p95FrameMs: frame.p95Ms,
    meanFrameMs: frame.totalMs / frame.count,
    maxFrameMs: frame.maxMs,
  };
}

export function evaluateRuntimePerformance(
  metrics,
  budgets = DEFAULT_RUNTIME_BUDGETS,
  expectedFixture = RUNTIME_PERFORMANCE_FIXTURE,
) {
  const requires = (scenario) =>
    expectedFixture.reviewScenario === null ||
    expectedFixture.reviewScenario === scenario;
  const exactCheckInputs = [
    ["fixture.id", metrics.fixture?.id, expectedFixture.id],
    [
      "fixture.reviewFixtureId",
      metrics.fixture?.reviewFixtureId,
      expectedFixture.reviewFixtureId,
    ],
    [
      "fixture.reviewScenario",
      metrics.fixture?.reviewScenario,
      expectedFixture.reviewScenario,
    ],
    [
      "fixture.reviewCardinalityJson",
      metrics.fixture?.reviewCardinalityJson,
      expectedFixture.reviewCardinalityJson,
    ],
    ["fixture.sceneId", metrics.fixture?.sceneId, expectedFixture.sceneId],
    [
      "fixture.seededTextChars",
      metrics.fixture?.seededTextChars,
      expectedFixture.seededTextChars,
    ],
    [
      "fixture.seededBeatCount",
      metrics.fixture?.seededBeatCount,
      expectedFixture.seededBeatCount,
    ],
    [
      "fixture.collectionSceneCount",
      metrics.fixture?.collectionSceneCount,
      expectedFixture.collectionSceneCount,
    ],
    [
      "fixture.timelineThreadCount",
      metrics.fixture?.timelineThreadCount,
      expectedFixture.timelineThreadCount,
    ],
    [
      "fixture.timelineMarkerLinkCount",
      metrics.fixture?.timelineMarkerLinkCount,
      expectedFixture.timelineMarkerLinkCount,
    ],
    [
      "fixture.chronicleEventCount",
      metrics.fixture?.chronicleEventCount,
      expectedFixture.chronicleEventCount,
    ],
    [
      "fixture.mapNodeCount",
      metrics.fixture?.mapNodeCount,
      expectedFixture.mapNodeCount,
    ],
    [
      "fixture.mapEdgeCount",
      metrics.fixture?.mapEdgeCount,
      expectedFixture.mapEdgeCount,
    ],
    [
      "fixture.chatMessageCount",
      metrics.fixture?.chatMessageCount,
      expectedFixture.chatMessageCount,
    ],
    [
      "fixture.chatSessionId",
      metrics.fixture?.chatSessionId,
      expectedFixture.chatSessionId,
    ],
    [
      "fixture.editorInputSceneId",
      metrics.fixture?.editorInputSceneId,
      expectedFixture.sceneId,
    ],
    [
      "fixture.autosaveSceneId",
      metrics.fixture?.autosaveSceneId,
      expectedFixture.sceneId,
    ],
    [
      "fixture.editorInputTargetVerified",
      metrics.fixture?.editorInputTargetVerified,
      true,
    ],
    [
      "fixture.editorInputParagraphCharsBefore",
      metrics.fixture?.editorInputParagraphCharsBefore,
      expectedFixture.inputAnchorText.length,
    ],
    [
      "autosave.domainIpcCount",
      metrics.autosave?.domainIpcCount,
      budgets.autosaveDomainIpcCount,
    ],
    [
      "autosave.dbTransactionCount",
      metrics.autosave?.dbTransactionCount,
      budgets.autosaveDbTransactionCount,
    ],
  ];
  const memoryPlatform = metrics.memory?.platform;
  const expectedMemoryMeasurement =
    APP_MEMORY_MEASUREMENT_BY_PLATFORM[memoryPlatform] ?? null;
  const startupMemoryEvidence = summarizeMemoryProcessEvidence(
    metrics.memory?.startupProcesses,
  );
  const peakMemoryEvidence = summarizeMemoryProcessEvidence(
    metrics.memory?.peakProcesses,
  );
  exactCheckInputs.push(
    ["memory.platformSupported", expectedMemoryMeasurement !== null, true],
    [
      "memory.measurement",
      metrics.memory?.measurement,
      expectedMemoryMeasurement,
    ],
    ["memory.startupProcesses", startupMemoryEvidence.valid, true],
    [
      "memory.startupProcessCount",
      metrics.memory?.startupProcessCount,
      startupMemoryEvidence.processCount,
    ],
    [
      "memory.startupFallbackProcessCount",
      metrics.memory?.startupFallbackProcessCount,
      startupMemoryEvidence.fallbackProcessCount,
    ],
    [
      "memory.startupBytesEvidence",
      metrics.memory?.startupBytes,
      startupMemoryEvidence.measuredBytes,
    ],
    ["memory.peakProcesses", peakMemoryEvidence.valid, true],
    [
      "memory.peakProcessCount",
      metrics.memory?.peakProcessCount,
      peakMemoryEvidence.processCount,
    ],
    [
      "memory.peakFallbackProcessCount",
      metrics.memory?.peakFallbackProcessCount,
      peakMemoryEvidence.fallbackProcessCount,
    ],
    [
      "memory.peakBytesEvidence",
      metrics.memory?.peakBytes,
      peakMemoryEvidence.measuredBytes,
    ],
  );
  const actualCardinality = metrics.fixture?.actualCardinality;
  const expectedActualCardinality =
    buildExpectedRuntimeActualCardinality(expectedFixture);
  for (const [field, expected] of Object.entries(expectedActualCardinality)) {
    exactCheckInputs.push([
      `fixture.actualCardinality.${field}`,
      actualCardinality?.[field],
      expected,
    ]);
  }
  if (expectedFixture.reviewScenario !== null) {
    const reviewCardinality = JSON.parse(expectedFixture.reviewCardinalityJson);
    const fieldMap =
      REVIEW_ACTUAL_CARDINALITY_FIELDS[expectedFixture.reviewScenario];
    for (const [reviewField, expected] of Object.entries(reviewCardinality)) {
      const actualField = fieldMap?.[reviewField];
      if (!actualField) {
        throw new Error(
          `unsupported runtime review cardinality field: ${expectedFixture.reviewScenario}.${reviewField}`,
        );
      }
      exactCheckInputs.push([
        `fixture.actualCardinality.selectedReview.${reviewField}`,
        actualCardinality?.[actualField],
        expected,
      ]);
    }
  }
  if (requires("treeGrid")) {
    exactCheckInputs.push([
      "interactions.treeFilter.targetVerified",
      metrics.interactions?.treeFilter?.targetVerified,
      true,
    ]);
  }
  if (requires("linear")) {
    exactCheckInputs.push(
      [
        "interactions.linearScroll.targetVerified",
        metrics.interactions?.linearScroll?.targetVerified,
        true,
      ],
      [
        "interactions.linearScroll.sceneRectReads",
        metrics.interactions?.linearScroll?.sceneRectReads,
        budgets.linearSceneRectReads,
      ],
    );
  }
  if (requires("timeline")) {
    exactCheckInputs.push([
      "interactions.timelineDrag.targetVerified",
      metrics.interactions?.timelineDrag?.targetVerified,
      true,
    ]);
  }
  if (requires("chronicle")) {
    exactCheckInputs.push([
      "interactions.chroniclePan.targetVerified",
      metrics.interactions?.chroniclePan?.targetVerified,
      true,
    ]);
  }
  if (requires("map") && expectedFixture.mapNodeCount > 0) {
    const mapDrag = metrics.interactions?.mapDrag;
    exactCheckInputs.push(
      ["interactions.mapDrag.targetVerified", mapDrag?.targetVerified, true],
      [
        "interactions.mapDrag.persistedPositionVerified",
        typeof mapDrag?.persistedPositionId === "string" &&
          mapDrag.persistedPositionId.startsWith(
            "grimodex-runtime-perf-position-",
          ),
        true,
      ],
      [
        "interactions.mapDrag.unrelatedNodeCount",
        mapDrag?.unrelatedNodeCount,
        expectedFixture.mapNodeCount - 1,
      ],
      [
        "interactions.mapDrag.targetNodeObjectIdentityChanged",
        mapDrag?.targetNodeObjectIdentityChanged,
        true,
      ],
      [
        "interactions.mapDrag.unrelatedNodeObjectIdentityChanges",
        mapDrag?.unrelatedNodeObjectIdentityChanges,
        0,
      ],
      [
        "interactions.mapDrag.unrelatedNodeRenderCount",
        mapDrag?.unrelatedNodeRenderCount,
        0,
      ],
      [
        "interactions.mapDrag.unrelatedRenderedNodeCount",
        mapDrag?.unrelatedRenderedNodeCount,
        0,
      ],
      [
        "interactions.mapDrag.unrelatedDomIdentityChanges",
        mapDrag?.unrelatedDomIdentityChanges,
        0,
      ],
      [
        "interactions.mapDrag.unrelatedTransformChanges",
        mapDrag?.unrelatedTransformChanges,
        0,
      ],
      [
        "interactions.mapDrag.unrelatedChildListReplacements",
        mapDrag?.unrelatedChildListReplacements,
        0,
      ],
      [
        "interactions.mapDrag.unrelatedAttributeMutations",
        mapDrag?.unrelatedAttributeMutations,
        0,
      ],
    );
  }
  if (requires("chat") && expectedFixture.chatMessageCount > 0) {
    exactCheckInputs.push(
      [
        "interactions.chatScroll.targetVerified",
        metrics.interactions?.chatScroll?.targetVerified,
        true,
      ],
      [
        "interactions.chatScroll.messageCount",
        metrics.interactions?.chatScroll?.messageCount,
        expectedFixture.chatMessageCount,
      ],
      [
        "interactions.chatDraft.targetVerified",
        metrics.interactions?.chatDraft?.targetVerified,
        true,
      ],
      [
        "interactions.chatDraft.headerCommitCount",
        metrics.interactions?.chatDraft?.headerCommitCount,
        0,
      ],
      [
        "interactions.chatDraft.contextBarCommitCount",
        metrics.interactions?.chatDraft?.contextBarCommitCount,
        0,
      ],
      [
        "interactions.chatDraft.chatPanelRenderCount",
        metrics.interactions?.chatDraft?.chatPanelRenderCount,
        0,
      ],
      [
        "interactions.chatDraft.chatMessageRenderCount",
        metrics.interactions?.chatDraft?.chatMessageRenderCount,
        budgets.chatDraftMessageRenderCount,
      ],
    );
  }
  const exactChecks = exactCheckInputs.map(([name, actual, expected]) => ({
    name,
    actual,
    expected,
    ok: actual === expected,
    missing: actual == null && expected != null,
  }));
  const budgetCheckInputs = [
    ["coldStartMs", metrics.coldStartMs, budgets.coldStartMs],
    ["projectOpenMs", metrics.projectOpenMs, budgets.projectOpenMs],
    ["editorInput.p95Ms", metrics.editorInput?.p95Ms, budgets.editorInputP95Ms],
    [
      "autosave.deriveSnapshotCpuMs",
      metrics.autosave?.deriveSnapshotCpuMs,
      budgets.autosaveDeriveSnapshotCpuMs,
    ],
    [
      "autosave.invokeSaveWallMs",
      metrics.autosave?.invokeSaveWallMs,
      budgets.autosaveInvokeSaveWallMs,
    ],
    [
      "autosave.serializeBytes",
      metrics.autosave?.serializeBytes,
      budgets.autosaveSerializeBytes,
    ],
    [
      "memory.startupBytes",
      metrics.memory?.startupBytes,
      budgets.startupMemoryBytes,
    ],
    ["memory.peakBytes", metrics.memory?.peakBytes, budgets.peakMemoryBytes],
    ["longTask.count", metrics.longTask?.count, budgets.longTaskCount],
    ["longTask.maxMs", metrics.longTask?.maxMs, budgets.longTaskMaxMs],
  ];
  if (requires("map")) {
    budgetCheckInputs.push([
      "memory.peakByViewBytes.map",
      metrics.memory?.peakByViewBytes?.map,
      budgets.mapPeakMemoryBytes,
    ]);
  }
  if (requires("timeline")) {
    budgetCheckInputs.push(
      [
        "memory.peakByViewBytes.timeline",
        metrics.memory?.peakByViewBytes?.timeline,
        budgets.timelinePeakMemoryBytes,
      ],
      [
        "interactions.timelineDrag.p95FrameMs",
        metrics.interactions?.timelineDrag?.p95FrameMs,
        budgets.interactionFrameP95Ms,
      ],
      [
        "interactions.timelineDrag.meanFrameMs",
        metrics.interactions?.timelineDrag?.meanFrameMs,
        budgets.interactionFrameMeanMs,
      ],
      [
        "interactions.timelineDrag.maxFrameMs",
        metrics.interactions?.timelineDrag?.maxFrameMs,
        budgets.interactionFrameCatastrophicMaxMs,
      ],
      [
        "interactions.timelineDrag.gestureLongTaskCount",
        metrics.interactions?.timelineDrag?.gestureLongTaskCount,
        budgets.interactionGestureLongTaskCount,
      ],
      [
        "interactions.timelineDrag.gestureLongTaskMaxMs",
        metrics.interactions?.timelineDrag?.gestureLongTaskMaxMs,
        budgets.interactionGestureLongTaskMaxMs,
      ],
      [
        "interactions.timelineDrag.dragStartRenderMaxMs",
        metrics.interactions?.timelineDrag?.dragStartRenderMaxMs,
        budgets.timelineDragStartRenderMaxMs,
      ],
    );
  }
  if (requires("linear")) {
    budgetCheckInputs.push(
      [
        "memory.peakByViewBytes.linear",
        metrics.memory?.peakByViewBytes?.linear,
        budgets.linearPeakMemoryBytes,
      ],
      [
        "interactions.linearScroll.maxVisibleRects",
        metrics.interactions?.linearScroll?.maxVisibleRects,
        budgets.linearMaxVisibleRects,
      ],
    );
  }
  if (requires("treeGrid")) {
    budgetCheckInputs.push(
      [
        "interactions.treeFilter.longTaskCount",
        metrics.interactions?.treeFilter?.longTaskCount,
        budgets.treeFilterLongTaskCount,
      ],
      [
        "interactions.treeFilter.longTaskMaxMs",
        metrics.interactions?.treeFilter?.longTaskMaxMs,
        budgets.treeFilterLongTaskMaxMs,
      ],
      [
        "interactions.treeFilter.maxNodesVisited",
        metrics.interactions?.treeFilter?.maxNodesVisited,
        budgets.treeFilterMaxNodesVisited,
      ],
    );
  }
  if (requires("chronicle")) {
    budgetCheckInputs.push(
      [
        "interactions.chroniclePan.p95FrameMs",
        metrics.interactions?.chroniclePan?.p95FrameMs,
        budgets.interactionFrameP95Ms,
      ],
      [
        "interactions.chroniclePan.meanFrameMs",
        metrics.interactions?.chroniclePan?.meanFrameMs,
        budgets.interactionFrameMeanMs,
      ],
      [
        "interactions.chroniclePan.maxFrameMs",
        metrics.interactions?.chroniclePan?.maxFrameMs,
        budgets.interactionFrameCatastrophicMaxMs,
      ],
      [
        "interactions.chroniclePan.gestureLongTaskCount",
        metrics.interactions?.chroniclePan?.gestureLongTaskCount,
        budgets.interactionGestureLongTaskCount,
      ],
      [
        "interactions.chroniclePan.gestureLongTaskMaxMs",
        metrics.interactions?.chroniclePan?.gestureLongTaskMaxMs,
        budgets.interactionGestureLongTaskMaxMs,
      ],
    );
  }
  if (requires("chat") && expectedFixture.chatMessageCount > 0) {
    budgetCheckInputs.push([
      "interactions.chatScroll.renderedRows",
      metrics.interactions?.chatScroll?.renderedRows,
      budgets.chatMaxRenderedRows,
    ]);
    budgetCheckInputs.push([
      "memory.peakByViewBytes.chat",
      metrics.memory?.peakByViewBytes?.chat,
      budgets.chatPeakMemoryBytes,
    ]);
  }
  const budgetChecks = budgetCheckInputs.map(([name, actual, max]) => ({
    name,
    actual,
    max,
    ok: finite(actual) && actual <= max,
    missing: !finite(actual),
  }));
  const minimumCheckInputs = [];
  if (requires("treeGrid")) {
    minimumCheckInputs.push([
      "interactions.treeFilter.derivationCount",
      metrics.interactions?.treeFilter?.derivationCount,
      1,
    ]);
  }
  if (requires("linear")) {
    minimumCheckInputs.push(
      [
        "interactions.linearScroll.renderedRows",
        metrics.interactions?.linearScroll?.renderedRows,
        1,
      ],
      [
        "interactions.linearScroll.detectionCount",
        metrics.interactions?.linearScroll?.detectionCount,
        1,
      ],
      [
        "interactions.linearScroll.maxVisibleRectsObserved",
        metrics.interactions?.linearScroll?.maxVisibleRects,
        1,
      ],
      [
        "interactions.linearScroll.containerRectReads",
        metrics.interactions?.linearScroll?.containerRectReads,
        1,
      ],
    );
  }
  if (requires("timeline")) {
    minimumCheckInputs.push(
      [
        "interactions.timelineDrag.frameCount",
        metrics.interactions?.timelineDrag?.frameCount,
        budgets.interactionFrameMinimumSamples,
      ],
      [
        "interactions.timelineDrag.workFrameCount",
        metrics.interactions?.timelineDrag?.workFrameCount,
        budgets.interactionWorkFrameMinimumSamples,
      ],
      [
        "interactions.timelineDrag.workCoverage",
        metrics.interactions?.timelineDrag?.workCoverage,
        budgets.interactionWorkCoverageMinimum,
      ],
    );
  }
  if (requires("chronicle")) {
    minimumCheckInputs.push(
      [
        "interactions.chroniclePan.frameCount",
        metrics.interactions?.chroniclePan?.frameCount,
        budgets.interactionFrameMinimumSamples,
      ],
      [
        "interactions.chroniclePan.workFrameCount",
        metrics.interactions?.chroniclePan?.workFrameCount,
        budgets.interactionWorkFrameMinimumSamples,
      ],
      [
        "interactions.chroniclePan.workCoverage",
        metrics.interactions?.chroniclePan?.workCoverage,
        budgets.interactionWorkCoverageMinimum,
      ],
    );
  }
  if (requires("map") && expectedFixture.mapNodeCount > 0) {
    minimumCheckInputs.push([
      "interactions.mapDrag.targetNodeRenderCount",
      metrics.interactions?.mapDrag?.targetNodeRenderCount,
      1,
    ]);
  }
  if (requires("chat") && expectedFixture.chatMessageCount > 0) {
    minimumCheckInputs.push([
      "interactions.chatScroll.virtualHeight",
      metrics.interactions?.chatScroll?.virtualHeight,
      1,
    ]);
  }
  const minimumChecks = minimumCheckInputs.map(([name, actual, min]) => ({
    name,
    actual,
    min,
    ok: finite(actual) && actual >= min,
    missing: !finite(actual),
  }));
  const checks = [...exactChecks, ...budgetChecks, ...minimumChecks];
  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

export function formatRuntimeBudgetReport(result) {
  return result.checks
    .map((check) => {
      const status = check.ok ? "PASS" : "FAIL";
      const actual = check.missing ? "missing" : check.actual;
      const expectation =
        "expected" in check
          ? `expected ${check.expected}`
          : "min" in check
            ? `min ${check.min}`
            : `max ${check.max}`;
      return `[runtime-perf] ${status} ${check.name}: ${actual} (${expectation})`;
    })
    .join("\n");
}

export function parseRuntimeBudgetArguments(argv) {
  const metricsPath = argv[2];
  if (!metricsPath) {
    throw new Error(
      "usage: node scripts/runtime-performance-budget.mjs <metrics.json> [--review-fixture <id>]",
    );
  }
  let reviewFixtureId = null;
  for (let index = 3; index < argv.length; index += 1) {
    if (argv[index] !== "--review-fixture") {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("--review-fixture requires an exact fixture id");
    }
    buildRuntimePerformanceFixtureForReview(value);
    reviewFixtureId = value;
    index += 1;
  }
  return { metricsPath, reviewFixtureId };
}

function main(argv) {
  const { metricsPath, reviewFixtureId } = parseRuntimeBudgetArguments(argv);
  const expectedFixture =
    buildRuntimePerformanceFixtureForReview(reviewFixtureId);
  const metrics = JSON.parse(readFileSync(metricsPath, "utf8"));
  const result = evaluateRuntimePerformance(
    metrics,
    buildRuntimeBudgets(expectedFixture),
    expectedFixture,
  );
  console.log(formatRuntimeBudgetReport(result));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
