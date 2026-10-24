import { useEffect, useState } from "react";
import { debugLog } from "@/lib/debugLog";
import {
  getProfileEgressStatus,
  onProfileEgressStatus,
  type ProfileEgressState,
  type ProfileEgressStatusView,
} from "@/lib/profileEgressStatus";

/**
 * The state only moves forward in a process: unrestricted → activating →
 * restricted or unavailable (there is no release, and unavailable is left only
 * by a restart). A view of a lower rank is older.
 */
const RANK: Readonly<Record<ProfileEgressState, number>> = {
  unrestricted: 0,
  activating: 1,
  restricted: 2,
  unavailable: 2,
};

/** `loading` until the first answer; `unknown` when it could not be read. */
export type ProfileEgressStatusSnapshot =
  | { readonly kind: "loading" }
  | { readonly kind: "unknown" }
  | { readonly kind: "known"; readonly view: ProfileEgressStatusView };

function viewOf(
  snapshot: ProfileEgressStatusSnapshot,
): ProfileEgressStatusView | null {
  return snapshot.kind === "known" ? snapshot.view : null;
}

/**
 * Subscribes to `profile-egress:state` first and then reads the current state
 * (Main sends the event only at stage 2, stage 6 and on a failure, never at
 * startup; DR-DA2-9). An event replaces a view of the same or a lower rank;
 * the read's answer replaces only a view of a lower rank, so an answer that
 * raced an event never moves the display backwards.
 *
 * Import only from a lazy chunk behind `PROFILE_ACTIVATION_UI_ENABLED`.
 */
export function useProfileEgressStatus(): ProfileEgressStatusSnapshot {
  const [snapshot, setSnapshot] = useState<ProfileEgressStatusSnapshot>({
    kind: "loading",
  });
  useEffect(() => {
    let active = true;
    const unsubscribe = onProfileEgressStatus((view) => {
      if (!active) return;
      setSnapshot((previous) => {
        const current = viewOf(previous);
        return current && RANK[current.state] > RANK[view.state]
          ? previous
          : { kind: "known", view };
      });
    });
    getProfileEgressStatus().then(
      (view) => {
        if (!active) return;
        setSnapshot((previous) => {
          const current = viewOf(previous);
          return current && RANK[current.state] >= RANK[view.state]
            ? previous
            : { kind: "known", view };
        });
      },
      () => {
        if (!active) return;
        // A fixed message only: Main answers with a closed union, so a failure
        // here is a broken bridge, not a state.
        debugLog.warn("profile-egress", "status unavailable");
        setSnapshot((previous) =>
          previous.kind === "loading" ? { kind: "unknown" } : previous,
        );
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return snapshot;
}
