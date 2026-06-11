import { describe, it, expect } from "vitest";
import { applyVerticalWheel } from "./useVerticalWheelScroll";

// 縦書きモードのホイール→横スクロール変換。Chromium の vertical-rl は
// scrollLeft 0 起点・負方向 (editorLayout の論理ヘルパに閉じ込め済み)。

function makeEl(scrollLeft = 0) {
  return { scrollLeft, scrollTop: 0, clientWidth: 800 };
}

const WHEEL = { deltaX: 0, deltaMode: 0, ctrlKey: false };

describe("applyVerticalWheel", () => {
  it("ホイール下 (deltaY>0) で読み進む = scrollLeft が負方向へ動く", () => {
    const el = makeEl(0);
    const handled = applyVerticalWheel(el, { ...WHEEL, deltaY: 120 });
    expect(handled).toBe(true);
    expect(el.scrollLeft).toBe(-120);
  });

  it("ホイール上 (deltaY<0) で読み戻る = scrollLeft が 0 方向へ戻る", () => {
    const el = makeEl(-200);
    applyVerticalWheel(el, { ...WHEEL, deltaY: -80 });
    expect(el.scrollLeft).toBe(-120);
  });

  it("横成分が主のとき (トラックパッド横/Shift+wheel) は奪わない", () => {
    const el = makeEl(0);
    const handled = applyVerticalWheel(el, {
      deltaY: 10,
      deltaX: 40,
      deltaMode: 0,
      ctrlKey: false,
    });
    expect(handled).toBe(false);
    expect(el.scrollLeft).toBe(0);
  });

  it("ctrlKey (ピンチズーム) は奪わない", () => {
    const el = makeEl(0);
    expect(
      applyVerticalWheel(el, { ...WHEEL, deltaY: 120, ctrlKey: true }),
    ).toBe(false);
  });

  it("deltaMode=1 (行単位) は概算ピクセル換算する", () => {
    const el = makeEl(0);
    applyVerticalWheel(el, { ...WHEEL, deltaY: 3, deltaMode: 1 });
    expect(el.scrollLeft).toBe(-48);
  });
});
