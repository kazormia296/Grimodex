import { describe, expect, it } from "vitest";

import { adviseCodexInvalidation } from "./codexInvalidationRules";

describe("adviseCodexInvalidation", () => {
  it("returns preview-only advice for every Gate C0 signal", () => {
    const signals = [
      "name-or-alias",
      "summary-or-content",
      "type",
      "detail-definition",
      "relation-human-edit",
    ] as const;

    for (const signal of signals) {
      expect(adviseCodexInvalidation(signal).autoApply).toBe(false);
    }
  });
});
