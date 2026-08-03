import { describe, expect, it } from "vitest";
import { hasIpcErrorCode, isUnknownIpcOutcomeError } from "./ipcOutcome";

describe("ipcOutcome", () => {
  it("detects unknown outcomes structurally", () => {
    expect(isUnknownIpcOutcomeError({ outcome: "unknown" })).toBe(true);
    expect(isUnknownIpcOutcomeError(new Error("unknown"))).toBe(false);
  });

  it("finds typed IPC codes through wrapper causes and aggregate errors", () => {
    const typed = Object.assign(new Error("workspace is changing"), {
      code: "WORKSPACE_SWITCHING",
    });
    const wrapped = new Error("save failed", { cause: typed });

    expect(hasIpcErrorCode(wrapped, "WORKSPACE_SWITCHING")).toBe(true);
    expect(
      hasIpcErrorCode(
        new AggregateError([new Error("other"), wrapped], "flush failed"),
        "WORKSPACE_SWITCHING",
      ),
    ).toBe(true);
  });

  it("does not classify a marker that only appears in display text", () => {
    expect(
      hasIpcErrorCode(
        new Error("WORKSPACE_SWITCHING: legacy message"),
        "WORKSPACE_SWITCHING",
      ),
    ).toBe(false);
  });

  it("handles cyclic wrapper structures", () => {
    const cyclic: { code?: string; cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(hasIpcErrorCode(cyclic, "WORKSPACE_SWITCHING")).toBe(false);
  });
});
