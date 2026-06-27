// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { useAnchoredPopover } from "./useAnchoredPopover";

/** getBoundingClientRect を固定したトリガ要素の ref を作る。 */
function triggerRefWithRect(rect: Partial<DOMRect>): RefObject<HTMLElement> {
  const el = document.createElement("button");
  document.body.appendChild(el);
  el.getBoundingClientRect = () =>
    ({
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      ...rect,
      toJSON: () => ({}),
    }) as DOMRect;
  return { current: el };
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(window, "innerHeight", {
    value: height,
    configurable: true,
  });
}

describe("useAnchoredPopover viewport clamp", () => {
  beforeEach(() => {
    setViewport(1200, 800);
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("top-start: maxHeight をトリガ上の空き空間にクランプし、style には混ぜない", () => {
    const ref = triggerRefWithRect({
      top: 600,
      bottom: 620,
      left: 40,
      right: 140,
    });
    const { result } = renderHook(() =>
      useAnchoredPopover(ref, true, () => {}, "top-start"),
    );
    // 上の空き = top(600) - margin*2(8) = 592
    expect(result.current.maxHeight).toBe(592);
    // 下端をトリガ上端に合わせる: innerHeight - top + margin = 800-600+4 = 204
    expect(result.current.style?.bottom).toBe(204);
    expect(result.current.style?.left).toBe(40);
    // maxHeight は style に混ぜない(呼び出し側の max-h-* クラスを壊さないため)。
    expect(result.current.style?.maxHeight).toBeUndefined();
  });

  it("bottom-start: maxHeight をトリガ下の空き空間にクランプする", () => {
    const ref = triggerRefWithRect({
      top: 180,
      bottom: 200,
      left: 40,
      right: 140,
    });
    const { result } = renderHook(() =>
      useAnchoredPopover(ref, true, () => {}, "bottom-start"),
    );
    // 下の空き = innerHeight(800) - bottom(200) - margin*2(8) = 592
    expect(result.current.maxHeight).toBe(592);
    expect(result.current.style?.top).toBe(204);
  });

  it("空きがほぼ無くても 120px の下限を割らない", () => {
    const ref = triggerRefWithRect({
      top: 50,
      bottom: 70,
      left: 40,
      right: 140,
    });
    const { result } = renderHook(() =>
      useAnchoredPopover(ref, true, () => {}, "top-start"),
    );
    // top(50) - 8 = 42 < 120 → 120 にクランプ
    expect(result.current.maxHeight).toBe(120);
  });

  it("閉じている間は style も maxHeight も null", () => {
    const ref = triggerRefWithRect({ top: 600, bottom: 620 });
    const { result } = renderHook(() =>
      useAnchoredPopover(ref, false, () => {}, "top-start"),
    );
    expect(result.current.style).toBeNull();
    expect(result.current.maxHeight).toBeNull();
  });
});
