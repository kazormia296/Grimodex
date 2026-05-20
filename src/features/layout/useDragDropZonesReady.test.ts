// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDragDropZonesReady } from "./useDragDropZonesReady";

describe("useDragDropZonesReady", () => {
  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays false while drag is inactive", () => {
    const { result } = renderHook(() => useDragDropZonesReady(false));
    expect(result.current).toBe(false);
  });

  it("becomes true after drag starts on the next animation frame", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useDragDropZonesReady(active),
      { initialProps: { active: false } },
    );

    act(() => {
      rerender({ active: true });
    });

    expect(result.current).toBe(true);
  });

  it("resets when drag ends", () => {
    const { result, rerender } = renderHook(
      ({ active }) => useDragDropZonesReady(active),
      { initialProps: { active: true } },
    );

    act(() => {
      rerender({ active: true });
    });
    expect(result.current).toBe(true);

    act(() => {
      rerender({ active: false });
    });
    expect(result.current).toBe(false);
  });
});
