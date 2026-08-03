// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { computeBubblePosition } from "./EditorBubbleMenu";

const EDGE = 8;

describe("computeBubblePosition", () => {
  it("returns a zeroed position when there is no selection rect", () => {
    expect(computeBubblePosition(null, 460, 1200)).toEqual({
      top: 0,
      left: 0,
      placeBelow: false,
    });
  });

  it("places the menu above the selection when there is room", () => {
    const rect = new DOMRect(400, 300, 100, 20); // top=300
    const pos = computeBubblePosition(rect, 460, 1200);
    expect(pos.placeBelow).toBe(false);
    expect(pos.top).toBe(300 - 8); // rect.top - GAP
  });

  it("flips below the selection when it is too close to the top", () => {
    const rect = new DOMRect(400, 10, 100, 20); // top=10 (< EST_HEIGHT+GAP)
    const pos = computeBubblePosition(rect, 460, 1200);
    expect(pos.placeBelow).toBe(true);
    expect(pos.top).toBe(30 + 8); // rect.bottom + GAP
  });

  it("keeps a left-edge selection's menu fully on screen", () => {
    const rect = new DOMRect(0, 300, 20, 20); // center ≈ 10 (far left)
    const menuWidth = 460;
    const { left } = computeBubblePosition(rect, menuWidth, 1200);
    // translate(-50%) を踏まえた実 box の左端が画面内に収まる。
    expect(left - menuWidth / 2).toBeGreaterThanOrEqual(EDGE - 0.001);
  });

  it("keeps a right-edge selection's menu fully on screen", () => {
    const vw = 1200;
    const rect = new DOMRect(vw - 20, 300, 20, 20); // center ≈ vw (far right)
    const menuWidth = 460;
    const { left } = computeBubblePosition(rect, menuWidth, vw);
    expect(left + menuWidth / 2).toBeLessThanOrEqual(vw - EDGE + 0.001);
  });

  it("centers on the selection when it fits comfortably", () => {
    const rect = new DOMRect(560, 300, 80, 20); // center = 600
    const { left } = computeBubblePosition(rect, 460, 1200);
    expect(left).toBe(600);
  });

  it("falls back to viewport center when the menu cannot fit", () => {
    const rect = new DOMRect(10, 300, 20, 20);
    const { left } = computeBubblePosition(rect, 460, 300); // vw too narrow
    expect(left).toBe(150); // vw / 2
  });

  it("uses the estimated width before a measurement is available", () => {
    // menuWidth=0 → EST_WIDTH(520) で保守的にクランプ (初回フレームも画面外に出ない)。
    const rect = new DOMRect(0, 300, 20, 20);
    const { left } = computeBubblePosition(rect, 0, 1200);
    expect(left).toBeGreaterThanOrEqual(520 / 2 + EDGE - 0.001);
  });
});
