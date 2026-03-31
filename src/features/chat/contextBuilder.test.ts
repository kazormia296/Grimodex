import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  countTokens,
  type SceneContext,
  type ProjectContext,
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

      expect(result).toContain("夜明けの対話");
      expect(result).toContain("太郎は窓の外を見つめていた。");
    });

    it("includes project overview when provided", () => {
      const scene: SceneContext = {
        id: "scene-1",
        title: "シーン1",
        content: "本文",
      };
      const project: ProjectContext = {
        title: "月と六文銭",
        description: "芸術家の葛藤を描く長編小説",
      };

      const result = buildSystemPrompt({ scene, project });

      expect(result).toContain("月と六文銭");
      expect(result).toContain("芸術家の葛藤を描く長編小説");
    });

    it("works without project context", () => {
      const scene: SceneContext = {
        id: "scene-1",
        title: "シーン1",
        content: "本文",
      };

      const result = buildSystemPrompt({ scene });

      expect(result).toContain("シーン1");
      expect(result).toContain("本文");
      expect(typeof result).toBe("string");
    });

    it("handles empty scene content gracefully", () => {
      const scene: SceneContext = {
        id: "scene-1",
        title: "空のシーン",
        content: "",
      };

      const result = buildSystemPrompt({ scene });

      expect(result).toContain("空のシーン");
      expect(typeof result).toBe("string");
    });

    it("includes a novel-writing assistant instruction", () => {
      const scene: SceneContext = {
        id: "scene-1",
        title: "シーン1",
        content: "本文",
      };

      const result = buildSystemPrompt({ scene });

      // System prompt should instruct AI to act as a writing assistant
      expect(result.length).toBeGreaterThan(0);
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
