import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSceneCodexPinsStore } from "@/features/codex/sceneCodexPinsStore";
import { CodexPill } from "@/features/codex/components/CodexPill";
import { PinEntryDialog } from "@/features/codex/components/PinEntryDialog";

const EMPTY_IDS: string[] = [];

interface Props {
  sceneId: string;
  editable?: boolean;
  compact?: boolean;
}

export function GridCardChips({ sceneId, editable, compact }: Props) {
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
    .filter((e): e is NonNullable<typeof e> => Boolean(e));

  const overflow = entryIds.length - MAX_CHIPS;

  if (chips.length === 0 && !editable) return null;

  return (
    <div
      ref={containerRef}
      className="relative flex flex-wrap items-center gap-1"
    >
      {chips.map((entry) => (
        <CodexPill
          key={entry.id}
          entry={entry}
          size={compact ? "sm" : "md"}
          actions={
            editable ? (
              <button
                type="button"
                className="ml-0.5 mr-1 text-muted-foreground/70 hover:text-destructive transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  void removePin(sceneId, entry.id);
                }}
                aria-label={t("grid.card.removeCodex", "削除")}
                title={t("grid.card.removeCodex", "削除")}
              >
                <X className={compact ? "h-2 w-2" : "h-2.5 w-2.5"} />
              </button>
            ) : null
          }
        />
      ))}

      {overflow > 0 && (
        <span className="text-[10px] text-muted-foreground/60">
          +{overflow}
        </span>
      )}

      {editable && (
        <button
          className="rounded-full border border-dashed border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-primary hover:text-primary transition-colors"
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
