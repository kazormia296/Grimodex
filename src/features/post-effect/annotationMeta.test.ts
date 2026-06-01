import { describe, it, expect } from "vitest";
import { parseAnnotationMeta } from "./annotationMeta";
import type { PostEffectAnnotation } from "./types";

/** テスト用の最小 annotation を作る。 */
function ann(
  partial: Partial<PostEffectAnnotation> & {
    category: string;
    metadata?: unknown;
  },
): PostEffectAnnotation {
  return {
    id: "a1",
    projectId: "p1",
    runId: "r1",
    anchorType: "scene_range",
    sceneId: "s1",
    rangeStart: 0,
    rangeEnd: 0,
    textSnapshot: null,
    persona: null,
    severity: null,
    content: "c",
    authorRole: "ai",
    parentId: null,
    status: "open",
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
    ...partial,
    metadata:
      typeof partial.metadata === "string"
        ? partial.metadata
        : JSON.stringify(partial.metadata ?? {}),
  } as unknown as PostEffectAnnotation;
}

describe("parseAnnotationMeta", () => {
  it("category=review を review として解決する (codex/typo fallthrough より先)", () => {
    const parsed = parseAnnotationMeta(
      ann({
        category: "review",
        metadata: {
          llm_reason: "中盤が冗長",
          found_text: "そして",
          found_context: "…そして…",
          detected_by_model: "gpt-4o-mini",
        },
      }),
    );
    expect(parsed.kind).toBe("review");
    expect(parsed.llmReason).toBe("中盤が冗長");
    expect(parsed.foundText).toBe("そして");
    expect(parsed.detectedByModel).toBe("gpt-4o-mini");
  });

  it("found_text の無い review (scene 全体所見) も review", () => {
    const parsed = parseAnnotationMeta(
      ann({ category: "review", metadata: { llm_reason: "構成の弱さ" } }),
    );
    expect(parsed.kind).toBe("review");
    expect(parsed.foundText).toBeUndefined();
  });

  it("category=pseudo_comment を pseudo_comment として解決し persona を拾う", () => {
    const parsed = parseAnnotationMeta(
      ann({
        category: "pseudo_comment",
        persona: "一般読者",
        metadata: {
          persona: "一般読者",
          found_text: "彼は走った",
          found_context: "…彼は走った…",
        },
      }),
    );
    expect(parsed.kind).toBe("pseudo_comment");
    expect(parsed.persona).toBe("一般読者");
    expect(parsed.foundText).toBe("彼は走った");
  });

  it("metadata 欠損でも category で review/pseudo を判別する", () => {
    expect(
      parseAnnotationMeta(ann({ category: "review", metadata: "" })).kind,
    ).toBe("review");
    expect(
      parseAnnotationMeta(ann({ category: "pseudo_comment", metadata: "" }))
        .kind,
    ).toBe("pseudo_comment");
  });

  it("consistency (codex_ref) / typo (typo_ref) は従来どおり (回帰)", () => {
    const consistency = parseAnnotationMeta(
      ann({
        category: "consistency_anchor",
        metadata: {
          codex_ref: {
            entry_id: "e1",
            entry_name: "田中",
            source_field: "summary",
            llm_reason: "目の色矛盾",
          },
        },
      }),
    );
    expect(consistency.kind).toBe("consistency");
    expect(consistency.codex?.entryName).toBe("田中");

    const typo = parseAnnotationMeta(
      ann({
        category: "typo_anchor",
        metadata: {
          typo_ref: {
            category: "homophone",
            found_text: "以外",
            suggestion: "意外",
            confidence: "high",
            llm_reason: "誤変換",
            dismiss_key: "k",
          },
        },
      }),
    );
    expect(typo.kind).toBe("typo");
    expect(typo.typo?.suggestion).toBe("意外");
  });

  it("category=consistency_anchor で codex_ref も無いものは intra にフォールバック", () => {
    const parsed = parseAnnotationMeta(
      ann({
        category: "consistency_anchor",
        metadata: { llm_reason: "前後で矛盾", found_text: "赤い" },
      }),
    );
    expect(parsed.kind).toBe("intra");
    expect(parsed.llmReason).toBe("前後で矛盾");
  });
});
