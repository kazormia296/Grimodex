import { describe, it, expect } from "vitest";
import { blockCacheKey, toRelative, toAbsolute } from "./lintStore";
import type { Diagnostic, WireLintBlock } from "./types";

function block(
  kind: WireLintBlock["kind"],
  text: string,
  offset = 0,
): WireLintBlock {
  return { id: 0, kind, text, str_offset_start: offset };
}

function diag(start: number, end: number, ruleId = "ja/foo"): Diagnostic {
  return {
    rule_id: ruleId,
    severity: "warning",
    message: "test",
    range: { start, end },
  };
}

function diagWithFix(
  start: number,
  end: number,
  fixStart: number,
  fixEnd: number,
): Diagnostic {
  return {
    rule_id: "ja/foo",
    severity: "warning",
    message: "test",
    range: { start, end },
    fix: {
      label: "fix",
      replacement: "x",
      range: { start: fixStart, end: fixEnd },
    },
  };
}

// ---------------------------------------------------------------------------
// blockCacheKey
// ---------------------------------------------------------------------------

describe("blockCacheKey", () => {
  it("different kind same text → different key", () => {
    const a = block("paragraph", "hello");
    const b = block("heading", "hello");
    expect(blockCacheKey(a)).not.toBe(blockCacheKey(b));
  });

  it("same kind different text → different key", () => {
    const a = block("paragraph", "hello");
    const b = block("paragraph", "world");
    expect(blockCacheKey(a)).not.toBe(blockCacheKey(b));
  });

  it("same kind same text at different offsets → same key", () => {
    const a = block("paragraph", "hello", 0);
    const b = block("paragraph", "hello", 100);
    expect(blockCacheKey(a)).toBe(blockCacheKey(b));
  });
});

// ---------------------------------------------------------------------------
// toRelative / toAbsolute round-trip
// ---------------------------------------------------------------------------

describe("toRelative / toAbsolute", () => {
  it("round-trips range offsets", () => {
    const original = diag(100, 110);
    const rel = toRelative(original, 100);
    expect(rel.range).toEqual({ start: 0, end: 10 });
    const abs = toAbsolute(rel, 100);
    expect(abs.range).toEqual(original.range);
  });

  it("round-trips fix range offsets", () => {
    const original = diagWithFix(100, 110, 100, 110);
    const rel = toRelative(original, 100);
    expect(rel.fix?.range).toEqual({ start: 0, end: 10 });
    const abs = toAbsolute(rel, 100);
    expect(abs.fix?.range).toEqual(original.fix?.range);
  });

  it("preserves non-range fields unchanged", () => {
    const original = diag(50, 60, "ja/test-rule");
    const rel = toRelative(original, 50);
    expect(rel.rule_id).toBe("ja/test-rule");
    expect(rel.severity).toBe("warning");
    expect(rel.message).toBe("test");
  });

  it("no fix → fix stays undefined after round-trip", () => {
    const original = diag(10, 20);
    const rel = toRelative(original, 10);
    expect(rel.fix).toBeUndefined();
    const abs = toAbsolute(rel, 10);
    expect(abs.fix).toBeUndefined();
  });

  it("shifting cached relative diag by new offset gives correct absolute", () => {
    // Block content doesn't change but the block moves (block above grew).
    // Original block was at offset 100, now at offset 150.
    const original = diag(110, 120); // absolute, block at 100
    const rel = toRelative(original, 100); // relative: {10, 20}
    const reAbsolute = toAbsolute(rel, 150); // new offset 150
    expect(reAbsolute.range).toEqual({ start: 160, end: 170 });
  });
});
