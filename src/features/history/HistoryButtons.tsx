import { Undo2, Redo2 } from "lucide-react";
import { toast } from "sonner";
import i18next from "i18next";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { formatShortcut } from "@/lib/platform";
import { useQuiescenceLeaseActive } from "@/application/lifecycle/useQuiescenceLeaseActive";

export function HistoryButtons() {
  const past = useGlobalHistoryStore((s) => s.past);
  const future = useGlobalHistoryStore((s) => s.future);
  const undo = useGlobalHistoryStore((s) => s.undo);
  const redo = useGlobalHistoryStore((s) => s.redo);
  const lifecycleLocked = useQuiescenceLeaseActive();

  const undoLabel = past.length > 0 ? past[past.length - 1].label : null;
  const redoLabel = future.length > 0 ? future[0].label : null;

  const undoKey = formatShortcut("Ctrl+Z");
  const redoKey = formatShortcut("Ctrl+Shift+Z");
  const undoTitle = undoLabel
    ? `${i18next.t("history.undo", "元に戻す")}: ${undoLabel} (${undoKey})`
    : i18next.t("history.undo", "元に戻す") + ` (${undoKey})`;
  const redoTitle = redoLabel
    ? `${i18next.t("history.redo", "やり直し")}: ${redoLabel} (${redoKey})`
    : i18next.t("history.redo", "やり直し") + ` (${redoKey})`;

  const onUndo = () => {
    undo().catch(() => {
      toast.error(i18next.t("history.undoError", "元に戻す操作に失敗しました"));
    });
  };
  const onRedo = () => {
    redo().catch(() => {
      toast.error(i18next.t("history.redoError", "やり直し操作に失敗しました"));
    });
  };

  return (
    <>
      <button
        type="button"
        data-testid="history-undo"
        title={undoTitle}
        disabled={past.length === 0 || lifecycleLocked}
        onClick={onUndo}
        className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
      >
        <Undo2 className="h-4 w-4" />
      </button>
      <button
        type="button"
        data-testid="history-redo"
        title={redoTitle}
        disabled={future.length === 0 || lifecycleLocked}
        onClick={onRedo}
        className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
      >
        <Redo2 className="h-4 w-4" />
      </button>
    </>
  );
}
