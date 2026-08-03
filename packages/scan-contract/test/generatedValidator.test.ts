import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertCspSafeValidatorSource,
  generateScanBundleV1ValidatorSource,
} from "../scripts/generateScanBundleV1Validator.js";
import validateShape from "../src/generated/scanBundleV1Validator.generated.js";

const GENERATED_VALIDATOR_URL = new URL(
  "../src/generated/scanBundleV1Validator.generated.ts",
  import.meta.url,
);
const MINIMAL_FIXTURE_URL = new URL(
  "./fixtures/minimal-ja.json",
  import.meta.url,
);

describe("generated ScanBundleV1 validator", () => {
  it("is fresh and contains no string-based runtime code generation", async () => {
    const actual = await readFile(
      fileURLToPath(GENERATED_VALIDATOR_URL),
      "utf8",
    );
    const expected = generateScanBundleV1ValidatorSource();

    expect(actual).toBe(expected);
    expect(() => assertCspSafeValidatorSource(actual)).not.toThrow();
  });

  it("accepts valid input and reports schema errors for invalid input", async () => {
    const fixture = JSON.parse(
      await readFile(fileURLToPath(MINIMAL_FIXTURE_URL), "utf8"),
    ) as Record<string, unknown>;

    expect(validateShape(fixture)).toBe(true);
    expect(validateShape.errors).toBeNull();

    const invalid = structuredClone(fixture);
    delete invalid.source;

    expect(validateShape(invalid)).toBe(false);
    expect(validateShape.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instancePath: "",
          keyword: "required",
          params: { missingProperty: "source" },
        }),
      ]),
    );
  });
});
