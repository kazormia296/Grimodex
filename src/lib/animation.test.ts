// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("motion/react", () => ({
  useReducedMotion: vi.fn(() => false),
}));

vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: vi.fn(),
}));

import { useReducedMotion } from "./animation";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useReducedMotion as useOsReducedMotion } from "motion/react";

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
