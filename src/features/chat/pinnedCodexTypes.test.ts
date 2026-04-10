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

  it("normalizes old string[] format (defaults type to codex)", () => {
    expect(normalizePinnedCodex(["id-1", "id-2"])).toEqual([
      { id: "id-1", type: "codex", withChildren: false },
      { id: "id-2", type: "codex", withChildren: false },
    ]);
  });

  it("normalizes new PinnedCodexEntry[] format (defaults type to codex when missing)", () => {
    expect(
      normalizePinnedCodex([
        { id: "id-1", withChildren: true },
        { id: "id-2", withChildren: false },
      ]),
    ).toEqual([
      { id: "id-1", type: "codex", withChildren: true, source: undefined },
      { id: "id-2", type: "codex", withChildren: false, source: undefined },
    ]);
  });

  it("preserves type=snippet", () => {
    expect(
      normalizePinnedCodex([
        { id: "snip-1", type: "snippet", withChildren: false },
      ]),
    ).toEqual([
      { id: "snip-1", type: "snippet", withChildren: false, source: undefined },
    ]);
  });

  it("defaults withChildren to false when missing in object", () => {
    expect(normalizePinnedCodex([{ id: "id-1" }])).toEqual([
      { id: "id-1", type: "codex", withChildren: false, source: undefined },
    ]);
  });

  it("filters out invalid entries", () => {
    expect(
      normalizePinnedCodex([null, 42, { noId: true }, "valid-id"]),
    ).toEqual([{ id: "valid-id", type: "codex", withChildren: false }]);
  });

  it("handles empty array", () => {
    expect(normalizePinnedCodex([])).toEqual([]);
  });
});
