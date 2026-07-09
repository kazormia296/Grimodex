// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { RefObject } from "react";

let mockWebKitGtk = true;
vi.mock("@/lib/platform", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/platform")>();
  return { ...mod, isWebKitGtk: () => mockWebKitGtk };
});

import { useWebKitGtkVerticalScrollResetGuard } from "./useWebKitGtkVerticalScrollResetGuard";

// happy-dom の Element.prototype に scrollLeft accessor が無い環境でも
// テストできるよう、素の accessor を prototype 相当のオブジェクトに立てて
// el に継承させる。
function makeScroller(): {
  el: HTMLElement;
  engineSet: (v: number) => void;
  protoGet: () => number;
} {
  const el = document.createElement("div");
  let value = 0;
  const proto = Object.create(Object.getPrototypeOf(el) as object);
  Object.defineProperty(proto, "scrollLeft", {
    configurable: true,
    get() {
      return value;
    },
    set(v: number) {
      value = v;
    },
  });
  Object.setPrototypeOf(el, proto);
  document.body.appendChild(el);
  return {
    el,
    // エンジン由来のリセットを模擬: JS の setter (インスタンス shadow) を
    // 経由せず prototype accessor へ直接書いて scroll イベントを発火する
    engineSet(v: number) {
      Object.getOwnPropertyDescriptor(proto, "scrollLeft")!.set!.call(el, v);
      el.dispatchEvent(new Event("scroll"));
    },
    protoGet: () => value,
  };
}

function mount(el: HTMLElement, vertical = true) {
  const ref: RefObject<HTMLElement | null> = { current: el };
  return renderHook(() => useWebKitGtkVerticalScrollResetGuard(ref, vertical));
}

describe("useWebKitGtkVerticalScrollResetGuard", () => {
  beforeEach(() => {
    mockWebKitGtk = true;
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("エンジン由来の 0 リセットを直前値へ同期復元する", () => {
    const { el, engineSet, protoGet } = makeScroller();
    mount(el);

    // JS で読み進める（shadow setter 経由 = 書き込み時刻が記録される）
    el.scrollLeft = -1000;
    el.dispatchEvent(new Event("scroll"));

    // JS 書き込み窓 (250ms) を越えてからエンジンリセットを模擬
    vi.setSystemTime(1_000_500);
    engineSet(0);

    expect(protoGet()).toBe(-1000);
  });

  it("直近に JS 書き込みがある 0 到達は素通しする（Ctrl+Home 相当）", () => {
    const { el, engineSet: _unused, protoGet } = makeScroller();
    mount(el);

    el.scrollLeft = -1000;
    el.dispatchEvent(new Event("scroll"));

    vi.setSystemTime(1_000_500);
    // JS からの正当な「先頭へ」— shadow setter 経由
    el.scrollLeft = 0;
    el.dispatchEvent(new Event("scroll"));

    expect(protoGet()).toBe(0);
  });

  it("scrollTo 経由の 0 到達も JS 書き込みとして素通しする", () => {
    const { el, protoGet } = makeScroller();
    // happy-dom の scrollTo は scrollLeft を書かないので、ここでは
    // 「scrollTo ラッパが lastJsWrite を記録する」ことだけを検証する:
    // scrollTo を呼んだ直後にエンジン相当の 0 書き込みが来ても復元しない。
    mount(el);

    el.scrollLeft = -1000;
    el.dispatchEvent(new Event("scroll"));

    vi.setSystemTime(1_000_500);
    el.scrollTo(0, 0); // 記録のみ（happy-dom では実スクロールなし）
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(el),
      "scrollLeft",
    )!.set!.call(el, 0);
    el.dispatchEvent(new Event("scroll"));

    expect(protoGet()).toBe(0);
  });

  it("浅い位置 (-150px 未満) からの 0 到達は復元しない", () => {
    const { el, engineSet, protoGet } = makeScroller();
    mount(el);

    el.scrollLeft = -100;
    el.dispatchEvent(new Event("scroll"));

    vi.setSystemTime(1_000_500);
    engineSet(0);

    expect(protoGet()).toBe(0);
  });

  it("横書き / WebKitGTK 以外では何もしない", () => {
    const a = makeScroller();
    mount(a.el, false); // 横書き
    a.el.scrollLeft = -1000;
    a.el.dispatchEvent(new Event("scroll"));
    vi.setSystemTime(1_000_500);
    a.engineSet(0);
    expect(a.protoGet()).toBe(0);

    mockWebKitGtk = false;
    const b = makeScroller();
    mount(b.el, true);
    b.el.scrollLeft = -1000;
    b.el.dispatchEvent(new Event("scroll"));
    vi.setSystemTime(1_001_000);
    b.engineSet(0);
    expect(b.protoGet()).toBe(0);
  });

  it("unmount で shadow accessor とリスナを原状復帰する", () => {
    const { el, engineSet, protoGet } = makeScroller();
    const hook = mount(el);

    el.scrollLeft = -1000;
    el.dispatchEvent(new Event("scroll"));

    hook.unmount();
    expect(Object.getOwnPropertyDescriptor(el, "scrollLeft")).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(el, "scrollTo")).toBeUndefined();

    // ガード解除後はエンジンリセットも復元されない
    vi.setSystemTime(1_000_500);
    engineSet(0);
    expect(protoGet()).toBe(0);
  });
});
