import { Undo2, Wrench } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useUiUndoStore } from "@/features/commands/uiOperationUndo";
import type { ToolCallRecord } from "../agent/agentTypes";

interface ToolCallBlockProps {
  record: ToolCallRecord;
}

/**
 * UI 操作ツール（run_app_command／apply_layout_preset）の結果に出す「元に戻す」。
 * 退避はメモリ上だけなので、再読込後（退避が無いとき）は何も出さない。確認は求めず 1 回で戻す。
 */
function UiUndoControl({ undoId }: { undoId: string }) {
  const { t } = useTranslation();
  const status = useUiUndoStore((state) => state.entries[undoId]?.status);
  const failure = useUiUndoStore((state) => state.entries[undoId]?.failure);
  if (status === undefined) return null;
  if (status === "undone") {
    return (
      <span className="ml-2 text-muted-foreground">
        {t("agentUiOps.undone")}
      </span>
    );
  }
  if (status === "superseded") {
    return (
      <span className="ml-2 text-muted-foreground">
        {t("agentUiOps.superseded")}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        aria-label={t("agentUiOps.undoAria")}
        onClick={() => {
          if (useUiUndoStore.getState().undo(undoId) === "failed") {
            const reason =
              useUiUndoStore.getState().entries[undoId]?.failure ?? "layout";
            toast.error(t(`agentUiOps.undoFailed.${reason}`));
          }
        }}
        className="ml-2 inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-foreground hover:bg-muted"
      >
        <Undo2 className="h-3 w-3" aria-hidden />
        {t("agentUiOps.undo")}
      </button>
      {failure !== undefined && (
        <span role="status" className="ml-2 text-muted-foreground">
          {t(`agentUiOps.undoFailed.${failure}`)}
        </span>
      )}
    </>
  );
}

export function ToolCallBlock({ record }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-1 rounded border border-border bg-muted/40 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-1.5 px-2 py-1.5 text-left hover:bg-muted/60"
      >
        <Wrench className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="font-mono font-medium text-foreground">
          {record.name}
        </span>
        <span className="text-muted-foreground">
          (
          {Object.entries(record.params)
            .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
            .join(", ")}
          )
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {expanded ? "▲" : "▼"}
        </span>
      </button>
      <div className="border-t border-border px-2 py-1 text-muted-foreground">
        └─ {record.resultSummary}
        {record.tokensUsed > 0 && (
          <span className="ml-2 opacity-60">(~{record.tokensUsed} tokens)</span>
        )}
        {record.undoId && <UiUndoControl undoId={record.undoId} />}
      </div>
      {expanded && (
        <div className="border-t border-border px-2 py-1.5">
          <div className="mb-1 font-medium text-muted-foreground">Params:</div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-foreground">
            {JSON.stringify(record.params, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
