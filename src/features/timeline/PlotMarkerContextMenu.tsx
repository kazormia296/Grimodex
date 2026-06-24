import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { GitBranch, GitMerge } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTimelineStore } from "./timelineStore";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import { PLOT_PHASE_TYPES, type PlotPhaseType } from "@/db/schema";

interface Props {
  linkId: string;
  phaseType: PlotPhaseType;
  /** このマーカーのシーン/スレッド。ここをアンカーする分岐/合流エッジの削除に使う。 */
  nodeId: string;
  threadId: string;
  x: number;
  y: number;
  onClose: () => void;
}

/**
 * プロットマーカー（点）の右クリックメニュー。段階変更 / メモ編集（選択 +
 * インスペクタを開く）/ マーカー削除。TimelineContextMenu と同じ portal パターン。
 */
export function PlotMarkerContextMenu({
  linkId,
  phaseType,
  nodeId,
  threadId,
  x,
  y,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const updateMarker = usePlotThreadStore((s) => s.updateMarker);
  const deleteMarker = usePlotThreadStore((s) => s.deleteMarker);
  const deleteBranch = usePlotThreadStore((s) => s.deleteBranch);
  const branches = usePlotThreadStore((s) => s.branches);
  const threads = usePlotThreadStore((s) => s.threads);
  const setSelectedPlotLinkId = useTimelineStore(
    (s) => s.setSelectedPlotLinkId,
  );
  const toggleInspector = useTimelineStore((s) => s.toggleInspector);

  // このマーカー(threadId, nodeId)が端点になる分岐/合流エッジ。from/to どちら側でも
  // 同じシーンに掛かっていれば候補にする（インスペクタの PlotBranchEditor と同条件）。
  const relatedEdges = branches.filter(
    (b) =>
      b.atNodeId === nodeId &&
      (b.fromThreadId === threadId || b.toThreadId === threadId),
  );
  const threadName = (id: string) =>
    threads.find((tt) => tt.id === id)?.name ||
    t("plotThread.unnamed", "（無名）");

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.max(0, Math.min(x, window.innerWidth - 220)),
    top: Math.max(0, Math.min(y, window.innerHeight - 280)),
    zIndex: 9999,
  };

  return createPortal(
    <div
      ref={menuRef}
      data-testid="plot-marker-context-menu"
      style={style}
      className="min-w-[176px] rounded-md border border-border bg-popover py-1 shadow-lg"
    >
      {/* 段階変更 */}
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("plotThread.phase", "段階")}
      </div>
      {PLOT_PHASE_TYPES.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => {
            void updateMarker(linkId, { phaseType: p });
            onClose();
          }}
          className={cn(
            "flex w-full items-center px-3 py-1.5 text-xs hover:bg-accent",
            phaseType === p && "font-medium text-foreground",
          )}
        >
          {t(`plotThread.phaseType.${p}`, p)}
        </button>
      ))}

      <div className="my-1 border-t border-border" />

      <button
        type="button"
        onClick={() => {
          setSelectedPlotLinkId(linkId);
          if (!useTimelineStore.getState().inspectorOpen) toggleInspector();
          onClose();
        }}
        className="flex w-full items-center px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent"
      >
        {t("plotThread.editNote", "メモを編集")}
      </button>

      <div className="my-1 border-t border-border" />

      <button
        type="button"
        onClick={() => {
          void deleteMarker(linkId);
          if (useTimelineStore.getState().selectedPlotLinkId === linkId) {
            setSelectedPlotLinkId(null);
          }
          onClose();
        }}
        className="flex w-full items-center px-3 py-1.5 text-left text-xs text-[color:var(--destructive)] hover:bg-destructive/10"
      >
        {t("plotThread.deleteMarker", "マーカーを削除")}
      </button>

      {relatedEdges.length > 0 && (
        <>
          <div className="my-1 border-t border-border" />
          <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("plotThread.edges", "分岐 / 合流")}
          </div>
          {relatedEdges.map((b) => {
            const isMerge = b.kind === "merge";
            const Icon = isMerge ? GitMerge : GitBranch;
            const pair = `${threadName(b.fromThreadId)} → ${threadName(b.toThreadId)}`;
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => {
                  void deleteBranch(b.id);
                  onClose();
                }}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-[color:var(--destructive)] hover:bg-destructive/10"
              >
                <Icon size={12} className="shrink-0" aria-hidden />
                <span className="truncate">
                  {isMerge
                    ? t("plotThread.deleteMergeEdge", "{{pair}} の合流を削除", {
                        pair,
                      })
                    : t(
                        "plotThread.deleteBranchEdge",
                        "{{pair}} の分岐を削除",
                        {
                          pair,
                        },
                      )}
                </span>
              </button>
            );
          })}
        </>
      )}
    </div>,
    document.body,
  );
}
