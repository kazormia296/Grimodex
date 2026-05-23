import { useReducedMotion as useOsReducedMotion } from "motion/react";
import { useSettingsStore } from "@/features/settings/settingsStore";

export const DURATIONS = {
  fast: 0.15,
  normal: 0.2,
  slow: 0.3,
  dialog: 0.25,
} as const;

export const EASINGS = {
  easeOut: [0.16, 1, 0.3, 1] as [number, number, number, number],
  spring: { type: "spring" as const, damping: 25, stiffness: 300 },
} as const;

export const VARIANTS = {
  fadeIn: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
  },
  slideUp: {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: 8 },
  },
  scaleIn: {
    initial: { opacity: 0, scale: 0.97 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.97 },
  },
  dropdown: {
    initial: { opacity: 0, y: -4 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -4 },
  },
  popover: {
    initial: { opacity: 0, scale: 0.95 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0 },
  },
} as const;

/** CSS transition-duration strings aligned with DURATIONS. */
export const CSS_DURATIONS = {
  fast: `${DURATIONS.fast * 1000}ms`,
  normal: `${DURATIONS.normal * 1000}ms`,
  slow: `${DURATIONS.slow * 1000}ms`,
  dialog: `${DURATIONS.dialog * 1000}ms`,
} as const;

export function useReducedMotion(): boolean {
  const osReduced = useOsReducedMotion();
  const appReduced = useSettingsStore((s) =>
    s.getBoolean("display.reduceMotion", false),
  );
  return !!(osReduced || appReduced);
}
