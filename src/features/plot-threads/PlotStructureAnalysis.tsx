import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Check,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  PLOT_PHASE_TYPES,
  type PlotPhaseType,
  type PlotBranchKind,
} from "@/db/schema";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { useTreeStore } from "@/features/tree/treeStore";
import { useTimelineStore } from "@/features/timeline/timelineStore";
import {
  computeTimelineSceneOrder,
  sceneIndexById,
} from "@/features/timeline/timelineSceneOrder";
import { usePlotThreadStore } from "./plotThreadStore";
import {
  computeThreadDormancy,
  computeThreadPhaseProgress,
} from "./plotThreadAnalysis";
import { buildPlotThreadsMarkdown } from "./plotThreadMarkdown";
import { PlotThreadAnalysisRow } from "./PlotThreadAnalysisRow";

/**
 * Timeline 下部の構造分析ドロワー（読み取り専用）。
 * 2a 休眠スレッド / 2b 起承転結バランス / 2c プロット構成 Markdown コピー。
 * 軸順は computeTimelineSceneOrder（TimelinePanel と同一正本）に追従する。
 */
export function PlotStructureAnalysis() {
  const { t } = useTranslation();
  const threads = usePlotThreadStore((s) => s.threads);
  const links = usePlotThreadStore((s) => s.links);
  const branches = usePlotThreadStore((s) => s.branches);
  const nodes = useTreeStore((s) => s.nodes);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const axisMode = useTimelineStore((s) => s.axisMode);
  const spacingMode = useTimelineStore((s) => s.spacingMode);
  const toggleDisplay = useTimelineStore((s) => s.toggleDisplay);

  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);

  const phaseLabels = useMemo(() => {
    const m = {} as Record<PlotPhaseType, string>;
    for (const p of PLOT_PHASE_TYPES) m[p] = t(`plotThread.phaseType.${p}`);
    return m;
  }, [t]);

  // N×M 回避: index/status/title の Map を一度だけ構築（行内 filter 禁止）。
  const maps = useMemo(() => {
    const order = computeTimelineSceneOrder(nodes, axisMode, spacingMode);
    const indexById = sceneIndexById(order.scenes);
    const statusByNodeId = new Map<string, string | null>();
    const titleByNodeId = new Map<string, string>();
    for (const n of nodes) {
      titleByNodeId.set(n.id, n.title);
      if (n.nodeType === "scene") statusByNodeId.set(n.id, n.status);
    }
    const tailIndex = order.scenes.length - 1;
    const currentIndex = indexById.get(activeSceneId) ?? tailIndex;
    return {
      indexById,
      statusByNodeId,
      titleByNodeId,
      tailIndex,
      currentIndex,
    };
  }, [nodes, axisMode, spacingMode, activeSceneId]);

  const rows = useMemo(() => {
    const sorted = [...threads].sort((a, b) =>
      cmpKeys(a.sortOrder, b.sortOrder),
    );
    return sorted.map((thread) => ({
      thread,
      dormancy: computeThreadDormancy(
        links,
        thread.id,
        maps.indexById,
        maps.currentIndex,
        maps.tailIndex,
      ),
      progress: computeThreadPhaseProgress(
        links,
        thread.id,
        maps.statusByNodeId,
      ),
    }));
  }, [threads, links, maps]);

  async function handleCopy() {
    const md = buildPlotThreadsMarkdown({
      threads,
      links,
      branches,
      titleByNodeId: maps.titleByNodeId,
      indexByNodeId: maps.indexById,
      phaseLabel: (p) => phaseLabels[p],
      branchKindLabel: (k: PlotBranchKind) =>
        t(`plotThread.branchKindLabel.${k}`),
      labels: {
        heading: t("plotThread.export.heading", "プロット構成"),
        colPhase: t("plotThread.export.colPhase", "段階"),
        colScene: t("plotThread.export.colScene", "シーン"),
        colNote: t("plotThread.export.colNote", "メモ"),
        branchSection: t("plotThread.export.branchSection", "分岐・合流"),
        unknownScene: t("plotThread.export.unknownScene", "（不明なシーン）"),
        unknownThread: t(
          "plotThread.export.unknownThread",
          "（不明なスレッド）",
        ),
      },
    });
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(
        t(
          "plotThread.export.clipboardFailed",
          "クリップボードにコピーできませんでした",
        ),
      );
    }
  }

  return (
    <div
      data-testid="plot-structure-analysis"
      className="flex shrink-0 flex-col overflow-hidden border-t border-border"
      style={{ maxHeight: "40%" }}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-muted/30 px-2 py-1 text-xs">
        <button
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          className="inline-flex items-center gap-1 rounded px-1 py-0.5 font-semibold text-foreground hover:bg-accent/50 focus:outline-none"
          title={t("plotThread.structure.title", "構造分析")}
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          )}
          {t("plotThread.structure.title", "構造分析")}
        </button>

        <div className="ml-auto flex items-center gap-1">
          <button
            data-testid="plot-structure-copy"
            onClick={handleCopy}
            disabled={threads.length === 0}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
            title={t("plotThread.export.copy", "Markdown でコピー")}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <ClipboardCopy className="h-3.5 w-3.5" aria-hidden />
            )}
            {copied
              ? t("plotThread.export.copied", "コピーしました")
              : t("plotThread.export.copy", "Markdown でコピー")}
          </button>
          <button
            onClick={() => toggleDisplay("showStructureAnalysis")}
            className="rounded px-1 py-0.5 text-muted-foreground hover:bg-accent/50 focus:outline-none"
            title={t("plotThread.structure.hide", "構造分析を閉じる")}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>

      {!collapsed &&
        (threads.length === 0 ? (
          <div
            data-testid="plot-structure-empty"
            className="px-3 py-3 text-xs text-muted-foreground"
          >
            {t("plotThread.structure.empty", "プロットスレッドがありません")}
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto py-0.5">
            {rows.map((r) => (
              <PlotThreadAnalysisRow
                key={r.thread.id}
                thread={r.thread}
                dormancy={r.dormancy}
                progress={r.progress}
                phaseLabels={phaseLabels}
              />
            ))}
          </div>
        ))}
    </div>
  );
}
