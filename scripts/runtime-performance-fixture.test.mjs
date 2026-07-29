import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_RUNTIME_PERFORMANCE_PROFILE,
  RUNTIME_PERFORMANCE_FIXTURE,
  RUNTIME_PERFORMANCE_INPUT_TEXT,
  RUNTIME_PERFORMANCE_REVIEW_MATRIX,
  buildRuntimeEditorDocument,
  buildRuntimeEditorDocumentAfterInput,
  buildRuntimePerformanceFixtureProfile,
  buildRuntimePerformanceFixtureForReview,
  buildRuntimeFixtureActualCardinalityQuery,
  buildRuntimeFixtureStatements,
  buildRuntimeReviewFixture,
  buildRuntimeReviewFixturePlans,
  measureRuntimeFixtureStatementCardinality,
  parseRuntimeFixtureActualCardinality,
  measureRuntimeEditorSerializedBytesAfterInput,
  measureRuntimeReviewFixtureCardinality,
} from "../electron/scripts/runtime-performance-fixture.mjs";
import {
  buildPerformanceBenchmarkInvocation,
  parsePerformanceBenchmarkArguments,
} from "../electron/scripts/performance-benchmark.mjs";
import {
  aggregateAppProcessMemory,
  appMemoryMeasurement,
  parseLinuxSmapsRollup,
} from "../electron/scripts/process-memory.mjs";
import {
  RUNTIME_AUTOSAVE_SERIALIZATION_OVERHEAD,
  buildRuntimeBudgets,
  parseRuntimeBudgetArguments,
} from "./runtime-performance-budget.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function seededSceneInsert(statements) {
  return statements.find(
    (statement) =>
      statement.method === "run" &&
      statement.params?.[0] === RUNTIME_PERFORMANCE_FIXTURE.sceneId,
  );
}

function seededTabStateInsert(statements) {
  return statements.find((statement) =>
    statement.sql.includes("editor.tabState"),
  );
}

function documentCardinality(serializedDocument) {
  const document = JSON.parse(serializedDocument);
  const paragraphs = document.content.filter(
    (node) => node.type === "paragraph",
  );
  return {
    textChars: paragraphs
      .flatMap((node) => node.content ?? [])
      .reduce((total, node) => total + (node.text?.length ?? 0), 0),
    beatCount: document.content.filter((node) => node.type === "sceneBeat")
      .length,
  };
}

function processMetric(
  pid,
  workingSetSize,
  { creationTime = pid, privateBytes } = {},
) {
  return {
    pid,
    type: pid === 1 ? "Browser" : "Tab",
    creationTime,
    memory: { workingSetSize, privateBytes },
  };
}

test("Linux smaps_rollup converts PSS and RSS KiB to bytes", () => {
  assert.deepEqual(
    parseLinuxSmapsRollup(
      [
        "Rss:                4096 kB",
        "Pss:                1536 kB",
        "Private_Clean:       128 kB",
        "",
      ].join("\n"),
    ),
    {
      proportionalSetBytes: 1_536 * 1_024,
      residentSetBytes: 4_096 * 1_024,
    },
  );
  assert.throws(() => parseLinuxSmapsRollup("Rss: 1 kB\n"), /missing Pss/);
});

test("Linux app memory sums PSS once per PID and keeps the newest process identity", async () => {
  const reads = [];
  const result = await aggregateAppProcessMemory(
    [
      processMetric(10, 1_000, { creationTime: 10 }),
      processMetric(10, 9_000, { creationTime: 9 }),
      processMetric(20, 2_000, { creationTime: 20 }),
    ],
    {
      platform: "linux",
      readLinuxSmapsRollup: async (pid) => {
        reads.push(pid);
        return `Rss: ${pid * 100} kB\nPss: ${pid * 10} kB\n`;
      },
    },
  );

  assert.deepEqual(
    reads.sort((a, b) => a - b),
    [10, 20],
  );
  assert.equal(result.measurement, appMemoryMeasurement("linux"));
  assert.equal(result.processCount, 2);
  assert.equal(result.fallbackProcessCount, 0);
  assert.equal(result.measuredBytes, (100 + 200) * 1_024);
  assert.equal(result.workingSetBytes, (1_000 + 2_000) * 1_024);
  assert.deepEqual(
    result.processes.map(({ pid, creationTime, source }) => ({
      pid,
      creationTime,
      source,
    })),
    [
      { pid: 10, creationTime: 10, source: "pss" },
      { pid: 20, creationTime: 20, source: "pss" },
    ],
  );
});

test("app memory rejects an empty process snapshot instead of reporting zero bytes", async () => {
  await assert.rejects(
    aggregateAppProcessMemory([], {
      platform: "linux",
      readLinuxSmapsRollup: async () => "Rss: 1 kB\nPss: 1 kB\n",
    }),
    /at least one Electron app process/,
  );
});

test("app memory rejects a process snapshot without the required working set", async () => {
  await assert.rejects(
    aggregateAppProcessMemory(
      [
        {
          pid: 10,
          type: "Tab",
          creationTime: 10,
          memory: {},
        },
      ],
      {
        platform: "linux",
        readLinuxSmapsRollup: async () => "Rss: 1 kB\nPss: 1 kB\n",
      },
    ),
    /workingSetSize must be a non-negative KiB value/,
  );
});

test("Linux PID exit race uses captured RSS with an explicit stable measurement policy", async () => {
  const success = await aggregateAppProcessMemory([processMetric(10, 1_000)], {
    platform: "linux",
    readLinuxSmapsRollup: async () => "Rss: 1000 kB\nPss: 250 kB\n",
  });
  const exited = Object.assign(new Error("process exited"), { code: "ENOENT" });
  const withFallback = await aggregateAppProcessMemory(
    [processMetric(10, 1_000), processMetric(20, 2_000)],
    {
      platform: "linux",
      readLinuxSmapsRollup: async (pid) => {
        if (pid === 20) throw exited;
        return "Rss: 1000 kB\nPss: 250 kB\n";
      },
    },
  );

  assert.equal(success.measurement, appMemoryMeasurement("linux"));
  assert.equal(withFallback.measurement, success.measurement);
  assert.equal(withFallback.fallbackProcessCount, 1);
  assert.equal(withFallback.measuredBytes, (250 + 2_000) * 1_024);
  assert.deepEqual(
    withFallback.processes.find((metric) => metric.pid === 20),
    {
      pid: 20,
      type: "Tab",
      creationTime: 20,
      measuredBytes: 2_000 * 1_024,
      workingSetBytes: 2_000 * 1_024,
      source: "rss-fallback",
      fallbackReason: "ENOENT",
    },
  );
});

test("runtime review matrix pins every recommended deterministic cardinality", () => {
  assert.deepEqual(
    RUNTIME_PERFORMANCE_REVIEW_MATRIX.editor.map((entry) => entry.textChars),
    [5_000, 50_000, 200_000],
  );
  assert.deepEqual(
    RUNTIME_PERFORMANCE_REVIEW_MATRIX.beatEditor.map(
      (entry) => entry.beatCount,
    ),
    [0, 20, 200],
  );
  assert.deepEqual(
    RUNTIME_PERFORMANCE_REVIEW_MATRIX.treeGrid.map((entry) => entry.nodeCount),
    [500, 2_000, 10_000],
  );
  assert.deepEqual(
    RUNTIME_PERFORMANCE_REVIEW_MATRIX.linear.map((entry) => entry.sceneCount),
    [100, 500, 2_000],
  );
  assert.deepEqual(
    RUNTIME_PERFORMANCE_REVIEW_MATRIX.chat.map((entry) => entry.messageCount),
    [100, 1_000, 5_000],
  );
  assert.deepEqual(RUNTIME_PERFORMANCE_REVIEW_MATRIX.timeline, [
    {
      id: "timeline-1k-scenes-100-threads-5k-markers-links",
      sceneCount: 1_000,
      threadCount: 100,
      markerLinkCount: 5_000,
    },
  ]);
  assert.deepEqual(
    RUNTIME_PERFORMANCE_REVIEW_MATRIX.chronicle.map(
      (entry) => entry.eventCount,
    ),
    [1_000, 5_000],
  );
  assert.deepEqual(
    RUNTIME_PERFORMANCE_REVIEW_MATRIX.map.map(({ nodeCount, edgeCount }) => [
      nodeCount,
      edgeCount,
    ]),
    [
      [500, 500],
      [2_000, 2_000],
    ],
  );

  const plans = buildRuntimeReviewFixturePlans();
  assert.equal(plans.length, 20);
  assert.equal(new Set(plans.map((plan) => plan.id)).size, plans.length);
  assert.deepEqual(
    [...new Set(plans.map((plan) => plan.scenario))],
    [
      "editor",
      "beatEditor",
      "treeGrid",
      "linear",
      "chat",
      "timeline",
      "chronicle",
      "map",
    ],
  );
});

test("runtime editor builder independently realizes every text/Beat review scale", () => {
  for (const { textChars } of RUNTIME_PERFORMANCE_REVIEW_MATRIX.editor) {
    for (const { beatCount } of RUNTIME_PERFORMANCE_REVIEW_MATRIX.beatEditor) {
      const document = buildRuntimeEditorDocument({
        ...RUNTIME_PERFORMANCE_FIXTURE,
        seededTextChars: textChars,
        seededBeatCount: beatCount,
      });
      assert.deepEqual(documentCardinality(document), {
        textChars,
        beatCount,
      });
    }
  }
});

test("every review-matrix row materializes its full deterministic data set", () => {
  for (const plan of buildRuntimeReviewFixturePlans()) {
    const fixture = buildRuntimeReviewFixture(plan.id);
    assert.equal(fixture.id, plan.id);
    assert.equal(fixture.scenario, plan.scenario);
    assert.deepEqual(
      measureRuntimeReviewFixtureCardinality(fixture),
      plan.cardinality,
      `${plan.id} must realize its declared cardinality`,
    );
  }
});

test("all 20 review ids select an actual seed and propagate to smoke + budget", () => {
  for (const plan of buildRuntimeReviewFixturePlans()) {
    const parsed = parsePerformanceBenchmarkArguments([
      "node",
      "performance-benchmark.mjs",
      "--review-fixture",
      plan.id,
      "--output",
      "runtime-metrics.json",
    ]);
    assert.equal(parsed.reviewFixtureId, plan.id);

    const fixture = buildRuntimePerformanceFixtureForReview(plan.id);
    assert.equal(fixture.id, plan.id);
    assert.equal(fixture.reviewFixtureId, plan.id);
    assert.equal(fixture.reviewScenario, plan.scenario);
    assert.equal(
      fixture.reviewCardinalityJson,
      JSON.stringify(plan.cardinality),
    );
    const statements = buildRuntimeFixtureStatements(fixture);
    assert.deepEqual(
      measureRuntimeFixtureStatementCardinality(statements, fixture),
      plan.cardinality,
      `${plan.id} must seed its declared production-table cardinality`,
    );

    const invocation = buildPerformanceBenchmarkInvocation(
      parsed,
      "/tmp/runtime-metrics.json",
    );
    assert.equal(
      invocation.smokeEnvironment.GRIMODEX_PERF_REVIEW_FIXTURE,
      plan.id,
    );
    assert.deepEqual(invocation.budgetArguments, [
      "/tmp/runtime-metrics.json",
      "--review-fixture",
      plan.id,
    ]);
    assert.deepEqual(
      parseRuntimeBudgetArguments([
        "node",
        "runtime-performance-budget.mjs",
        ...invocation.budgetArguments,
      ]),
      {
        metricsPath: "/tmp/runtime-metrics.json",
        reviewFixtureId: plan.id,
      },
    );
  }
});

test("runtime cardinality query measures persisted fixture rows by exact IDs and prefixes", () => {
  const query = buildRuntimeFixtureActualCardinalityQuery(
    RUNTIME_PERFORMANCE_FIXTURE,
  );

  assert.equal(query.method, "all");
  assert.match(query.sql, /FROM tree_nodes WHERE id = \?/);
  assert.match(query.sql, /id GLOB \?/);
  assert.match(query.sql, /FROM plot_threads/);
  assert.match(query.sql, /FROM plot_thread_scene_links/);
  assert.match(query.sql, /FROM events/);
  assert.match(query.sql, /FROM map_node_positions/);
  assert.match(query.sql, /FROM map_edges/);
  assert.match(query.sql, /FROM chat_sessions/);
  assert.match(query.sql, /FROM chat_messages/);
  assert.ok(query.params.includes(RUNTIME_PERFORMANCE_FIXTURE.sceneId));
  assert.ok(query.params.includes(RUNTIME_PERFORMANCE_FIXTURE.folderId));
  assert.ok(query.params.includes(RUNTIME_PERFORMANCE_FIXTURE.boardId));
  assert.ok(
    query.params.some(
      (value) =>
        value === "grimodex-runtime-perf-scene-*" && typeof value === "string",
    ),
  );

  const serializedDocument = buildRuntimeEditorDocument(
    RUNTIME_PERFORMANCE_FIXTURE,
  );
  assert.deepEqual(
    parseRuntimeFixtureActualCardinality([
      {
        editorContent: serializedDocument,
        treeNodeCount: 502,
        sceneCount: 501,
        threadCount: 100,
        markerLinkCount: 5_000,
        eventCount: 1_000,
        mapNodeCount: 500,
        mapEdgeCount: 500,
        chatSessionCount: 0,
        chatMessageCount: 0,
      },
    ]),
    {
      textChars: 50_000,
      beatCount: 20,
      treeNodeCount: 502,
      sceneCount: 501,
      threadCount: 100,
      markerLinkCount: 5_000,
      eventCount: 1_000,
      mapNodeCount: 500,
      mapEdgeCount: 500,
      chatSessionCount: 0,
      chatMessageCount: 0,
    },
  );
  assert.throws(
    () => parseRuntimeFixtureActualCardinality([]),
    /cardinality query returned no row/,
  );
  assert.throws(
    () =>
      parseRuntimeFixtureActualCardinality([
        {
          editorContent: serializedDocument,
          treeNodeCount: "not-a-count",
        },
      ]),
    /treeNodeCount must be a non-negative integer/,
  );
});

test("all 20 profiles derive autosave bytes from the actual post-input UTF-8 payload", () => {
  for (const plan of buildRuntimeReviewFixturePlans()) {
    const fixture = buildRuntimePerformanceFixtureForReview(plan.id);
    const statements = buildRuntimeFixtureStatements(fixture);
    const seededScene = statements.find(
      (statement) => statement.params?.[0] === fixture.sceneId,
    );
    assert.ok(seededScene, `${plan.id} must seed its editor scene`);

    const document = JSON.parse(seededScene.params[2]);
    document.content[0].content[0].text += RUNTIME_PERFORMANCE_INPUT_TEXT;
    const actualPostInputPayload = JSON.stringify(document);
    assert.equal(
      buildRuntimeEditorDocumentAfterInput(fixture),
      actualPostInputPayload,
    );
    const actualBytes = Buffer.byteLength(actualPostInputPayload, "utf8");
    assert.equal(
      measureRuntimeEditorSerializedBytesAfterInput(fixture),
      actualBytes,
    );
    const budgets = buildRuntimeBudgets(fixture);
    const boundedOverhead =
      RUNTIME_AUTOSAVE_SERIALIZATION_OVERHEAD.fixedBytes +
      Math.ceil(actualBytes * RUNTIME_AUTOSAVE_SERIALIZATION_OVERHEAD.ratio);
    assert.equal(budgets.autosaveSerializeExpectedBytes, actualBytes);
    assert.equal(budgets.autosaveSerializeOverheadBytes, boundedOverhead);
    assert.equal(budgets.autosaveSerializeBytes, actualBytes + boundedOverhead);
    assert.ok(
      budgets.autosaveSerializeBytes < actualBytes * 2,
      `${plan.id} must reject a duplicated serialization payload`,
    );
  }

  const editor200k = buildRuntimePerformanceFixtureForReview("editor-200k");
  assert.equal(
    measureRuntimeEditorSerializedBytesAfterInput(editor200k),
    615_029,
  );
  assert.equal(buildRuntimeBudgets(editor200k).autosaveSerializeBytes, 628_354);
});

test("canonical CLI remains the default when no review fixture is selected", () => {
  const parsed = parsePerformanceBenchmarkArguments([
    "node",
    "performance-benchmark.mjs",
    "--output",
    "runtime-metrics.json",
  ]);
  assert.equal(parsed.reviewFixtureId, null);
  const invocation = buildPerformanceBenchmarkInvocation(
    parsed,
    "/tmp/runtime-metrics.json",
  );
  assert.equal(
    Object.hasOwn(invocation.smokeEnvironment, "GRIMODEX_PERF_REVIEW_FIXTURE"),
    false,
  );
  assert.deepEqual(invocation.budgetArguments, ["/tmp/runtime-metrics.json"]);
  assert.equal(
    buildRuntimePerformanceFixtureForReview(null),
    RUNTIME_PERFORMANCE_FIXTURE,
  );
});

test("review fixture selection rejects missing, altered, and unknown ids", () => {
  assert.throws(
    () =>
      parsePerformanceBenchmarkArguments([
        "node",
        "performance-benchmark.mjs",
        "--review-fixture",
      ]),
    /requires an exact fixture id/,
  );
  assert.throws(
    () =>
      parsePerformanceBenchmarkArguments([
        "node",
        "performance-benchmark.mjs",
        "--review-fixture",
        "tree-grid-999",
      ]),
    /unknown runtime review fixture: tree-grid-999/,
  );
  assert.throws(
    () =>
      parseRuntimeBudgetArguments([
        "node",
        "runtime-performance-budget.mjs",
        "metrics.json",
        "--review-fixture",
        "chat-100-extra",
      ]),
    /unknown runtime review fixture: chat-100-extra/,
  );
});

test("chat review seeds a real scene-scoped session and every message row", () => {
  const fixture = buildRuntimePerformanceFixtureForReview("chat-5k");
  const statements = buildRuntimeFixtureStatements(fixture);
  const sessionInserts = statements.filter((statement) =>
    statement.sql.includes("INSERT INTO chat_sessions"),
  );
  const messageInserts = statements.filter((statement) =>
    statement.sql.includes("INSERT INTO chat_messages"),
  );

  assert.equal(sessionInserts.length, 1);
  assert.deepEqual(sessionInserts[0].params.slice(0, 2), [
    fixture.chatSessionId,
    fixture.sceneId,
  ]);
  assert.equal(messageInserts.length, 5_000);
  assert.equal(
    messageInserts.every(
      (statement) => statement.params[1] === fixture.chatSessionId,
    ),
    true,
  );
});

test("review fixture objects cannot retain a canonical id with altered cardinality", () => {
  assert.throws(
    () =>
      buildRuntimeReviewFixture({
        id: "editor-200k",
        scenario: "editor",
        cardinality: { textChars: 100 },
      }),
    /altered runtime review fixture: editor-200k/,
  );
});

test("materialized relation fixtures reference entities in the same profile", () => {
  const treeGrid = buildRuntimeReviewFixture("tree-grid-10k");
  const treeGridIds = new Set(treeGrid.nodes.map((node) => node.id));
  assert.equal(
    treeGrid.nodes.every(
      (node) => node.parentId === null || treeGridIds.has(node.parentId),
    ),
    true,
  );

  const timeline = buildRuntimeReviewFixture(
    "timeline-1k-scenes-100-threads-5k-markers-links",
  );
  const timelineSceneIds = new Set(timeline.scenes.map((scene) => scene.id));
  const timelineThreadIds = new Set(
    timeline.threads.map((thread) => thread.id),
  );
  assert.equal(
    timeline.links.every(
      (link) =>
        timelineSceneIds.has(link.nodeId) &&
        timelineThreadIds.has(link.threadId),
    ),
    true,
  );
  assert.equal(
    timeline.links.every((link) => link.note === null),
    true,
  );

  const map = buildRuntimeReviewFixture("map-2k");
  const mapNodeIds = new Set(map.nodes.map((node) => node.id));
  const mapSceneIds = new Set(map.scenes.map((scene) => scene.id));
  assert.equal(
    map.nodes.every(
      (node) =>
        node.nodeRefType === "scene" &&
        mapSceneIds.has(node.treeNodeId) &&
        node.boardId === "map-2k-board",
    ),
    true,
  );
  assert.equal(
    map.edges.every(
      (edge) =>
        mapNodeIds.has(edge.fromPositionId) &&
        mapNodeIds.has(edge.toPositionId),
    ),
    true,
  );
});

test("per-PR runtime profile remains the realistic 50k / 20 / 500 gate", () => {
  assert.deepEqual(CANONICAL_RUNTIME_PERFORMANCE_PROFILE.editor, {
    textChars: 50_000,
    beatCount: 20,
  });
  assert.deepEqual(CANONICAL_RUNTIME_PERFORMANCE_PROFILE.project, {
    collectionSceneCount: 500,
  });
  assert.deepEqual(CANONICAL_RUNTIME_PERFORMANCE_PROFILE.timeline, {
    threadCount: 100,
    markerLinkCount: 5_000,
  });
  assert.deepEqual(CANONICAL_RUNTIME_PERFORMANCE_PROFILE.chronicle, {
    eventCount: 1_000,
  });
  assert.deepEqual(CANONICAL_RUNTIME_PERFORMANCE_PROFILE.map, {
    nodeCount: 500,
    edgeCount: 500,
  });
  assert.deepEqual(
    buildRuntimePerformanceFixtureProfile(),
    RUNTIME_PERFORMANCE_FIXTURE,
  );
  assert.equal(RUNTIME_PERFORMANCE_FIXTURE.seededTextChars, 50_000);
  assert.equal(RUNTIME_PERFORMANCE_FIXTURE.seededBeatCount, 20);
  assert.equal(RUNTIME_PERFORMANCE_FIXTURE.collectionSceneCount, 500);
});

test("runtime fixture seeds the contracted 50k-character / 20-Beat scene", () => {
  const statements = buildRuntimeFixtureStatements();
  const insert = seededSceneInsert(statements);

  assert.ok(insert, "seeded performance scene insert is required");
  assert.equal(RUNTIME_PERFORMANCE_FIXTURE.seededTextChars, 50_000);
  assert.equal(RUNTIME_PERFORMANCE_FIXTURE.seededBeatCount, 20);
  assert.equal(insert.params[1], RUNTIME_PERFORMANCE_FIXTURE.sceneTitle);
  assert.equal(insert.params[3], RUNTIME_PERFORMANCE_FIXTURE.seededTextChars);
  assert.match(insert.sql, /chronicle_start_time/);
  assert.match(insert.sql, /chronicle_start_granularity/);

  const document = JSON.parse(insert.params[2]);
  const paragraphs = document.content.filter(
    (node) => node.type === "paragraph",
  );
  const textChars = paragraphs
    .flatMap((node) => node.content ?? [])
    .reduce((total, node) => total + (node.text?.length ?? 0), 0);
  const beats = document.content.filter((node) => node.type === "sceneBeat");

  assert.equal(
    paragraphs[0]?.content?.[0]?.text,
    RUNTIME_PERFORMANCE_FIXTURE.inputAnchorText,
  );
  assert.equal(textChars, RUNTIME_PERFORMANCE_FIXTURE.seededTextChars);
  assert.equal(beats.length, RUNTIME_PERFORMANCE_FIXTURE.seededBeatCount);
  assert.equal(new Set(beats.map((beat) => beat.attrs?.id)).size, beats.length);
});

test("runtime fixture opens the measured scene without a harness click", () => {
  const statements = buildRuntimeFixtureStatements();
  const insert = seededTabStateInsert(statements);

  assert.ok(insert, "seeded editor tab state is required");
  assert.match(insert.sql, /INSERT INTO project_settings/);
  assert.match(insert.sql, /'default-project', 'editor\.tabState'/);
  const tabState = JSON.parse(insert.params[0]);
  assert.equal(tabState.activeTabId, RUNTIME_PERFORMANCE_FIXTURE.sceneId);
  assert.deepEqual(tabState.tabs, [
    {
      nodeId: RUNTIME_PERFORMANCE_FIXTURE.sceneId,
      isPreview: false,
      contentType: "scene",
    },
  ]);
});

test("runtime fixture preserves project-scale surface cardinality", () => {
  const statements = buildRuntimeFixtureStatements();
  const mapBoardInsert = statements.find((statement) =>
    statement.sql.includes("INSERT INTO map_boards"),
  );
  const fixtureSceneInserts = statements.filter((statement) =>
    statement.sql.includes("INSERT INTO tree_nodes"),
  );
  const mapPositionInserts = statements.filter((statement) =>
    statement.sql.includes("INSERT INTO map_node_positions"),
  );
  const mapEdgeInserts = statements.filter((statement) =>
    statement.sql.includes("INSERT INTO map_edges"),
  );
  const timelineThreadInserts = statements.filter((statement) =>
    statement.sql.includes("INSERT INTO plot_threads"),
  );
  const timelineMarkerLinkInserts = statements.filter((statement) =>
    statement.sql.includes("INSERT INTO plot_thread_scene_links"),
  );
  const chronicleEventInserts = statements.filter((statement) =>
    statement.sql.includes("INSERT INTO events"),
  );
  const chronicleRelationInserts = statements.filter((statement) =>
    statement.sql.includes("INSERT INTO event_relations"),
  );

  assert.match(mapBoardInsert?.sql ?? "", /VALUES \(\?,[^)]* -1,/);
  assert.equal(RUNTIME_PERFORMANCE_FIXTURE.collectionSceneCount, 500);
  assert.equal(
    fixtureSceneInserts.length,
    RUNTIME_PERFORMANCE_FIXTURE.collectionSceneCount + 2,
  );
  assert.equal(
    mapPositionInserts.length,
    RUNTIME_PERFORMANCE_FIXTURE.mapNodeCount,
  );
  assert.equal(
    new Set(mapPositionInserts.map((statement) => statement.params[0])).size,
    RUNTIME_PERFORMANCE_FIXTURE.mapNodeCount,
  );
  for (const statement of mapPositionInserts) {
    assert.match(statement.sql, /FROM map_boards\s+WHERE id = \?/);
    assert.equal(statement.params.at(-1), RUNTIME_PERFORMANCE_FIXTURE.boardId);
  }
  assert.equal(mapEdgeInserts.length, RUNTIME_PERFORMANCE_FIXTURE.mapEdgeCount);
  assert.equal(
    timelineThreadInserts.length,
    RUNTIME_PERFORMANCE_FIXTURE.timelineThreadCount,
  );
  assert.equal(
    timelineMarkerLinkInserts.length,
    RUNTIME_PERFORMANCE_FIXTURE.timelineMarkerLinkCount,
  );
  assert.equal(
    chronicleEventInserts.length,
    RUNTIME_PERFORMANCE_FIXTURE.chronicleEventCount,
  );
  assert.equal(
    chronicleRelationInserts.length,
    Math.min(RUNTIME_PERFORMANCE_FIXTURE.chronicleEventCount - 1, 1_000),
  );
});

test("Chronicle review fixtures cover the causal-edge path across the full range", () => {
  const fixture = buildRuntimeReviewFixture("chronicle-5k");

  assert.equal(fixture.events.length, 5_000);
  assert.equal(fixture.relations.length, 1_000);
  assert.equal(
    new Set(
      fixture.relations.map(
        (relation) => `${relation.causeEventId}|${relation.effectEventId}`,
      ),
    ).size,
    fixture.relations.length,
  );
  assert.equal(fixture.relations[0].causeEventId, fixture.events[0].id);
  assert.ok(
    fixture.relations.at(-1).effectEventId.startsWith("chronicle-5k-event-"),
  );
});

test("smoke measures the seeded long scene before running the independent persistence scenario", async () => {
  const source = await readFile(
    path.join(repoRoot, "electron", "scripts", "smoke.mjs"),
    "utf8",
  );
  const inputTargetSelection = source.indexOf(
    "await focusRuntimeInputAnchor(page)",
  );
  const seedBatch = source.indexOf('await invokeOk(page, "db_execute_batch"');
  const actualCardinalityQuery = source.indexOf(
    "buildRuntimeFixtureActualCardinalityQuery(",
    seedBatch,
  );
  const actualCardinalityInvoke = source.indexOf(
    '"db_execute"',
    actualCardinalityQuery,
  );
  const actualCardinalityAssignment = source.indexOf(
    "performanceMetrics.fixture.actualCardinality =",
    actualCardinalityInvoke,
  );
  const perfSessionStart = source.indexOf(
    "globalThis.startPerfSession?.()",
    inputTargetSelection,
  );
  const longSceneInput = source.indexOf("page.keyboard.type(PERF_INPUT_TEXT");
  const inputSnapshot = source.indexOf(
    "globalThis.snapshotPerfSession?.()",
    longSceneInput,
  );
  const longSceneAutosave = source.indexOf(
    "sceneContainsTextInDb(page, PERF_SCENE_ID, PERF_INPUT_TEXT)",
  );
  const smokeSceneCreate = source.indexOf(
    'header.locator(`button[title="${CREATE_BUTTON_TITLE}"]`).click()',
  );
  const smokeSceneInput = source.indexOf("page.keyboard.type(SMOKE_TEXT");
  const perfSessionEnd = source.indexOf(
    "globalThis.endPerfSession?.()",
    longSceneAutosave,
  );

  assert.ok(perfSessionStart >= 0);
  assert.ok(seedBatch >= 0);
  assert.ok(seedBatch < actualCardinalityQuery);
  assert.ok(actualCardinalityQuery < actualCardinalityInvoke);
  assert.ok(actualCardinalityInvoke < actualCardinalityAssignment);
  assert.ok(actualCardinalityAssignment < inputTargetSelection);
  const idleDrain = source.indexOf("await waitForRuntimeEditorIdle(page)");
  assert.ok(idleDrain >= 0);
  assert.ok(idleDrain < inputTargetSelection);
  assert.ok(inputTargetSelection < perfSessionStart);
  assert.ok(perfSessionStart < longSceneInput);
  assert.ok(longSceneInput < inputSnapshot);
  assert.ok(inputSnapshot < longSceneAutosave);
  assert.ok(longSceneInput < longSceneAutosave);
  assert.ok(longSceneAutosave < perfSessionEnd);
  assert.ok(perfSessionEnd < smokeSceneCreate);
  assert.ok(smokeSceneCreate < smokeSceneInput);
  assert.match(
    source,
    /performanceMetrics\.fixture\.editorInputSceneId = PERF_SCENE_ID/,
  );
  assert.match(
    source,
    /performanceMetrics\.fixture\.autosaveSceneId = PERF_SCENE_ID/,
  );
  assert.match(
    source,
    /performanceMetrics\.fixture\.editorInputTargetVerified = true/,
  );
  assert.match(source, /grimodex\.editorInputReady/);
  assert.doesNotMatch(source, /await perfScene\.click\(\)/);
  assert.equal(
    source.match(/globalThis\.startPerfSession\?\.\(\)/g)?.length,
    11,
  );
  assert.equal(
    source.match(/globalThis\.snapshotPerfSession\?\.\(\)/g)?.length,
    2,
  );
  assert.equal(source.match(/globalThis\.endPerfSession\?\.\(\)/g)?.length, 11);
  assert.match(source, /performanceMetrics\.interactions\.treeFilter = \{/);
  assert.match(source, /performanceMetrics\.interactions\.linearScroll = \{/);
  assert.match(source, /\.react-flow__node/);
  assert.match(source, /\.react-flow__edge/);
  assert.match(source, /Map drag persists changed x\/y/);
  assert.match(source, /new MutationObserver/);
  assert.match(source, /performanceMetrics\.interactions\.mapDrag = \{/);
  assert.match(source, /"map\.dragIdentity"/);
  assert.match(source, /targetNodeObjectIdentityChanged/);
  assert.match(source, /unrelatedNodeObjectIdentityChanges/);
  assert.match(source, /unrelatedNodeRenderCount/);
  assert.match(source, /unrelatedChildListReplacements/);
  assert.match(source, /hidePanelIfVisible/);
  assert.match(source, /activePanelsInPersistedLayout/);
  assert.doesNotMatch(
    source,
    /for \(const panelId of \["timeline", "map", "grid"\]\)/,
  );
  assert.match(source, /treeFilterSession\?\.longtask/);
  assert.match(
    source,
    /linearSession\?\.counters\?\.\["linear\.activeDetection\.sceneRectReads"\]/,
  );
  assert.match(
    source,
    /extractInteractionFrameMetrics\(\s*timelineSession,\s*"timeline\.pointerFrame\.interval",\s*"timeline\.pointerFrame\.work",?\s*\)/,
  );
  assert.match(
    source,
    /extractInteractionFrameMetrics\(\s*chronicleSession,\s*"chronicle\.viewportFrame\.interval",\s*"chronicle\.viewportFrame\.work",?\s*\)/,
  );
  assert.match(source, /const INTERACTION_FRAME_SAMPLE_COUNT = 120/);
  assert.match(source, /async function drivePointerMoveFrames/);
  assert.equal(
    source.match(/await drivePointerMoveFrames\(page,/g)?.length,
    2,
    "Timeline and Chronicle must drive real pointer work throughout the sample",
  );
  assert.match(source, /frameIndex < frameCount/);
  assert.match(
    source,
    /await new Promise\(\(resolve\) => requestAnimationFrame/,
  );
  assert.match(source, /workFrameCount:/);
  assert.match(source, /workCoverage:/);
  assert.match(source, /p50FrameMs:/);
  assert.match(source, /p95FrameMs:/);
  assert.match(source, /meanFrameMs:/);
  assert.match(source, /GRIMODEX_PERF_REVIEW_FIXTURE/);
  assert.match(
    source,
    /sample\.measurement !== performanceMetrics\.memory\.measurement/,
  );
  assert.match(
    source,
    /performanceMetrics\.memory\.startupBytes =\s+startupMemorySample\?\.measuredBytes/,
  );
  assert.match(source, /performanceMetrics\.memory\.peakProcesses = processes/);
  assert.match(
    source,
    /async function pauseMemorySamplerForInteraction\(memorySampler\)/,
  );
  assert.match(
    source,
    /const resumeMemorySampler =\s+await pauseMemorySamplerForInteraction\(memorySampler\)/,
  );
  assert.equal(
    source.match(/await resumeMemorySampler\(\)/g)?.length,
    2,
    "Timeline and Chronicle must resume sampling after their frame sessions",
  );
  assert.match(
    source,
    /let timelineSessionStarted = false;\s+try \{\s+await page\.evaluate\(\(\) => globalThis\.startPerfSession\?\.\(\)\);\s+timelineSessionStarted = true;/,
  );
  const chronicleMeasure = source.indexOf(
    "async function measureChroniclePan(page, memorySampler)",
  );
  const chronicleTargetMove = source.indexOf(
    "await page.mouse.move(x, y)",
    chronicleMeasure,
  );
  const chronicleSetupSettle = source.indexOf(
    "requestAnimationFrame(() => requestAnimationFrame(resolve))",
    chronicleTargetMove,
  );
  const chronicleSessionStart = source.indexOf(
    "globalThis.startPerfSession?.()",
    chronicleSetupSettle,
  );
  const chroniclePointerDown = source.indexOf(
    'await page.mouse.down({ button: "middle" })',
    chronicleSessionStart,
  );
  assert.ok(
    chronicleMeasure >= 0 &&
      chronicleMeasure < chronicleTargetMove &&
      chronicleTargetMove < chronicleSetupSettle &&
      chronicleSetupSettle < chronicleSessionStart &&
      chronicleSessionStart < chroniclePointerDown,
    "Chronicle hover/compositing setup must settle before the scoped pan session",
  );
  const chronicleMeasureEnd = source.indexOf(
    "function shouldMeasureReviewScenario",
    chronicleMeasure,
  );
  const chronicleMeasureSource = source.slice(
    chronicleMeasure,
    chronicleMeasureEnd,
  );
  assert.match(chronicleMeasureSource, /data-chronicle-total-event-count/);
  assert.match(chronicleMeasureSource, /data-chronicle-rendered-marker-count/);
  assert.match(chronicleMeasureSource, /data-background-renderer/);
  assert.match(chronicleMeasureSource, /data-background-fallback-reason/);
  assert.match(chronicleMeasureSource, /data-zen-shader-renderer/);
  assert.match(chronicleMeasureSource, /data-zen-glass-compositor/);
  assert.match(chronicleMeasureSource, /data-ambient-glass-surface/);
  assert.match(
    chronicleMeasureSource,
    /graphicsTopology\.ambientBackgroundRenderer !== "fallback"\s*\|\|\s*\(\s*!graphicsTopology\.sharedCompositorPresent\s*&&\s*graphicsTopology\.chronicleHostBackdropFilter === "none"\s*\)/,
    "Chronicle fallback must not retain the shared compositor or host backdrop filter",
  );
  assert.match(
    chronicleMeasureSource,
    /targetVerified:\s+fallbackTopologyVerified\s*&&/,
    "Chronicle fallback topology must flow through the existing runtime budget gate",
  );
  assert.match(
    chronicleMeasureSource,
    /graphicsTopology:\s*\{\s*\.\.\.graphicsTopology,\s*fallbackTopologyVerified,\s*\}/,
    "Chronicle artifacts must retain the observed graphics topology",
  );
  assert.match(
    chronicleMeasureSource,
    /renderedMarkers < totalEvents/,
    "Chronicle readiness must prove the large state is DOM-windowed",
  );
  assert.doesNotMatch(
    chronicleMeasureSource,
    /querySelectorAll\("#chronicle-track \[data-event-id\]"\)\.length\s*>=/,
    "fixture cardinality is independently verified from SQLite, not full DOM materialization",
  );
  assert.match(
    source,
    /if \(timelineSessionStarted\) \{\s+timelineSession = await page\.evaluate/,
  );
  assert.match(
    source,
    /if \(chronicleSessionStarted\) \{\s+chronicleSession = await page\.evaluate/,
  );
  assert.doesNotMatch(source, /metric\.memory\?\.private \?\?/);
  assert.match(source, /measureChatVirtualization\(page, memorySampler\)/);
  assert.match(source, /data-testid="chat-virtual-list"/);
  assert.match(source, /getAttribute\("aria-setsize"\)/);
  assert.match(source, /interactions\.chatScroll = \{/);
  assert.match(
    source,
    /invokeRuntimePerformanceControl\?\.\(\s*ownerToken,\s*"chat\.streamingDraft"/,
  );
  assert.match(source, /GRIMODEX_RUNTIME_PERFORMANCE_OWNER_TOKEN/);
  assert.match(source, /action: "prepare"/);
  assert.match(source, /action: "delta"/);
  assert.match(source, /action: "cleanup"/);
  assert.match(source, /interactions\.chatDraft = \{/);
  assert.match(source, /data-editor-loaded-document-id="\$\{PERF_SCENE_ID\}"/);
  assert.match(source, /const smokeSceneId = await smokeEditorSurface/);
  assert.doesNotMatch(source, /getByText\(DEFAULT_SCENE_TITLE/);
  assert.match(source, /const initialEditorPane = page/);
  assert.match(source, /if \(initialDocumentId !== persistedSmokeScene\.id\)/);
  assert.match(
    source,
    /data-editor-loaded-document-id="\$\{persistedSmokeScene\.id\}"/,
  );
  assert.match(source, /data-editor-document-loading="false"/);
  assert.match(source, /getByTestId\("editor-content-loading"\)/);
});

test("renderer startup does not preload the exact chat tokenizer", async () => {
  const source = await readFile(path.join(repoRoot, "src", "main.tsx"), "utf8");

  assert.doesNotMatch(source, /ensureTokenizer/);
  assert.doesNotMatch(source, /tiktoken/);
});
