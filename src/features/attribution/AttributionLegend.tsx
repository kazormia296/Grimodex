import { useTranslation } from "react-i18next";

/**
 * 本文オーバーレイ（帰属ハイライト）の凡例。
 * オーバーレイがマークするのは AI（teal）と unknown（amber）のみ。human は
 * 意図的にハイライトしない（＝あなたの執筆は素のまま）ので凡例にも出さない。
 * スウォッチは正本トークン由来の Tailwind utility（bg-attribution-*）= 単色の
 * 参照色（淡い本文ティントに対する「色キー」）。inline の color-mix とは別物で、
 * テーマやユーザーの opacity 設定に依らず色相が読み取れるようにしている。
 * 表示の ON/OFF（`showAttribution`）は呼び出し側がゲートする。
 */
const LEGEND_SOURCES = ["ai", "unknown"] as const;

const SWATCH_BG: Record<(typeof LEGEND_SOURCES)[number], string> = {
  ai: "bg-attribution-ai",
  unknown: "bg-attribution-unknown",
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
            className={`${SWATCH_BG[source]} inline-block h-2.5 w-2.5 flex-shrink-0 rounded-[2px]`}
            aria-hidden
          />
          {t(`attribution.${source}`)}
        </span>
      ))}
    </div>
  );
}
