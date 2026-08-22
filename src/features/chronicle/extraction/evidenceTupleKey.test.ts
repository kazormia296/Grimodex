import { describe, expect, it } from "vitest";

import { chronicleEvidenceTupleKey } from "./evidenceTupleKey";

describe("chronicleEvidenceTupleKey", () => {
  it("preserves the historical key for ordinary evidence strings", () => {
    expect(chronicleEvidenceTupleKey("S0001", "quoted text")).toBe(
      "S0001\0quoted text",
    );
  });

  it("keeps embedded-NUL tuples distinct", () => {
    expect(chronicleEvidenceTupleKey("a", "b\0c")).not.toBe(
      chronicleEvidenceTupleKey("a\0b", "c"),
    );
  });
});
