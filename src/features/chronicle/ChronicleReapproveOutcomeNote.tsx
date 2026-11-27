import { useTranslation } from "react-i18next";
import {
  describeReapprovalReason,
  type ReapprovalTranslate,
} from "./chronicleReapprovalText";

/** Reasons to name in the result line (the most frequent ones). */
const OUTCOME_REASON_LIMIT = 2;

export interface ChronicleReapproveOutcomeView {
  readonly approved: number;
  readonly skipped: readonly {
    readonly proposalId: string;
    readonly reason: string;
  }[];
  readonly failed: readonly {
    readonly proposalId: string;
    readonly code: string;
  }[];
  readonly stopped: boolean;
  readonly refreshed: boolean;
}

export interface ChronicleReapproveOutcomeNoteProps {
  readonly outcome: ChronicleReapproveOutcomeView;
}

/**
 * The result of one "承認し直す" press (SRD/1 RA7): how many were approved
 * again, and how many were skipped with the main reasons. Same shape as the
 * bulk-approve note.
 */
export function ChronicleReapproveOutcomeNote({
  outcome,
}: ChronicleReapproveOutcomeNoteProps) {
  const { t } = useTranslation();
  const translate: ReapprovalTranslate = (key, fallback, values) =>
    t(key, fallback, values);
  const notApproved = outcome.skipped.length + outcome.failed.length;
  const reasonCounts = new Map<string, number>();
  for (const item of outcome.skipped) {
    const text =
      describeReapprovalReason(item.reason, translate) ??
      t("chronicle.extract.reapproveReason.unknown", "確かめられませんでした");
    reasonCounts.set(text, (reasonCounts.get(text) ?? 0) + 1);
  }
  if (outcome.failed.length > 0) {
    reasonCounts.set(
      t("chronicle.extract.bulkReason.failed", "保存でエラーになりました"),
      outcome.failed.length,
    );
  }
  const mainReasons = [...reasonCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, OUTCOME_REASON_LIMIT)
    .map(([text]) => text);
  return (
    <div
      className="flex flex-col gap-0.5 text-[10px] leading-snug text-foreground"
      role="status"
      data-testid="chronicle-reapprove-result"
    >
      <p>
        {t(
          "chronicle.extract.reapproveResultApproved",
          "{{count}} 件を承認し直しました。",
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
