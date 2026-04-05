import { create } from "zustand";
import { getSetting, setSetting } from "@/features/settings/api";

const TAB_STATE_KEY = "editor.tabState";
const SAVE_DEBOUNCE_MS = 500;

export interface TabEntry {
  nodeId: string;
  isPreview: boolean;
}

export type GroupIndex = 0 | 1;

interface PersistedTabState {
  tabs: TabEntry[];
  activeTabId: string | null;
  secondaryTabs: TabEntry[];
  secondaryActiveTabId: string | null;
  activeGroupIndex: GroupIndex;
}

interface TabState {
  // ---- Primary group ----
  tabs: TabEntry[];
  activeTabId: string | null;

  // ---- Secondary group (split view) ----
  secondaryTabs: TabEntry[];
  secondaryActiveTabId: string | null;

  /** Which group currently has keyboard focus (0 = primary, 1 = secondary) */
  activeGroupIndex: GroupIndex;

  // ---- Primary group operations ----

  /**
   * Single-click behavior: open as preview tab.
   * - If already pinned: just activate
   * - If already a preview for the same node: just activate
   * - If a different preview exists: replace it
   * - Otherwise: add new preview tab
   */
  openPreview: (nodeId: string) => void;

  /**
   * Double-click / Enter behavior: open as pinned tab.
   * - If already open as preview: promote to pinned
   * - If already pinned: just activate
   * - Otherwise: add new pinned tab
   */
  openPinned: (nodeId: string) => void;

  /** Promote a preview tab to pinned (called when user starts editing). */
  pinTab: (nodeId: string) => void;

  /** Close a tab. Activates adjacent tab if the closed one was active. */
  closeTab: (nodeId: string) => void;

  /** Activate a tab. No-op if nodeId is not in tabs. */
  setActiveTab: (nodeId: string) => void;

  /**
   * Ensure a node has a pinned tab (used for external activeSceneId changes).
   * If already open, just activate.
   */
  ensureTab: (nodeId: string) => void;

  // ---- Secondary group operations ----

  /**
   * Open a scene in the secondary group (Ctrl+Enter).
   * Creates a pinned tab in the secondary group and focuses it.
   */
  openInSecondaryGroup: (nodeId: string) => void;

  /** Close a tab in the secondary group. Resets activeGroupIndex if last tab. */
  closeSecondaryTab: (nodeId: string) => void;

  /** Close all secondary tabs and reset to primary group. */
  closeSecondaryGroup: () => void;

  /** Activate a tab in the secondary group. No-op if not found. */
  setSecondaryActiveTab: (nodeId: string) => void;

  /** Promote a preview tab in the secondary group to pinned. */
  pinSecondaryTab: (nodeId: string) => void;

  // ---- Group-level operations ----

  /** Set which group has keyboard focus. */
  setActiveGroup: (index: GroupIndex) => void;

  /**
   * Returns true if the scene is currently open in BOTH groups.
   * Used to show the sync badge in the tab bar.
   */
  isSyncedScene: (nodeId: string) => boolean;

  /** Reorder a tab within its group. fromIndex and toIndex are positions in the original array. */
  reorderTab: (
    fromIndex: number,
    toIndex: number,
    groupIndex: GroupIndex,
  ) => void;

  /**
   * Move a tab from one group to another.
   * If the source group would become empty (primary), the move is blocked.
   * If the secondary group becomes empty, it is automatically closed.
   * insertIndex is the position in the destination array (before removal) to insert at.
   */
  moveTabBetweenGroups: (
    nodeId: string,
    fromGroup: GroupIndex,
    toGroup: GroupIndex,
    insertIndex?: number,
  ) => void;

  // ---- Persistence ----

  /** Load tab state from workspace settings. If validNodeIds is provided,
   *  tabs referencing unknown IDs are filtered out. */
  loadTabState: (validNodeIds?: Set<string>) => Promise<void>;

  /** Save current tab state to workspace settings. */
  saveTabState: () => Promise<void>;

  /** Start auto-saving tab state on changes (debounced). */
  initAutoSave: () => void;

  /** Stop auto-saving (cleanup subscription). */
  disposeAutoSave?: () => void;
}

export const useTabStore = create<TabState>()((set, get) => ({
  tabs: [],
  activeTabId: null,
  secondaryTabs: [],
  secondaryActiveTabId: null,
  activeGroupIndex: 0,

  // ---- Primary group ----

  openPreview(nodeId) {
    const { tabs } = get();
    const existing = tabs.find((t) => t.nodeId === nodeId);

    if (existing) {
      // Remove any stale preview tab for other nodes
      const cleaned = tabs.filter((t) => !t.isPreview || t.nodeId === nodeId);
      set({ tabs: cleaned, activeTabId: nodeId, activeGroupIndex: 0 });
      return;
    }

    const withoutPreview = tabs.filter((t) => !t.isPreview);
    set({
      tabs: [...withoutPreview, { nodeId, isPreview: true }],
      activeTabId: nodeId,
      activeGroupIndex: 0,
    });
  },

  openPinned(nodeId) {
    const { tabs } = get();
    const existing = tabs.find((t) => t.nodeId === nodeId);

    if (existing) {
      if (existing.isPreview) {
        set({
          tabs: tabs.map((t) =>
            t.nodeId === nodeId ? { ...t, isPreview: false } : t,
          ),
          activeTabId: nodeId,
          activeGroupIndex: 0,
        });
      } else {
        set({ activeTabId: nodeId, activeGroupIndex: 0 });
      }
      return;
    }

    set({
      tabs: [...tabs, { nodeId, isPreview: false }],
      activeTabId: nodeId,
      activeGroupIndex: 0,
    });
  },

  pinTab(nodeId) {
    const { tabs } = get();
    const existing = tabs.find((t) => t.nodeId === nodeId);
    if (!existing || !existing.isPreview) return;

    set({
      tabs: tabs.map((t) =>
        t.nodeId === nodeId ? { ...t, isPreview: false } : t,
      ),
    });
  },

  closeTab(nodeId) {
    const { tabs, activeTabId } = get();
    const idx = tabs.findIndex((t) => t.nodeId === nodeId);
    if (idx === -1) return;

    const remaining = tabs.filter((t) => t.nodeId !== nodeId);

    let newActive = activeTabId;
    if (activeTabId === nodeId) {
      if (remaining.length === 0) {
        newActive = null;
      } else {
        const nextTab = remaining[idx] ?? remaining[idx - 1];
        newActive = nextTab.nodeId;
      }
    }

    set({ tabs: remaining, activeTabId: newActive });
  },

  setActiveTab(nodeId) {
    const { tabs } = get();
    if (!tabs.find((t) => t.nodeId === nodeId)) return;
    set({ activeTabId: nodeId, activeGroupIndex: 0 });
  },

  ensureTab(nodeId) {
    const { tabs } = get();
    if (tabs.find((t) => t.nodeId === nodeId)) {
      set({ activeTabId: nodeId });
      return;
    }
    set({
      tabs: [...tabs, { nodeId, isPreview: false }],
      activeTabId: nodeId,
    });
  },

  // ---- Secondary group ----

  openInSecondaryGroup(nodeId) {
    const { secondaryTabs } = get();
    const existing = secondaryTabs.find((t) => t.nodeId === nodeId);

    if (existing) {
      set({ secondaryActiveTabId: nodeId, activeGroupIndex: 1 });
      return;
    }

    set({
      secondaryTabs: [...secondaryTabs, { nodeId, isPreview: false }],
      secondaryActiveTabId: nodeId,
      activeGroupIndex: 1,
    });
  },

  closeSecondaryTab(nodeId) {
    const { secondaryTabs, secondaryActiveTabId } = get();
    const idx = secondaryTabs.findIndex((t) => t.nodeId === nodeId);
    if (idx === -1) return;

    const remaining = secondaryTabs.filter((t) => t.nodeId !== nodeId);

    let newActive = secondaryActiveTabId;
    if (secondaryActiveTabId === nodeId) {
      if (remaining.length === 0) {
        newActive = null;
      } else {
        const nextTab = remaining[idx] ?? remaining[idx - 1];
        newActive = nextTab.nodeId;
      }
    }

    set({
      secondaryTabs: remaining,
      secondaryActiveTabId: newActive,
      activeGroupIndex: remaining.length === 0 ? 0 : get().activeGroupIndex,
    });
  },

  closeSecondaryGroup() {
    set({
      secondaryTabs: [],
      secondaryActiveTabId: null,
      activeGroupIndex: 0,
    });
  },

  setSecondaryActiveTab(nodeId) {
    const { secondaryTabs } = get();
    if (!secondaryTabs.find((t) => t.nodeId === nodeId)) return;
    set({ secondaryActiveTabId: nodeId });
  },

  pinSecondaryTab(nodeId) {
    const { secondaryTabs } = get();
    const existing = secondaryTabs.find((t) => t.nodeId === nodeId);
    if (!existing || !existing.isPreview) return;

    set({
      secondaryTabs: secondaryTabs.map((t) =>
        t.nodeId === nodeId ? { ...t, isPreview: false } : t,
      ),
    });
  },

  setActiveGroup(index) {
    set({ activeGroupIndex: index });
  },

  isSyncedScene(nodeId) {
    const { tabs, secondaryTabs } = get();
    const inPrimary = tabs.some((t) => t.nodeId === nodeId);
    const inSecondary = secondaryTabs.some((t) => t.nodeId === nodeId);
    return inPrimary && inSecondary;
  },

  reorderTab(fromIndex, toIndex, groupIndex) {
    const arr = [...(groupIndex === 0 ? get().tabs : get().secondaryTabs)];
    if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= arr.length)
      return;
    const [moved] = arr.splice(fromIndex, 1);
    // toIndex was computed before removal; adjust if it came after fromIndex
    const adjusted = toIndex > fromIndex ? toIndex - 1 : toIndex;
    arr.splice(Math.min(adjusted, arr.length), 0, moved);
    if (groupIndex === 0) set({ tabs: arr });
    else set({ secondaryTabs: arr });
  },

  moveTabBetweenGroups(nodeId, fromGroup, toGroup, insertIndex) {
    const { tabs, secondaryTabs, activeTabId, secondaryActiveTabId } = get();
    const srcArr = fromGroup === 0 ? tabs : secondaryTabs;
    const dstArr = toGroup === 0 ? tabs : secondaryTabs;

    const movingTab = srcArr.find((t) => t.nodeId === nodeId);
    if (!movingTab) return;
    // Can't leave primary empty
    if (fromGroup === 0 && srcArr.length <= 1) return;

    // If already in destination, just activate it there
    if (dstArr.some((t) => t.nodeId === nodeId)) {
      if (toGroup === 0) set({ activeTabId: nodeId, activeGroupIndex: 0 });
      else set({ secondaryActiveTabId: nodeId, activeGroupIndex: 1 });
      return;
    }

    const newSrc = srcArr.filter((t) => t.nodeId !== nodeId);
    const newDst = [...dstArr];
    const at =
      insertIndex !== undefined
        ? Math.min(insertIndex, newDst.length)
        : newDst.length;
    newDst.splice(at, 0, { ...movingTab, isPreview: false });

    // Pick new active for source group if we moved away the active tab
    const srcActiveId = fromGroup === 0 ? activeTabId : secondaryActiveTabId;
    let newSrcActiveId = srcActiveId;
    if (srcActiveId === nodeId) {
      const srcIdx = srcArr.findIndex((t) => t.nodeId === nodeId);
      newSrcActiveId =
        newSrc[srcIdx]?.nodeId ?? newSrc[srcIdx - 1]?.nodeId ?? null;
    }

    const updates: Partial<
      Pick<
        TabState,
        | "tabs"
        | "secondaryTabs"
        | "activeTabId"
        | "secondaryActiveTabId"
        | "activeGroupIndex"
      >
    > = {};

    if (fromGroup === 0) {
      updates.tabs = newSrc;
      updates.activeTabId = newSrcActiveId;
    } else {
      updates.secondaryTabs = newSrc;
      updates.secondaryActiveTabId = newSrcActiveId;
    }

    if (toGroup === 0) {
      updates.tabs = newDst;
      updates.activeTabId = nodeId;
      updates.activeGroupIndex = 0;
    } else {
      updates.secondaryTabs = newDst;
      updates.secondaryActiveTabId = nodeId;
      updates.activeGroupIndex = 1;
    }

    // Auto-close secondary if it became empty
    if (fromGroup === 1 && newSrc.length === 0) {
      updates.secondaryTabs = [];
      updates.secondaryActiveTabId = null;
      updates.activeGroupIndex = 0;
    }

    set(updates);
  },

  // ---- Persistence ----

  async loadTabState(validNodeIds) {
    try {
      const json = await getSetting(TAB_STATE_KEY);
      if (!json) return;

      const parsed: PersistedTabState = JSON.parse(json);

      let tabs = parsed.tabs ?? [];
      let secondaryTabs = parsed.secondaryTabs ?? [];

      if (validNodeIds) {
        tabs = tabs.filter((t) => validNodeIds.has(t.nodeId));
        secondaryTabs = secondaryTabs.filter((t) => validNodeIds.has(t.nodeId));
      }

      const activeTabId = tabs.find((t) => t.nodeId === parsed.activeTabId)
        ? parsed.activeTabId
        : (tabs[0]?.nodeId ?? null);

      const secondaryActiveTabId = secondaryTabs.find(
        (t) => t.nodeId === parsed.secondaryActiveTabId,
      )
        ? parsed.secondaryActiveTabId
        : (secondaryTabs[0]?.nodeId ?? null);

      const activeGroupIndex =
        secondaryTabs.length === 0 ? 0 : (parsed.activeGroupIndex ?? 0);

      set({
        tabs,
        activeTabId,
        secondaryTabs,
        secondaryActiveTabId,
        activeGroupIndex,
      });
    } catch {
      // Corrupted or missing — keep current state
    }
  },

  async saveTabState() {
    try {
      const {
        tabs,
        activeTabId,
        secondaryTabs,
        secondaryActiveTabId,
        activeGroupIndex,
      } = get();
      const data: PersistedTabState = {
        tabs,
        activeTabId,
        secondaryTabs,
        secondaryActiveTabId,
        activeGroupIndex,
      };
      await setSetting(TAB_STATE_KEY, JSON.stringify(data));
    } catch {
      // Ignore save errors
    }
  },

  initAutoSave() {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = useTabStore.subscribe((state, prev) => {
      // Only save when tab-related state changes
      if (
        state.tabs === prev.tabs &&
        state.activeTabId === prev.activeTabId &&
        state.secondaryTabs === prev.secondaryTabs &&
        state.secondaryActiveTabId === prev.secondaryActiveTabId &&
        state.activeGroupIndex === prev.activeGroupIndex
      ) {
        return;
      }

      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        useTabStore.getState().saveTabState();
      }, SAVE_DEBOUNCE_MS);
    });

    set({
      disposeAutoSave: () => {
        if (timer !== null) clearTimeout(timer);
        unsubscribe();
        set({ disposeAutoSave: undefined });
      },
    });
  },
}));
