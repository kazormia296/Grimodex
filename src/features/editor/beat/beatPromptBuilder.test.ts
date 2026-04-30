import { describe, it, expect } from "vitest";
import {
  buildBeatMessages,
  buildBeatSystemPrompt,
  buildBeatUserPrompt,
  type BeatPromptInput,
} from "./beatPromptBuilder";

const BASE: BeatPromptInput = {
  instructions: "雨の夜、廃社の前で立ち止まる朱音。",
  beatType: "free",
  projectTitle: "テストプロジェクト",
  sceneTitle: "第1話",
  sceneTextSoFar: "朱音は雨の中、十年ぶりに故郷へ向かった。",
  povName: null,
};

describe("buildBeatSystemPrompt", () => {
  it("includes project and scene titles", () => {
    const sys = buildBeatSystemPrompt(BASE);
    expect(sys).toContain("テストプロジェクト");
    expect(sys).toContain("第1話");
  });

  it("injects POV name only when provided", () => {
    expect(buildBeatSystemPrompt(BASE)).not.toContain("POV");
    const withPov = buildBeatSystemPrompt({ ...BASE, povName: "朱音" });
    expect(withPov).toContain("朱音");
    expect(withPov).toContain("POV");
  });

  it("emits beat-type guidance for non-free types", () => {
    expect(buildBeatSystemPrompt({ ...BASE, beatType: "free" })).not.toContain(
      "会話",
    );
    expect(buildBeatSystemPrompt({ ...BASE, beatType: "dialogue" })).toContain(
      "会話",
    );
    expect(buildBeatSystemPrompt({ ...BASE, beatType: "micro" })).toContain(
      "100",
    );
  });
});

describe("buildBeatUserPrompt", () => {
  it("includes prior scene text and beat instructions", () => {
    const user = buildBeatUserPrompt(BASE);
    expect(user).toContain("十年ぶりに故郷");
    expect(user).toContain("雨の夜、廃社");
  });

  it("omits the prior-scene section when sceneTextSoFar is blank", () => {
    const user = buildBeatUserPrompt({ ...BASE, sceneTextSoFar: "   " });
    expect(user).not.toContain("直前まで");
    expect(user).toContain("ビート指示");
  });

  it("instructs the model to output prose only (no metacomments)", () => {
    const user = buildBeatUserPrompt(BASE);
    expect(user).toMatch(/メタコメント|見出し/);
  });
});

describe("buildBeatMessages", () => {
  it("returns a system + user pair in the right order", () => {
    const msgs = buildBeatMessages(BASE);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("user");
  });
});
