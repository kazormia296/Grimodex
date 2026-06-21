import { describe, it, expect } from "vitest";
import {
  appendIntentGuidance,
  appendKouetsuGuidance,
  appendStoryContextGuidance,
  intentScopeSuffix,
  kouetsuScopeSuffix,
  storyContextScopeSuffix,
  findKouetsuDelimiter,
} from "./customInstruction";
import { JA_POST_EFFECT } from "@/prompts/ja/postEffect";

// 校閲プロンプトはロケール別に翻訳される。これらの JA プロンプトが共有する
// 区切り行プレフィックスを検出して使う (本番 append* と同じ検出経路)。
const DELIM = findKouetsuDelimiter(JA_POST_EFFECT.consistencySystem)!;

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
    const delimIdx = result.indexOf(DELIM);
    expect(customIdx).toBeGreaterThanOrEqual(0);
    expect(delimIdx).toBeGreaterThanOrEqual(0);
    // custom は区切り行より前
    expect(customIdx).toBeLessThan(delimIdx);
    // 区切り行以降 (= JSON スキーマ) は base と完全一致 (改変されない)
    const baseDelimIdx = base.indexOf(DELIM);
    expect(result.slice(delimIdx)).toBe(base.slice(baseDelimIdx));
  });

  it("区切り行が無い base には追記しない (fail-safe)", () => {
    const base = "No delimiter here. Just freeform text.";
    expect(appendKouetsuGuidance(base, "なにか指示")).toBe(base);
  });

  it("7 校閲プロンプトすべてが区切り行をちょうど1個持つ (回帰防止)", () => {
    for (const [name, prompt] of ALL_KOUETSU_SYSTEMS) {
      const occurrences = prompt.split(DELIM).length - 1;
      expect(occurrences, `${name} の区切り行出現回数`).toBe(1);
    }
  });

  it("7 校閲プロンプトすべてで非空 custom が安全に挿入される", () => {
    const custom = "テスト用の追加指示";
    for (const [name, prompt] of ALL_KOUETSU_SYSTEMS) {
      const result = appendKouetsuGuidance(prompt, custom);
      expect(result, name).toContain(custom);
      // 区切り行は依然 1 個 (二重挿入や破壊が起きていない)
      const occurrences = result.split(DELIM).length - 1;
      expect(occurrences, `${name} 挿入後の区切り行`).toBe(1);
      // custom は区切り行の前
      expect(result.indexOf(custom)).toBeLessThan(result.indexOf(DELIM));
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
    // 反採点フレーミング (grader↔intent の肝) が翻訳後も残ることを担保する。
    expect(built).toContain("採点者ではありません");
    expect(built).toContain(DELIM);
    const delimIdx = built.indexOf(DELIM);
    expect(built.indexOf(intent)).toBeLessThan(delimIdx);
    expect(built.indexOf(custom)).toBeLessThan(delimIdx);
    expect(built.slice(delimIdx)).toBe(base.slice(base.indexOf(DELIM)));
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

describe("appendStoryContextGuidance", () => {
  it("synopsis/outline とも空なら basePrompt と byte-identical", () => {
    const base = JA_POST_EFFECT.reviewSystem;
    expect(appendStoryContextGuidance(base, {})).toBe(base);
    expect(
      appendStoryContextGuidance(base, { synopsis: "  ", outline: "\n\t" }),
    ).toBe(base);
  });

  it("synopsis を区切り行の前に背景枠として挿入し JSON schema は末尾に残す", () => {
    const base = JA_POST_EFFECT.reviewSystem;
    const synopsis = "主人公が決意を固める転換点";
    const result = appendStoryContextGuidance(base, { synopsis });
    const synIdx = result.indexOf(synopsis);
    const delimIdx = result.indexOf(DELIM);
    expect(synIdx).toBeGreaterThanOrEqual(0);
    expect(delimIdx).toBeGreaterThanOrEqual(0);
    expect(synIdx).toBeLessThan(delimIdx);
    // 区切り行以降 (= JSON スキーマ) は base と完全一致 (改変されない)
    expect(result.slice(delimIdx)).toBe(base.slice(base.indexOf(DELIM)));
  });

  it("枠見出しが『評価指示でない』ことを明示する (rubric 化防止 = 機能の本体)", () => {
    const result = appendStoryContextGuidance(JA_POST_EFFECT.reviewSystem, {
      synopsis: "x",
    });
    // 背景情報であって採点基準ではないと framing で宣言している。
    // この文言は intent_drift（狙い=採点基準）と grader（狙い=背景）を分ける肝。
    expect(result).toContain("評価指示");
  });

  it("outline のみでも挿入される", () => {
    const base = JA_POST_EFFECT.metaStructureSystem;
    const outline = "第3章: 対立の激化";
    const result = appendStoryContextGuidance(base, { outline });
    expect(result).toContain(outline);
    expect(result.indexOf(outline)).toBeLessThan(result.indexOf(DELIM));
  });

  it("synopsis と outline 両方を含める", () => {
    const result = appendStoryContextGuidance(JA_POST_EFFECT.reviewSystem, {
      synopsis: "シーン概要X",
      outline: "章概要Y",
    });
    expect(result).toContain("シーン概要X");
    expect(result).toContain("章概要Y");
  });

  it("区切り行が無い base には追記しない (fail-safe)", () => {
    const base = "No delimiter here. Just freeform text.";
    expect(appendStoryContextGuidance(base, { synopsis: "x" })).toBe(base);
  });

  it("kouetsu custom と共存しても区切り行は1個・両ブロックが前に来る", () => {
    const base = JA_POST_EFFECT.reviewSystem;
    const custom = "戦闘描写の臨場感を重点的に";
    const synopsis = "このシーンの狙いZ";
    const built = appendStoryContextGuidance(
      appendKouetsuGuidance(base, custom),
      {
        synopsis,
      },
    );
    expect(built).toContain(custom);
    expect(built).toContain(synopsis);
    const delimIdx = built.indexOf(DELIM);
    expect(built.indexOf(custom)).toBeLessThan(delimIdx);
    expect(built.indexOf(synopsis)).toBeLessThan(delimIdx);
    // 区切り行は依然ちょうど1個 (二重挿入や破壊が起きていない)
    expect(built.split(DELIM).length - 1).toBe(1);
    // JSON スキーマ部は base と不変
    expect(built.slice(delimIdx)).toBe(base.slice(base.indexOf(DELIM)));
  });

  it("review / meta_structure 両プロンプトで安全に挿入される", () => {
    for (const base of [
      JA_POST_EFFECT.reviewSystem,
      JA_POST_EFFECT.metaStructureSystem,
    ]) {
      const result = appendStoryContextGuidance(base, {
        synopsis: "S",
        outline: "O",
      });
      expect(result).toContain("S");
      expect(result).toContain("O");
      expect(result.split(DELIM).length - 1).toBe(1);
    }
  });
});

describe("storyContextScopeSuffix", () => {
  it("空 ctx なら空文字 (既存ハッシュ不変)", () => {
    expect(storyContextScopeSuffix({})).toBe("");
    expect(storyContextScopeSuffix({ synopsis: "  ", outline: " \t" })).toBe(
      "",
    );
  });

  it("synopsis のみ → |synopsis: のみ (正規化)", () => {
    expect(storyContextScopeSuffix({ synopsis: "  A   B  " })).toBe(
      "|synopsis:A B",
    );
  });

  it("outline のみ → |outline: のみ", () => {
    expect(storyContextScopeSuffix({ outline: "XYZ" })).toBe("|outline:XYZ");
  });

  it("両方 → ラベル付きで連結する", () => {
    expect(storyContextScopeSuffix({ synopsis: "A", outline: "C" })).toBe(
      "|synopsis:A|outline:C",
    );
  });

  it("synopsis と outline の取り違えが起きない (ラベルで分離)", () => {
    expect(storyContextScopeSuffix({ synopsis: "A" })).not.toBe(
      storyContextScopeSuffix({ outline: "A" }),
    );
  });
});
