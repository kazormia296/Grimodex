import { Component, Suspense, lazy } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { PROFILE_ACTIVATION_UI_ENABLED } from "./profileActivationAvailability";

// The status display is a lazy chunk requested only while the constant is on
// (DR-DA2-30). A chunk that fails to load rejects the lazy component and is
// caught by the boundary below, like a render or effect error of the display.
const ProfileEgressStatusIndicator = /* @__PURE__ */ lazy(
  () => import("./ProfileEgressStatusIndicator"),
);

/**
 * Error boundary of the status display (DR-DA2-62, R3-7). It lives in the
 * startup graph on purpose: a boundary inside the lazy chunk cannot catch the
 * chunk's own load failure or its module-evaluation errors. A failure of the
 * display (chunk, render, effect) draws nothing and is logged, instead of
 * reaching the app root's full-screen `ErrorBoundary`.
 *
 * It never closes the AI entrances itself: the display is only the UI side of
 * the closure (the defence is Main's gate and Native, DR-DA2B-R6), and an
 * unknown state closes nothing, the same as "loading" and "unknown". The chat
 * panel's probe closes its own entrances independently.
 */
export class ProfileEgressStatusBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    debugLog.error("ProfileEgressStatus", "status display failed", {
      sensitivity: "content-derived",
      fields: {
        error: errorDetail(error),
        componentStack: info.componentStack ?? "",
      },
    });
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * App-wide mount point of the profile egress status (NIR-1 DA-2 ST3), placed
 * with the application dialogs (`ApplicationDialogs.tsx`). While
 * `PROFILE_ACTIVATION_UI_ENABLED` is false it creates no element, requests no
 * chunk and calls no IPC (D-13 (a)).
 */
export function ProfileEgressStatusSlot() {
  return PROFILE_ACTIVATION_UI_ENABLED ? (
    <ProfileEgressStatusBoundary>
      <Suspense fallback={null}>
        <ProfileEgressStatusIndicator />
      </Suspense>
    </ProfileEgressStatusBoundary>
  ) : null;
}
