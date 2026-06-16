import { describe, it, expect } from "vitest";
import { insertedCharsFromPayload } from "./writingStatsQuery";

describe("insertedCharsFromPayload", () => {
  it("ReplaceStep の挿入テキスト長を数える", () => {
    const payload = JSON.stringify({
      steps: [
        {
          stepType: "replace",
          from: 5,
          to: 5,
          slice: { content: [{ type: "text", text: "こんにちは" }] },
        },
      ],
    });
    expect(insertedCharsFromPayload(payload)).toBe(5);
  });

  it("複数 step / ネストした content を合算する", () => {
    const payload = JSON.stringify({
      steps: [
        {
          stepType: "replace",
          slice: {
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "abc" }],
              },
              { type: "text", text: "de" },
            ],
          },
        },
        {
          stepType: "replace",
          slice: { content: [{ type: "text", text: "f" }] },
        },
      ],
    });
    expect(insertedCharsFromPayload(payload)).toBe(6);
  });

  it("削除（空 slice）は 0", () => {
    const payload = JSON.stringify({
      steps: [{ stepType: "replace", from: 2, to: 8, slice: { content: [] } }],
    });
    expect(insertedCharsFromPayload(payload)).toBe(0);
  });

  it("壊れた JSON / 想定外の形は 0（フォールバック）", () => {
    expect(insertedCharsFromPayload("not json")).toBe(0);
    expect(insertedCharsFromPayload(JSON.stringify({}))).toBe(0);
    expect(insertedCharsFromPayload(JSON.stringify({ steps: "x" }))).toBe(0);
  });
});
