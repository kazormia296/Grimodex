// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMapKeyboard } from "./useMapKeyboard";

function makeKeyEvent(
  key: string,
  opts: {
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    isComposing?: boolean;
  } = {},
  target: HTMLElement = document.createElement("div"),
): React.KeyboardEvent<HTMLDivElement> {
  return {
    key,
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    altKey: opts.altKey ?? false,
    shiftKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    nativeEvent: { isComposing: opts.isComposing ?? false },
    target,
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
    onAddSticky: vi.fn(),
    fitView: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    zoomReset: vi.fn(),
    selectAll: vi.fn(),
    onPinToggle: vi.fn(),
    ...overrides,
  };
  const { result } = renderHook(() => useMapKeyboard(mocks));
  return {
    onKeyDown: result.current.onKeyDown,
    onKeyUp: result.current.onKeyUp,
    mocks,
  };
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

  it("Alt キーを離すと default モードに戻る", () => {
    const { onKeyDown, onKeyUp, mocks } = renderKeyboard();
    act(() => onKeyDown(makeKeyEvent("Alt")));
    act(() => onKeyUp(makeKeyEvent("Alt")));
    expect(mocks.setPaletteMode).toHaveBeenLastCalledWith("default");
  });

  it("Alt を押さずに Alt keyup しても setPaletteMode を呼ばない", () => {
    const { onKeyUp, mocks } = renderKeyboard();
    act(() => onKeyUp(makeKeyEvent("Alt")));
    expect(mocks.setPaletteMode).not.toHaveBeenCalled();
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

  it("Ctrl+E は connect モードに入らない", () => {
    const { onKeyDown, mocks } = renderKeyboard();
    act(() => onKeyDown(makeKeyEvent("e", { ctrlKey: true })));
    expect(mocks.setPaletteMode).not.toHaveBeenCalledWith("connect");
  });

  it("Meta+E は connect モードに入らない", () => {
    const { onKeyDown, mocks } = renderKeyboard();
    act(() => onKeyDown(makeKeyEvent("e", { metaKey: true })));
    expect(mocks.setPaletteMode).not.toHaveBeenCalledWith("connect");
  });

  it("Alt+E は connect モードに入らない (Alt 単体のみ有効)", () => {
    const { onKeyDown, mocks } = renderKeyboard();
    act(() => onKeyDown(makeKeyEvent("e", { altKey: true })));
    expect(mocks.setPaletteMode).not.toHaveBeenCalledWith("connect");
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

  it("S キーで onAddSticky が呼ばれる", () => {
    const { onKeyDown, mocks } = renderKeyboard();
    act(() => onKeyDown(makeKeyEvent("s")));
    expect(mocks.onAddSticky).toHaveBeenCalledOnce();
  });

  it("Ctrl+S では onAddSticky が呼ばれない", () => {
    const { onKeyDown, mocks } = renderKeyboard();
    act(() => onKeyDown(makeKeyEvent("s", { ctrlKey: true })));
    expect(mocks.onAddSticky).not.toHaveBeenCalled();
  });

  it("S キーは input フォーカス中には発火しない", () => {
    const { onKeyDown, mocks } = renderKeyboard();
    const input = document.createElement("input");
    act(() => onKeyDown(makeKeyEvent("s", {}, input)));
    expect(mocks.onAddSticky).not.toHaveBeenCalled();
  });

  it("S キーは select フォーカス中には発火しない", () => {
    const { onKeyDown, mocks } = renderKeyboard();
    const select = document.createElement("select");
    act(() => onKeyDown(makeKeyEvent("s", {}, select)));
    expect(mocks.onAddSticky).not.toHaveBeenCalled();
  });

  it("S キーは contenteditable 配下の要素では発火しない", () => {
    const { onKeyDown, mocks } = renderKeyboard();
    const host = document.createElement("div");
    host.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    host.appendChild(child);
    document.body.appendChild(host);
    try {
      act(() => onKeyDown(makeKeyEvent("s", {}, child)));
      expect(mocks.onAddSticky).not.toHaveBeenCalled();
    } finally {
      host.remove();
    }
  });

  it("IME 変換中 (isComposing) はショートカットを無視する", () => {
    const { onKeyDown, mocks } = renderKeyboard();
    act(() => onKeyDown(makeKeyEvent("s", { isComposing: true })));
    expect(mocks.onAddSticky).not.toHaveBeenCalled();
  });

  it("IME 変換中 (isComposing) は Escape も無視する", () => {
    const { onKeyDown, mocks } = renderKeyboard({ searchVisible: true });
    act(() => onKeyDown(makeKeyEvent("Escape", { isComposing: true })));
    expect(mocks.setSearchVisible).not.toHaveBeenCalled();
  });
});
