import { describe, expect, it, vi } from "vitest";
import type { CodexContextEntry } from "@/features/codex/api";
import type { CodexMatchTarget } from "@/features/codex/codexMatcher";
import type { CodexEntryPhase } from "@/features/codex/phaseApi";
import type { CodexRelationRow } from "@/features/codex/codexRelationApi";
import { decideCodexAiVisibility } from "@/../electron/shared/readDomain/features/codex/context/codexAiVisibility";
import { buildSceneTimeIndex } from "@/features/codex/context/sceneTimeIndex";
import type { Snippet } from "@/features/snippets/api";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { PinnedCodexEntryWithData } from "../../chatApi";
import { buildSystemPrompt } from "../../contextBuilder";
import {
  createNonSceneTurnContextRequest,
  type CreateNonSceneTurnContextRequestInput,
} from "../turnContextRequest";
import {
  collectNonSceneContext,
  createNonSceneContextSourceDeps,
  type AggregatedSceneInput,
} from "./nonSceneContextSource";

function doc(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

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
    version: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function pinnedCodex(
  entry: CodexContextEntry,
  pinSource: "manual" | "chat_mention",
  withChildren = false,
): PinnedCodexEntryWithData {
  return {
    ...entry,
    withChildren,
    pinnedType: "codex",
    pinSource,
  } as PinnedCodexEntryWithData;
}

function relation(
  id: string,
  fromCodexId: string,
  toCodexId: string,
  label: string,
): CodexRelationRow {
  return {
    id,
    projectId: "project-1",
    fromCodexId,
    toCodexId,
    relationType: "custom",
    label,
    directionality: "directed",
    inverseLabel: null,
    semanticKey: `project-1|${fromCodexId}|${toCodexId}|custom|${label}|directed`,
    version: 1,
    depthHint: null,
    sourceMapEdgeId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
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
      semanticRerankerMode: "off",
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

  it("materializes a visible non-scene Codex active tab and seeds only its selected body", async () => {
    const active = codexEntry("active-tab-codex", {
      name: "Active Codex",
      content: doc("ACTIVE_TAB_BODY"),
    });
    const unrelated = codexEntry("unrelated-codex", {
      content: doc("UNRELATED_BODY"),
    });
    const entries = [active, unrelated];
    const listCodexEntriesByIds = vi.fn(
      async (_projectId: string, ids: readonly string[]) =>
        ids.flatMap(
          (id) => entries.find((candidate) => candidate.id === id) ?? [],
        ),
    );

    const result = await collectNonSceneContext(
      request({
        activeTab: { nodeId: active.id, contentType: "codex" },
      }),
      createNonSceneContextSourceDeps({
        fetchProjectContext: async () => ({ title: "Project", language: "en" }),
        listCodexEntries: async () => entries,
        listCodexEntriesByIds,
      }),
    );

    expect(listCodexEntriesByIds).toHaveBeenCalledWith("project-1", [
      active.id,
    ]);
    expect(result.promptInput.activeTabContent).toEqual({
      type: "codex",
      title: "Active Codex",
      content: "ACTIVE_TAB_BODY",
    });
    expect(buildSystemPrompt(result.promptInput).prompt).toContain(
      "ACTIVE_TAB_BODY",
    );
  });

  it("honors active-tab visibility, manual-pin authority, and focus de-duplication", async () => {
    const excluded = codexEntry("excluded-active-tab", {
      content: doc("EXCLUDED_ACTIVE_TAB_BODY"),
    });
    const manual = codexEntry("manual-active-tab", {
      contextMode: "suppress",
      content: doc("MANUAL_ACTIVE_TAB_BODY"),
    });
    const entries = [excluded, manual];
    const excludedResult = await collectNonSceneContext(
      request({
        activeTab: { nodeId: excluded.id, contentType: "codex" },
        excludedAutoEntryIds: [excluded.id],
      }),
      createNonSceneContextSourceDeps({
        fetchProjectContext: async () => ({ title: "Project", language: "en" }),
        listCodexEntries: async () => entries,
      }),
    );
    expect(excludedResult.promptInput.activeTabContent).toBeUndefined();

    const manualResult = await collectNonSceneContext(
      request({
        sessionId: "session-1",
        activeTab: { nodeId: manual.id, contentType: "codex" },
        excludedAutoEntryIds: [manual.id],
      }),
      createNonSceneContextSourceDeps({
        fetchProjectContext: async () => ({ title: "Project", language: "en" }),
        listCodexEntries: async () => entries,
        listPinnedCodex: async () => [pinnedCodex(manual, "manual")],
      }),
    );
    expect(manualResult.promptInput.activeTabContent?.content).toBe(
      "MANUAL_ACTIVE_TAB_BODY",
    );

    const focusResult = await collectNonSceneContext(
      request({
        scope: { kind: "codex", entryId: manual.id },
        containerScope: "codex",
        scopeAnchorId: manual.id,
        activeTab: { nodeId: manual.id, contentType: "codex" },
      }),
      createNonSceneContextSourceDeps({
        fetchProjectContext: async () => ({ title: "Project", language: "en" }),
        listCodexEntries: async () => entries,
      }),
    );
    expect(focusResult.promptInput.focusSubject?.kind).toBe("codex");
    expect(focusResult.promptInput.activeTabContent).toBeUndefined();
  });

  it("materializes a non-scene snippet active tab except when it is already the focus", async () => {
    const snippet: Snippet = {
      id: "snippet-1",
      projectId: "project-1",
      sceneId: null,
      title: "Active Snippet",
      content: doc("ACTIVE_SNIPPET_BODY"),
      version: 0,
      tagsCache: null,
      sourceChatMessageId: null,
      usageCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const getSnippet = vi.fn(
      async (_projectId: string, _snippetId: string) => snippet,
    );
    const activeResult = await collectNonSceneContext(
      request({ activeTab: { nodeId: snippet.id, contentType: "snippet" } }),
      createNonSceneContextSourceDeps({
        fetchProjectContext: async () => ({ title: "Project", language: "en" }),
        getSnippet,
      }),
    );
    expect(activeResult.promptInput.activeTabContent).toEqual({
      type: "snippet",
      title: snippet.title,
      content: "ACTIVE_SNIPPET_BODY",
    });

    const focusResult = await collectNonSceneContext(
      request({
        scope: { kind: "snippet", snippetId: snippet.id },
        containerScope: "snippet",
        scopeAnchorId: snippet.id,
        activeTab: { nodeId: snippet.id, contentType: "snippet" },
      }),
      createNonSceneContextSourceDeps({
        fetchProjectContext: async () => ({ title: "Project", language: "en" }),
        getSnippet,
      }),
    );
    expect(focusResult.promptInput.focusSubject?.kind).toBe("snippet");
    expect(focusResult.promptInput.activeTabContent).toBeUndefined();
  });

  it("reports an unavailable active snippet without aborting the plan", async () => {
    const result = await collectNonSceneContext(
      request({
        activeTab: { nodeId: "missing-snippet", contentType: "snippet" },
      }),
      createNonSceneContextSourceDeps({
        fetchProjectContext: async () => ({ title: "Project", language: "en" }),
        getSnippet: async () => undefined,
      }),
    );

    expect(result.promptInput.activeTabContent).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        source: "active-tab",
        code: "ACTIVE_TAB_SNIPPET_UNAVAILABLE",
        severity: "warning",
      }),
    ]);
  });

  it("selects text and structured current-turn mentions without promoting them to pins", async () => {
    const textMention = codexEntry("text-mention", { name: "Alice" });
    const structuredMention = codexEntry("structured-mention");
    const inputMention = codexEntry("input-mention");
    const entries = [textMention, structuredMention, inputMention];
    const findMentionedEntries = vi.fn(
      async (text: string, candidates: CodexMatchTarget[]) =>
        text.includes("Alice")
          ? candidates.filter((entry) => entry.id === textMention.id)
          : [],
    );

    const result = await collectNonSceneContext(
      request({
        outgoingUserMessage: "Tell me about Alice",
        mentionedCodexIds: [structuredMention.id],
        inputPinnedEntryIds: [inputMention.id],
      }),
      createNonSceneContextSourceDeps({
        fetchProjectContext: async () => ({ title: "Project", language: "en" }),
        listCodexEntries: async () => entries,
        findMentionedEntries,
      }),
    );

    expect(findMentionedEntries).toHaveBeenCalledWith(
      "Tell me about Alice",
      expect.arrayContaining(
        entries.map((entry) => expect.objectContaining({ id: entry.id })),
      ),
    );
    expect(result.detectedEntries.map((entry) => entry.id)).toEqual([
      inputMention.id,
      structuredMention.id,
      textMention.id,
    ]);
    expect(result.promptInput.pinnedCodexEntries).toBeUndefined();
  });

  it("does not escalate current-turn mentions to the suppress explicit-pin exception", async () => {
    const suppressed = codexEntry("suppressed-current", {
      name: "Classified",
      contextMode: "suppress",
    });

    const result = await collectNonSceneContext(
      request({
        outgoingUserMessage: "Discuss Classified",
        mentionedCodexIds: [suppressed.id],
        inputPinnedEntryIds: [suppressed.id],
      }),
      createNonSceneContextSourceDeps({
        fetchProjectContext: async () => ({ title: "Project", language: "en" }),
        listCodexEntries: async () => [suppressed],
        findMentionedEntries: async (_text, entries) => entries,
      }),
    );

    expect(result.detectedEntries).toEqual([]);
    expect(result.promptInput.codexEntries).toBeUndefined();
    expect(result.promptInput.pinnedCodexEntries).toBeUndefined();
    expect(result.promptInput.contextDecisions).toEqual([
      expect.objectContaining({
        key: `codex:${suppressed.id}`,
        status: "excluded",
        reason: "policy-suppress",
      }),
    ]);
  });

  it("ignores legacy chat-mention DB pins but keeps manual suppress pins", async () => {
    const legacyMentionPin = codexEntry("legacy-chat-mention", {
      contextMode: "suppress",
    });
    const manualPin = codexEntry("manual-suppress", {
      contextMode: "suppress",
    });

    const result = await collectNonSceneContext(
      request({ sessionId: "session-1" }),
      createNonSceneContextSourceDeps({
        fetchProjectContext: async () => ({ title: "Project", language: "en" }),
        listCodexEntries: async () => [legacyMentionPin, manualPin],
        listPinnedCodex: async () => [
          pinnedCodex(legacyMentionPin, "chat_mention"),
          pinnedCodex(manualPin, "manual"),
        ],
      }),
    );

    expect(
      result.promptInput.pinnedCodexEntries?.map((entry) => entry.id),
    ).toEqual([manualPin.id]);
    expect(result.promptInput.pinnedCodexEntries?.[0]).toEqual(
      expect.objectContaining({
        id: manualPin.id,
        summary: manualPin.summary,
      }),
    );
    const finalPrompt = buildSystemPrompt(result.promptInput).prompt;
    expect(finalPrompt).not.toContain(legacyMentionPin.id);
    expect(finalPrompt).not.toContain(legacyMentionPin.summary ?? "");
  });

  it("treats visible direct children of a manual withChildren pin as full explicit pins", async () => {
    const parent = codexEntry("manual-parent", { contextMode: "suppress" });
    const mentionedChild = codexEntry("manual-mentioned-child", {
      parentId: parent.id,
      content: doc("NON_SCENE_MENTIONED_CHILD_BODY"),
      tagsCache: JSON.stringify(["non-scene-child-tag"]),
    });
    const suppressChild = codexEntry("manual-suppress-child", {
      parentId: parent.id,
      contextMode: "suppress",
      content: doc("NON_SCENE_SUPPRESS_CHILD_BODY"),
    });
    const hiddenChild = codexEntry("manual-hidden-child", {
      parentId: parent.id,
      contextMode: "hidden",
      content: doc("NON_SCENE_HIDDEN_CHILD_BODY"),
    });
    const entries = [parent, mentionedChild, suppressChild, hiddenChild];
    const result = await collectNonSceneContext(
      request({ sessionId: "session-1" }),
      createNonSceneContextSourceDeps({
        fetchProjectContext: async () => ({ title: "Project", language: "en" }),
        listCodexEntries: async () => entries,
        listPinnedCodex: async () => [pinnedCodex(parent, "manual", true)],
        listContextDetails: async () => [
          {
            entryId: suppressChild.id,
            definitionId: "role",
            fieldName: "Role",
            fieldType: "text",
            value: "Explicit non-scene child detail",
          },
        ],
      }),
    );

    const pinnedParent = result.promptInput.pinnedCodexEntries?.[0];
    expect(pinnedParent?.children?.map((child) => child.id)).toEqual([
      mentionedChild.id,
      suppressChild.id,
    ]);
    const prompt = buildSystemPrompt(result.promptInput).prompt;
    expect(prompt).toContain("NON_SCENE_MENTIONED_CHILD_BODY");
    expect(prompt).toContain("NON_SCENE_SUPPRESS_CHILD_BODY");
    expect(prompt).toContain("non-scene-child-tag");
    expect(prompt).toContain("Explicit non-scene child detail");
    expect(prompt).not.toContain("NON_SCENE_HIDDEN_CHILD_BODY");
  });

  it("renders automatic mentioned descendants as identity-only and keeps hidden descendants closed", async () => {
    const parent = codexEntry("automatic-parent", {
      contextMode: "always",
      childrenBudget: "expanded",
    });
    const mentionedChild = codexEntry("automatic-mentioned-child", {
      name: "Automatic Mentioned Child",
      parentId: parent.id,
      summary: "AUTOMATIC_CHILD_SECRET_SUMMARY",
      content: doc("AUTOMATIC_CHILD_SECRET_BODY"),
    });
    const hiddenChild = codexEntry("automatic-hidden-child", {
      name: "Automatic Hidden Child",
      parentId: parent.id,
      contextMode: "hidden",
      summary: "AUTOMATIC_HIDDEN_SECRET",
    });
    const entries = [parent, mentionedChild, hiddenChild];
    const listCodexEntriesByIds = vi.fn(
      async (_projectId: string, ids: readonly string[]) =>
        ids.flatMap(
          (id) => entries.find((candidate) => candidate.id === id) ?? [],
        ),
    );
    const result = await collectNonSceneContext(
      request(),
      createNonSceneContextSourceDeps({
        fetchProjectContext: async () => ({ title: "Project", language: "en" }),
        listCodexEntries: async () => entries,
        listCodexEntriesByIds,
      }),
    );

    const prompt = buildSystemPrompt(result.promptInput).prompt;
    expect(prompt).toContain("Automatic Mentioned Child");
    expect(prompt).not.toContain("AUTOMATIC_CHILD_SECRET_SUMMARY");
    expect(prompt).not.toContain("AUTOMATIC_CHILD_SECRET_BODY");
    expect(prompt).not.toContain("Automatic Hidden Child");
    expect(prompt).not.toContain("AUTOMATIC_HIDDEN_SECRET");
    const loadedIds = listCodexEntriesByIds.mock.calls.flatMap(([, ids]) => [
      ...ids,
    ]);
    expect(loadedIds).toContain(parent.id);
    expect(loadedIds).not.toEqual(
      expect.arrayContaining([mentionedChild.id, hiddenChild.id]),
    );
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
        semanticRerankerMode: "off",
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

  it("never names a scene POV character on a folder/project aggregated pseudo-scene", async () => {
    const alice = codexEntry("alice", { contextMode: "always" });
    const povScene: TreeNodeData = {
      ...scene("scene-1", "a0"),
      povCharacterId: alice.id,
    };
    const result = await collectNonSceneContext(
      request({
        scope: { kind: "project" },
        sourceSnapshot: {
          treeNodes: [povScene],
          plotThreadIds: [],
          plotThreadLinks: [],
        },
      }),
      createNonSceneContextSourceDeps({
        fetchProjectContext: async () => ({ title: "Project", language: "en" }),
        listCodexEntries: async () => [alice],
        listCodexContextMetadata: async () => [alice],
        listCodexEntriesByIds: async () => [alice],
        buildAggregatedScene: async (input: AggregatedSceneInput) => ({
          aggregatedScene: {
            id: input.anchorId,
            title: input.anchorTitle,
            content: "aggregate",
          },
          aggregatedDetected: [],
        }),
      }),
    );
    expect(result.promptInput.scene.povName).toBeUndefined();
    const { prompt } = buildSystemPrompt({ ...result.promptInput, lang: "en" });
    expect(prompt).not.toContain("POV of this scene");
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
        semanticRerankerMode: "off",
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
        contentOverride: doc("child phase full body"),
        contextModeOverride: "always",
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
    expect(result.alwaysEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: always.id,
          summary: "always phase summary",
          contextMode: "always",
        }),
      ]),
    );
    expect(result.alwaysEntries.map((entry) => entry.id)).not.toContain(
      manualChild.id,
    );
    expect(result.promptInput.pinnedCodexEntries).toEqual([
      expect.objectContaining({
        id: manual.id,
        summary: "manual phase summary",
        children: [
          expect.objectContaining({
            id: manualChild.id,
            summary: "child phase summary",
            fullContent: "child phase full body",
          }),
        ],
      }),
    ]);
    expect(
      result.promptInput.pinnedCodexEntries?.[0]?.childrenContext ?? "",
    ).not.toContain("child phase summary");
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

  it("keeps excluded-auto entries out of current mentions and every closure path", async () => {
    const selected = codexEntry("selected-scope", {
      contextMode: "suppress",
      childrenBudget: "expanded",
    });
    const excludedCurrent = codexEntry("excluded-current", {
      name: "Excluded Current",
    });
    const excludedAlways = codexEntry("excluded-always", {
      contextMode: "always",
    });
    const excludedChild = codexEntry("excluded-child", {
      parentId: selected.id,
      contextMode: "always",
      summary: "EXCLUDED_CHILD_SECRET",
    });
    const excludedRelation = codexEntry("excluded-relation", {
      summary: "EXCLUDED_RELATION_SECRET",
    });
    const excludedDetail = codexEntry("excluded-detail", {
      name: "Excluded Detail Name",
    });
    const allowedAlways = codexEntry("allowed-always", {
      contextMode: "always",
    });
    const entries = [
      selected,
      excludedCurrent,
      excludedAlways,
      excludedChild,
      excludedRelation,
      excludedDetail,
      allowedAlways,
    ];
    const excludedIds = [
      excludedCurrent.id,
      excludedAlways.id,
      excludedChild.id,
      excludedRelation.id,
      excludedDetail.id,
    ];
    const listCodexEntriesByIds = vi.fn(
      async (_projectId: string, ids: readonly string[]) =>
        ids.flatMap(
          (id) => entries.find((candidate) => candidate.id === id) ?? [],
        ),
    );
    const loadMapBoardMarkdown = vi.fn(
      async (
        _request: CreateNonSceneTurnContextRequestInput,
        _entries: Array<{ id: string; name: string }>,
      ) => undefined,
    );

    const result = await collectNonSceneContext(
      request({
        scope: { kind: "codex", entryId: selected.id },
        containerScope: "codex",
        scopeAnchorId: selected.id,
        outgoingUserMessage: "Excluded Current",
        mentionedCodexIds: [excludedCurrent.id],
        inputPinnedEntryIds: [excludedCurrent.id],
        excludedAutoEntryIds: excludedIds,
      }),
      createNonSceneContextSourceDeps({
        fetchProjectContext: async () => ({ title: "Project", language: "en" }),
        listCodexEntries: async () => entries,
        listCodexEntriesByIds,
        findMentionedEntries: async (_text, candidates) =>
          candidates.filter((entry) => entry.id === excludedCurrent.id),
        listCodexRelations: async () => [
          relation(
            "excluded-relation-edge",
            selected.id,
            excludedRelation.id,
            "must-not-surface",
          ),
        ],
        listContextDetails: async () => [
          {
            entryId: selected.id,
            definitionId: "excluded-reference",
            fieldName: "Secret reference",
            fieldType: "codex_reference",
            value: excludedDetail.id,
          },
        ],
        loadMapBoardMarkdown,
      }),
    );

    const loadedIds = listCodexEntriesByIds.mock.calls.flatMap(
      ([, ids]) => ids,
    );
    expect(loadedIds).toEqual(
      expect.arrayContaining([selected.id, allowedAlways.id]),
    );
    expect(loadedIds).not.toEqual(expect.arrayContaining(excludedIds));
    expect(result.detectedEntries).toEqual([]);
    expect(result.alwaysEntries.map((entry) => entry.id)).toEqual([
      allowedAlways.id,
    ]);
    expect(result.promptInput.relationCodexEntries).toBeUndefined();
    expect(result.promptInput.focusSubject?.kind).toBe("codex");
    const focusEntry =
      result.promptInput.focusSubject?.kind === "codex"
        ? result.promptInput.focusSubject.entry
        : undefined;
    expect(focusEntry?.childrenContext ?? "").not.toContain(
      "EXCLUDED_CHILD_SECRET",
    );
    expect(focusEntry?.customDetails).toBeUndefined();
    expect(loadMapBoardMarkdown).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.arrayContaining(
        excludedIds.map((id) => expect.objectContaining({ id })),
      ),
    );
  });

  it("passes only map-reference identity candidates to the non-scene map adapter", async () => {
    const mentioned = codexEntry("map-mentioned", {
      contextMode: "mentioned",
    });
    const always = codexEntry("map-always", { contextMode: "always" });
    const suppressPin = codexEntry("map-suppress-pin", {
      contextMode: "suppress",
    });
    const hidden = codexEntry("map-hidden", { contextMode: "hidden" });
    const excluded = codexEntry("map-excluded", {
      contextMode: "mentioned",
    });
    const entries = [mentioned, always, suppressPin, hidden, excluded];
    const loadMapBoardMarkdown = vi.fn(
      async (
        _request: CreateNonSceneTurnContextRequestInput,
        _entries: Array<{ id: string; name: string }>,
      ) => undefined,
    );

    await collectNonSceneContext(
      request({
        sessionId: "session-1",
        map: { enabled: true, boardId: "board-1", activeBoardId: null },
        excludedAutoEntryIds: [excluded.id],
      }),
      createNonSceneContextSourceDeps({
        fetchProjectContext: async () => ({ title: "Project", language: "en" }),
        listCodexEntries: async () => entries,
        listPinnedCodex: async () => [pinnedCodex(suppressPin, "manual")],
        loadMapBoardMarkdown,
      }),
    );

    expect(loadMapBoardMarkdown).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ id: mentioned.id }),
        expect.objectContaining({ id: always.id }),
      ]),
    );
    const mapEntries = loadMapBoardMarkdown.mock.calls[0]![1];
    expect(mapEntries.map((entry) => entry.id)).not.toEqual(
      expect.arrayContaining([suppressPin.id, hidden.id, excluded.id]),
    );
  });

  it("renders mentioned relation targets as identity-only and keeps always targets canonical", async () => {
    const selected = codexEntry("relation-root", {
      contextMode: "suppress",
      summary: "selected summary",
      content: "selected content",
    });
    const summaryTarget = codexEntry("relation-summary-target", {
      name: "Summary Target",
      summary: "RELATION_SECRET_SUMMARY",
      content: "summary target body",
    });
    const contentTarget = codexEntry("relation-content-target", {
      name: "Content Target",
      summary: "",
      content: doc("RELATION_SECRET_CONTENT"),
    });
    const alwaysTarget = codexEntry("relation-always-target", {
      name: "Always Target",
      contextMode: "always",
      summary: "ALWAYS_CANONICAL_SUMMARY",
    });
    const entries = [selected, summaryTarget, contentTarget, alwaysTarget];

    const result = await collectNonSceneContext(
      request({
        scope: { kind: "codex", entryId: selected.id },
        containerScope: "codex",
        scopeAnchorId: selected.id,
      }),
      createNonSceneContextSourceDeps({
        fetchProjectContext: async () => ({ title: "Project", language: "en" }),
        listCodexEntries: async () => entries,
        findMentionedEntries: async () => [],
        listCodexRelations: async () => [
          relation(
            "summary-edge",
            selected.id,
            summaryTarget.id,
            "summary-link",
          ),
          relation(
            "content-edge",
            selected.id,
            contentTarget.id,
            "content-link",
          ),
          relation("always-edge", selected.id, alwaysTarget.id, "always-link"),
        ],
      }),
    );

    expect(result.promptInput.relationCodexEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: summaryTarget.id,
          summary: "",
          relationVia: expect.stringContaining("summary-link"),
        }),
        expect.objectContaining({
          id: contentTarget.id,
          summary: "",
          relationVia: expect.stringContaining("content-link"),
        }),
      ]),
    );
    for (const entry of result.promptInput.relationCodexEntries ?? []) {
      expect(entry.contentFallback).toBeUndefined();
      expect(entry.customDetails).toBeUndefined();
    }
    expect(result.promptInput.codexEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: alwaysTarget.id,
          summary: "ALWAYS_CANONICAL_SUMMARY",
        }),
      ]),
    );
    expect(
      result.promptInput.codexEntries?.find(
        (entry) => entry.id === alwaysTarget.id,
      ),
    ).not.toHaveProperty("relationVia");

    const finalPrompt = buildSystemPrompt(result.promptInput).prompt;
    expect(finalPrompt).toContain(summaryTarget.name);
    expect(finalPrompt).toContain(contentTarget.name);
    expect(finalPrompt).toContain("summary-link");
    expect(finalPrompt).toContain("content-link");
    expect(finalPrompt).not.toContain("RELATION_SECRET_SUMMARY");
    expect(finalPrompt).not.toContain("RELATION_SECRET_CONTENT");
    expect(finalPrompt).toContain("ALWAYS_CANONICAL_SUMMARY");
  });

  it("uses latest for a user-selected Codex scope and projects body matches as identity-only", async () => {
    const selected = codexEntry("selected", { contextMode: "suppress" });
    const related = codexEntry("related", {
      name: "Related Identity",
      summary: "RELATED_MATCH_SECRET_SUMMARY",
      content: doc("RELATED_MATCH_SECRET_BODY"),
    });
    const relationTarget = codexEntry("relation-target", {
      contextMode: "always",
    });
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
        relation("relation-1", selected.id, relationTarget.id, "knows"),
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
    expect(result.detectedEntries).toEqual([]);
    expect(result.promptInput.relationCodexEntries).toEqual([
      expect.objectContaining({
        id: related.id,
        name: "Related Identity",
        summary: "",
        relationVia: expect.any(String),
      }),
    ]);
    expect(result.promptInput.codexEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: relationTarget.id,
          summary: "relation latest",
        }),
      ]),
    );
    const finalPrompt = buildSystemPrompt(result.promptInput).prompt;
    expect(finalPrompt).toContain("Related Identity");
    expect(finalPrompt).not.toContain("related latest");
    expect(finalPrompt).not.toContain("RELATED_MATCH_SECRET_SUMMARY");
    expect(finalPrompt).not.toContain("RELATED_MATCH_SECRET_BODY");
  });
});

describe("collectNonSceneContext when the current scene cannot be resolved (DR-MP4-41 の向き)", () => {
  const phaseHidden = (
    id: string,
    overrides: Partial<CodexContextEntry> = {},
  ) =>
    codexEntry(id, {
      name: id,
      summary: `${id.toUpperCase()}_SUM`,
      content: doc(`${id.toUpperCase()}_BODY`),
      ...overrides,
    });
  const ENTRIES = {
    aria: phaseHidden("aria"),
    borin: phaseHidden("borin", { contextMode: "always" }),
    cael: phaseHidden("cael", { contextMode: "suppress" }),
    dara: phaseHidden("dara", { contextMode: "suppress" }),
    eli: phaseHidden("eli", { name: "Elivane", parentId: "dara" }),
    fenn: phaseHidden("fenn", { contextMode: "always" }),
    gale: phaseHidden("gale"),
    hana: phaseHidden("hana", { name: "Hanavane" }),
    iris: phaseHidden("iris", { name: "Irisvane" }),
    jay: phaseHidden("jay", { name: "Jayvane" }),
    calm: phaseHidden("calm"),
    soft: phaseHidden("soft"),
    lift: phaseHidden("lift", { contextMode: "hidden" }),
  };
  const PHASE_HIDDEN = [
    "aria",
    "borin",
    "cael",
    "eli",
    "gale",
    "hana",
    "iris",
    "jay",
  ] as const;
  /** What proves each entry reached the AI (a name only where nothing else shows it). */
  const TOKEN: Partial<Record<keyof typeof ENTRIES, string>> = {
    aria: "ARIA_SUM",
    borin: "BORIN_SUM",
    cael: "CAEL_SUM",
    dara: "DARA_SUM",
    eli: "ELI_SUM",
    fenn: "FENN_SUM",
    hana: "HANA_BODY",
    iris: "IRIS_SUM",
    jay: "JAY_SUM",
    calm: "CALM_SUM",
    soft: "SOFT_SUM",
    lift: "LIFT_SUM",
  };
  const PHASES: CodexEntryPhase[] = [
    ...PHASE_HIDDEN.map((id) =>
      phase(`p-${id}`, id, "scene-2", { contextModeOverride: "hidden" }),
    ),
    phase("p-soft", "soft", "scene-2", { contextModeOverride: "suppress" }),
    phase("p-lift", "lift", "scene-1", { contextModeOverride: "mentioned" }),
  ];
  const sceneIndex = buildSceneTimeIndex([
    scene("scene-1", "a0"),
    scene("scene-2", "a1"),
  ]);

  async function collect(
    activeSceneId: string,
    options: {
      index?: ReturnType<typeof buildSceneTimeIndex>;
      scope?: CreateNonSceneTurnContextRequestInput["scope"];
      phases?: CodexEntryPhase[];
      entries?: CodexContextEntry[];
      overrides?: Partial<CreateNonSceneTurnContextRequestInput>;
    } = {},
  ) {
    const entries = options.entries ?? Object.values(ENTRIES);
    const phases = options.phases ?? PHASES;
    const buildAggregatedScene = vi.fn(
      async (_input: AggregatedSceneInput) => ({
        aggregatedScene: { id: "project-1", title: "Project", content: "body" },
        aggregatedDetected: [] as AggregatedSceneInput["detectableEntries"],
      }),
    );
    const scope = options.scope ?? { kind: "project" as const };
    const result = await collectNonSceneContext(
      request({
        sessionId: "session-1",
        scope,
        containerScope: scope.kind === "codex" ? "codex" : "project",
        scopeAnchorId: scope.kind === "codex" ? scope.entryId : null,
        activeSceneId,
        outgoingUserMessage: "Tell me about aria, calm, soft and lift.",
        mentionedCodexIds: ["jay"],
        inputPinnedEntryIds: ["iris"],
        activeTab: { nodeId: "hana", contentType: "codex" },
        ...options.overrides,
      }),
      createNonSceneContextSourceDeps({
        fetchProjectContext: async () => ({ title: "Project", language: "en" }),
        listCodexEntries: async () => entries,
        getTemporalResolution: () => ({
          sceneTimeIndex: options.index ?? sceneIndex,
          resolutionMode: "reading",
        }),
        listPhases: async (ids) =>
          phases.filter((candidate) => ids.includes(candidate.entryId)),
        findMentionedEntries: async (text, targets) =>
          targets.filter((target) => text.includes(target.name)),
        listPinnedCodex: async () => [
          pinnedCodex(ENTRIES.cael, "manual"),
          pinnedCodex(ENTRIES.dara, "manual", true),
        ],
        listCodexRelations: async () => [
          relation("relation-1", "fenn", "gale", "ally"),
        ],
        buildAggregatedScene,
      }),
    );
    const haystack = `${JSON.stringify(result.promptInput)}\n${
      buildSystemPrompt(result.promptInput).prompt
    }`;
    return { result, haystack, buildAggregatedScene };
  }

  it("keeps every path public while the scene is in the reading order (the control: the Phase has not started)", async () => {
    const { haystack } = await collect("scene-1");
    for (const id of [...PHASE_HIDDEN, "calm", "soft", "lift"] as const) {
      // gale reaches the AI only as an identity (the aggregated scene's name lookup), not as text.
      if (id === "gale") continue;
      expect(haystack, id).toContain(TOKEN[id]!);
    }
  });

  it.each(["", "   ", "n-note", "no-such-scene"])(
    "closes an entry that a later Phase hides on every path (mention, input pin, always, pin, child, active tab) when activeSceneId is %j",
    async (activeSceneId) => {
      const { haystack } = await collect(activeSceneId);
      for (const id of PHASE_HIDDEN) {
        if (id === "gale") continue;
        expect(haystack, id).not.toContain(TOKEN[id]!);
        // Neither the summary nor the body of a closed entry is in anything the AI gets.
        expect(haystack, id).not.toContain(`${id.toUpperCase()}_SUM`);
        expect(haystack, id).not.toContain(`${id.toUpperCase()}_BODY`);
      }
    },
  );

  it("reads an id with spaces around it as the resolver does (not in the reading order, so closed), while the agent tool trims it and resolves (a known difference)", async () => {
    const { haystack } = await collect(" scene-1 ");
    for (const id of PHASE_HIDDEN) {
      if (id === "gale") continue;
      expect(haystack, id).not.toContain(TOKEN[id]!);
    }
    const decision = decideCodexAiVisibility({
      entries: Object.values(ENTRIES),
      phases: PHASES,
      sceneId: " scene-1 ",
      sceneTimeIndex: sceneIndex,
      resolutionMode: { kind: "resolved", mode: "reading" },
    });
    expect([...decision.hidden]).not.toContain("aria");
  });

  it.each(["", "n-note", "no-such-scene"])(
    "keeps entries no Phase hides, a suppress-only Phase and a base-hidden entry the same when activeSceneId is %j",
    async (activeSceneId) => {
      const { haystack } = await collect(activeSceneId);
      expect(haystack).toContain(TOKEN.calm!);
      expect(haystack).toContain(TOKEN.soft!);
      expect(haystack).toContain(TOKEN.dara!);
      expect(haystack).not.toContain(TOKEN.lift!);
    },
  );

  it.each(["", "n-note"])(
    "counts a Phase whose anchor scene is gone and a Phase with an unknown mode as hiding when activeSceneId is %j",
    async (activeSceneId) => {
      const dangling = phaseHidden("dangling", { contextMode: "always" });
      const odd = phaseHidden("odd", { contextMode: "always" });
      const { haystack } = await collect(activeSceneId, {
        entries: [dangling, odd, ENTRIES.calm],
        phases: [
          phase("p-dangling", "dangling", "deleted-scene", {
            contextModeOverride: "hidden",
          }),
          phase("p-odd", "odd", "scene-2", {
            contextModeOverride: "a-mode-from-the-future",
          }),
        ],
      });
      expect(haystack).not.toContain("DANGLING_SUM");
      expect(haystack).not.toContain("ODD_SUM");
      expect(haystack).toContain("CALM_SUM");
    },
  );

  it.each(["", "n-note"])(
    "keeps the entries a later Phase hides out of what the aggregated scene gets (activeSceneId %j)",
    async (activeSceneId) => {
      const { buildAggregatedScene } = await collect(activeSceneId);
      const input = buildAggregatedScene.mock.calls[0]![0];
      const detectable = input.detectableEntries.map((entry) => entry.id);
      const identities = input.allEntries.map((entry) => entry.id);
      for (const id of PHASE_HIDDEN) {
        expect(detectable, id).not.toContain(id);
        // The identity lookup (relation / map reference / child) is closed too (gale, borin, ...).
        expect(identities, id).not.toContain(id);
      }
      expect(detectable).toEqual(expect.arrayContaining(["calm", "soft"]));
      expect(identities).toEqual(expect.arrayContaining(["calm", "soft"]));
    },
  );

  it.each(["scene-1", "", "   ", "n-note", "no-such-scene"])(
    "shows an entry that is public at base to the AI exactly when the agent tool's rule (decideCodexAiVisibility) does not hide it (activeSceneId %j)",
    async (activeSceneId) => {
      const { haystack, buildAggregatedScene } = await collect(activeSceneId);
      const decision = decideCodexAiVisibility({
        entries: Object.values(ENTRIES),
        phases: PHASES,
        sceneId: activeSceneId,
        sceneTimeIndex: sceneIndex,
        resolutionMode: { kind: "resolved", mode: "reading" },
      });
      // Base-public entries only: the tool also hides base-hidden and unknown modes (lift is not compared).
      for (const id of [...PHASE_HIDDEN, "calm", "soft"] as const) {
        const reached =
          id === "gale"
            ? buildAggregatedScene.mock.calls[0]![0].allEntries.some(
                (entry) => entry.id === id,
              )
            : haystack.includes(TOKEN[id]!);
        expect(reached, id).toBe(!decision.hidden.has(id));
      }
    },
  );

  describe("the codex scope resolves at the latest state and does not depend on the scene (not changed)", () => {
    // A Phase whose anchor scene is not in the reading order is skipped by the resolver, even at latest.
    const dangling = phaseHidden("ghosty", { contextMode: "always" });
    const applied = phaseHidden("applied", { contextMode: "always" });
    const selected = phaseHidden("selected");
    const extra = [dangling, applied, selected];
    const extraPhases = [
      phase("p-ghosty", "ghosty", "deleted-scene", {
        contextModeOverride: "hidden",
      }),
      phase("p-applied", "applied", "scene-2", {
        contextModeOverride: "hidden",
      }),
    ];

    it.each([
      ["a scene id", "scene-1"],
      ["no scene", ""],
      ["a note", "n-note"],
    ])(
      "keeps the result the same whether the current scene is %s",
      async (_label, activeSceneId) => {
        const { haystack } = await collect(activeSceneId, {
          scope: { kind: "codex", entryId: "selected" },
          entries: extra,
          phases: extraPhases,
        });
        expect(haystack).toContain("SELECTED_SUM");
        // The Phase that does apply at latest hides it; the skipped (dangling) one does not.
        expect(haystack).not.toContain("APPLIED_SUM");
        expect(haystack).toContain("GHOSTY_SUM");
      },
    );

    it("applies no Phase at latest while the reading order is empty (an existing fail-open, not changed)", async () => {
      const { haystack } = await collect("scene-1", {
        scope: { kind: "codex", entryId: "selected" },
        entries: extra,
        phases: extraPhases,
        index: buildSceneTimeIndex([]),
      });
      expect(haystack).toContain("SELECTED_SUM");
      expect(haystack).toContain("APPLIED_SUM");
      expect(haystack).toContain("GHOSTY_SUM");
    });
  });
});
