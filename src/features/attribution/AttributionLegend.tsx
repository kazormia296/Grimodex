import { useTranslation } from "react-i18next";

/**
 * 本文オーバーレイ（帰属ハイライト）の凡例。
 * オーバーレイがマークするのは AI（teal）と unknown（amber）のみ。human は
 * 意図的にハイライトしない（＝あなたの執筆は素のまま）ので凡例にも出さない。
 *
 * スウォッチは本文オーバーレイと **同一の `.attribution-*` クラス**を使う＝
 * 同じ color-mix(in oklab, トークン × --attribution-pct × --content-background) を
 * 描画するので、どのテーマ（紙色が色相をずらすダーク系を含む）でも
 * 「凡例の色＝本文ハイライトの色」が必ず一致する。淡いティントなので small
 * swatch でも輪郭が読めるよう枠線を足し、サイズもわずかに大きくしている。
 * （量の内訳を示す BreakdownBar/統計は別物で、そちらは単色トークンのまま。）
 * 表示の ON/OFF（`showAttribution`）は呼び出し側がゲートする。
 */
const LEGEND_SOURCES = ["ai", "unknown"] as const;

// 本文の .attribution-* オーバーレイクラスをそのまま流用（単一の真実源）。
const SWATCH_OVERLAY_CLASS: Record<(typeof LEGEND_SOURCES)[number], string> = {
  ai: "attribution-ai",
  unknown: "attribution-unknown",
};

export function AttributionLegend({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <div
      className={`flex flex-shrink-0 items-center gap-2 whitespace-nowrap ${className ?? ""}`}
      aria-label={t("attribution.legendLabel")}
    >
      {LEGEND_SOURCES.map((source) => (
        <span
          key={source}
          data-legend-source={source}
          className="flex items-center gap-1"
        >
          <span
            className={`${SWATCH_OVERLAY_CLASS[source]} inline-block h-3 w-3 flex-shrink-0 rounded-[2px] border border-border`}
            aria-hidden
          />
          {t(`attribution.${source}`)}
        </span>
      ))}
    </div>
  );
}
