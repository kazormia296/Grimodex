import {
  ArrowLeft,
  CircleSlash2,
  RotateCw,
  Search,
  Unlink,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { useWorkLayer } from "./WorkLayerContext";
import { useWorkLayerInitialFocus } from "./useWorkLayerInitialFocus";

export function SystemBlocked() {
  const workLayer = useWorkLayer();
  const { t } = useTranslation();
  const backRef = useWorkLayerInitialFocus<HTMLButtonElement>();
  if (workLayer == null) return null;

  const { model, back, close, openInspect } = workLayer;
  const reason =
    model.system.blockedReason?.trim() ||
    t(
      "workLayer.system.blockedReasonFallback",
      "停止理由の詳細はまだ提供されていません。",
    );
  const staleImpact =
    model.system.staleImpact?.trim() ||
    t(
      "workLayer.system.staleImpactFallback",
      "影響範囲は未判定です。既存の構造と判断は変更されません。",
    );

  return (
    <section
      role="dialog"
      aria-label={t("workLayer.system.blockedAria", "System Blocked")}
      aria-modal="false"
      className="absolute left-1/2 top-2 z-40 flex max-h-[min(36rem,calc(100%-1rem))] w-[min(25rem,calc(100%-2rem))] translate-x-14 flex-col overflow-hidden rounded-sm border border-foreground/40 bg-background text-foreground shadow-2xl"
    >
      <header className="flex h-10 shrink-0 items-center border-b border-foreground/30 px-3">
        <button
          ref={backRef}
          type="button"
          onClick={back}
          aria-label={t("workLayer.back", "一段戻る")}
          className="rounded-sm p-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <CircleSlash2 aria-hidden="true" className="ml-2 h-3.5 w-3.5" />
        <span className="ml-2 font-mono text-[9px] tracking-[0.16em]">
          SYSTEM BLOCKED
        </span>
        <span className="ml-2 rounded-sm border border-foreground/30 px-1.5 py-0.5 font-mono text-[8px] tracking-[0.1em] text-muted-foreground">
          UI PREVIEW
        </span>
        <button
          type="button"
          onClick={close}
          aria-label={t("common.close", "閉じる")}
          className="ml-auto rounded-sm p-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="rounded-sm border border-foreground/30 bg-foreground/5 p-4">
          <div className="font-mono text-[8px] tracking-[0.14em]">
            SYS · BLOCKED
          </div>
          <h2 className="mt-1 text-base font-semibold">{model.system.label}</h2>
        </div>

        <dl className="mt-4 grid gap-3">
          <div className="rounded-sm border border-border bg-card p-3">
            <dt className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
              {t("workLayer.system.blockedReason", "停止理由")}
            </dt>
            <dd className="mt-2 text-sm leading-relaxed">{reason}</dd>
          </div>
          <div className="rounded-sm border border-border bg-card p-3">
            <dt className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
              {t("workLayer.system.staleImpact", "古くなる可能性がある範囲")}
            </dt>
            <dd className="mt-2 text-sm leading-relaxed">{staleImpact}</dd>
          </div>
        </dl>

        <div className="mt-4 rounded-sm border border-dashed border-border p-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t(
              "workLayer.system.blockedPreviewOnly",
              "再実行とDetachはUI配置だけのプレビューです。保存・再実行・切り離しは行いません。",
            )}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              id="work-layer-inspect-system-run"
              type="button"
              onClick={openInspect}
              aria-label={t(
                "workLayer.system.inspectRunAria",
                "System runを検査",
              )}
              className="flex items-center gap-1.5 rounded-sm border border-foreground/40 px-3 py-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Search className="h-3.5 w-3.5" />
              {t("workLayer.system.inspectRun", "INSPECT →")}
            </button>
            <button
              type="button"
              disabled
              className="flex items-center gap-1.5 rounded-sm border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground disabled:cursor-not-allowed disabled:opacity-70"
            >
              <RotateCw className="h-3.5 w-3.5" />
              {t("workLayer.system.retryPreview", "再実行 · PREVIEW ONLY")}
            </button>
            <button
              type="button"
              disabled
              className="flex items-center gap-1.5 rounded-sm border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground disabled:cursor-not-allowed disabled:opacity-70"
            >
              <Unlink className="h-3.5 w-3.5" />
              {t("workLayer.system.detachPreview", "Detach · PREVIEW ONLY")}
            </button>
          </div>
        </div>

        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          {t(
            "workLayer.system.blockedNoCheckbox",
            "SYSの停止はFindingやTaskの完了ではありません。チェック操作では解消しません。",
          )}
        </p>
      </div>
    </section>
  );
}
