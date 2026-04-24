import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  filterAndSortSessions,
  groupSessionsByScene,
} from "./chatHistoryStore";
import type { SessionWithStats } from "./chatHistoryApi";

// Helper to build a minimal SessionWithStats
function makeSession(
  overrides: Partial<SessionWithStats> & { id: string },
): SessionWithStats {
  return {
    projectId: "proj-1",
    nodeId: null,
    title: "Session",
    titleManual: 0,
    model: "claude",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    msgCount: 0,
    codexCount: 0,
    snippetCount: 0,
    firstUserMessage: null,
    ...overrides,
  };
}

const sessions: SessionWithStats[] = [
  makeSession({
    id: "s1",
    nodeId: "scene-a",
    title: "Alpha",
    updatedAt: "2024-03-01T00:00:00Z",
    msgCount: 10,
    codexCount: 2,
    snippetCount: 1,
  }),
  makeSession({
    id: "s2",
    nodeId: "scene-b",
    title: "Beta",
    updatedAt: "2024-03-02T00:00:00Z",
    msgCount: 4,
    codexCount: 0,
    snippetCount: 0,
  }),
  makeSession({
    id: "s3",
    nodeId: null,
    title: "Gamma",
    updatedAt: "2024-03-03T00:00:00Z",
    msgCount: 7,
    codexCount: 0,
    snippetCount: 3,
  }),
  makeSession({
    id: "s4",
    nodeId: "scene-a",
    title: "Delta",
    updatedAt: "2024-02-28T00:00:00Z",
    msgCount: 2,
    codexCount: 1,
    snippetCount: 0,
  }),
];

const defaultFilters = {
  sceneFilter: null,
  hasExtractionsOnly: false,
  projectScopeOnly: false,
  sortMode: "recent" as const,
};

describe("filterAndSortSessions", () => {
  it("returns all sessions with no filters (sorted recent first)", () => {
    const result = filterAndSortSessions(sessions, defaultFilters);
    expect(result.map((s) => s.id)).toEqual(["s3", "s2", "s1", "s4"]);
  });

  it("filters by sceneFilter (nodeId)", () => {
    const result = filterAndSortSessions(sessions, {
      ...defaultFilters,
      sceneFilter: "scene-a",
    });
    expect(result.map((s) => s.id)).toEqual(["s1", "s4"]);
  });

  it("filters by hasExtractionsOnly (codex OR snippet > 0)", () => {
    const result = filterAndSortSessions(sessions, {
      ...defaultFilters,
      hasExtractionsOnly: true,
    });
    expect(result.map((s) => s.id)).toEqual(["s3", "s1", "s4"]);
  });

  it("filters by projectScopeOnly (nodeId === null)", () => {
    const result = filterAndSortSessions(sessions, {
      ...defaultFilters,
      projectScopeOnly: true,
    });
    expect(result.map((s) => s.id)).toEqual(["s3"]);
  });

  it("sceneFilter and projectScopeOnly are mutually exclusive: sceneFilter takes precedence", () => {
    const result = filterAndSortSessions(sessions, {
      ...defaultFilters,
      sceneFilter: "scene-a",
      projectScopeOnly: true,
    });
    // sceneFilter wins
    expect(result.map((s) => s.id)).toEqual(["s1", "s4"]);
  });

  it("sorts oldest first", () => {
    const result = filterAndSortSessions(sessions, {
      ...defaultFilters,
      sortMode: "oldest",
    });
    expect(result.map((s) => s.id)).toEqual(["s4", "s1", "s2", "s3"]);
  });

  it("sorts by most messages", () => {
    const result = filterAndSortSessions(sessions, {
      ...defaultFilters,
      sortMode: "most_messages",
    });
    expect(result[0].id).toBe("s1"); // 10 msgs
    expect(result[1].id).toBe("s3"); // 7 msgs
    expect(result[2].id).toBe("s2"); // 4 msgs
    expect(result[3].id).toBe("s4"); // 2 msgs
  });

  it("sorts by most extractions (codex + snippet)", () => {
    const result = filterAndSortSessions(sessions, {
      ...defaultFilters,
      sortMode: "most_extractions",
    });
    // s1: 2+1=3, s3: 0+3=3, s4: 1+0=1, s2: 0
    expect(result.map((s) => s.id).slice(0, 2)).toEqual(
      expect.arrayContaining(["s1", "s3"]),
    );
    expect(result[2].id).toBe("s4");
    expect(result[3].id).toBe("s2");
  });

  it("returns empty array for empty input", () => {
    expect(filterAndSortSessions([], defaultFilters)).toEqual([]);
  });
});

describe("groupSessionsByScene", () => {
  const nodeMap = {
    "scene-a": { title: "Scene A", parentId: null },
    "scene-b": { title: "Scene B", parentId: null },
  };

  it("groups sessions by nodeId", () => {
    const filtered = filterAndSortSessions(sessions, defaultFilters);
    const groups = groupSessionsByScene(filtered, nodeMap);
    const labels = groups.map((g) => g.groupLabel);
    expect(labels).toContain("Scene A");
    expect(labels).toContain("Scene B");
    expect(labels).toContain("Project scope");
  });

  it("places project-scope sessions (nodeId=null) in Project scope group", () => {
    const filtered = filterAndSortSessions(sessions, defaultFilters);
    const groups = groupSessionsByScene(filtered, nodeMap);
    const projectGroup = groups.find((g) => g.nodeId === null);
    expect(projectGroup).toBeDefined();
    expect(projectGroup!.sessions.map((s) => s.id)).toContain("s3");
  });

  it("groups multiple sessions under the same scene", () => {
    const filtered = filterAndSortSessions(sessions, defaultFilters);
    const groups = groupSessionsByScene(filtered, nodeMap);
    const sceneAGroup = groups.find((g) => g.nodeId === "scene-a");
    expect(sceneAGroup!.sessions).toHaveLength(2);
  });

  it("uses nodeId as fallback label when nodeId not in nodeMap", () => {
    const filtered = filterAndSortSessions(sessions, defaultFilters);
    const groups = groupSessionsByScene(filtered, {});
    // All scene-linked sessions fall back to showing their nodeId
    const unknownGroup = groups.find((g) => g.nodeId === "scene-a");
    expect(unknownGroup!.groupLabel).toBe("scene-a");
  });
});

describe("chatHistoryStore state", () => {
  // These tests check the Zustand store state mutations
  beforeEach(() => {
    vi.resetModules();
  });

  it("defaults are correct", async () => {
    const { useChatHistoryStore } = await import("./chatHistoryStore");
    const state = useChatHistoryStore.getState();
    expect(state.searchQuery).toBe("");
    expect(state.sceneFilter).toBeNull();
    expect(state.hasExtractionsOnly).toBe(false);
    expect(state.projectScopeOnly).toBe(false);
    expect(state.sortMode).toBe("recent");
    expect(state.sessions).toEqual([]);
    expect(state.searchResults).toEqual([]);
    expect(state.isSearchMode).toBe(false);
  });

  it("setSearchQuery updates state and sets isSearchMode", async () => {
    const { useChatHistoryStore } = await import("./chatHistoryStore");
    useChatHistoryStore.getState().setSearchQuery("magic system");
    expect(useChatHistoryStore.getState().searchQuery).toBe("magic system");
  });

  it("setSearchQuery empty string clears isSearchMode", async () => {
    const { useChatHistoryStore } = await import("./chatHistoryStore");
    useChatHistoryStore.getState().setSearchQuery("test");
    useChatHistoryStore.getState().setSearchQuery("");
    expect(useChatHistoryStore.getState().isSearchMode).toBe(false);
  });

  it("setSceneFilter updates sceneFilter", async () => {
    const { useChatHistoryStore } = await import("./chatHistoryStore");
    useChatHistoryStore.getState().setSceneFilter("scene-x");
    expect(useChatHistoryStore.getState().sceneFilter).toBe("scene-x");
  });

  it("toggleHasExtractionsOnly flips the boolean", async () => {
    const { useChatHistoryStore } = await import("./chatHistoryStore");
    useChatHistoryStore.setState({ hasExtractionsOnly: false });
    useChatHistoryStore.getState().toggleHasExtractionsOnly();
    expect(useChatHistoryStore.getState().hasExtractionsOnly).toBe(true);
    useChatHistoryStore.getState().toggleHasExtractionsOnly();
    expect(useChatHistoryStore.getState().hasExtractionsOnly).toBe(false);
  });

  it("toggleProjectScopeOnly flips the boolean", async () => {
    const { useChatHistoryStore } = await import("./chatHistoryStore");
    useChatHistoryStore.setState({ projectScopeOnly: false });
    useChatHistoryStore.getState().toggleProjectScopeOnly();
    expect(useChatHistoryStore.getState().projectScopeOnly).toBe(true);
  });

  it("setSortMode updates sortMode", async () => {
    const { useChatHistoryStore } = await import("./chatHistoryStore");
    useChatHistoryStore.getState().setSortMode("most_messages");
    expect(useChatHistoryStore.getState().sortMode).toBe("most_messages");
  });
});
