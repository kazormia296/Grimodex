import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  debugLog,
  errorDetail,
  rootCause,
  sanitizeLogDetail,
  useDebugLogStore,
} from "./debugLog";

describe("redactParams", () => {
  it("fully redacts long param values in errorDetail", () => {
    const longContent = "a".repeat(200);
    const err = new Error(
      `Failed query: INSERT INTO t VALUES (?)\nparams: ${longContent}`,
    );
    const detail = errorDetail(err);
    expect(detail).not.toContain(longContent);
    expect(detail).toContain("[redacted sql params]");
  });

  it("fully redacts short param values too", () => {
    const err = new Error(
      "Failed query: UPDATE t SET x = ?\nparams: 2026-01-01,abc-123",
    );
    const detail = errorDetail(err);
    expect(detail).not.toContain("2026-01-01");
    expect(detail).not.toContain("abc-123");
    expect(detail).toContain("[redacted sql params]");
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
    expect(detail).toContain("[redacted sql params]");
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
    expect(detail).toContain("[redacted sql params]");
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
    expect(msg).toContain("[redacted sql params]");
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

describe("structured sensitive logging", () => {
  beforeEach(() => {
    useDebugLogStore.getState().clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("redacts a content sentinel before both the store and console in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sentinel = "SECRET_NOVEL_SENTINEL";

    debugLog.warn("Editor", `doc changed ${sentinel}`, {
      sensitivity: "content-derived",
      fields: {
        steps: [{ stepType: "replace", insertedText: sentinel }],
      },
    });

    const entry = useDebugLogStore.getState().entries.at(-1);
    expect(entry?.message).toBe("[redacted content-derived message]");
    expect(entry?.detail).toBe("[redacted content-derived]");
    expect(JSON.stringify(entry)).not.toContain(sentinel);
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain(sentinel);
    expect(consoleWarn).toHaveBeenCalledWith(
      "[Editor] [redacted content-derived message]",
      "[redacted content-derived]",
    );
  });

  it("redacts SQL params and stack frames from messages before both sinks", () => {
    vi.stubEnv("NODE_ENV", "production");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const sentinel = "SECRET_NOVEL_SENTINEL";

    debugLog.error(
      "Database",
      `query failed\nparams: ${sentinel}\n    at ${sentinel} (/workspace/file.ts:1:1)`,
    );

    const entry = useDebugLogStore.getState().entries.at(-1);
    expect(entry?.message).toContain("[redacted sql params]");
    expect(JSON.stringify(entry)).not.toContain(sentinel);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(sentinel);
  });

  it("redacts legacy raw details and secret fields in production", () => {
    expect(sanitizeLogDetail("legacy SECRET_NOVEL_SENTINEL", true)).toBe(
      "[redacted legacy detail]",
    );
    expect(
      sanitizeLogDetail(
        {
          sensitivity: "safe",
          fields: {
            command: "test",
            token: "SECRET_NOVEL_SENTINEL",
            params: ["SECRET_NOVEL_SENTINEL"],
          },
        },
        true,
      ),
    ).not.toContain("SECRET_NOVEL_SENTINEL");
  });

  it("omits stack traces in production error details", () => {
    vi.stubEnv("NODE_ENV", "production");
    const error = new Error("operation failed");
    error.stack = "SECRET_STACK_SENTINEL";

    const detail = errorDetail(error);

    expect(detail).toBe("operation failed");
    expect(detail).not.toContain("SECRET_STACK_SENTINEL");
  });
});
