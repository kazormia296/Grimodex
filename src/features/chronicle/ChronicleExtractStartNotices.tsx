import { useTranslation } from "react-i18next";
import {
  CHRONICLE_START_NOTICE_ORDER,
  type ChronicleStartNoticeKind,
} from "./chronicleExtractScene";

export interface ChronicleExtractStartNoticesProps {
  readonly kinds: readonly ChronicleStartNoticeKind[];
  /** 前の組に残っている未取り込みの提案の件数（pending-review のときの文に使う）。 */
  readonly pendingCount: number;
}

/**
 * 抽出を始める前の知らせ（SSE/1 S7・S8・S8b）。ボタンは持たず、同じ「解析」を
 * もう一度押すと始まる。
 */
export function ChronicleExtractStartNotices({
  kinds,
  pendingCount,
}: ChronicleExtractStartNoticesProps) {
  const { t } = useTranslation();
  const ordered = CHRONICLE_START_NOTICE_ORDER.filter((kind) =>
    kinds.includes(kind),
  );
  if (ordered.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-800 dark:text-amber-300"
      data-testid="chronicle-extract-start-notices"
      role="status"
    >
      {ordered.map((kind) => (
        <p key={kind} data-testid={`chronicle-extract-notice-${kind}`}>
          {kind === "long-scene"
            ? t(
                "chronicle.extract.noticeLongScene",
                "この場面は長いため、提案が関連場面に使われないことがあります。",
              )
            : kind === "pending-review"
              ? t(
                  "chronicle.extract.noticePendingReview",
                  "前の組の提案が{{count}}件残っています。提案は消えません。新しい組の提案をすべて取り込むか拒否すると、前の組に戻れます。承認済みの提案は、取り込まなくても関連場面に使われます。",
                  { count: pendingCount },
                )
              : t(
                  "chronicle.extract.noticeSameSceneApproved",
                  "この場面には、承認済みで取り込んでいない提案があります。抽出し直すと、前の提案と新しい提案の両方が関連場面に使われることがあります。",
                )}
        </p>
      ))}
      <p>
        {t(
          "chronicle.extract.noticeRestart",
          "もう一度「解析」を押すと始めます。",
        )}
      </p>
    </div>
  );
}
