import { useEffect, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import { AnimatePresence, motion } from "motion/react";
import {
  EASINGS,
  ZEN_AMBIENT_DURATIONS,
  useReducedMotion,
} from "@/lib/animation";
import { createZenAmbientDrift } from "@/lib/gsap";

function isWindowActive() {
  if (typeof document === "undefined") return true;
  const focused =
    typeof document.hasFocus !== "function" || document.hasFocus();
  return document.visibilityState !== "hidden" && focused;
}

function useWindowActive() {
  const [active, setActive] = useState(isWindowActive);

  useEffect(() => {
    const sync = () => setActive(isWindowActive());
    const deactivate = () => setActive(false);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", deactivate);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", deactivate);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  return active;
}

interface ZenAmbientBackdropProps {
  active: boolean;
}

/** Two low-opacity lights behind the fixed Zen writing column. */
export function ZenAmbientBackdrop({ active }: ZenAmbientBackdropProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLDivElement>(null);
  const secondaryRef = useRef<HTMLDivElement>(null);
  const driftRef = useRef<ReturnType<typeof createZenAmbientDrift>>(null);
  const reduced = useReducedMotion();
  const windowActive = useWindowActive();

  useGSAP(
    () => {
      if (!active || reduced || !primaryRef.current || !secondaryRef.current) {
        driftRef.current = null;
        return;
      }
      driftRef.current = createZenAmbientDrift(
        primaryRef.current,
        secondaryRef.current,
      );
      return () => {
        driftRef.current = null;
      };
    },
    {
      scope: rootRef,
      dependencies: [active, reduced],
      revertOnUpdate: true,
    },
  );

  useEffect(() => {
    driftRef.current?.paused(reduced || !windowActive);
  }, [active, reduced, windowActive]);

  return (
    <AnimatePresence initial={false}>
      {active && (
        <motion.div
          key="zen-ambient"
          ref={rootRef}
          data-zen-ambient
          data-motion={reduced ? "static" : "drifting"}
          data-window-active={windowActive ? "true" : "false"}
          aria-hidden="true"
          className="zen-ambient-backdrop pointer-events-none fixed inset-0 overflow-hidden"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{
            opacity: 0,
            transition: {
              duration: reduced ? 0 : ZEN_AMBIENT_DURATIONS.exit,
              ease: EASINGS.easeOut,
            },
          }}
          transition={{
            duration: reduced ? 0 : ZEN_AMBIENT_DURATIONS.enter,
            ease: EASINGS.easeOut,
          }}
        >
          <div
            ref={primaryRef}
            data-zen-ambient-light="primary"
            className="zen-ambient-light zen-ambient-light--primary"
          />
          <div
            ref={secondaryRef}
            data-zen-ambient-light="secondary"
            className="zen-ambient-light zen-ambient-light--secondary"
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
