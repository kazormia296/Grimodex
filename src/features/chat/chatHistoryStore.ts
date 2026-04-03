import { create } from "zustand";
import { listSessionsWithStats, searchChatMessages } from "./chatHistoryApi";
import type { SessionWithStats, MessageSearchHit } from "./chatHistoryApi";

export type SortMode =
  | "recent"
  | "oldest"
  | "most_messages"
  | "most_extractions";

export interface FilterOptions {
  sceneFilter: string | null;
  hasExtractionsOnly: boolean;
  projectScopeOnly: boolean;
  sortMode: SortMode;
}

/**
 * Pure function: filter and sort sessions based on UI filter state.
 * Exported for unit testing.
 */
export function filterAndSortSessions(
  sessions: SessionWithStats[],
  filters: FilterOptions,
): SessionWithStats[] {
  const { sceneFilter, hasExtractionsOnly, projectScopeOnly, sortMode } =
    filters;

  let result = sessions.filter((s) => {
    // sceneFilter takes precedence over projectScopeOnly
    if (sceneFilter !== null) {
      if (s.nodeId !== sceneFilter) return false;
    } else if (projectScopeOnly) {
      if (s.nodeId !== null) return false;
    }
    if (hasExtractionsOnly && s.codexCount + s.snippetCount === 0) return false;
    return true;
  });

  result = [...result].sort((a, b) => {
    switch (sortMode) {
      case "recent":
        return b.updatedAt.localeCompare(a.updatedAt);
      case "oldest":
        return a.updatedAt.localeCompare(b.updatedAt);
      case "most_messages":
        return b.msgCount - a.msgCount;
      case "most_extractions":
        return b.codexCount + b.snippetCount - (a.codexCount + a.snippetCount);
    }
  });

  return result;
}

export interface SceneNode {
  title: string;
  parentId: string | null;
}

export interface SessionGroup {
  groupLabel: string;
  nodeId: string | null;
  sessions: SessionWithStats[];
}

/**
 * Pure function: group sessions by scene.
 * Exported for unit testing.
 */
export function groupSessionsByScene(
  sessions: SessionWithStats[],
  nodeMap: Record<string, SceneNode>,
): SessionGroup[] {
  const groupMap = new Map<string | null, SessionWithStats[]>();

  for (const session of sessions) {
    const key = session.nodeId;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(session);
  }

  const groups: SessionGroup[] = [];
  for (const [nodeId, groupSessions] of groupMap) {
    const groupLabel =
      nodeId === null ? "Project scope" : (nodeMap[nodeId]?.title ?? nodeId);
    groups.push({ groupLabel, nodeId, sessions: groupSessions });
  }

  // Sort groups: scene groups first (in insertion order), project scope last
  return groups.sort((a, b) => {
    if (a.nodeId === null) return 1;
    if (b.nodeId === null) return -1;
    return 0;
  });
}

// --- Zustand store ---

interface ChatHistoryState {
  sessions: SessionWithStats[];
  isLoading: boolean;

  // Search
  searchQuery: string;
  searchResults: MessageSearchHit[];
  isSearchMode: boolean;
  isSearching: boolean;

  // Filters
  sceneFilter: string | null;
  hasExtractionsOnly: boolean;
  projectScopeOnly: boolean;
  sortMode: SortMode;

  // Actions
  loadSessions: (projectId: string) => Promise<void>;
  setSearchQuery: (q: string) => void;
  runSearch: (projectId: string) => Promise<void>;
  setSceneFilter: (nodeId: string | null) => void;
  toggleHasExtractionsOnly: () => void;
  toggleProjectScopeOnly: () => void;
  setSortMode: (mode: SortMode) => void;
}

export const useChatHistoryStore = create<ChatHistoryState>()((set, get) => ({
  sessions: [],
  isLoading: false,
  searchQuery: "",
  searchResults: [],
  isSearchMode: false,
  isSearching: false,
  sceneFilter: null,
  hasExtractionsOnly: false,
  projectScopeOnly: false,
  sortMode: "recent",

  async loadSessions(projectId) {
    set({ isLoading: true });
    try {
      const sessions = await listSessionsWithStats(projectId);
      set({ sessions, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  setSearchQuery(q) {
    set({ searchQuery: q, isSearchMode: q.trim().length > 0 });
    if (!q.trim()) {
      set({ searchResults: [] });
    }
  },

  async runSearch(projectId) {
    const { searchQuery } = get();
    if (!searchQuery.trim()) return;
    set({ isSearching: true });
    try {
      const results = await searchChatMessages(projectId, searchQuery);
      set({ searchResults: results, isSearching: false });
    } catch {
      set({ isSearching: false });
    }
  },

  setSceneFilter(nodeId) {
    set({ sceneFilter: nodeId });
  },

  toggleHasExtractionsOnly() {
    set((s) => ({ hasExtractionsOnly: !s.hasExtractionsOnly }));
  },

  toggleProjectScopeOnly() {
    set((s) => ({ projectScopeOnly: !s.projectScopeOnly }));
  },

  setSortMode(mode) {
    set({ sortMode: mode });
  },
}));
