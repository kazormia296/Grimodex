// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMapKeyboard } from "./useMapKeyboard";

function makeKeyEvent(
  key: string,
  opts: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {},
): React.KeyboardEvent<HTMLDivElement> {
  return {
    key,
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    altKey: opts.altKey ?? false,
    shiftKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    target: document.createElement("div"),
  } as unknown as React.KeyboardEvent<HTMLDivElement>;
}

function makeRef<T>(v: T) {
  return { current: v };
}

function renderKeyboard(
  overrides: Partial<Parameters<typeof useMapKeyboard>[0]> = {},
) {
  const mocks = {
    searchVisible: false,
    setSearchVisible: vi.fn(),
    focusedNodeId: null as string | null,
    setFocusedNode: vi.fn(),
    gridSnap: false,
    setGridSnap: vi.fn(),
    setMode: vi.fn(),
    setPaletteMode: vi.fn() as React.Dispatch<
      React.SetStateAction<"default" | "frame" | "connect">
    >,
    frameDraftRect: null as {
      x: number;
      y: number;
      w: number;
      h: number;
    } | null,
    frameDragStart: makeRef(null as { x: number; y: number } | null),
    frameDragStartScreen: makeRef(null as { x: number; y: number } | null),
    setFrameDraftRect: vi.fn(),
    setFrameDraftScreenRect: vi.fn(),
    onDeleteSelected: vi.fn(),
    fitView: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    zoomReset: vi.fn(),
    selectAll: vi.fn(),
    onPinToggle: vi.fn(),
    ...overrides,
  };
  const { result } = renderHook(() => useMapKeyboard(mocks));
  return { onKeyDown: result.current.onKeyDown, mocks };
}

describe("useMapKeyboard — 新規ショートカット", () => {
  it("E キーで connect モードに切り替わる", () => {
    const { onKeyDown, mocks } = renderKeyboard();
    act(() => onKeyDown(makeKeyEvent("e")));
    expect(mocks.setPaletteMode).toHaveBeenCalledWith("connect");
  });

  it("Alt キーで connect モードに切り替わる", () => {
    const { onKeyDown, mocks } = renderKeyboard();
    act(() => onKeyDown(makeKeyEvent("Alt")));
    expect(mocks.setPaletteMode).toHaveBeenCalledWith("connect");
  });

  it("Ctrl+0 で fitView が呼ばれる", () => {
    const { onKeyDown, mocks } = renderKeyboard();
    act(() => onKeyDown(makeKeyEvent("0", { ctrlKey: true })));
    expect(mocks.fitView).toHaveBeenCalledOnce();
  });

  it("Ctrl+= で zoomIn が呼ばれる", () => {
    const { onKeyDown, mocks } = renderKeyboard();
    act(() => onKeyDown(makeKeyEvent("=", { ctrlKey: true })));
    expect(mocks.zoomIn).toHaveBeenCalledOnce();
  });

  it("Ctrl++ で zoomIn が呼ばれる", () => {
    const { onKeyDown, mocks } = renderKeyboard();
    act(() => onKeyDown(makeKeyEvent("+", { ctrlKey: true })));
    expect(mocks.zoomIn).toHaveBeenCalledOnce();
  });

  it("Ctrl+- で zoomOut が呼ばれる", () => {
    const { onKeyDown, mocks } = renderKeyboard();
    act(() => onKeyDown(makeKeyEvent("-", { ctrlKey: true })));
    expect(mocks.zoomOut).toHaveBeenCalledOnce();
  });

  it("Ctrl+1 で zoomReset が呼ばれる", () => {
    const { onKeyDown, mocks } = renderKeyboard();
    act(() => onKeyDown(makeKeyEvent("1", { ctrlKey: true })));
    expect(mocks.zoomReset).toHaveBeenCalledOnce();
  });

  it("Ctrl+A で selectAll が呼ばれる", () => {
    const { onKeyDown, mocks } = renderKeyboard();
    act(() => onKeyDown(makeKeyEvent("a", { ctrlKey: true })));
    expect(mocks.selectAll).toHaveBeenCalledOnce();
  });

  it("Ctrl+P で onPinToggle が呼ばれる", () => {
    const { onKeyDown, mocks } = renderKeyboard();
    act(() => onKeyDown(makeKeyEvent("p", { ctrlKey: true })));
    expect(mocks.onPinToggle).toHaveBeenCalledOnce();
  });

  it("既存: 1キーで Free モード切替", () => {
    const { onKeyDown, mocks } = renderKeyboard();
    act(() => onKeyDown(makeKeyEvent("1")));
    expect(mocks.setMode).toHaveBeenCalledWith("free");
  });

  it("既存: Ctrl+G でグリッドスナップトグル", () => {
    const { onKeyDown, mocks } = renderKeyboard();
    act(() => onKeyDown(makeKeyEvent("g", { ctrlKey: true })));
    expect(mocks.setGridSnap).toHaveBeenCalledWith(true);
  });
});
