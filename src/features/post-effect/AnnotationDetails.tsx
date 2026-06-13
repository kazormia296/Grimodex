import { ArrowRight, ExternalLink, MapPinOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { clipValue, type ParsedAnnotationMeta } from "./annotationMeta";
import type {
  IntentDriftRelation,
  TimelineRelation,
  TypoCategory,
} from "./types";

function openCodexEntry(id: string) {
  useLayoutStore.getState().showPanel("codex");
  useCodexStore.getState().requestSelectEntry(id);
}

interface CodexChipProps {
  codex: NonNullable<ParsedAnnotationMeta["codex"]>;
}

export function CodexChip({ codex }: CodexChipProps) {
  const label = codex.detailName
    ? `${codex.entryName} ▸ ${codex.detailName}`
    : codex.sourceField === "summary"
      ? `${codex.entryName} ▸ サマリ`
      : codex.entryName;

  return (
    <button
      type="button"
      title={`Codex「${codex.entryName}」を開く`}
      onClick={(e) => {
        e.stopPropagation();
        openCodexEntry(codex.entryId);
      }}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded border border-border/70 bg-muted/40 px-1.5 py-0 text-[10px] text-foreground/80",
        "hover:border-primary/50 hover:bg-primary/10 hover:text-primary",
        "transition-colors",
      )}
    >
      <span className="truncate max-w-[14rem]">{label}</span>
      <ExternalLink size={9} className="shrink-0 opacity-60" />
    </button>
  );
}

const CONFIDENCE_STYLE: Record<"high" | "medium" | "low", string> = {
  high: "bg-destructive/15 text-destructive",
  medium: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  low: "bg-muted text-muted-foreground",
};

const CONFIDENCE_LABEL: Record<"high" | "medium" | "low", string> = {
  high: "高",
  medium: "中",
  low: "低",
};

export function ConfidenceBadge({
  level,
}: {
  level: "high" | "medium" | "low";
}) {
  return (
    <span
      title={`AI 信頼度: ${CONFIDENCE_LABEL[level]}`}
      className={cn(
        "shrink-0 rounded px-1 py-0 text-[10px] leading-tight",
        CONFIDENCE_STYLE[level],
      )}
    >
      {CONFIDENCE_LABEL[level]}
    </span>
  );
}

interface ContrastRowProps {
  expected: string | undefined;
  found: string | undefined;
}

/** Codex 値と本文値の対比 1 行。両辺が有意な値のときだけ描画。 */
export function ContrastRow({ expected, found }: ContrastRowProps) {
  const left = clipValue(expected);
  const right = clipValue(found);
  if (!left || !right) return null;
  return (
    <div className="flex items-center gap-1.5 text-[11px] leading-tight">
      <span className="text-muted-foreground">Codex:</span>
      <span className="truncate text-foreground/90">{left}</span>
      <ArrowRight size={10} className="shrink-0 text-muted-foreground" />
      <span className="text-muted-foreground">本文:</span>
      <span className="truncate text-foreground/90">{right}</span>
    </div>
  );
}

const TYPO_CATEGORY_LABEL: Record<TypoCategory, string> = {
  okurigana: "送り仮名",
  "missing-particle": "助詞",
  homophone: "同音異義",
  "missing-char": "脱字",
  // English typo categories (UI チップ文言は別途 i18n フェーズで英語化)
  spelling: "スペル",
  grammar: "文法",
  punctuation: "句読点",
  other: "誤字",
};

export function TypoChip({ category }: { category: TypoCategory }) {
  return (
    <span
      title={`誤字脱字: ${TYPO_CATEGORY_LABEL[category]}`}
      className={cn(
        "inline-flex shrink-0 items-center rounded border border-border/70 bg-muted/40 px-1.5 py-0 text-[10px] text-foreground/80",
      )}
    >
      {TYPO_CATEGORY_LABEL[category]}
    </span>
  );
}

// intent_drift / timeline_consistency 双方の relation を日本語ラベル + tooltip 化する。
// kind ごとに別 chip にせず 1 つで扱う (値が衝突しない union のため)。
const RELATION_LABEL: Record<IntentDriftRelation | TimelineRelation, string> = {
  contradicts: "矛盾",
  absent: "欠落",
  dilutes: "希薄",
  ambiguous: "曖昧",
  chronology: "時系列",
  causality: "因果",
  contradiction: "矛盾",
};

const RELATION_TITLE: Record<IntentDriftRelation | TimelineRelation, string> = {
  contradicts: "狙いと矛盾している",
  absent: "狙いが本文に欠けている",
  dilutes: "狙いはあるが希薄",
  ambiguous: "関係が曖昧",
  chronology: "物語内時系列と矛盾",
  causality: "因果関係と矛盾",
  contradiction: "確立済の事実と矛盾",
};

/**
 * intent_drift の「狙いとのズレ方」/ timeline の「時系列とのズレ方」chip。
 * raw enum でなく日本語ラベルで表示。relation 値は両 effect で衝突しないので共用。
 */
export function IntentRelationChip({
  relation,
}: {
  relation: IntentDriftRelation | TimelineRelation;
}) {
  return (
    <span
      title={RELATION_TITLE[relation]}
      className={cn(
        "inline-flex shrink-0 items-center rounded border border-border/70 bg-muted/40 px-1.5 py-0 text-[10px] text-foreground/80",
      )}
    >
      {RELATION_LABEL[relation]}
    </span>
  );
}

interface TypoContrastRowProps {
  found: string | undefined;
  suggestion: string | undefined;
}

/** typo の 誤→正 対比 1 行。両辺が有意な値のときだけ描画。 */
export function TypoContrastRow({ found, suggestion }: TypoContrastRowProps) {
  const left = clipValue(found);
  const right = clipValue(suggestion);
  if (!left || !right) return null;
  return (
    <div className="flex items-center gap-1.5 text-[11px] leading-tight">
      <span className="text-muted-foreground">誤:</span>
      <span className="truncate text-foreground/90">{left}</span>
      <ArrowRight size={10} className="shrink-0 text-muted-foreground" />
      <span className="text-muted-foreground">正:</span>
      <span className="truncate text-foreground/90">{right}</span>
    </div>
  );
}

interface ExpandedDetailsProps {
  parsed: ParsedAnnotationMeta;
  currentModel?: string | null;
}

/** focus 時に開く 2 段目: 理由、Codex 抜粋、orphaned 時の context、検出モデル。 */
export function ExpandedDetails({
  parsed,
  currentModel,
}: ExpandedDetailsProps) {
  const reason = clipValue(parsed.llmReason, 400);
  const excerpt = clipValue(parsed.codex?.sourceExcerpt, 200);
  const ctx = parsed.orphaned ? clipValue(parsed.foundContext, 200) : null;
  const staleModel =
    parsed.detectedByModel != null &&
    currentModel != null &&
    parsed.detectedByModel !== currentModel;

  if (!reason && !excerpt && !ctx && !parsed.orphaned && !staleModel) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 border-t border-border/60 pt-1.5 text-[11px] text-muted-foreground">
      {reason && (
        <div>
          <span className="font-medium text-foreground/80">理由: </span>
          <span className="leading-snug">{reason}</span>
        </div>
      )}
      {excerpt && (
        <div>
          <span className="font-medium text-foreground/80">Codex 抜粋: </span>
          <span className="leading-snug">{excerpt}</span>
        </div>
      )}
      {ctx && (
        <div>
          <span className="font-medium text-foreground/80">前後文脈: </span>
          <span className="leading-snug">{ctx}</span>
        </div>
      )}
      {(parsed.orphaned || staleModel) && (
        <div className="flex flex-wrap items-center gap-1 pt-0.5 text-[10px]">
          {parsed.orphaned && (
            <span
              title="本文中の該当位置を特定できませんでした"
              className="inline-flex items-center gap-0.5 rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-600 dark:text-amber-400"
            >
              <MapPinOff size={10} /> 位置特定不可
            </span>
          )}
          {staleModel && (
            <span
              title={`現在のモデル (${currentModel}) とは別モデルで検出された指摘です`}
              className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
            >
              by {parsed.detectedByModel}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
