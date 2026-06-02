import { useEffect, useRef } from "react";
import { isReducedMotion, pulseHighlight } from "@/lib/gsap";

const MILESTONES = [0.25, 0.5, 0.75, 1.0];

export function useCharCountMilestone(
  charCount: number,
  target: number,
  elementRef: React.RefObject<HTMLElement | null>,
): void {
  const initializedRef = useRef(false);
  const reachedRef = useRef<Set<number>>(new Set());

  // Reset milestone tracking when target changes
  const prevTargetRef = useRef(target);
  if (prevTargetRef.current !== target) {
    prevTargetRef.current = target;
    reachedRef.current = new Set();
    initializedRef.current = false;
  }

  useEffect(() => {
    if (!initializedRef.current) {
      // charCount starts as 0 (useState) and gets the real value after async load.
      // Defer seeding until we have the real count to avoid false positives on open.
      if (charCount === 0 && target > 0) return;
      initializedRef.current = true;
      // Seed already-passed milestones on mount to avoid false positives
      if (target > 0) {
        const ratio = charCount / target;
        for (const m of MILESTONES) {
          if (ratio >= m) reachedRef.current.add(m);
        }
      }
      return;
    }

    if (target <= 0) return;

    const ratio = charCount / target;
    for (const m of MILESTONES) {
      if (ratio >= m && !reachedRef.current.has(m)) {
        reachedRef.current.add(m);
        if (isReducedMotion() || !elementRef.current) return;
        pulseHighlight(elementRef.current);
        if (m === 1.0) {
          const rect = elementRef.current.getBoundingClientRect();
          const origin = {
            x: (rect.left + rect.width / 2) / window.innerWidth,
            y: rect.top / window.innerHeight,
          };
          // canvas-confetti は 100% 達成という稀なイベントでしか使わないので
          // 起動時バンドルから外し、達成時に動的 import する（所見#11）。
          void import("canvas-confetti").then(({ default: confetti }) => {
            confetti({ particleCount: 80, spread: 60, origin });
          });
        }
        return; // fire at most one milestone per update
      }
    }
  }, [charCount, target, elementRef]);
}
