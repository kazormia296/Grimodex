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
  it("typo Lint diagnostics are double-counted in linterCount and typoCount", () => {
    const diagnostics = [
      diag(TYPO_RULE_ID),
      diag(TYPO_RULE_ID),
      diag("ja/other-rule"),
    ];
    const counts = deriveIssueCounts({
      diagnostics,
      annotationsByScene: new Map(),
      scope: "current",
      activeSceneId: "s1",
    });
    // linterCount is the total diagnostics (typo Lint included)
    expect(counts.linterCount).toBe(3);
    // typoLintCount counts only the typo-confusable rule
    expect(counts.typoLintCount).toBe(2);
    // typoCount includes the same typo Lint diagnostics (MVP double-count)
    expect(counts.typoCount).toBe(2);
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
      scope: "current",
      activeSceneId: "s1",
    });
    expect(counts.consistencyCount).toBe(2);
  });

  it("typoAiCount counts only open typo_anchor annotations", () => {
    const anns = [
      ann("open", "typo_anchor"),
      ann("dismissed", "typo_anchor"), // wrong status
      ann("open", "consistency_anchor"), // wrong category
    ];
    const counts = deriveIssueCounts({
      diagnostics: [diag(TYPO_RULE_ID)],
      annotationsByScene: mapOf("s1", anns),
      scope: "current",
      activeSceneId: "s1",
    });
    expect(counts.typoAiCount).toBe(1);
    // typoCount = typoLintCount (1) + typoAiCount (1)
    expect(counts.typoCount).toBe(2);
  });

  it("scope gate: non-current scope yields 0 consistency even with scene data (RED target)", () => {
    const anns = [
      ann("open", "consistency_anchor"),
      ann("open", "consistency_anchor"),
    ];
    const counts = deriveIssueCounts({
      diagnostics: [],
      annotationsByScene: mapOf("s1", anns),
      scope: "project", // non-current → gate forces []
      activeSceneId: "s1", // non-null, so only the scope gate suppresses it
    });
    expect(counts.consistencyCount).toBe(0);
    expect(counts.typoAiCount).toBe(0);
  });

  it("scope gate: current scope with null activeSceneId yields 0 consistency", () => {
    const anns = [ann("open", "consistency_anchor")];
    const counts = deriveIssueCounts({
      diagnostics: [],
      annotationsByScene: mapOf("s1", anns),
      scope: "current",
      activeSceneId: null,
    });
    expect(counts.consistencyCount).toBe(0);
  });

  it("current scope with matching activeSceneId surfaces the consistency count", () => {
    const anns = [ann("open", "consistency_anchor")];
    const counts = deriveIssueCounts({
      diagnostics: [],
      annotationsByScene: mapOf("s1", anns),
      scope: "current",
      activeSceneId: "s1",
    });
    expect(counts.consistencyCount).toBe(1);
  });
});
