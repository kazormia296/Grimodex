import { useEffect, useState } from "react";
import { motion } from "motion/react";
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

/** One configurable Paper shader shared by the normal and Zen editor layouts. */
export function ZenAmbientBackdrop({ active }: ZenAmbientBackdropProps) {
  const reduced = useReducedMotion();
  const windowActive = useWindowActive();
  const config = useZenShaderConfig();
  const playing =
    config.enabled && !reduced && windowActive && config.speed > 0;

  return (
    <motion.div
      data-editor-ambient
      data-zen-mode={active ? "true" : "false"}
      data-background-enabled={config.enabled ? "true" : "false"}
      data-motion={playing ? "drifting" : "static"}
      data-window-active={windowActive ? "true" : "false"}
      data-background-shader={config.shader}
      data-background-dither={config.dither.enabled ? "true" : "false"}
      data-background-halftone={config.halftone.enabled ? "true" : "false"}
      aria-hidden="true"
      className="editor-ambient-backdrop pointer-events-none absolute inset-0 overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{
        duration: reduced ? 0 : ZEN_AMBIENT_DURATIONS.enter,
        ease: EASINGS.easeOut,
      }}
    >
      {config.enabled && <ZenShaderSurface config={config} playing={playing} />}
    </motion.div>
  );
}
