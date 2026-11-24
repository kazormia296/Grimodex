import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  CodexStructureExtractionCoverage,
  CodexStructureSkippedRelationalTerm,
} from "./codexStructureExtractionStore";
import type { NarrativeExtractionTaskCounts } from "@/features/narrative-extraction/runtime/types";

export interface CodexStructureExtractionProgressProps {
  readonly analyzing?: boolean;
  readonly coverage: CodexStructureExtractionCoverage | null;
  readonly taskCounts: NarrativeExtractionTaskCounts | null;
  readonly entityCount: number;
  readonly relationCount?: number;
  readonly unresolvedCount?: number;
  /** 関係の呼び名として新規の提案にしなかった語（live の診断）。 */
  readonly skippedRelationalTerms?: readonly CodexStructureSkippedRelationalTerm[];
}

const SKIPPED_SURFACE_DISPLAY_LIMIT = 10;

/**
 * Task progress summary for Codex Structure Extraction runs.
 */
export function CodexStructureExtractionProgress({
  analyzing = false,
  coverage,
  taskCounts,
  entityCount,
  relationCount = 0,
  unresolvedCount = 0,
  skippedRelationalTerms = [],
}: CodexStructureExtractionProgressProps) {
  const { t } = useTranslation();
  // 表記の種類の数（出現数ではない）。同じ表記は 1 件にまとめ、表示は先頭だけにする。
  const skippedSurfaces = [
    ...new Set(skippedRelationalTerms.map((term) => term.surface)),
  ];
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
      data-testid="codex-structure-extraction-progress"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {analyzing && (
          <Loader2
            className="h-3.5 w-3.5 animate-spin text-primary"
            aria-hidden
          />
        )}
        <span>
          {t("codex.structureReview.progress.windows", {
            completed: completedWindows,
            total: windowCount || "—",
          })}
        </span>
        {gaps.length > 0 && (
          <span className="text-amber-700 dark:text-amber-400">
            {t("codex.structureReview.progress.gaps", {
              count: gaps.length,
            })}
          </span>
        )}
        <span>
          {t("codex.structureReview.progress.proposalCounts", {
            entityCount,
            relationCount,
          })}
          {unresolvedCount > 0 &&
            t("codex.structureReview.progress.unresolvedCount", {
              count: unresolvedCount,
            })}
        </span>
        {totalTasks > 0 && (
          <span className="text-[10px] opacity-80">
            {t("codex.structureReview.progress.tasks", {
              completed: completedTasks,
              total: totalTasks,
            })}
          </span>
        )}
      </div>
      {gaps.length > 0 && (
        <ul
          className="list-inside list-disc text-[11px] text-amber-800 dark:text-amber-300"
          data-testid="codex-structure-extraction-gaps"
        >
          {gaps.map((gap, index) => (
            <li key={`${gap.sourceRef ?? gap.windowId ?? "gap"}-${index}`}>
              {gap.reason}
              {gap.sourceRef
                ? t("codex.structureReview.progress.sourceRef", {
                    sourceRef: gap.sourceRef,
                  })
                : ""}
            </li>
          ))}
        </ul>
      )}
      {skippedSurfaces.length > 0 && (
        <p
          className="text-[11px]"
          data-testid="codex-structure-extraction-skipped-relational"
        >
          {t("codex.structureReview.progress.skippedRelationalTerms", {
            surfaces: skippedSurfaces
              .slice(0, SKIPPED_SURFACE_DISPLAY_LIMIT)
              .map((surface) => `「${surface}」`)
              .join(""),
            more:
              skippedSurfaces.length > SKIPPED_SURFACE_DISPLAY_LIMIT
                ? t("codex.structureReview.progress.moreSkipped", {
                    count:
                      skippedSurfaces.length - SKIPPED_SURFACE_DISPLAY_LIMIT,
                  })
                : "",
            count: skippedSurfaces.length,
          })}
        </p>
      )}
    </div>
  );
}
