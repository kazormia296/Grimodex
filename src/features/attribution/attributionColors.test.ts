import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  ATTRIBUTION_COLORS,
  ATTRIBUTION_COLOR_VARS,
} from "./attributionColors";

describe("attributionColors（帰属カラーの正本）", () => {
  const sources = ["human", "ai", "unknown"] as const;

  it("3 ソースすべてに literal と CSS 変数を定義している", () => {
    for (const s of sources) {
      expect(ATTRIBUTION_COLORS[s]).toBeTruthy();
      expect(ATTRIBUTION_COLOR_VARS[s]).toBe(`var(--attribution-${s})`);
    }
  });

  it("literal 値は oklch 表記（SVG/canvas フォールバック用）", () => {
    for (const s of sources) {
      expect(ATTRIBUTION_COLORS[s]).toMatch(/^oklch\(/);
    }
  });

  it("AI=teal(165°) / unknown=amber(30°) の本文オーバーレイ色と一致する", () => {
    // index.css の .attribution-ai / .attribution-unknown と同値であること。
    expect(ATTRIBUTION_COLORS.ai).toBe("oklch(0.72 0.2 165)");
    expect(ATTRIBUTION_COLORS.unknown).toBe("oklch(0.72 0.14 30)");
  });

  it("index.css の :root --attribution-* と literal がドリフトしていない", () => {
    // literal フォールバック(SVG/canvas)と CSS 変数の値源が分かれているため、
    // 実ファイルを読んで一致を gate する（コメントの「必ず一致」を機械検証）。
    const cssPath = fileURLToPath(new URL("../../index.css", import.meta.url));
    const css = readFileSync(cssPath, "utf8");
    for (const s of sources) {
      const m = css.match(new RegExp(`\\s--attribution-${s}:\\s*([^;]+);`));
      expect(m, `--attribution-${s} が index.css に見つからない`).toBeTruthy();
      expect(m![1].trim()).toBe(ATTRIBUTION_COLORS[s]);
    }
  });
});
