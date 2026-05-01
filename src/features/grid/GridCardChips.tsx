import { useEffect } from "react";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSceneCodexPinsStore } from "@/features/codex/sceneCodexPinsStore";
import { cn } from "@/lib/utils";

const TYPE_COLORS: Record<string, string> = {
  character: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  location: "bg-green-500/20 text-green-300 border-green-500/30",
  item: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  lore: "bg-purple-500/20 text-purple-300 border-purple-500/30",
};

const MAX_CHIPS = 5;
const EMPTY_IDS: string[] = [];

interface Props {
  sceneId: string;
  onChipClick?: (entryId: string) => void;
}

export function GridCardChips({ sceneId, onChipClick }: Props) {
  const loadPinsForScene = useSceneCodexPinsStore((s) => s.loadPinsForScene);
  const entryIds = useSceneCodexPinsStore(
    (s) => s.pinsByScene[sceneId] ?? EMPTY_IDS,
  );
  const entries = useCodexStore((s) => s.entries);

  useEffect(() => {
    void loadPinsForScene(sceneId);
  }, [sceneId, loadPinsForScene]);

  const chips = entryIds
    .slice(0, MAX_CHIPS)
    .map((id) => entries.find((e) => e.id === id))
    .filter(Boolean);

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((entry) => (
        <button
          key={entry!.id}
          className={cn(
            "rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none",
            TYPE_COLORS[entry!.type] ??
              "bg-muted text-muted-foreground border-border",
          )}
          onClick={() => onChipClick?.(entry!.id)}
          title={entry!.name}
        >
          {entry!.name}
        </button>
      ))}
    </div>
  );
}
