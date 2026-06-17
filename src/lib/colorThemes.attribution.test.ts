import { describe, it, expect } from "vitest";
import { COLOR_THEMES, THEME_CSS_VARS } from "./colorThemes";

// 帰属(authorship)色の per-theme チューニング（戦略A）を固定する。
// 方針: 色相は全テーマ共通（human=220° / ai=165° / unknown=30°）、
// 明度・彩度のみ theme×mode で調整。dark は暗背景での視認性のため light より明るく。

const ATTR_VARS = [
  "--attribution-human",
  "--attribution-ai",
  "--attribution-unknown",
] as const;

const EXPECTED_HUE: Record<(typeof ATTR_VARS)[number], number> = {
  "--attribution-human": 220,
  "--attribution-ai": 165,
  "--attribution-unknown": 30,
};

function parseOklch(v: string): { L: number; C: number; H: number } {
  const m = v.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  expect(m, `oklch(L C H) 形式であること: ${v}`).toBeTruthy();
  return { L: Number(m![1]), C: Number(m![2]), H: Number(m![3]) };
}

describe("colorThemes 帰属色（per-theme tuning / 戦略A）", () => {
  it("THEME_CSS_VARS に 3 つの attribution 変数が含まれる（applyTheme が適用する）", () => {
    for (const v of ATTR_VARS) expect(THEME_CSS_VARS).toContain(v);
  });

  it("全テーマ×light/dark で 3 色を定義し、色相は固定（意味を保つ）", () => {
    for (const theme of COLOR_THEMES) {
      for (const mode of ["light", "dark"] as const) {
        for (const v of ATTR_VARS) {
          const val = theme[mode][v];
          expect(val, `${theme.id}.${mode}.${v} が未定義`).toBeTruthy();
          expect(
            parseOklch(val).H,
            `${theme.id}.${mode}.${v} の色相は ${EXPECTED_HUE[v]}° 固定`,
          ).toBe(EXPECTED_HUE[v]);
        }
      }
    }
  });

  it("dark は light より明るい（暗背景での視認性確保＝今回の目的）", () => {
    for (const theme of COLOR_THEMES) {
      for (const v of ATTR_VARS) {
        const lightL = parseOklch(theme.light[v]).L;
        const darkL = parseOklch(theme.dark[v]).L;
        expect(
          darkL,
          `${theme.id}.${v}: dark L(${darkL}) > light L(${lightL})`,
        ).toBeGreaterThan(lightL);
      }
    }
  });
});
