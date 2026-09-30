import { Loader2 } from "lucide-react";
import type { ChronicleExtractionCoverage } from "./chronicleExtractionStore";
import type { NarrativeExtractionTaskCounts } from "@/features/narrative-extraction/runtime/types";

export interface ChronicleExtractionProgressProps {
  readonly analyzing?: boolean;
  readonly coverage: ChronicleExtractionCoverage | null;
  readonly taskCounts: NarrativeExtractionTaskCounts | null;
  readonly proposalCount: number;
}

/**
 * Task progress summary + coverage gaps for Chronicle Run-based extraction.
 */
export function ChronicleExtractionProgress({
  analyzing = false,
  coverage,
  taskCounts,
  proposalCount,
}: ChronicleExtractionProgressProps) {
  const windowCount = coverage?.windowCount ?? 0;
  const completedWindows =
    coverage?.completedWindows ??
    (coverage?.mode === "complete" ? windowCount : 0);
  const gaps = coverage?.gaps ?? [];
  const completedTasks = taskCounts?.completed ?? 0;
  const totalTasks =
    (taskCounts?.queued ?? 0) +
    (taskCounts?.running ?? 0) +
    completedTasks +
    (taskCounts?.failed ?? 0) +
    (taskCounts?.cancelled ?? 0);

  return (
    <div
      className="flex flex-col gap-1 rounded border border-border bg-muted/30 px-2.5 py-2 text-xs text-muted-foreground"
      data-testid="chronicle-extraction-progress"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {analyzing && (
          <Loader2
            className="h-3.5 w-3.5 animate-spin text-primary"
            aria-hidden
          />
        )}
        <span>
          解析 {completedWindows}/{windowCount || "—"} Window
        </span>
        {gaps.length > 0 && (
          <span className="text-amber-700 dark:text-amber-400">
            {gaps.length}件の範囲欠落
          </span>
        )}
        <span>{proposalCount}件の提案</span>
        {totalTasks > 0 && (
          <span className="text-[10px] opacity-80">
            Task {completedTasks}/{totalTasks}
          </span>
        )}
      </div>
      {gaps.length > 0 && (
        <ul
          className="list-inside list-disc text-[11px] text-amber-800 dark:text-amber-300"
          data-testid="chronicle-extraction-gaps"
        >
          {gaps.map((gap, index) => (
            <li key={`${gap.sourceRef ?? gap.windowId ?? "gap"}-${index}`}>
              {gap.reason}
              {gap.sourceRef ? `（${gap.sourceRef}）` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
