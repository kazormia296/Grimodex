import { describe, expect, it } from "vitest";
import { parseRuntimeKey } from "./key-reader.mjs";

const FAKE_CANARY = "sk-test-canary_123";
const FIXED_ERROR = "LIVE_JUDGE_KEY_INVALID";

describe("runtime key parser", () => {
  it("accepts a trimmed NUL-delimited fake canary", () => {
    const parsed = parseRuntimeKey(
      "  " + FAKE_CANARY + "  \0ignored-after-delimiter",
    );

    expect(parsed).toBe(FAKE_CANARY);
    const sanitized = JSON.stringify({
      present: true,
      length: parsed.length,
    });
    expect(sanitized).not.toContain(parsed);
  });

  it.each([
    ["empty", ""],
    ["wrong prefix", "pk-test-canary"],
    ["too short", "sk-a"],
    ["too long", "sk-" + "a".repeat(510)],
    ["newline", FAKE_CANARY + "\ntrailing"],
    ["carriage return", FAKE_CANARY + "\rtrailing"],
    ["invalid punctuation", FAKE_CANARY + "!"],
    ["NUL before a complete value", "sk-\0ignored"],
    ["non-string", null],
    ["non-string number", 123],
  ])("rejects %s with the fixed error", (_label, input) => {
    expect(() => parseRuntimeKey(input)).toThrowError(FIXED_ERROR);
  });

  it("never includes invalid input text in the fixed exception", () => {
    const invalidInputs = [
      FAKE_CANARY + "\nsecret-body-canary",
      FAKE_CANARY + "!response-body-canary",
      "not-a-runtime-credential",
    ];

    for (const input of invalidInputs) {
      try {
        parseRuntimeKey(input);
        throw new Error("expected parser rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ message: FIXED_ERROR });
        expect((error as Error).message).not.toContain(input);
      }
    }
  });
});
