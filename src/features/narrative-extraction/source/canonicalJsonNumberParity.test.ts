import { describe, expect, it } from "vitest";

import numberParityFixture from "../../../../policies/narrative/fixtures/canonical-json-number-parity.json";
import { digestStableJson, stableJsonStringify } from "./digest";

function exactFixtureValue(bits: string | undefined, value: number): number {
  if (!bits) return value;
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setBigUint64(0, BigInt(`0x${bits}`), true);
  return view.getFloat64(0, true);
}

describe("canonical JSON number parity", () => {
  it("matches the ECMAScript number spelling and digest goldens", async () => {
    for (const fixtureCase of numberParityFixture.cases) {
      const value = exactFixtureValue(fixtureCase.bits, fixtureCase.value);
      expect(stableJsonStringify(value), fixtureCase.id).toBe(
        fixtureCase.canonicalJson,
      );
      await expect(digestStableJson(value)).resolves.toBe(fixtureCase.digest);
    }
  });

  it("fails closed for non-JSON numbers", () => {
    expect(() => stableJsonStringify(Number.NaN)).toThrow(/non-finite number/i);
    expect(() => stableJsonStringify(Number.POSITIVE_INFINITY)).toThrow(
      /non-finite number/i,
    );
    expect(() => stableJsonStringify(Number.NEGATIVE_INFINITY)).toThrow(
      /non-finite number/i,
    );
  });
});
