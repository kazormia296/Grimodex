import { useEffect, useRef } from "react";
import confetti from "canvas-confetti";
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
          confetti({
            particleCount: 80,
            spread: 60,
            origin: { y: 1 },
          });
        }
        return; // fire at most one milestone per update
      }
    }
  }, [charCount, target, elementRef]);
}
