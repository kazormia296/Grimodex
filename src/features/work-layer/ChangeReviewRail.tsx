import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";

const IMPACT_KEYS = ["timeline", "scenes", "thread", "chat"] as const;

export function ChangeReviewRail({
  onInspect,
}: {
  readonly onInspect: () => void;
}) {
  const { t } = useTranslation();

  return (
    <aside className="flex min-w-0 flex-col gap-3">
      <section className="rounded-sm border border-foreground/30 p-3">
        <h3 className="font-mono text-[8px] font-normal tracking-[0.14em] text-muted-foreground">
          {t("workLayer.review.rail.trigger", "変更を引き起こした本文")}
        </h3>
        <blockquote className="mt-2 border-l-2 border-foreground/30 pl-3 font-serif text-xs leading-relaxed">
          {t(
            "workLayer.review.rail.triggerExcerpt",
            "「アリスは鍵を拾い、地下牢を出た。振り返りはしなかった。」",
          )}
        </blockquote>
        <div className="mt-2 font-mono text-[8px] tracking-[0.08em] text-muted-foreground">
          {t("workLayer.review.rail.triggerAnchor", "SCENE 12 · ¶2 · v48")}
        </div>
      </section>

      <section className="min-h-0 flex-1 rounded-sm border border-foreground/30 p-3">
        <h3 className="font-mono text-[8px] font-normal tracking-[0.14em] text-muted-foreground">
          {t("workLayer.review.rail.impact", "適用した場合の影響")}
        </h3>
        <ul className="mt-2 space-y-2 text-[11px]">
          {IMPACT_KEYS.map((key) => (
            <li key={key} className="flex gap-2">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 border border-foreground" />
              <span>{t(`workLayer.review.rail.impacts.${key}`)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-4 space-y-2 border-t border-border pt-3 font-mono text-[8px] leading-relaxed tracking-[0.06em] text-muted-foreground">
          <p>
            {t(
              "workLayer.review.rail.applyEffect",
              "適用時: V2をHuman-derived Revisionとして保存し、下流Consumerを再投影",
            )}
          </p>
          <p>
            {t(
              "workLayer.review.rail.rejectEffect",
              "Reject時: V1を維持し、このMaterial Basisをnegative memoryに記録",
            )}
          </p>
        </div>
      </section>
      <button
        id="work-layer-inspect-review"
        type="button"
        aria-label={t("workLayer.inspect.open", "詳細を検査")}
        onClick={onInspect}
        className="flex w-full items-center justify-center gap-1.5 rounded-sm border border-foreground/30 px-3 py-2 font-mono text-[9px] tracking-[0.1em] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Search className="h-3 w-3" /> INSPECT
      </button>
    </aside>
  );
}
