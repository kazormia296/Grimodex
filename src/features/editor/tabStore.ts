import { create } from "zustand";
import {
  getProjectSetting,
  getSetting,
  setProjectSetting,
} from "@/features/settings/api";
import { markStart, markEnd } from "@/lib/perfLog";
import { guardInlineAiPending } from "./inlineAi/pendingGuard";
import {
  reduceTabState,
  type TabAction,
  type TabReducerState,
} from "./tabReducer";
import {
  parseTabPersistence,
  serializeTabPersistence,
  TAB_STATE_KEY,
  type TabPersistenceSnapshot,
} from "./tabPersistence";
import { useEditorSessionStore } from "./editorSessionStore";
import {
  hasExternalEditConflictForId,
  hasExternalEditConflictForKind,
} from "@/lib/externalEditConflictRegistry";

const SAVE_DEBOUNCE_MS = 500;
let tabStateAuthorityEpoch = 0;

export type TabContentType = "scene" | "codex" | "snippet" | "chronicle_event";

export interface TabEntry {
  nodeId: string;
  isPreview: boolean;
  contentType: TabContentType;
  /** Chronicle event tabs only: display label resolved at open time.
   *  Events are not held in a global store (loaded into ChroniclePanel local
   *  state), so the tab caches the title here for TabBar to render. */
  label?: string;
  /** Codex tabs only: which phase's content to show/edit.
   *  - undefined/null → auto-resolve from active scene
   *  - "__base__"     → show base entry content (ignore active phase)
   *  - "<phase-id>"  → show/edit that phase's contentOverride
   */
  overridePhaseId?: string | null;
  /** Preview tabs only: true when the tab is genuinely new (no prior preview existed).
   *  false when replacing an existing preview tab → suppresses entrance animation. */
  animateIn?: boolean;
}

export type GroupIndex = 0 | 1;

interface TabState {
  // ---- Primary group ----
  tabs: TabEntry[];
  activeTabId: string | null;

  // ---- Secondary group (split view) ----
  secondaryTabs: TabEntry[];
  secondaryActiveTabId: string | null;
  /** Whether the secondary editor group panel is visible (may be empty). */
  secondaryGroupOpen: boolean;

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

  /**
   * Open a codex entry as a pinned tab in the primary group.
   * If already open, update overridePhaseId and activate.
   * @param phaseId undefined = auto-resolve, "__base__" = base content, phase-id = that phase
   */
  openCodexTab: (entryId: string, phaseId?: string | null) => void;

  /**
   * Open a snippet as a pinned tab in the primary group.
   * If already open, just activate.
   */
  openSnippetTab: (snippetId: string) => void;

  /**
   * Open a chronicle event's detail (rich text) as a pinned tab in the primary
   * group. If already open, refresh its label and activate.
   * @param label display title resolved at open time (events have no global store)
   */
  openChronicleEventTab: (eventId: string, label?: string) => void;

  // ---- Secondary group operations ----

  /**
   * Open a scene in the secondary group (Ctrl+Enter).
   * Creates a pinned tab in the secondary group and focuses it.
   */
  openInSecondaryGroup: (nodeId: string) => void;

  /** Create an empty secondary group with the given split direction. */
  createEmptySecondaryGroup: (direction: "right" | "below") => void;

  /** Close a tab in the secondary group. Group stays visible even when empty. */
  closeSecondaryTab: (nodeId: string) => void;

  /** Close the secondary group panel entirely (X button). */
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
    /** If secondary group doesn't exist yet, create it with this direction. */
    createDirection?: "right" | "below",
  ) => void;

  // ---- Context-menu bulk-close operations ----

  /** Close all tabs in the group except the given one. */
  closeOtherTabsInGroup: (nodeId: string, groupIndex: GroupIndex) => void;
  /** Close all tabs to the right of the given one. */
  closeRightTabsInGroup: (nodeId: string, groupIndex: GroupIndex) => void;
  /** Close all tabs to the left of the given one. */
  closeLeftTabsInGroup: (nodeId: string, groupIndex: GroupIndex) => void;
  /** Close all tabs in the group. Secondary group is auto-closed when empty. */
  closeAllTabsInGroup: (groupIndex: GroupIndex) => void;

  // ---- Drag-and-drop state ----

  /**
   * True while a tab drag is in progress. Set by TabBar/SceneEditor via
   * document dragstart/dragend listeners. Also reset inside moveTabBetweenGroups
   * because dragend does not bubble to document when the source element is
   * removed from the DOM during the drop handler.
   */
  isDraggingTab: boolean;
  setIsDraggingTab: (v: boolean) => void;

  // ---- Split direction ----

  /** Direction of the secondary editor group split. */
  splitDirection: "right" | "below";
  /** Open a scene in the secondary group with a given direction. */
  openInSecondaryGroupDirectional: (
    nodeId: string,
    direction: "right" | "below",
  ) => void;

  // ---- Editor focus intent ----

  /**
   * Set by TabBar when the user explicitly clicks a tab in a specific group.
   * EditorPane consumes this once via consumeEditorFocusRequest(group) to decide
   * whether to focus the editor immediately on scene switch.
   * Scenes-panel navigation does NOT set this flag, so the editor does not
   * steal focus from keyboard navigation.
   * Scoped per group to avoid races in split-view mode.
   */
  requestEditorFocus: (group: GroupIndex) => void;
  /** Read and clear the flag for the given group. Returns true if focus was requested. */
  consumeEditorFocusRequest: (group: GroupIndex) => boolean;

  // ---- Linear mode ----

  /** Whether the editor is in linear (multi-scene scroll) mode. */
  isLinearMode: boolean;
  /** Toggle linear mode on/off. Closes secondary group when entering. */
  toggleLinearMode: () => void;

  // ---- Unsaved-changes tracking ----

  /** IDs of tabs that have unsaved content. Updated by EditorPane. */
  dirtyTabIds: Set<string>;
  /** Called by EditorPane to register/unregister a tab as dirty. */
  setTabDirty: (nodeId: string, dirty: boolean) => void;

  // ---- Persistence ----

  /**
   * True after the current project's persisted tab state has either been
   * applied or found unreadable/missing. Starts true for isolated consumers;
   * resetForProject establishes the real project-boundary loading state.
   */
  tabStateHydrated: boolean;
  /** Project that owns the currently hydrated tab snapshot. */
  tabStateProjectId: string | null;

  /** Load tab state from workspace settings. If validNodeIds is provided,
   *  tabs referencing unknown IDs are filtered out. beforeApply runs
   *  synchronously after parsing and authority validation, but before Zustand
   *  publishes the restored snapshot. Returns false when superseded. */
  loadTabState: (
    projectId: string,
    validNodeIds?: Set<string>,
    beforeApply?: (snapshot: TabPersistenceSnapshot) => boolean | void,
  ) => Promise<boolean>;

  /** Save current tab state to workspace settings. */
  saveTabState: (projectId: string) => Promise<void>;

  /** Start auto-saving tab state on changes (debounced). */
  initAutoSave: (projectId: string) => void;

  /** Stop auto-saving (cleanup subscription). */
  disposeAutoSave?: () => void;

  /** Clear all editor session state when switching projects. */
  resetForProject: () => void;
}

async function saveTabStateForAuthority(
  projectId: string,
  expectedAuthorityEpoch: number,
): Promise<void> {
  try {
    const state = useTabStore.getState();
    if (
      !state.tabStateHydrated ||
      state.tabStateProjectId !== projectId ||
      expectedAuthorityEpoch !== tabStateAuthorityEpoch
    ) {
      return;
    }
    const serialized = serializeTabPersistence({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      secondaryTabs: state.secondaryTabs,
      secondaryActiveTabId: state.secondaryActiveTabId,
      secondaryGroupOpen: state.secondaryGroupOpen,
      activeGroupIndex: state.activeGroupIndex,
      splitDirection: state.splitDirection,
      isLinearMode: state.isLinearMode,
    });
    // Serialization is synchronous, but keep the authority check next to the
    // persistence boundary so a stale timer can never target the newly bound DB.
    if (
      !useTabStore.getState().tabStateHydrated ||
      useTabStore.getState().tabStateProjectId !== projectId ||
      expectedAuthorityEpoch !== tabStateAuthorityEpoch
    ) {
      return;
    }
    await setProjectSetting(projectId, TAB_STATE_KEY, serialized);
  } catch {
    // Ignore save errors
  }
}

/** Secondary group へ追加するエントリを、既存タブ(primary/secondary)の
 *  contentType/label を引き継いで生成する。codex/snippet/chronicle_event の
 *  タブを split したとき contentType が "scene" に化けて EditorPane が
 *  loadSceneFull(非シーン id) で空ロード→誤保存するのを防ぐ。 */
function tabReducerState(state: TabState): TabReducerState {
  return {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    secondaryTabs: state.secondaryTabs,
    secondaryActiveTabId: state.secondaryActiveTabId,
    secondaryGroupOpen: state.secondaryGroupOpen,
    activeGroupIndex: state.activeGroupIndex,
    splitDirection: state.splitDirection,
  };
}

function reduceTabs(state: TabState, action: TabAction): TabReducerState {
  return reduceTabState(tabReducerState(state), action);
}

function activeDocumentHasExternalConflict(
  state: TabState,
  group: GroupIndex,
): boolean {
  const activeId = group === 0 ? state.activeTabId : state.secondaryActiveTabId;
  return activeId !== null && hasExternalEditConflictForId(activeId);
}

function hasAnyTreeExternalConflict(): boolean {
  return hasExternalEditConflictForKind("tree", { includeLegacy: true });
}

export const useTabStore = create<TabState>()((set, get) => {
  return {
    tabs: [],
    activeTabId: null,
    secondaryTabs: [],
    secondaryActiveTabId: null,
    secondaryGroupOpen: false,
    activeGroupIndex: 0,
    splitDirection: "right",
    isLinearMode: false,
    isDraggingTab: false,
    tabStateHydrated: true,
    tabStateProjectId: null,
    resetForProject() {
      // Stop the old Project subscriber/timer before publishing the empty
      // reset snapshot. Otherwise that reset is observed as a tab change and
      // can be debounced into the newly bound Workspace DB.
      get().disposeAutoSave?.();
      tabStateAuthorityEpoch += 1;
      useEditorSessionStore.getState().resetForProject();
      set({
        tabs: [],
        activeTabId: null,
        secondaryTabs: [],
        secondaryActiveTabId: null,
        secondaryGroupOpen: false,
        activeGroupIndex: 0,
        isDraggingTab: false,
        dirtyTabIds: new Set<string>(),
        tabStateHydrated: false,
        tabStateProjectId: null,
      });
    },
    setIsDraggingTab(v) {
      set({ isDraggingTab: v });
    },
    toggleLinearMode() {
      const { isLinearMode, secondaryGroupOpen } = get();
      // Entering replaces the active EditorPane; leaving destroys every
      // mounted LinearSceneBlock. Keep the surface that owns a conflicted
      // local draft alive until the banner resolves it.
      if (
        (isLinearMode && hasAnyTreeExternalConflict()) ||
        (!isLinearMode &&
          (activeDocumentHasExternalConflict(get(), 0) ||
            activeDocumentHasExternalConflict(get(), 1)))
      ) {
        return;
      }
      if (!isLinearMode && secondaryGroupOpen) {
        // Close split view before entering linear mode
        get().closeSecondaryGroup();
      }
      set({ isLinearMode: !isLinearMode });
    },
    dirtyTabIds: new Set<string>(),
    requestEditorFocus(group: GroupIndex) {
      useEditorSessionStore.getState().requestEditorFocus(group);
    },
    consumeEditorFocusRequest(group: GroupIndex) {
      return useEditorSessionStore.getState().consumeEditorFocusRequest(group);
    },

    // ---- Primary group ----

    openPreview(nodeId) {
      // EditorPane は activeTabId で本文をロードする。pending 中に別 node へ
      // 切り替えると owner エディタが reload され未確定/未保存テキストが喪失する。
      if (nodeId !== get().activeTabId && guardInlineAiPending()) return;
      if (
        nodeId !== get().activeTabId &&
        activeDocumentHasExternalConflict(get(), 0)
      )
        return;
      markStart("tabStore.openPreview");
      try {
        set(reduceTabs(get(), { type: "preview/open", nodeId }));
      } finally {
        markEnd("tabStore.openPreview");
      }
    },

    openPinned(nodeId) {
      if (nodeId !== get().activeTabId && guardInlineAiPending()) return;
      if (
        nodeId !== get().activeTabId &&
        activeDocumentHasExternalConflict(get(), 0)
      )
        return;
      set(reduceTabs(get(), { type: "pinned/open", nodeId }));
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
      // 表示中 (= owner エディタ) のタブを閉じると本文が切り替わり pending 喪失。
      if (nodeId === activeTabId && guardInlineAiPending()) return;
      if (nodeId === activeTabId && activeDocumentHasExternalConflict(get(), 0))
        return;
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
      if (nodeId !== get().activeTabId && guardInlineAiPending()) return;
      if (
        nodeId !== get().activeTabId &&
        activeDocumentHasExternalConflict(get(), 0)
      )
        return;
      set({ activeTabId: nodeId, activeGroupIndex: 0 });
    },

    ensureTab(nodeId) {
      if (nodeId !== get().activeTabId && guardInlineAiPending()) return;
      if (
        nodeId !== get().activeTabId &&
        activeDocumentHasExternalConflict(get(), 0)
      )
        return;
      const { tabs } = get();
      if (tabs.find((t) => t.nodeId === nodeId)) {
        set({ activeTabId: nodeId });
        return;
      }
      set({
        tabs: [...tabs, { nodeId, isPreview: false, contentType: "scene" }],
        activeTabId: nodeId,
      });
    },

    openCodexTab(entryId, phaseId) {
      const current = get();
      const currentTab = current.tabs.find(
        (tab) => tab.nodeId === current.activeTabId,
      );
      const changesDisplayedDocument =
        entryId !== current.activeTabId ||
        (entryId === current.activeTabId &&
          currentTab?.contentType === "codex" &&
          (currentTab.overridePhaseId ?? null) !== (phaseId ?? null));
      if (changesDisplayedDocument && guardInlineAiPending()) return;
      if (
        changesDisplayedDocument &&
        activeDocumentHasExternalConflict(current, 0)
      )
        return;
      set(reduceTabs(current, { type: "codex/open", entryId, phaseId }));
    },

    openSnippetTab(snippetId) {
      if (snippetId !== get().activeTabId && guardInlineAiPending()) return;
      if (
        snippetId !== get().activeTabId &&
        activeDocumentHasExternalConflict(get(), 0)
      )
        return;
      set(reduceTabs(get(), { type: "snippet/open", snippetId }));
    },

    openChronicleEventTab(eventId, label) {
      if (eventId !== get().activeTabId && guardInlineAiPending()) return;
      if (
        eventId !== get().activeTabId &&
        activeDocumentHasExternalConflict(get(), 0)
      )
        return;
      set(reduceTabs(get(), { type: "chronicle-event/open", eventId, label }));
    },

    // ---- Secondary group ----

    openInSecondaryGroup(nodeId) {
      if (nodeId !== get().secondaryActiveTabId && guardInlineAiPending())
        return;
      if (
        nodeId !== get().secondaryActiveTabId &&
        activeDocumentHasExternalConflict(get(), 1)
      )
        return;
      set(reduceTabs(get(), { type: "secondary/open", nodeId }));
    },

    createEmptySecondaryGroup(direction) {
      set({
        secondaryGroupOpen: true,
        splitDirection: direction,
        activeGroupIndex: 1,
      });
    },

    closeSecondaryTab(nodeId) {
      const { secondaryTabs, secondaryActiveTabId } = get();
      if (nodeId === secondaryActiveTabId && guardInlineAiPending()) return;
      if (
        nodeId === secondaryActiveTabId &&
        activeDocumentHasExternalConflict(get(), 1)
      )
        return;
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
        // Keep activeGroupIndex on secondary even when empty — group stays visible
      });
    },

    closeSecondaryGroup() {
      if (guardInlineAiPending()) return;
      if (activeDocumentHasExternalConflict(get(), 1)) return;
      set({
        secondaryTabs: [],
        secondaryActiveTabId: null,
        secondaryGroupOpen: false,
        activeGroupIndex: 0,
      });
    },

    setSecondaryActiveTab(nodeId) {
      const { secondaryTabs } = get();
      if (!secondaryTabs.find((t) => t.nodeId === nodeId)) return;
      if (nodeId !== get().secondaryActiveTabId && guardInlineAiPending())
        return;
      if (
        nodeId !== get().secondaryActiveTabId &&
        activeDocumentHasExternalConflict(get(), 1)
      )
        return;
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

    moveTabBetweenGroups(
      nodeId,
      fromGroup,
      toGroup,
      insertIndex,
      createDirection,
    ) {
      if (guardInlineAiPending()) return;
      if (
        activeDocumentHasExternalConflict(get(), fromGroup) ||
        activeDocumentHasExternalConflict(get(), toGroup)
      )
        return;
      const { tabs, secondaryTabs, activeTabId, secondaryActiveTabId } = get();
      const srcArr = fromGroup === 0 ? tabs : secondaryTabs;
      const dstArr = toGroup === 0 ? tabs : secondaryTabs;

      const movingTab = srcArr.find((t) => t.nodeId === nodeId);
      if (!movingTab) return;

      // If already in destination, just activate it there
      if (dstArr.some((t) => t.nodeId === nodeId)) {
        if (toGroup === 0) set({ activeTabId: nodeId, activeGroupIndex: 0 });
        else
          set({
            secondaryActiveTabId: nodeId,
            activeGroupIndex: 1,
            secondaryGroupOpen: true,
          });
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
          | "secondaryGroupOpen"
          | "splitDirection"
          | "isDraggingTab"
        >
      > = {
        // When a cross-group move completes, the source tab element is removed
        // from the DOM. In that case `dragend` fires on the detached element and
        // never bubbles to `document`, so the usual document-level dragend listener
        // cannot reset the flag. Resetting here (inside the same Zustand set call
        // as the tab move) keeps the FullAreaDropZone from staying visible.
        isDraggingTab: false,
      };

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
        updates.secondaryGroupOpen = true;
        // Set split direction when creating the secondary group for the first time
        if (createDirection && !get().secondaryGroupOpen) {
          updates.splitDirection = createDirection;
        }
      }

      set(updates);
    },

    // ---- Context-menu bulk-close operations ----

    closeOtherTabsInGroup(nodeId, groupIndex) {
      const arr = groupIndex === 0 ? get().tabs : get().secondaryTabs;
      const remaining = arr.filter((t) => t.nodeId === nodeId);
      if (groupIndex === 0) {
        set({ tabs: remaining, activeTabId: remaining[0]?.nodeId ?? null });
      } else {
        set({
          secondaryTabs: remaining,
          secondaryActiveTabId: remaining[0]?.nodeId ?? null,
        });
      }
    },

    closeRightTabsInGroup(nodeId, groupIndex) {
      const arr = groupIndex === 0 ? get().tabs : get().secondaryTabs;
      const idx = arr.findIndex((t) => t.nodeId === nodeId);
      if (idx === -1) return;
      const remaining = arr.slice(0, idx + 1);
      const curActive =
        groupIndex === 0 ? get().activeTabId : get().secondaryActiveTabId;
      const newActive = remaining.some((t) => t.nodeId === curActive)
        ? curActive
        : nodeId;
      if (groupIndex === 0) {
        set({ tabs: remaining, activeTabId: newActive });
      } else {
        set({ secondaryTabs: remaining, secondaryActiveTabId: newActive });
      }
    },

    closeLeftTabsInGroup(nodeId, groupIndex) {
      const arr = groupIndex === 0 ? get().tabs : get().secondaryTabs;
      const idx = arr.findIndex((t) => t.nodeId === nodeId);
      if (idx === -1) return;
      const remaining = arr.slice(idx);
      const curActive =
        groupIndex === 0 ? get().activeTabId : get().secondaryActiveTabId;
      const newActive = remaining.some((t) => t.nodeId === curActive)
        ? curActive
        : nodeId;
      if (groupIndex === 0) {
        set({ tabs: remaining, activeTabId: newActive });
      } else {
        set({ secondaryTabs: remaining, secondaryActiveTabId: newActive });
      }
    },

    closeAllTabsInGroup(groupIndex) {
      if (groupIndex === 0) {
        set({ tabs: [], activeTabId: null });
      } else {
        // Keep the group panel visible (empty state); user must click X to close it
        set({ secondaryTabs: [], secondaryActiveTabId: null });
      }
    },

    // ---- Directional split ----

    openInSecondaryGroupDirectional(nodeId, direction) {
      if (nodeId !== get().secondaryActiveTabId && guardInlineAiPending())
        return;
      if (
        nodeId !== get().secondaryActiveTabId &&
        activeDocumentHasExternalConflict(get(), 1)
      )
        return;
      set(
        reduceTabs(get(), {
          type: "secondary/open",
          nodeId,
          direction,
        }),
      );
    },

    // ---- Dirty-tab tracking ----

    setTabDirty(nodeId, dirty) {
      useEditorSessionStore.getState().setDocumentDirty(nodeId, dirty);
      const cur = get().dirtyTabIds;
      // Idempotent: skip the store update (and subscriber notify) when the
      // dirty state is unchanged. Without this guard every redundant call —
      // e.g. an EditorPane mount syncing isDirty=false on an already-clean
      // tab — allocates a new Set and re-renders all dirtyTabIds subscribers.
      if (dirty === cur.has(nodeId)) return;
      const next = new Set(cur);
      if (dirty) next.add(nodeId);
      else next.delete(nodeId);
      set({ dirtyTabIds: next });
    },

    // ---- Persistence ----

    async loadTabState(projectId, validNodeIds, beforeApply) {
      const authorityEpoch = ++tabStateAuthorityEpoch;
      try {
        const projectJson = await getProjectSetting(projectId, TAB_STATE_KEY);
        const legacyJson =
          projectJson === null ? await getSetting(TAB_STATE_KEY) : null;
        const json = projectJson ?? legacyJson;
        const snapshot: TabPersistenceSnapshot = json
          ? parseTabPersistence(json, validNodeIds)
          : {
              tabs: [],
              activeTabId: null,
              secondaryTabs: [],
              secondaryActiveTabId: null,
              secondaryGroupOpen: false,
              activeGroupIndex: 0,
              splitDirection: "right",
              isLinearMode: false,
            };

        if (authorityEpoch !== tabStateAuthorityEpoch) return false;
        if (beforeApply?.(snapshot) === false) return false;
        // The callback may synchronously reset the project or begin a newer
        // load. Revalidate before publishing in that case as well.
        if (authorityEpoch !== tabStateAuthorityEpoch) return false;
        set({
          ...snapshot,
          tabStateHydrated: true,
          tabStateProjectId: projectId,
        });
        if (projectJson === null && legacyJson !== null) {
          // Keep the global value for downgrade/other-workspace compatibility,
          // but make the filtered project snapshot canonical from now on.
          try {
            if (
              authorityEpoch === tabStateAuthorityEpoch &&
              get().tabStateProjectId === projectId
            ) {
              await setProjectSetting(
                projectId,
                TAB_STATE_KEY,
                serializeTabPersistence(snapshot),
              );
            }
          } catch {
            // A failed compatibility migration must not discard a valid
            // in-memory restore. The next activation can retry it.
          }
        }
        return (
          authorityEpoch === tabStateAuthorityEpoch &&
          get().tabStateProjectId === projectId
        );
      } catch {
        // Corrupted or missing — keep current state, but do not leave the
        // current project permanently blocked behind the hydration gate.
        if (authorityEpoch !== tabStateAuthorityEpoch) return false;
        set({ tabStateHydrated: true, tabStateProjectId: projectId });
        return true;
      }
    },

    async saveTabState(projectId) {
      await saveTabStateForAuthority(projectId, tabStateAuthorityEpoch);
    },

    initAutoSave(projectId) {
      // StrictMode, Project activation, and a queued replacement init may all
      // converge here. Exactly one subscriber owns persistence at a time.
      get().disposeAutoSave?.();
      const authorityEpoch = tabStateAuthorityEpoch;
      if (!get().tabStateHydrated || get().tabStateProjectId !== projectId) {
        return;
      }
      let timer: ReturnType<typeof setTimeout> | null = null;

      const unsubscribe = useTabStore.subscribe((state, prev) => {
        if (
          !state.tabStateHydrated ||
          state.tabStateProjectId !== projectId ||
          authorityEpoch !== tabStateAuthorityEpoch
        ) {
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          return;
        }
        // Only save when tab-related state changes
        if (
          state.tabs === prev.tabs &&
          state.activeTabId === prev.activeTabId &&
          state.secondaryTabs === prev.secondaryTabs &&
          state.secondaryActiveTabId === prev.secondaryActiveTabId &&
          state.secondaryGroupOpen === prev.secondaryGroupOpen &&
          state.splitDirection === prev.splitDirection &&
          state.activeGroupIndex === prev.activeGroupIndex &&
          state.isLinearMode === prev.isLinearMode
        ) {
          return;
        }

        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void saveTabStateForAuthority(projectId, authorityEpoch);
        }, SAVE_DEBOUNCE_MS);
      });

      const disposeAutoSave = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        unsubscribe();
        if (get().disposeAutoSave === disposeAutoSave) {
          set({ disposeAutoSave: undefined });
        }
      };
      set({ disposeAutoSave });
    },
  };
});
