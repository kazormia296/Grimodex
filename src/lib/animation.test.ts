// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("motion/react", () => ({
  useReducedMotion: vi.fn(() => false),
}));

vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: vi.fn(),
}));

import {
  useReducedMotion,
  cubicBezier,
  easeOutFn,
  EASINGS,
  ZEN_AMBIENT_DURATIONS,
} from "./animation";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useReducedMotion as useOsReducedMotion } from "motion/react";

describe("cubicBezier / easeOutFn", () => {
  it("端点は 0→0, 1→1（範囲外もクランプ）", () => {
    expect(easeOutFn(0)).toBe(0);
    expect(easeOutFn(1)).toBe(1);
    expect(easeOutFn(-1)).toBe(0);
    expect(easeOutFn(2)).toBe(1);
  });

  it("単調増加する（時間が進むほど値の進捗も増える）", () => {
    let prev = -1;
    for (let i = 0; i <= 10; i++) {
      const v = easeOutFn(i / 10);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("ease-out: 序盤で大きく進み、終盤は緩やか（前半 > 50%）", () => {
    // EASINGS.easeOut=[0.16,1,0.3,1] は強い減速曲線。t=0.5 で既に過半進む。
    expect(easeOutFn(0.5)).toBeGreaterThan(0.5);
  });

  it("linear cubic-bezier(0,0,1,1) は恒等に近い", () => {
    const lin = cubicBezier(0, 0, 1, 1);
    expect(lin(0.25)).toBeCloseTo(0.25, 2);
    expect(lin(0.75)).toBeCloseTo(0.75, 2);
  });

  it("easeOutFn は EASINGS.easeOut と同一曲線", () => {
    const fn = cubicBezier(...EASINGS.easeOut);
    expect(easeOutFn(0.3)).toBeCloseTo(fn(0.3), 6);
  });
});

describe("ZEN_AMBIENT_DURATIONS", () => {
  it("keeps both drift cycles subtle, long, and non-synchronous", () => {
    expect(ZEN_AMBIENT_DURATIONS.primaryDrift).toBeGreaterThanOrEqual(60);
    expect(ZEN_AMBIENT_DURATIONS.primaryDrift).toBeLessThanOrEqual(90);
    expect(ZEN_AMBIENT_DURATIONS.secondaryDrift).toBeGreaterThanOrEqual(60);
    expect(ZEN_AMBIENT_DURATIONS.secondaryDrift).toBeLessThanOrEqual(90);
    expect(ZEN_AMBIENT_DURATIONS.primaryDrift).not.toBe(
      ZEN_AMBIENT_DURATIONS.secondaryDrift,
    );
    expect(ZEN_AMBIENT_DURATIONS.exit).toBeLessThan(
      ZEN_AMBIENT_DURATIONS.enter,
    );
  });
});

describe("useReducedMotion", () => {
  beforeEach(() => {
    vi.mocked(useOsReducedMotion).mockReturnValue(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(useSettingsStore).mockImplementation((selector: any) =>
      selector({ getBoolean: (_k: string, def: boolean) => def }),
    );
  });

  it("returns false when both OS and app setting are false", () => {
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });

  it("returns true when app setting is true", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(useSettingsStore).mockImplementation((selector: any) =>
      selector({ getBoolean: () => true }),
    );
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
  });

  it("returns true when OS prefers-reduced-motion", () => {
    vi.mocked(useOsReducedMotion).mockReturnValue(true);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
  });
});
