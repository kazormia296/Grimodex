import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { CodexEntryPhase, CodexPhaseDetailOverride } from "@/db/schema";
import type { CodexContextEntry } from "@/features/codex/api";
import { buildSceneTimeIndex } from "@/features/codex/context/sceneTimeIndex";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { PinnedCodexEntryWithData } from "../../chatApi";
import type { ChatMessage } from "../../chatTypes";
import { buildSystemPrompt } from "../../contextBuilder";
import { createSceneTurnContextRequest } from "../turnContextRequest";
import {
  collectSceneContext,
  createSceneContextSourceDeps,
} from "./sceneContextSource";

const NOW = "2026-01-01T00:00:00.000Z";

function doc(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

function entry(
  overrides: Partial<CodexContextEntry> &
    Pick<CodexContextEntry, "id" | "name">,
): CodexContextEntry {
  return {
    projectId: "project-1",
    parentId: null,
    type: "character",
    aliases: null,
    excludedAliases: null,
    summary: "Base summary",
    content: doc("Base body"),
    tagsCache: null,
    contextMode: "mentioned",
    childrenBudget: "compact",
    sourceChatMessageId: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 0,
    ...overrides,
  };
}

function phase(
  overrides: Partial<CodexEntryPhase> & Pick<CodexEntryPhase, "id" | "entryId">,
): CodexEntryPhase {
  return {
    anchorNodeId: "scene-1",
    label: "Current",
    summaryOverride: null,
    contentOverride: null,
    contextModeOverride: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const sceneNode: TreeNodeData = {
  id: "scene-1",
  projectId: "project-1",
  parentId: null,
  nodeType: "scene",
  title: "Scene",
  synopsis: null,
  intent: null,
  sortOrder: "a0",
  status: null,
  storyTimeOrder: null,
  storyTimeLabel: null,
  povCharacterId: null,
  locationId: null,
  charCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

interface RequestOverrides {
  includeBodies?: boolean;
  entries?: CodexContextEntry[];
  sceneContent?: string;
  inputPinnedEntryIds?: string[];
  activeTabId?: string;
  prefetch?: boolean;
  messages?: ChatMessage[];
  outgoingUserMessage?: string;
  mentionedCodexIds?: string[];
  sessionId?: string | null;
  excludedAutoEntryIds?: string[];
  semanticRecallEnabled?: boolean;
}

function request(overrides: RequestOverrides = {}) {
  return createSceneTurnContextRequest({
    requestId: "request-1",
    purpose: "live",
    projectId: "project-1",
    sessionId: overrides.sessionId ?? null,
    sceneId: "scene-1",
    mode: "chat",
    route: null,
    budget: { contextWindow: 16_384, deliveryMode: "plain" },
    messages: overrides.messages ?? [],
    outgoingUserMessage: overrides.outgoingUserMessage ?? "",
    mentionedSceneIds: [],
    mentionedCodexIds: overrides.mentionedCodexIds ?? [],
    inputPinnedEntryIds: overrides.inputPinnedEntryIds ?? [],
    excludedAutoEntryIds: overrides.excludedAutoEntryIds ?? [],
    sessionStableCodexIds: [],
    includeBodies: overrides.includeBodies ?? true,
    map: { enabled: false, boardId: null, activeBoardId: null },
    activeTab: overrides.activeTabId
      ? { nodeId: overrides.activeTabId, contentType: "codex" }
      : null,
    settings: {
      injectBeats: false,
      chronicleEnabled: false,
      semanticRecallEnabled: overrides.semanticRecallEnabled ?? false,
      episodicRecallEnabled: false,
      hybridRecallEnabled: false,
      customChatInstruction: "",
    },
    trackRecallPromote: false,
    sourceSnapshot: {
      scene: {
        id: "scene-1",
        title: "Scene",
        content: overrides.sceneContent ?? "Body",
      },
      project: { title: "Project", language: "en" },
      ...(overrides.prefetch === false
        ? {}
        : { prefetchedCodexEntries: overrides.entries ?? [] }),
    },
  });
}

function pinnedCodex(
  candidate: CodexContextEntry,
  pinSource: "manual" | "chat_mention" = "manual",
  withChildren = false,
): PinnedCodexEntryWithData {
  return {
    ...candidate,
    icon: null,
    readings: null,
    notes: null,
    withChildren,
    pinnedType: "codex",
    pinSource,
  };
}

interface PhaseDepsOptions {
  detailOverrides?: CodexPhaseDetailOverride[];
  rawDetails?: Array<{
    entryId: string;
    definitionId: string;
    value: string | null;
  }>;
  contextDetails?: Array<{
    entryId: string;
    definitionId: string;
    fieldName: string;
    fieldType: string;
    value: string | null;
  }>;
}

function phaseDeps(phases: CodexEntryPhase[], options: PhaseDepsOptions = {}) {
  return createSceneContextSourceDeps({
    listTreeNodes: () => [sceneNode],
    getTemporalResolution: () => ({
      sceneTimeIndex: buildSceneTimeIndex([sceneNode]),
      resolutionMode: "reading",
    }),
    listPhases: async (entryIds) =>
      phases.filter((candidate) => entryIds.includes(candidate.entryId)),
    listPhaseDetailOverrides: async (phaseIds) =>
      (options.detailOverrides ?? []).filter((override) =>
        phaseIds.includes(override.phaseId),
      ),
    listRawDetailValues: async (entryIds) =>
      (options.rawDetails ?? []).filter((detail) =>
        entryIds.includes(detail.entryId),
      ),
    listContextDetails: async (entryIds) =>
      (options.contextDetails ?? []).filter((detail) =>
        entryIds.includes(detail.entryId),
      ),
    findMentionedEntries: async (text, targets) =>
      targets.filter((target) => text.includes(target.name)),
  });
}

describe("collectSceneContext", () => {
  it("uses the request project id and source snapshot without global project lookup", async () => {
    const listCodexEntries = vi.fn(async () => []);
    const result = await collectSceneContext(
      request(),
      createSceneContextSourceDeps({ listCodexEntries }),
    );

    expect(listCodexEntries).not.toHaveBeenCalled();
    expect(result.scene.id).toBe("scene-1");
    expect(result.project?.title).toBe("Project");
    expect(result.promptInput.scene.content).toBe("Body");
    expect(result).toMatchObject({ diagnostics: [] });
  });

  it("retains independent optional source failures as deterministic diagnostics", async () => {
    const result = await collectSceneContext(
      request({
        sessionId: "session-1",
        outgoingUserMessage: "Find related material",
        semanticRecallEnabled: true,
      }),
      createSceneContextSourceDeps({
        listTreeNodes: () => [sceneNode],
        listPinnedSnippets: async () => {
          throw new Error("snippet database offline");
        },
        fetchSemanticRecall: async () => {
          throw new Error("embedding service offline");
        },
      }),
    );

    expect(result.promptInput.pinnedSnippets).toBeUndefined();
    expect(result.promptInput.semanticRecall).toBeUndefined();
    expect(result).toMatchObject({
      diagnostics: [
        {
          source: "pinned-snippets",
          severity: "warning",
          code: "PINNED_SNIPPETS_UNAVAILABLE",
          message: "Pinned snippets are unavailable; continuing without them.",
          cause: expect.any(Error),
        },
        {
          source: "semantic-recall",
          severity: "warning",
          code: "SEMANTIC_RECALL_UNAVAILABLE",
          message: "Semantic recall is unavailable; continuing without it.",
          cause: expect.any(Error),
        },
      ],
    });
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.latencyMs).toEqual(expect.any(Number));
      expect(diagnostic.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("applies eco mode from the immutable request snapshot", async () => {
    const result = await collectSceneContext(
      request({ includeBodies: false }),
      createSceneContextSourceDeps(),
    );

    expect(result.scene.content).toBe("");
    expect(result.promptInput.scene.content).toBe("");
  });

  it("loads full Codex bodies only after metadata selection", async () => {
    const alice = entry({
      id: "alice",
      name: "Alice",
      summary: null,
      content: doc("Alice full body"),
    });
    const bob = entry({
      id: "bob",
      name: "Bob",
      summary: null,
      content: doc("Bob full body"),
    });
    const allEntries = [alice, bob];
    const listCodexEntries = vi.fn(async () => {
      throw new Error("full all-entry load must not be used");
    });
    const listCodexContextMetadata = vi.fn(async () =>
      allEntries.map(({ content: _content, ...metadata }) => metadata),
    );
    const listCodexEntriesByIds = vi.fn(
      async (_projectId, ids: readonly string[]) =>
        ids.flatMap(
          (id) => allEntries.find((candidate) => candidate.id === id) ?? [],
        ),
    );

    const result = await collectSceneContext(
      request({
        prefetch: false,
        sceneContent: "Alice appears",
      }),
      {
        ...phaseDeps([]),
        listCodexEntries,
        listCodexContextMetadata,
        listCodexEntriesByIds,
      },
    );

    expect(listCodexContextMetadata).toHaveBeenCalledWith("project-1");
    expect(listCodexEntries).not.toHaveBeenCalled();
    expect(listCodexEntriesByIds).toHaveBeenCalledWith("project-1", ["alice"]);
    expect(result.promptInput.codexEntries?.map((item) => item.id)).toEqual([
      "alice",
    ]);
    expect(result.promptInput.codexEntries?.[0]?.contentFallback).toBe(
      "Alice full body",
    );
  });

  it("uses only the current turn and structured mentions as chat triggers", async () => {
    const alice = entry({ id: "alice", name: "Alice" });
    const historicalMessage: ChatMessage = {
      id: "message-1",
      sessionId: "session-1",
      role: "user",
      content: "Alice appeared in an earlier turn",
      createdAt: NOW,
    };

    const historicalOnly = await collectSceneContext(
      request({ entries: [alice], messages: [historicalMessage] }),
      phaseDeps([]),
    );
    expect(historicalOnly.promptInput.codexEntries).toEqual([]);

    const currentText = await collectSceneContext(
      request({ entries: [alice], outgoingUserMessage: "Ask about Alice" }),
      phaseDeps([]),
    );
    expect(
      currentText.promptInput.codexEntries?.map((item) => item.id),
    ).toEqual([alice.id]);

    const structured = await collectSceneContext(
      request({ entries: [alice], mentionedCodexIds: [alice.id] }),
      phaseDeps([]),
    );
    expect(structured.promptInput.codexEntries?.map((item) => item.id)).toEqual(
      [alice.id],
    );
  });

  it("does not promote a current-turn mention to an explicit pin", async () => {
    const suppressed = entry({
      id: "suppressed",
      name: "Suppressed",
      contextMode: "suppress",
      summary: "Must stay private",
    });

    for (const mention of [
      { outgoingUserMessage: "Ask about Suppressed" },
      { inputPinnedEntryIds: [suppressed.id] },
      { mentionedCodexIds: [suppressed.id] },
    ]) {
      const result = await collectSceneContext(
        request({ entries: [suppressed], ...mention }),
        phaseDeps([]),
      );

      expect(result.promptInput.codexEntries).toEqual([]);
      expect(result.promptInput.pinnedCodexEntries).toEqual([]);
      expect(JSON.stringify(result.promptInput)).not.toContain(
        "Must stay private",
      );
    }
  });

  it("ignores legacy persisted chat-mention pins", async () => {
    const suppressed = entry({
      id: "legacy-chat-mention",
      name: "Legacy",
      contextMode: "suppress",
      summary: "Legacy private body",
    });
    const result = await collectSceneContext(
      request({ entries: [suppressed], sessionId: "session-1" }),
      {
        ...phaseDeps([]),
        listPinnedCodex: async () => [pinnedCodex(suppressed, "chat_mention")],
      },
    );

    expect(result.promptInput.codexEntries).toEqual([]);
    expect(result.promptInput.pinnedCodexEntries).toEqual([]);
    expect(result.promptInput.contextDecisions).toEqual([]);
    expect(JSON.stringify(result.promptInput)).not.toContain(
      "Legacy private body",
    );
  });

  it("contains no direct Chat store or implicit current-project reads", () => {
    const source = readFileSync(
      new URL("./sceneContextSource.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/useChatStore/);
    expect(source).not.toMatch(/getCurrentProjectId/);
  });

  it.each(["hidden", "suppress"])(
    "excludes Base-mentioned entries after Phase %s resolution",
    async (mode) => {
      const alice = entry({ id: "alice", name: "Alice" });
      const result = await collectSceneContext(
        request({
          entries: [alice],
          sceneContent: "Alice appears",
        }),
        phaseDeps([
          phase({
            id: "phase-1",
            entryId: alice.id,
            summaryOverride: "Phase secret",
            contentOverride: doc("Phase secret body"),
            contextModeOverride: mode,
          }),
        ]),
      );

      expect(result.promptInput.codexEntries).toEqual([]);
      expect(result.promptInput.pinnedCodexEntries).toEqual([]);
      expect(result.detectedEntries).toEqual([]);
      expect(JSON.stringify(result.promptInput)).not.toContain("Phase secret");
    },
  );

  it.each(["mentioned", "always"] as const)(
    "selects Base-hidden entries after Phase %s resolution",
    async (mode) => {
      const alice = entry({
        id: "alice",
        name: "Alice",
        contextMode: "hidden",
      });
      const result = await collectSceneContext(
        request({
          entries: [alice],
          sceneContent: mode === "mentioned" ? "Alice appears" : "No mention",
        }),
        phaseDeps([
          phase({
            id: "phase-1",
            entryId: alice.id,
            summaryOverride: "Phase summary",
            contentOverride: doc("Phase body"),
            contextModeOverride: mode,
          }),
        ]),
      );

      expect(result.promptInput.codexEntries).toEqual([
        expect.objectContaining({
          id: alice.id,
          summary: "Phase summary",
          phaseLabel: "Current",
        }),
      ]);
      const selected =
        mode === "mentioned"
          ? result.detectedEntries[0]
          : result.alwaysEntries[0];
      expect(selected).toMatchObject({
        id: alice.id,
        summary: "Phase summary",
        content: doc("Phase body"),
        contextMode: mode,
      });
    },
  );

  it("explains missing and effectively hidden explicit pins", async () => {
    const hidden = entry({
      id: "hidden-pin",
      name: "Hidden",
      contextMode: "hidden",
    });
    const result = await collectSceneContext(
      request({
        entries: [hidden],
        sessionId: "session-1",
      }),
      {
        ...phaseDeps([]),
        listPinnedCodex: async () => [
          pinnedCodex(hidden),
          pinnedCodex({ ...hidden, id: "missing-pin", name: "Missing" }),
        ],
      },
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

  it("preserves always priority when an always entry is also mentioned", async () => {
    const alice = entry({
      id: "alice",
      name: "Alice",
      contextMode: "always",
    });
    const result = await collectSceneContext(
      request({ entries: [alice], sceneContent: "Alice appears" }),
      phaseDeps([]),
    );

    expect(result.detectedEntries.map((candidate) => candidate.id)).toEqual([
      alice.id,
    ]);
    expect(result.alwaysEntries).toEqual([]);
    expect(result.promptInput.alwaysEntryIds).toEqual([alice.id]);
  });

  it("allows Phase-suppress only through an explicit pin and uses Phase body", async () => {
    const alice = entry({
      id: "alice",
      name: "Alice",
      contextMode: "always",
    });
    const result = await collectSceneContext(
      request({
        entries: [alice],
        sceneContent: "No mention",
        sessionId: "session-1",
      }),
      {
        ...phaseDeps([
          phase({
            id: "phase-1",
            entryId: alice.id,
            summaryOverride: "Pinned phase summary",
            contentOverride: doc("Pinned phase body"),
            contextModeOverride: "suppress",
          }),
        ]),
        listPinnedCodex: async () => [pinnedCodex(alice)],
      },
    );

    expect(result.promptInput.codexEntries).toEqual([]);
    expect(result.promptInput.pinnedCodexEntries).toEqual([
      expect.objectContaining({
        id: alice.id,
        summary: "Pinned phase summary",
        fullContent: "Pinned phase body",
        phaseLabel: "Current",
      }),
    ]);
  });

  it("renders a Phase-only custom detail override for a detected entry", async () => {
    const alice = entry({ id: "alice", name: "Alice" });
    const currentPhase = phase({ id: "phase-1", entryId: alice.id });
    const result = await collectSceneContext(
      request({ entries: [alice], sceneContent: "Alice appears" }),
      phaseDeps([currentPhase], {
        detailOverrides: [
          {
            phaseId: currentPhase.id,
            definitionId: "detail-role",
            value: "Phase role",
          },
        ],
        // No Base value row: metadata still has to make the Phase-only
        // override renderable with a human-readable field name.
        contextDetails: [
          {
            entryId: alice.id,
            definitionId: "detail-role",
            fieldName: "Role",
            fieldType: "text",
            value: null,
          },
        ],
      }),
    );

    expect(result.promptInput.codexEntries?.[0]?.customDetails).toEqual([
      { fieldName: "Role", value: "Phase role" },
    ]);
  });

  it("keeps an explicit null Phase custom-detail clear absent for a pin", async () => {
    const alice = entry({ id: "alice", name: "Alice" });
    const currentPhase = phase({ id: "phase-1", entryId: alice.id });
    const result = await collectSceneContext(
      request({ entries: [alice], sessionId: "session-1" }),
      {
        ...phaseDeps([currentPhase], {
          detailOverrides: [
            {
              phaseId: currentPhase.id,
              definitionId: "detail-role",
              value: null,
            },
          ],
          rawDetails: [
            {
              entryId: alice.id,
              definitionId: "detail-role",
              value: "Base role",
            },
          ],
          contextDetails: [
            {
              entryId: alice.id,
              definitionId: "detail-role",
              fieldName: "Role",
              fieldType: "text",
              value: "Base role",
            },
          ],
        }),
        listPinnedCodex: async () => [pinnedCodex(alice)],
      },
    );

    expect(
      result.promptInput.pinnedCodexEntries?.[0]?.customDetails,
    ).toBeUndefined();
    expect(JSON.stringify(result.promptInput)).not.toContain("Base role");
  });

  it("evaluates each child effective mode and uses resolved child content", async () => {
    const parent = entry({
      id: "parent",
      name: "Parent",
      contextMode: "always",
    });
    const visibleChild = entry({
      id: "visible-child",
      name: "Visible child",
      parentId: parent.id,
      contextMode: "hidden",
      summary: "",
    });
    const mentionedChild = entry({
      id: "mentioned-child",
      name: "Mentioned child",
      parentId: parent.id,
      summary: "Mentioned child summary",
    });
    const hiddenChild = entry({
      id: "hidden-child",
      name: "Hidden child",
      parentId: parent.id,
      summary: "Base hidden summary",
    });
    const entries = [parent, visibleChild, mentionedChild, hiddenChild];
    const phases = [
      phase({
        id: "phase-visible",
        entryId: visibleChild.id,
        contentOverride: doc("Resolved child body"),
        contextModeOverride: "always",
      }),
      phase({
        id: "phase-hidden",
        entryId: hiddenChild.id,
        summaryOverride: "Phase hidden summary",
        contextModeOverride: "hidden",
      }),
    ];
    const listCodexEntriesByIds = vi.fn(
      async (_projectId: string, ids: readonly string[]) =>
        ids.flatMap(
          (id) => entries.find((candidate) => candidate.id === id) ?? [],
        ),
    );
    const result = await collectSceneContext(
      request({ entries, prefetch: false }),
      {
        ...phaseDeps(phases),
        listCodexContextMetadata: async () =>
          entries.map(({ content: _content, ...metadata }) => metadata),
        listCodexEntriesByIds,
      },
    );

    const parentContext = result.promptInput.codexEntries?.find(
      (candidate) => candidate.id === parent.id,
    );
    expect(parentContext?.childrenContext).toContain("Resolved child body");
    expect(parentContext?.childrenContext).not.toContain("Base body");
    expect(parentContext?.childrenContext).not.toContain(
      "Phase hidden summary",
    );
    expect(parentContext?.childrenContext).not.toContain(
      "Mentioned child summary",
    );
    expect(parentContext?.childrenContext).toContain("Mentioned child");
    const prompt = buildSystemPrompt(result.promptInput).prompt;
    expect(prompt).toContain("Mentioned child");
    expect(prompt).not.toContain("Mentioned child summary");
    const loadedIds = listCodexEntriesByIds.mock.calls.flatMap(([, ids]) => [
      ...ids,
    ]);
    expect(loadedIds).toEqual(
      expect.arrayContaining([parent.id, visibleChild.id]),
    );
    expect(loadedIds).not.toEqual(
      expect.arrayContaining([mentionedChild.id, hiddenChild.id]),
    );
  });

  it("treats every visible direct child of a manual withChildren pin as explicitly selected", async () => {
    const parent = entry({
      id: "manual-parent",
      name: "Manual parent",
      contextMode: "suppress",
      summary: "Parent summary",
    });
    const mentionedChild = entry({
      id: "manual-mentioned-child",
      name: "Manual mentioned child",
      parentId: parent.id,
      contextMode: "mentioned",
      summary: "MANUAL_MENTIONED_SUMMARY",
      content: doc("MANUAL_MENTIONED_BODY"),
      tagsCache: JSON.stringify(["manual-child-tag"]),
    });
    const suppressChild = entry({
      id: "manual-suppress-child",
      name: "Manual suppress child",
      parentId: parent.id,
      contextMode: "suppress",
      summary: "MANUAL_SUPPRESS_SUMMARY",
      content: doc("MANUAL_SUPPRESS_BODY"),
    });
    const alwaysChild = entry({
      id: "manual-always-child",
      name: "Manual always child",
      parentId: parent.id,
      contextMode: "always",
      summary: "MANUAL_ALWAYS_SUMMARY",
      content: doc("MANUAL_ALWAYS_BODY"),
    });
    const hiddenChild = entry({
      id: "manual-hidden-child",
      name: "Manual hidden child",
      parentId: parent.id,
      contextMode: "hidden",
      summary: "MANUAL_HIDDEN_SUMMARY",
      content: doc("MANUAL_HIDDEN_BODY"),
    });
    const entries = [
      parent,
      mentionedChild,
      suppressChild,
      alwaysChild,
      hiddenChild,
    ];
    const result = await collectSceneContext(
      request({ entries, sessionId: "session-1" }),
      {
        ...phaseDeps([], {
          contextDetails: [
            {
              entryId: suppressChild.id,
              definitionId: "role",
              fieldName: "Role",
              fieldType: "text",
              value: "Explicit child detail",
            },
          ],
        }),
        listPinnedCodex: async () => [pinnedCodex(parent, "manual", true)],
      },
    );

    const pinnedParent = result.promptInput.pinnedCodexEntries?.[0];
    expect(pinnedParent?.children?.map((child) => child.id)).toEqual(
      expect.arrayContaining([
        mentionedChild.id,
        suppressChild.id,
        alwaysChild.id,
      ]),
    );
    expect(pinnedParent?.children).toHaveLength(3);
    expect(pinnedParent?.childrenContext ?? "").not.toContain(
      "MANUAL_ALWAYS_SUMMARY",
    );
    const prompt = buildSystemPrompt(result.promptInput).prompt;
    expect(prompt).toContain("MANUAL_MENTIONED_BODY");
    expect(prompt).toContain("MANUAL_SUPPRESS_BODY");
    expect(prompt).toContain("MANUAL_ALWAYS_BODY");
    expect(prompt).toContain("manual-child-tag");
    expect(prompt).toContain("Explicit child detail");
    expect(prompt).not.toContain("MANUAL_HIDDEN_SUMMARY");
    expect(prompt).not.toContain("MANUAL_HIDDEN_BODY");
    expect(prompt.match(/MANUAL_ALWAYS_SUMMARY/g)).toHaveLength(1);
  });

  it("keeps an excluded outgoing and structured mention unloaded and unrendered", async () => {
    const excluded = entry({
      id: "dismissed-entry",
      name: "Dismissed Entry",
      summary: "DISMISSED_SECRET_SUMMARY",
      content: doc("DISMISSED_SECRET_BODY"),
    });
    const listCodexEntriesByIds = vi.fn(
      async (_projectId: string, ids: readonly string[]) =>
        ids.includes(excluded.id) ? [excluded] : [],
    );
    const result = await collectSceneContext(
      request({
        entries: [excluded],
        prefetch: false,
        outgoingUserMessage: "Ask about Dismissed Entry",
        mentionedCodexIds: [excluded.id],
        inputPinnedEntryIds: [excluded.id],
        excludedAutoEntryIds: [excluded.id],
      }),
      {
        ...phaseDeps([]),
        listCodexContextMetadata: async () => {
          const { content: _content, ...metadata } = excluded;
          return [metadata];
        },
        listCodexEntriesByIds,
        findMentionedEntries: async () => [excluded],
      },
    );

    const loadedIds = listCodexEntriesByIds.mock.calls.flatMap(([, ids]) =>
      ids ? [...ids] : [],
    );
    expect(loadedIds).not.toContain(excluded.id);
    const prompt = buildSystemPrompt(result.promptInput).prompt;
    expect(prompt).not.toContain("Dismissed Entry");
    expect(prompt).not.toContain("DISMISSED_SECRET_SUMMARY");
    expect(prompt).not.toContain("DISMISSED_SECRET_BODY");
  });

  it("keeps excluded automatic children and relations out of the prompt", async () => {
    const parent = entry({
      id: "parent",
      name: "Parent",
      contextMode: "always",
      summary: "Parent summary",
    });
    const child = entry({
      id: "excluded-child",
      name: "Excluded child",
      parentId: parent.id,
      contextMode: "always",
      summary: "Excluded child summary",
    });
    const related = entry({
      id: "excluded-relation",
      name: "Excluded relation",
      contextMode: "always",
      summary: "Excluded relation summary",
    });
    const result = await collectSceneContext(
      request({
        entries: [parent, child, related],
        excludedAutoEntryIds: [child.id, related.id],
      }),
      {
        ...phaseDeps([]),
        listCodexRelations: async () => [
          {
            id: "relation-1",
            projectId: "project-1",
            fromCodexId: parent.id,
            toCodexId: related.id,
            relationType: "ally",
            label: "ally",
            depthHint: null,
            sourceMapEdgeId: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      },
    );

    const parentContext = result.promptInput.codexEntries?.find(
      (candidate) => candidate.id === parent.id,
    );
    expect(parentContext?.childrenContext).toBeUndefined();
    expect(result.promptInput.relationCodexEntries).toBeUndefined();
    expect(result.alwaysEntries.map((candidate) => candidate.id)).toEqual([
      parent.id,
    ]);
    expect(JSON.stringify(result.promptInput)).not.toContain(
      "Excluded child summary",
    );
    expect(JSON.stringify(result.promptInput)).not.toContain(
      "Excluded relation summary",
    );
  });

  it("renders a mentioned relation target as identity-only", async () => {
    const parent = entry({
      id: "parent",
      name: "Parent",
      contextMode: "always",
      summary: "Parent summary",
    });
    const related = entry({
      id: "related",
      name: "Related identity",
      contextMode: "mentioned",
      summary: "Related secret summary",
      content: doc("Related secret body"),
    });
    const result = await collectSceneContext(
      request({ entries: [parent, related] }),
      {
        ...phaseDeps([]),
        listCodexRelations: async () => [
          {
            id: "relation-1",
            projectId: "project-1",
            fromCodexId: parent.id,
            toCodexId: related.id,
            relationType: "ally",
            label: "ally",
            depthHint: null,
            sourceMapEdgeId: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      },
    );
    const prompt = buildSystemPrompt(result.promptInput).prompt;

    expect(prompt).toContain("Related identity");
    expect(prompt).toContain("ally");
    expect(prompt).not.toContain("Related secret summary");
    expect(prompt).not.toContain("Related secret body");
  });

  it("does not expose an effective hidden Codex through active-tab content", async () => {
    const alice = entry({ id: "alice", name: "Alice" });
    const result = await collectSceneContext(
      request({
        entries: [alice],
        activeTabId: alice.id,
      }),
      phaseDeps([
        phase({
          id: "phase-1",
          entryId: alice.id,
          contentOverride: doc("Hidden active-tab body"),
          contextModeOverride: "hidden",
        }),
      ]),
    );

    expect(result.promptInput.activeTabContent).toBeUndefined();
    expect(result.promptInput.pinnedCodexEntries).toEqual([]);
  });
});
