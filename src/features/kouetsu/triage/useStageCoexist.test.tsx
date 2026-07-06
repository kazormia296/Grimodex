// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRef } from "react";
import {
  STAGE_COEXIST_MIN_HEIGHT,
  STAGE_COEXIST_MIN_WIDTH,
  useStageCoexist,
} from "./useStageCoexist";

/**
 * happy-dom は layout を計算しないため、clientWidth/clientHeight を
 * defineProperty で偽装し、ResizeObserver をコールバック直接駆動の
 * フェイクに差し替えて閾値ロジックだけを検証する。
 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  constructor(public cb: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  fire() {
    this.cb([], this as unknown as ResizeObserver);
  }
}

function setSize(el: HTMLElement, width: number, height: number) {
  Object.defineProperty(el, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    value: height,
    configurable: true,
  });
}

function renderCoexist(el: HTMLElement) {
  return renderHook(() => {
    const ref = useRef<HTMLElement | null>(el);
    return useStageCoexist(ref);
  });
}

describe("useStageCoexist", () => {
  const realRO = globalThis.ResizeObserver;

  beforeEach(() => {
    FakeResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (realRO) globalThis.ResizeObserver = realRO;
  });

  it("高さ・幅とも閾値以上のときだけ true", () => {
    const el = document.createElement("div");
    setSize(el, STAGE_COEXIST_MIN_WIDTH, STAGE_COEXIST_MIN_HEIGHT);
    const { result } = renderCoexist(el);
    expect(result.current).toBe(true);
  });

  it("高さが足りても幅が閾値未満（1 列ダッシュボード）なら false", () => {
    const el = document.createElement("div");
    setSize(el, STAGE_COEXIST_MIN_WIDTH - 1, STAGE_COEXIST_MIN_HEIGHT + 200);
    const { result } = renderCoexist(el);
    expect(result.current).toBe(false);
  });

  it("幅が足りても高さが閾値未満なら false", () => {
    const el = document.createElement("div");
    setSize(el, STAGE_COEXIST_MIN_WIDTH + 200, STAGE_COEXIST_MIN_HEIGHT - 1);
    const { result } = renderCoexist(el);
    expect(result.current).toBe(false);
  });

  it("リサイズ（ResizeObserver 発火）で追従する", () => {
    const el = document.createElement("div");
    setSize(el, 200, 300);
    const { result } = renderCoexist(el);
    expect(result.current).toBe(false);

    setSize(el, STAGE_COEXIST_MIN_WIDTH, STAGE_COEXIST_MIN_HEIGHT);
    act(() => {
      for (const ro of FakeResizeObserver.instances) ro.fire();
    });
    expect(result.current).toBe(true);
  });

  it("ResizeObserver 不在環境では常に false（排他表示フォールバック）", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const el = document.createElement("div");
    setSize(el, 1000, 1000);
    const { result } = renderCoexist(el);
    expect(result.current).toBe(false);
  });
});
