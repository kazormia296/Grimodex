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

  it("prefers codex_ref.dismiss_source when codex_ref is present", () => {
    // 整合性 annotation は codex 参照を codex_ref に畳むため、ネスト下を優先して見る。
    expect(
      isManualDismiss(
        makeAnn("consistency_anchor", {
          codex_ref: { dismiss_source: "manual" },
        }),
      ),
    ).toBe(true);
    // codex_ref 下が manual でなければ top-level の manual は無視される (precedence 仕様)。
    expect(
      isManualDismiss(
        makeAnn("consistency_anchor", {
          dismiss_source: "manual",
          codex_ref: { dismiss_source: "cascade" },
        }),
      ),
    ).toBe(false);
  });

  it("returns false on malformed or null metadata", () => {
    expect(isManualDismiss(makeAnn("typo_anchor", "not-json{"))).toBe(false);
    expect(isManualDismiss(makeAnn("typo_anchor", null))).toBe(false);
  });
});
