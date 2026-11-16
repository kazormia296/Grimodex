import { useSyncExternalStore } from "react";
import { Toaster } from "sonner";

/**
 * Where the app's toasts appear (DR-PUBG-35-1).
 *
 * Wide and compact keep the bottom-right corner. Below 720 px the app shows the
 * phone workspace, whose bottom is the full-width nav, the AI composer (up to
 * about 90 px tall and growing) and the profile egress status display
 * (`profileEgressStatusPlacement.ts`): a bottom toast covers all three, and
 * sonner's own width <= 600 px layout spans the whole width. The phone shows
 * toasts at the top centre instead, under the header (56 px; more with a top
 * safe area) where nothing is pinned. The query is the phone breakpoint of
 * `viewportProfile.ts` (`phoneMaxExclusive` 720; `max-width` is inclusive, so
 * 719.98) and the same one the status display uses.
 */
export const PHONE_TOAST_MEDIA_QUERY = "(max-width: 719.98px)";
export const PHONE_TOAST_TOP_OFFSET =
  "calc(env(safe-area-inset-top, 0px) + 64px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(PHONE_TOAST_MEDIA_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function snapshot(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia &&
    window.matchMedia(PHONE_TOAST_MEDIA_QUERY).matches
  );
}

export function AppToaster() {
  const phone = useSyncExternalStore(subscribe, snapshot, () => false);
  // One Toaster in both layouts, so a toast on screen survives a window
  // resize across the breakpoint.
  return (
    <Toaster
      position={phone ? "top-center" : "bottom-right"}
      offset={phone ? { top: PHONE_TOAST_TOP_OFFSET } : undefined}
      mobileOffset={
        phone ? { top: PHONE_TOAST_TOP_OFFSET, left: 16, right: 16 } : undefined
      }
      richColors
    />
  );
}
