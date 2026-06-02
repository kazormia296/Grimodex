import { describe, it, expect } from "vitest";
import { clampMarkRange, resolveAnchorLoads } from "./anchorLoads";

// resolveAnchorLoads は 3 並列リード(allSettled) の結果を畳み込む純関数。
// 検証対象の invariant は「部分適用」: 1 件が rejected でも残り 2 件は適用され、
// rejected は errors にラベル付きで残る。PromiseSettledResult は実形を直接構築する。

// loadAuthorshipSpans → AuthorshipSpan[] / loadForeshadowAnchors → MarkApplication[]
// は配列。listAnnotationsForScene → AnnotationsForSceneResponse(.annotations を持つ
// オブジェクト、配列ではない)。fake は最小限の形だけ作る(純関数は形を見ない)。
const SPANS = [{ fromPos: 0, toPos: 3, source: "ai" }] as never;
const FORESHADOW = [
  { from: 1, to: 4, markName: "foreshadowSetup", attrs: {} },
] as never;
const ANNOTATIONS = { annotations: [{ id: "a1" }], relations: [] } as never;

const fulfilled = <T>(value: T): PromiseSettledResult<T> => ({
  status: "fulfilled",
  value,
});
const rejected = <T>(reason: unknown): PromiseSettledResult<T> => ({
  status: "rejected",
  reason,
});

describe("resolveAnchorLoads", () => {
  it("all fulfilled → all values returned, errors empty", () => {
    const result = resolveAnchorLoads(
      fulfilled(SPANS),
      fulfilled(FORESHADOW),
      fulfilled(ANNOTATIONS),
    );
    expect(result.spans).toBe(SPANS);
    expect(result.foreshadowMarks).toBe(FORESHADOW);
    expect(result.annotations).toBe(ANNOTATIONS);
    expect(result.errors).toEqual([]);
  });

  it("spans rejected → spans [] + one error authorshipSpans, others still applied", () => {
    const reason = new Error("spans boom");
    const result = resolveAnchorLoads(
      rejected(reason),
      fulfilled(FORESHADOW),
      fulfilled(ANNOTATIONS),
    );
    expect(result.spans).toEqual([]);
    // 部分適用: 残り 2 件は通常どおり適用される
    expect(result.foreshadowMarks).toBe(FORESHADOW);
    expect(result.annotations).toBe(ANNOTATIONS);
    expect(result.errors).toEqual([{ label: "authorshipSpans", reason }]);
  });

  it("foreshadow rejected → foreshadowMarks [] + one error foreshadowAnchors, others applied", () => {
    const reason = new Error("foreshadow boom");
    const result = resolveAnchorLoads(
      fulfilled(SPANS),
      rejected(reason),
      fulfilled(ANNOTATIONS),
    );
    expect(result.foreshadowMarks).toEqual([]);
    expect(result.spans).toBe(SPANS);
    expect(result.annotations).toBe(ANNOTATIONS);
    expect(result.errors).toEqual([{ label: "foreshadowAnchors", reason }]);
  });

  it("annotations rejected → annotations null + one error annotations, others applied", () => {
    const reason = new Error("annotations boom");
    const result = resolveAnchorLoads(
      fulfilled(SPANS),
      fulfilled(FORESHADOW),
      rejected(reason),
    );
    expect(result.annotations).toBeNull();
    expect(result.spans).toBe(SPANS);
    expect(result.foreshadowMarks).toBe(FORESHADOW);
    expect(result.errors).toEqual([{ label: "annotations", reason }]);
  });

  it("two rejected → two errors, the fulfilled one still applied", () => {
    const spansReason = new Error("spans boom");
    const annReason = new Error("annotations boom");
    const result = resolveAnchorLoads(
      rejected(spansReason),
      fulfilled(FORESHADOW),
      rejected(annReason),
    );
    expect(result.spans).toEqual([]);
    expect(result.annotations).toBeNull();
    // 残り 1 件は適用される
    expect(result.foreshadowMarks).toBe(FORESHADOW);
    expect(result.errors).toEqual([
      { label: "authorshipSpans", reason: spansReason },
      { label: "annotations", reason: annReason },
    ]);
  });
});

describe("clampMarkRange", () => {
  it("returns the range unchanged when within doc size", () => {
    expect(clampMarkRange(2, 5, 10)).toEqual({ from: 2, to: 5 });
  });

  it("clamps both ends to doc size (stale anchor past doc end)", () => {
    // from/to are beyond a now-shorter doc → both clamp to docSize, collapsing
    // to an empty range → null (the addMark is skipped, no stale apply).
    expect(clampMarkRange(8, 20, 6)).toBeNull();
  });

  it("clamps only the end when it overruns but start is still in range", () => {
    expect(clampMarkRange(3, 20, 6)).toEqual({ from: 3, to: 6 });
  });

  it("returns null for an empty range (from === to)", () => {
    expect(clampMarkRange(4, 4, 10)).toBeNull();
  });

  it("returns null for an inverted range (from > to)", () => {
    expect(clampMarkRange(7, 2, 10)).toBeNull();
  });

  it("returns null when the whole range is at/after doc end", () => {
    expect(clampMarkRange(6, 9, 6)).toBeNull();
  });
});
