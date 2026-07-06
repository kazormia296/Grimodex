import type {
  Diagnostic,
  Severity as LintSeverity,
} from "@/features/lint/types";
import {
  parseAnnotationMeta,
  type ParsedAnnotationMeta,
} from "@/features/post-effect/annotationMeta";
import type {
  PostEffectAnnotation,
  PostEffectCategory,
  PostEffectSeverity,
  SceneLensRecord,
  TypoCategory,
} from "@/features/post-effect/types";

// ---------------------------------------------------------------------------
// 統合トリアージの issue モデル（純関数のみ、store 参照なし）
// 設計書: docs/superpowers/specs/2026-07-06-kouetsu-triage-refine-design.md
// ---------------------------------------------------------------------------

export type IssueCat =
  | "linter"
  | "typo"
  | "consistency"
  | "impact"
  | "review"
  | "intent"
  | "meta"
  | "timeline";

export type IssueSev = "high" | "mid" | "low";

/**
 * 行のメタ表示（rule_id / codex chip / typo カテゴリ / relation / lensType /
 * 変更対象エントリ名）。i18n をモデルに持ち込まないため、ラベル文字列ではなく
 * 構造化した値を保持し、表示ラベルは UI 側で付与する。
 */
export type IssueMeta =
  | { kind: "rule"; ruleId: string }
  | { kind: "codex"; codex: NonNullable<ParsedAnnotationMeta["codex"]> }
  | { kind: "typo"; category: TypoCategory }
  | { kind: "relation"; relation: string }
  | { kind: "lens"; lensType: SceneLensRecord["lensType"] }
  | { kind: "impact"; entryName: string }
  | null;

export interface UnifiedIssue {
  /** "ann:<annId>" | "lint:<sceneId>:<i>:<ruleId>" | "lens:<recordId>" */
  id: string;
  cat: IssueCat;
  sev: IssueSev;
  /** timeline 等 scene 不定は null */
  sceneId: string | null;
  /** annotation.content / diagnostic.message / lens.finding */
  title: string;
  meta: IssueMeta;
  excerpt: { pre: string; mark: string; post: string } | null;
  /** textSnapshot / found_context */
  quote: string | null;
  /** ラベルは UI 側で i18n 付与（モデルは値のみ保持） */
  compare: {
    leftLabel: string;
    left: string;
    rightLabel: string;
    right: string;
  } | null;
  /** typo のみ */
  suggest: { found: string; suggestion: string } | null;
  /** typo(suggestion あり) / lint(fix あり) */
  fixable: boolean;
  confidence: "high" | "medium" | "low" | null;
  createdAt: string | null;
  source:
    | {
        kind: "annotation";
        ann: PostEffectAnnotation;
        parsed: ParsedAnnotationMeta;
      }
    | { kind: "lint"; sceneId: string; diag: Diagnostic }
    | { kind: "lens"; record: SceneLensRecord };
}

/**
 * annotation category → 観点。pseudo_comment / foreshadow_anchor / theme_anchor
 * は受信箱の対象外（undefined）。
 */
export const ANNOTATION_CATEGORY_TO_CAT: Partial<
  Record<PostEffectCategory, IssueCat>
> = {
  typo_anchor: "typo",
  consistency_anchor: "consistency",
  review: "review",
  intent_anchor: "intent",
  timeline_anchor: "timeline",
  impact_review_anchor: "impact",
};

// ---------------------------------------------------------------------------
// severity 写像（単一の正）
// ---------------------------------------------------------------------------

/** annotation.severity: error→high / warning→mid / suggestion・info・null→low */
export function sevOfAnnotation(severity: string | null | undefined): IssueSev {
  if (severity === "error") return "high";
  if (severity === "warning") return "mid";
  return "low";
}

/** lint Diagnostic.severity: error→high / warning→mid / info→low */
export function sevOfLint(severity: LintSeverity): IssueSev {
  if (severity === "error") return "high";
  if (severity === "warning") return "mid";
  return "low";
}

/** SceneLensRecord.severity: annotation と同じ写像 */
export function sevOfLens(severity: PostEffectSeverity): IssueSev {
  return sevOfAnnotation(severity);
}

// ---------------------------------------------------------------------------
// アダプタ
// ---------------------------------------------------------------------------

/**
 * foundContext を foundText の最初の一致で {pre, mark, post} に分割する。
 * 不一致・欠落なら excerpt=null とし、quote は foundContext を優先
 * （分割に失敗した文脈をそのまま引用として見せる）。成功時の quote は
 * textSnapshot を優先する。
 */
function buildExcerptAndQuote(
  parsed: ParsedAnnotationMeta,
  textSnapshot: string | null,
): { excerpt: UnifiedIssue["excerpt"]; quote: string | null } {
  const { foundContext, foundText } = parsed;
  if (foundContext && foundText) {
    const idx = foundContext.indexOf(foundText);
    if (idx !== -1) {
      return {
        excerpt: {
          pre: foundContext.slice(0, idx),
          mark: foundText,
          post: foundContext.slice(idx + foundText.length),
        },
        quote: textSnapshot ?? foundContext,
      };
    }
  }
  return { excerpt: null, quote: foundContext ?? textSnapshot ?? null };
}

function buildCompare(
  cat: IssueCat,
  parsed: ParsedAnnotationMeta,
): UnifiedIssue["compare"] {
  if (cat === "consistency") {
    const codex = parsed.codex;
    if (codex?.expectedValue && codex.foundValue) {
      return {
        leftLabel: "",
        left: codex.expectedValue,
        rightLabel: "",
        right: codex.foundValue,
      };
    }
    return null;
  }
  if (cat === "impact") {
    const impact = parsed.impact;
    if (impact?.changeSummary && parsed.foundText) {
      return {
        leftLabel: "",
        left: impact.changeSummary,
        rightLabel: "",
        right: parsed.foundText,
      };
    }
    return null;
  }
  return null;
}

function buildAnnotationMeta(
  cat: IssueCat,
  parsed: ParsedAnnotationMeta,
): IssueMeta {
  switch (cat) {
    case "consistency":
      return parsed.codex ? { kind: "codex", codex: parsed.codex } : null;
    case "typo":
      return parsed.typo
        ? { kind: "typo", category: parsed.typo.category }
        : null;
    case "intent":
    case "timeline":
      return parsed.relation
        ? { kind: "relation", relation: parsed.relation }
        : null;
    case "impact":
      return parsed.impact
        ? { kind: "impact", entryName: parsed.impact.entryName }
        : null;
    default:
      // review はメタ表示なし
      return null;
  }
}

/**
 * annotation → UnifiedIssue。対象外 category（pseudo_comment /
 * foreshadow_anchor / theme_anchor）は null（受信箱に出さない）。
 */
export function fromAnnotation(ann: PostEffectAnnotation): UnifiedIssue | null {
  const cat = ANNOTATION_CATEGORY_TO_CAT[ann.category as PostEffectCategory];
  if (!cat) return null;
  const parsed = parseAnnotationMeta(ann);

  const { excerpt, quote } = buildExcerptAndQuote(parsed, ann.textSnapshot);
  const suggest =
    cat === "typo" && parsed.typo?.suggestion
      ? { found: parsed.foundText ?? "", suggestion: parsed.typo.suggestion }
      : null;

  return {
    id: `ann:${ann.id}`,
    cat,
    sev: sevOfAnnotation(ann.severity),
    sceneId: ann.sceneId,
    title: ann.content,
    meta: buildAnnotationMeta(cat, parsed),
    excerpt,
    quote,
    compare: buildCompare(cat, parsed),
    suggest,
    fixable: suggest !== null,
    confidence: parsed.confidence ?? null,
    createdAt: ann.createdAt,
    source: { kind: "annotation", ann, parsed },
  };
}

/** lint Diagnostic → UnifiedIssue（常に行になる）。 */
export function fromLintDiagnostic(
  sceneId: string,
  index: number,
  diag: Diagnostic,
): UnifiedIssue {
  return {
    id: `lint:${sceneId}:${index}:${diag.rule_id}`,
    cat: "linter",
    sev: sevOfLint(diag.severity),
    sceneId,
    title: diag.message,
    meta: { kind: "rule", ruleId: diag.rule_id },
    excerpt: null,
    quote: null,
    compare: null,
    suggest: null,
    fixable: !!diag.fix,
    confidence: null,
    createdAt: null,
    source: { kind: "lint", sceneId, diag },
  };
}

/**
 * SceneLensRecord → UnifiedIssue。finding が null / 空のレコードは行にしない。
 * annotation ではないため解決/無視/Fix 不可（fixable=false）。
 */
export function fromSceneLens(record: SceneLensRecord): UnifiedIssue | null {
  const finding = record.finding;
  if (!finding || finding.trim() === "") return null;
  return {
    id: `lens:${record.id}`,
    cat: "meta",
    sev: sevOfLens(record.severity),
    sceneId: record.targetId,
    title: finding,
    meta: { kind: "lens", lensType: record.lensType },
    excerpt: null,
    quote: null,
    compare: null,
    suggest: null,
    fixable: false,
    confidence: null,
    createdAt: record.createdAt,
    source: { kind: "lens", record },
  };
}

// ---------------------------------------------------------------------------
// ソート・グルーピング・件数
// ---------------------------------------------------------------------------

const SEV_RANK: Record<IssueSev, number> = { high: 0, mid: 1, low: 2 };

/**
 * sev（high→mid→low）→ createdAt 降順（null は最後）→ id 昇順の安定ソート。
 * 非破壊（入力配列は変更しない）。
 */
export function sortIssues(issues: UnifiedIssue[]): UnifiedIssue[] {
  return [...issues].sort((a, b) => {
    const sevDiff = SEV_RANK[a.sev] - SEV_RANK[b.sev];
    if (sevDiff !== 0) return sevDiff;
    if (a.createdAt !== b.createdAt) {
      if (a.createdAt === null) return 1;
      if (b.createdAt === null) return -1;
      return a.createdAt < b.createdAt ? 1 : -1;
    }
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });
}

/** 観点の固定表示順。 */
export const CAT_ORDER: readonly IssueCat[] = [
  "linter",
  "typo",
  "consistency",
  "impact",
  "review",
  "intent",
  "meta",
  "timeline",
];

/**
 * CAT_ORDER 順のグループ化。空の観点は含めない。各 items は入力順のまま
 * （ソート済みリストを渡す前提）。
 */
export function groupByCat(
  issues: UnifiedIssue[],
): Array<{ cat: IssueCat; items: UnifiedIssue[] }> {
  const byCat = new Map<IssueCat, UnifiedIssue[]>();
  for (const issue of issues) {
    const list = byCat.get(issue.cat);
    if (list) list.push(issue);
    else byCat.set(issue.cat, [issue]);
  }
  const groups: Array<{ cat: IssueCat; items: UnifiedIssue[] }> = [];
  for (const cat of CAT_ORDER) {
    const items = byCat.get(cat);
    if (items && items.length > 0) groups.push({ cat, items });
  }
  return groups;
}

export interface SevCounts {
  high: number;
  mid: number;
  low: number;
}

/** 重大度分布（SummaryStage のバー・ヘッダ pill 用）。 */
export function deriveSevCounts(issues: UnifiedIssue[]): SevCounts {
  const counts: SevCounts = { high: 0, mid: 0, low: 0 };
  for (const issue of issues) counts[issue.sev] += 1;
  return counts;
}

/**
 * トリアージの「次へ」遷移。order は現リストの表示順 id 列（id を含む）。
 * id の次以降 → 先頭から id 手前、の巡回順で最初の候補を返す。
 *
 * - removed=true（解決/無視/Fix で現項目がリストから消える）: 残候補の先頭、
 *   無ければ null（選択解除）。
 * - removed=false（あとで）: 同じ探索だが自分には戻らない — 自分以外に候補が
 *   無ければ null（選択解除）。
 *
 * 純関数・ステータス参照なし。id が order に無い場合は null。
 */
export function advanceFrom(
  order: string[],
  id: string,
  removed: boolean,
): string | null {
  const idx = order.indexOf(id);
  if (idx === -1) return null;
  const candidates = [...order.slice(idx + 1), ...order.slice(0, idx)];
  if (removed) {
    return candidates[0] ?? null;
  }
  return candidates.find((candidateId) => candidateId !== id) ?? null;
}
