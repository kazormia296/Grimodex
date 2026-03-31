import { useMemo } from "react";
import { useEditorStore } from "@/features/editor/editorStore";
import { computeAttributionStats } from "./attributionStats";
import { ExportAgentTraceButton } from "./ExportAgentTraceButton";

interface StatBarProps {
  label: string;
  count: number;
  total: number;
  color: string;
}

function StatBar({ label, count, total, color }: StatBarProps) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <div className="flex-1 h-3 rounded bg-muted overflow-hidden">
        <div
          className="h-full rounded"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className="w-16 text-right tabular-nums text-muted-foreground">
        {count}字 ({pct}%)
      </span>
    </div>
  );
}

export function AttributionReport() {
  const editor = useEditorStore((s) => s.editor);

  const stats = useMemo(() => {
    if (!editor) return null;
    return computeAttributionStats(editor.state.doc);
  }, [editor, editor?.state.doc]);

  if (!stats || stats.total === 0) {
    return (
      <div
        className="p-3 text-xs text-muted-foreground"
        data-testid="attribution-report"
      >
        テキストがありません
      </div>
    );
  }

  const humanTotal = stats.human + stats.unmarked;

  return (
    <div className="flex flex-col gap-2 p-3" data-testid="attribution-report">
      <h3 className="text-sm font-semibold">帰属レポート</h3>
      <StatBar
        label="人間"
        count={humanTotal}
        total={stats.total}
        color="oklch(0.65 0.10 220)"
      />
      <StatBar
        label="AI生成"
        count={stats.ai}
        total={stats.total}
        color="oklch(0.65 0.18 250)"
      />
      <StatBar
        label="不明"
        count={stats.unknown}
        total={stats.total}
        color="oklch(0.65 0.05 0)"
      />
      <StatBar
        label="スニペット"
        count={stats.snippet}
        total={stats.total}
        color="oklch(0.65 0.12 50)"
      />
      <div className="flex items-center justify-between">
        <ExportAgentTraceButton />
        <span className="text-xs text-muted-foreground tabular-nums">
          合計: {stats.total}字
        </span>
      </div>
    </div>
  );
}
