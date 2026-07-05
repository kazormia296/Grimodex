import type { Diagnostic } from "@/features/lint/types";
import type { PostEffectAnnotation } from "@/features/post-effect/types";
import type { KouetsuScope, KouetsuStatusFilter } from "./kouetsuStore";

const TYPO_RULE_ID = "ja/typo-confusable";

/** Task 6 で正直化するまでの後方互換用（旧 IssuesTab の文字列スコープ）。 */
type LegacyScope = "current" | "project" | "ignored";

export interface IssueCounts {
  linterCount: number;
  typoLintCount: number;
  typoAiCount: number;
  typoCount: number;
  consistencyCount: number;
  impactCount: number;
  reviewCount: number;
  intentCount: number;
}

/**
 * Derive the kouetsu Issues 受信箱の観点グループ件数。
 *
 * The scope→[] gate lives INSIDE this helper: 場所軸の annotation 件数は scene
 * スコープ（旧 "current"）かつ activeSceneId 非 null のときだけ見える。dismissed
 * フィルタ時は場所軸の件数を出さない（除外表示中は 0）。
 *
 * scope は KouetsuScope（{type:"scene"}|…）と旧文字列スコープの両方を受け付ける
 * 最小 shim。Task 6 で issueCounts を正直化する際に旧経路は撤去する。
 *
 * typo Lint diagnostics are counted in BOTH linterCount (校正: full Linter
 * panel) and typoCount (誤字脱字): an intentional MVP double-count.
 */
export function deriveIssueCounts({
  diagnostics,
  annotationsByScene,
  scope,
  statusFilter = "open",
  activeSceneId,
}: {
  diagnostics: Diagnostic[];
  annotationsByScene: Map<string, PostEffectAnnotation[]>;
  scope: KouetsuScope | LegacyScope;
  statusFilter?: KouetsuStatusFilter;
  activeSceneId: string | null;
}): IssueCounts {
  const isScene =
    typeof scope === "string" ? scope === "current" : scope.type === "scene";
  const sceneAnnotations =
    isScene && statusFilter !== "dismissed" && activeSceneId
      ? (annotationsByScene.get(activeSceneId) ?? [])
      : [];

  const typoLintCount = diagnostics.filter(
    (d) => d.rule_id === TYPO_RULE_ID,
  ).length;
  const linterCount = diagnostics.length;
  const consistencyCount = sceneAnnotations.filter(
    (a) => a.status === "open" && a.category === "consistency_anchor",
  ).length;
  const typoAiCount = sceneAnnotations.filter(
    (a) => a.status === "open" && a.category === "typo_anchor",
  ).length;
  const typoCount = typoLintCount + typoAiCount;
  const impactCount = sceneAnnotations.filter(
    (a) => a.status === "open" && a.category === "impact_review_anchor",
  ).length;
  const reviewCount = sceneAnnotations.filter(
    (a) => a.status === "open" && a.category === "review",
  ).length;
  const intentCount = sceneAnnotations.filter(
    (a) => a.status === "open" && a.category === "intent_anchor",
  ).length;

  return {
    linterCount,
    typoLintCount,
    typoAiCount,
    typoCount,
    consistencyCount,
    impactCount,
    reviewCount,
    intentCount,
  };
}
