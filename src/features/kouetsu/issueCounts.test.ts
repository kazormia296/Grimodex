import { describe, expect, it } from "vitest";
import type { Diagnostic } from "@/features/lint/types";
import type { PostEffectAnnotation } from "@/features/post-effect/types";
import { deriveIssueCounts } from "./issueCounts";

const TYPO_RULE_ID = "ja/typo-confusable";

function diag(rule_id: string): Diagnostic {
  return { rule_id } as unknown as Diagnostic;
}

function ann(status: string, category: string): PostEffectAnnotation {
  return { status, category } as unknown as PostEffectAnnotation;
}

function mapOf(
  sceneId: string,
  anns: PostEffectAnnotation[],
): Map<string, PostEffectAnnotation[]> {
  return new Map([[sceneId, anns]]);
}

describe("deriveIssueCounts", () => {
  it("typo lint 診断は typoCount に含めない（二重計上廃止）", () => {
    const diagnostics = [diag(TYPO_RULE_ID), diag("ja/other-rule")];
    const openTypoAnn = ann("open", "typo_anchor");
    const counts = deriveIssueCounts({
      diagnostics,
      annotationsByScene: mapOf("s1", [openTypoAnn]),
      scope: { type: "scene" },
      statusFilter: "open",
      activeSceneId: "s1",
    });
    // linterCount is the total lint diagnostics (校正は全 lint 診断)
    expect(counts.linterCount).toBe(2);
    // typoCount is AI typo_anchor annotations only — no lint double-count
    expect(counts.typoCount).toBe(1);
  });

  it("scene 以外のスコープでは全カウントが null（0 固定の嘘バッジ禁止）", () => {
    const anns = [ann("open", "typo_anchor")];
    const counts = deriveIssueCounts({
      diagnostics: [diag(TYPO_RULE_ID)],
      annotationsByScene: mapOf("s1", anns),
      scope: { type: "project" },
      statusFilter: "open",
      activeSceneId: "s1",
    });
    expect(counts.linterCount).toBeNull();
    expect(counts.typoCount).toBeNull();
    expect(counts.consistencyCount).toBeNull();
    expect(counts.impactCount).toBeNull();
    expect(counts.reviewCount).toBeNull();
    expect(counts.intentCount).toBeNull();
  });

  it("folder スコープでも全カウントが null", () => {
    const counts = deriveIssueCounts({
      diagnostics: [diag(TYPO_RULE_ID)],
      annotationsByScene: new Map(),
      scope: { type: "folder", anchorId: "f1" },
      statusFilter: "open",
      activeSceneId: "s1",
    });
    expect(counts.linterCount).toBeNull();
  });

  it("statusFilter=dismissed では全カウント null", () => {
    const counts = deriveIssueCounts({
      diagnostics: [],
      annotationsByScene: new Map(),
      scope: { type: "scene" },
      statusFilter: "dismissed",
      activeSceneId: "s1",
    });
    expect(counts.consistencyCount).toBeNull();
    expect(counts.linterCount).toBeNull();
    expect(counts.typoCount).toBeNull();
    expect(counts.impactCount).toBeNull();
    expect(counts.reviewCount).toBeNull();
    expect(counts.intentCount).toBeNull();
  });

  it("scene スコープでも activeSceneId が null なら全カウント null", () => {
    const anns = [ann("open", "consistency_anchor")];
    const counts = deriveIssueCounts({
      diagnostics: [],
      annotationsByScene: mapOf("s1", anns),
      scope: { type: "scene" },
      statusFilter: "open",
      activeSceneId: null,
    });
    expect(counts.consistencyCount).toBeNull();
  });

  it("consistencyCount counts only open consistency_anchor annotations", () => {
    const anns = [
      ann("open", "consistency_anchor"),
      ann("open", "consistency_anchor"),
      ann("dismissed", "consistency_anchor"), // wrong status
      ann("open", "typo_anchor"), // wrong category
    ];
    const counts = deriveIssueCounts({
      diagnostics: [],
      annotationsByScene: mapOf("s1", anns),
      scope: { type: "scene" },
      statusFilter: "open",
      activeSceneId: "s1",
    });
    expect(counts.consistencyCount).toBe(2);
  });

  it("typoCount counts only open typo_anchor annotations", () => {
    const anns = [
      ann("open", "typo_anchor"),
      ann("dismissed", "typo_anchor"), // wrong status
      ann("open", "consistency_anchor"), // wrong category
    ];
    const counts = deriveIssueCounts({
      diagnostics: [diag(TYPO_RULE_ID)],
      annotationsByScene: mapOf("s1", anns),
      scope: { type: "scene" },
      statusFilter: "open",
      activeSceneId: "s1",
    });
    expect(counts.typoCount).toBe(1);
    expect(counts.linterCount).toBe(1);
  });

  it("impactCount counts only open impact_review_anchor annotations", () => {
    const anns = [
      ann("open", "impact_review_anchor"),
      ann("open", "impact_review_anchor"),
      ann("dismissed", "impact_review_anchor"), // wrong status
      ann("open", "consistency_anchor"), // wrong category
    ];
    const counts = deriveIssueCounts({
      diagnostics: [],
      annotationsByScene: mapOf("s1", anns),
      scope: { type: "scene" },
      statusFilter: "open",
      activeSceneId: "s1",
    });
    expect(counts.impactCount).toBe(2);
    expect(counts.consistencyCount).toBe(1);
  });

  it("review / intent もカウントされる（旧 EditorialTab のインライン計数を吸収）", () => {
    const openReviewAnn = ann("open", "review");
    const openIntentAnn = ann("open", "intent_anchor");
    const counts = deriveIssueCounts({
      diagnostics: [],
      annotationsByScene: mapOf("s1", [openReviewAnn, openIntentAnn]),
      scope: { type: "scene" },
      statusFilter: "open",
      activeSceneId: "s1",
    });
    expect(counts.reviewCount).toBe(1);
    expect(counts.intentCount).toBe(1);
  });
});
