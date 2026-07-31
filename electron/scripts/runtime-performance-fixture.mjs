function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export const RUNTIME_PERFORMANCE_INPUT_TEXT = "性能回帰入力".repeat(8);
export const RUNTIME_PERFORMANCE_STEADY_INPUT_TEXT = "定常保存入力".repeat(8);
export const RUNTIME_PERFORMANCE_AUTOSAVE_SAMPLE_COUNT = 3;

/**
 * Full review matrix from the performance review. These are deterministic
 * fixture contracts, not one giant Cartesian-product Electron run. Focused
 * benchmarks can select one row while the per-PR runtime gate remains small
 * enough to be stable on shared CI workers.
 */
export const RUNTIME_PERFORMANCE_REVIEW_MATRIX = deepFreeze({
  editor: [
    { id: "editor-5k", textChars: 5_000 },
    { id: "editor-50k", textChars: 50_000 },
    { id: "editor-200k", textChars: 200_000 },
  ],
  beatEditor: [
    { id: "beat-editor-0", beatCount: 0 },
    { id: "beat-editor-20", beatCount: 20 },
    { id: "beat-editor-200", beatCount: 200 },
  ],
  treeGrid: [
    { id: "tree-grid-500", nodeCount: 500 },
    { id: "tree-grid-2k", nodeCount: 2_000 },
    { id: "tree-grid-10k", nodeCount: 10_000 },
  ],
  linear: [
    { id: "linear-100", sceneCount: 100 },
    { id: "linear-500", sceneCount: 500 },
    { id: "linear-2k", sceneCount: 2_000 },
  ],
  chat: [
    { id: "chat-100", messageCount: 100 },
    { id: "chat-1k", messageCount: 1_000 },
    { id: "chat-5k", messageCount: 5_000 },
  ],
  timeline: [
    {
      id: "timeline-1k-scenes-100-threads-5k-markers-links",
      sceneCount: 1_000,
      threadCount: 100,
      markerLinkCount: 5_000,
    },
  ],
  chronicle: [
    { id: "chronicle-1k", eventCount: 1_000 },
    { id: "chronicle-5k", eventCount: 5_000 },
  ],
  map: [
    { id: "map-500", nodeCount: 500, edgeCount: 500 },
    { id: "map-2k", nodeCount: 2_000, edgeCount: 2_000 },
  ],
});

/**
 * Return independent plan objects so callers can annotate a selected review
 * case without mutating the canonical matrix.
 */
export function buildRuntimeReviewFixturePlans() {
  return Object.entries(RUNTIME_PERFORMANCE_REVIEW_MATRIX).flatMap(
    ([scenario, profiles]) =>
      profiles.map(({ id, ...cardinality }) => ({
        id,
        scenario,
        cardinality: { ...cardinality },
      })),
  );
}

export function resolveRuntimeReviewFixturePlan(planOrId) {
  const plans = buildRuntimeReviewFixturePlans();
  const requested =
    typeof planOrId === "string"
      ? plans.find((candidate) => candidate.id === planOrId)
      : planOrId;
  const canonical = plans.find(
    (candidate) =>
      candidate.id === requested?.id &&
      candidate.scenario === requested?.scenario,
  );
  if (!requested || !canonical) {
    throw new Error(`unknown runtime review fixture: ${String(planOrId)}`);
  }
  if (
    typeof planOrId !== "string" &&
    (Object.keys(requested.cardinality ?? {}).length !==
      Object.keys(canonical.cardinality).length ||
      !Object.entries(canonical.cardinality).every(
        ([key, value]) => requested.cardinality?.[key] === value,
      ))
  ) {
    throw new Error(`altered runtime review fixture: ${requested.id}`);
  }
  return canonical;
}

function fixtureId(prefix, index, total) {
  return `${prefix}-${String(index).padStart(String(total).length, "0")}`;
}

function buildSceneRecords(count, prefix) {
  return Array.from({ length: count }, (_, index) => ({
    id: fixtureId(`${prefix}-scene`, index, count),
    projectId: "default-project",
    parentId: null,
    nodeType: "scene",
    title: `PERF scene ${index + 1}`,
    synopsis: null,
    intent: null,
    content: `Runtime fixture scene ${index + 1}.`,
    charCount: `Runtime fixture scene ${index + 1}.`.length,
    sortOrder: String(index).padStart(String(count).length, "0"),
    status: null,
    storyTimeOrder: String(index).padStart(String(count).length, "0"),
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
}

/**
 * Materialize one full review-matrix row. Unlike
 * `buildRuntimeReviewFixturePlans`, this creates the actual deterministic data
 * that a focused renderer benchmark can pass to the target surface.
 */
export function buildRuntimeReviewFixture(planOrId) {
  const plan = resolveRuntimeReviewFixturePlan(planOrId);
  const fixture = {
    id: plan.id,
    scenario: plan.scenario,
    expectedCardinality: { ...plan.cardinality },
  };

  switch (plan.scenario) {
    case "editor":
      return {
        ...fixture,
        document: buildRuntimeEditorDocument({
          ...RUNTIME_PERFORMANCE_FIXTURE,
          seededTextChars: plan.cardinality.textChars,
          seededBeatCount: 0,
        }),
      };
    case "beatEditor":
      return {
        ...fixture,
        document: buildRuntimeEditorDocument({
          ...RUNTIME_PERFORMANCE_FIXTURE,
          seededTextChars:
            CANONICAL_RUNTIME_PERFORMANCE_PROFILE.editor.textChars,
          seededBeatCount: plan.cardinality.beatCount,
        }),
      };
    case "treeGrid": {
      const folderCount = Math.max(
        1,
        Math.floor(plan.cardinality.nodeCount / 50),
      );
      const folders = Array.from({ length: folderCount }, (_, index) => ({
        id: fixtureId(`${plan.id}-folder`, index, folderCount),
        projectId: "default-project",
        title: `PERF folder ${index + 1}`,
        nodeType: "folder",
        parentId: null,
        synopsis: null,
        intent: null,
        charCount: 0,
        sortOrder: String(index).padStart(String(folderCount).length, "0"),
        status: null,
        storyTimeOrder: null,
        storyTimeLabel: null,
        povCharacterId: null,
        locationId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }));
      const sceneCount = plan.cardinality.nodeCount - folderCount;
      const scenes = buildSceneRecords(sceneCount, plan.id).map(
        (scene, index) => ({
          ...scene,
          nodeType: "scene",
          parentId: folders[index % folders.length].id,
        }),
      );
      const nodes = [...folders, ...scenes];
      return { ...fixture, nodes };
    }
    case "linear":
      return {
        ...fixture,
        scenes: buildSceneRecords(plan.cardinality.sceneCount, plan.id),
      };
    case "chat":
      return {
        ...fixture,
        session: {
          id: `${plan.id}-session`,
          projectId: "default-project",
          nodeId: RUNTIME_PERFORMANCE_FIXTURE.sceneId,
          title: `Runtime ${plan.id}`,
          model: "runtime-fixture",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        messages: Array.from(
          { length: plan.cardinality.messageCount },
          (_, index) => ({
            id: fixtureId(
              `${plan.id}-message`,
              index,
              plan.cardinality.messageCount,
            ),
            role: index % 2 === 0 ? "user" : "assistant",
            content: `Runtime fixture message ${index + 1}.`,
            sessionId: `${plan.id}-session`,
            model: index % 2 === 0 ? null : "runtime-fixture",
            metadata: null,
            createdAt: new Date(index * 1_000).toISOString(),
          }),
        ),
      };
    case "timeline": {
      const scenes = buildSceneRecords(plan.cardinality.sceneCount, plan.id);
      const threads = Array.from(
        { length: plan.cardinality.threadCount },
        (_, index) => ({
          id: fixtureId(
            `${plan.id}-thread`,
            index,
            plan.cardinality.threadCount,
          ),
          name: `Thread ${index + 1}`,
          projectId: "default-project",
          color: null,
          description: null,
          sortOrder: String(index).padStart(
            String(plan.cardinality.threadCount).length,
            "0",
          ),
          startNodeId: null,
          endNodeId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      // Timeline markers are plot_thread_scene_links rows in production.
      // Materialize that actual surface contract instead of inventing a
      // second marker graph that no renderer consumes.
      const links = Array.from(
        { length: plan.cardinality.markerLinkCount },
        (_, index) => ({
          id: fixtureId(
            `${plan.id}-link`,
            index,
            plan.cardinality.markerLinkCount,
          ),
          threadId: threads[index % threads.length].id,
          nodeId: scenes[index % scenes.length].id,
          phaseType: ["introduce", "develop", "turn", "climax", "resolve"][
            index % 5
          ],
          note: null,
          sortOrder: String(index).padStart(
            String(plan.cardinality.markerLinkCount).length,
            "0",
          ),
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      return { ...fixture, scenes, threads, links };
    }
    case "chronicle": {
      const events = Array.from(
        { length: plan.cardinality.eventCount },
        (_, index) => ({
          id: fixtureId(`${plan.id}-event`, index, plan.cardinality.eventCount),
          projectId: "default-project",
          title: `Event ${index + 1}`,
          note: null,
          detail: null,
          startTime: index,
          endTime: index % 5 === 0 ? index + 1 : null,
          ordinal: String(index).padStart(
            String(plan.cardinality.eventCount).length,
            "0",
          ),
          primaryCodexId: null,
          laneGroup: null,
          locationCodexId: null,
          startMinute: null,
          endMinute: null,
          startGranularity: "day",
          endGranularity: "day",
          precision: "exact",
          kind: "generic",
          secret: false,
          revealSceneId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          version: 0,
        }),
      );
      const relationCount = Math.min(Math.max(events.length - 1, 0), 1_000);
      const relations = Array.from({ length: relationCount }, (_, index) => {
        const causeIndex = Math.floor(
          (index * Math.max(events.length - 1, 0)) / Math.max(relationCount, 1),
        );
        return {
          projectId: "default-project",
          causeEventId: events[causeIndex].id,
          effectEventId: events[causeIndex + 1].id,
        };
      });
      return {
        ...fixture,
        events,
        relations,
      };
    }
    case "map": {
      const scenes = buildSceneRecords(plan.cardinality.nodeCount, plan.id);
      const nodes = Array.from(
        { length: plan.cardinality.nodeCount },
        (_, index) => ({
          id: fixtureId(`${plan.id}-node`, index, plan.cardinality.nodeCount),
          boardId: `${plan.id}-board`,
          nodeRefType: "scene",
          treeNodeId: scenes[index].id,
          codexEntryId: null,
          snippetId: null,
          stickyId: null,
          aiBranchId: null,
          x: (index % 50) * 180,
          y: Math.floor(index / 50) * 120,
          pinned: 0,
          zIndex: index,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const edges = Array.from(
        { length: plan.cardinality.edgeCount },
        (_, index) => ({
          id: fixtureId(`${plan.id}-edge`, index, plan.cardinality.edgeCount),
          boardId: `${plan.id}-board`,
          fromPositionId: nodes[index % nodes.length].id,
          toPositionId: nodes[(index + 1) % nodes.length].id,
          forwardLabel: null,
          backwardLabel: null,
          labels: "[]",
          style: "solid",
          color: "#64748b",
          direction: "none",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      return { ...fixture, scenes, nodes, edges };
    }
    default:
      throw new Error(`unsupported runtime review scenario: ${plan.scenario}`);
  }
}

function editorDocumentCardinality(serializedDocument) {
  const document = JSON.parse(serializedDocument);
  let textChars = 0;
  let beatCount = 0;
  for (const node of document.content ?? []) {
    if (node.type === "sceneBeat") beatCount += 1;
    if (node.type === "paragraph") {
      for (const child of node.content ?? []) {
        textChars += child.text?.length ?? 0;
      }
    }
  }
  return { textChars, beatCount };
}

/** Verify the data that was materialized, not merely the matrix declaration. */
export function measureRuntimeReviewFixtureCardinality(fixture) {
  switch (fixture.scenario) {
    case "editor":
      return {
        textChars: editorDocumentCardinality(fixture.document).textChars,
      };
    case "beatEditor":
      return {
        beatCount: editorDocumentCardinality(fixture.document).beatCount,
      };
    case "treeGrid":
      return { nodeCount: fixture.nodes.length };
    case "linear":
      return { sceneCount: fixture.scenes.length };
    case "chat":
      return { messageCount: fixture.messages.length };
    case "timeline":
      return {
        sceneCount: fixture.scenes.length,
        threadCount: fixture.threads.length,
        markerLinkCount: fixture.links.length,
      };
    case "chronicle":
      return { eventCount: fixture.events.length };
    case "map":
      return {
        nodeCount: fixture.nodes.length,
        edgeCount: fixture.edges.length,
      };
    default:
      throw new Error(
        `unsupported runtime review scenario: ${fixture.scenario}`,
      );
  }
}

export const CANONICAL_RUNTIME_PERFORMANCE_PROFILE = deepFreeze({
  id: "long-scene-50k-20-beats-v2",
  editor: {
    textChars: 50_000,
    beatCount: 20,
  },
  project: {
    collectionSceneCount: 500,
  },
  timeline: {
    threadCount: 100,
    markerLinkCount: 5_000,
  },
  chronicle: {
    eventCount: 1_000,
  },
  map: {
    nodeCount: 500,
    edgeCount: 500,
  },
});

export function buildRuntimePerformanceFixtureProfile(
  definition = CANONICAL_RUNTIME_PERFORMANCE_PROFILE,
) {
  const textChars = definition?.editor?.textChars;
  const beatCount = definition?.editor?.beatCount;
  const collectionSceneCount = definition?.project?.collectionSceneCount;
  const timelineThreadCount = definition?.timeline?.threadCount;
  const timelineMarkerLinkCount = definition?.timeline?.markerLinkCount;
  const chronicleEventCount = definition?.chronicle?.eventCount;
  const mapNodeCount = definition?.map?.nodeCount;
  const mapEdgeCount = definition?.map?.edgeCount;
  const chatMessageCount = definition?.chat?.messageCount ?? 0;
  for (const [label, value] of [
    ["editor.textChars", textChars],
    ["editor.beatCount", beatCount],
    ["project.collectionSceneCount", collectionSceneCount],
    ["timeline.threadCount", timelineThreadCount],
    ["timeline.markerLinkCount", timelineMarkerLinkCount],
    ["chronicle.eventCount", chronicleEventCount],
    ["map.nodeCount", mapNodeCount],
    ["map.edgeCount", mapEdgeCount],
    ["chat.messageCount", chatMessageCount],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`runtime performance profile ${label} must be >= 0`);
    }
  }
  if (
    mapNodeCount >
    collectionSceneCount + RUNTIME_PERFORMANCE_AUTOSAVE_SAMPLE_COUNT
  ) {
    throw new Error(
      "runtime performance profile map.nodeCount exceeds available scenes",
    );
  }
  if (timelineMarkerLinkCount > 0 && timelineThreadCount === 0) {
    throw new Error(
      "runtime performance profile timeline links require at least one thread",
    );
  }
  if (mapEdgeCount > 0 && mapNodeCount < 2) {
    throw new Error(
      "runtime performance profile map edges require at least two nodes",
    );
  }

  const autosaveSampleScenes = Object.freeze(
    Array.from(
      { length: RUNTIME_PERFORMANCE_AUTOSAVE_SAMPLE_COUNT },
      (_, index) => {
        const collectionIndex = index - 1;
        const isCollectionScene =
          collectionIndex >= 0 && collectionIndex < collectionSceneCount;
        return Object.freeze({
          id:
            index === 0
              ? "grimodex-runtime-perf-seeded-scene"
              : isCollectionScene
                ? `grimodex-runtime-perf-scene-${String(collectionIndex).padStart(3, "0")}`
                : `grimodex-runtime-perf-autosave-scene-${index + 1}`,
          title:
            index === 0
              ? "PERF AUTOSAVE SAMPLE 1"
              : isCollectionScene
                ? `PERF SCENE ${String(collectionIndex + 1).padStart(3, "0")}`
                : `PERF AUTOSAVE SAMPLE ${index + 1}`,
          isCollectionScene,
        });
      },
    ),
  );
  const autosaveExtraSceneCount = autosaveSampleScenes.filter(
    (scene, index) => index > 0 && !scene.isCollectionScene,
  ).length;
  return Object.freeze({
    id: definition.id,
    reviewFixtureId: definition.reviewFixtureId ?? null,
    reviewScenario: definition.reviewScenario ?? null,
    reviewCardinalityJson:
      definition.reviewCardinality == null
        ? null
        : JSON.stringify(definition.reviewCardinality),
    sceneId: autosaveSampleScenes[0].id,
    sceneTitle: autosaveSampleScenes[0].title,
    autosaveSampleScenes,
    autosaveExtraSceneCount,
    folderId: "grimodex-runtime-perf-scenes",
    boardId: "grimodex-runtime-perf-board",
    inputAnchorText: "今日は晴れです。",
    seededTextChars: textChars,
    seededBeatCount: beatCount,
    collectionSceneCount,
    timelineThreadCount,
    timelineMarkerLinkCount,
    chronicleEventCount,
    mapNodeCount,
    mapEdgeCount,
    chatMessageCount,
    chatSessionId:
      chatMessageCount > 0
        ? `${definition.reviewFixtureId ?? definition.id}-session`
        : null,
  });
}

export const RUNTIME_PERFORMANCE_FIXTURE =
  buildRuntimePerformanceFixtureProfile();

/**
 * Expand one review-matrix row into the complete runtime seed contract.
 *
 * The focused profiles keep the editor/persistence path that proves the
 * benchmark is running against the production renderer, while seeding only the
 * selected large-data surface. This prevents a `linear-100` run from silently
 * becoming a 500-scene run merely because the canonical Map fixture also needs
 * 500 scene references.
 */
export function buildRuntimePerformanceFixtureForReview(reviewFixtureId) {
  if (reviewFixtureId == null) return RUNTIME_PERFORMANCE_FIXTURE;
  const plan = resolveRuntimeReviewFixturePlan(reviewFixtureId);
  const definition = {
    id: plan.id,
    reviewFixtureId: plan.id,
    reviewScenario: plan.scenario,
    reviewCardinality: plan.cardinality,
    editor: {
      ...CANONICAL_RUNTIME_PERFORMANCE_PROFILE.editor,
    },
    project: {
      collectionSceneCount: 0,
    },
    timeline: {
      threadCount: 0,
      markerLinkCount: 0,
    },
    chronicle: {
      eventCount: 0,
    },
    map: {
      nodeCount: 0,
      edgeCount: 0,
    },
    chat: {
      messageCount: 0,
    },
  };

  switch (plan.scenario) {
    case "editor":
      definition.editor.textChars = plan.cardinality.textChars;
      break;
    case "beatEditor":
      definition.editor.beatCount = plan.cardinality.beatCount;
      break;
    case "treeGrid":
      // The primary editor scene and fixture folder sit outside the requested
      // collection cardinality. Autosave samples 2/3 reuse collection scenes.
      definition.project.collectionSceneCount = Math.max(
        0,
        plan.cardinality.nodeCount - 2,
      );
      break;
    case "linear":
      // The primary editor scene participates in Linear mode; autosave samples
      // 2/3 reuse the first collection scenes.
      definition.project.collectionSceneCount = Math.max(
        0,
        plan.cardinality.sceneCount - 1,
      );
      break;
    case "chat":
      definition.chat.messageCount = plan.cardinality.messageCount;
      break;
    case "timeline":
      definition.project.collectionSceneCount = Math.max(
        0,
        plan.cardinality.sceneCount - 1,
      );
      definition.timeline.threadCount = plan.cardinality.threadCount;
      definition.timeline.markerLinkCount = plan.cardinality.markerLinkCount;
      break;
    case "chronicle":
      definition.chronicle.eventCount = plan.cardinality.eventCount;
      break;
    case "map":
      definition.project.collectionSceneCount = Math.max(
        0,
        plan.cardinality.nodeCount - 1,
      );
      definition.map.nodeCount = plan.cardinality.nodeCount;
      definition.map.edgeCount = plan.cardinality.edgeCount;
      break;
    default:
      throw new Error(`unsupported runtime review scenario: ${plan.scenario}`);
  }

  return buildRuntimePerformanceFixtureProfile(definition);
}

export function buildRuntimeEditorDocument(
  profile = RUNTIME_PERFORMANCE_FIXTURE,
) {
  const inputAnchorText = profile.inputAnchorText;
  const bodyCharacterCount = profile.seededTextChars - inputAnchorText.length;
  if (bodyCharacterCount < 0) {
    throw new Error(
      "runtime performance fixture body must fit the input anchor",
    );
  }
  if (
    !Number.isSafeInteger(profile.seededBeatCount) ||
    profile.seededBeatCount < 0
  ) {
    throw new Error("runtime performance fixture Beat count must be >= 0");
  }
  const longSceneText = "本文"
    .repeat(Math.ceil(bodyCharacterCount / 2))
    .slice(0, bodyCharacterCount);
  // Keep the contracted 50k-character document while providing a deterministic
  // short paragraph for native DOM selection. Input latency must measure
  // application-level whole-document work, not Chromium collapsing a Selection
  // at an arbitrary point in a 1,000-character text node.
  const content = [
    {
      type: "paragraph",
      content: [{ type: "text", text: inputAnchorText }],
    },
  ];
  const paragraphSize = 1_000;
  const paragraphCount = Math.ceil(longSceneText.length / paragraphSize);

  for (
    let paragraphIndex = 0;
    paragraphIndex < paragraphCount;
    paragraphIndex += 1
  ) {
    const start = paragraphIndex * paragraphSize;
    content.push({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: longSceneText.slice(start, start + paragraphSize),
        },
      ],
    });

    const beatsThroughThisParagraph = Math.floor(
      ((paragraphIndex + 1) * profile.seededBeatCount) / paragraphCount,
    );
    const beatsThroughPreviousParagraph = Math.floor(
      (paragraphIndex * profile.seededBeatCount) / paragraphCount,
    );
    for (
      let beatIndex = beatsThroughPreviousParagraph;
      beatIndex < beatsThroughThisParagraph;
      beatIndex += 1
    ) {
      content.push({
        type: "sceneBeat",
        attrs: {
          id: `runtime-perf-beat-${beatIndex}`,
          collapsed: false,
          beatType: "free",
          pov: null,
        },
        content: [{ type: "text", text: `Beat ${beatIndex}` }],
      });
    }
  }

  return JSON.stringify({ type: "doc", content });
}

/**
 * Reproduce the deterministic ProseMirror JSON after the smoke harness types
 * into the input-anchor paragraph. The runtime byte counter encodes this exact
 * JSON as UTF-8 immediately before the domain save IPC.
 */
export function buildRuntimeEditorDocumentAfterInput(
  profile = RUNTIME_PERFORMANCE_FIXTURE,
  inputText = RUNTIME_PERFORMANCE_INPUT_TEXT,
) {
  const document = JSON.parse(buildRuntimeEditorDocument(profile));
  const anchorText = document.content?.[0]?.content?.[0];
  if (anchorText?.type !== "text" || typeof anchorText.text !== "string") {
    throw new Error("runtime input anchor text node is missing");
  }
  anchorText.text += inputText;
  return JSON.stringify(document);
}

export function measureRuntimeEditorSerializedBytesAfterInput(
  profile = RUNTIME_PERFORMANCE_FIXTURE,
  inputText = RUNTIME_PERFORMANCE_INPUT_TEXT,
) {
  return new TextEncoder().encode(
    buildRuntimeEditorDocumentAfterInput(profile, inputText),
  ).byteLength;
}

function buildSeededEditorTabState(profile = RUNTIME_PERFORMANCE_FIXTURE) {
  return JSON.stringify({
    tabs: profile.autosaveSampleScenes.map((scene) => ({
      nodeId: scene.id,
      isPreview: false,
      contentType: "scene",
    })),
    activeTabId: profile.sceneId,
    secondaryTabs: [],
    secondaryActiveTabId: null,
    activeGroupIndex: 0,
    secondaryGroupOpen: false,
    splitDirection: "right",
    isLinearMode: false,
  });
}

export function buildRuntimeFixtureStatements(
  profile = RUNTIME_PERFORMANCE_FIXTURE,
) {
  const longDocument = buildRuntimeEditorDocument(profile);
  const statements = [
    {
      sql: `INSERT INTO tree_nodes
        (id, project_id, node_type, title, content, char_count, sort_order,
         chronicle_start_time, chronicle_start_granularity)
        VALUES (?, 'default-project', 'scene', ?, ?, ?, 'a0', 0, 'day')`,
      params: [
        profile.sceneId,
        profile.sceneTitle,
        longDocument,
        profile.seededTextChars,
      ],
      method: "run",
    },
    {
      sql: `INSERT INTO tree_nodes
        (id, project_id, node_type, title, sort_order)
        VALUES (?, 'default-project', 'folder', 'PERF LARGE FIXTURE', 'a1')`,
      params: [profile.folderId],
      method: "run",
    },
    {
      sql: `INSERT INTO map_boards
        (id, project_id, title, sort_order, mode, show_config)
        VALUES (?, 'default-project', 'PERF LARGE BOARD', -1, 'free', '{}')`,
      params: [profile.boardId],
      method: "run",
    },
    {
      // The measured launch must represent a returning writer whose active
      // document opens without a synthetic Playwright click. Persist the same
      // tab state the product writes through tabStore.saveTabState().
      sql: `INSERT INTO project_settings (project_id, key, value)
        VALUES ('default-project', 'editor.tabState', ?)
        ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value`,
      params: [buildSeededEditorTabState(profile)],
      method: "run",
    },
  ];

  for (const [index, scene] of profile.autosaveSampleScenes.entries()) {
    if (scene.id === profile.sceneId || scene.isCollectionScene) continue;
    statements.push({
      sql: `INSERT INTO tree_nodes
        (id, project_id, parent_id, node_type, title, content, char_count, sort_order,
         chronicle_start_time, chronicle_start_granularity)
        VALUES (?, 'default-project', ?, 'scene', ?, ?, ?, ?, 0, 'day')`,
      params: [
        scene.id,
        profile.folderId,
        scene.title,
        longDocument,
        profile.seededTextChars,
        `a0-${index}`,
      ],
      method: "run",
    });
  }

  const sceneIds = profile.autosaveSampleScenes.map((scene) => scene.id);
  for (let index = 0; index < profile.collectionSceneCount; index += 1) {
    const sceneId = `grimodex-runtime-perf-scene-${String(index).padStart(3, "0")}`;
    const sampleScene = profile.autosaveSampleScenes.find(
      (scene) => scene.id === sceneId,
    );
    const sceneText =
      `PERF scene ${String(index + 1).padStart(3, "0")} virtualized body. `.repeat(
        20,
      );
    const sceneDocument = sampleScene
      ? longDocument
      : JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: sceneText }],
            },
          ],
        });
    if (!sceneIds.includes(sceneId)) sceneIds.push(sceneId);
    statements.push({
      sql: `INSERT INTO tree_nodes
        (id, project_id, parent_id, node_type, title, content, char_count, sort_order, story_time_order)
        VALUES (?, 'default-project', ?, 'scene', ?, ?, ?, 'a0', ?)`,
      params: [
        sceneId,
        profile.folderId,
        sampleScene?.title ??
          `PERF SCENE ${String(index + 1).padStart(3, "0")}`,
        sceneDocument,
        sampleScene ? profile.seededTextChars : sceneText.length,
        String(index).padStart(4, "0"),
      ],
      method: "run",
    });
  }

  const mapPositionIds = [];
  for (let index = 0; index < profile.mapNodeCount; index += 1) {
    const sceneId = sceneIds[index];
    const positionId = `grimodex-runtime-perf-position-${String(index).padStart(4, "0")}`;
    mapPositionIds.push(positionId);
    statements.push({
      sql: `INSERT INTO map_node_positions
        (id, board_id, node_ref_type, tree_node_id, x, y, z_index)
        SELECT ?, id, 'scene', ?, ?, ?, ?
        FROM map_boards
        WHERE id = ?`,
      params: [
        positionId,
        sceneId,
        (index % 18) * 240,
        Math.floor(index / 18) * 140,
        index,
        profile.boardId,
      ],
      method: "run",
    });
  }

  for (let index = 0; index < profile.mapEdgeCount; index += 1) {
    statements.push({
      sql: `INSERT INTO map_edges
        (id, board_id, from_position_id, to_position_id, labels, style, color, direction)
        VALUES (?, ?, ?, ?, '[]', 'solid', '#64748b', 'none')`,
      params: [
        `grimodex-runtime-perf-edge-${String(index).padStart(4, "0")}`,
        profile.boardId,
        mapPositionIds[index % mapPositionIds.length],
        mapPositionIds[(index + 1) % mapPositionIds.length],
      ],
      method: "run",
    });
  }

  const timelineThreadIds = [];
  for (let index = 0; index < profile.timelineThreadCount; index += 1) {
    const threadId = `grimodex-runtime-perf-thread-${String(index).padStart(3, "0")}`;
    timelineThreadIds.push(threadId);
    statements.push({
      sql: `INSERT INTO plot_threads
        (id, project_id, name, color, sort_order)
        VALUES (?, 'default-project', ?, ?, ?)`,
      params: [
        threadId,
        `PERF THREAD ${String(index + 1).padStart(3, "0")}`,
        `hsl(${(index * 47) % 360} 70% 55%)`,
        String(index).padStart(4, "0"),
      ],
      method: "run",
    });
  }

  const phaseTypes = ["introduce", "develop", "turn", "climax", "resolve"];
  for (let index = 0; index < profile.timelineMarkerLinkCount; index += 1) {
    statements.push({
      sql: `INSERT INTO plot_thread_scene_links
        (id, thread_id, node_id, phase_type, sort_order)
        VALUES (?, ?, ?, ?, ?)`,
      params: [
        `grimodex-runtime-perf-marker-link-${String(index).padStart(5, "0")}`,
        timelineThreadIds[index % timelineThreadIds.length],
        sceneIds[index % sceneIds.length],
        phaseTypes[index % phaseTypes.length],
        String(index).padStart(5, "0"),
      ],
      method: "run",
    });
  }

  for (let index = 0; index < profile.chronicleEventCount; index += 1) {
    statements.push({
      sql: `INSERT INTO events
        (id, project_id, title, ordinal, start_time, end_time,
         start_granularity, end_granularity, precision, kind, secret)
        VALUES (?, 'default-project', ?, ?, ?, ?, 'day', 'day', 'exact', 'generic', 0)`,
      params: [
        `grimodex-runtime-perf-event-${String(index).padStart(4, "0")}`,
        `PERF EVENT ${String(index + 1).padStart(4, "0")}`,
        String(index).padStart(5, "0"),
        index,
        index % 5 === 0 ? index + 1 : null,
      ],
      method: "run",
    });
  }
  // Exercise the real causal-edge SVG/windowing path without turning the
  // event cardinality matrix into an all-pairs graph. Relations are spread
  // across the full story-time range so every horizontal projection contains
  // representative edges.
  const chronicleRelationCount = Math.min(
    Math.max(profile.chronicleEventCount - 1, 0),
    1_000,
  );
  for (let index = 0; index < chronicleRelationCount; index += 1) {
    const causeIndex = Math.floor(
      (index * Math.max(profile.chronicleEventCount - 1, 0)) /
        Math.max(chronicleRelationCount, 1),
    );
    const effectIndex = causeIndex + 1;
    statements.push({
      sql: `INSERT INTO event_relations
        (project_id, cause_event_id, effect_event_id)
        VALUES ('default-project', ?, ?)`,
      params: [
        `grimodex-runtime-perf-event-${String(causeIndex).padStart(4, "0")}`,
        `grimodex-runtime-perf-event-${String(effectIndex).padStart(4, "0")}`,
      ],
      method: "run",
    });
  }

  if (profile.chatMessageCount > 0) {
    statements.push({
      sql: `INSERT INTO chat_sessions
        (id, project_id, node_id, title, model, created_at, updated_at)
        VALUES (?, 'default-project', ?, ?, 'runtime-fixture', ?, ?)`,
      params: [
        profile.chatSessionId,
        profile.sceneId,
        `Runtime ${profile.reviewFixtureId ?? profile.id}`,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ],
      method: "run",
    });
    for (let index = 0; index < profile.chatMessageCount; index += 1) {
      statements.push({
        sql: `INSERT INTO chat_messages
          (id, session_id, role, content, model, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
        params: [
          `grimodex-runtime-perf-chat-message-${String(index).padStart(5, "0")}`,
          profile.chatSessionId,
          index % 2 === 0 ? "user" : "assistant",
          `Runtime fixture message ${index + 1}.`,
          index % 2 === 0 ? null : "runtime-fixture",
          new Date(index * 1_000).toISOString(),
        ],
        method: "run",
      });
    }
  }

  return statements;
}

/**
 * Build a read-only query for the fixture rows that SQLite actually committed.
 *
 * Every predicate is pinned to a fixture-owned exact ID or ID prefix so an
 * unrelated project row cannot make the runtime contract pass accidentally.
 * This query is intentionally separate from `db_execute_batch`: the benchmark
 * must verify the persisted database, not count the batch it attempted to send.
 */
export function buildRuntimeFixtureActualCardinalityQuery(
  profile = RUNTIME_PERFORMANCE_FIXTURE,
) {
  return {
    sql: `SELECT
      (SELECT content FROM tree_nodes WHERE id = ?) AS editorContent,
      (SELECT COUNT(*) FROM tree_nodes
        WHERE id = ? OR id = ? OR id GLOB ?) AS treeNodeCount,
      (SELECT COUNT(*) FROM tree_nodes
        WHERE node_type = 'scene' AND (id = ? OR id GLOB ?)) AS sceneCount,
      (SELECT COUNT(*) FROM plot_threads
        WHERE project_id = 'default-project' AND id GLOB ?) AS threadCount,
      (SELECT COUNT(*) FROM plot_thread_scene_links
        WHERE id GLOB ?) AS markerLinkCount,
      (SELECT COUNT(*) FROM events
        WHERE project_id = 'default-project' AND id GLOB ?) AS eventCount,
      (SELECT COUNT(*) FROM map_node_positions
        WHERE board_id = ? AND id GLOB ?) AS mapNodeCount,
      (SELECT COUNT(*) FROM map_edges
        WHERE board_id = ? AND id GLOB ?) AS mapEdgeCount,
      (SELECT COUNT(*) FROM chat_sessions
        WHERE id = ?) AS chatSessionCount,
      (SELECT COUNT(*) FROM chat_messages
        WHERE session_id = ? AND id GLOB ?) AS chatMessageCount`,
    params: [
      profile.sceneId,
      profile.sceneId,
      profile.folderId,
      "grimodex-runtime-perf-scene-*",
      profile.sceneId,
      "grimodex-runtime-perf-scene-*",
      "grimodex-runtime-perf-thread-*",
      "grimodex-runtime-perf-marker-link-*",
      "grimodex-runtime-perf-event-*",
      profile.boardId,
      "grimodex-runtime-perf-position-*",
      profile.boardId,
      "grimodex-runtime-perf-edge-*",
      profile.chatSessionId,
      profile.chatSessionId,
      "grimodex-runtime-perf-chat-message-*",
    ],
    method: "all",
  };
}

function actualCardinalityCount(row, field) {
  const value = Number(row?.[field]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `runtime fixture actual cardinality ${field} must be a non-negative integer`,
    );
  }
  return value;
}

/**
 * Convert the real SQLite cardinality row into the stable metrics contract.
 */
export function parseRuntimeFixtureActualCardinality(rows) {
  const row = rows?.[0];
  if (!row) {
    throw new Error("runtime fixture cardinality query returned no row");
  }
  if (typeof row.editorContent !== "string") {
    throw new Error(
      "runtime fixture cardinality query returned no editor content",
    );
  }

  let editor;
  try {
    editor = editorDocumentCardinality(row.editorContent);
  } catch (error) {
    throw new Error("runtime fixture editor content is not valid JSON", {
      cause: error,
    });
  }

  return {
    textChars: editor.textChars,
    beatCount: editor.beatCount,
    treeNodeCount: actualCardinalityCount(row, "treeNodeCount"),
    sceneCount: actualCardinalityCount(row, "sceneCount"),
    threadCount: actualCardinalityCount(row, "threadCount"),
    markerLinkCount: actualCardinalityCount(row, "markerLinkCount"),
    eventCount: actualCardinalityCount(row, "eventCount"),
    mapNodeCount: actualCardinalityCount(row, "mapNodeCount"),
    mapEdgeCount: actualCardinalityCount(row, "mapEdgeCount"),
    chatSessionCount: actualCardinalityCount(row, "chatSessionCount"),
    chatMessageCount: actualCardinalityCount(row, "chatMessageCount"),
  };
}

function statementsForTable(statements, tableName) {
  return statements.filter((statement) =>
    statement.sql.includes(`INSERT INTO ${tableName}`),
  );
}

/**
 * Count the rows/doc cardinality that the real SQLite seed batch will receive.
 * Review tests use this instead of trusting the higher-level fixture object.
 */
export function measureRuntimeFixtureStatementCardinality(statements, profile) {
  const primaryScene = statements.find(
    (statement) =>
      statement.method === "run" && statement.params?.[0] === profile.sceneId,
  );
  if (!primaryScene) {
    throw new Error(`runtime seed scene is missing: ${profile.sceneId}`);
  }
  const editor = editorDocumentCardinality(primaryScene.params[2]);
  const treeNodes = statementsForTable(statements, "tree_nodes");
  const scenes = treeNodes.filter((statement) => /'scene'/.test(statement.sql));

  switch (profile.reviewScenario) {
    case "editor":
      return { textChars: editor.textChars };
    case "beatEditor":
      return { beatCount: editor.beatCount };
    case "treeGrid":
      return { nodeCount: treeNodes.length };
    case "linear":
      return { sceneCount: scenes.length };
    case "chat":
      return {
        messageCount: statementsForTable(statements, "chat_messages").length,
      };
    case "timeline":
      return {
        sceneCount: scenes.length,
        threadCount: statementsForTable(statements, "plot_threads").length,
        markerLinkCount: statementsForTable(
          statements,
          "plot_thread_scene_links",
        ).length,
      };
    case "chronicle":
      return { eventCount: statementsForTable(statements, "events").length };
    case "map":
      return {
        nodeCount: statementsForTable(statements, "map_node_positions").length,
        edgeCount: statementsForTable(statements, "map_edges").length,
      };
    case null:
      return {
        textChars: editor.textChars,
        beatCount: editor.beatCount,
        treeNodeCount: treeNodes.length,
        sceneCount: scenes.length,
        threadCount: statementsForTable(statements, "plot_threads").length,
        markerLinkCount: statementsForTable(
          statements,
          "plot_thread_scene_links",
        ).length,
        eventCount: statementsForTable(statements, "events").length,
        mapNodeCount: statementsForTable(statements, "map_node_positions")
          .length,
        mapEdgeCount: statementsForTable(statements, "map_edges").length,
        chatMessageCount: statementsForTable(statements, "chat_messages")
          .length,
      };
    default:
      throw new Error(
        `unsupported runtime review scenario: ${profile.reviewScenario}`,
      );
  }
}
