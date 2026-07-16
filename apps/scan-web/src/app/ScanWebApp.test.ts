import { describe, expect, it } from "vitest";
import { rollbackFeedbackOverride } from "./ScanWebApp";

describe("rollbackFeedbackOverride", () => {
  it("removes the optimistic override when its request fails", () => {
    expect(
      rollbackFeedbackOverride(
        { finding: "intentional" },
        "finding",
        "intentional",
        undefined,
      ),
    ).toEqual({});
  });

  it("does not overwrite a newer feedback choice", () => {
    const current = { finding: "rejected" } as const;
    expect(
      rollbackFeedbackOverride(current, "finding", "intentional", undefined),
    ).toBe(current);
  });
});
