import { describe, it, expect } from "vitest";
import { computeFitZoom, ZOOM_STEP, ZOOM_MIN, ZOOM_MAX } from "./timelineZoom";

describe("computeFitZoom", () => {
  it("パディングを除いた usable 幅でズームを計算する", () => {
    // usable = 560 - 80 = 480px、10シーン × 96 = 960px → zoom = 480/960 = 0.5
    const zoom = computeFitZoom(10, 560, 96, 80);
    expect(zoom).toBeCloseTo(0.5, 2);
  });

  it("シーン数が0のときは ZOOM_MIN を返す", () => {
    expect(computeFitZoom(0, 480, 96, 80)).toBe(ZOOM_MIN);
  });

  it("コンテナ幅が0のときは ZOOM_MIN を返す", () => {
    expect(computeFitZoom(10, 0, 96, 80)).toBe(ZOOM_MIN);
  });

  it("計算結果は [ZOOM_MIN, ZOOM_MAX] にクランプされる", () => {
    // 大量シーン → クランプされて ZOOM_MIN
    expect(computeFitZoom(10000, 480, 96, 80)).toBe(ZOOM_MIN);
    // 1シーンでコンテナ幅が広い → クランプされて ZOOM_MAX
    expect(computeFitZoom(1, 10000, 96, 80)).toBe(ZOOM_MAX);
  });
});

describe("zoom constants", () => {
  it("ZOOM_STEP は 1 より大きい (1.25x 程度)", () => {
    expect(ZOOM_STEP).toBeGreaterThan(1);
    expect(ZOOM_STEP).toBeLessThan(2);
  });

  it("ZOOM_MIN と ZOOM_MAX の範囲が妥当", () => {
    expect(ZOOM_MIN).toBeGreaterThan(0);
    expect(ZOOM_MIN).toBeLessThan(1);
    expect(ZOOM_MAX).toBeGreaterThan(1);
  });
});
