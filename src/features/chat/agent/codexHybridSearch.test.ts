import { describe, it, expect } from "vitest";
import { fuseCodexHybrid } from "./codexHybridSearch";
import type { CodexSearchHit } from "@/features/semantic-search/api";

function hit(
  entryId: string,
  score: number,
  extra?: Partial<CodexSearchHit>,
): CodexSearchHit {
  return {
    entryId,
    entryName: extra?.entryName ?? `name-${entryId}`,
    entryType: extra?.entryType ?? "character",
    summary: extra?.summary ?? `summary-${entryId}`,
    score,
  };
}

function row(id: string, name = `s-${id}`) {
  return { id, name, type: "location", summary: `srow-${id}` };
}

describe("fuseCodexHybrid", () => {
  it("returns dense order when sparse is empty", () => {
    const dense = [hit("a", 0.9), hit("b", 0.8), hit("c", 0.7)];
    const out = fuseCodexHybrid(dense, [], 10);
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("returns sparse order when dense is empty", () => {
    const sparse = [row("x"), row("y"), row("z")];
    const out = fuseCodexHybrid([], sparse, 10);
    expect(out.map((r) => r.id)).toEqual(["x", "y", "z"]);
  });

  it("boosts an entry present in both arms above singletons", () => {
    // 'b' is rank1 in dense and rank0 in sparse → RRF sum beats rank0-only peers.
    const dense = [hit("a", 0.95), hit("b", 0.6)];
    const sparse = [row("b"), row("c")];
    const out = fuseCodexHybrid(dense, sparse, 10);
    // b: 1/(60+1) + 1/(60+0) ≈ 0.01639+0.01667 = 0.03306 (highest)
    // a: 1/(60+0) = 0.01667 ; c: 1/(60+1) = 0.01639
    expect(out[0].id).toBe("b");
    expect(out.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("prefers dense data (name/type/summary) for entries in both arms", () => {
    const dense = [
      hit("b", 0.5, {
        entryName: "DenseName",
        entryType: "item",
        summary: "dense summary",
      }),
    ];
    const sparse = [
      {
        id: "b",
        name: "SparseName",
        type: "location",
        summary: "sparse summary",
      },
    ];
    const out = fuseCodexHybrid(dense, sparse, 10);
    expect(out[0]).toEqual({
      id: "b",
      name: "DenseName",
      type: "item",
      summary: "dense summary",
    });
  });

  it("uses sparse row data for entries only in sparse", () => {
    const dense = [hit("a", 0.9)];
    const sparse = [{ id: "z", name: "Zed", type: "lore", summary: "z sum" }];
    const out = fuseCodexHybrid(dense, sparse, 10);
    const z = out.find((r) => r.id === "z");
    expect(z).toEqual({ id: "z", name: "Zed", type: "lore", summary: "z sum" });
  });

  it("re-sorts dense defensively by score and dedups repeated ids", () => {
    const dense = [hit("a", 0.2), hit("b", 0.9), hit("a", 0.99)];
    const out = fuseCodexHybrid(dense, [], 10);
    // first occurrence after score-sort: a(0.99) rank0, b(0.9) rank1, a(0.2) ignored
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("caps results at limit", () => {
    const dense = [hit("a", 0.9), hit("b", 0.8), hit("c", 0.7), hit("d", 0.6)];
    const out = fuseCodexHybrid(dense, [], 2);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("breaks rrf ties by dense score then id", () => {
    // a and b both only in dense at distinct ranks → no tie. Force a tie via sparse:
    // a: dense rank0 (score 0.5). b: sparse rank0. Different arms, same rrf 1/60.
    const dense = [hit("a", 0.5)];
    const sparse = [row("b")];
    const out = fuseCodexHybrid(dense, sparse, 10);
    // equal rrf → higher dense score wins: a has score 0.5, b has 0 → a first.
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });
});
