import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { parseBeatPreview } from "./parseBeatPreview";
import { InlineSynopsisEditor } from "@/features/editor/InlineSynopsisEditor";
import { useTranslation } from "react-i18next";

interface Props {
  nodeId: string;
  synopsis: string | null;
  unplacedBeatPreview: string | null;
  showSynopsis: boolean;
  showBeats: boolean;
  compact?: boolean;
  onEditingChange?: (editing: boolean) => void;
}

export function GridCardBody({
  nodeId,
  synopsis,
  unplacedBeatPreview,
  showSynopsis,
  showBeats,
  compact,
  onEditingChange,
}: Props) {
  const { t } = useTranslation();
  const [synopsisOpen, setSynopsisOpen] = useState(false);
  const beats = showBeats ? parseBeatPreview(unplacedBeatPreview) : null;
  const hasSynopsis = !!synopsis?.trim();

  // Beat-primary display: beats are shown first, synopsis is collapsed below
  if (beats && beats.length > 0) {
    return (
      <div className="px-3 pb-2 pt-1">
        <ul className="mb-1 space-y-0.5">
          {beats.map((line, i) => (
            <li
              key={i}
              className="flex items-start gap-1 text-[10px] text-muted-foreground leading-snug"
            >
              <span className="mt-px shrink-0 text-[8px] opacity-50">•</span>
              <span className={compact ? "line-clamp-1" : "line-clamp-2"}>
                {line}
              </span>
            </li>
          ))}
        </ul>

        {showSynopsis &&
          hasSynopsis &&
          (synopsisOpen ? (
            <InlineSynopsisEditor
              nodeId={nodeId}
              synopsis={synopsis}
              className="mt-1 cursor-text rounded text-[11px] text-muted-foreground hover:bg-accent/30"
              placeholder={t(
                "grid.card.synopsisPlaceholder",
                "シノプシスを追加…",
              )}
              triggerOn="doubleClick"
              onEditingChange={onEditingChange}
            />
          ) : (
            <button
              className="mt-1 flex items-center gap-0.5 text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              onClick={() => setSynopsisOpen(true)}
            >
              <ChevronRight className="h-2.5 w-2.5" />
              {t("grid.card.showSynopsis", "Show synopsis")}
            </button>
          ))}
      </div>
    );
  }

  // Synopsis-only display (no beats)
  if (showSynopsis && (hasSynopsis || !beats)) {
    return (
      <div className="px-3 pb-2 pt-1">
        <InlineSynopsisEditor
          nodeId={nodeId}
          synopsis={synopsis}
          className="cursor-text rounded text-[11px] text-muted-foreground hover:bg-accent/30"
          placeholder={t("grid.card.synopsisPlaceholder", "シノプシスを追加…")}
          triggerOn="doubleClick"
          onEditingChange={onEditingChange}
        />
      </div>
    );
  }

  return (
    <p className="px-3 pb-2 pt-1 text-[10px] italic text-muted-foreground/50">
      {t("grid.card.empty", "空のシーン")}
    </p>
  );
}
