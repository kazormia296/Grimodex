import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSceneCodexPinsStore } from "@/features/codex/sceneCodexPinsStore";
import { PinEntryDialog } from "@/features/codex/components/PinEntryDialog";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { cn } from "@/lib/utils";

const TYPE_COLORS: Record<string, string> = {
  character: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  location: "bg-green-500/20 text-green-300 border-green-500/30",
  item: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  lore: "bg-purple-500/20 text-purple-300 border-purple-500/30",
};

const EMPTY_IDS: string[] = [];

interface Props {
  sceneId: string;
  onChipClick?: (entryId: string) => void;
  editable?: boolean;
  compact?: boolean;
}

export function GridCardChips({
  sceneId,
  onChipClick,
  editable,
  compact,
}: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);

  const MAX_CHIPS = compact ? 3 : 5;

  const loadPinsForScene = useSceneCodexPinsStore((s) => s.loadPinsForScene);
  const entryIds = useSceneCodexPinsStore(
    (s) => s.pinsByScene[sceneId] ?? EMPTY_IDS,
  );
  const isPinsLoaded = useSceneCodexPinsStore(
    (s) => s.pinsByScene[sceneId] !== undefined,
  );
  const addPin = useSceneCodexPinsStore((s) => s.addPin);
  const removePin = useSceneCodexPinsStore((s) => s.removePin);
  const entries = useCodexStore((s) => s.entries);

  useEffect(() => {
    if (isPinsLoaded) return;
    void loadPinsForScene(sceneId);
  }, [sceneId, isPinsLoaded, loadPinsForScene]);

  const pinnedIds = useMemo(() => new Set(entryIds), [entryIds]);

  const chips = entryIds
    .slice(0, MAX_CHIPS)
    .map((id) => entries.find((e) => e.id === id))
    .filter(Boolean);

  const overflow = entryIds.length - MAX_CHIPS;

  if (chips.length === 0 && !editable) return null;

  return (
    <div
      ref={containerRef}
      className="relative flex flex-wrap items-center gap-1"
    >
      {chips.map((entry) => (
        <div key={entry!.id} className="group/chip relative inline-flex">
          <button
            className={cn(
              "rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none",
              editable && "pr-4",
              TYPE_COLORS[entry!.type] ??
                "bg-muted text-muted-foreground border-border",
            )}
            onClick={(e) => {
              e.stopPropagation();
              if (!editable) {
                onChipClick?.(entry!.id);
                useLayoutStore.getState().showPanel("codex");
              }
            }}
            title={entry!.name}
          >
            {entry!.name}
          </button>
          {editable && (
            <button
              className="absolute right-0.5 top-1/2 -translate-y-1/2 rounded-full opacity-0 group-hover/chip:opacity-100 transition-opacity hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                void removePin(sceneId, entry!.id);
              }}
              title={t("grid.card.removeCodex", "削除")}
            >
              <X className="h-2 w-2" />
            </button>
          )}
        </div>
      ))}

      {overflow > 0 && (
        <span className="text-[10px] text-muted-foreground/60">
          +{overflow}
        </span>
      )}

      {editable && (
        <button
          className="rounded border border-dashed border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-primary hover:text-primary transition-colors"
          onClick={() => setPopoverOpen((v) => !v)}
          title={t("grid.card.addCodex", "Codex を紐付け")}
        >
          <Plus className="h-2.5 w-2.5" />
        </button>
      )}

      <PinEntryDialog
        open={popoverOpen}
        pinnedIds={pinnedIds}
        onPin={(eid) => void addPin(sceneId, eid)}
        onUnpin={(eid) => void removePin(sceneId, eid)}
        onClose={() => setPopoverOpen(false)}
        containerRef={containerRef}
        anchorRef={containerRef}
        tabs={["codex"]}
        title={t("grid.card.pinCodexTitle", "Codex を紐付け")}
      />
    </div>
  );
}
