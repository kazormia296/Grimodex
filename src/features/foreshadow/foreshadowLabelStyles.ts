import type { DerivedLabel } from "./types";

/**
 * 伏線の派生ラベル (DerivedLabel) に対する表示スタイルの正本。
 * パネルのフィルタピル / Grid カードのドット / 伏線レーダーのアークが
 * 同じ色で揃うよう、ここを唯一の出所にする。
 */

/** 健全性の悪い順。worst-label 抽出 (Grid カード等) で使う。 */
export const FORESHADOW_LABEL_PRIORITY: DerivedLabel[] = [
  "critical_weak",
  "orphan_payoff",
  "needs_strengthening",
  "seeded",
  "paid",
  "planned",
  "abandoned",
];

/** ラベルピル (背景 + 文字色) クラス。ForeshadowPanel のフィルタ/バッジ用。 */
export const FORESHADOW_LABEL_PILL_CLASS: Record<DerivedLabel, string> = {
  planned: "bg-muted text-muted-foreground",
  seeded: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  paid: "bg-green-500/15 text-green-600 dark:text-green-400",
  critical_weak: "bg-red-500/15 text-red-600 dark:text-red-400",
  needs_strengthening: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  orphan_payoff: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  abandoned: "bg-muted text-muted-foreground/50 line-through",
};

/** ドット背景クラス。Grid カードのヘルス・ドット / レーダーの凡例スウォッチ用。 */
export const FORESHADOW_LABEL_DOT_BG: Record<DerivedLabel, string> = {
  paid: "bg-green-500",
  seeded: "bg-blue-500",
  needs_strengthening: "bg-yellow-400",
  critical_weak: "bg-red-500",
  orphan_payoff: "bg-orange-400",
  planned: "bg-muted-foreground/30",
  abandoned: "bg-muted-foreground/20",
};

/** SVG stroke クラス。レーダーのアーク描画用 (ドット色と対応)。 */
export const FORESHADOW_LABEL_STROKE_CLASS: Record<DerivedLabel, string> = {
  paid: "stroke-green-500",
  seeded: "stroke-blue-500",
  needs_strengthening: "stroke-yellow-400",
  critical_weak: "stroke-red-500",
  orphan_payoff: "stroke-orange-400",
  planned: "stroke-muted-foreground/40",
  abandoned: "stroke-muted-foreground/30",
};

/** SVG fill クラス。レーダーのアーク端点マーカー用 (ドット色と対応)。 */
export const FORESHADOW_LABEL_FILL_CLASS: Record<DerivedLabel, string> = {
  paid: "fill-green-500",
  seeded: "fill-blue-500",
  needs_strengthening: "fill-yellow-400",
  critical_weak: "fill-red-500",
  orphan_payoff: "fill-orange-400",
  planned: "fill-muted-foreground/40",
  abandoned: "fill-muted-foreground/30",
};

/** Grid カードのヘルス・ドット用のツールチップ i18n キー。 */
export const FORESHADOW_LABEL_TITLE_KEY: Record<DerivedLabel, string> = {
  paid: "grid.foreshadow.paid",
  seeded: "grid.foreshadow.seeded",
  needs_strengthening: "grid.foreshadow.needsStrengthening",
  critical_weak: "grid.foreshadow.criticalWeak",
  orphan_payoff: "grid.foreshadow.orphanPayoff",
  planned: "grid.foreshadow.planned",
  abandoned: "grid.foreshadow.abandoned",
};

/** 優先度順に最も健全性の悪いラベルを返す (該当なしは null)。 */
export function worstForeshadowLabel(
  labels: Iterable<DerivedLabel>,
): DerivedLabel | null {
  const set = new Set(labels);
  for (const label of FORESHADOW_LABEL_PRIORITY) {
    if (set.has(label)) return label;
  }
  return null;
}
