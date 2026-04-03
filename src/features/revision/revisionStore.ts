import { create } from "zustand";
import type { EntityType, SnapshotType, RevisionMeta } from "./api";

interface RevisionHistoryState {
  /** Whether the history modal is open */
  isOpen: boolean;
  /** Entity being viewed */
  entityType: EntityType | null;
  entityId: string | null;
  /** Current content of the entity (for "Current version" display) */
  currentContent: string | null;
  /** Loaded revisions (metadata only) */
  revisions: RevisionMeta[];
  /** ID of selected revision (null = "current version") */
  selectedRevisionId: string | null;
  /** Content of selected revision (loaded on demand) */
  selectedContent: string | null;
  isLoadingContent: boolean;
  page: number;
  hasMore: boolean;

  /** Tracks last auto-revision timestamps per entityId */
  lastAutoRevisionAt: Record<string, number>;

  openHistory: (
    entityType: EntityType,
    entityId: string,
    currentContent: string,
  ) => void;
  closeHistory: () => void;
  loadRevisions: () => Promise<void>;
  loadMore: () => Promise<void>;
  selectRevision: (id: string | null) => Promise<void>;

  /** Record the time of the last auto-revision for an entity */
  recordAutoRevision: (entityId: string) => void;
  /** Check if enough time has passed for auto-revision (default: 5 min) */
  shouldAutoRevision: (entityId: string, intervalMs?: number) => boolean;
}

const PAGE_SIZE = 20;

export const useRevisionStore = create<RevisionHistoryState>()((set, get) => ({
  isOpen: false,
  entityType: null,
  entityId: null,
  currentContent: null,
  revisions: [],
  selectedRevisionId: null,
  selectedContent: null,
  isLoadingContent: false,
  page: 0,
  hasMore: false,
  lastAutoRevisionAt: {},

  openHistory(entityType, entityId, currentContent) {
    set({
      isOpen: true,
      entityType,
      entityId,
      currentContent,
      revisions: [],
      selectedRevisionId: null,
      selectedContent: null,
      page: 0,
      hasMore: false,
    });
    get().loadRevisions();
  },

  closeHistory() {
    set({ isOpen: false });
  },

  async loadRevisions() {
    const { entityType, entityId } = get();
    if (!entityType || !entityId) return;
    const { listRevisions } = await import("./api");
    const items = await listRevisions(entityType, entityId, PAGE_SIZE, 0);
    set({
      revisions: items,
      page: 1,
      hasMore: items.length === PAGE_SIZE,
    });
  },

  async loadMore() {
    const { entityType, entityId, revisions, page, hasMore } = get();
    if (!entityType || !entityId || !hasMore) return;
    const { listRevisions } = await import("./api");
    const more = await listRevisions(
      entityType,
      entityId,
      PAGE_SIZE,
      page * PAGE_SIZE,
    );
    set({
      revisions: [...revisions, ...more],
      page: page + 1,
      hasMore: more.length === PAGE_SIZE,
    });
  },

  async selectRevision(id) {
    if (id === null) {
      set({ selectedRevisionId: null, selectedContent: get().currentContent });
      return;
    }
    set({ selectedRevisionId: id, isLoadingContent: true });
    try {
      const { getRevision } = await import("./api");
      const rev = await getRevision(id);
      set({ selectedContent: rev?.content ?? null, isLoadingContent: false });
    } catch {
      set({ isLoadingContent: false });
    }
  },

  recordAutoRevision(entityId) {
    set((state) => ({
      lastAutoRevisionAt: {
        ...state.lastAutoRevisionAt,
        [entityId]: Date.now(),
      },
    }));
  },

  shouldAutoRevision(entityId, intervalMs = 5 * 60 * 1000) {
    const last = get().lastAutoRevisionAt[entityId];
    if (!last) return true;
    return Date.now() - last >= intervalMs;
  },
}));

/** Entity type helper for tree nodes */
export function getEntityType(nodeType: string): EntityType | null {
  if (nodeType === "scene") return "scene";
  if (nodeType === "note") return "note";
  return null;
}

export type { EntityType, SnapshotType };
