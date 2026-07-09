/**
 * supportsVerticalFormControls の probe 契約（実 Chromium）。
 * happy-dom は writing-mode の computed 解決をしないため browser test で gate。
 *
 * Chromium (M119+) はフォームコントロールの縦書きを常にサポートするため
 * true になる。WebKitGTK の「フラグ OFF で horizontal-tb へ強制」側は
 * Chromium では再現できない — そちらは実機ハーネス
 * (scratchpad の beat1 系スクリプト) で検証済み。
 */
import { describe, it, expect } from "vitest";
import { supportsVerticalFormControls } from "./verticalFormControls";

describe("supportsVerticalFormControls", () => {
  it("Chromium では true（縦書き button サポートあり）", () => {
    expect(supportsVerticalFormControls()).toBe(true);
  });

  it("probe 要素を DOM に残さない", () => {
    const before = document.querySelectorAll("button").length;
    supportsVerticalFormControls();
    expect(document.querySelectorAll("button").length).toBe(before);
  });
});
