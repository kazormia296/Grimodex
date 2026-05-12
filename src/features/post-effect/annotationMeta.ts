import type {
  ConsistencyAnnotationMeta,
  IntraAnnotationMeta,
  PostEffectAnnotation,
} from "./types";

export interface ParsedAnnotationMeta {
  /** consistency (codex_ref あり) or intra_scene (codex_ref なし) */
  kind: "consistency" | "intra";
  orphaned: boolean;
  detectedByModel?: string;
  llmReason?: string;
  confidence?: "high" | "medium" | "low";
  foundText?: string;
  foundContext?: string;
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
  if (!meta) return { kind: "intra", orphaned: false };

  const ref = meta.codex_ref as
    | ConsistencyAnnotationMeta["codex_ref"]
    | undefined;
  const orphaned = meta.orphaned === true;

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
