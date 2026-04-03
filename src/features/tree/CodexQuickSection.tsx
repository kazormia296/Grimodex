import { useState } from "react";
import { ChevronDown, ChevronRight, Pin, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useTreeStore } from "./treeStore";

const TYPE_COLORS: Record<string, string> = {
  character: "bg-purple-500",
  location: "bg-teal-500",
  item: "bg-amber-500",
  lore: "bg-coral-500",
};

function typeDotColor(type: string): string {
  return TYPE_COLORS[type] ?? "bg-muted-foreground";
}

export function CodexQuickSection() {
  const [collapsed, setCollapsed] = useState(false);
  const matchTargets = useCodexHighlightStore((s) => s.matchTargets);
  const entries = useCodexStore((s) => s.entries);
  const { pinnedCodexIds, togglePinnedCodex } = useTreeStore();

  // Build matched entry list (deduplicated)
  const matchedIds = new Set(matchTargets.map((m) => m.id));

  // Combine auto-detected + pinned, deduplicated
  const displayed = [
    ...entries.filter((e) => matchedIds.has(e.id)),
    ...entries.filter(
      (e) => pinnedCodexIds.includes(e.id) && !matchedIds.has(e.id),
    ),
  ];

  return (
    <div className="flex-shrink-0 border-t border-border">
      {/* Section header */}
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs font-semibold text-foreground hover:bg-accent/50"
      >
        {collapsed ? (
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        )}
        Codex Quick
      </button>

      {!collapsed && (
        <div className="pb-1">
          {displayed.length === 0 ? (
            <p className="px-3 py-1 text-[11px] text-muted-foreground">
              エントリなし
            </p>
          ) : (
            displayed.map((entry) => (
              <div
                key={entry.id}
                className="group flex items-center gap-2 px-2 py-1 hover:bg-accent/50"
              >
                {/* Category dot */}
                <span
                  className={cn(
                    "h-2 w-2 flex-shrink-0 rounded-full",
                    typeDotColor(entry.type),
                  )}
                />
                {/* Name */}
                <span className="flex-1 truncate text-xs text-foreground">
                  {entry.name}
                </span>
                {/* Type label */}
                <span className="text-[10px] text-muted-foreground">
                  {entry.type}
                </span>
                {/* Pin/unpin button */}
                <button
                  type="button"
                  title={
                    pinnedCodexIds.includes(entry.id)
                      ? "ピン留め解除"
                      : "ピン留め"
                  }
                  onClick={() => togglePinnedCodex(entry.id)}
                  className={cn(
                    "hidden h-4 w-4 flex-shrink-0 items-center justify-center rounded text-muted-foreground group-hover:flex",
                    pinnedCodexIds.includes(entry.id) && "flex text-primary",
                  )}
                >
                  {pinnedCodexIds.includes(entry.id) ? (
                    <X className="h-3 w-3" />
                  ) : (
                    <Pin className="h-3 w-3" />
                  )}
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
