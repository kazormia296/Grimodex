import { useCodexStore } from "@/features/codex/codexStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useSceneBeatPovStore } from "@/features/editor/beat/sceneBeatPovStore";

const MAX_CHIPS = 3;

// Visually distinct palette that works on both light/dark backgrounds
const POV_PALETTE = [
  "#e05c5c", // red
  "#e0875a", // orange
  "#c9a53a", // amber
  "#5aaa6b", // green
  "#3aaa9a", // teal
  "#3a8fd6", // blue
  "#6a5ad6", // indigo
  "#9a3ad6", // violet
  "#d63aaa", // pink
  "#d65a7a", // rose
  "#7aaa3a", // lime
  "#3aaad6", // cyan
];

function hashIdToColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
  }
  return POV_PALETTE[Math.abs(h) % POV_PALETTE.length];
}

interface Props {
  sceneId: string;
  scenePovCharacterId: string | null;
  compact?: boolean;
}

export function GridCardPovChips({ sceneId, scenePovCharacterId }: Props) {
  const beatPovIds = useSceneBeatPovStore(
    (s) => s.povIdsByScene[sceneId] ?? [],
  );
  const entries = useCodexStore((s) => s.entries);

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
        const color = hashIdToColor(id);

        return (
          <button
            key={id}
            onClick={(e) => handleChipClick(e, id)}
            className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium transition-opacity hover:opacity-80"
            style={
              isScene
                ? { backgroundColor: color + "cc", color: "#fff" }
                : {
                    boxShadow: `inset 0 0 0 1px ${color}99`,
                    color: color,
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
