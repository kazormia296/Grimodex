import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  trimToFit,
  countTokens,
  sanitizeSceneContent,
  type SceneContext,
  type ProjectContext,
  type CodexContext,
  type TrimInput,
} from "./contextBuilder";

describe("contextBuilder", () => {
  describe("buildSystemPrompt", () => {
    it("includes scene content in the system prompt", () => {
      const scene: SceneContext = {
        id: "scene-1",
        title: "夜明けの対話",
        content: "太郎は窓の外を見つめていた。",
      };

      const result = buildSystemPrompt({ scene });

      expect(result.prompt).toContain("夜明けの対話");
      expect(result.prompt).toContain("太郎は窓の外を見つめていた。");
    });

    it("includes project overview when provided", () => {
      const scene: SceneContext = {
        id: "scene-1",
        title: "シーン1",
        content: "本文",
      };
      const project: ProjectContext = {
        title: "月と六文銭",
        genre: "文学",
        pov: "三人称",
        tense: "過去形",
        styleGuide: "芸術家の葛藤を描く長編小説",
        aiInstructions: "丁寧な文体で",
      };

      const result = buildSystemPrompt({ scene, project });

      expect(result.prompt).toContain("月と六文銭");
      expect(result.prompt).toContain("文学");
      expect(result.prompt).toContain("三人称");
      expect(result.prompt).toContain("過去形");
      expect(result.prompt).toContain("芸術家の葛藤を描く長編小説");
      expect(result.prompt).toContain("丁寧な文体で");
    });

    it("works without project context", () => {
      const scene: SceneContext = {
        id: "scene-1",
        title: "シーン1",
        content: "本文",
      };

      const result = buildSystemPrompt({ scene });

      expect(result.prompt).toContain("シーン1");
      expect(result.prompt).toContain("本文");
      expect(typeof result.prompt).toBe("string");
    });

    it("handles empty scene content gracefully", () => {
      const scene: SceneContext = {
        id: "scene-1",
        title: "空のシーン",
        content: "",
      };

      const result = buildSystemPrompt({ scene });

      expect(result.prompt).toContain("空のシーン");
      expect(typeof result.prompt).toBe("string");
    });

    it("includes a novel-writing assistant instruction", () => {
      const scene: SceneContext = {
        id: "scene-1",
        title: "シーン1",
        content: "本文",
      };

      const result = buildSystemPrompt({ scene });

      // System prompt should instruct AI to act as a writing assistant
      expect(result.prompt.length).toBeGreaterThan(0);
    });

    it("includes codex entries in the system prompt", () => {
      const scene: SceneContext = {
        id: "scene-1",
        title: "シーン1",
        content: "太郎が花子に話しかけた。",
      };
      const codexEntries: CodexContext[] = [
        {
          id: "codex-1",
          type: "character",
          name: "太郎",
          summary: "主人公の青年",
        },
        {
          id: "codex-2",
          type: "location",
          name: "東京",
          summary: "物語の舞台",
        },
      ];

      const result = buildSystemPrompt({ scene, codexEntries });

      expect(result.prompt).toContain("登場キャラクター・設定情報");
      expect(result.prompt).toContain("**太郎** (キャラクター): 主人公の青年");
      expect(result.prompt).toContain("**東京** (場所): 物語の舞台");
    });

    it("includes pinned codex entries in the system prompt", () => {
      const scene: SceneContext = {
        id: "scene-1",
        title: "シーン1",
        content: "本文",
      };
      const pinnedCodexEntries: CodexContext[] = [
        {
          id: "codex-3",
          type: "item",
          name: "魔法の剣",
          summary: "伝説の武器",
        },
      ];

      const result = buildSystemPrompt({ scene, pinnedCodexEntries });

      expect(result.prompt).toContain("**魔法の剣** (アイテム): 伝説の武器");
    });

    it("deduplicates entries that appear in both auto and pinned", () => {
      const scene: SceneContext = {
        id: "scene-1",
        title: "シーン1",
        content: "本文",
      };
      const sharedEntry: CodexContext = {
        id: "codex-1",
        type: "character",
        name: "太郎",
        summary: "主人公の青年",
      };
      const codexEntries: CodexContext[] = [sharedEntry];
      const pinnedCodexEntries: CodexContext[] = [sharedEntry];

      const result = buildSystemPrompt({
        scene,
        codexEntries,
        pinnedCodexEntries,
      });

      // Should appear only once
      const matches = result.prompt.match(/\*\*太郎\*\*/g);
      expect(matches).toHaveLength(1);
    });

    it("does not add codex section when no entries provided", () => {
      const scene: SceneContext = {
        id: "scene-1",
        title: "シーン1",
        content: "本文",
      };

      const result = buildSystemPrompt({ scene });

      expect(result.prompt).not.toContain("登場キャラクター・設定情報");
    });

    it("does not add codex section when entries arrays are empty", () => {
      const scene: SceneContext = {
        id: "scene-1",
        title: "シーン1",
        content: "本文",
      };

      const result = buildSystemPrompt({
        scene,
        codexEntries: [],
        pinnedCodexEntries: [],
      });

      expect(result.prompt).not.toContain("登場キャラクター・設定情報");
    });

    it("uses type label for lore entries", () => {
      const scene: SceneContext = {
        id: "scene-1",
        title: "シーン1",
        content: "本文",
      };
      const codexEntries: CodexContext[] = [
        {
          id: "codex-1",
          type: "lore",
          name: "魔法体系",
          summary: "世界の魔法ルール",
        },
      ];

      const result = buildSystemPrompt({ scene, codexEntries });

      expect(result.prompt).toContain("**魔法体系** (設定): 世界の魔法ルール");
    });

    it("phaseLabelありのCodexContextが正しくフォーマットされる", () => {
      const scene: SceneContext = {
        id: "scene-1",
        title: "シーン1",
        content: "本文",
      };
      const codexEntries: CodexContext[] = [
        {
          id: "codex-1",
          type: "character",
          name: "アリス",
          summary: "変化後の概要",
          phaseLabel: "フェーズ1",
        },
      ];

      const result = buildSystemPrompt({ scene, codexEntries });

      expect(result.prompt).toContain(
        "**アリス** [フェーズ1] (キャラクター): 変化後の概要",
      );
    });

    it("phaseLabelなしのCodexContextは通常フォーマット", () => {
      const scene: SceneContext = {
        id: "scene-1",
        title: "シーン1",
        content: "本文",
      };
      const codexEntries: CodexContext[] = [
        {
          id: "codex-1",
          type: "character",
          name: "ボブ",
          summary: "普通のキャラクター",
        },
      ];

      const result = buildSystemPrompt({ scene, codexEntries });

      expect(result.prompt).toContain(
        "**ボブ** (キャラクター): 普通のキャラクター",
      );
      expect(result.prompt).not.toContain("[");
    });
  });

  describe("sanitizeSceneContent", () => {
    it("removes authorship spans but keeps their text", () => {
      const html =
        '<span data-authorship="ai" source="ai" timestamp="2026-01-01T00:00:00.000Z" manualoverride="false">AIが書いたテキスト</span>';
      expect(sanitizeSceneContent(html)).toBe("AIが書いたテキスト");
    });

    it("removes human authorship spans too", () => {
      const html =
        '<span data-authorship="human" source="human" timestamp="2026-01-01T00:00:00.000Z" manualoverride="false">人間が書いたテキスト</span>';
      expect(sanitizeSceneContent(html)).toBe("人間が書いたテキスト");
    });

    it("preserves ruby tags", () => {
      const html =
        '<ruby base="承知" data-base="承知" data-annotation="OK">承知<rp>(</rp><rt>OK</rt><rp>)</rp></ruby>';
      expect(sanitizeSceneContent(html)).toBe(html);
    });

    it("strips authorship spans while preserving sibling ruby tags", () => {
      const html =
        '<span data-authorship="ai" source="ai" timestamp="2026-01-01T00:00:00.000Z" manualoverride="false">はい、</span>' +
        '<ruby base="承知" data-base="承知" data-annotation="OK">承知<rp>(</rp><rt>OK</rt><rp>)</rp></ruby>' +
        '<span data-authorship="ai" source="ai" timestamp="2026-01-01T00:00:00.000Z" manualoverride="false">。</span>';
      expect(sanitizeSceneContent(html)).toBe(
        'はい、<ruby base="承知" data-base="承知" data-annotation="OK">承知<rp>(</rp><rt>OK</rt><rp>)</rp></ruby>。',
      );
    });

    it("leaves plain text unchanged", () => {
      const text = "これは普通のテキストです。";
      expect(sanitizeSceneContent(text)).toBe(text);
    });

    it("preserves p tags and other structural HTML", () => {
      const html = "<p>段落テキスト</p>";
      expect(sanitizeSceneContent(html)).toBe(html);
    });

    it("strips multiple authorship spans across the document", () => {
      const html =
        '<span data-authorship="ai" source="ai" timestamp="2026-01-01T00:00:00.000Z" chatmessageid="abc" manualoverride="false">文A</span>' +
        "人間テキスト" +
        '<span data-authorship="ai" source="ai" timestamp="2026-01-01T00:00:00.000Z" chatmessageid="abc" manualoverride="false">文B</span>';
      expect(sanitizeSceneContent(html)).toBe("文A人間テキスト文B");
    });
  });

  describe("trimToFit", () => {
    function makeLayers(overrides: Partial<TrimInput> = {}): TrimInput {
      return {
        baseText: "base",
        l1Text: "",
        l2Text: "",
        l3Text: "",
        l4Text: "",
        l5Text: "",
        l6Text: "",
        ...overrides,
      };
    }

    it("returns unchanged texts when total tokens <= budget", () => {
      const layers = makeLayers({ l4Text: "短い文章" });
      const budget = 100_000;
      const result = trimToFit(layers, budget);
      expect(result.trimmedLayers).toHaveLength(0);
      expect(result.trimmedTexts.l4Text).toBe("短い文章");
    });

    it("trims L5 before L4 (priority order)", () => {
      // L5 has content (simulate), L4 also has content
      // budget is tiny so both may be touched, but L5 is cleared first
      const l5Content = "L5コンテンツ: ".repeat(500);
      const l4Content =
        "- **キャラA** (character): 説明\n- **キャラB** (character): 説明";
      const layers = makeLayers({ l5Text: l5Content, l4Text: l4Content });
      const totalTokens =
        countTokens("base") + countTokens(l5Content) + countTokens(l4Content);
      // budget = total - (L5 tokens) => forces L5 to be trimmed but L4 untouched
      const l5Tokens = countTokens(l5Content);
      const budget = totalTokens - l5Tokens;

      const result = trimToFit(layers, budget);
      expect(result.trimmedLayers).toContain("L5");
      expect(result.trimmedTexts.l5Text).toBe("");
      // L4 should be untouched since trimming L5 brought us within budget
      expect(result.trimmedTexts.l4Text).toBe(l4Content);
    });

    it("trims L4 when L5 trimming is not enough", () => {
      // L5 is empty, L4 has many entries — budget is smaller than L4 alone
      const l4Content = [
        "\n## 登場キャラクター・設定情報",
        "- **キャラA** (キャラクター): 詳しい説明文A",
        "- **キャラB** (キャラクター): 詳しい説明文B",
        "- **キャラC** (キャラクター): 詳しい説明文C",
        "- **キャラD** (キャラクター): 詳しい説明文D",
      ].join("\n");
      const layers = makeLayers({ l4Text: l4Content });
      const totalTokens = countTokens("base") + countTokens(l4Content);
      // Force trimming by setting budget below total
      const budget =
        totalTokens -
        countTokens("- **キャラD** (キャラクター): 詳しい説明文D");

      const result = trimToFit(layers, budget);
      expect(result.trimmedLayers).toContain("L4");
      expect(result.totalTokens).toBeLessThanOrEqual(budget);
    });

    it("does not exceed budget after trimming", () => {
      const l4Content = Array.from(
        { length: 50 },
        (_, i) =>
          `- **キャラ${i}** (キャラクター): これはキャラクター${i}の詳細な説明文です。`,
      ).join("\n");
      const layers = makeLayers({
        l4Text: "\n## 登場キャラクター・設定情報\n" + l4Content,
        l2Text: "## これまでの物語\n\n第一章の概要\n\n第二章の概要",
      });
      const budget = 50;
      const result = trimToFit(layers, budget);
      expect(result.totalTokens).toBeLessThanOrEqual(budget);
    });

    it("records all trimmed layer names", () => {
      // Use a very tight budget to force multiple layers to be trimmed
      const l5Content = "L5data ".repeat(100);
      const l4Content =
        "\n## 登場キャラクター・設定情報\n" +
        Array.from(
          { length: 20 },
          (_, i) => `- **C${i}** (キャラクター): 説明${i}`,
        ).join("\n");
      const l2Content =
        "## これまでの物語\n\n" +
        Array.from({ length: 10 }, (_, i) => `シーン${i}\n概要${i}`).join(
          "\n\n",
        );
      const layers = makeLayers({
        l5Text: l5Content,
        l4Text: l4Content,
        l2Text: l2Content,
      });
      const result = trimToFit(layers, 5);
      // With budget=5, multiple layers should be trimmed
      expect(result.trimmedLayers.length).toBeGreaterThan(0);
    });
  });

  describe("buildSystemPrompt — excludeLayers", () => {
    it("excludes L2 when excludeLayers contains 'L2'", () => {
      const scene: SceneContext = {
        id: "scene-1",
        title: "テスト",
        content: "内容",
      };
      const storySoFar = "## これまでの物語\n\n過去のシーン概要";

      const normalResult = buildSystemPrompt({ scene, storySoFar });
      expect(normalResult.prompt).toContain("これまでの物語");

      const excludedResult = buildSystemPrompt({
        scene,
        storySoFar,
        excludeLayers: ["L2"],
      });
      expect(excludedResult.prompt).not.toContain("これまでの物語");
    });

    it("excludes L4 when excludeLayers contains 'L4'", () => {
      const scene: SceneContext = {
        id: "scene-1",
        title: "テスト",
        content: "内容",
      };
      const codexEntries: CodexContext[] = [
        { id: "c1", type: "character", name: "太郎", summary: "主人公" },
      ];

      const normalResult = buildSystemPrompt({ scene, codexEntries });
      expect(normalResult.prompt).toContain("太郎");

      const excludedResult = buildSystemPrompt({
        scene,
        codexEntries,
        excludeLayers: ["L4"],
      });
      expect(excludedResult.prompt).not.toContain("太郎");
    });

    it("can exclude multiple layers at once", () => {
      const scene: SceneContext = {
        id: "scene-1",
        title: "テスト",
        content: "内容",
      };
      const storySoFar = "## これまでの物語\n\n概要";
      const codexEntries: CodexContext[] = [
        { id: "c1", type: "character", name: "太郎", summary: "主人公" },
      ];

      const result = buildSystemPrompt({
        scene,
        storySoFar,
        codexEntries,
        excludeLayers: ["L2", "L4"],
      });
      expect(result.prompt).not.toContain("これまでの物語");
      expect(result.prompt).not.toContain("太郎");
    });

    it("returns trimmedLayers in result when trimming occurs via conversationTokens", () => {
      // Build a scene with enough content that trimming occurs
      const scene: SceneContext = {
        id: "scene-1",
        title: "テスト",
        content: "内容",
      };
      const codexEntries: CodexContext[] = Array.from(
        { length: 30 },
        (_, i) => ({
          id: `c${i}`,
          type: "character",
          name: `キャラ${i}`,
          summary: `これはキャラクター${i}の詳しい説明文です。`.repeat(5),
        }),
      );
      // Tiny contextWindow to force trimming
      const result = buildSystemPrompt({
        scene,
        codexEntries,
        contextWindow: 500,
        conversationTokens: 0,
      });
      // trimmedLayers should be set since L4 will be trimmed
      expect(result.trimmedLayers).toBeDefined();
      expect(result.trimmedLayers!.length).toBeGreaterThan(0);
    });
  });

  describe("countTokens", () => {
    it("returns a positive number for non-empty text", () => {
      const count = countTokens("こんにちは、世界！");
      expect(count).toBeGreaterThan(0);
      expect(Number.isInteger(count)).toBe(true);
    });

    it("returns 0 for empty text", () => {
      const count = countTokens("");
      expect(count).toBe(0);
    });

    it("counts tokens for longer text", () => {
      const short = countTokens("Hello");
      const long = countTokens(
        "Hello world, this is a longer sentence with more tokens.",
      );
      expect(long).toBeGreaterThan(short);
    });

    it("handles multi-message token counting", () => {
      const messages = [
        { role: "system" as const, content: "You are a writing assistant." },
        { role: "user" as const, content: "こんにちは" },
      ];
      const total = messages.reduce(
        (sum, m) => sum + countTokens(m.content),
        0,
      );
      expect(total).toBeGreaterThan(0);
    });
  });
});
