import { useCallback, useEffect, useRef, useState } from "react";
import {
  requestProfileActivation,
  type ProfileActivationRequestStatus,
} from "@/lib/profileEgressStatus";

export interface ProfileActivationRequestState {
  /** True from the click until Main answers (dialog and stages 2..7). */
  readonly pending: boolean;
  /** Main's closed answer to the last request, if any. */
  readonly lastStatus: ProfileActivationRequestStatus | null;
  readonly request: () => void;
}

/**
 * The one request both entries share (K3/2 T-1: the settings item and the
 * `profile-not-restricted` guidance make the same request). The renderer only
 * asks; Main checks the sender, window and caller, shows its confirmation and
 * answers with a closed status (DR-DA2-16). A second click while one request
 * is pending sends nothing; Main would answer `busy` anyway.
 *
 * Import only from a lazy chunk behind `PROFILE_ACTIVATION_UI_ENABLED`.
 */
export function useProfileActivationRequest(): ProfileActivationRequestState {
  const [pending, setPending] = useState(false);
  const [lastStatus, setLastStatus] =
    useState<ProfileActivationRequestStatus | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const request = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    requestProfileActivation()
      .then(
        (result) => result.status,
        (): ProfileActivationRequestStatus => "refused",
      )
      .then((status) => {
        inFlight.current = false;
        if (!mounted.current) return;
        setPending(false);
        setLastStatus(status);
      });
  }, []);
  return { pending, lastStatus, request };
}
