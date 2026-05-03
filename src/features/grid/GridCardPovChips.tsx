import { useEffect, useState } from "react";
import { useCodexStore } from "@/features/codex/codexStore";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { listSceneBeatPovOverrides } from "@/features/editor/beat/beatPovCacheApi";

const MAX_CHIPS = 3;

interface Props {
  sceneId: string;
  scenePovCharacterId: string | null;
  compact?: boolean;
}

export function GridCardPovChips({ sceneId, scenePovCharacterId }: Props) {
  const [beatPovIds, setBeatPovIds] = useState<string[]>([]);
  const entries = useCodexStore((s) => s.entries);
  const typeColorMap = useCodexHighlightStore((s) => s.typeColorMap);

  useEffect(() => {
    void listSceneBeatPovOverrides(sceneId).then(setBeatPovIds);
  }, [sceneId]);

  // Build effective POV list: scene POV first, then beat-only overrides
  const effectivePovIds: { id: string; isScene: boolean }[] = [];
  if (scenePovCharacterId) {
    effectivePovIds.push({ id: scenePovCharacterId, isScene: true });
  }
  for (const id of beatPovIds) {
    if (!effectivePovIds.some((p) => p.id === id)) {
      effectivePovIds.push({ id, isScene: false });
    }
  }

  if (effectivePovIds.length === 0) return null;

  const displayPovs = effectivePovIds.slice(0, MAX_CHIPS);
  const extraCount = Math.max(0, effectivePovIds.length - MAX_CHIPS);

  function handleChipClick(e: React.MouseEvent, entryId: string) {
    e.stopPropagation();
    useCodexStore.getState().requestSelectEntry(entryId);
    useLayoutStore.getState().showPanel("codex");
  }

  return (
    <div className="flex flex-wrap items-center gap-1 px-3 pb-1.5">
      {displayPovs.map(({ id, isScene }) => {
        const entry = entries.find((e) => e.id === id);
        const name = entry?.name ?? id.slice(0, 8);
        const fgColor = entry?.type
          ? (typeColorMap[entry.type]?.fg ?? "#888888")
          : "#888888";

        return (
          <button
            key={id}
            onClick={(e) => handleChipClick(e, id)}
            className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium transition-opacity hover:opacity-80"
            style={
              isScene
                ? { backgroundColor: fgColor + "b3", color: "#fff" }
                : {
                    boxShadow: `inset 0 0 0 1px ${fgColor}80`,
                    color: fgColor,
                  }
            }
            title={isScene ? "Scene POV" : "Beat POV override"}
          >
            {name}
          </button>
        );
      })}
      {extraCount > 0 && (
        <span className="text-[10px] text-muted-foreground">
          +{extraCount} more
        </span>
      )}
    </div>
  );
}
