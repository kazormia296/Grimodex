import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import {
  externalDocumentStateKey,
  useExternalWriteStore,
} from "@/features/concurrency/externalWriteStore";
import { guardInlineAiPending } from "@/features/editor/inlineAi/pendingGuard";
import {
  type DocumentKey,
  type EditorInstanceId,
} from "@/features/editor/document/documentKey";
import { rootCause } from "@/lib/debugLog";

interface Props {
  nodeId: string;
  documentKey?: DocumentKey | null;
  editorInstanceId?: EditorInstanceId;
  onKeepMine?: () => void | Promise<void>;
  onReload?: () => void | Promise<void>;
}

export function ExternalEditConflictBanner({
  nodeId,
  documentKey,
  onKeepMine,
  onReload,
}: Props) {
  const { t } = useTranslation();
  const [resolving, setResolving] = useState(false);
  const document = documentKey ?? nodeId;
  const stateKey = externalDocumentStateKey(document);
  const conflict = useExternalWriteStore((s) =>
    s.conflicts.find(
      (candidate) =>
        externalDocumentStateKey(candidate.documentKey ?? candidate.sceneId) ===
        stateKey,
    ),
  );
  const shiftConflict = useExternalWriteStore((s) => s.shiftConflict);
  const bumpReloadNonce = useExternalWriteStore((s) => s.bumpReloadNonce);

  if (!conflict) return null;

  const handleReload = async () => {
    if (guardInlineAiPending()) return;
    setResolving(true);
    try {
      await onReload?.();
      // Reload completion is owned by the document surface. It clears dirty
      // and the conflict only after persisted content was actually applied;
      // doing so here would turn a failed/asynchronous reload into data loss.
      bumpReloadNonce(document);
    } catch (error) {
      toast.error(t("autoSave.failed", { reason: rootCause(error) }));
    } finally {
      setResolving(false);
    }
  };

  const handleKeep = async () => {
    if (guardInlineAiPending()) return;
    setResolving(true);
    try {
      await onKeepMine?.();
      shiftConflict(document);
    } catch (error) {
      toast.error(t("autoSave.failed", { reason: rootCause(error) }));
    } finally {
      setResolving(false);
    }
  };

  return (
    <div
      role="alert"
      data-testid="external-edit-conflict"
      className="flex items-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" aria-hidden />
      <p className="flex-1 text-amber-950 dark:text-amber-100">
        {t("externalWrite.conflictBody")}
      </p>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          data-testid="external-edit-keep"
          className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
          onClick={() => void handleKeep()}
          disabled={resolving}
        >
          {t("externalWrite.keepMine")}
        </button>
        <button
          type="button"
          data-testid="external-edit-reload"
          className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground"
          onClick={() => void handleReload()}
          disabled={resolving}
        >
          {t("externalWrite.reload")}
        </button>
      </div>
    </div>
  );
}
