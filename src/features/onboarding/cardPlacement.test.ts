// @vitest-environment happy-dom
//
// ツアーカード配置の純幾何（右→左→下→上 の側選択 + viewport clamp + フォールバック）を gate。
// SampleTour の UI 依存から切り出した cardPlacement の computeCardStyle をリテラル矩形で検証。
import { describe, it, expect } from "vitest";
import { computeCardStyle } from "./cardPlacement";
import type { FocusRect } from "./spotlight";

const VW = 1200;
const VH = 768;
const rect = (
  left: number,
  top: number,
  width = 50,
  height = 50,
): FocusRect => ({
  left,
  top,
  width,
  height,
});

describe("computeCardStyle", () => {
  it("右に収まれば panel の右に置く", () => {
    expect(computeCardStyle([rect(100, 100)], VW, VH, false)).toEqual({
      left: 166, // 100 + 50 + CARD_GAP(16)
      top: 100,
    });
  });

  it("右が溢れたら左に置く", () => {
    // left=1000 → rightX=1066, +384+16=1466 > 1200 → 左 leftX=1000-16-384=600
    expect(computeCardStyle([rect(1000, 100)], VW, VH, false)).toEqual({
      left: 600,
      top: 100,
    });
  });

  it("左右とも不可なら下に置く（中央寄せ + clamp）", () => {
    // narrow vw=500, 幅広 rect: right/left 不可 → below belowY=116, left=clampLeft(58)=58
    expect(computeCardStyle([rect(50, 50, 400, 50)], 500, VH, false)).toEqual({
      left: 58,
      top: 116,
    });
  });

  it("下も不可なら上に置く", () => {
    // vw=500, rect 下端 top=600 → below 不可(882>768) → above aboveY=384
    expect(computeCardStyle([rect(50, 600, 400, 50)], 500, VH, false)).toEqual({
      left: 58,
      top: 384,
    });
  });

  it("top は viewport 上端 (VIEWPORT_PAD) で clamp される", () => {
    // rect top=-100（画面外上）でも右配置の top は 16 に clamp
    expect(computeCardStyle([rect(100, -100)], VW, VH, false)).toEqual({
      left: 166,
      top: 16,
    });
  });

  it("isEnd は画面中央", () => {
    expect(computeCardStyle([rect(100, 100)], VW, VH, true)).toEqual({
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)",
    });
  });

  it("矩形が無ければ下中央フォールバック", () => {
    expect(computeCardStyle([], VW, VH, false)).toEqual({
      left: "50%",
      bottom: 24,
      transform: "translateX(-50%)",
    });
  });
});
