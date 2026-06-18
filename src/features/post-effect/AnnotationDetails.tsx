import { ArrowRight, ExternalLink, MapPinOff } from "lucide-react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const label = codex.detailName
    ? `${codex.entryName} ▸ ${codex.detailName}`
    : codex.sourceField === "summary"
      ? `${codex.entryName} ▸ ${t("postEffect.codex.summary")}`
      : codex.entryName;

  return (
    <button
      type="button"
      title={t("postEffect.codex.openEntry", { entryName: codex.entryName })}
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

interface ImpactChipProps {
  impact: NonNullable<ParsedAnnotationMeta["impact"]>;
}

/**
 * impact_review (変更影響レビュー) chip。変更された Codex 設定 (entry ▸ 変更要約) を
 * 表示し、クリックで該当エントリを開く。CodexChip と同じ導線。
 */
export function ImpactChip({ impact }: ImpactChipProps) {
  const { t } = useTranslation();
  const label = impact.changeSummary
    ? `${impact.entryName} ▸ ${impact.changeSummary}`
    : impact.entryName;

  return (
    <button
      type="button"
      title={t("postEffect.codex.openEntry", { entryName: impact.entryName })}
      onClick={(e) => {
        e.stopPropagation();
        openCodexEntry(impact.entryId);
      }}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded border border-border/70 bg-muted/40 px-1.5 py-0 text-[10px] text-foreground/80",
        "hover:border-primary/50 hover:bg-primary/10 hover:text-primary",
        "transition-colors",
      )}
    >
      <span className="truncate max-w-[16rem]">{label}</span>
      <ExternalLink size={9} className="shrink-0 opacity-60" />
    </button>
  );
}

const CONFIDENCE_STYLE: Record<"high" | "medium" | "low", string> = {
  high: "bg-destructive/15 text-destructive",
  medium: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
  low: "bg-muted text-muted-foreground",
};

export function ConfidenceBadge({
  level,
}: {
  level: "high" | "medium" | "low";
}) {
  const { t } = useTranslation();
  const label = t(`postEffect.confidence.${level}`);
  return (
    <span
      title={t("postEffect.confidence.title", { level: label })}
      className={cn(
        "shrink-0 rounded px-1 py-0 text-[10px] leading-tight",
        CONFIDENCE_STYLE[level],
      )}
    >
      {label}
    </span>
  );
}

interface ContrastRowProps {
  expected: string | undefined;
  found: string | undefined;
}

/** Codex 値と本文値の対比 1 行。両辺が有意な値のときだけ描画。 */
export function ContrastRow({ expected, found }: ContrastRowProps) {
  const { t } = useTranslation();
  const left = clipValue(expected);
  const right = clipValue(found);
  if (!left || !right) return null;
  return (
    <div className="flex items-center gap-1.5 text-[11px] leading-tight">
      <span className="text-muted-foreground">
        {t("postEffect.contrast.codex")}
      </span>
      <span className="truncate text-foreground/90">{left}</span>
      <ArrowRight size={10} className="shrink-0 text-muted-foreground" />
      <span className="text-muted-foreground">
        {t("postEffect.contrast.text")}
      </span>
      <span className="truncate text-foreground/90">{right}</span>
    </div>
  );
}

// typo category → i18n key。enum 値 (TypoCategory) はそのまま key として使う
// (LLM JSON 契約・post_effect.rs allow-list と一致させるため値は変更しない)。
const TYPO_CATEGORY_KEY: Record<TypoCategory, string> = {
  okurigana: "postEffect.typo.category.okurigana",
  "missing-particle": "postEffect.typo.category.missingParticle",
  homophone: "postEffect.typo.category.homophone",
  "missing-char": "postEffect.typo.category.missingChar",
  spelling: "postEffect.typo.category.spelling",
  grammar: "postEffect.typo.category.grammar",
  punctuation: "postEffect.typo.category.punctuation",
  other: "postEffect.typo.category.other",
};

export function TypoChip({ category }: { category: TypoCategory }) {
  const { t } = useTranslation();
  const label = t(TYPO_CATEGORY_KEY[category]);
  return (
    <span
      title={t("postEffect.typo.titleTemplate", { category: label })}
      className={cn(
        "inline-flex shrink-0 items-center rounded border border-border/70 bg-muted/40 px-1.5 py-0 text-[10px] text-foreground/80",
      )}
    >
      {label}
    </span>
  );
}

// intent_drift / timeline_consistency 双方の relation を表示ラベル + tooltip 化する。
// kind ごとに別 chip にせず 1 つで扱う (値が衝突しない union のため)。
// enum 値 (relation) はそのまま i18n key の suffix に使う (値自体は変更しない)。
const RELATION_LABEL_KEY: Record<
  IntentDriftRelation | TimelineRelation,
  string
> = {
  contradicts: "postEffect.relation.contradicts",
  absent: "postEffect.relation.absent",
  dilutes: "postEffect.relation.dilutes",
  ambiguous: "postEffect.relation.ambiguous",
  chronology: "postEffect.relation.chronology",
  causality: "postEffect.relation.causality",
  contradiction: "postEffect.relation.contradiction",
};

const RELATION_TITLE_KEY: Record<
  IntentDriftRelation | TimelineRelation,
  string
> = {
  contradicts: "postEffect.relation.tooltip.contradicts",
  absent: "postEffect.relation.tooltip.absent",
  dilutes: "postEffect.relation.tooltip.dilutes",
  ambiguous: "postEffect.relation.tooltip.ambiguous",
  chronology: "postEffect.relation.tooltip.chronology",
  causality: "postEffect.relation.tooltip.causality",
  contradiction: "postEffect.relation.tooltip.contradiction",
};

/**
 * intent_drift の「狙いとのズレ方」/ timeline の「時系列とのズレ方」chip。
 * raw enum でなく表示ラベルで表示。relation 値は両 effect で衝突しないので共用。
 */
export function IntentRelationChip({
  relation,
}: {
  relation: IntentDriftRelation | TimelineRelation;
}) {
  const { t } = useTranslation();
  return (
    <span
      title={t(RELATION_TITLE_KEY[relation])}
      className={cn(
        "inline-flex shrink-0 items-center rounded border border-border/70 bg-muted/40 px-1.5 py-0 text-[10px] text-foreground/80",
      )}
    >
      {t(RELATION_LABEL_KEY[relation])}
    </span>
  );
}

interface TypoContrastRowProps {
  found: string | undefined;
  suggestion: string | undefined;
}

/** typo の 誤→正 対比 1 行。両辺が有意な値のときだけ描画。 */
export function TypoContrastRow({ found, suggestion }: TypoContrastRowProps) {
  const { t } = useTranslation();
  const left = clipValue(found);
  const right = clipValue(suggestion);
  if (!left || !right) return null;
  return (
    <div className="flex items-center gap-1.5 text-[11px] leading-tight">
      <span className="text-muted-foreground">
        {t("postEffect.typoContrast.incorrect")}
      </span>
      <span className="truncate text-foreground/90">{left}</span>
      <ArrowRight size={10} className="shrink-0 text-muted-foreground" />
      <span className="text-muted-foreground">
        {t("postEffect.typoContrast.correct")}
      </span>
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
  const { t } = useTranslation();
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
          <span className="font-medium text-foreground/80">
            {t("postEffect.expanded.reason")}
          </span>
          <span className="leading-snug">{reason}</span>
        </div>
      )}
      {excerpt && (
        <div>
          <span className="font-medium text-foreground/80">
            {t("postEffect.expanded.codexExcerpt")}
          </span>
          <span className="leading-snug">{excerpt}</span>
        </div>
      )}
      {ctx && (
        <div>
          <span className="font-medium text-foreground/80">
            {t("postEffect.expanded.context")}
          </span>
          <span className="leading-snug">{ctx}</span>
        </div>
      )}
      {(parsed.orphaned || staleModel) && (
        <div className="flex flex-wrap items-center gap-1 pt-0.5 text-[10px]">
          {parsed.orphaned && (
            <span
              title={t("postEffect.expanded.orphanedTooltip")}
              className="inline-flex items-center gap-0.5 rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-600 dark:text-amber-400"
            >
              <MapPinOff size={10} /> {t("postEffect.expanded.orphaned")}
            </span>
          )}
          {staleModel && (
            <span
              title={t("postEffect.expanded.staleModelTooltip", {
                currentModel,
              })}
              className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
            >
              {t("postEffect.expanded.detectedBy", {
                model: parsed.detectedByModel,
              })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
