import { describe, it, expect } from "vitest";
import { normalizePinnedCodex } from "./pinnedCodexTypes";

describe("normalizePinnedCodex", () => {
  it("returns empty array for null input", () => {
    expect(normalizePinnedCodex(null)).toEqual([]);
  });

  it("returns empty array for non-array input", () => {
    expect(normalizePinnedCodex("string")).toEqual([]);
    expect(normalizePinnedCodex(42)).toEqual([]);
    expect(normalizePinnedCodex({})).toEqual([]);
  });

  it("normalizes old string[] format", () => {
    expect(normalizePinnedCodex(["id-1", "id-2"])).toEqual([
      { id: "id-1", withChildren: false },
      { id: "id-2", withChildren: false },
    ]);
  });

  it("normalizes new PinnedCodexEntry[] format", () => {
    expect(
      normalizePinnedCodex([
        { id: "id-1", withChildren: true },
        { id: "id-2", withChildren: false },
      ]),
    ).toEqual([
      { id: "id-1", withChildren: true },
      { id: "id-2", withChildren: false },
    ]);
  });

  it("defaults withChildren to false when missing in object", () => {
    expect(normalizePinnedCodex([{ id: "id-1" }])).toEqual([
      { id: "id-1", withChildren: false },
    ]);
  });

  it("filters out invalid entries", () => {
    expect(
      normalizePinnedCodex([null, 42, { noId: true }, "valid-id"]),
    ).toEqual([{ id: "valid-id", withChildren: false }]);
  });

  it("handles empty array", () => {
    expect(normalizePinnedCodex([])).toEqual([]);
  });
});
