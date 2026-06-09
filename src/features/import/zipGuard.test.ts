import { describe, it, expect } from "vitest";
import type { UnzipFileInfo } from "fflate";
import { zipBombGuard, MAX_ZIP_ENTRIES, MAX_ZIP_TOTAL_BYTES } from "./zipGuard";

/** Minimal UnzipFileInfo for the filter callback. */
function info(name: string, originalSize: number): UnzipFileInfo {
  return { name, size: 0, originalSize } as UnzipFileInfo;
}

describe("zipBombGuard", () => {
  it("accepts normal entries", () => {
    const guard = zipBombGuard();
    expect(guard(info("a.txt", 1000))).toBe(true);
    expect(guard(info("b.txt", 2000))).toBe(true);
  });

  it("bounds cumulative uncompressed size (not compressed size)", () => {
    const guard = zipBombGuard();
    // A single entry declaring a huge originalSize trips the limit even though
    // its compressed size could be tiny — the f.size-vs-originalSize bug class.
    expect(() => guard(info("bomb.txt", MAX_ZIP_TOTAL_BYTES + 1))).toThrow(
      /展開後サイズ/,
    );
  });

  it("rejected entries do not count toward the limits", () => {
    const guard = zipBombGuard((name) => name.endsWith(".md"));
    // Non-.md huge entry is filtered out before counting → no throw, returns false.
    expect(guard(info("huge.bin", MAX_ZIP_TOTAL_BYTES + 1))).toBe(false);
    expect(guard(info("ok.md", 10))).toBe(true);
  });

  it("bounds entry count", () => {
    const guard = zipBombGuard();
    expect(() => {
      for (let i = 0; i <= MAX_ZIP_ENTRIES; i++) guard(info(`f${i}.txt`, 1));
    }).toThrow(/多すぎ/);
  });
});
