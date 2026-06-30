import { useRef, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "motion/react";
import { useReducedMotion } from "@/lib/animation";
import {
  X,
  ChevronDown,
  Columns2,
  ScrollText,
  Files,
  StickyNote,
  BookOpen,
  CalendarDays,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTabStore } from "./tabStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { TabContextMenu } from "./TabContextMenu";
import { UnsavedDialog } from "./UnsavedDialog";
import { saveScene } from "./editorSaveRegistry";
import type { GroupIndex, TabEntry } from "./tabStore";
import type { CodexEntryPhase } from "@/features/codex/phaseApi";

export const DRAG_DATA_KEY = "application/grimodex-tab";
/** Per-group marker so drop zones can detect source group during dragover. */
export const DRAG_GROUP_KEY = (g: 0 | 1) => `application/grimodex-tab-g${g}`;

/** Returns the label of the phase currently shown in a codex tab, or null. */
function getTabPhaseLabel(
  tab: TabEntry,
  phasesByEntry: Record<string, CodexEntryPhase[]>,
  globalSceneOrder: Map<string, number>,
  activeSceneId: string | null,
): string | null {
  if (tab.contentType !== "codex") return null;
  const phases = phasesByEntry[tab.nodeId];
  if (!phases || phases.length === 0) return null;

  if (tab.overridePhaseId === "__base__") return null; // explicitly showing base
  if (tab.overridePhaseId) {
    return phases.find((p) => p.id === tab.overridePhaseId)?.label ?? null;
  }
  // Auto-resolve from active scene
  if (!activeSceneId) return null;
  const currentOrder = globalSceneOrder.get(activeSceneId);
  if (currentOrder === undefined) return null;
  const applicable = phases
    .filter(
      (p) =>
        p.anchorNodeId != null &&
        globalSceneOrder.has(p.anchorNodeId) &&
        globalSceneOrder.get(p.anchorNodeId!)! <= currentOrder,
    )
    .sort(
      (a, b) =>
        globalSceneOrder.get(a.anchorNodeId!)! -
        globalSceneOrder.get(b.anchorNodeId!)!,
    );
  return applicable[applicable.length - 1]?.label ?? null;
}

interface DragPayload {
  nodeId: string;
  groupIndex: GroupIndex;
}

interface DropTarget {
  nodeId: string;
  side: "left" | "right";
}

interface TabBarProps {
  groupIndex?: GroupIndex;
}

export function TabBar({ groupIndex = 0 }: TabBarProps) {
  const { t } = useTranslation();
  const primaryTabs = useTabStore((s) => s.tabs);
  const primaryActiveTabId = useTabStore((s) => s.activeTabId);
  const secondaryTabs = useTabStore((s) => s.secondaryTabs);
  const secondaryActiveTabId = useTabStore((s) => s.secondaryActiveTabId);
  const isSyncedScene = useTabStore((s) => s.isSyncedScene);
  const dirtyTabIds = useTabStore((s) => s.dirtyTabIds);

  const nodes = useTreeStore((s) => s.nodes);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const codexEntries = useCodexStore((s) => s.entries);
  const snippetEntries = useSnippetStore((s) => s.entries);
  const phasesByEntry = usePhaseStore((s) => s.phasesByEntry);
  const globalSceneOrder = usePhaseStore((s) => s.globalSceneOrder);

  const hasSecondaryGroup = useTabStore((s) => s.secondaryGroupOpen);
  const isLinearMode = useTabStore((s) => s.isLinearMode);
  const isPrimary = groupIndex === 0;
  const tabs = isPrimary ? primaryTabs : secondaryTabs;
  const activeTabId = isPrimary ? primaryActiveTabId : secondaryActiveTabId;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowBtnRef = useRef<HTMLDivElement>(null);

  // Drag-and-drop state
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    nodeId: string;
    x: number;
    y: number;
  } | null>(null);

  // Unsaved-changes dialog state for X / middle-click / secondary-group close
  const [pendingClose, setPendingClose] = useState<{
    nodeIds: string[];
    /** true when the secondary group panel itself should close after the tabs close */
    closeSecondaryGroupAfter?: boolean;
  } | null>(null);

  // Split dropdown state (primary group only)
  const splitMenuRef = useRef<HTMLDivElement>(null);
  const [splitMenuOpen, setSplitMenuOpen] = useState(false);
  const reduced = useReducedMotion();

  // Reset drag state on dragend (safety net for normal drops)
  useEffect(() => {
    function onDragEnd() {
      useTabStore.getState().setIsDraggingTab(false);
      setDropTarget(null);
    }
    document.addEventListener("dragend", onDragEnd);
    return () => {
      document.removeEventListener("dragend", onDragEnd);
    };
  }, []);

  // Detect when tabs overflow the container
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => setHasOverflow(el.scrollWidth > el.clientWidth + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [tabs]);

  // Close overflow dropdown on outside click
  useEffect(() => {
    if (!overflowOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (!overflowBtnRef.current?.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [overflowOpen]);

  // Close split dropdown on outside click
  useEffect(() => {
    if (!splitMenuOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (!splitMenuRef.current?.contains(e.target as Node)) {
        setSplitMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [splitMenuOpen]);

  function handleTabClick(nodeId: string) {
    setOverflowOpen(false);
    useTabStore.getState().requestEditorFocus(groupIndex);
    const clickedTab = tabs.find((t) => t.nodeId === nodeId);
    const isSceneTab = clickedTab?.contentType === "scene";
    if (isPrimary) {
      useTabStore.getState().setActiveTab(nodeId);
      if (isSceneTab) useTreeStore.getState().setActiveScene(nodeId);
    } else {
      useTabStore.getState().setSecondaryActiveTab(nodeId);
      if (isSceneTab) useTreeStore.getState().setActiveScene(nodeId);
    }
  }

  function executeClose(nodeIds: string[], closeSecondaryGroupAfter = false) {
    const store = useTabStore.getState();
    for (const id of nodeIds) {
      if (isPrimary) store.closeTab(id);
      else store.closeSecondaryTab(id);
    }
    if (closeSecondaryGroupAfter) {
      useTabStore.getState().closeSecondaryGroup();
    }
    const { activeTabId: newActiveId, secondaryTabs: remaining } =
      useTabStore.getState();
    if (isPrimary) {
      if (newActiveId) useTreeStore.getState().setActiveScene(newActiveId);
    } else {
      if (remaining.length === 0 && newActiveId) {
        useTreeStore.getState().setActiveScene(newActiveId);
      }
    }
  }

  function handleTabClose(e: React.MouseEvent, nodeId: string) {
    e.stopPropagation();
    if (useTabStore.getState().dirtyTabIds.has(nodeId)) {
      setPendingClose({ nodeIds: [nodeId] });
      return;
    }
    if (isPrimary) {
      useTabStore.getState().closeTab(nodeId);
      const newActiveId = useTabStore.getState().activeTabId;
      if (newActiveId) useTreeStore.getState().setActiveScene(newActiveId);
    } else {
      useTabStore.getState().closeSecondaryTab(nodeId);
      const { secondaryTabs: remaining, activeTabId: primaryActive } =
        useTabStore.getState();
      if (remaining.length === 0 && primaryActive) {
        useTreeStore.getState().setActiveScene(primaryActive);
      }
    }
  }

  function handleCloseSecondaryGroup() {
    const { secondaryTabs: tabsInGroup, dirtyTabIds: dirty } =
      useTabStore.getState();
    const dirtyIds = tabsInGroup
      .map((t) => t.nodeId)
      .filter((id) => dirty.has(id));
    if (dirtyIds.length > 0) {
      setPendingClose({
        nodeIds: tabsInGroup.map((t) => t.nodeId),
        closeSecondaryGroupAfter: true,
      });
      return;
    }
    useTabStore.getState().closeSecondaryGroup();
  }

  function handleTabDoubleClick(nodeId: string, isPreview: boolean) {
    if (!isPreview) return;
    if (isPrimary) {
      useTabStore.getState().openPinned(nodeId);
    } else {
      useTabStore.getState().pinSecondaryTab(nodeId);
    }
  }

  // --- Drag handlers ---

  function handleDragStart(e: React.DragEvent, nodeId: string) {
    const payload: DragPayload = {
      nodeId,
      groupIndex: isPrimary ? 0 : 1,
    };
    e.dataTransfer.setData(DRAG_DATA_KEY, JSON.stringify(payload));
    e.dataTransfer.setData(DRAG_GROUP_KEY(isPrimary ? 0 : 1), "");
    e.dataTransfer.effectAllowed = "move";
    useTabStore.getState().setIsDraggingTab(true);
  }

  function handleDragOver(e: React.DragEvent, nodeId: string) {
    if (!e.dataTransfer.types.includes(DRAG_DATA_KEY)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const side = e.clientX < rect.left + rect.width / 2 ? "left" : "right";
    setDropTarget((prev) =>
      prev?.nodeId === nodeId && prev.side === side ? prev : { nodeId, side },
    );
  }

  function handleDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropTarget(null);
    }
  }

  function handleDrop(e: React.DragEvent, targetNodeId: string) {
    e.preventDefault();
    setDropTarget(null);
    const raw = e.dataTransfer.getData(DRAG_DATA_KEY);
    if (!raw) return;
    const { nodeId: srcId, groupIndex: srcGroup } = JSON.parse(
      raw,
    ) as DragPayload;

    const dstGroup: GroupIndex = isPrimary ? 0 : 1;
    const rect = e.currentTarget.getBoundingClientRect();
    const side = e.clientX < rect.left + rect.width / 2 ? "left" : "right";
    const dstIndex = tabs.findIndex((t) => t.nodeId === targetNodeId);
    const insertIndex = side === "right" ? dstIndex + 1 : dstIndex;

    if (srcGroup === dstGroup) {
      const srcIndex = tabs.findIndex((t) => t.nodeId === srcId);
      if (srcIndex === -1 || srcId === targetNodeId) return;
      useTabStore.getState().reorderTab(srcIndex, insertIndex, dstGroup);
    } else {
      useTabStore
        .getState()
        .moveTabBetweenGroups(srcId, srcGroup, dstGroup, insertIndex);
      const newActiveId =
        dstGroup === 0
          ? useTabStore.getState().activeTabId
          : useTabStore.getState().secondaryActiveTabId;
      if (newActiveId) useTreeStore.getState().setActiveScene(newActiveId);
    }
  }

  // Drop on empty area after all tabs → append to end
  function handleBarDrop(e: React.DragEvent) {
    e.preventDefault();
    setDropTarget(null);
    const raw = e.dataTransfer.getData(DRAG_DATA_KEY);
    if (!raw) return;
    const { nodeId: srcId, groupIndex: srcGroup } = JSON.parse(
      raw,
    ) as DragPayload;
    const dstGroup: GroupIndex = isPrimary ? 0 : 1;

    if (srcGroup === dstGroup) {
      const srcIndex = tabs.findIndex((t) => t.nodeId === srcId);
      if (srcIndex === -1) return;
      useTabStore.getState().reorderTab(srcIndex, tabs.length, dstGroup);
    } else {
      useTabStore.getState().moveTabBetweenGroups(srcId, srcGroup, dstGroup);
      const newActiveId =
        dstGroup === 0
          ? useTabStore.getState().activeTabId
          : useTabStore.getState().secondaryActiveTabId;
      if (newActiveId) useTreeStore.getState().setActiveScene(newActiveId);
    }
  }

  return (
    <div className="glass-editor-chrome flex items-center border-b border-border bg-background">
      {/* Scrollable tab list */}
      <div
        ref={scrollRef}
        className="flex min-w-0 flex-1 items-center overflow-x-auto"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_DATA_KEY)) return;
          e.preventDefault();
        }}
        onDrop={handleBarDrop}
      >
        <AnimatePresence initial={false}>
          {tabs.map((tab) => {
            const isCodex = tab.contentType === "codex";
            const isSnippet = tab.contentType === "snippet";
            const isChronicle = tab.contentType === "chronicle_event";
            const node =
              isCodex || isSnippet || isChronicle
                ? null
                : nodes.find((n) => n.id === tab.nodeId);
            const codexEntry = isCodex
              ? codexEntries.find((e) => e.id === tab.nodeId)
              : null;
            const snippetEntry = isSnippet
              ? snippetEntries.find((e) => e.id === tab.nodeId)
              : null;
            const isActive = tab.nodeId === activeTabId;
            const title =
              node?.title ??
              codexEntry?.name ??
              snippetEntry?.title ??
              tab.label ??
              "…";
            const phaseLabel = getTabPhaseLabel(
              tab,
              phasesByEntry,
              globalSceneOrder,
              activeSceneId,
            );
            const synced = isSyncedScene(tab.nodeId);
            const isDirty = dirtyTabIds.has(tab.nodeId);
            const isDropLeft =
              dropTarget?.nodeId === tab.nodeId && dropTarget.side === "left";
            const isDropRight =
              dropTarget?.nodeId === tab.nodeId && dropTarget.side === "right";

            return (
              <motion.div
                key={tab.nodeId}
                className="flex-shrink-0"
                initial={
                  !reduced && (!tab.isPreview || tab.animateIn)
                    ? { opacity: 0, x: -8, scale: 0.92 }
                    : false
                }
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={
                  tab.isPreview || reduced
                    ? {
                        opacity: 0,
                        width: 0,
                        scale: 0.92,
                        transition: { duration: 0 },
                      }
                    : { opacity: 0, width: 0, scale: 0.92 }
                }
                transition={
                  reduced
                    ? { duration: 0 }
                    : { type: "spring", damping: 22, stiffness: 380, mass: 0.7 }
                }
                style={{ overflow: "hidden" }}
              >
                <div
                  draggable
                  className={cn(
                    "group relative flex shrink-0 cursor-pointer items-center gap-1",
                    "border-r border-border px-3 py-1.5 text-xs",
                    "hover:bg-accent/50",
                    isActive
                      ? "bg-background font-medium text-foreground"
                      : "text-muted-foreground",
                    isActive &&
                      "after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-primary",
                  )}
                  style={{
                    borderLeft: isDropLeft
                      ? "2px solid hsl(var(--primary))"
                      : undefined,
                    borderRight: isDropRight
                      ? "2px solid hsl(var(--primary))"
                      : undefined,
                  }}
                  onClick={() => handleTabClick(tab.nodeId)}
                  onDoubleClick={() =>
                    handleTabDoubleClick(tab.nodeId, tab.isPreview)
                  }
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      handleTabClose(e, tab.nodeId);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({
                      nodeId: tab.nodeId,
                      x: e.clientX,
                      y: e.clientY,
                    });
                  }}
                  onDragStart={(e) => handleDragStart(e, tab.nodeId)}
                  onDragOver={(e) => handleDragOver(e, tab.nodeId)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => {
                    e.stopPropagation();
                    handleDrop(e, tab.nodeId);
                  }}
                >
                  {synced && (
                    <span
                      className="mr-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary/70"
                      title={t("editor.tabBar.syncedIndicator")}
                    />
                  )}
                  {node?.nodeType === "note" && (
                    <StickyNote
                      className="mr-1 h-3 w-3 shrink-0 text-teal-500"
                      aria-hidden
                    />
                  )}
                  {isCodex && (
                    <BookOpen
                      className="mr-1 h-3 w-3 shrink-0 text-purple-500"
                      aria-hidden
                    />
                  )}
                  {isSnippet && (
                    <Files
                      className="mr-1 h-3 w-3 shrink-0 text-amber-500"
                      aria-hidden
                    />
                  )}
                  {isChronicle && (
                    <CalendarDays
                      className="mr-1 h-3 w-3 shrink-0 text-sky-500"
                      aria-hidden
                    />
                  )}
                  <span
                    className={cn(
                      "max-w-[120px] truncate",
                      tab.isPreview && "italic",
                    )}
                  >
                    {title}
                  </span>
                  {phaseLabel && (
                    <span className="ml-0.5 shrink-0 rounded bg-purple-500/15 px-1 py-0.5 text-[10px] text-purple-500">
                      {phaseLabel}
                    </span>
                  )}
                  <button
                    type="button"
                    title={t("common.close")}
                    className={cn(
                      "ml-1 rounded p-0.5 hover:bg-accent active:scale-[0.97] transition-transform duration-75",
                      isDirty
                        ? "opacity-100"
                        : "opacity-0 group-hover:opacity-100",
                    )}
                    onClick={(e) => handleTabClose(e, tab.nodeId)}
                  >
                    {isDirty ? (
                      <>
                        <span className="block h-2 w-2 rounded-full bg-current group-hover:hidden" />
                        <X className="hidden h-3 w-3 group-hover:block" />
                      </>
                    ) : (
                      <X className="h-3 w-3" />
                    )}
                  </button>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {/* Linear mode toggle: primary group only */}
      {isPrimary && (
        <button
          type="button"
          title={t("editor.tabBar.linearMode")}
          onClick={() => useTabStore.getState().toggleLinearMode()}
          className={cn(
            "flex h-full flex-shrink-0 items-center border-l border-border px-2 text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97] transition-transform duration-75",
            isLinearMode && "bg-accent text-foreground",
          )}
        >
          <ScrollText className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Split dropdown button: primary group only, when no secondary group and not in linear mode */}
      {isPrimary && !hasSecondaryGroup && !isLinearMode && (
        <div
          ref={splitMenuRef}
          className="relative flex-shrink-0 border-l border-border"
        >
          <button
            type="button"
            title={t("editor.tabBar.split")}
            onClick={() => setSplitMenuOpen((v) => !v)}
            className={cn(
              "flex h-full items-center px-2 text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97] transition-transform duration-75",
              splitMenuOpen && "bg-accent text-foreground",
            )}
          >
            <Columns2 className="h-3.5 w-3.5" />
          </button>
          {splitMenuOpen && (
            <div className="absolute right-0 top-full z-50 min-w-[140px] rounded-md border border-border bg-popover py-1 shadow-md">
              <button
                type="button"
                className="flex w-full items-center px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent"
                onClick={() => {
                  useTabStore.getState().createEmptySecondaryGroup("right");
                  setSplitMenuOpen(false);
                }}
              >
                {t("editor.tabBar.splitRight")}
              </button>
              <button
                type="button"
                className="flex w-full items-center px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent"
                onClick={() => {
                  useTabStore.getState().createEmptySecondaryGroup("below");
                  setSplitMenuOpen(false);
                }}
              >
                {t("editor.tabBar.splitBelow")}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Close group button: secondary group */}
      {!isPrimary && (
        <button
          type="button"
          title={t("editor.tabBar.closeGroup")}
          onClick={handleCloseSecondaryGroup}
          className="flex h-full flex-shrink-0 items-center border-l border-border px-2 text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97] transition-transform duration-75"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Overflow dropdown button — shown when tabs don't all fit */}
      {hasOverflow && (
        <div
          ref={overflowBtnRef}
          className="relative flex-shrink-0 border-l border-border"
        >
          <button
            type="button"
            title={t("editor.tabBar.tabList")}
            onClick={() => setOverflowOpen((v) => !v)}
            className={cn(
              "flex h-full items-center gap-0.5 px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97] transition-transform duration-75",
              overflowOpen && "bg-accent text-foreground",
            )}
          >
            <ChevronDown className="h-3 w-3" />
          </button>
          {overflowOpen && (
            <div className="absolute right-0 top-full z-50 min-w-[180px] rounded-md border border-border bg-popover py-1 shadow-md">
              {tabs.map((tab) => {
                const isOverflowCodex = tab.contentType === "codex";
                const isOverflowSnippet = tab.contentType === "snippet";
                const isOverflowChronicle =
                  tab.contentType === "chronicle_event";
                const node =
                  isOverflowCodex || isOverflowSnippet || isOverflowChronicle
                    ? null
                    : nodes.find((n) => n.id === tab.nodeId);
                const overflowCodexEntry = isOverflowCodex
                  ? codexEntries.find((e) => e.id === tab.nodeId)
                  : null;
                const overflowSnippetEntry = isOverflowSnippet
                  ? snippetEntries.find((e) => e.id === tab.nodeId)
                  : null;
                const isActive = tab.nodeId === activeTabId;
                const title =
                  node?.title ??
                  overflowCodexEntry?.name ??
                  overflowSnippetEntry?.title ??
                  tab.label ??
                  "…";
                const overflowPhaseLabel = getTabPhaseLabel(
                  tab,
                  phasesByEntry,
                  globalSceneOrder,
                  activeSceneId,
                );
                return (
                  <button
                    key={tab.nodeId}
                    type="button"
                    onClick={() => handleTabClick(tab.nodeId)}
                    className={cn(
                      "flex w-full items-center px-3 py-1.5 text-left text-xs hover:bg-accent",
                      isActive && "font-medium text-foreground",
                      !isActive && "text-muted-foreground",
                      tab.isPreview && "italic",
                    )}
                  >
                    {node?.nodeType === "note" && (
                      <StickyNote
                        className="mr-1 h-3 w-3 shrink-0 text-teal-500"
                        aria-hidden
                      />
                    )}
                    {isOverflowCodex && (
                      <BookOpen
                        className="mr-1 h-3 w-3 shrink-0 text-purple-500"
                        aria-hidden
                      />
                    )}
                    {isOverflowSnippet && (
                      <Files
                        className="mr-1 h-3 w-3 shrink-0 text-amber-500"
                        aria-hidden
                      />
                    )}
                    {isOverflowChronicle && (
                      <CalendarDays
                        className="mr-1 h-3 w-3 shrink-0 text-sky-500"
                        aria-hidden
                      />
                    )}
                    {title}
                    {overflowPhaseLabel && (
                      <span className="ml-1.5 rounded bg-purple-500/15 px-1 py-0.5 text-[10px] text-purple-500">
                        {overflowPhaseLabel}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {contextMenu && (
        <TabContextMenu
          nodeId={contextMenu.nodeId}
          groupIndex={isPrimary ? 0 : 1}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      )}

      {pendingClose && (
        <UnsavedDialog
          count={
            pendingClose.nodeIds.filter((id) => dirtyTabIds.has(id)).length
          }
          onSaveAndClose={() => {
            const { nodeIds, closeSecondaryGroupAfter } = pendingClose;
            Promise.all(nodeIds.map((id) => saveScene(id)))
              .then(() => executeClose(nodeIds, closeSecondaryGroupAfter))
              .catch(console.error);
            setPendingClose(null);
          }}
          onCloseWithoutSave={() => {
            executeClose(
              pendingClose.nodeIds,
              pendingClose.closeSecondaryGroupAfter,
            );
            setPendingClose(null);
          }}
          onCancel={() => setPendingClose(null)}
        />
      )}
    </div>
  );
}
