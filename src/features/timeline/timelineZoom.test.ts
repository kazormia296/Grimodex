import { describe, it, expect } from "vitest";
import {
  computeFitZoom,
  computeZoomScrollLeft,
  zoomFactorFromWheel,
  WHEEL_DELTA_CLAMP,
  WHEEL_ZOOM_SENSITIVITY,
  ZOOM_STEP,
  ZOOM_MIN,
  ZOOM_MAX,
} from "./timelineZoom";

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

describe("computeZoomScrollLeft（zoom-to-cursor）", () => {
  const PAD = 48;

  /** カーソル下の content 点が、ズーム後も同じ画面 px に来ることを検証する不変条件。 */
  function cursorStaysFixed(
    scrollLeft: number,
    cursorX: number,
    padLeft: number,
    prevZoom: number,
    nextZoom: number,
  ) {
    // ズーム前にカーソル下にある content 点（画面 px ではなく content 座標）。
    const contentUnderCursor = scrollLeft + cursorX;
    // その content 点の「ズームに依存しないワールド位置」。
    const world = (contentUnderCursor - padLeft) / prevZoom;
    // ズーム後の同じワールド点の content 座標。
    const contentAfter = padLeft + world * nextZoom;
    const newScroll = computeZoomScrollLeft(
      scrollLeft,
      cursorX,
      padLeft,
      prevZoom,
      nextZoom,
    );
    // ズーム後の画面 px 位置 = contentAfter - newScroll。これが cursorX と一致するはず。
    expect(contentAfter - newScroll).toBeCloseTo(cursorX, 6);
  }

  it("ズームインしてもカーソル下の点は画面上で動かない", () => {
    cursorStaysFixed(100, 400, PAD, 1, 1.25);
  });

  it("ズームアウトしてもカーソル下の点は画面上で動かない", () => {
    cursorStaysFixed(600, 250, PAD, 2, 2 / 1.25);
  });

  it("スクロール 0・カーソルが左端でも不変条件が成り立つ", () => {
    cursorStaysFixed(0, 0, PAD, 1, 1.25);
  });

  it("スレッド表示の広い左ガター（padLeft 大）でも成り立つ", () => {
    cursorStaysFixed(300, 500, 150, 1, 1.25);
  });

  it("具体値: scrollLeft=100, cursorX=400, pad=48, 1→1.25 で 213 を返す", () => {
    // scaled = 100+400-48 = 452, 48 + 452*1.25 - 400 = 213
    expect(computeZoomScrollLeft(100, 400, PAD, 1, 1.25)).toBeCloseTo(213, 6);
  });

  it("倍率が変わらない（限界でクランプ）なら scrollLeft は不変", () => {
    expect(computeZoomScrollLeft(123, 400, PAD, 4, 4)).toBeCloseTo(123, 6);
  });

  it("prevZoom が 0 以下なら scrollLeft をそのまま返す（ゼロ除算ガード）", () => {
    expect(computeZoomScrollLeft(123, 400, PAD, 0, 1.25)).toBe(123);
  });

  it("連続ズーム（バーストの連鎖）でも不変条件が累積で保たれる", () => {
    // 1 回目で得た scrollLeft を 2 回目の base にして連鎖させる（実装の連鎖と同型）。
    const cursorX = 400;
    const z0 = 1;
    const z1 = z0 * ZOOM_STEP;
    const z2 = z1 * ZOOM_STEP;
    const s0 = 100;
    const s1 = computeZoomScrollLeft(s0, cursorX, PAD, z0, z1);
    const s2 = computeZoomScrollLeft(s1, cursorX, PAD, z1, z2);
    // z0→z2 を 1 回で計算したものと一致するはず（連鎖 == 直接）。
    const direct = computeZoomScrollLeft(s0, cursorX, PAD, z0, z2);
    expect(s2).toBeCloseTo(direct, 6);
  });
});

describe("zoomFactorFromWheel（連続ホイールズーム）", () => {
  it("上スクロール(deltaY<0)は拡大(>1)・下スクロール(deltaY>0)は縮小(<1)", () => {
    expect(zoomFactorFromWheel(-100)).toBeGreaterThan(1);
    expect(zoomFactorFromWheel(100)).toBeLessThan(1);
  });

  it("deltaY=0 は等倍（ズームしない）", () => {
    expect(zoomFactorFromWheel(0)).toBe(1);
  });

  it("上下対称（factor(-d) × factor(d) = 1）", () => {
    expect(zoomFactorFromWheel(-80) * zoomFactorFromWheel(80)).toBeCloseTo(
      1,
      6,
    );
  });

  it("deltaY が大きいほど倍率の振れも大きい（連続・単調）", () => {
    // 小さい delta = 1 に近い（=細かい刻み）/ 大きい delta = より拡大。
    expect(zoomFactorFromWheel(-5)).toBeGreaterThan(1);
    expect(zoomFactorFromWheel(-5)).toBeLessThan(zoomFactorFromWheel(-40));
    expect(zoomFactorFromWheel(-40)).toBeLessThan(zoomFactorFromWheel(-100));
  });

  it("小さな delta（トラックパッド）はほぼ等倍＝滑らかな微小ステップ", () => {
    const f = zoomFactorFromWheel(-4);
    expect(f).toBeGreaterThan(1);
    expect(f).toBeLessThan(1.02);
  });

  it("1イベントの効きは WHEEL_DELTA_CLAMP で頭打ち（慣性/暴れ対策）", () => {
    const capped = Math.exp(WHEEL_DELTA_CLAMP * WHEEL_ZOOM_SENSITIVITY);
    expect(zoomFactorFromWheel(-100000)).toBeCloseTo(capped, 6);
    expect(zoomFactorFromWheel(100000)).toBeCloseTo(1 / capped, 6);
  });

  it("行モード(deltaMode=1)はピクセル換算され、同じ数値でも効きが強い", () => {
    expect(zoomFactorFromWheel(-3, 1)).toBeGreaterThan(
      zoomFactorFromWheel(-3, 0),
    );
  });

  it("マウス1ノッチ(≈100px)は旧 1.25x 刻みに近い体感", () => {
    // 連続化しても1ノッチの拡大量が極端に変わらないことを担保（回帰ガード）。
    expect(zoomFactorFromWheel(-100)).toBeGreaterThan(1.1);
    expect(zoomFactorFromWheel(-100)).toBeLessThan(1.35);
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
