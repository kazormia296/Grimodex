import { useEffect, useSyncExternalStore } from "react";
import {
  acquireZenWebGl2Probe,
  readCachedZenWebGl2Support,
  subscribeZenWebGl2Support,
} from "./zenWebGlSupport";

export type ZenWebGl2SupportState = "pending" | "supported" | "unsupported";

function readServerSupport() {
  return false;
}

/**
 * Reads the per-renderer WebGL2 probe result without ever probing during
 * render. While `enabled` and unknown, an effect starts (or joins) the
 * deferred probe and releases it on unmount so an abandoned probe stops.
 */
export function useZenWebGl2Support(enabled: boolean): ZenWebGl2SupportState {
  const supported = useSyncExternalStore(
    subscribeZenWebGl2Support,
    readCachedZenWebGl2Support,
    readServerSupport,
  );
  const unknown = supported === null;

  useEffect(() => {
    if (!enabled || !unknown) return;
    return acquireZenWebGl2Probe();
  }, [enabled, unknown]);

  if (supported === null) return "pending";
  return supported ? "supported" : "unsupported";
}
