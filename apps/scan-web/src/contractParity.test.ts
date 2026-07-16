import { describe, expect, it } from "vitest";
import { parseEditorSeed, parseScanBundle } from "@grimodex/scan-contract";
import {
  createMinimalJaBundle,
  createMinimalJaSeed,
} from "./fixtures/minimalJa";

describe("ScanBundle cross-runtime serialization", () => {
  it("round-trips the same fixture through browser JSON parsing", () => {
    const bundle = createMinimalJaBundle();
    const serialized = JSON.stringify(bundle);
    const parsed = parseScanBundle(JSON.parse(serialized));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(JSON.stringify(parsed.value)).toBe(serialized);
  });

  it("validates the editor seed at the browser boundary", () => {
    expect(
      parseEditorSeed(JSON.parse(JSON.stringify(createMinimalJaSeed()))).ok,
    ).toBe(true);
  });
});
