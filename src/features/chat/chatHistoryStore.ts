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
      if (
        s.nodeId !== null ||
        s.codexAnchorId !== null ||
        s.snippetAnchorId !== null
      )
        return false;
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
  codexAnchorId: string | null;
  snippetAnchorId: string | null;
  sessions: SessionWithStats[];
}

/**
 * Pure function: group sessions by scope (scene/folder, project, codex, snippet).
 * Exported for unit testing.
 */
export function groupSessionsByScope(
  sessions: SessionWithStats[],
  nodeMap: Record<string, SceneNode>,
  codexEntryMap: Record<string, { name: string }> = {},
  snippetEntryMap: Record<string, { title: string }> = {},
): SessionGroup[] {
  const groupMap = new Map<string, SessionWithStats[]>();

  for (const session of sessions) {
    let key: string;
    if (session.codexAnchorId) {
      key = `codex:${session.codexAnchorId}`;
    } else if (session.snippetAnchorId) {
      key = `snippet:${session.snippetAnchorId}`;
    } else if (session.nodeId) {
      key = `scene:${session.nodeId}`;
    } else {
      key = "project";
    }
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(session);
  }

  const groups: SessionGroup[] = [];
  for (const [key, groupSessions] of groupMap) {
    let groupLabel: string;
    let nodeId: string | null = null;
    let codexAnchorId: string | null = null;
    let snippetAnchorId: string | null = null;
    if (key.startsWith("codex:")) {
      codexAnchorId = key.slice(6);
      const entry = codexEntryMap[codexAnchorId];
      groupLabel = entry ? `Codex: ${entry.name}` : `Codex: ${codexAnchorId}`;
    } else if (key.startsWith("snippet:")) {
      snippetAnchorId = key.slice(8);
      const snippet = snippetEntryMap[snippetAnchorId];
      groupLabel = snippet
        ? `Snippet: ${snippet.title}`
        : `Snippet: ${snippetAnchorId}`;
    } else if (key.startsWith("scene:")) {
      nodeId = key.slice(6);
      groupLabel = nodeMap[nodeId]?.title ?? nodeId;
    } else {
      groupLabel = "Project scope";
    }
    groups.push({
      groupLabel,
      nodeId,
      codexAnchorId,
      snippetAnchorId,
      sessions: groupSessions,
    });
  }

  // Sort: scene groups first, project scope, anchored (codex/snippet) groups last
  const isAnchored = (g: SessionGroup) =>
    g.codexAnchorId !== null || g.snippetAnchorId !== null;
  return groups.sort((a, b) => {
    if (isAnchored(a) && !isAnchored(b)) return 1;
    if (!isAnchored(a) && isAnchored(b)) return -1;
    if (a.nodeId === null && b.nodeId !== null && !isAnchored(a)) return 1;
    if (a.nodeId !== null && b.nodeId === null && !isAnchored(b)) return -1;
    return 0;
  });
}

/** @deprecated use groupSessionsByScope */
export const groupSessionsByScene = groupSessionsByScope;

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
