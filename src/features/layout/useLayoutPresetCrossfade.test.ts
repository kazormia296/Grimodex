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
import { PRESET_ANIMATION_DEBOUNCE_MS } from "./layoutAnimation";

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
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-triggers an opacity fade (set 0 → start 1) when preset changes", () => {
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

  it("debounces rapid preset switches (fade only, never remount)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { result } = renderHook(() => useLayoutPresetCrossfade());
    const setSpy = vi.spyOn(result.current.crossfadeControls, "set");

    act(() => {
      useLayoutStore.setState({ activePresetId: "builtin:chat-main" });
    });
    expect(setSpy).toHaveBeenCalledTimes(1);

    // debounce 窓内の連打はフェードを再トリガーしない
    act(() => {
      useLayoutStore.setState({ activePresetId: "builtin:plan" });
    });
    expect(setSpy).toHaveBeenCalledTimes(1);

    // 窓を抜ければ再びフェードする
    vi.setSystemTime(1_000_000 + PRESET_ANIMATION_DEBOUNCE_MS + 1);
    act(() => {
      useLayoutStore.setState({ activePresetId: "builtin:default" });
    });
    expect(setSpy).toHaveBeenCalledTimes(2);
  });
});
