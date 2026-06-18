import { describe, it, expect } from "vitest";
import { parseAnnotationMeta } from "./annotationMeta";
import type { PostEffectAnnotation } from "./types";

/** テスト用の最小 annotation を作る。 */
function ann(
  // metadata は Partial<PostEffectAnnotation> 由来の `string` と intersection
  // すると `string & unknown = string` に再 narrow され object fixture を弾く。
  // Omit してから unknown を足し、object も string も渡せるようにする
  // (本文 30-33 行で string へ正規化している)。
  partial: Omit<Partial<PostEffectAnnotation>, "metadata"> & {
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

  it("category=intent_anchor を intent_drift として解決し relation を拾う", () => {
    const parsed = parseAnnotationMeta(
      ann({
        category: "intent_anchor",
        metadata: {
          llm_reason: "狙いの緊張感が薄い",
          relation: "dilutes",
          found_text: "穏やかに",
        },
      }),
    );
    expect(parsed.kind).toBe("intent_drift");
    expect(parsed.llmReason).toBe("狙いの緊張感が薄い");
    expect(parsed.relation).toBe("dilutes");
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

  it("category=impact_review_anchor を impact として解決し impact_ref を拾う", () => {
    const parsed = parseAnnotationMeta(
      ann({
        category: "impact_review_anchor",
        metadata: {
          impact_ref: {
            entry_id: "e1",
            entry_name: "アリス",
            change_id: "c1",
            change_summary: "年齢: 15 → 17",
            contradiction_score: 0.8,
            found_text: "15歳のアリス",
            found_context: "…15歳のアリスは…",
            confidence: "high",
            // Rust 側は metadata key を llm_reason で書く（契約固定）
            llm_reason: "本文がまだ旧設定の年齢を反映している",
            dismiss_key: "k1",
            detected_by_model: "gpt-4o-mini",
          },
        },
      }),
    );
    expect(parsed.kind).toBe("impact");
    expect(parsed.foundText).toBe("15歳のアリス");
    expect(parsed.llmReason).toBe("本文がまだ旧設定の年齢を反映している");
    expect(parsed.detectedByModel).toBe("gpt-4o-mini");
    expect(parsed.impact?.entryName).toBe("アリス");
    expect(parsed.impact?.changeSummary).toBe("年齢: 15 → 17");
    expect(parsed.impact?.contradictionScore).toBe(0.8);
  });

  it("impact_review_anchor で impact_ref が欠落していても impact (orphaned)", () => {
    const parsed = parseAnnotationMeta(
      ann({ category: "impact_review_anchor", metadata: {} }),
    );
    expect(parsed.kind).toBe("impact");
    expect(parsed.impact).toBeUndefined();
  });
});
