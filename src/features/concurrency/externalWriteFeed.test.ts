import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  reloadTree: vi.fn().mockResolvedValue(undefined),
  loadCodex: vi.fn().mockResolvedValue(undefined),
  loadSnippets: vi.fn().mockResolvedValue(undefined),
  loadForeshadows: vi.fn().mockResolvedValue(undefined),
  dirtyTabs: new Set<string>(),
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({
      reloadTreeOrThrow: h.reloadTree,
    }),
  },
}));

vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: {
    getState: () => ({ loadEntries: h.loadCodex }),
  },
}));

vi.mock("@/features/snippets/snippetStore", () => ({
  useSnippetStore: {
    getState: () => ({ loadEntries: h.loadSnippets }),
  },
}));

vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: {
    getState: () => ({ dirtyTabIds: h.dirtyTabs, setTabDirty: vi.fn() }),
  },
}));

vi.mock("@/features/foreshadow/foreshadowStore", () => ({
  useForeshadowStore: {
    getState: () => ({ load: h.loadForeshadows }),
  },
}));

import {
  processExternalEventsForTest,
  stopExternalWriteFeed,
} from "./externalWriteFeed";
import { useExternalWriteStore } from "./externalWriteStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useInlineAiStore } from "@/features/editor/inlineAi/inlineAiStore";

const ev = (
  partial: Partial<{
    sequence: number;
    domain: string;
    sceneId: string | null;
    entityType: string | null;
    entityId: string | null;
    opType: string;
  }>,
) => ({
  id: 1,
  eventUid: "uid",
  projectId: "p1",
  sessionId: "other",
  sequence: partial.sequence ?? 1,
  domain: partial.domain ?? "codex",
  opType: partial.opType ?? "entry.create",
  entityType: partial.entityType ?? null,
  entityId: partial.entityId ?? null,
  sceneId: partial.sceneId ?? null,
  payload: "{}",
  timestamp: Date.now(),
  prevHash: "0",
  hash: "1",
});

describe("externalWriteFeed fan-out", () => {
  beforeEach(() => {
    stopExternalWriteFeed();
    h.reloadTree.mockClear();
    h.loadCodex.mockClear();
    h.loadSnippets.mockClear();
    h.dirtyTabs = new Set();
    useExternalWriteStore.getState().clear();
    useInlineAiStore.getState().reset();
  });

  it("reloads codex store on codex domain events", async () => {
    await processExternalEventsForTest([ev({ domain: "codex" })], "p1");
    expect(h.loadCodex).toHaveBeenCalledTimes(1);
  });

  it("reloads tree on grid domain events", async () => {
    await processExternalEventsForTest([ev({ domain: "grid" })], "p1");
    expect(h.reloadTree).toHaveBeenCalledWith("p1");
  });

  it("reloads foreshadow store on foreshadow domain events", async () => {
    await processExternalEventsForTest(
      [
        ev({
          domain: "foreshadow",
          opType: "foreshadow.create",
          entityType: "foreshadow",
          entityId: "f1",
        }),
      ],
      "p1",
    );
    expect(h.loadForeshadows).toHaveBeenCalledWith("p1");
  });

  it("pushes conflict for dirty editor scene", async () => {
    h.dirtyTabs.add("scene-1");
    await processExternalEventsForTest(
      [
        ev({
          domain: "editor",
          sceneId: "scene-1",
          entityType: "scene",
          entityId: "scene-1",
          opType: "body.update",
        }),
      ],
      "p1",
    );
    expect(useExternalWriteStore.getState().conflicts).toHaveLength(1);
    expect(
      useExternalWriteStore.getState().reloadNonce["scene-1"],
    ).toBeUndefined();
  });

  it("bumps reload nonce for clean editor scene", async () => {
    await processExternalEventsForTest(
      [
        ev({
          domain: "editor",
          sceneId: "scene-2",
          entityType: "scene",
          entityId: "scene-2",
        }),
      ],
      "p1",
    );
    expect(useExternalWriteStore.getState().reloadNonce["scene-2"]).toBe(1);
  });

  it("pushes conflict instead of reloading clean editor scene while inline AI is pending", async () => {
    useInlineAiStore.getState().startGeneration({
      commandId: "continue",
      mode: "insert",
      originalRange: null,
      originalText: "",
      insertPos: 1,
      abortController: new AbortController(),
    });
    useInlineAiStore.getState().finishGeneration("m");

    await processExternalEventsForTest(
      [
        ev({
          domain: "editor",
          sceneId: "scene-pending",
          entityType: "scene",
          entityId: "scene-pending",
          opType: "body.update",
        }),
      ],
      "p1",
    );

    expect(useExternalWriteStore.getState().conflicts).toHaveLength(1);
    expect(useExternalWriteStore.getState().conflicts[0]).toMatchObject({
      sceneId: "scene-pending",
      domain: "editor",
      opType: "body.update",
      entityId: "scene-pending",
    });
    expect(
      useExternalWriteStore.getState().reloadNonce["scene-pending"],
    ).toBeUndefined();
  });

  it("pushes conflict for dirty snippet tab", async () => {
    h.dirtyTabs.add("snippet-1");
    await processExternalEventsForTest(
      [
        ev({
          domain: "snippet",
          entityType: "snippet",
          entityId: "snippet-1",
          opType: "snippet.update",
        }),
      ],
      "p1",
    );
    expect(useExternalWriteStore.getState().conflicts).toHaveLength(1);
    expect(useExternalWriteStore.getState().conflicts[0].sceneId).toBe(
      "snippet-1",
    );
  });

  it("bumps reload nonce for clean snippet tab", async () => {
    await processExternalEventsForTest(
      [
        ev({
          domain: "snippet",
          entityType: "snippet",
          entityId: "snippet-2",
          opType: "snippet.create",
        }),
      ],
      "p1",
    );
    expect(useExternalWriteStore.getState().reloadNonce["snippet-2"]).toBe(1);
  });
});

// Importing this module registers handleUndoConflict via setUndoConflictHandler
// (a top-level side effect). These tests pin that the conflict-surfacing logic —
// moved out of globalHistoryStore to break the projectStore↔treeStore import
// cycle — still fires. (This file has been the site of two regressions across
// three touches; the feature was previously asserted only by "body copied
// correctly", never by a test.)
describe("undo version-conflict surfacing (registered handler)", () => {
  beforeEach(() => {
    h.dirtyTabs = new Set();
    useExternalWriteStore.getState().clear();
    useGlobalHistoryStore.getState().clear();
  });

  function pushConflicting(entityId: string) {
    useGlobalHistoryStore.getState().push({
      kind: "codex",
      label: "stale",
      entityId,
      undo: async () => {
        throw new Error(
          `codex entry '${entityId}' version 2 conflict during journal restore`,
        );
      },
      redo: async () => {},
    });
  }

  it("pushes a conflict banner when the entity's tab is dirty", async () => {
    h.dirtyTabs.add("entry-1");
    pushConflicting("entry-1");
    await useGlobalHistoryStore.getState().undo();

    const conflicts = useExternalWriteStore.getState().conflicts;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      sceneId: "entry-1",
      domain: "codex",
      opType: "undo.version_conflict",
      entityId: "entry-1",
    });
    // Conflict drops only the failed entry; history is not wiped.
    expect(useGlobalHistoryStore.getState().past).toHaveLength(0);
  });

  it("bumps reload nonce (no banner) when the entity's tab is clean", async () => {
    pushConflicting("entry-2");
    await useGlobalHistoryStore.getState().undo();

    expect(useExternalWriteStore.getState().conflicts).toHaveLength(0);
    expect(useExternalWriteStore.getState().reloadNonce["entry-2"]).toBe(1);
  });
});
