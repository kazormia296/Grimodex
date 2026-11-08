import { Suspense, lazy } from "react";
import { PROFILE_ACTIVATION_UI_ENABLED } from "./profileActivationAvailability";
import { ProfileEgressStatusBoundary } from "./ProfileEgressStatusBoundary";

// The status display is a lazy chunk requested only while the constant is on
// (DR-DA2-30). A chunk that fails to load rejects the lazy component and is
// caught by the boundary below, like a render or effect error of the display.
const ProfileEgressStatusIndicator = /* @__PURE__ */ lazy(
  () => import("./ProfileEgressStatusIndicator"),
);

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
