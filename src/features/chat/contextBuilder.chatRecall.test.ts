import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  trimToFit,
  countTokens,
  type SceneContext,
  type CodexContext,
  type TrimInput,
} from "./contextBuilder";

// セクションヘッダ文言の正本はカタログ (prompts/ja/chatSystem.ts)。
// テストはアンカー部分文字列にのみ依存させる。
const EPISODIC_ANCHOR = "過去の対話の記憶";
const RECALL_ANCHOR = "関連する過去シーン"; // scene RAG

const scene: SceneContext = {
  id: "scene-current",
  title: "現在のシーン",
  content: "太郎は窓の外を見つめていた。",
};

const chatRecall = [
  { label: "過去のあなたの発言", text: "魔法体系は等価交換で統一したい。" },
  { label: "過去のAIの応答", text: "では代償は記憶の欠落にしましょう。" },
];

describe("buildSystemPrompt chatRecall (episodic memory)", () => {
  it("renders the episodic section with labels and message text", () => {
    const result = buildSystemPrompt({ scene, chatRecall });
    expect(result.prompt).toContain(EPISODIC_ANCHOR);
    expect(result.prompt).toContain("過去のあなたの発言");
    expect(result.prompt).toContain("魔法体系は等価交換で統一したい。");
    expect(result.prompt).toContain("過去のAIの応答");
    expect(result.prompt).toContain("では代償は記憶の欠落にしましょう。");
  });

  it("omits the section entirely when no episodic messages are given", () => {
    expect(buildSystemPrompt({ scene }).prompt).not.toContain(EPISODIC_ANCHOR);
    expect(buildSystemPrompt({ scene, chatRecall: [] }).prompt).not.toContain(
      EPISODIC_ANCHOR,
    );
  });

  it("NEVER places episodic content inside cacheSegments (cache byte-stability)", () => {
    // クエリ毎に変わる episodic は、stable codex があっても cache 安定領域に
    // 混ざってはならない (混ざると prompt cache が毎ターン壊れる)。
    const codex: CodexContext[] = [
      { id: "c1", type: "character", name: "太郎", summary: "主人公。" },
    ];
    const result = buildSystemPrompt({
      scene,
      codexEntries: codex,
      sessionStableCodexIds: ["c1"],
      chatRecall,
    });
    for (const seg of result.cacheSegments ?? []) {
      expect(seg).not.toContain(EPISODIC_ANCHOR);
      expect(seg).not.toContain("魔法体系は等価交換で統一したい。");
    }
  });

  it("delivers episodic content via volatileTail for cache-capable providers", () => {
    const result = buildSystemPrompt({ scene, chatRecall });
    expect(result.volatileTail).toBeDefined();
    expect(result.volatileTail).toContain(EPISODIC_ANCHOR);
    expect(result.volatileTail).toContain("魔法体系は等価交換で統一したい。");
  });

  it("orders Codex BEFORE episodic in prompt (canon cannot be overridden)", () => {
    const codex: CodexContext[] = [
      { id: "c1", type: "character", name: "セレーナ", summary: "導師。" },
    ];
    const result = buildSystemPrompt({
      scene,
      codexEntries: codex,
      chatRecall,
    });
    const codexIdx = result.prompt.indexOf("セレーナ");
    const episodicIdx = result.prompt.indexOf(EPISODIC_ANCHOR);
    expect(codexIdx).toBeGreaterThanOrEqual(0);
    expect(episodicIdx).toBeGreaterThan(codexIdx);
  });

  it("orders scene RAG BEFORE episodic, and episodic BEFORE the summary (volatileTail)", () => {
    const result = buildSystemPrompt({
      scene,
      semanticRecall: [{ sceneTitle: "第一章", chunkText: "海は荒れていた。" }],
      chatRecall,
      conversationSummary: "これまでの会話の要約文。",
    });
    const tail = result.volatileTail ?? "";
    const ragIdx = tail.indexOf(RECALL_ANCHOR);
    const episodicIdx = tail.indexOf(EPISODIC_ANCHOR);
    const summaryIdx = tail.indexOf("これまでの会話の要約文。");
    expect(ragIdx).toBeGreaterThanOrEqual(0);
    expect(episodicIdx).toBeGreaterThan(ragIdx);
    expect(summaryIdx).toBeGreaterThan(episodicIdx);
  });

  it("reports an EPISODIC layer breakdown entry only when episodic is present", () => {
    const withEp = buildSystemPrompt({ scene, chatRecall });
    const epLayer = withEp.layers.find((l) => l.layer === "EPISODIC");
    expect(epLayer).toBeDefined();
    expect(epLayer!.used).toBeGreaterThan(0);

    const without = buildSystemPrompt({ scene });
    expect(without.layers.find((l) => l.layer === "EPISODIC")).toBeUndefined();
  });

  it("accounts episodic tokens in totalTokens", () => {
    const withEp = buildSystemPrompt({ scene, chatRecall });
    const without = buildSystemPrompt({ scene });
    expect(withEp.totalTokens).toBeGreaterThan(without.totalTokens);
  });

  it("supports excludeLayers: ['EPISODIC']", () => {
    const result = buildSystemPrompt({
      scene,
      chatRecall,
      excludeLayers: ["EPISODIC"],
    });
    expect(result.prompt).not.toContain(EPISODIC_ANCHOR);
  });

  it("trims episodic away FIRST (before scene RAG) when over budget", () => {
    // budget を「episodic 以外の合計」に固定 → episodic だけ削れば収まる。
    // scene RAG も既存層も無傷でなければならない (episodic が最も投機的)。
    const withRag = buildSystemPrompt({
      scene,
      semanticRecall: [{ sceneTitle: "第一章", chunkText: "海は荒れていた。" }],
    });
    const reservation = 2000;
    const result = buildSystemPrompt({
      scene,
      semanticRecall: [{ sceneTitle: "第一章", chunkText: "海は荒れていた。" }],
      chatRecall,
      contextWindow: withRag.totalTokens + reservation,
      maxOutputTokens: reservation,
      conversationTokens: 0,
    });
    expect(result.trimmedLayers).toContain("EPISODIC");
    expect(result.trimmedLayers).not.toContain("RAG");
    expect(result.prompt).not.toContain("魔法体系は等価交換で統一したい。");
    // scene RAG と本文は残る。
    expect(result.prompt).toContain("海は荒れていた。");
    expect(result.prompt).toContain("太郎は窓の外を見つめていた。");
  });
});

describe("trimToFit episodicText", () => {
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
    "\n## 関連する過去シーン\nintro\n### 抜粋: 第一章\n海は荒れ、舟は軋んでいた。";
  const episodicText =
    "\n## 過去の対話の記憶\nintro\n### 過去のあなたの発言\n魔法体系は等価交換で統一したい。";

  it("keeps episodicText when the budget fits", () => {
    const input: TrimInput = { ...baseInput, episodicText };
    const result = trimToFit(input, 100_000);
    expect(result.trimmedTexts.episodicText).toBe(episodicText);
    expect(result.trimmedLayers).toEqual([]);
  });

  it("trims episodicText BEFORE ragText when over budget", () => {
    const input: TrimInput = { ...baseInput, ragText, episodicText };
    // budget を base+l3+rag に固定 → episodic だけ削れば収まる。
    const budget =
      countTokens(baseInput.baseText) +
      countTokens(baseInput.l3Text) +
      countTokens(ragText);
    const result = trimToFit(input, budget);
    expect(result.trimmedLayers[0]).toBe("EPISODIC");
    expect(result.trimmedLayers).not.toContain("RAG");
    expect(result.trimmedTexts.ragText).toBe(ragText);
    expect(result.trimmedTexts.l3Text).toBe(baseInput.l3Text);
  });

  it("behaves as before when episodicText is absent", () => {
    const result = trimToFit(baseInput, 100_000);
    expect(result.trimmedLayers).toEqual([]);
  });
});
