import { describe, it, expect } from "vitest";
import {
  buildInlineAiSystemPromptJa,
  buildInlineAiUserPromptJa,
} from "./inlineAi";
import { buildBeatSystemPromptJa, buildBeatUserPromptJa } from "./beat";
import type {
  InlineAiCommand,
  InlineAiContext,
} from "@/features/editor/inlineAi/inlineAiTypes";
import type { BeatPromptInput } from "@/features/editor/beat/beatPromptBuilder";

const CONTINUE: InlineAiCommand = {
  id: "continue",
  label: "続き",
  description: "",
  mode: "insert",
  needsSelection: false,
};

function inlineCtx(custom?: string): InlineAiContext {
  return {
    projectTitle: "P",
    sceneTitle: "S",
    sceneText: "本文テキスト",
    codexSummaries: "",
    customInstruction: custom,
  };
}

function beatInput(custom?: string): BeatPromptInput {
  return {
    instructions: "ビート指示",
    beatType: "free",
    projectTitle: "P",
    sceneTitle: "S",
    sceneTextSoFar: "これまでの本文",
    povName: null,
    customInstruction: custom,
  };
}

const INLINE_CUSTOM = "比喩を多用し、短めの文で書いてください";
const BEAT_CUSTOM = "会話のテンポを速めてください";

describe("buildInlineAiSystemPromptJa customInstruction", () => {
  it("空/未指定なら system prompt は byte-identical", () => {
    const base = buildInlineAiSystemPromptJa(CONTINUE, inlineCtx());
    expect(buildInlineAiSystemPromptJa(CONTINUE, inlineCtx(""))).toBe(base);
    expect(buildInlineAiSystemPromptJa(CONTINUE, inlineCtx("  \n "))).toBe(
      base,
    );
  });

  it("非空なら system prompt 末尾に追記される", () => {
    const result = buildInlineAiSystemPromptJa(
      CONTINUE,
      inlineCtx(INLINE_CUSTOM),
    );
    expect(result).toContain(INLINE_CUSTOM);
    expect(result).toContain("## 追加指示");
  });

  it("user prompt は custom の有無で変わらない (出力契約を保持)", () => {
    const a = buildInlineAiUserPromptJa(CONTINUE, inlineCtx());
    const b = buildInlineAiUserPromptJa(CONTINUE, inlineCtx(INLINE_CUSTOM));
    expect(b).toBe(a);
    expect(b).toContain("本文のみ出力してください");
  });
});

describe("buildBeatSystemPromptJa customInstruction", () => {
  it("空/未指定なら system prompt は byte-identical", () => {
    const base = buildBeatSystemPromptJa(beatInput());
    expect(buildBeatSystemPromptJa(beatInput(""))).toBe(base);
    expect(buildBeatSystemPromptJa(beatInput("   "))).toBe(base);
  });

  it("非空なら system prompt 末尾に追記される", () => {
    const result = buildBeatSystemPromptJa(beatInput(BEAT_CUSTOM));
    expect(result).toContain(BEAT_CUSTOM);
    expect(result).toContain("## 追加指示");
  });

  it("user prompt は custom の有無で変わらない (出力契約を保持)", () => {
    const a = buildBeatUserPromptJa(beatInput());
    const b = buildBeatUserPromptJa(beatInput(BEAT_CUSTOM));
    expect(b).toBe(a);
    expect(b).toContain("本文のみを出力");
  });
});
