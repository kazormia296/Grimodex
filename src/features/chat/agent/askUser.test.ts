import { describe, it, expect, vi } from "vitest";

vi.mock("../contextBuilder", () => ({
  countTokens: (s: string) => (s ? s.length : 0),
}));

import {
  normalizeAskUserSpec,
  buildAskUserResult,
  dismissedAskUserResult,
  invalidAskUserResult,
} from "./askUser";
import type { AskUserContent } from "./agentTypes";

describe("normalizeAskUserSpec", () => {
  it("normalizes a valid multi-question payload", () => {
    const spec = normalizeAskUserSpec({
      questions: [
        { question: "Pick one", kind: "single", options: ["A", "B"] },
        { question: "Free", kind: "text" },
      ],
    });
    expect(spec).not.toBeNull();
    expect(spec!.questions).toHaveLength(2);
    expect(spec!.questions[0]).toMatchObject({
      kind: "single",
      options: ["A", "B"],
      allowFreeText: false,
    });
    expect(spec!.questions[1]).toMatchObject({ kind: "text", options: [] });
  });

  it("returns null when questions is missing or empty", () => {
    expect(normalizeAskUserSpec({})).toBeNull();
    expect(normalizeAskUserSpec({ questions: [] })).toBeNull();
    expect(normalizeAskUserSpec({ questions: "nope" })).toBeNull();
  });

  it("degrades single/multi without options to text", () => {
    const spec = normalizeAskUserSpec({
      questions: [{ question: "Q", kind: "single", options: [] }],
    });
    expect(spec!.questions[0].kind).toBe("text");
  });

  it("drops empty questions and blank options", () => {
    const spec = normalizeAskUserSpec({
      questions: [
        { question: "  ", kind: "text" },
        { question: "Real", kind: "multi", options: ["x", "", "  ", "y"] },
      ],
    });
    expect(spec!.questions).toHaveLength(1);
    expect(spec!.questions[0].options).toEqual(["x", "y"]);
  });

  it("coerces invalid kind to text", () => {
    const spec = normalizeAskUserSpec({
      questions: [{ question: "Q", kind: "bogus" }],
    });
    expect(spec!.questions[0].kind).toBe("text");
  });
});

describe("buildAskUserResult", () => {
  it("returns structured answers as content and a parseable summary", () => {
    const answer: AskUserContent = {
      answers: [
        {
          questionIndex: 0,
          question: "Pick",
          selected: ["A"],
        },
      ],
    };
    const result = buildAskUserResult("call-1", answer, "DISMISS_NOTE");
    expect(result.name).toBe("ask_user");
    expect(result.error).toBeUndefined();
    expect((result.content as AskUserContent).answers[0].selected).toEqual([
      "A",
    ]);
    const parsedSummary = JSON.parse(result.summary);
    expect(parsedSummary.answers[0].selected).toEqual(["A"]);
  });

  it("emits a dismissed sentinel carrying the dismiss note", () => {
    const result = dismissedAskUserResult("call-2", "DISMISS_NOTE");
    const content = result.content as AskUserContent;
    expect(content.dismissed).toBe(true);
    expect(content.note).toBe("DISMISS_NOTE");
    expect(content.answers).toEqual([]);
    expect(JSON.parse(result.summary)).toEqual({ dismissed: true });
  });
});

describe("invalidAskUserResult", () => {
  it("flags an error result for malformed input", () => {
    const result = invalidAskUserResult("call-3", "bad");
    expect(result.error).toBe("bad");
    expect(result.content).toBeNull();
    expect(result.tokensUsed).toBe(0);
  });
});
