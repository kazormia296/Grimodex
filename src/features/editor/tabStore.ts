import { create } from "zustand";

export interface TabEntry {
  nodeId: string;
  isPreview: boolean;
}

export type GroupIndex = 0 | 1;

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
      set({ activeTabId: nodeId, activeGroupIndex: 0 });
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
}));
