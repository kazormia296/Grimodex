import { describe, it, expect } from "vitest";
import { buildChatCommandInstruction } from "./chatCommandInstruction";
import { buildSystemPrompt } from "../contextBuilder";

describe("buildChatCommandInstruction", () => {
  it("brainstorm → VS 指示(裾サンプリング・数値非出力)を返す", () => {
    const s = buildChatCommandInstruction("brainstorm", "ja");
    expect(s).toBeDefined();
    expect(s).toContain("裾");
    // チャットは生テキストを人が読むので確率の数値は出させない
    expect(s).toMatch(/出力しない|書かない/);
  });

  it("brainstorm 以外 / null は undefined (VS を当てない)", () => {
    expect(buildChatCommandInstruction("continue", "ja")).toBeUndefined();
    expect(buildChatCommandInstruction("rewrite", "ja")).toBeUndefined();
    expect(buildChatCommandInstruction(null, "ja")).toBeUndefined();
  });

  it("cot ゲート: false で『切り口』前置きを足さない / true で足す", () => {
    expect(
      buildChatCommandInstruction("brainstorm", "ja", { cot: false }),
    ).not.toContain("切り口");
    expect(
      buildChatCommandInstruction("brainstorm", "ja", { cot: true }),
    ).toContain("切り口");
  });

  it("en でも生成できる", () => {
    const s = buildChatCommandInstruction("brainstorm", "en");
    expect(s?.toLowerCase()).toContain("tail");
  });

  it("end-to-end: /brainstorm の指示は L6 経由で最終 prompt/volatileTail に載る", () => {
    const scene = { id: "s1", title: "S", content: "本文" };
    const withVs = buildSystemPrompt({
      scene,
      commandInstruction: buildChatCommandInstruction("brainstorm", "ja"),
    });
    expect(withVs.prompt).toContain("Verbalized Sampling");
    expect(withVs.prompt).toContain("裾");
    // cache プロバイダ向けにも届くよう volatileTail にも載る
    expect(withVs.volatileTail).toContain("Verbalized Sampling");

    // 非 brainstorm は instruction undefined → VS は載らない (従来不変)
    const none = buildSystemPrompt({
      scene,
      commandInstruction: buildChatCommandInstruction("continue", "ja"),
    });
    expect(none.prompt).not.toContain("Verbalized Sampling");
  });
});
