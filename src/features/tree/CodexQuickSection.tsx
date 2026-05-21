import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Pin, PinOff, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { sortEntries, sortEntriesByCategory } from "@/features/codex/codexSort";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useTreeStore } from "./treeStore";
import { CodexQuickPopover } from "./CodexQuickPopover";
import { CodexCommandPalette } from "@/features/codex/components/CodexCommandPalette";
import { AnimatePresence } from "motion/react";
import { getTypeLabel } from "@/features/chat/utils/typeLabels";
import { listCodexTypes, ensureBuiltinTypes } from "@/features/codex/typeApi";
import { getCurrentProjectId } from "@/features/project/projectStore";
import type { CodexEntry } from "@/features/codex/api";
import type { CodexType } from "@/features/codex/typeApi";

export function CodexQuickSection() {
  const { t } = useTranslation();
  const matchedEntryIds = useCodexHighlightStore((s) => s.matchedEntryIds);
  const typeColorMap = useCodexHighlightStore((s) => s.typeColorMap);
  const entries = useCodexStore((s) => s.entries);
  const sortOrder = useCodexStore((s) => s.sortOrder);
  const { pinnedCodexIds, togglePinnedCodex } = useTreeStore();
  const [codexTypes, setCodexTypes] = useState<CodexType[]>([]);

  useEffect(() => {
    ensureBuiltinTypes(getCurrentProjectId())
      .then(() => listCodexTypes(getCurrentProjectId()))
      .then(setCodexTypes)
      .catch(() => setCodexTypes([]));
  }, []);
  const [hoveredEntry, setHoveredEntry] = useState<{
    entry: CodexEntry;
    rect: DOMRect;
  } | null>(null);
  const [showPinPalette, setShowPinPalette] = useState(false);

  // Build matched entry set (deduplicated)
  const matchedIds = new Set(matchedEntryIds);

  // Combine auto-detected + pinned, deduplicated
  const combined = [
    ...entries.filter((e) => matchedIds.has(e.id)),
    ...entries.filter(
      (e) => pinnedCodexIds.includes(e.id) && !matchedIds.has(e.id),
    ),
  ];

  // Apply sort — category uses type-group order matching CodexManagementPanel
  const displayed =
    sortOrder === "category"
      ? sortEntriesByCategory(combined, codexTypes)
      : sortEntries(combined, sortOrder);

  function handleEntryClick(entry: CodexEntry) {
    useLayoutStore.getState().showPanel("codex");
    useCodexStore.getState().requestSelectEntry(entry.id);
  }

  return (
    <>
      <div className="py-1">
        {displayed.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-muted-foreground">
            {t("tree.quickSection.noEntries")}
          </p>
        ) : (
          displayed.map((entry) => (
            <div
              key={entry.id}
              className="group flex cursor-pointer items-center gap-2 px-2 py-1 hover:bg-accent/50"
              onClick={() => handleEntryClick(entry)}
              onMouseEnter={(e) => {
                setHoveredEntry({
                  entry,
                  rect: e.currentTarget.getBoundingClientRect(),
                });
              }}
              onMouseLeave={() => setHoveredEntry(null)}
            >
              {/* Category dot */}
              <span
                className="h-2 w-2 flex-shrink-0 rounded-full"
                style={{
                  backgroundColor: typeColorMap[entry.type]?.fg ?? "#888888",
                }}
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
                    ? t("tree.quickSection.unpin")
                    : t("tree.quickSection.pin")
                }
                onClick={(e) => {
                  e.stopPropagation();
                  togglePinnedCodex(entry.id);
                }}
                className={cn(
                  "hidden h-4 w-4 flex-shrink-0 items-center justify-center rounded text-muted-foreground group-hover:flex",
                  pinnedCodexIds.includes(entry.id) && "flex text-primary",
                )}
              >
                {pinnedCodexIds.includes(entry.id) ? (
                  <PinOff className="h-3 w-3" />
                ) : (
                  <Pin className="h-3 w-3" />
                )}
              </button>
            </div>
          ))
        )}

        {/* Add pin button */}
        <button
          type="button"
          onClick={() => setShowPinPalette(true)}
          className="mt-1 flex w-full items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
          {t("tree.quickSection.pinCodex")}
        </button>
      </div>

      {/* Hover popover */}
      {hoveredEntry && (
        <CodexQuickPopover
          entry={hoveredEntry.entry}
          rect={hoveredEntry.rect}
          dotColor={typeColorMap[hoveredEntry.entry.type]?.fg ?? "#888888"}
          typeLabel={getTypeLabel(hoveredEntry.entry.type)}
          onClose={() => setHoveredEntry(null)}
        />
      )}

      {/* Pin search palette */}
      <AnimatePresence>
        {showPinPalette && (
          <CodexCommandPalette
            onSelect={(entry) => {
              togglePinnedCodex(entry.id);
              setShowPinPalette(false);
            }}
            onClose={() => setShowPinPalette(false)}
          />
        )}
      </AnimatePresence>
    </>
  );
}
