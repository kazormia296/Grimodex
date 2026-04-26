import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildUserPrompt } from "./inlineAiApi";
import type { InlineAiCommand, InlineAiContext } from "./inlineAiTypes";

const cmd: InlineAiCommand = {
  id: "continue",
  label: "Continue",
  description: "",
  mode: "insert",
  needsSelection: false,
};

function ctx(overrides: Partial<InlineAiContext> = {}): InlineAiContext {
  return {
    projectTitle: "Proj",
    sceneTitle: "Scene",
    sceneText: "本文",
    codexSummaries: "",
    ...overrides,
  };
}

describe("buildSystemPrompt", () => {
  it("mentions project and scene titles", () => {
    const text = buildSystemPrompt(cmd, ctx());
    expect(text).toContain("Proj");
    expect(text).toContain("Scene");
  });

  it("includes codexSummaries section when non-empty", () => {
    const text = buildSystemPrompt(
      cmd,
      ctx({ codexSummaries: "- Alice: 騎士" }),
    );
    expect(text).toContain("## 関連設定");
    expect(text).toContain("- Alice: 騎士");
  });

  it("omits codexSummaries section when empty", () => {
    const text = buildSystemPrompt(cmd, ctx({ codexSummaries: "" }));
    expect(text).not.toContain("## 関連設定");
  });
});

describe("buildUserPrompt", () => {
  it("injects sceneText for all commands", () => {
    const text = buildUserPrompt(cmd, ctx({ sceneText: "シーン本文テキスト" }));
    expect(text).toContain("## シーン本文");
    expect(text).toContain("シーン本文テキスト");
  });

  it("adds cursorContext block for /continue (insert-mode)", () => {
    const text = buildUserPrompt(
      cmd,
      ctx({ cursorContext: "前【カーソル】後" }),
    );
    expect(text).toContain("## カーソル周辺");
    expect(text).toContain("【カーソル】");
  });

  it("adds selection block for /rewrite (replace-mode)", () => {
    const rewrite: InlineAiCommand = {
      ...cmd,
      id: "rewrite",
      mode: "replace",
      needsSelection: true,
    };
    const text = buildUserPrompt(rewrite, ctx({ selectedText: "原文" }));
    expect(text).toContain("## 選択テキスト");
    expect(text).toContain("原文");
  });

  it("interpolates arg for /tone", () => {
    const tone: InlineAiCommand = {
      ...cmd,
      id: "tone",
      mode: "replace",
      needsSelection: true,
      needsArg: true,
    };
    const text = buildUserPrompt(tone, ctx({ selectedText: "x", arg: "硬質" }));
    expect(text).toContain("「硬質」");
  });

  it("interpolates arg for /translate", () => {
    const tr: InlineAiCommand = {
      ...cmd,
      id: "translate",
      mode: "replace",
      needsSelection: true,
      needsArg: true,
    };
    const text = buildUserPrompt(tr, ctx({ selectedText: "x", arg: "英語" }));
    expect(text).toContain("「英語」");
  });
});
