import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  trimToFit,
  countTokens,
  type SceneContext,
  type CodexContext,
  type TrimInput,
} from "./contextBuilder";

// セクションヘッダの文言そのものはカタログ (prompts/ja/chatSystem.ts) が正本。
// テストはアンカー部分文字列のみに依存させる。
const RECALL_ANCHOR = "関連する過去シーン";

const scene: SceneContext = {
  id: "scene-current",
  title: "現在のシーン",
  content: "太郎は窓の外を見つめていた。",
};

const recall = [
  { sceneTitle: "第一章 嵐の夜", chunkText: "海は荒れ、舟は軋んでいた。" },
  { sceneTitle: "第三章 再会", chunkText: "彼女は無言で頷いた。" },
];

describe("buildSystemPrompt semanticRecall", () => {
  it("renders the recall section with scene titles and chunk text", () => {
    const result = buildSystemPrompt({ scene, semanticRecall: recall });
    expect(result.prompt).toContain(RECALL_ANCHOR);
    expect(result.prompt).toContain("第一章 嵐の夜");
    expect(result.prompt).toContain("海は荒れ、舟は軋んでいた。");
    expect(result.prompt).toContain("第三章 再会");
    expect(result.prompt).toContain("彼女は無言で頷いた。");
  });

  it("omits the section entirely when no recall chunks are given", () => {
    expect(buildSystemPrompt({ scene }).prompt).not.toContain(RECALL_ANCHOR);
    expect(
      buildSystemPrompt({ scene, semanticRecall: [] }).prompt,
    ).not.toContain(RECALL_ANCHOR);
  });

  it("never places recall content inside cacheSegments", () => {
    // stable な L4 (sessionStableCodexIds 指定の codex) がある状態でも、
    // クエリ毎に変わる recall は cache 安定領域に混ざってはならない。
    const codex: CodexContext[] = [
      { id: "c1", type: "character", name: "太郎", summary: "主人公。" },
    ];
    const result = buildSystemPrompt({
      scene,
      codexEntries: codex,
      sessionStableCodexIds: ["c1"],
      semanticRecall: recall,
    });
    for (const seg of result.cacheSegments ?? []) {
      expect(seg).not.toContain(RECALL_ANCHOR);
      expect(seg).not.toContain("海は荒れ、舟は軋んでいた。");
    }
  });

  it("delivers recall content via volatileTail for cache-capable providers", () => {
    const result = buildSystemPrompt({ scene, semanticRecall: recall });
    expect(result.volatileTail).toBeDefined();
    expect(result.volatileTail).toContain(RECALL_ANCHOR);
    expect(result.volatileTail).toContain("海は荒れ、舟は軋んでいた。");
  });

  it("places recall before the conversation summary in volatileTail (prompt order)", () => {
    const result = buildSystemPrompt({
      scene,
      semanticRecall: recall,
      conversationSummary: "これまでの会話の要約文。",
    });
    const tail = result.volatileTail ?? "";
    const recallIdx = tail.indexOf(RECALL_ANCHOR);
    const summaryIdx = tail.indexOf("これまでの会話の要約文。");
    expect(recallIdx).toBeGreaterThanOrEqual(0);
    expect(summaryIdx).toBeGreaterThan(recallIdx);
  });

  it("reports a RAG layer breakdown entry only when recall is present", () => {
    const withRecall = buildSystemPrompt({ scene, semanticRecall: recall });
    const ragLayer = withRecall.layers.find((l) => l.layer === "RAG");
    expect(ragLayer).toBeDefined();
    expect(ragLayer!.used).toBeGreaterThan(0);

    const without = buildSystemPrompt({ scene });
    expect(without.layers.find((l) => l.layer === "RAG")).toBeUndefined();
  });

  it("accounts recall tokens in totalTokens", () => {
    const withRecall = buildSystemPrompt({ scene, semanticRecall: recall });
    const without = buildSystemPrompt({ scene });
    expect(withRecall.totalTokens).toBeGreaterThan(without.totalTokens);
  });

  it("supports excludeLayers: ['RAG']", () => {
    const result = buildSystemPrompt({
      scene,
      semanticRecall: recall,
      excludeLayers: ["RAG"],
    });
    expect(result.prompt).not.toContain(RECALL_ANCHOR);
  });

  it("trims recall away before touching other layers when over budget", () => {
    // budget を「recall 以外の合計」に固定すると、trim は recall だけを
    // 削れば収まる。既存層は無傷で残らなければならない。
    const without = buildSystemPrompt({ scene });
    const reservation = 2000; // computeResponseReservation の下限クランプ
    const result = buildSystemPrompt({
      scene,
      semanticRecall: recall,
      contextWindow: without.totalTokens + reservation,
      maxOutputTokens: reservation,
      conversationTokens: 0,
    });
    expect(result.trimmedLayers).toContain("RAG");
    expect(result.prompt).not.toContain("海は荒れ、舟は軋んでいた。");
    // 既存のシーン本文は残る
    expect(result.prompt).toContain("太郎は窓の外を見つめていた。");
  });
});

describe("trimToFit ragText", () => {
  const baseInput: TrimInput = {
    baseText: "ベース指示。",
    l1Text: "",
    l2Text: "",
    l3Text: "\n## 現在のシーン\n\n### シーン本文\n太郎は窓の外を見つめていた。",
    l4Text: "",
    l5Text: "",
    l6Text: "",
  };
  const ragText =
    "\n## 関連する過去シーン\n### 抜粋: 第一章\n海は荒れ、舟は軋んでいた。";

  it("keeps ragText when the budget fits", () => {
    const input: TrimInput = { ...baseInput, ragText };
    const result = trimToFit(input, 100_000);
    expect(result.trimmedTexts.ragText).toBe(ragText);
    expect(result.trimmedLayers).toEqual([]);
  });

  it("trims ragText first, leaving other layers intact", () => {
    const input: TrimInput = { ...baseInput, ragText };
    const budgetWithoutRag =
      countTokens(baseInput.baseText) + countTokens(baseInput.l3Text);
    const result = trimToFit(input, budgetWithoutRag);
    expect(result.trimmedLayers[0]).toBe("RAG");
    expect(result.trimmedTexts.l3Text).toBe(baseInput.l3Text);
    expect(countTokens(result.trimmedTexts.ragText ?? "")).toBeLessThan(
      countTokens(ragText),
    );
  });

  it("behaves as before when ragText is absent", () => {
    const result = trimToFit(baseInput, 100_000);
    expect(result.trimmedLayers).toEqual([]);
    expect(result.trimmedTexts.l3Text).toBe(baseInput.l3Text);
  });
});
