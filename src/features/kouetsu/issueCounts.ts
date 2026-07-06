import type { Diagnostic } from "@/features/lint/types";
import type { PostEffectAnnotation } from "@/features/post-effect/types";
import type { KouetsuScope, KouetsuStatusFilter } from "./kouetsuStore";

export interface IssueCounts {
  linterCount: number | null;
  typoCount: number | null;
  consistencyCount: number | null;
  impactCount: number | null;
  reviewCount: number | null;
  intentCount: number | null;
}

/**
 * 受信箱グループのバッジ件数。不変条件: バッジは「いま表示されている件数」に
 * 一致する実数のみ。scene スコープ + open フィルタ以外では件数を知らないので
 * null（バッジ非表示）を返す — 0 固定の嘘バッジ（旧実装）を出さない。
 * typo lint は校正(linterCount)のみに計上（旧 MVP の意図的二重計上を廃止）。
 */
export function deriveIssueCounts({
  diagnostics,
  annotationsByScene,
  scope,
  statusFilter,
  activeSceneId,
}: {
  diagnostics: Diagnostic[];
  annotationsByScene: Map<string, PostEffectAnnotation[]>;
  scope: KouetsuScope;
  statusFilter: KouetsuStatusFilter;
  activeSceneId: string | null;
}): IssueCounts {
  const NONE: IssueCounts = {
    linterCount: null,
    typoCount: null,
    consistencyCount: null,
    impactCount: null,
    reviewCount: null,
    intentCount: null,
  };
  if (scope.type !== "scene" || statusFilter !== "open" || !activeSceneId) {
    return NONE;
  }
  const anns = annotationsByScene.get(activeSceneId) ?? [];
  const openOf = (category: string) =>
    anns.filter((a) => a.status === "open" && a.category === category).length;
  return {
    linterCount: diagnostics.length,
    typoCount: openOf("typo_anchor"),
    consistencyCount: openOf("consistency_anchor"),
    impactCount: openOf("impact_review_anchor"),
    reviewCount: openOf("review"),
    intentCount: openOf("intent_anchor"),
  };
}
