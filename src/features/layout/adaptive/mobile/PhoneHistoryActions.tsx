import { Redo2, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useQuiescenceLeaseActive } from "@/application/lifecycle/useQuiescenceLeaseActive";

export function PhoneHistoryActions() {
  const { t } = useTranslation();
  const canUndo = useGlobalHistoryStore((state) => state.canUndo);
  const canRedo = useGlobalHistoryStore((state) => state.canRedo);
  const isReplaying = useGlobalHistoryStore((state) => state.isReplaying);
  const undo = useGlobalHistoryStore((state) => state.undo);
  const redo = useGlobalHistoryStore((state) => state.redo);
  const lifecycleLocked = useQuiescenceLeaseActive();

  const onUndo = (): void => {
    void undo().catch(() => {
      toast.error(t("history.undoError"));
    });
  };
  const onRedo = (): void => {
    void redo().catch(() => {
      toast.error(t("history.redoError"));
    });
  };

  return (
    <div className="grid grid-cols-2 gap-2">
      <button
        type="button"
        disabled={!canUndo || isReplaying || lifecycleLocked}
        onClick={onUndo}
        className="flex min-h-12 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-medium disabled:opacity-40"
      >
        <Undo2 className="h-5 w-5 text-muted-foreground" aria-hidden />
        {t("history.undo")}
      </button>
      <button
        type="button"
        disabled={!canRedo || isReplaying || lifecycleLocked}
        onClick={onRedo}
        className="flex min-h-12 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-medium disabled:opacity-40"
      >
        <Redo2 className="h-5 w-5 text-muted-foreground" aria-hidden />
        {t("history.redo")}
      </button>
    </div>
  );
}
