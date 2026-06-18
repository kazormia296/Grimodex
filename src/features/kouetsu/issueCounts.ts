import type { Diagnostic } from "@/features/lint/types";
import type { PostEffectAnnotation } from "@/features/post-effect/types";
import type { IssuesScope } from "./kouetsuStore";

const TYPO_RULE_ID = "ja/typo-confusable";

export interface IssueCounts {
  linterCount: number;
  typoLintCount: number;
  typoAiCount: number;
  typoCount: number;
  consistencyCount: number;
  impactCount: number;
}

/**
 * Derive the kouetsu Issues panel section counts.
 *
 * The scope→[] gate lives INSIDE this helper: consistency / typo-AI counts
 * only see scene annotations when scope === "current" with a non-null
 * activeSceneId, so the scope-gated semantics are part of the unit under test.
 *
 * typo Lint diagnostics are counted in BOTH linterCount (校正: full Linter
 * panel) and typoCount (誤字脱字): an intentional MVP double-count.
 */
export function deriveIssueCounts({
  diagnostics,
  annotationsByScene,
  scope,
  activeSceneId,
}: {
  diagnostics: Diagnostic[];
  annotationsByScene: Map<string, PostEffectAnnotation[]>;
  scope: IssuesScope;
  activeSceneId: string | null;
}): IssueCounts {
  const sceneAnnotations =
    scope === "current" && activeSceneId
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

  return {
    linterCount,
    typoLintCount,
    typoAiCount,
    typoCount,
    consistencyCount,
    impactCount,
  };
}
