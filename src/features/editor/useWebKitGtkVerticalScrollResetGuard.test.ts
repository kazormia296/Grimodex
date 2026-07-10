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
  engineSetSilent: (v: number) => void;
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
    // 「復元書き込みのクランプ」を模擬: scroll イベント無しで値だけ変える
    // (実機では relayout 直後の書き込みが 0 へ丸められ、イベントが来ない)
    engineSetSilent(v: number) {
      Object.getOwnPropertyDescriptor(proto, "scrollLeft")!.set!.call(el, v);
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

  it("奥の値への JS 書き込み直後のエンジンリセットも復元する（入力中の caret 追従の穴）", () => {
    // PM は入力中に caret 追従で奥の値 (-1000 等) を書く。その直後にエンジンが
    // 0 へ落とした場合、「直近に JS 書き込みあり」だけで素通しすると入力後に
    // 先頭へ飛ぶ — 書き込んだ値が先頭近傍のときだけ素通しする。
    const { el, engineSet, protoGet } = makeScroller();
    mount(el);

    el.scrollLeft = -1000;
    el.dispatchEvent(new Event("scroll"));

    vi.setSystemTime(1_000_100); // JS 書き込みから 100ms (窓内)
    engineSet(0);

    expect(protoGet()).toBe(-1000);
  });

  it("復元書き込みがクランプされても再アサートで書き直す", () => {
    const { el, engineSet, engineSetSilent, protoGet } = makeScroller();
    mount(el);

    el.scrollLeft = -1000;
    el.dispatchEvent(new Event("scroll"));

    vi.setSystemTime(1_000_500);
    engineSet(0);
    expect(protoGet()).toBe(-1000); // 即時復元

    // クランプ模擬: 復元直後に scroll イベント無しで 0 へ戻される
    engineSetSilent(0);
    vi.advanceTimersByTime(60); // 再アサート (0ms/50ms) が発火
    expect(protoGet()).toBe(-1000);

    // 再度クランプ → 150ms/300ms の再アサートでも書き直す
    engineSetSilent(0);
    vi.advanceTimersByTime(260);
    expect(protoGet()).toBe(-1000);
  });

  it("再アサート中に JS の明示スクロールが入ったら手を引く", () => {
    const { el, engineSet, protoGet } = makeScroller();
    mount(el);

    el.scrollLeft = -1000;
    el.dispatchEvent(new Event("scroll"));

    vi.setSystemTime(1_000_500);
    engineSet(0);
    expect(protoGet()).toBe(-1000);

    // ユーザー/アプリが明示的に先頭へ（Ctrl+Home 相当）
    vi.setSystemTime(1_000_520);
    el.scrollLeft = 0;
    el.dispatchEvent(new Event("scroll"));

    vi.advanceTimersByTime(400); // 残りの再アサートは何もしない
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
