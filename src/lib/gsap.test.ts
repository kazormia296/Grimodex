// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("gsap", () => {
  const mockTimeline = {
    fromTo: vi.fn().mockReturnThis(),
    to: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
  };
  const mockTween = {};
  return {
    gsap: {
      timeline: vi.fn(() => mockTimeline),
      fromTo: vi.fn(() => mockTween),
    },
  };
});

vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: {
    getState: vi.fn(() => ({ getBoolean: (_k: string, def: boolean) => def })),
  },
}));

import { gsap } from "gsap";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  celebrationBurst,
  shimmerSweep,
  staggerFlourish,
  pulseHighlight,
} from "./gsap";

function setMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn(() => ({ matches })),
  });
}

describe("gsap presets", () => {
  beforeEach(() => {
    setMatchMedia(false);
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      getBoolean: (_k: string, def: boolean) => def,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(gsap.timeline).mockClear();
    vi.mocked(gsap.fromTo).mockClear();
  });

  describe("celebrationBurst", () => {
    it("returns null when OS prefers-reduced-motion", () => {
      setMatchMedia(true);
      const el = document.createElement("div");
      expect(celebrationBurst(el)).toBeNull();
      expect(gsap.timeline).not.toHaveBeenCalled();
    });

    it("returns null when app reduceMotion is true", () => {
      vi.mocked(useSettingsStore.getState).mockReturnValue({
        getBoolean: () => true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      const el = document.createElement("div");
      expect(celebrationBurst(el)).toBeNull();
    });

    it("calls gsap.timeline and returns it when motion enabled", () => {
      const el = document.createElement("div");
      const result = celebrationBurst(el);
      expect(gsap.timeline).toHaveBeenCalled();
      expect(result).not.toBeNull();
    });
  });

  describe("shimmerSweep", () => {
    it("returns null when reduced motion", () => {
      setMatchMedia(true);
      expect(shimmerSweep(document.createElement("div"))).toBeNull();
    });

    it("calls gsap.fromTo when motion enabled", () => {
      shimmerSweep(document.createElement("div"));
      expect(gsap.fromTo).toHaveBeenCalled();
    });
  });

  describe("staggerFlourish", () => {
    it("returns null when reduced motion", () => {
      setMatchMedia(true);
      expect(staggerFlourish([document.createElement("div")])).toBeNull();
    });

    it("returns null when targets is empty", () => {
      expect(staggerFlourish([])).toBeNull();
    });

    it("calls gsap.timeline when motion enabled", () => {
      staggerFlourish([document.createElement("div")]);
      expect(gsap.timeline).toHaveBeenCalled();
    });
  });

  describe("pulseHighlight", () => {
    it("returns null when reduced motion", () => {
      setMatchMedia(true);
      expect(pulseHighlight(document.createElement("div"))).toBeNull();
    });

    it("calls gsap.timeline when motion enabled", () => {
      pulseHighlight(document.createElement("div"));
      expect(gsap.timeline).toHaveBeenCalled();
    });
  });
});
