import type { CSSProperties } from "react";
import { boundingRect, type FocusRect } from "./spotlight";

// ツアーカードの配置幾何（純ロジック）。SampleTour の UI 依存（gsap/motion）から
// 切り出して happy-dom で単体テスト可能にする。
export const CARD_WIDTH = 384;
export const CARD_GAP = 16;
export const VIEWPORT_PAD = 16;
export const CARD_ESTIMATED_HEIGHT = 200;

/**
 * フォーカス矩形（spotlight の穴）に対してツアーカードを配置する CSS を返す。
 * 右 → 左 → 下 → 上 の順に収まる側を選び、viewport 端で clamp する。
 * isEnd / 矩形なし / viewport 未計測 のときは中央 or 下中央にフォールバック。
 */
export function computeCardStyle(
  focusRects: FocusRect[],
  vw: number,
  vh: number,
  isEnd: boolean,
): CSSProperties {
  const r = boundingRect(focusRects);
  if (isEnd || !r || !vw || !vh) {
    return isEnd
      ? { left: "50%", top: "50%", transform: "translate(-50%, -50%)" }
      : { left: "50%", bottom: 24, transform: "translateX(-50%)" };
  }
  const clampTop = (t: number) =>
    Math.max(
      VIEWPORT_PAD,
      Math.min(t, vh - CARD_ESTIMATED_HEIGHT - VIEWPORT_PAD),
    );
  const clampLeft = (l: number) =>
    Math.max(VIEWPORT_PAD, Math.min(l, vw - CARD_WIDTH - VIEWPORT_PAD));

  // Right of panel
  const rightX = r.left + r.width + CARD_GAP;
  if (rightX + CARD_WIDTH + VIEWPORT_PAD <= vw) {
    return { left: rightX, top: clampTop(r.top) };
  }
  // Left of panel
  const leftX = r.left - CARD_GAP - CARD_WIDTH;
  if (leftX >= VIEWPORT_PAD) {
    return { left: leftX, top: clampTop(r.top) };
  }
  // Below panel
  const belowY = r.top + r.height + CARD_GAP;
  if (belowY + CARD_ESTIMATED_HEIGHT + VIEWPORT_PAD <= vh) {
    return {
      left: clampLeft(r.left + r.width / 2 - CARD_WIDTH / 2),
      top: belowY,
    };
  }
  // Above panel
  const aboveY = r.top - CARD_GAP - CARD_ESTIMATED_HEIGHT;
  if (aboveY >= VIEWPORT_PAD) {
    return {
      left: clampLeft(r.left + r.width / 2 - CARD_WIDTH / 2),
      top: aboveY,
    };
  }
  // Fallback: bottom-center
  return { left: "50%", bottom: 24, transform: "translateX(-50%)" };
}
