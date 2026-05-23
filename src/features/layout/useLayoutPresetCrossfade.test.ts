// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, vi } from "vitest";
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
    });
  });

  it("updates crossfade key when preset changes", () => {
    const { result } = renderHook(() => useLayoutPresetCrossfade());
    expect(result.current.crossfadeKey).toBe("builtin:default");

    act(() => {
      useLayoutStore.setState({ activePresetId: "builtin:chat-main" });
    });

    expect(result.current.crossfadeKey).toBe("builtin:chat-main");
    expect(result.current.animateEntry).toBe(true);
  });

  it("skips entry animation when layout is locked", () => {
    useLayoutStore.setState({ layoutLocked: true });
    const { result } = renderHook(() => useLayoutPresetCrossfade());

    act(() => {
      useLayoutStore.setState({ activePresetId: "builtin:plan" });
    });

    expect(result.current.crossfadeKey).toBe("builtin:plan");
    expect(result.current.animateEntry).toBe(false);
  });
});
