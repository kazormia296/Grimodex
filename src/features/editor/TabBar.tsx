import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTabStore } from "./tabStore";
import { useTreeStore } from "@/features/tree/treeStore";

export function TabBar() {
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const closeTab = useTabStore((s) => s.closeTab);
  const setActiveTab = useTabStore((s) => s.setActiveTab);
  const openPinned = useTabStore((s) => s.openPinned);
  const nodes = useTreeStore((s) => s.nodes);

  if (tabs.length === 0) return null;

  function handleTabClick(nodeId: string) {
    setActiveTab(nodeId);
    useTreeStore.getState().setActiveScene(nodeId);
  }

  function handleTabClose(e: React.MouseEvent, nodeId: string) {
    e.stopPropagation();
    closeTab(nodeId);
    const newActiveId = useTabStore.getState().activeTabId;
    if (newActiveId) useTreeStore.getState().setActiveScene(newActiveId);
  }

  function handleTabDoubleClick(nodeId: string, isPreview: boolean) {
    if (isPreview) {
      openPinned(nodeId);
    }
  }

  return (
    <div className="flex items-center overflow-x-auto border-b border-border bg-background">
      {tabs.map((tab) => {
        const node = nodes.find((n) => n.id === tab.nodeId);
        const isActive = tab.nodeId === activeTabId;
        const title = node?.title ?? "…";

        return (
          <div
            key={tab.nodeId}
            className={cn(
              "group relative flex cursor-pointer items-center gap-1 shrink-0",
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
  );
}
