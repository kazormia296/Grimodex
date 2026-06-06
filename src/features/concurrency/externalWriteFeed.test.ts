import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  reloadTree: vi.fn().mockResolvedValue(undefined),
  loadCodex: vi.fn().mockResolvedValue(undefined),
  loadSnippets: vi.fn().mockResolvedValue(undefined),
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

import {
  processExternalEventsForTest,
  stopExternalWriteFeed,
} from "./externalWriteFeed";
import { useExternalWriteStore } from "./externalWriteStore";

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
  });

  it("reloads codex store on codex domain events", async () => {
    await processExternalEventsForTest([ev({ domain: "codex" })], "p1");
    expect(h.loadCodex).toHaveBeenCalledTimes(1);
  });

  it("reloads tree on grid domain events", async () => {
    await processExternalEventsForTest([ev({ domain: "grid" })], "p1");
    expect(h.reloadTree).toHaveBeenCalledWith("p1");
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
});
