import { useRef, useState, useEffect } from "react";
import { X, ChevronDown, Columns2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTabStore } from "./tabStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { TabContextMenu } from "./TabContextMenu";
import type { GroupIndex } from "./tabStore";

export const DRAG_DATA_KEY = "application/grimodex-tab";
/** Per-group marker so drop zones can detect source group during dragover. */
export const DRAG_GROUP_KEY = (g: 0 | 1) => `application/grimodex-tab-g${g}`;

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
  const primaryTabs = useTabStore((s) => s.tabs);
  const primaryActiveTabId = useTabStore((s) => s.activeTabId);
  const secondaryTabs = useTabStore((s) => s.secondaryTabs);
  const secondaryActiveTabId = useTabStore((s) => s.secondaryActiveTabId);
  const isSyncedScene = useTabStore((s) => s.isSyncedScene);

  const nodes = useTreeStore((s) => s.nodes);

  const hasSecondaryGroup = useTabStore((s) => s.secondaryGroupOpen);
  const isPrimary = groupIndex === 0;
  const tabs = isPrimary ? primaryTabs : secondaryTabs;
  const activeTabId = isPrimary ? primaryActiveTabId : secondaryActiveTabId;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowBtnRef = useRef<HTMLDivElement>(null);

  // Drag-and-drop state
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [isDraggingTab, setIsDraggingTab] = useState(false);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    nodeId: string;
    x: number;
    y: number;
  } | null>(null);

  // Split dropdown state (primary group only)
  const splitMenuRef = useRef<HTMLDivElement>(null);
  const [splitMenuOpen, setSplitMenuOpen] = useState(false);

  // Track global drag start/end to show the split drop zone
  useEffect(() => {
    function onDragStart() {
      setIsDraggingTab(true);
    }
    function onDragEnd() {
      setIsDraggingTab(false);
      setDropTarget(null);
    }
    document.addEventListener("dragstart", onDragStart);
    document.addEventListener("dragend", onDragEnd);
    return () => {
      document.removeEventListener("dragstart", onDragStart);
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
    useTabStore.getState().requestEditorFocus();
    if (isPrimary) {
      useTabStore.getState().setActiveTab(nodeId);
      useTreeStore.getState().setActiveScene(nodeId);
    } else {
      useTabStore.getState().setSecondaryActiveTab(nodeId);
      useTreeStore.getState().setActiveScene(nodeId);
    }
  }

  function handleTabClose(e: React.MouseEvent, nodeId: string) {
    e.stopPropagation();
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

  // Drop on the "split" zone → create secondary group
  function handleSplitDrop(e: React.DragEvent) {
    e.preventDefault();
    const raw = e.dataTransfer.getData(DRAG_DATA_KEY);
    if (!raw) return;
    const { nodeId: srcId, groupIndex: srcGroup } = JSON.parse(
      raw,
    ) as DragPayload;
    if (srcGroup !== 0) return;
    useTabStore.getState().moveTabBetweenGroups(srcId, 0, 1);
    useTreeStore.getState().setActiveScene(srcId);
  }

  return (
    <div className="flex items-center border-b border-border bg-background">
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
        {tabs.map((tab) => {
          const node = nodes.find((n) => n.id === tab.nodeId);
          const isActive = tab.nodeId === activeTabId;
          const title = node?.title ?? "…";
          const synced = isSyncedScene(tab.nodeId);
          const isDropLeft =
            dropTarget?.nodeId === tab.nodeId && dropTarget.side === "left";
          const isDropRight =
            dropTarget?.nodeId === tab.nodeId && dropTarget.side === "right";

          return (
            <div
              key={tab.nodeId}
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
                  title="別のグループでも開かれています"
                />
              )}
              {node?.nodeType === "note" && (
                <span className="mr-0.5 text-teal-500">📝</span>
              )}
              <span
                className={cn(
                  "max-w-[140px] truncate",
                  tab.isPreview && "italic",
                )}
              >
                {title}
              </span>
              <button
                type="button"
                title="閉じる"
                className="ml-1 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
                onClick={(e) => handleTabClose(e, tab.nodeId)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>

      {/* Split dropdown button: primary group only, when no secondary group */}
      {isPrimary && !hasSecondaryGroup && !isDraggingTab && (
        <div
          ref={splitMenuRef}
          className="relative flex-shrink-0 border-l border-border"
        >
          <button
            type="button"
            title="分割"
            onClick={() => setSplitMenuOpen((v) => !v)}
            className={cn(
              "flex h-full items-center px-2 text-muted-foreground hover:bg-accent hover:text-foreground",
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
                右に分割
              </button>
              <button
                type="button"
                className="flex w-full items-center px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent"
                onClick={() => {
                  useTabStore.getState().createEmptySecondaryGroup("below");
                  setSplitMenuOpen(false);
                }}
              >
                下に分割
              </button>
            </div>
          )}
        </div>
      )}

      {/* Split drop zone: primary group only, when no secondary group, during drag */}
      {isPrimary && !hasSecondaryGroup && isDraggingTab && (
        <div
          title="ここにドロップして分割"
          className="flex h-full flex-shrink-0 items-center border-l border-primary/50 bg-primary/10 px-2 text-xs text-primary"
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(DRAG_DATA_KEY)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
          onDrop={handleSplitDrop}
        >
          <Columns2 className="h-3.5 w-3.5" />
        </div>
      )}

      {/* Close group button: secondary group */}
      {!isPrimary && (
        <button
          type="button"
          title="グループを閉じる"
          onClick={() => useTabStore.getState().closeSecondaryGroup()}
          className="flex h-full flex-shrink-0 items-center border-l border-border px-2 text-muted-foreground hover:bg-accent hover:text-foreground"
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
            title="タブ一覧"
            onClick={() => setOverflowOpen((v) => !v)}
            className={cn(
              "flex h-full items-center gap-0.5 px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
              overflowOpen && "bg-accent text-foreground",
            )}
          >
            <ChevronDown className="h-3 w-3" />
          </button>
          {overflowOpen && (
            <div className="absolute right-0 top-full z-50 min-w-[180px] rounded-md border border-border bg-popover py-1 shadow-md">
              {tabs.map((tab) => {
                const node = nodes.find((n) => n.id === tab.nodeId);
                const isActive = tab.nodeId === activeTabId;
                const title = node?.title ?? "…";
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
                      <span className="mr-1 text-teal-500">📝</span>
                    )}
                    {title}
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
    </div>
  );
}
