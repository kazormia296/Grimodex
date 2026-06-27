import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { useExternalWriteStore } from "@/features/concurrency/externalWriteStore";
import { useTabStore } from "@/features/editor/tabStore";
import { guardInlineAiPending } from "@/features/editor/inlineAi/pendingGuard";

interface Props {
  nodeId: string;
}

export function ExternalEditConflictBanner({ nodeId }: Props) {
  const { t } = useTranslation();
  const conflict = useExternalWriteStore((s) =>
    s.conflicts.find((c) => c.sceneId === nodeId),
  );
  const shiftConflict = useExternalWriteStore((s) => s.shiftConflict);
  const bumpReloadNonce = useExternalWriteStore((s) => s.bumpReloadNonce);

  if (!conflict) return null;

  const handleReload = () => {
    if (guardInlineAiPending()) return;
    useTabStore.getState().setTabDirty(nodeId, false);
    bumpReloadNonce(nodeId);
    shiftConflict(nodeId);
  };

  const handleKeep = () => {
    shiftConflict(nodeId);
  };

  return (
    <div
      role="alert"
      className="flex items-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" aria-hidden />
      <p className="flex-1 text-amber-950 dark:text-amber-100">
        {t("externalWrite.conflictBody")}
      </p>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
          onClick={handleKeep}
        >
          {t("externalWrite.keepMine")}
        </button>
        <button
          type="button"
          className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground"
          onClick={handleReload}
        >
          {t("externalWrite.reload")}
        </button>
      </div>
    </div>
  );
}
