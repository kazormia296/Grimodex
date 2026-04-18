import { gsap } from "gsap";
import { useSettingsStore } from "@/features/settings/settingsStore";

export function isReducedMotion(): boolean {
  const osReduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const appReduced = useSettingsStore
    .getState()
    .getBoolean("display.reduceMotion", false);
  return osReduced || appReduced;
}

export function celebrationBurst(
  target: HTMLElement,
  opts?: { duration?: number },
): gsap.core.Timeline | null {
  if (isReducedMotion()) return null;
  const dur = opts?.duration ?? 0.6;
  return gsap
    .timeline()
    .fromTo(
      target,
      { scale: 0, opacity: 0, rotation: -15 },
      {
        scale: 1.1,
        opacity: 1,
        rotation: 5,
        duration: dur * 0.5,
        ease: "back.out(1.7)",
      },
    )
    .to(target, {
      scale: 1,
      rotation: 0,
      duration: dur * 0.5,
      ease: "power2.out",
    });
}

export function shimmerSweep(
  target: HTMLElement,
  opts?: { duration?: number },
): gsap.core.Tween | null {
  if (isReducedMotion()) return null;
  const dur = opts?.duration ?? 0.8;
  return gsap.fromTo(
    target,
    { backgroundPosition: "-100% 0" },
    { backgroundPosition: "200% 0", duration: dur, ease: "none", repeat: -1 },
  );
}

export function staggerFlourish(
  targets: HTMLElement[],
  opts?: { duration?: number; stagger?: number },
): gsap.core.Timeline | null {
  if (isReducedMotion() || targets.length === 0) return null;
  const dur = opts?.duration ?? 0.3;
  const stagger = opts?.stagger ?? 0.04;
  return gsap.timeline().from(targets, {
    scale: 0.9,
    opacity: 0,
    duration: dur,
    stagger,
    ease: "power2.out",
  });
}

export function pulseHighlight(
  target: HTMLElement,
  opts?: { duration?: number },
): gsap.core.Timeline | null {
  if (isReducedMotion()) return null;
  const dur = opts?.duration ?? 0.5;
  return gsap
    .timeline()
    .to(target, {
      boxShadow: "0 0 0 6px rgba(99,102,241,0.4)",
      duration: dur / 2,
      ease: "power2.out",
    })
    .to(target, {
      boxShadow: "0 0 0 0px rgba(99,102,241,0)",
      duration: dur / 2,
      ease: "power2.in",
    });
}
