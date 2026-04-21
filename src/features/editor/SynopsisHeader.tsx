import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";
import { SynopsisArea } from "@/features/tree/SynopsisArea";

interface SynopsisHeaderProps {
  sceneId: string;
}

/**
 * C-4: Collapsible synopsis header above the editor.
 */
export function SynopsisHeader({ sceneId }: SynopsisHeaderProps) {
  const [collapsed, setCollapsed] = useState(false);
  const nodes = useTreeStore((s) => s.nodes);
  const node = nodes.find((n) => n.id === sceneId);

  if (!node || node.nodeType !== "scene") return null;

  return (
    <div className="flex-shrink-0 border-b border-border bg-muted/30">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-1 px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {collapsed ? (
          <ChevronRight className="h-3 w-3" />
        ) : (
          <ChevronDown className="h-3 w-3" />
        )}
        <span className="font-medium">Synopsis</span>
        {collapsed && node.synopsis && (
          <span className="ml-2 truncate italic opacity-70">
            {node.synopsis}
          </span>
        )}
        {node.storyTimeLabel && (
          <span
            data-testid="story-time-label"
            className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          >
            {node.storyTimeLabel}
          </span>
        )}
      </button>
      {!collapsed && (
        <div className="px-3 pb-2">
          <SynopsisArea nodeId={sceneId} />
        </div>
      )}
    </div>
  );
}
