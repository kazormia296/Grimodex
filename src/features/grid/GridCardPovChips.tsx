import { useEffect, useState } from "react";
import { useCodexStore } from "@/features/codex/codexStore";
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

  return (
    <div className="flex flex-wrap items-center gap-1 px-3 pb-1.5">
      {displayPovs.map(({ id, isScene }) => {
        const entry = entries.find((e) => e.id === id);
        const name = entry?.name ?? id.slice(0, 8);
        return (
          <span
            key={id}
            className={
              isScene
                ? "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/70 text-white"
                : "inline-flex items-center rounded-full border border-blue-500/50 px-1.5 py-0.5 text-[10px] font-medium text-blue-400"
            }
            title={isScene ? "Scene POV" : "Beat POV override"}
          >
            {name}
          </span>
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
