import { useEffect, useState } from "react";
import { motion } from "motion/react";
import {
  EASINGS,
  ZEN_AMBIENT_DURATIONS,
  useReducedMotion,
} from "@/lib/animation";
import {
  ZenShaderSurface,
  type ZenShaderRendererStatus,
} from "./zen/ZenShaderSurface";
import { useZenShaderConfig } from "./zen/useZenShaderConfig";
import { hasUsableZenWebGl2 } from "./zen/zenWebGlSupport";

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
    // Electron creates the window hidden, then shows and focuses it after the
    // renderer has loaded. Re-read after subscribing so a focus event between
    // the initial render and this effect cannot leave animation paused forever.
    sync();
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
  const [webGlProbe, setWebGlProbe] = useState(() =>
    config.enabled
      ? { complete: true, supported: hasUsableZenWebGl2() }
      : { complete: false, supported: false },
  );
  const [rendererStatus, setRendererStatus] = useState<ZenShaderRendererStatus>(
    webGlProbe.supported ? "initializing" : "fallback-unsupported",
  );
  useEffect(() => {
    if (!config.enabled || webGlProbe.complete) return;
    const supported = hasUsableZenWebGl2();
    setWebGlProbe({ complete: true, supported });
    setRendererStatus(supported ? "initializing" : "fallback-unsupported");
  }, [config.enabled, webGlProbe.complete]);

  const webGlSupported = webGlProbe.supported;
  const playing =
    config.enabled &&
    webGlSupported &&
    !reduced &&
    windowActive &&
    config.speed > 0;
  const backgroundRenderer = !config.enabled
    ? "none"
    : rendererStatus === "webgl"
      ? "webgl"
      : rendererStatus === "initializing"
        ? "initializing"
        : "fallback";
  const fallbackReason =
    config.enabled && rendererStatus.startsWith("fallback-")
      ? rendererStatus
      : undefined;

  return (
    <motion.div
      data-editor-ambient
      data-zen-mode={active ? "true" : "false"}
      data-background-enabled={config.enabled ? "true" : "false"}
      data-background-renderer={backgroundRenderer}
      data-background-fallback-reason={fallbackReason}
      data-motion={
        playing && rendererStatus === "webgl" ? "drifting" : "static"
      }
      data-window-active={windowActive ? "true" : "false"}
      data-background-shader={config.shader}
      data-background-dither={config.dither.enabled ? "true" : "false"}
      data-background-halftone={config.halftone.enabled ? "true" : "false"}
      data-background-contrast-guard={config.contrastGuard.mode}
      aria-hidden="true"
      className="editor-ambient-backdrop pointer-events-none absolute inset-0 overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{
        duration: reduced ? 0 : ZEN_AMBIENT_DURATIONS.enter,
        ease: EASINGS.easeOut,
      }}
    >
      {config.enabled && webGlProbe.complete && (
        <ZenShaderSurface
          config={config}
          playing={playing}
          webGlSupported={webGlSupported}
          onRendererStatusChange={setRendererStatus}
        />
      )}
    </motion.div>
  );
}
