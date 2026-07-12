// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChronicleStore } from "./chronicleStore";
import { useChronicleViewportController } from "./useChronicleViewportController";

vi.mock("@/lib/a11y/announcer", () => ({ announce: vi.fn() }));

describe("useChronicleViewportController", () => {
  beforeEach(() => {
    useChronicleStore.setState({
      pxPerDay: null,
      viewStartDay: null,
    });
  });

  it("fits locally on first measurement and persists user navigation", () => {
    const { result } = renderHook(() =>
      useChronicleViewportController({
        dataStart: 0,
        dataEnd: 100,
        eventCount: 2,
        focusDay: 50,
      }),
    );

    act(() => result.current.setTrackW(800));
    expect(result.current.view.pxPerDay).toBeGreaterThan(0);
    expect(useChronicleStore.getState().pxPerDay).toBeNull();

    act(() => result.current.applyView({ pxPerDay: 4, viewStartDay: 10 }));
    expect(useChronicleStore.getState()).toMatchObject({
      pxPerDay: 4,
      viewStartDay: 10,
    });

    act(() => result.current.centerOnDay(110));
    expect(result.current.view.viewStartDay).toBeCloseTo(10);
  });

  it("does not center when the viewport has no measurable width", () => {
    const { result } = renderHook(() =>
      useChronicleViewportController({
        dataStart: 0,
        dataEnd: 10,
        eventCount: 1,
        focusDay: 5,
      }),
    );
    const before = result.current.view;
    act(() => result.current.centerOnDay(5));
    expect(result.current.view).toEqual(before);
  });
});
