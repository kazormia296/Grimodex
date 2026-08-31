import { Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useWorkLayer } from "./WorkLayerContext";
import { useWorkLayerInitialFocus } from "./useWorkLayerInitialFocus";

export function ResolvedReceipt() {
  const workLayer = useWorkLayer();
  const { t } = useTranslation();
  const closeRef = useWorkLayerInitialFocus<HTMLButtonElement>();
  if (workLayer == null) return null;

  const {
    model,
    navigation,
    close,
    openChangeReview,
    openFinding,
    openProjection,
    selectFinding,
  } = workLayer;
  const nextAttention = model.attention.find(
    (finding) => finding.id !== navigation.selectedFindingId,
  );

  const openNextAttention = () => {
    if (nextAttention == null) return;
    if (nextAttention.kind !== "source-missing") {
      openFinding(nextAttention.id);
      return;
    }
    selectFinding(nextAttention.id);
    openProjection();
    openChangeReview();
  };
  const nextDestination =
    nextAttention?.kind === "source-missing" ? "Change Review" : "Resolve Lens";

  return (
    <div className="pointer-events-none absolute inset-0 z-40">
      <section
        role="status"
        aria-label={t("workLayer.resolved.aria", "プレビュー判断の受領証")}
        className="pointer-events-auto absolute right-3 top-3 w-[min(28rem,calc(100%-1.5rem))] rounded-sm border border-foreground/30 bg-background p-4 text-foreground shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-foreground/40">
            <Check className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
              RESOLVED · UI PREVIEW
            </div>
            <h2 className="mt-1 text-sm font-semibold">
              {navigation.decisionLabel}
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            aria-label={t("common.close", "閉じる")}
            className="rounded-sm p-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          {t(
            "workLayer.resolved.notPersisted",
            "これはUI上の選択確認です。判断はまだ保存されていません。基盤接続後にHuman Decisionとして記録されます。",
          )}
        </p>
        <div className="mt-4 grid grid-cols-3 divide-x divide-border border-y border-border py-2 text-center">
          <div className="px-1">
            <div className="font-mono text-[8px] tracking-[0.1em] text-muted-foreground">
              CHOICE
            </div>
            <div className="mt-1 text-[10px] font-medium">LOCAL</div>
          </div>
          <div className="px-1">
            <div className="font-mono text-[8px] tracking-[0.1em] text-muted-foreground">
              RECORD
            </div>
            <div className="mt-1 text-[10px] font-medium">NOT SAVED</div>
          </div>
          <div className="px-1">
            <div className="font-mono text-[8px] tracking-[0.1em] text-muted-foreground">
              RECHECK
            </div>
            <div className="mt-1 text-[10px] font-medium">NOT STARTED</div>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2">
          {nextAttention != null && (
            <button
              type="button"
              onClick={openNextAttention}
              aria-label={t(
                "workLayer.resolved.nextAria",
                "次: {{title}}を{{destination}}で開く",
                {
                  title: nextAttention.title,
                  destination: nextDestination,
                },
              )}
              className="min-w-0 flex-1 truncate rounded-sm bg-foreground px-3 py-2 text-xs font-medium text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("workLayer.resolved.next", "次: {{title}} →", {
                title: nextAttention.title,
              })}
            </button>
          )}
          <button
            type="button"
            onClick={close}
            className="rounded-sm border border-foreground/30 px-3 py-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("common.close", "閉じる")}
          </button>
        </div>
      </section>
    </div>
  );
}
