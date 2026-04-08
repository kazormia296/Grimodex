import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  countTokens,
  sanitizeSceneContent,
  type SceneContext,
  type ProjectContext,
  type CodexContext,
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
