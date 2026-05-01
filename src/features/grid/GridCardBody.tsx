import { parseBeatPreview } from "./parseBeatPreview";
import { InlineSynopsisEditor } from "@/features/editor/InlineSynopsisEditor";
import { useTranslation } from "react-i18next";

interface Props {
  nodeId: string;
  synopsis: string | null;
  unplacedBeatPreview: string | null;
  showSynopsis: boolean;
  showBeats: boolean;
  onEditingChange?: (editing: boolean) => void;
}

export function GridCardBody({
  nodeId,
  synopsis,
  unplacedBeatPreview,
  showSynopsis,
  showBeats,
  onEditingChange,
}: Props) {
  const { t } = useTranslation();
  const beats = showBeats ? parseBeatPreview(unplacedBeatPreview) : null;
  const hasSynopsis = !!synopsis?.trim();

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

  if (beats) {
    return (
      <ul className="px-3 pb-2 pt-1 space-y-0.5">
        {beats.map((line, i) => (
          <li
            key={i}
            className="flex items-start gap-1 text-[10px] text-muted-foreground leading-snug"
          >
            <span className="mt-px shrink-0 text-[8px] opacity-50">•</span>
            <span className="line-clamp-2">{line}</span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <p className="px-3 pb-2 pt-1 text-[10px] italic text-muted-foreground/50">
      {t("grid.card.empty", "空のシーン")}
    </p>
  );
}
