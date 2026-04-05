import { useRef, useState, useEffect } from "react";
import { X, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTabStore } from "./tabStore";
import { useTreeStore } from "@/features/tree/treeStore";
import type { GroupIndex } from "./tabStore";

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

  const isPrimary = groupIndex === 0;
  const tabs = isPrimary ? primaryTabs : secondaryTabs;
  const activeTabId = isPrimary ? primaryActiveTabId : secondaryActiveTabId;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowBtnRef = useRef<HTMLDivElement>(null);

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

  if (tabs.length === 0) return null;

  function handleTabClick(nodeId: string) {
    setOverflowOpen(false);
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

  return (
    <div className="flex items-center border-b border-border bg-background">
      {/* Scrollable tab list */}
      <div
        ref={scrollRef}
        className="flex min-w-0 flex-1 items-center overflow-x-auto"
      >
        {tabs.map((tab) => {
          const node = nodes.find((n) => n.id === tab.nodeId);
          const isActive = tab.nodeId === activeTabId;
          const title = node?.title ?? "…";
          const synced = isSyncedScene(tab.nodeId);

          return (
            <div
              key={tab.nodeId}
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
              onClick={() => handleTabClick(tab.nodeId)}
              onDoubleClick={() =>
                handleTabDoubleClick(tab.nodeId, tab.isPreview)
              }
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
    </div>
  );
}
