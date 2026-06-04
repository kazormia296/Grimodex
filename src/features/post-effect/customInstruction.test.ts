import { describe, it, expect } from "vitest";
import {
  appendIntentGuidance,
  appendKouetsuGuidance,
  intentScopeSuffix,
  kouetsuScopeSuffix,
  KOUETSU_JSON_DELIMITER,
} from "./customInstruction";
import { JA_POST_EFFECT } from "@/prompts/ja/postEffect";

const ALL_KOUETSU_SYSTEMS: Array<[string, string]> = [
  ["consistency", JA_POST_EFFECT.consistencySystem],
  ["typo", JA_POST_EFFECT.typoSystem],
  ["intra", JA_POST_EFFECT.intraSystem],
  ["review", JA_POST_EFFECT.reviewSystem],
  ["pseudoComment", JA_POST_EFFECT.pseudoCommentSystem],
  ["metaStructure", JA_POST_EFFECT.metaStructureSystem],
  ["intentDrift", JA_POST_EFFECT.intentDriftSystem],
];

describe("appendKouetsuGuidance", () => {
  it("空 custom なら basePrompt と byte-identical (strictEqual)", () => {
    const base = JA_POST_EFFECT.typoSystem;
    expect(appendKouetsuGuidance(base, "")).toBe(base);
    expect(appendKouetsuGuidance(base, "   \n  ")).toBe(base);
  });

  it("非空 custom は JSON 区切り行の前に挿入される (スキーマ指示は末尾に残る)", () => {
    const base = JA_POST_EFFECT.reviewSystem;
    const custom = "戦闘描写の臨場感を重点的に見てください";
    const result = appendKouetsuGuidance(base, custom);

    const customIdx = result.indexOf(custom);
    const delimIdx = result.indexOf(KOUETSU_JSON_DELIMITER);
    expect(customIdx).toBeGreaterThanOrEqual(0);
    expect(delimIdx).toBeGreaterThanOrEqual(0);
    // custom は区切り行より前
    expect(customIdx).toBeLessThan(delimIdx);
    // 区切り行以降 (= JSON スキーマ) は base と完全一致 (改変されない)
    const baseDelimIdx = base.indexOf(KOUETSU_JSON_DELIMITER);
    expect(result.slice(delimIdx)).toBe(base.slice(baseDelimIdx));
  });

  it("区切り行が無い base には追記しない (fail-safe)", () => {
    const base = "No delimiter here. Just freeform text.";
    expect(appendKouetsuGuidance(base, "なにか指示")).toBe(base);
  });

  it("7 校閲プロンプトすべてが区切り行をちょうど1個持つ (回帰防止)", () => {
    for (const [name, prompt] of ALL_KOUETSU_SYSTEMS) {
      const occurrences = prompt.split(KOUETSU_JSON_DELIMITER).length - 1;
      expect(occurrences, `${name} の区切り行出現回数`).toBe(1);
    }
  });

  it("7 校閲プロンプトすべてで非空 custom が安全に挿入される", () => {
    const custom = "テスト用の追加指示";
    for (const [name, prompt] of ALL_KOUETSU_SYSTEMS) {
      const result = appendKouetsuGuidance(prompt, custom);
      expect(result, name).toContain(custom);
      // 区切り行は依然 1 個 (二重挿入や破壊が起きていない)
      const occurrences = result.split(KOUETSU_JSON_DELIMITER).length - 1;
      expect(occurrences, `${name} 挿入後の区切り行`).toBe(1);
      // custom は区切り行の前
      expect(result.indexOf(custom)).toBeLessThan(
        result.indexOf(KOUETSU_JSON_DELIMITER),
      );
    }
  });
});

describe("appendIntentGuidance", () => {
  it("空 intent なら basePrompt と byte-identical", () => {
    const base = JA_POST_EFFECT.intentDriftSystem;
    expect(appendIntentGuidance(base, "")).toBe(base);
    expect(appendIntentGuidance(base, "   \n  ")).toBe(base);
  });

  it("非空 intent は区切り行の前に狙い見出しと本文を挿入し JSON schema は末尾", () => {
    const base = JA_POST_EFFECT.intentDriftSystem;
    const intent = "読者に緊張感を与える";
    const custom = "文体は硬めに";
    const built = appendIntentGuidance(
      appendKouetsuGuidance(base, custom),
      intent,
    );
    expect(built).toContain(intent);
    expect(built).toContain("## 作者の狙い（このシーンで達成したいこと）");
    expect(built).toContain(custom);
    expect(built).toContain("NOT a grader");
    expect(built).toContain(KOUETSU_JSON_DELIMITER);
    const delimIdx = built.indexOf(KOUETSU_JSON_DELIMITER);
    expect(built.indexOf(intent)).toBeLessThan(delimIdx);
    expect(built.indexOf(custom)).toBeLessThan(delimIdx);
    expect(built.slice(delimIdx)).toBe(
      base.slice(base.indexOf(KOUETSU_JSON_DELIMITER)),
    );
  });
});

describe("intentScopeSuffix", () => {
  it("空/空白なら空文字", () => {
    expect(intentScopeSuffix("")).toBe("");
    expect(intentScopeSuffix("  \t ")).toBe("");
  });

  it("非空なら |intent: プレフィックス", () => {
    expect(intentScopeSuffix("狙いA")).toBe("|intent:狙いA");
    expect(intentScopeSuffix("  A   B  ")).toBe("|intent:A B");
  });
});

describe("kouetsuScopeSuffix", () => {
  it("空/空白なら空文字 (scope に何も足さない = 既存ハッシュ不変)", () => {
    expect(kouetsuScopeSuffix("")).toBe("");
    expect(kouetsuScopeSuffix("   \n\t ")).toBe("");
  });

  it("非空なら |custom: プレフィックス付きで正規化テキストを返す", () => {
    expect(kouetsuScopeSuffix("ABC")).toBe("|custom:ABC");
    // normalizeText: 連続スペース→1個 / 前後 trim
    expect(kouetsuScopeSuffix("  A   B  ")).toBe("|custom:A B");
  });

  it("内容が違えば suffix も違う", () => {
    expect(kouetsuScopeSuffix("X")).not.toBe(kouetsuScopeSuffix("Y"));
  });
});
