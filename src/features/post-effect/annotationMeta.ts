import type {
  ConsistencyAnnotationMeta,
  IntraAnnotationMeta,
  PostEffectAnnotation,
  PseudoCommentAnnotationMeta,
  ReviewAnnotationMeta,
  IntentDriftAnnotationMeta,
  TimelineAnnotationMeta,
  TypoAnnotationMeta,
  TypoCategory,
} from "./types";

export interface ParsedAnnotationMeta {
  /**
   * typo (typo_ref あり) / consistency (codex_ref あり) / review / pseudo_comment
   * （category で判定）/ intra_scene (fallback)
   */
  kind:
    | "consistency"
    | "intra"
    | "typo"
    | "review"
    | "intent_drift"
    | "timeline"
    | "pseudo_comment";
  orphaned: boolean;
  detectedByModel?: string;
  llmReason?: string;
  confidence?: "high" | "medium" | "low";
  foundText?: string;
  foundContext?: string;
  /** pseudo_comment only — ペルソナ名 */
  persona?: string;
  /** intent_drift / timeline only */
  relation?:
    | IntentDriftAnnotationMeta["relation"]
    | TimelineAnnotationMeta["relation"];
  /** consistency only */
  codex?: {
    entryId: string;
    entryName: string;
    sourceField: "summary" | "content" | "detail";
    sourceExcerpt?: string;
    detailName?: string;
    expectedValue?: string;
    foundValue?: string;
  };
  /** typo only */
  typo?: {
    category: TypoCategory;
    suggestion: string;
  };
}

function safeParseMetadata(
  ann: PostEffectAnnotation,
): Record<string, unknown> | undefined {
  try {
    if (typeof ann.metadata === "string") {
      return JSON.parse(ann.metadata) as Record<string, unknown>;
    }
    return ann.metadata as Record<string, unknown> | undefined;
  } catch {
    return undefined;
  }
}

export function parseAnnotationMeta(
  ann: PostEffectAnnotation,
): ParsedAnnotationMeta {
  const meta = safeParseMetadata(ann);
  if (!meta) {
    // metadata 無しでも category で review / pseudo_comment は判別する
    if (ann.category === "review") return { kind: "review", orphaned: false };
    if (ann.category === "intent_anchor")
      return { kind: "intent_drift", orphaned: false };
    if (ann.category === "timeline_anchor")
      return { kind: "timeline", orphaned: false };
    if (ann.category === "pseudo_comment")
      return { kind: "pseudo_comment", orphaned: false };
    return { kind: "intra", orphaned: false };
  }

  const orphaned = meta.orphaned === true;

  // review / pseudo_comment は category で判定 (codex_ref / typo_ref を持たない)
  if (ann.category === "review") {
    const r = meta as Partial<ReviewAnnotationMeta>;
    return {
      kind: "review",
      orphaned,
      detectedByModel: r.detected_by_model,
      llmReason: r.llm_reason,
      foundText: r.found_text,
      foundContext: r.found_context,
    };
  }
  if (ann.category === "intent_anchor") {
    const r = meta as Partial<IntentDriftAnnotationMeta>;
    return {
      kind: "intent_drift",
      orphaned,
      detectedByModel: r.detected_by_model,
      llmReason: r.llm_reason,
      relation: r.relation,
      foundText: r.found_text,
      foundContext: r.found_context,
    };
  }
  if (ann.category === "timeline_anchor") {
    const r = meta as Partial<TimelineAnnotationMeta>;
    return {
      kind: "timeline",
      orphaned,
      detectedByModel: r.detected_by_model,
      llmReason: r.llm_reason,
      relation: r.relation,
      foundText: r.found_text,
      foundContext: r.found_context,
    };
  }
  if (ann.category === "pseudo_comment") {
    const p = meta as Partial<PseudoCommentAnnotationMeta>;
    return {
      kind: "pseudo_comment",
      orphaned,
      detectedByModel: p.detected_by_model,
      foundText: p.found_text,
      foundContext: p.found_context,
      persona: p.persona,
    };
  }

  const typoRef = meta.typo_ref as TypoAnnotationMeta["typo_ref"] | undefined;
  if (typoRef && typeof typoRef === "object" && typoRef.found_text) {
    return {
      kind: "typo",
      orphaned,
      detectedByModel: typoRef.detected_by_model,
      llmReason: typoRef.llm_reason,
      confidence: typoRef.confidence,
      foundText: typoRef.found_text,
      foundContext: typoRef.found_context,
      typo: {
        category: typoRef.category,
        suggestion: typoRef.suggestion,
      },
    };
  }

  const ref = meta.codex_ref as
    | ConsistencyAnnotationMeta["codex_ref"]
    | undefined;

  if (ref && typeof ref === "object" && ref.entry_id) {
    return {
      kind: "consistency",
      orphaned,
      detectedByModel: ref.detected_by_model,
      llmReason: ref.llm_reason,
      confidence: ref.confidence,
      foundText: ref.found_text,
      foundContext: ref.found_context,
      codex: {
        entryId: ref.entry_id,
        entryName: ref.entry_name,
        sourceField: ref.source_field,
        sourceExcerpt: ref.source_excerpt,
        detailName: ref.detail_name,
        expectedValue: ref.expected_value,
        foundValue: ref.found_value,
      },
    };
  }

  const intra = meta as Partial<IntraAnnotationMeta>;
  return {
    kind: "intra",
    orphaned,
    detectedByModel: intra.detected_by_model,
    llmReason: intra.llm_reason,
    confidence: intra.confidence,
    foundText: intra.found_text,
    foundContext: intra.found_context,
  };
}

/**
 * `田中 ▸ 年齢` (detail), `田中 ▸ サマリ` (summary), `田中` (content) のような
 * chip ラベル。consistency 専用。
 */
export function codexChipLabel(codex: ParsedAnnotationMeta["codex"]): string {
  if (!codex) return "";
  if (codex.detailName) return `${codex.entryName} ▸ ${codex.detailName}`;
  if (codex.sourceField === "summary") return `${codex.entryName} ▸ サマリ`;
  return codex.entryName;
}

/** 60字でカット (末尾 …)。空文字は null。 */
export function clipValue(v: string | undefined, max = 60): string | null {
  if (!v) return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}
