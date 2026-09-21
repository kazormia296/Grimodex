import { describe, expect, it } from "vitest";
import { parseWorkspaceRestoreOutcome } from "./workspaceRestoreOutcome.js";

const readyLifecycle = {
  schemaVersion: 1,
  revision: 12,
  status: "ready",
  bindingToken: "bnd-exact",
  activation: "ready",
} as const;

describe("parseWorkspaceRestoreOutcome", () => {
  it("accepts an operation-scoped Unchanged proof", () => {
    expect(
      parseWorkspaceRestoreOutcome({
        status: "unchanged",
        operationOutcome: "failed",
        contentEffect: "none",
        lifecycle: readyLifecycle,
      }),
    ).toMatchObject({
      status: "unchanged",
      operationOutcome: "failed",
      lifecycle: readyLifecycle,
    });
  });

  it("keeps NotAdmitted distinct from a usable old binding", () => {
    expect(
      parseWorkspaceRestoreOutcome({
        status: "not-admitted",
        operationOutcome: "unknown",
        contentEffect: "none",
        lifecycle: {
          schemaVersion: 1,
          revision: 8,
          status: "transition",
          bindingToken: "bnd-old",
          activation: "none",
        },
        reasonCode: "lifecycle-active-operations",
      }).status,
    ).toBe("not-admitted");
  });

  it("rejects malformed or unsafe result combinations", () => {
    expect(() =>
      parseWorkspaceRestoreOutcome({
        status: "unchanged",
        operationOutcome: "succeeded",
        contentEffect: "none",
        lifecycle: readyLifecycle,
      }),
    ).toThrow();
    expect(() =>
      parseWorkspaceRestoreOutcome({
        status: "restored",
        operationOutcome: "succeeded",
        contentEffect: "replaced",
        activation: "ready",
        lifecycle: {
          ...readyLifecycle,
          revision: 13,
          bindingToken: null,
        },
      }),
    ).toThrow();
    expect(() =>
      parseWorkspaceRestoreOutcome({
        status: "not-admitted",
        operationOutcome: "unknown",
        contentEffect: "none",
        lifecycle: readyLifecycle,
        unknown: true,
      }),
    ).toThrow();
  });
});
