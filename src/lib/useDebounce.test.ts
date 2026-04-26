// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebouncedCallback, useKeyedDebouncedCallback } from "./useDebounce";

describe("useDebouncedCallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays invocation until the timeout elapses", () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(fn, 200));
    act(() => result.current("a"));
    expect(fn).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(fn).toHaveBeenCalledWith("a");
  });

  it("resets the timer when invoked again within the delay", () => {
    const fn = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(fn, 200));
    act(() => result.current("a"));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    act(() => result.current("b"));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(fn).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("b");
  });

  it("cancels pending timer on unmount", () => {
    const fn = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedCallback(fn, 200));
    act(() => result.current("a"));
    unmount();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("useKeyedDebouncedCallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const getKey = (id: string) => id;

  it("maintains independent timers per key", () => {
    const fn = vi.fn();
    const { result } = renderHook(() =>
      useKeyedDebouncedCallback(fn, 200, getKey),
    );
    act(() => result.current("a"));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => result.current("b"));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    // Key "a" fires first; "b" is still pending
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("a");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("b");
  });

  it("coalesces repeated calls with the same key", () => {
    const fn = vi.fn();
    const { result } = renderHook(() =>
      useKeyedDebouncedCallback(fn, 200, getKey),
    );
    act(() => result.current("a"));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    act(() => result.current("a"));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(fn).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancels all pending timers on unmount", () => {
    const fn = vi.fn();
    const { result, unmount } = renderHook(() =>
      useKeyedDebouncedCallback(fn, 200, getKey),
    );
    act(() => result.current("a"));
    act(() => result.current("b"));
    act(() => result.current("c"));
    unmount();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(fn).not.toHaveBeenCalled();
  });
});
