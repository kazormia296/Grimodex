import { useTranslation } from "react-i18next";
import { Trash2, Hand } from "lucide-react";
import type { TrashItemData } from "./types";
import { dominantSource } from "./displayHelpers";
import { TrashBinPopover } from "./TrashBinPopover";

interface ListViewProps {
  items: TrashItemData[];
  isLoading: boolean;
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

export function TrashBinListView({
  items,
  isLoading,
  onRemove,
}: ListViewProps) {
  const { t } = useTranslation();

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        …
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-12 text-center text-sm text-muted-foreground">
        {t("trashBin.empty")}
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border/50">
      {items.map((item) => (
        <TrashBinListItem key={item.id} item={item} onRemove={onRemove} />
      ))}
    </ul>
  );
}

function TrashBinListItem({
  item,
  onRemove,
}: {
  item: TrashItemData;
  onRemove: (id: string) => void;
}) {
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
    // 確認は親 (TrashBinPanel) が confirm を返す onRemove で集約処理する。
    onRemove(item.id);
  };

  return (
    <li
      className="group flex items-center gap-2 border-b border-border/50 px-3 py-2 text-sm hover:bg-muted/50"
      data-subkind={item.subKind}
      data-interesting={item.isInteresting}
    >
      <span
        className={`h-3 w-1 rounded-full ${sourceColor}`}
        aria-hidden="true"
      />
      <span className="flex-1 truncate" title={item.previewText}>
        {item.previewText}
      </span>
      {originLabel && (
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          {originLabel}
        </span>
      )}
      <span className="text-xs text-muted-foreground">
        {relativeTime(item.deletedAt)}
      </span>
      <TrashBinPopover item={item}>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground opacity-0 hover:bg-primary/10 hover:text-primary group-hover:opacity-100"
          title={t("trashBin.pickup")}
          aria-label={t("trashBin.pickup")}
        >
          <Hand className="h-3.5 w-3.5" />
        </button>
      </TrashBinPopover>
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
