import {
  Clock,
  Crosshair,
  Eye,
  Layers,
  Radar,
  Scale,
  ScanText,
  SpellCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import i18next from "@/lib/i18n";
import { codexChipLabel } from "@/features/post-effect/annotationMeta";
import type {
  PostEffectType,
  TypoCategory,
} from "@/features/post-effect/types";
import type { FullCheckStepId } from "../fullCheckStore";
import type { IssueCat, IssueMeta, IssueSev } from "./issueModel";
import { formatRelativeTime } from "./relativeTime";
import type { EffectLastRunMap } from "./useEffectLastRuns";

/**
 * catalog.ts — 観点（IssueCat）と表示ラベル / effect / severity スタイルの
 * 対応表。issueModel（純データ）と UI の間の写像をここに集約する。
 */

/** 観点名の i18n キー（旧セクション見出しキーを再利用）。 */
export const CAT_LABEL_KEY: Record<IssueCat, string> = {
  linter: "settings.linter.proofreading",
  typo: "kouetsu.issues.typo",
  consistency: "codex.tab.consistency",
  impact: "kouetsu.impactReview.title",
  review: "kouetsu.editorial.review",
  intent: "kouetsu.editorial.intentDrift",
  meta: "kouetsu.editorial.metaStructure",
  timeline: "kouetsu.editorial.timeline",
};

/** 観点アイコン（ドロップダウン・ダッシュボードタイル等の視覚識別）。 */
export const CAT_ICON: Record<IssueCat, LucideIcon> = {
  linter: SpellCheck,
  typo: ScanText,
  consistency: Scale,
  impact: Radar,
  review: Eye,
  intent: Crosshair,
  meta: Layers,
  timeline: Clock,
};

/** 観点 → 全体チェックのステップ。impact は全体チェック対象外（null）。 */
export const CAT_TO_STEP: Record<IssueCat, FullCheckStepId | null> = {
  linter: "lint",
  typo: "typo",
  consistency: "consistency",
  impact: null,
  review: "review",
  intent: "intent",
  meta: "meta",
  timeline: "timeline",
};

/** ステップ → 観点（パイプラインのアコーディオンが指摘を引くため）。 */
export const STEP_TO_CAT: Record<FullCheckStepId, IssueCat> = {
  lint: "linter",
  typo: "typo",
  consistency: "consistency",
  review: "review",
  meta: "meta",
  timeline: "timeline",
  intent: "intent",
};

/**
 * 観点 → post-effect effect 種。実行中スピナー（useIsPostEffectRunning）と
 * 最終実行時刻（useEffectLastRuns）の照合に使う。linter は post-effect 外。
 */
export const CAT_EFFECTS: Record<IssueCat, readonly PostEffectType[]> = {
  linter: [],
  typo: ["typo_detection"],
  consistency: ["consistency", "intra_scene_consistency"],
  impact: ["impact_review"],
  review: ["review"],
  intent: ["intent_drift"],
  meta: ["meta_structure"],
  timeline: ["timeline_consistency"],
};

// ---------------------------------------------------------------------------
// severity スタイル（CSS 変数は src/index.css の --kouetsu-* が正本）
// ---------------------------------------------------------------------------

export const SEV_LABEL_KEY: Record<IssueSev, string> = {
  high: "kouetsu.triage.sev.high",
  mid: "kouetsu.triage.sev.mid",
  low: "kouetsu.triage.sev.low",
};

/** 行の左レール（border-left）。 */
export const SEV_RAIL_CLASS: Record<IssueSev, string> = {
  high: "border-l-[var(--kouetsu-sev-high)]",
  mid: "border-l-[var(--kouetsu-sev-mid)]",
  low: "border-l-[var(--kouetsu-sev-low)]",
};

/** 観点チップ（bg + fg）。 */
export const SEV_CHIP_CLASS: Record<IssueSev, string> = {
  high: "bg-[var(--kouetsu-chip-high-bg)] text-[var(--kouetsu-chip-high-fg)]",
  mid: "bg-[var(--kouetsu-chip-mid-bg)] text-[var(--kouetsu-chip-mid-fg)]",
  low: "bg-[var(--kouetsu-chip-low-bg)] text-[var(--kouetsu-chip-low-fg)]",
};

/** 重大度ドット / 分布バーの塗り。 */
export const SEV_DOT_CLASS: Record<IssueSev, string> = {
  high: "bg-[var(--kouetsu-sev-high)]",
  mid: "bg-[var(--kouetsu-sev-mid)]",
  low: "bg-[var(--kouetsu-sev-low)]",
};

/** excerpt 内の <mark> 背景。 */
export const SEV_MARK_CLASS: Record<IssueSev, string> = {
  high: "bg-[var(--kouetsu-mark-high)]",
  mid: "bg-[var(--kouetsu-mark-mid)]",
  low: "bg-[var(--kouetsu-mark-low)]",
};

/** タイル等の件数文字色（chip の fg を流用）。 */
export const SEV_TEXT_CLASS: Record<IssueSev, string> = {
  high: "text-[var(--kouetsu-chip-high-fg)]",
  mid: "text-[var(--kouetsu-chip-mid-fg)]",
  low: "text-[var(--kouetsu-chip-low-fg)]",
};

// ---------------------------------------------------------------------------
// IssueMeta → 表示ラベル
// ---------------------------------------------------------------------------

/** TypoCategory（kebab-case）→ 既存 i18n キー（camelCase）。 */
const TYPO_CATEGORY_KEY: Record<TypoCategory, string> = {
  okurigana: "postEffect.typo.category.okurigana",
  "missing-particle": "postEffect.typo.category.missingParticle",
  "missing-char": "postEffect.typo.category.missingChar",
  spelling: "postEffect.typo.category.spelling",
  grammar: "postEffect.typo.category.grammar",
  punctuation: "postEffect.typo.category.punctuation",
  homophone: "postEffect.typo.category.homophone",
  other: "postEffect.typo.category.other",
};

/** lensType → 既存 i18n キー。 */
const LENS_KEY: Record<string, string> = {
  plot_structure: "kouetsu.lens.structure",
  pacing: "kouetsu.lens.pacing",
  character_arc: "kouetsu.lens.characterArc",
  pov: "kouetsu.lens.pov",
};

/**
 * 行のメタ表示ラベル。構造化 IssueMeta（issueModel）を文字列化する。
 * relation は既存 postEffect.relation.* をそのまま引く。
 */
export function issueMetaLabel(meta: IssueMeta): string {
  if (!meta) return "";
  const t = i18next.t.bind(i18next);
  switch (meta.kind) {
    case "rule":
      return meta.ruleId;
    case "codex":
      return codexChipLabel(meta.codex);
    case "typo":
      return `${t("kouetsu.triage.aiDetected")} · ${t(TYPO_CATEGORY_KEY[meta.category] ?? "postEffect.typo.category.other")}`;
    case "relation":
      return t(`postEffect.relation.${meta.relation}`, meta.relation);
    case "lens":
      return t(LENS_KEY[meta.lensType] ?? "kouetsu.editorial.metaStructure");
    case "impact":
      return meta.entryName;
  }
}

// ---------------------------------------------------------------------------
// 最終実行時刻の表示
// ---------------------------------------------------------------------------

/** RelativeTime を表示文字列へ（kouetsu.triage.time.* を引く）。 */
export function relativeTimeLabel(iso: string, now: Date): string | null {
  const rt = formatRelativeTime(iso, now);
  if (!rt) return null;
  const t = i18next.t.bind(i18next);
  switch (rt.kind) {
    case "justNow":
      return t("kouetsu.triage.time.justNow");
    case "minutesAgo":
      return t("kouetsu.triage.time.minutesAgo", { count: rt.minutes });
    case "timeOfDay":
      return rt.label;
    case "yesterday":
      return t("kouetsu.triage.time.yesterday");
    case "date":
      return rt.label;
  }
}

/**
 * 観点の最終実行 ISO。consistency は codex/intra 2 effect の新しい方
 * （useEffectLastRuns は生 7 キーで返すためここで畳む）。
 */
export function catLastRunIso(
  cat: IssueCat,
  lastRuns: EffectLastRunMap,
): string | null {
  let latest: string | null = null;
  for (const effect of CAT_EFFECTS[cat]) {
    const iso = lastRuns[effect];
    if (iso && (latest === null || iso > latest)) latest = iso;
  }
  return latest;
}
