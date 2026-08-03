import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RUNTIME_BUDGETS,
  buildExpectedRuntimeActualCardinality,
  buildRuntimeBudgets,
  evaluateRuntimePerformance,
  extractAutosaveMetrics,
  extractInteractionFrameMetrics,
  formatRuntimeBudgetReport,
} from "./runtime-performance-budget.mjs";
import {
  RUNTIME_PERFORMANCE_FIXTURE,
  buildRuntimePerformanceFixtureForReview,
  buildRuntimeReviewFixturePlans,
  measureRuntimeEditorSerializedBytesAfterInput,
} from "../electron/scripts/runtime-performance-fixture.mjs";
import { appMemoryMeasurement } from "../electron/scripts/process-memory.mjs";

function passingLongTaskSample() {
  return {
    durationMs: 100,
    longtask: { count: 0, totalMs: 0, maxMs: 0 },
    longTaskEntries: [],
    slowEvent: { count: 0, p95Ms: 0, maxMs: 0 },
    topMarks: [],
    markStats: [],
    counters: {},
  };
}

function passingMetrics(fixture = RUNTIME_PERFORMANCE_FIXTURE) {
  return {
    fixture: {
      id: fixture.id,
      reviewFixtureId: fixture.reviewFixtureId,
      reviewScenario: fixture.reviewScenario,
      reviewCardinalityJson: fixture.reviewCardinalityJson,
      sceneId: fixture.sceneId,
      seededTextChars: fixture.seededTextChars,
      seededBeatCount: fixture.seededBeatCount,
      collectionSceneCount: fixture.collectionSceneCount,
      timelineThreadCount: fixture.timelineThreadCount,
      timelineMarkerLinkCount: fixture.timelineMarkerLinkCount,
      chronicleEventCount: fixture.chronicleEventCount,
      mapNodeCount: fixture.mapNodeCount,
      mapEdgeCount: fixture.mapEdgeCount,
      chatMessageCount: fixture.chatMessageCount,
      chatSessionId: fixture.chatSessionId,
      autosaveSampleSceneIds: fixture.autosaveSampleScenes.map(
        (scene) => scene.id,
      ),
      editorInputSceneId: fixture.sceneId,
      autosaveSceneId: fixture.sceneId,
      editorInputTargetVerified: true,
      editorInputParagraphCharsBefore: fixture.inputAnchorText.length,
      actualCardinality: {
        ...buildExpectedRuntimeActualCardinality(fixture),
      },
    },
    coldStartMs: 1_500,
    projectOpenMs: 900,
    editorInput: { p50Ms: 2, p95Ms: 6, p99Ms: 9 },
    autosave: {
      deriveSnapshotCpuMs: 20,
      invokeSaveWallMs: 80,
      serializeBytes: measureRuntimeEditorSerializedBytesAfterInput(fixture),
      domainIpcCount: 1,
      dbTransactionCount: 1,
    },
    memory: {
      platform: "linux",
      measurement: appMemoryMeasurement("linux"),
      startupBytes: 400_000_000,
      startupProcessCount: 1,
      startupFallbackProcessCount: 0,
      startupProcesses: [
        {
          pid: 10,
          type: "Browser",
          creationTime: 10,
          measuredBytes: 400_000_000,
          workingSetBytes: 500_000_000,
          source: "pss",
          fallbackReason: null,
        },
      ],
      peakBytes: 600_000_000,
      peakProcessCount: 1,
      peakFallbackProcessCount: 0,
      peakProcesses: [
        {
          pid: 10,
          type: "Browser",
          creationTime: 10,
          measuredBytes: 600_000_000,
          workingSetBytes: 700_000_000,
          source: "pss",
          fallbackReason: null,
        },
      ],
      peakByViewBytes: {
        map: 550_000_000,
        timeline: 560_000_000,
        linear: 570_000_000,
        chat: 580_000_000,
      },
    },
    longTask: { count: 0, maxMs: 0 },
    performanceSamples: {
      initialAutosave: Array.from({ length: 3 }, passingLongTaskSample),
      steadyStateAutosave: Array.from({ length: 3 }, passingLongTaskSample),
      postSaveDrain: Array.from({ length: 3 }, passingLongTaskSample),
    },
    interactions: {
      treeFilter: {
        targetVerified: true,
        derivationCount: 1,
        maxNodesVisited: 1_004,
        longTaskCount: 0,
        longTaskMaxMs: 0,
      },
      linearScroll: {
        targetVerified: true,
        sceneCount: RUNTIME_PERFORMANCE_FIXTURE.collectionSceneCount + 1,
        renderedRows: 12,
        detectionCount: 1,
        maxVisibleRects: 8,
        containerRectReads: 1,
        sceneRectReads: 0,
      },
      timelineDrag: {
        targetVerified: true,
        gestureLongTaskCount: 0,
        gestureLongTaskMaxMs: 0,
        dragStartRenderCount: 1,
        dragStartRenderMaxMs: 12,
        frameCount: 120,
        workFrameCount: 120,
        workCoverage: 1,
        p50FrameMs: 16.7,
        p95FrameMs: 16.8,
        meanFrameMs: 16.9775,
        maxFrameMs: 50,
      },
      chroniclePan: {
        targetVerified: true,
        gestureLongTaskCount: 0,
        gestureLongTaskMaxMs: 0,
        frameCount: 120,
        workFrameCount: 120,
        workCoverage: 1,
        p50FrameMs: 16.7,
        p95FrameMs: 16.8,
        meanFrameMs: 16.9775,
        maxFrameMs: 50,
      },
      chatScroll: {
        targetVerified: true,
        messageCount: fixture.chatMessageCount,
        renderedRows: 12,
        virtualHeight: 10_000,
      },
      chatDraft: {
        targetVerified: true,
        headerCommitCount: 0,
        contextBarCommitCount: 0,
        chatPanelRenderCount: 0,
        chatMessageRenderCount: 1,
      },
      mapDrag: {
        targetVerified: true,
        persistedPositionId: "grimodex-runtime-perf-position-0000",
        unrelatedNodeCount: Math.max(0, fixture.mapNodeCount - 1),
        targetNodeObjectIdentityChanged: true,
        targetNodeRenderCount: 1,
        unrelatedNodeObjectIdentityChanges: 0,
        unrelatedNodeRenderCount: 0,
        unrelatedRenderedNodeCount: 0,
        unrelatedDomIdentityChanges: 0,
        unrelatedTransformChanges: 0,
        unrelatedChildListReplacements: 0,
        unrelatedAttributeMutations: 0,
      },
    },
  };
}

test("runtime performance budgets accept a complete passing sample", () => {
  const result = evaluateRuntimePerformance(passingMetrics());
  assert.equal(result.ok, true);
  assert.equal(
    result.checks.every((check) => check.ok),
    true,
  );
});

test("long-task samples accept two of three at 75ms while retaining the outlier", () => {
  const metrics = passingMetrics();
  // The former single-session count cap is not meaningful after expanding the
  // same-process gate to independent samples. Completeness, target pass count,
  // and the catastrophic max own the decision instead.
  metrics.longTask.count = 99;
  metrics.performanceSamples.initialAutosave[0].longtask = {
    count: 1,
    totalMs: 84,
    maxMs: 84,
  };
  metrics.performanceSamples.initialAutosave[0].longTaskEntries = [
    {
      startTime: 10,
      duration: 84,
      overlappingMarks: [
        {
          label: "editor.autoRevision.insert",
          start: 12,
          duration: 22,
        },
      ],
      unattributedMs: 62,
    },
  ];

  const result = evaluateRuntimePerformance(metrics);

  assert.equal(result.ok, true);
  assert.equal(
    result.checks.some((check) => check.name === "longTask.count"),
    false,
  );
  assert.equal(
    result.checks.find(
      (check) =>
        check.name === "performanceSamples.initialAutosave.targetPassCount",
    )?.actual,
    2,
  );
});

test("long-task samples reject a catastrophic outlier and print attribution", () => {
  const metrics = passingMetrics();
  metrics.performanceSamples.postSaveDrain[2].longtask = {
    count: 1,
    totalMs: 91,
    maxMs: 91,
  };
  metrics.performanceSamples.postSaveDrain[2].longTaskEntries = [
    {
      startTime: 20,
      duration: 91,
      overlappingMarks: [
        {
          label: "editor.postSave.bodyMention",
          start: 24,
          duration: 41,
        },
      ],
      unattributedMs: 50,
    },
  ];

  const result = evaluateRuntimePerformance(metrics);
  const report = formatRuntimeBudgetReport(result);

  assert.equal(result.ok, false);
  assert.match(report, /FAIL longTask\.maxMs: 91ms \(postSaveDrain\)/);
  assert.match(report, /editor\.postSave\.bodyMention 41ms/);
  assert.match(report, /unattributed: 50ms/);
});

test("long-task evidence rejects an entry without attribution fields", () => {
  const metrics = passingMetrics();
  metrics.performanceSamples.initialAutosave[0].longtask = {
    count: 1,
    totalMs: 60,
    maxMs: 60,
  };
  metrics.performanceSamples.initialAutosave[0].longTaskEntries = [
    {
      startTime: 20,
      duration: 60,
    },
  ];

  const result = evaluateRuntimePerformance(metrics);

  assert.equal(result.ok, false);
  assert.equal(
    result.checks.find(
      (check) =>
        check.name ===
        "performanceSamples.initialAutosave.evidenceComplete",
    )?.actual,
    false,
  );
});

test("every focused review profile selects dynamic fixture expectations and budgets", () => {
  for (const plan of buildRuntimeReviewFixturePlans()) {
    const fixture = buildRuntimePerformanceFixtureForReview(plan.id);
    const budgets = buildRuntimeBudgets(fixture);
    const metrics = passingMetrics(fixture);
    const result = evaluateRuntimePerformance(metrics, budgets, fixture);

    assert.equal(
      result.ok,
      true,
      `${plan.id}: ${result.checks
        .filter((check) => !check.ok)
        .map((check) => check.name)
        .join(", ")}`,
    );
    assert.equal(
      result.checks.find((check) => check.name === "fixture.id")?.expected,
      plan.id,
    );
    for (const [field, expected] of Object.entries(plan.cardinality)) {
      assert.deepEqual(
        result.checks.find(
          (check) =>
            check.name === `fixture.actualCardinality.selectedReview.${field}`,
        ),
        {
          name: `fixture.actualCardinality.selectedReview.${field}`,
          actual: expected,
          expected,
          ok: true,
          missing: false,
        },
        `${plan.id} must exact-check selected ${field}`,
      );
    }
    if (plan.scenario === "treeGrid") {
      assert.equal(
        budgets.treeFilterMaxNodesVisited,
        (plan.cardinality.nodeCount + 4) * 2,
      );
    }

    const duplicateSerialization = passingMetrics(fixture);
    duplicateSerialization.autosave.serializeBytes =
      measureRuntimeEditorSerializedBytesAfterInput(fixture) * 2;
    const duplicateResult = evaluateRuntimePerformance(
      duplicateSerialization,
      budgets,
      fixture,
    );
    assert.equal(
      duplicateResult.checks.find(
        (check) => check.name === "autosave.serializeBytes",
      )?.ok,
      false,
      `${plan.id} must reject a second full serialization payload`,
    );
  }
  assert.equal(DEFAULT_RUNTIME_BUDGETS.treeFilterMaxNodesVisited, 1_008);
});

test("runtime performance budgets exact-check every real SQLite fixture surface", () => {
  const expected = buildExpectedRuntimeActualCardinality(
    RUNTIME_PERFORMANCE_FIXTURE,
  );

  for (const [field, value] of Object.entries(expected)) {
    const metrics = passingMetrics();
    metrics.fixture.actualCardinality[field] = value + 1;
    const result = evaluateRuntimePerformance(metrics);
    const name = `fixture.actualCardinality.${field}`;

    assert.equal(result.ok, false, `${name} must reject a mismatched DB count`);
    assert.deepEqual(
      result.checks.find((check) => check.name === name),
      {
        name,
        actual: value + 1,
        expected: value,
        ok: false,
        missing: false,
      },
    );
  }

  const missing = passingMetrics();
  delete missing.fixture.actualCardinality.chatSessionCount;
  const missingResult = evaluateRuntimePerformance(missing);
  assert.deepEqual(
    missingResult.checks.find(
      (check) => check.name === "fixture.actualCardinality.chatSessionCount",
    ),
    {
      name: "fixture.actualCardinality.chatSessionCount",
      actual: undefined,
      expected: 0,
      ok: false,
      missing: true,
    },
  );
});

test("autosave metrics keep CPU, wall time, and logical counters independent", () => {
  const metrics = extractAutosaveMetrics({
    markStats: [
      {
        label: "editor.coreSave.deriveSnapshot",
        count: 2,
        totalMs: 18,
      },
      {
        label: "editor.coreSave.invokeSave",
        count: 3,
        totalMs: 75,
      },
    ],
    counters: {
      "editor.coreSave.serializeBytes": 180_000,
      "editor.coreSave.domainIpc": 1,
      "editor.coreSave.dbTransaction": 1,
    },
  });

  assert.deepEqual(metrics, {
    deriveSnapshotCpuMs: 18,
    invokeSaveWallMs: 75,
    serializeBytes: 180_000,
    domainIpcCount: 1,
    dbTransactionCount: 1,
  });
});

test("autosave metrics reject missing canonical counters", () => {
  assert.equal(
    extractAutosaveMetrics({
      markStats: [
        { label: "editor.coreSave.deriveSnapshot", count: 1, totalMs: 10 },
        { label: "editor.coreSave.invokeSave", count: 1, totalMs: 20 },
      ],
      counters: {},
    }),
    null,
  );
});

test("interaction frame metrics require the measured rAF mark and counter", () => {
  assert.deepEqual(
    extractInteractionFrameMetrics(
      {
        markStats: [
          {
            label: "timeline.pointerFrame.interval",
            count: 120,
            totalMs: 2_016,
            p50Ms: 16.6,
            p95Ms: 16.8,
            maxMs: 50,
          },
          {
            label: "timeline.pointerFrame.work",
            count: 120,
          },
        ],
        counters: {
          "timeline.pointerFrame.interval.count": 120,
          "timeline.pointerFrame.work.count": 120,
        },
      },
      "timeline.pointerFrame.interval",
      "timeline.pointerFrame.work",
    ),
    {
      frameCount: 120,
      workFrameCount: 120,
      workCoverage: 1,
      p50FrameMs: 16.6,
      p95FrameMs: 16.8,
      meanFrameMs: 16.8,
      maxFrameMs: 50,
    },
  );
  assert.equal(
    extractInteractionFrameMetrics(
      {
        markStats: [
          {
            label: "timeline.pointerFrame.interval",
            count: 120,
            totalMs: 2_016,
            p50Ms: 16.6,
            p95Ms: 16.8,
            maxMs: 50,
          },
          { label: "timeline.pointerFrame.work", count: 120 },
        ],
        counters: { "timeline.pointerFrame.interval.count": 120 },
      },
      "timeline.pointerFrame.interval",
      "timeline.pointerFrame.work",
    ),
    null,
  );
  assert.equal(
    extractInteractionFrameMetrics(
      {
        markStats: [
          {
            label: "timeline.pointerFrame.interval",
            count: 120,
            totalMs: 2_016,
            p50Ms: 16.6,
            maxMs: 50,
          },
          { label: "timeline.pointerFrame.work", count: 120 },
        ],
        counters: {
          "timeline.pointerFrame.interval.count": 120,
          "timeline.pointerFrame.work.count": 120,
        },
      },
      "timeline.pointerFrame.interval",
      "timeline.pointerFrame.work",
    ),
    null,
    "missing p95 cannot satisfy the statistical frame gate",
  );
});

test("interaction frame gate separates steady-state p95 from catastrophic outliers", () => {
  const passing = passingMetrics();
  const passingResult = evaluateRuntimePerformance(passing);
  assert.equal(passingResult.ok, true);
  assert.equal(
    passingResult.checks.find(
      (check) => check.name === "interactions.timelineDrag.p95FrameMs",
    )?.ok,
    true,
  );
  assert.equal(
    passingResult.checks.find(
      (check) => check.name === "interactions.timelineDrag.maxFrameMs",
    )?.ok,
    true,
    "one bounded 50ms miss must not masquerade as the steady-state rate",
  );

  const slowRate = passingMetrics();
  slowRate.interactions.timelineDrag.p95FrameMs =
    DEFAULT_RUNTIME_BUDGETS.interactionFrameP95Ms + 0.01;
  const slowRateResult = evaluateRuntimePerformance(slowRate);
  assert.equal(
    slowRateResult.checks.find(
      (check) => check.name === "interactions.timelineDrag.p95FrameMs",
    )?.ok,
    false,
  );
  assert.equal(
    slowRateResult.checks.find(
      (check) => check.name === "interactions.timelineDrag.maxFrameMs",
    )?.ok,
    true,
  );

  const slowMean = passingMetrics();
  slowMean.interactions.timelineDrag.meanFrameMs =
    DEFAULT_RUNTIME_BUDGETS.interactionFrameMeanMs + 0.01;
  const slowMeanResult = evaluateRuntimePerformance(slowMean);
  assert.equal(
    slowMeanResult.checks.find(
      (check) => check.name === "interactions.timelineDrag.p95FrameMs",
    )?.ok,
    true,
    "mean-only regression keeps p95 independently green",
  );
  assert.equal(
    slowMeanResult.checks.find(
      (check) => check.name === "interactions.timelineDrag.meanFrameMs",
    )?.ok,
    false,
  );

  const catastrophic = passingMetrics();
  catastrophic.interactions.timelineDrag.maxFrameMs = 50.2;
  const catastrophicResult = evaluateRuntimePerformance(catastrophic);
  assert.equal(
    catastrophicResult.checks.find(
      (check) => check.name === "interactions.timelineDrag.p95FrameMs",
    )?.ok,
    true,
  );
  assert.equal(
    catastrophicResult.checks.find(
      (check) => check.name === "interactions.timelineDrag.maxFrameMs",
    )?.ok,
    false,
  );
});

test("runtime performance budgets reject missing metrics and regressions", () => {
  const metrics = passingMetrics();
  metrics.editorInput.p95Ms = DEFAULT_RUNTIME_BUDGETS.editorInputP95Ms + 1;
  metrics.autosave.serializeBytes =
    DEFAULT_RUNTIME_BUDGETS.autosaveSerializeBytes + 1;
  delete metrics.memory.peakBytes;
  delete metrics.memory.peakByViewBytes.timeline;

  const result = evaluateRuntimePerformance(metrics);
  assert.equal(result.ok, false);
  assert.equal(
    result.checks.find((check) => check.name === "editorInput.p95Ms").ok,
    false,
  );
  assert.equal(
    result.checks.find((check) => check.name === "autosave.serializeBytes").ok,
    false,
  );
  assert.equal(
    result.checks.find((check) => check.name === "memory.peakBytes").missing,
    true,
  );
  assert.equal(
    result.checks.find(
      (check) => check.name === "memory.peakByViewBytes.timeline",
    ).missing,
    true,
  );
});

test("runtime performance budgets require supported memory semantics and non-empty process evidence", () => {
  const cases = [
    {
      name: "memory.measurement",
      mutate(metrics) {
        metrics.memory.measurement = "sumProcessUnknownBytes";
      },
    },
    {
      name: "memory.startupProcesses",
      mutate(metrics) {
        metrics.memory.startupProcesses = [];
        metrics.memory.startupProcessCount = 0;
        metrics.memory.startupBytes = 0;
      },
    },
    {
      name: "memory.peakProcessCount",
      mutate(metrics) {
        metrics.memory.peakProcessCount = 2;
      },
    },
    {
      name: "memory.peakFallbackProcessCount",
      mutate(metrics) {
        metrics.memory.peakFallbackProcessCount = 1;
      },
    },
    {
      name: "memory.startupBytesEvidence",
      mutate(metrics) {
        metrics.memory.startupBytes -= 1;
      },
    },
  ];

  for (const { name, mutate } of cases) {
    const metrics = passingMetrics();
    mutate(metrics);
    const result = evaluateRuntimePerformance(metrics);
    assert.equal(result.ok, false, `${name} must fail`);
    assert.equal(
      result.checks.find((check) => check.name === name)?.ok,
      false,
      `${name} must have a failing contract check`,
    );
  }
});

test("autosave cardinality requires exactly one domain IPC and DB transaction", () => {
  for (const field of ["domainIpcCount", "dbTransactionCount"]) {
    for (const value of [0, -1, 2]) {
      const metrics = passingMetrics();
      metrics.autosave[field] = value;
      const result = evaluateRuntimePerformance(metrics);
      const name = `autosave.${field}`;

      assert.equal(result.ok, false, `${name}=${value} must fail`);
      assert.deepEqual(
        result.checks.find((check) => check.name === name),
        {
          name,
          actual: value,
          expected: 1,
          ok: false,
          missing: false,
        },
      );
    }
  }
});

test("runtime performance budgets reject metrics from a small or different scene", () => {
  const mutations = [
    ["id", "tiny-scene-v1"],
    ["sceneId", "different-seeded-scene"],
    ["seededTextChars", 1_000],
    ["seededBeatCount", 1],
    ["collectionSceneCount", 10],
    ["editorInputSceneId", "new-empty-smoke-scene"],
    ["autosaveSceneId", "new-empty-smoke-scene"],
    ["editorInputTargetVerified", false],
    ["editorInputParagraphCharsBefore", 1_000],
  ];

  for (const [field, value] of mutations) {
    const metrics = passingMetrics();
    metrics.fixture[field] = value;
    const result = evaluateRuntimePerformance(metrics);
    const name = `fixture.${field}`;

    assert.equal(result.ok, false);
    assert.equal(
      result.checks.find((check) => check.name === name)?.ok,
      false,
      `${name} must be enforced`,
    );
  }
});

test("runtime interaction budgets require scoped evidence for every hot path", () => {
  const mutations = [
    ["treeFilter", "targetVerified", false],
    ["treeFilter", "longTaskCount", 1],
    [
      "treeFilter",
      "maxNodesVisited",
      DEFAULT_RUNTIME_BUDGETS.treeFilterMaxNodesVisited + 1,
    ],
    ["linearScroll", "targetVerified", false],
    ["linearScroll", "sceneRectReads", 1],
    [
      "linearScroll",
      "maxVisibleRects",
      DEFAULT_RUNTIME_BUDGETS.linearMaxVisibleRects + 1,
    ],
    ["timelineDrag", "targetVerified", false],
    [
      "timelineDrag",
      "frameCount",
      DEFAULT_RUNTIME_BUDGETS.interactionFrameMinimumSamples - 1,
    ],
    [
      "timelineDrag",
      "workFrameCount",
      DEFAULT_RUNTIME_BUDGETS.interactionWorkFrameMinimumSamples - 1,
    ],
    [
      "timelineDrag",
      "workCoverage",
      DEFAULT_RUNTIME_BUDGETS.interactionWorkCoverageMinimum - 0.01,
    ],
    [
      "timelineDrag",
      "p95FrameMs",
      DEFAULT_RUNTIME_BUDGETS.interactionFrameP95Ms + 0.01,
    ],
    [
      "timelineDrag",
      "meanFrameMs",
      DEFAULT_RUNTIME_BUDGETS.interactionFrameMeanMs + 0.01,
    ],
    [
      "timelineDrag",
      "maxFrameMs",
      DEFAULT_RUNTIME_BUDGETS.interactionFrameCatastrophicMaxMs + 0.01,
    ],
    ["timelineDrag", "gestureLongTaskCount", 1],
    [
      "timelineDrag",
      "gestureLongTaskMaxMs",
      DEFAULT_RUNTIME_BUDGETS.interactionGestureLongTaskMaxMs + 0.01,
    ],
    [
      "timelineDrag",
      "dragStartRenderMaxMs",
      DEFAULT_RUNTIME_BUDGETS.timelineDragStartRenderMaxMs + 0.01,
    ],
    ["chroniclePan", "targetVerified", false],
    [
      "chroniclePan",
      "frameCount",
      DEFAULT_RUNTIME_BUDGETS.interactionFrameMinimumSamples - 1,
    ],
    [
      "chroniclePan",
      "workFrameCount",
      DEFAULT_RUNTIME_BUDGETS.interactionWorkFrameMinimumSamples - 1,
    ],
    [
      "chroniclePan",
      "workCoverage",
      DEFAULT_RUNTIME_BUDGETS.interactionWorkCoverageMinimum - 0.01,
    ],
    [
      "chroniclePan",
      "p95FrameMs",
      DEFAULT_RUNTIME_BUDGETS.interactionFrameP95Ms + 0.01,
    ],
    [
      "chroniclePan",
      "meanFrameMs",
      DEFAULT_RUNTIME_BUDGETS.interactionFrameMeanMs + 0.01,
    ],
    [
      "chroniclePan",
      "maxFrameMs",
      DEFAULT_RUNTIME_BUDGETS.interactionFrameCatastrophicMaxMs + 0.01,
    ],
    ["chroniclePan", "gestureLongTaskCount", 1],
    [
      "chroniclePan",
      "gestureLongTaskMaxMs",
      DEFAULT_RUNTIME_BUDGETS.interactionGestureLongTaskMaxMs + 0.01,
    ],
  ];

  for (const [interaction, field, value] of mutations) {
    const metrics = passingMetrics();
    metrics.interactions[interaction][field] = value;
    const result = evaluateRuntimePerformance(metrics);
    const name = `interactions.${interaction}.${field}`;

    assert.equal(result.ok, false, `${name} must fail the runtime gate`);
    assert.equal(
      result.checks.find((check) => check.name === name)?.ok,
      false,
      `${name} must be enforced`,
    );
  }
});

test("focused Chat draft delta permits no Header, ContextBar, or panel commit", () => {
  const fixture = buildRuntimePerformanceFixtureForReview("chat-100");
  const budgets = buildRuntimeBudgets(fixture);
  for (const [field, value] of [
    ["headerCommitCount", 1],
    ["contextBarCommitCount", 1],
    ["chatPanelRenderCount", 1],
    ["chatMessageRenderCount", 2],
  ]) {
    const metrics = passingMetrics(fixture);
    metrics.interactions.chatDraft[field] = value;
    const result = evaluateRuntimePerformance(metrics, budgets, fixture);
    assert.equal(result.ok, false, `${field}=${value} must fail`);
    assert.equal(
      result.checks.find(
        (check) => check.name === `interactions.chatDraft.${field}`,
      )?.ok,
      false,
    );
  }
});

test("focused Map drag requires persisted movement and zero unrelated React node or DOM churn", () => {
  const fixture = buildRuntimePerformanceFixtureForReview("map-500");
  const budgets = buildRuntimeBudgets(fixture);
  for (const [field, value] of [
    ["targetVerified", false],
    ["persistedPositionId", "not-a-fixture-position"],
    ["unrelatedNodeCount", fixture.mapNodeCount - 2],
    ["targetNodeObjectIdentityChanged", false],
    ["targetNodeRenderCount", 0],
    ["unrelatedNodeObjectIdentityChanges", 1],
    ["unrelatedNodeRenderCount", 1],
    ["unrelatedRenderedNodeCount", 1],
    ["unrelatedDomIdentityChanges", 1],
    ["unrelatedTransformChanges", 1],
    ["unrelatedChildListReplacements", 1],
    ["unrelatedAttributeMutations", 1],
  ]) {
    const metrics = passingMetrics(fixture);
    metrics.interactions.mapDrag[field] = value;
    const result = evaluateRuntimePerformance(metrics, budgets, fixture);
    const checkName =
      field === "persistedPositionId"
        ? "interactions.mapDrag.persistedPositionVerified"
        : field === "targetNodeRenderCount"
          ? "interactions.mapDrag.targetNodeRenderCount"
          : `interactions.mapDrag.${field}`;
    assert.equal(result.ok, false, `${field}=${value} must fail`);
    assert.equal(
      result.checks.find((check) => check.name === checkName)?.ok,
      false,
      `${checkName} must be enforced`,
    );
  }
});
