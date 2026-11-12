import { useTranslation } from "react-i18next";
import { describeBulkApprovalOutcomeReason } from "./chronicleBulkApprovalReasons";
import type { ChronicleBulkApproveOutcome } from "./chronicleExtractionApi";

/** Reasons to name in the result line (the most frequent ones). */
const OUTCOME_REASON_LIMIT = 2;

export interface ChronicleBulkApproveOutcomeNoteProps {
  readonly outcome: ChronicleBulkApproveOutcome;
}

/**
 * The result of one "bulk approve" press (BAO/1, B9): how many were approved,
 * how many were skipped and the main reasons, and how many are left to decide
 * one by one.
 */
export function ChronicleBulkApproveOutcomeNote({
  outcome,
}: ChronicleBulkApproveOutcomeNoteProps) {
  const { t } = useTranslation();
  const notApproved = outcome.skipped.length + outcome.failed.length;
  const reasonCounts = new Map<string, number>();
  for (const item of outcome.skipped) {
    for (const code of new Set(item.reasons)) {
      const text = describeBulkApprovalOutcomeReason(code, (key, fallback) =>
        t(key, fallback),
      );
      reasonCounts.set(text, (reasonCounts.get(text) ?? 0) + 1);
    }
  }
  if (outcome.failed.length > 0) {
    const text = t(
      "chronicle.extract.bulkReason.failed",
      "保存でエラーになりました",
    );
    reasonCounts.set(text, outcome.failed.length);
  }
  const mainReasons = [...reasonCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, OUTCOME_REASON_LIMIT)
    .map(([text]) => text);
  return (
    <div
      className="flex flex-col gap-0.5 text-[10px] leading-snug text-foreground"
      role="status"
      data-testid="chronicle-bulk-approve-result"
    >
      <p>
        {t(
          "chronicle.extract.bulkResultApproved",
          "{{count}} 件を承認しました。",
          { count: outcome.approved },
        )}
        {notApproved > 0
          ? ` ${t(
              "chronicle.extract.bulkResultSkipped",
              "{{count}} 件は飛ばしました（{{reasons}}）。",
              { count: notApproved, reasons: mainReasons.join("、") },
            )}`
          : ""}
      </p>
      <p>
        {t(
          "chronicle.extract.bulkResultRemaining",
          "個別に決める提案が {{count}} 件残っています。",
          { count: outcome.remaining },
        )}
      </p>
      {outcome.notSent > 0 && (
        <p>
          {t(
            "chronicle.extract.bulkResultNotSent",
            "一度に処理できる件数を超えたため、{{count}} 件は送っていません。もう一度押してください。",
            { count: outcome.notSent },
          )}
        </p>
      )}
      {outcome.stopped && (
        <p className="text-amber-700 dark:text-amber-400">
          {t(
            "chronicle.extract.bulkResultStopped",
            "途中で止まりました（終了または workspace の切り替え）。残りは処理していません。",
          )}
        </p>
      )}
      {!outcome.refreshed && (
        <p className="text-amber-700 dark:text-amber-400">
          {t(
            "chronicle.extract.bulkResultNotRefreshed",
            "一覧を読み直せませんでした。表示が古い可能性があります。年表を開き直してください。",
          )}
        </p>
      )}
    </div>
  );
}
