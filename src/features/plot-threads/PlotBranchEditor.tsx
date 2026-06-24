import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, GitBranch, GitMerge } from "lucide-react";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { PLOT_BRANCH_KINDS, type PlotBranchKind } from "@/db/schema";
import { usePlotThreadStore } from "./plotThreadStore";
import type { PlotThreadRow } from "./api";

/**
 * 選択中マーカーのシーン（atNodeId）を起点に、現在のスレッドから別スレッドへの
 * 分岐 / 合流エッジを追加・削除する。reading-order でのみ線が描かれる（描画側ゲート）。
 */
export function PlotBranchEditor({
  thread,
  atNodeId,
  threads,
}: {
  thread: PlotThreadRow;
  atNodeId: string;
  threads: PlotThreadRow[];
}) {
  const { t } = useTranslation();
  const branches = usePlotThreadStore((s) => s.branches);
  const addBranch = usePlotThreadStore((s) => s.addBranch);
  const deleteBranch = usePlotThreadStore((s) => s.deleteBranch);

  const others = threads.filter((th) => th.id !== thread.id);
  const [kind, setKind] = useState<PlotBranchKind>("branch");
  const [targetId, setTargetId] = useState<string>(others[0]?.id ?? "");

  // このスレッド × このシーンに関わる既存エッジのみ表示。
  const related = branches.filter(
    (b) =>
      b.atNodeId === atNodeId &&
      (b.fromThreadId === thread.id || b.toThreadId === thread.id),
  );

  const threadName = (id: string) =>
    threads.find((th) => th.id === id)?.name ||
    t("plotThread.unnamed", "（無名）");

  return (
    <div className="flex flex-col gap-1" data-testid="plot-branch-editor">
      <span className="text-muted-foreground">
        {t("plotThread.branches", "分岐 / 合流")}
      </span>

      {related.map((b) => (
        <div key={b.id} className="flex items-center gap-1 text-foreground/80">
          {b.kind === "merge" ? (
            <GitMerge className="h-3 w-3 shrink-0" aria-hidden />
          ) : (
            <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
          )}
          <span className="truncate">
            {threadName(b.fromThreadId)} → {threadName(b.toThreadId)}
          </span>
          <button
            type="button"
            onClick={() => void deleteBranch(b.id)}
            aria-label={t("plotThread.deleteBranch", "分岐を削除")}
            className="ml-auto shrink-0 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      ))}

      {others.length === 0 ? (
        <span className="text-muted-foreground">
          {t("plotThread.branchNeedsTwo", "他のスレッドが必要です")}
        </span>
      ) : (
        <div className="flex items-center gap-1">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as PlotBranchKind)}
            aria-label={t("plotThread.branchKind", "種別")}
            className="shrink-0 rounded border border-border bg-background px-1 py-0.5 text-xs focus:outline-none"
          >
            {PLOT_BRANCH_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`plotThread.branchKindLabel.${k}`, k)}
              </option>
            ))}
          </select>
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            aria-label={t("plotThread.branchTarget", "対象スレッド")}
            className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-xs focus:outline-none"
          >
            {others.map((th) => (
              <option key={th.id} value={th.id}>
                {th.name || t("plotThread.unnamed", "（無名）")}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              // 自己参照（from===to）と、同一(from,to,atNode,kind)の重複を弾く。
              if (!targetId || targetId === thread.id) return;
              const dup = branches.some(
                (b) =>
                  b.fromThreadId === thread.id &&
                  b.toThreadId === targetId &&
                  b.atNodeId === atNodeId &&
                  b.kind === kind,
              );
              if (dup) return;
              void addBranch({
                projectId: getCurrentProjectId(),
                fromThreadId: thread.id,
                toThreadId: targetId,
                atNodeId,
                kind,
              });
            }}
            className="shrink-0 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent/50"
          >
            {t("plotThread.addBranch", "追加")}
          </button>
        </div>
      )}
    </div>
  );
}
