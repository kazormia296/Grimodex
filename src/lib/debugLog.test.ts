import { describe, it, expect } from "vitest";
import { errorDetail, rootCause } from "./debugLog";

describe("redactParams", () => {
  it("truncates long param values in errorDetail", () => {
    const longContent = "a".repeat(200);
    const err = new Error(
      `Failed query: INSERT INTO t VALUES (?)\nparams: ${longContent}`,
    );
    const detail = errorDetail(err);
    expect(detail).not.toContain(longContent);
    expect(detail).toContain("…[redacted]");
  });

  it("preserves short param values", () => {
    const err = new Error(
      "Failed query: UPDATE t SET x = ?\nparams: 2026-01-01,abc-123",
    );
    const detail = errorDetail(err);
    expect(detail).toContain("2026-01-01");
    expect(detail).toContain("abc-123");
    expect(detail).not.toContain("[redacted]");
  });

  it("redacts long comma-containing prose (does not leak per-fragment)", () => {
    const prose =
      "The mist rolled in, cold and grey, over the harbor, and the ship sailed away into the fog";
    const err = new Error(
      `Failed query: INSERT INTO scenes VALUES (?)\nparams: ${prose}`,
    );
    const detail = errorDetail(err);
    expect(detail).not.toContain(prose);
    expect(detail).not.toContain("sailed away into the fog");
    expect(detail).toContain("…[redacted]");
  });

  it("redacts params in stack trace (which repeats the message)", () => {
    const longContent = "b".repeat(200);
    const err = new Error(`Failed query: SELECT\nparams: ${longContent}`);
    // JS stacks include the message on the first line
    const detail = errorDetail(err);
    // The full long content should not appear anywhere
    expect(detail).not.toContain(longContent);
  });

  it("redacts params in cause chain", () => {
    const longContent = "c".repeat(200);
    const inner = new Error(`Failed query: DELETE\nparams: ${longContent}`);
    const outer = new Error("wrapper");
    outer.cause = inner;
    const detail = errorDetail(outer);
    expect(detail).not.toContain(longContent);
    expect(detail).toContain("…[redacted]");
  });

  it("handles non-Error values", () => {
    const longContent = "d".repeat(200);
    const detail = errorDetail(`params: ${longContent}`);
    expect(detail).not.toContain(longContent);
  });
});

describe("rootCause", () => {
  it("redacts long params in root cause message", () => {
    const longContent = "e".repeat(200);
    const err = new Error(`Failed query: X\nparams: ${longContent}`);
    const msg = rootCause(err);
    expect(msg).not.toContain(longContent);
    expect(msg).toContain("…[redacted]");
  });

  it("walks cause chain and redacts", () => {
    const longContent = "f".repeat(200);
    const inner = new Error(`params: ${longContent}`);
    const outer = new Error("outer");
    outer.cause = inner;
    const msg = rootCause(outer);
    expect(msg).not.toContain(longContent);
  });
});
