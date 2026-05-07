import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import type { TextFragmentPayload, TrashItemData } from "./types";

interface Props {
  item: TrashItemData;
  onRemove: (id: string) => void;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間前`;
  const day = Math.floor(hour / 24);
  return `${day}日前`;
}

function dominantSource(item: TrashItemData): "human" | "ai" | "unknown" {
  if (item.kind !== "text-fragment") return "human";
  const spans = (item.payload as TextFragmentPayload).spans ?? [];
  if (spans.some((s) => s.source === "ai")) return "ai";
  if (spans.some((s) => s.source === "unknown")) return "unknown";
  return "human";
}

export function TrashBinItem({ item, onRemove }: Props) {
  const { t } = useTranslation();
  const source = dominantSource(item);
  const sourceColor =
    source === "ai"
      ? "bg-purple-500"
      : source === "unknown"
        ? "bg-muted-foreground"
        : "bg-foreground";
  const originLabel =
    item.originSceneId != null
      ? t("trashBin.originScene")
      : item.originCodexId != null
        ? t("trashBin.originCodex")
        : "";

  const handleDelete = () => {
    if (!window.confirm(t("trashBin.removeConfirm"))) return;
    onRemove(item.id);
  };

  return (
    <li className="group flex items-center gap-2 border-b border-border/50 px-3 py-2 text-sm hover:bg-muted/50">
      <span
        className={`h-3 w-1 rounded-full ${sourceColor}`}
        aria-hidden="true"
      />
      <span className="flex-1 truncate" title={item.previewText}>
        {item.previewText}
        {item.isInteresting ? " ✨" : ""}
      </span>
      {originLabel && (
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          {originLabel}
        </span>
      )}
      <span className="text-xs text-muted-foreground">
        {relativeTime(item.deletedAt)}
      </span>
      <button
        type="button"
        onClick={handleDelete}
        className="rounded p-1 text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
        title={t("trashBin.discard")}
        aria-label={t("trashBin.discard")}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}
