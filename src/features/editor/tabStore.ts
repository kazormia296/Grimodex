import { create } from "zustand";

export interface TabEntry {
  nodeId: string;
  isPreview: boolean;
}

interface TabState {
  tabs: TabEntry[];
  activeTabId: string | null;

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

  /**
   * Promote a preview tab to pinned (called when user starts editing).
   */
  pinTab: (nodeId: string) => void;

  /** Close a tab. Activates adjacent tab if the closed one was active. */
  closeTab: (nodeId: string) => void;

  /** Activate a tab. No-op if nodeId is not in tabs. */
  setActiveTab: (nodeId: string) => void;

  /**
   * Ensure a node has a pinned tab (used for external activeSceneId changes,
   * e.g. when a new scene is created). If already open, just activate.
   */
  ensureTab: (nodeId: string) => void;
}

export const useTabStore = create<TabState>()((set, get) => ({
  tabs: [],
  activeTabId: null,

  openPreview(nodeId) {
    const { tabs } = get();
    const existing = tabs.find((t) => t.nodeId === nodeId);

    if (existing) {
      // Already open (pinned or preview) — just activate
      set({ activeTabId: nodeId });
      return;
    }

    // Replace existing preview tab (if any) with the new one
    const withoutPreview = tabs.filter((t) => !t.isPreview);
    set({
      tabs: [...withoutPreview, { nodeId, isPreview: true }],
      activeTabId: nodeId,
    });
  },

  openPinned(nodeId) {
    const { tabs } = get();
    const existing = tabs.find((t) => t.nodeId === nodeId);

    if (existing) {
      if (existing.isPreview) {
        // Promote preview → pinned
        set({
          tabs: tabs.map((t) =>
            t.nodeId === nodeId ? { ...t, isPreview: false } : t,
          ),
          activeTabId: nodeId,
        });
      } else {
        // Already pinned — just activate
        set({ activeTabId: nodeId });
      }
      return;
    }

    // New pinned tab
    set({
      tabs: [...tabs, { nodeId, isPreview: false }],
      activeTabId: nodeId,
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
        // Prefer the tab that was after; fall back to the one before
        const nextTab = remaining[idx] ?? remaining[idx - 1];
        newActive = nextTab.nodeId;
      }
    }

    set({ tabs: remaining, activeTabId: newActive });
  },

  setActiveTab(nodeId) {
    const { tabs } = get();
    if (!tabs.find((t) => t.nodeId === nodeId)) return;
    set({ activeTabId: nodeId });
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
}));
