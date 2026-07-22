import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  EASINGS,
  ZEN_AMBIENT_DURATIONS,
  useReducedMotion,
} from "@/lib/animation";
import { ZenShaderSurface } from "./zen/ZenShaderSurface";
import { useZenShaderConfig } from "./zen/useZenShaderConfig";

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

/** Configurable Paper shader behind the fixed, opaque Zen writing column. */
export function ZenAmbientBackdrop({ active }: ZenAmbientBackdropProps) {
  const reduced = useReducedMotion();
  const windowActive = useWindowActive();
  const config = useZenShaderConfig();
  const playing = active && !reduced && windowActive && config.speed > 0;

  return (
    <AnimatePresence initial={false}>
      {active && (
        <motion.div
          key="zen-ambient"
          data-zen-ambient
          data-motion={playing ? "drifting" : "static"}
          data-window-active={windowActive ? "true" : "false"}
          data-zen-shader={config.shader}
          data-zen-dither={config.dither.enabled ? "true" : "false"}
          data-zen-halftone={config.halftone.enabled ? "true" : "false"}
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
          <ZenShaderSurface config={config} playing={playing} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
