import { describe, expect, it } from "vitest";
import type {
  PostEffectAnnotation,
  PostEffectCategory,
} from "@/features/post-effect/types";
import {
  isManualDismiss,
  selectManuallyDismissed,
} from "./dismissedAnnotations";

function makeAnn(
  category: PostEffectCategory,
  metadata: unknown,
): PostEffectAnnotation {
  return { category, metadata } as unknown as PostEffectAnnotation;
}

describe("selectManuallyDismissed", () => {
  it("returns only annotations matching the requested category", () => {
    const anns = [
      makeAnn("consistency_anchor", { dismiss_source: "manual" }),
      makeAnn("typo_anchor", { dismiss_source: "manual" }),
      makeAnn("review", { dismiss_source: "manual" }),
      makeAnn("pseudo_comment", { dismiss_source: "manual" }),
    ];
    expect(
      selectManuallyDismissed(anns, "typo_anchor").map((a) => a.category),
    ).toEqual(["typo_anchor"]);
    expect(
      selectManuallyDismissed(anns, "review").map((a) => a.category),
    ).toEqual(["review"]);
  });

  it("excludes non-manual dismisses even when the category matches", () => {
    const anns = [
      makeAnn("review", { dismiss_source: "manual" }),
      makeAnn("review", { dismiss_source: "cascade" }),
      makeAnn("review", { dismiss_source: "run_completed" }),
      makeAnn("review", {}),
    ];
    expect(selectManuallyDismissed(anns, "review")).toHaveLength(1);
  });

  it("regression: 各セクションが category で分離され byte 同一の全件にならない", () => {
    // category を渡さず全件を出すと整合性・誤字脱字が同一リストになっていた回帰を gate する。
    const anns = [
      makeAnn("consistency_anchor", { dismiss_source: "manual" }),
      makeAnn("consistency_anchor", { dismiss_source: "manual" }),
      makeAnn("typo_anchor", { dismiss_source: "manual" }),
    ];
    expect(selectManuallyDismissed(anns, "consistency_anchor")).toHaveLength(2);
    expect(selectManuallyDismissed(anns, "typo_anchor")).toHaveLength(1);
  });
});

describe("isManualDismiss", () => {
  it("reads top-level dismiss_source from an object metadata", () => {
    expect(
      isManualDismiss(makeAnn("typo_anchor", { dismiss_source: "manual" })),
    ).toBe(true);
    expect(
      isManualDismiss(makeAnn("typo_anchor", { dismiss_source: "cascade" })),
    ).toBe(false);
    expect(isManualDismiss(makeAnn("typo_anchor", {}))).toBe(false);
  });

  it("parses metadata when supplied as a JSON string", () => {
    expect(
      isManualDismiss(
        makeAnn("typo_anchor", JSON.stringify({ dismiss_source: "manual" })),
      ),
    ).toBe(true);
  });

  it("regression: codex_ref を持つ整合性でも top-level の manual を拾う", () => {
    // Rust は dismiss_source を top-level に書く。整合性 annotation は codex_ref を
    // 持つが、旧実装は codex_ref 下だけを見て top-level の manual を取りこぼし、
    // 整合性の除外ビューが常に空になっていた。top-level を権威として拾うこと。
    expect(
      isManualDismiss(
        makeAnn("consistency_anchor", {
          dismiss_source: "manual",
          codex_ref: { detected_by_model: "gpt-4o" },
        }),
      ),
    ).toBe(true);
    // top-level が cascade (= 手動でない) なら、codex_ref に manual が無い限り false。
    expect(
      isManualDismiss(
        makeAnn("consistency_anchor", {
          dismiss_source: "cascade",
          codex_ref: { detected_by_model: "gpt-4o" },
        }),
      ),
    ).toBe(false);
  });

  it("codex_ref 下の legacy な manual も許容する", () => {
    expect(
      isManualDismiss(
        makeAnn("consistency_anchor", {
          codex_ref: { dismiss_source: "manual" },
        }),
      ),
    ).toBe(true);
  });

  it("returns false on malformed or null metadata", () => {
    expect(isManualDismiss(makeAnn("typo_anchor", "not-json{"))).toBe(false);
    expect(isManualDismiss(makeAnn("typo_anchor", null))).toBe(false);
  });
});
