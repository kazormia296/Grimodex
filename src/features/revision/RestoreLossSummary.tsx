import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { RestoreLossNotice } from "./projectSnapshotNative";
import { describeRestoreLoss } from "./restoreLossNotices";

interface RestoreLossSummaryProps {
  mode: "preview" | "result";
  notices: readonly RestoreLossNotice[];
  status?: "idle" | "loading" | "ready" | "error";
  heading?: ReactNode;
  note?: ReactNode;
}

export function RestoreLossSummary({
  mode,
  notices,
  status = "ready",
  heading,
  note,
}: RestoreLossSummaryProps) {
  const { t } = useTranslation();
  const summary = describeRestoreLoss(notices);
  if (
    mode === "preview" &&
    (status === "idle" || (status === "ready" && summary.total === 0))
  ) {
    return null;
  }

  return (
    <section className="mb-4 rounded border border-border bg-muted/30 px-3 py-2">
      {heading && <h3 className="mb-2 text-sm font-medium">{heading}</h3>}
      {note && <p className="mb-2 text-xs text-muted-foreground">{note}</p>}

      {mode === "preview" && status === "loading" ? (
        <p className="text-sm">{t("snapshot.loss.previewLoading")}</p>
      ) : mode === "preview" && status === "error" ? (
        <p className="text-sm">{t("snapshot.loss.previewError")}</p>
      ) : summary.lostCount > 0 ? (
        <ul className="space-y-1 text-sm">
          {summary.items.map(({ kind, count }) => (
            <li key={kind}>
              {t(`snapshot.loss.kind.${kind}`)} —{" "}
              {t("snapshot.loss.count", { count })}
            </li>
          ))}
          {summary.otherCount > 0 && (
            <li>{t("snapshot.loss.other", { count: summary.otherCount })}</li>
          )}
        </ul>
      ) : null}
      {summary.resetCount > 0 && (
        <p className="mt-2 text-sm">
          {t(
            mode === "preview"
              ? "snapshot.loss.resetPreview"
              : "snapshot.loss.resetResult",
            { count: summary.resetCount },
          )}
        </p>
      )}
    </section>
  );
}
