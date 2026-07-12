import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { CodexEntryPhase, CodexPhaseDetailOverride } from "@/db/schema";
import type { CodexContextEntry } from "@/features/codex/api";
import { buildSceneTimeIndex } from "@/features/codex/context/sceneTimeIndex";
import type { TreeNodeData } from "@/features/tree/treeStore";
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
}

function request(overrides: RequestOverrides = {}) {
  return createSceneTurnContextRequest({
    requestId: "request-1",
    purpose: "live",
    projectId: "project-1",
    sessionId: null,
    sceneId: "scene-1",
    mode: "chat",
    route: null,
    budget: { contextWindow: 16_384, deliveryMode: "plain" },
    messages: [],
    outgoingUserMessage: "",
    mentionedSceneIds: [],
    mentionedCodexIds: [],
    inputPinnedEntryIds: overrides.inputPinnedEntryIds ?? [],
    excludedAutoEntryIds: [],
    sessionStableCodexIds: [],
    includeBodies: overrides.includeBodies ?? true,
    map: { enabled: false, boardId: null, activeBoardId: null },
    activeTab: overrides.activeTabId
      ? { nodeId: overrides.activeTabId, contentType: "codex" }
      : null,
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

  it("contains no direct Chat store or implicit current-project reads", () => {
    const source = readFileSync(
      new URL("./sceneContextSource.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/useChatStore/);
    expect(source).not.toMatch(/getCurrentProjectId/);
  });

  it.each([
    { mode: "hidden", pinned: true },
    { mode: "suppress", pinned: false },
  ])(
    "excludes Base-mentioned entries after Phase $mode resolution",
    async ({ mode, pinned }) => {
      const alice = entry({ id: "alice", name: "Alice" });
      const result = await collectSceneContext(
        request({
          entries: [alice],
          sceneContent: "Alice appears",
          inputPinnedEntryIds: pinned ? [alice.id] : [],
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
        inputPinnedEntryIds: [hidden.id, "missing-pin"],
      }),
      phaseDeps([]),
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
        inputPinnedEntryIds: [alice.id],
      }),
      phaseDeps([
        phase({
          id: "phase-1",
          entryId: alice.id,
          summaryOverride: "Pinned phase summary",
          contentOverride: doc("Pinned phase body"),
          contextModeOverride: "suppress",
        }),
      ]),
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
      request({ entries: [alice], inputPinnedEntryIds: [alice.id] }),
      phaseDeps([currentPhase], {
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
    const hiddenChild = entry({
      id: "hidden-child",
      name: "Hidden child",
      parentId: parent.id,
      summary: "Base hidden summary",
    });
    const result = await collectSceneContext(
      request({ entries: [parent, visibleChild, hiddenChild] }),
      phaseDeps([
        phase({
          id: "phase-visible",
          entryId: visibleChild.id,
          contentOverride: doc("Resolved child body"),
          contextModeOverride: "mentioned",
        }),
        phase({
          id: "phase-hidden",
          entryId: hiddenChild.id,
          summaryOverride: "Phase hidden summary",
          contextModeOverride: "hidden",
        }),
      ]),
    );

    const parentContext = result.promptInput.codexEntries?.find(
      (candidate) => candidate.id === parent.id,
    );
    expect(parentContext?.childrenContext).toContain("Resolved child body");
    expect(parentContext?.childrenContext).not.toContain("Base body");
    expect(parentContext?.childrenContext).not.toContain(
      "Phase hidden summary",
    );
  });

  it("does not expose an effective hidden Codex through active-tab content", async () => {
    const alice = entry({ id: "alice", name: "Alice" });
    const result = await collectSceneContext(
      request({
        entries: [alice],
        activeTabId: alice.id,
        inputPinnedEntryIds: [alice.id],
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
