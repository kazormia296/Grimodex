import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";
import { SynopsisArea } from "@/features/tree/SynopsisArea";
import { useCodexStore } from "@/features/codex/codexStore";

interface SynopsisHeaderProps {
  sceneId: string;
}

function CodexRefSelect({
  label,
  value,
  entries,
  onSelect,
}: {
  label: string;
  value: string | null;
  entries: { id: string; name: string }[];
  onSelect: (id: string | null) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <select
        value={value ?? ""}
        onChange={(e) => onSelect(e.target.value || null)}
        className="h-5 rounded border border-border bg-background px-1 text-[10px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      >
        <option value="">—</option>
        {entries.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Collapsible synopsis header above the editor.
 * Includes POV character and Location selectors (C2-U).
 */
export function SynopsisHeader({ sceneId }: SynopsisHeaderProps) {
  const [collapsed, setCollapsed] = useState(false);
  const nodes = useTreeStore((s) => s.nodes);
  const updatePovCharacter = useTreeStore((s) => s.updatePovCharacter);
  const updateLocation = useTreeStore((s) => s.updateLocation);
  const allCodexEntries = useCodexStore((s) => s.entries);

  const node = nodes.find((n) => n.id === sceneId);

  const characters = allCodexEntries.filter((e) => e.type === "character");
  const locations = allCodexEntries.filter((e) => e.type === "location");

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
          {(characters.length > 0 || locations.length > 0) && (
            <div className="mt-1.5 flex flex-wrap gap-3">
              {characters.length > 0 && (
                <CodexRefSelect
                  label="POV"
                  value={node.povCharacterId}
                  entries={characters}
                  onSelect={(id) => updatePovCharacter(sceneId, id)}
                />
              )}
              {locations.length > 0 && (
                <CodexRefSelect
                  label="場所"
                  value={node.locationId}
                  entries={locations}
                  onSelect={(id) => updateLocation(sceneId, id)}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
