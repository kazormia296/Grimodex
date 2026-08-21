import { describe, expect, it } from "vitest";

import numberParityFixture from "../../../../policies/narrative/fixtures/canonical-json-number-parity.json";
import { digestStableJson, stableJsonStringify } from "./digest";

describe("canonical JSON number parity", () => {
  it("matches the ECMAScript number spelling and digest goldens", async () => {
    for (const fixtureCase of numberParityFixture.cases) {
      expect(stableJsonStringify(fixtureCase.value), fixtureCase.id).toBe(
        fixtureCase.canonicalJson,
      );
      await expect(digestStableJson(fixtureCase.value)).resolves.toBe(
        fixtureCase.digest,
      );
    }
  });

  it("fails closed for non-JSON numbers", () => {
    expect(() => stableJsonStringify(Number.NaN)).toThrow(
      /non-finite number/i,
    );
    expect(() => stableJsonStringify(Number.POSITIVE_INFINITY)).toThrow(
      /non-finite number/i,
    );
    expect(() => stableJsonStringify(Number.NEGATIVE_INFINITY)).toThrow(
      /non-finite number/i,
    );
  });
});
