// @vitest-environment happy-dom
/**
 * 注意: このスイートは controls.set/start の「dispatch（呼び出しと引数）」のみを
 * 検証する。controls → motion.div の実配線と実際の opacity フェードは
 * presetCrossfade.browser.test.tsx が、remount 不在は
 * LayoutShell.presetSwitch.test.tsx が gate する。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLayoutPresetCrossfade } from "./useLayoutPresetCrossfade";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState } from "./layoutStateUtils";

vi.mock("@/lib/animation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/animation")>();
  return {
    ...actual,
    useReducedMotion: () => false,
  };
});

describe("useLayoutPresetCrossfade", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ allInactive: true }),
      activePresetId: "builtin:default",
      layoutLocked: false,
      maximizedPanelId: null,
      initialized: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets opacity 0 and starts the fade without remounting", () => {
    const { result } = renderHook(() => useLayoutPresetCrossfade());
    const setSpy = vi.spyOn(result.current.crossfadeControls, "set");
    const startSpy = vi.spyOn(result.current.crossfadeControls, "start");

    act(() => {
      useLayoutStore.setState({ activePresetId: "builtin:chat-main" });
    });

    expect(setSpy).toHaveBeenCalledWith({ opacity: 0 });
    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({ opacity: 1 }),
    );
  });

  it("does not fade on zoom enter (reveal が担当) but fades on zoom exit", () => {
    const { result } = renderHook(() => useLayoutPresetCrossfade());
    const setSpy = vi.spyOn(result.current.crossfadeControls, "set");
    const startSpy = vi.spyOn(result.current.crossfadeControls, "start");

    // 突入（null→panel）: clip-path reveal 側が演出するためフェードなし
    act(() => {
      useLayoutStore.setState({ maximizedPanelId: "scenes" });
    });
    expect(setSpy).not.toHaveBeenCalled();

    // 解除（panel→null）: フェードで復帰
    act(() => {
      useLayoutStore.setState({ maximizedPanelId: null });
    });
    expect(setSpy).toHaveBeenCalledWith({ opacity: 0 });
    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({ opacity: 1 }),
    );
  });

  it("does not fade the startup layout hydration", async () => {
    useLayoutStore.setState({
      activePresetId: null,
      initialized: false,
    });
    const { result } = renderHook(() => useLayoutPresetCrossfade());
    const setSpy = vi.spyOn(result.current.crossfadeControls, "set");
    const startSpy = vi.spyOn(result.current.crossfadeControls, "start");

    act(() => {
      // loadPresets(): initialized=false のまま保存済み preset id を先に読む。
      useLayoutStore.setState({ activePresetId: "builtin:default" });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(setSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();

    act(() => {
      // initializeLayout(): layout hydration と同時に initialized=true になる。
      useLayoutStore.setState({
        initialized: true,
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(setSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("does not re-trigger the fade on re-render while preset is unchanged", () => {
    // 初回 mount の不発火そのものは spy を貼るタイミング上ここでは直接 gate
    // できない（prevPresetRef ガードによる）。ここで固定するのは「preset が
    // 同一のままの再レンダーでは発火しない」こと。
    const { result } = renderHook(() => useLayoutPresetCrossfade());
    const setSpy = vi.spyOn(result.current.crossfadeControls, "set");

    act(() => {
      useLayoutStore.setState({ layoutLocked: false });
    });

    expect(setSpy).not.toHaveBeenCalled();
  });

  it("skips the fade when layout is locked", () => {
    useLayoutStore.setState({ layoutLocked: true });
    const { result } = renderHook(() => useLayoutPresetCrossfade());
    const setSpy = vi.spyOn(result.current.crossfadeControls, "set");
    const startSpy = vi.spyOn(result.current.crossfadeControls, "start");

    act(() => {
      useLayoutStore.setState({ activePresetId: "builtin:plan" });
    });

    expect(setSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("restarts on every rapid preset switch (no throttle, never remount)", () => {
    const { result } = renderHook(() => useLayoutPresetCrossfade());
    const setSpy = vi.spyOn(result.current.crossfadeControls, "set");

    act(() => {
      useLayoutStore.setState({ activePresetId: "builtin:chat-main" });
    });
    act(() => {
      useLayoutStore.setState({ activePresetId: "builtin:plan" });
    });
    act(() => {
      useLayoutStore.setState({ activePresetId: "builtin:default" });
    });
    // 連打の途中でも毎回つなぐ（以前の 300ms の throttle は廃止）。
    expect(setSpy).toHaveBeenCalledTimes(3);
  });

  it("treats re-applying the same preset as a replacement", () => {
    const { result } = renderHook(() => useLayoutPresetCrossfade());
    const setSpy = vi.spyOn(result.current.crossfadeControls, "set");

    act(() => {
      useLayoutStore.setState((state) => ({
        layoutReplaceSeq: state.layoutReplaceSeq + 1,
      }));
    });
    expect(setSpy).toHaveBeenCalledWith({ opacity: 0 });
  });
});
