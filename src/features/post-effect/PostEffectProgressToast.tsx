import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Loader2, CircleCheck, CircleAlert } from "lucide-react";
import { toast } from "sonner";
import { abortPostEffectRun } from "./api";
import { usePostEffectRunStore, type ActivePostEffectRun } from "./runStore";

/**
 * PostEffect run の進行状況を画面右下にトースト風で常駐表示する
 * （ReindexProgressToast と同型）。校閲パネルを閉じていても・別タブに
 * 移動していても「実行中である」ことと進捗（multi は 3/12）が見える。
 * 終端後は runStore 側の AUTO_CLEAR_MS で自動的に消える。
 *
 * 中止ボタンは multi 実行（totalScenes あり）のみ出す: バックエンドの
 * abort フラグはシーン間の境界でしかチェックされないため、単一シーン
 * run には効かない（DB 上 cancelled になるだけで呼び出しは続く）。
 */
export function PostEffectProgressToast() {
  const { t } = useTranslation();
  const runs = usePostEffectRunStore((s) => s.runs);
  const [aborting, setAborting] = useState<ReadonlySet<string>>(new Set());

  const list = Object.values(runs);
  if (list.length === 0) return null;

  const abort = async (run: ActivePostEffectRun) => {
    setAborting((prev) => new Set(prev).add(run.runId));
    try {
      await abortPostEffectRun(run.runId, run.projectId);
      // 実際の終了は backend の post_effect:error("中断されました") が
      // runStore に届いた時点。ここでは要求済み表示に切り替えるだけ。
    } catch (e) {
      setAborting((prev) => {
        const next = new Set(prev);
        next.delete(run.runId);
        return next;
      });
      toast.error(t("kouetsu.progressToast.abortFailed"), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        right: 16,
        // ReindexProgressToast (bottom:16) / ModelDownloadToast (bottom:84) と
        // 干渉しない 3 段目。
        bottom: 152,
        zIndex: 9998,
        width: 280,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {list.map((run) => {
        const label = t(
          `kouetsu.progressToast.effect.${run.effectType}`,
          run.effectType,
        );
        const scopeLabel = t(
          `kouetsu.progressToast.scope.${run.scopeType}`,
          run.scopeType,
        );
        const pct = Math.min(100, Math.round(run.progress * 100));
        return (
          <div
            key={run.runId}
            style={{
              background: "var(--popover)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              boxShadow: "0 6px 24px rgba(0,0,0,0.20)",
              padding: "10px 12px",
              fontSize: 12,
              color: "var(--foreground)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {run.outcome === undefined ? (
                <Loader2 size={13} className="animate-spin shrink-0" />
              ) : run.outcome.kind === "done" ? (
                <CircleCheck size={13} className="shrink-0 text-green-500" />
              ) : (
                <CircleAlert size={13} className="shrink-0 text-red-500" />
              )}
              <span style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>
                {label}
                <span style={{ fontWeight: 400, opacity: 0.7 }}>
                  {" "}
                  · {scopeLabel}
                </span>
              </span>
              {run.outcome === undefined &&
                run.totalScenes !== undefined &&
                (aborting.has(run.runId) ? (
                  <span style={{ opacity: 0.7 }}>
                    {t("kouetsu.progressToast.aborting")}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void abort(run)}
                    className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  >
                    {t("kouetsu.progressToast.abort")}
                  </button>
                ))}
            </div>
            <div style={{ marginTop: 6, opacity: 0.8 }}>
              {run.outcome === undefined
                ? run.message
                  ? t("kouetsu.progressToast.runningProgress", {
                      progress: run.message,
                    })
                  : t("kouetsu.progressToast.running")
                : run.outcome.kind === "done"
                  ? run.outcome.annotationCount > 0
                    ? t("kouetsu.progressToast.done", {
                        count: run.outcome.annotationCount,
                      })
                    : t("kouetsu.progressToast.doneNoFindings")
                  : t("kouetsu.progressToast.failed", {
                      error: run.outcome.error,
                    })}
            </div>
            {run.outcome === undefined && (
              <div
                aria-hidden
                style={{
                  marginTop: 6,
                  height: 4,
                  borderRadius: 2,
                  background: "var(--border)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${pct}%`,
                    background: "var(--primary)",
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
