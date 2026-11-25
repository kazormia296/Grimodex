import { useTranslation } from "react-i18next";

import { useWorkLayer } from "./WorkLayerContext";
import type { WorkLayerLiveEntry } from "./types";

/**
 * Attention tray body for live data: one row per kind of count, with an entry
 * to the screen that handles it when there is one. A "0" is shown as a count,
 * never as "all clear": the counts only say what the readers could find.
 */
export function LiveAttentionRows() {
  const workLayer = useWorkLayer();
  const { t } = useTranslation();
  if (workLayer == null) return null;

  const { model, openSurface, close } = workLayer;
  const entries = model.liveEntries ?? [];

  const titleOf = (entry: WorkLayerLiveEntry) =>
    entry.id === "codex-candidates"
      ? t("workLayer.live.candidatesTitle", "未登録の固有名詞の候補")
      : t("workLayer.live.staleProposalsTitle", "根拠が古くなった提案");

  const statusOf = (entry: WorkLayerLiveEntry) => {
    if (entry.status === "ready") {
      return t("workLayer.live.count", "{{count}} 件", {
        count: entry.count ?? 0,
      });
    }
    if (entry.status === "not-counted") {
      return t("workLayer.live.counting", "数えています…");
    }
    return entry.reason === "timed-out"
      ? t(
          "workLayer.live.slow",
          "数えるのに時間がかかっています（終わったら更新します）",
        )
      : t("workLayer.live.unavailable", "数えられません");
  };

  return (
    <ul className="min-h-0 overflow-auto" data-testid="work-layer-live-rows">
      {entries.map((entry) => {
        const open = entry.open;
        const title = titleOf(entry);
        return (
          <li
            key={entry.id}
            data-work-layer-live-entry={entry.id}
            data-work-layer-live-status={entry.status}
            className="flex items-center gap-3 border-b border-border px-4 py-3"
          >
            <span className="min-w-0 flex-1 text-xs font-medium">{title}</span>
            <span
              className={
                entry.status === "ready"
                  ? "shrink-0 text-xs tabular-nums"
                  : "min-w-0 text-right text-[11px] text-muted-foreground"
              }
            >
              {statusOf(entry)}
            </span>
            {open != null && (
              <button
                type="button"
                aria-label={t(
                  "workLayer.live.reviewAria",
                  "{{title}}を確認する",
                  { title },
                )}
                onClick={() => {
                  // Close the tray first: the review screen is a modal dialog. Closing the
                  // tray hands focus back to the Pulse button that opened it, so the dialog
                  // later returns focus to a button that still exists.
                  close();
                  openSurface(open);
                }}
                className="shrink-0 rounded-sm border border-foreground/30 px-2 py-1 text-[11px] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t("workLayer.live.review", "確認する")}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
