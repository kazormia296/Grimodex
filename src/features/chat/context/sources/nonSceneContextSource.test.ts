import { describe, expect, it, vi } from "vitest";
import type { CodexContextEntry } from "@/features/codex/api";
import type { CodexEntryPhase } from "@/features/codex/phaseApi";
import { buildSceneTimeIndex } from "@/features/codex/context/sceneTimeIndex";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { PinnedCodexEntryWithData } from "../../chatApi";
import {
  createNonSceneTurnContextRequest,
  type CreateNonSceneTurnContextRequestInput,
} from "../turnContextRequest";
import {
  collectNonSceneContext,
  createNonSceneContextSourceDeps,
  type AggregatedSceneInput,
} from "./nonSceneContextSource";

function scene(id: string, sortOrder: string): TreeNodeData {
  return {
    id,
    projectId: "project-1",
    parentId: null,
    nodeType: "scene",
    title: id,
    synopsis: null,
    intent: null,
    sortOrder,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 10,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function codexEntry(
  id: string,
  overrides: Partial<CodexContextEntry> = {},
): CodexContextEntry {
  return {
    id,
    projectId: "project-1",
    parentId: null,
    type: "character",
    name: id,
    aliases: null,
    excludedAliases: null,
    summary: `${id} base summary`,
    content: `${id} base content`,
    tagsCache: null,
    contextMode: "mentioned",
    childrenBudget: "compact",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as CodexContextEntry;
}

function phase(
  id: string,
  entryId: string,
  anchorNodeId: string,
  overrides: Partial<CodexEntryPhase> = {},
): CodexEntryPhase {
  return {
    id,
    entryId,
    anchorNodeId,
    label: id,
    summaryOverride: null,
    contentOverride: null,
    contextModeOverride: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function request(
  overrides: Partial<CreateNonSceneTurnContextRequestInput> = {},
) {
  const sceneOne = scene("scene-1", "a0");
  return createNonSceneTurnContextRequest({
    requestId: "context-request",
    purpose: "live",
    projectId: "project-1",
    sessionId: null,
    scope: { kind: "project" },
    containerScope: "project",
    scopeAnchorId: null,
    activeSceneId: sceneOne.id,
    activeProjectId: "project-1",
    agentToolsAvailable: false,
    mode: "chat",
    route: null,
    budget: { contextWindow: 8_192, deliveryMode: "plain" },
    messages: [],
    outgoingUserMessage: "",
    mentionedSceneIds: [],
    mentionedCodexIds: [],
    inputPinnedEntryIds: [],
    excludedAutoEntryIds: [],
    sessionStableCodexIds: [],
    includeBodies: true,
    map: { enabled: false, boardId: null, activeBoardId: null },
    activeTab: null,
    settings: {
      injectBeats: false,
      chronicleEnabled: false,
      semanticRecallEnabled: false,
      episodicRecallEnabled: false,
      hybridRecallEnabled: false,
      customChatInstruction: "",
    },
    trackRecallPromote: false,
    sourceSnapshot: {
      treeNodes: [sceneOne],
      plotThreadIds: [],
      plotThreadLinks: [],
    },
    ...overrides,
  });
}

describe("collectNonSceneContext", () => {
  it("uses Codex metadata first and loads full bodies only for selected non-scene context ids", async () => {
    const alice = codexEntry("alice");
    const bob = codexEntry("bob");
    const allEntries = [alice, bob];
    const metadata = allEntries.map(({ content: _content, ...entry }) => entry);
    const listCodexEntries = vi.fn(async () => {
      throw new Error("full all-entry load must not be used");
    });
    const listCodexContextMetadata = vi.fn(async () => metadata);
    const listCodexEntriesByIds = vi.fn(
      async (_projectId, ids: readonly string[]) =>
        ids.flatMap(
          (id) => allEntries.find((candidate) => candidate.id === id) ?? [],
        ),
    );
    const buildAggregatedScene = vi.fn(async (input: AggregatedSceneInput) => ({
      aggregatedScene: {
        id: input.anchorId,
        title: input.anchorTitle,
        content: "Alice appears in project synopsis",
      },
      aggregatedDetected: input.detectableEntries.filter(
        (entry) => entry.id === "alice",
      ),
    }));

    const result = await collectNonSceneContext(
      request({ scope: { kind: "project" } }),
      createNonSceneContextSourceDeps({
        fetchProjectContext: async () => ({ title: "Project", language: "en" }),
        listCodexEntries,
        listCodexContextMetadata,
        listCodexEntriesByIds,
        buildAggregatedScene,
      }),
    );

    expect(listCodexContextMetadata).toHaveBeenCalledWith("project-1");
    expect(listCodexEntries).not.toHaveBeenCalled();
    expect(listCodexEntriesByIds).toHaveBeenCalledWith("project-1", ["alice"]);
    expect(result.promptInput.codexEntries?.map((entry) => entry.id)).toEqual([
      "alice",
    ]);
  });

  it("builds a thread focus from its snapshotted members even in eco mode", async () => {
    const buildAggregatedScene = vi.fn(async () => ({
      aggregatedScene: {
        id: "thread-1",
        title: "Thread",
        content: "member body",
      },
      aggregatedDetected: [],
    }));
    const deps = createNonSceneContextSourceDeps({
      fetchProjectContext: async () => ({ title: "Project", language: "en" }),
      buildAggregatedScene,
    });
    const request = createNonSceneTurnContextRequest({
      requestId: "thread-request",
      purpose: "live",
      projectId: "project-1",
      sessionId: null,
      scope: { kind: "thread", threadId: "thread-1", title: "Thread" },
      containerScope: "scene",
      scopeAnchorId: null,
      activeSceneId: "scene-1",
      activeProjectId: "project-1",
      agentToolsAvailable: true,
      mode: "agent",
      route: null,
      budget: { contextWindow: 8_192, deliveryMode: "plain" },
      messages: [],
      outgoingUserMessage: "",
      mentionedSceneIds: [],
      mentionedCodexIds: [],
      inputPinnedEntryIds: [],
      excludedAutoEntryIds: [],
      sessionStableCodexIds: [],
      includeBodies: false,
      map: { enabled: false, boardId: null, activeBoardId: null },
      activeTab: null,
      settings: {
        injectBeats: false,
        chronicleEnabled: false,
        semanticRecallEnabled: false,
        episodicRecallEnabled: false,
        hybridRecallEnabled: false,
        customChatInstruction: "",
      },
      trackRecallPromote: false,
      sourceSnapshot: {
        treeNodes: [scene("scene-1", "a0"), scene("scene-2", "a1")],
        plotThreadIds: ["thread-1"],
        plotThreadLinks: [{ threadId: "thread-1", nodeId: "scene-1" }],
      },
    });

    const result = await collectNonSceneContext(request, deps);

    expect(buildAggregatedScene).toHaveBeenCalledWith(
      expect.objectContaining({
        includeBodies: true,
        agentMode: true,
        descendants: [expect.objectContaining({ id: "scene-1" })],
      }),
    );
    expect(result.promptInput.scene).toEqual({
      id: "",
      title: "",
      content: "",
    });
    expect(result.promptInput.focusSubject).toEqual({
      kind: "thread",
      name: "Thread",
      body: "member body",
    });
    expect(result.scopeAnchor).toBeNull();
  });

  it("fails when an explicit folder anchor is missing", async () => {
    await expect(
      collectNonSceneContext(
        request({ scope: { kind: "folder", folderId: "missing-folder" } }),
        createNonSceneContextSourceDeps(),
      ),
    ).rejects.toThrow("required folder context anchor is unavailable");
  });

  it("fails when an explicit codex anchor is missing", async () => {
    await expect(
      collectNonSceneContext(
        request({ scope: { kind: "codex", entryId: "missing-codex" } }),
        createNonSceneContextSourceDeps(),
      ),
    ).rejects.toThrow("required codex context anchor is unavailable");
  });

  it("fails when an explicit codex anchor resolves hidden", async () => {
    const hidden = codexEntry("hidden-codex", { contextMode: "hidden" });

    await expect(
      collectNonSceneContext(
        request({ scope: { kind: "codex", entryId: hidden.id } }),
        createNonSceneContextSourceDeps({
          fetchProjectContext: async () => ({
            title: "Project",
            language: "en",
          }),
          listCodexEntries: async () => [hidden],
        }),
      ),
    ).rejects.toThrow("required codex context anchor is unavailable or hidden");
  });

  it("fails when the captured project context is unavailable", async () => {
    await expect(
      collectNonSceneContext(
        request(),
        createNonSceneContextSourceDeps({
          fetchProjectContext: async () => null,
        }),
      ),
    ).rejects.toThrow("required project context is unavailable");
  });

  it("preserves always priority and active-scene temporal provenance", async () => {
    const always = codexEntry("always-1", { contextMode: "always" });
    const deps = createNonSceneContextSourceDeps({
      fetchProjectContext: async () => ({ title: "Project", language: "en" }),
      listCodexEntries: async () => [always],
      getTemporalResolution: () => ({
        sceneTimeIndex: buildSceneTimeIndex([scene("scene-1", "a0")]),
        resolutionMode: "story",
      }),
      buildAggregatedScene: async () => ({
        aggregatedScene: { id: "project-1", title: "Project", content: "" },
        aggregatedDetected: [],
      }),
    });

    const result = await collectNonSceneContext(request(), deps);

    expect(result.promptInput.alwaysEntryIds).toEqual([always.id]);
    expect(result.promptInput.contextTemporal).toEqual({
      asOfSceneId: "scene-1",
    });
    expect(result.promptInput.contextTemporalBySourceId?.[always.id]).toEqual(
      expect.objectContaining({
        asOfSceneId: "scene-1",
        axis: "reading",
        fallbackReason: "story-current-unresolved",
      }),
    );
  });

  it("canonicalizes equal-priority non-scene candidates independent of DB order", async () => {
    const a = codexEntry("always-a", { contextMode: "always" });
    const b = codexEntry("always-b", { contextMode: "always" });
    const collect = (entries: CodexContextEntry[]) =>
      collectNonSceneContext(
        request(),
        createNonSceneContextSourceDeps({
          fetchProjectContext: async () => ({
            title: "Project",
            language: "en",
          }),
          listCodexEntries: async () => entries,
        }),
      );

    const [forward, reversed] = await Promise.all([
      collect([a, b]),
      collect([b, a]),
    ]);

    expect(forward.promptInput.codexEntries?.map((entry) => entry.id)).toEqual([
      a.id,
      b.id,
    ]);
    expect(reversed.promptInput.codexEntries?.map((entry) => entry.id)).toEqual(
      [a.id, b.id],
    );
  });

  it("explains missing and effectively hidden explicit pins", async () => {
    const hidden = codexEntry("hidden-pin", { contextMode: "hidden" });
    const deps = createNonSceneContextSourceDeps({
      fetchProjectContext: async () => ({ title: "Project", language: "en" }),
      listCodexEntries: async () => [hidden],
    });

    const result = await collectNonSceneContext(
      request({ inputPinnedEntryIds: [hidden.id, "missing-pin"] }),
      deps,
    );

    expect(result.promptInput.contextDecisions).toEqual([
      expect.objectContaining({
        key: `codex:${hidden.id}`,
        status: "excluded",
        reason: "policy-hidden",
      }),
      expect.objectContaining({
        key: "codex:missing-pin",
        status: "unavailable",
        reason: "missing-source",
      }),
    ]);
  });

  it("fails when an explicit snippet anchor is missing", async () => {
    await expect(
      collectNonSceneContext(
        request({ scope: { kind: "snippet", snippetId: "missing-snippet" } }),
        createNonSceneContextSourceDeps(),
      ),
    ).rejects.toThrow("required snippet context anchor is unavailable");
  });

  it("fails when an explicit thread anchor is missing", async () => {
    await expect(
      collectNonSceneContext(
        request({
          scope: {
            kind: "thread",
            threadId: "missing-thread",
            title: "Missing",
          },
        }),
        createNonSceneContextSourceDeps(),
      ),
    ).rejects.toThrow("required thread context anchor is unavailable");
  });

  it("rejects Codex rows from a different project", async () => {
    const request = createNonSceneTurnContextRequest({
      requestId: "foreign-project-request",
      purpose: "live",
      projectId: "project-1",
      sessionId: null,
      scope: { kind: "global" },
      containerScope: "scene",
      scopeAnchorId: null,
      activeSceneId: "",
      activeProjectId: null,
      agentToolsAvailable: false,
      mode: "chat",
      route: null,
      budget: { contextWindow: 8_192, deliveryMode: "plain" },
      messages: [],
      outgoingUserMessage: "",
      mentionedSceneIds: [],
      mentionedCodexIds: [],
      inputPinnedEntryIds: [],
      excludedAutoEntryIds: [],
      sessionStableCodexIds: [],
      includeBodies: true,
      map: { enabled: false, boardId: null, activeBoardId: null },
      activeTab: null,
      settings: {
        injectBeats: false,
        chronicleEnabled: false,
        semanticRecallEnabled: false,
        episodicRecallEnabled: false,
        hybridRecallEnabled: false,
        customChatInstruction: "",
      },
      trackRecallPromote: false,
      sourceSnapshot: { treeNodes: [], plotThreadIds: [], plotThreadLinks: [] },
    });
    const deps = createNonSceneContextSourceDeps({
      listCodexEntries: async () =>
        [{ id: "foreign", projectId: "project-2" }] as CodexContextEntry[],
    });

    await expect(collectNonSceneContext(request, deps)).rejects.toThrow(
      "non-scene context project mismatch: project-2",
    );
  });

  it("rejects tree rows from a different project", async () => {
    const foreignScene = {
      ...scene("foreign-scene", "a0"),
      projectId: "project-2",
    };

    await expect(
      collectNonSceneContext(
        request({
          sourceSnapshot: {
            treeNodes: [foreignScene],
            plotThreadIds: ["thread-1"],
            plotThreadLinks: [
              { threadId: "thread-1", nodeId: foreignScene.id },
            ],
          },
        }),
        createNonSceneContextSourceDeps(),
      ),
    ).rejects.toThrow("non-scene context tree project mismatch: project-2");
  });

  it("resolves every candidate before visibility, matching, pins, and details", async () => {
    const revealed = codexEntry("revealed", { contextMode: "hidden" });
    const concealed = codexEntry("concealed");
    const manual = codexEntry("manual");
    const manualChild = codexEntry("manual-child", { parentId: manual.id });
    const hiddenPin = codexEntry("hidden-pin", { contextMode: "hidden" });
    const always = codexEntry("always");
    const phases = [
      phase("p-revealed", revealed.id, "scene-1", {
        summaryOverride: "revealed phase summary",
        contentOverride: "revealed phase content",
        contextModeOverride: "mentioned",
      }),
      phase("p-concealed", concealed.id, "scene-1", {
        contextModeOverride: "hidden",
      }),
      phase("p-manual", manual.id, "scene-1", {
        summaryOverride: "manual phase summary",
        contextModeOverride: "suppress",
      }),
      phase("p-manual-child", manualChild.id, "scene-1", {
        summaryOverride: "child phase summary",
      }),
      phase("p-always", always.id, "scene-1", {
        summaryOverride: "always phase summary",
        contextModeOverride: "always",
      }),
    ];
    const buildAggregatedScene = vi.fn(async (input: AggregatedSceneInput) => ({
      aggregatedScene: { id: "project-1", title: "Project", content: "body" },
      aggregatedDetected: input.detectableEntries.filter(
        (entry) => entry.id === revealed.id,
      ),
    }));
    const sceneIndex = buildSceneTimeIndex([scene("scene-1", "a0")]);
    const deps = createNonSceneContextSourceDeps({
      fetchProjectContext: async () => ({ title: "Project", language: "en" }),
      listCodexEntries: async () => [
        revealed,
        concealed,
        manual,
        manualChild,
        hiddenPin,
        always,
      ],
      getTemporalResolution: () => ({
        sceneTimeIndex: sceneIndex,
        resolutionMode: "reading",
      }),
      listPhases: async () => phases,
      listPhaseDetailOverrides: async () => [
        {
          phaseId: "p-always",
          definitionId: "mood",
          value: "phase mood",
        },
      ],
      listRawDetailValues: async () => [],
      listContextDetails: async () => [
        {
          entryId: always.id,
          definitionId: "mood",
          fieldName: "Mood",
          fieldType: "text",
          value: null,
        },
      ],
      listPinnedCodex: async () =>
        [manual, hiddenPin].map((entry) => ({
          ...entry,
          withChildren: entry.id === manual.id,
          pinnedType: "codex" as const,
        })) as PinnedCodexEntryWithData[],
      buildAggregatedScene,
    });

    const result = await collectNonSceneContext(
      request({ sessionId: "session-1" }),
      deps,
    );

    expect(buildAggregatedScene).toHaveBeenCalledWith(
      expect.objectContaining({
        detectableEntries: expect.arrayContaining([
          expect.objectContaining({
            id: revealed.id,
            summary: "revealed phase summary",
            contextMode: "mentioned",
          }),
        ]),
      }),
    );
    const detectionIds =
      buildAggregatedScene.mock.calls[0]![0].detectableEntries.map(
        (entry) => entry.id,
      );
    expect(detectionIds).not.toEqual(
      expect.arrayContaining([
        concealed.id,
        manual.id,
        hiddenPin.id,
        always.id,
      ]),
    );
    expect(result.detectedEntries).toEqual([
      expect.objectContaining({
        id: revealed.id,
        summary: "revealed phase summary",
        content: "revealed phase content",
      }),
    ]);
    expect(result.alwaysEntries).toEqual([
      expect.objectContaining({
        id: always.id,
        summary: "always phase summary",
        contextMode: "always",
      }),
    ]);
    expect(result.promptInput.pinnedCodexEntries).toEqual([
      expect.objectContaining({
        id: manual.id,
        summary: "manual phase summary",
        children: [
          expect.objectContaining({
            id: manualChild.id,
            summary: "child phase summary",
          }),
        ],
        childrenContext: expect.stringContaining("child phase summary"),
      }),
    ]);
    expect(result.promptInput.codexEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: always.id,
          customDetails: [{ fieldName: "Mood", value: "phase mood" }],
        }),
      ]),
    );
    expect(
      result.promptInput.codexEntries?.map((entry) => entry.id),
    ).not.toContain(concealed.id);
    expect(
      result.promptInput.pinnedCodexEntries?.map((entry) => entry.id),
    ).not.toContain(hiddenPin.id);
  });

  it("uses latest for a user-selected Codex scope and resolves related entries", async () => {
    const selected = codexEntry("selected", { contextMode: "suppress" });
    const related = codexEntry("related");
    const relationTarget = codexEntry("relation-target");
    const early = scene("scene-1", "a0");
    const late = scene("scene-2", "a1");
    const phases = [
      phase("selected-early", selected.id, early.id, {
        summaryOverride: "selected early",
      }),
      phase("selected-late", selected.id, late.id, {
        summaryOverride: "selected latest",
        contentOverride: "selected latest content",
      }),
      phase("related-late", related.id, late.id, {
        summaryOverride: "related latest",
      }),
      phase("relation-late", relationTarget.id, late.id, {
        summaryOverride: "relation latest",
      }),
    ];
    const deps = createNonSceneContextSourceDeps({
      fetchProjectContext: async () => ({ title: "Project", language: "en" }),
      listCodexEntries: async () => [selected, related, relationTarget],
      getTemporalResolution: () => ({
        sceneTimeIndex: buildSceneTimeIndex([early, late]),
        resolutionMode: "reading",
      }),
      listPhases: async () => phases,
      findMentionedEntries: async () => [related],
      listCodexRelations: async () => [
        {
          id: "relation-1",
          projectId: "project-1",
          fromCodexId: selected.id,
          toCodexId: relationTarget.id,
          relationType: "custom",
          label: "knows",
          depthHint: null,
          sourceMapEdgeId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const result = await collectNonSceneContext(
      request({
        scope: { kind: "codex", entryId: selected.id },
        containerScope: "codex",
        scopeAnchorId: selected.id,
        activeSceneId: early.id,
        sourceSnapshot: {
          treeNodes: [early, late],
          plotThreadIds: [],
          plotThreadLinks: [],
        },
      }),
      deps,
    );

    expect(result.promptInput.focusSubject).toEqual({
      kind: "codex",
      entry: expect.objectContaining({
        id: selected.id,
        summary: "selected latest",
      }),
    });
    expect(result.scopeAnchor).toEqual({
      kind: "codex",
      id: selected.id,
      name: selected.name,
    });
    expect(result.detectedEntries).toEqual([
      expect.objectContaining({ id: related.id, summary: "related latest" }),
    ]);
    expect(result.promptInput.relationCodexEntries).toEqual([
      expect.objectContaining({
        id: relationTarget.id,
        summary: "relation latest",
        relationVia: expect.stringContaining("knows"),
      }),
    ]);
  });
});
