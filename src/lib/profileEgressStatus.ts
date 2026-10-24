/**
 * Renderer wrapper of the profile egress state and the activation request
 * (NIR-1 DA-2; DR-DA2-9 and DR-DA2-16 in
 * `docs/plans/nir1-lane-decisions/da2-decisions.md`).
 *
 * The renderer only reads closed codes and asks; Electron main decides and
 * shows the confirmation. Nothing here carries plaintext or an id.
 *
 * Startup graph: this module is not imported by the startup graph. Import it
 * only from a lazy chunk (ST3, behind `PROFILE_ACTIVATION_UI_ENABLED`).
 *
 * The two commands bypass the renderer's IPC queue on purpose: they are
 * processed by Main without touching Native data, and the request waits for
 * the user's dialog (up to the preview's 60 s) and the bounded stages, which
 * must not hold a queue slot or a lifecycle quiescence.
 */
import {
  PROFILE_ACTIVATION_REQUEST_COMMAND,
  PROFILE_EGRESS_STATE_EVENT,
  PROFILE_EGRESS_STATUS_COMMAND,
  parseProfileActivationRequestResult,
  parseProfileEgressStatusView,
  type ProfileActivationRequestResult,
  type ProfileEgressStatusView,
} from "@/../electron/shared/profileEgressStatusWire";

/**
 * The preload bridge, read directly rather than through `./shell` (the same
 * check as `isElectron()` and `electronBridge()`): this module is reached only
 * from lazy chunks, and importing `./shell` from them splits it out of the
 * startup `tauri` chunk, which grows every startup preload list (DR-DA2-30).
 */
function bridge(): NonNullable<Window["grimodex"]> | undefined {
  return typeof window !== "undefined" ? window.grimodex : undefined;
}

export type {
  ProfileActivationRequestResult,
  ProfileActivationRequestStatus,
  ProfileEgressState,
  ProfileEgressStatusView,
  ProfileEgressUnavailableReason,
} from "@/../electron/shared/profileEgressStatusWire";

/** Outside Electron there is no profile gate: the legacy runtimes are unrestricted. */
const NON_ELECTRON_STATUS: ProfileEgressStatusView = { state: "unrestricted" };

/** The current state. Main answers while unavailable too. */
export async function getProfileEgressStatus(): Promise<ProfileEgressStatusView> {
  const electron = bridge();
  if (!electron) return NON_ELECTRON_STATUS;
  const envelope = await electron.invoke(PROFILE_EGRESS_STATUS_COMMAND);
  if (!envelope.ok) {
    throw new Error("PROFILE_EGRESS_STATUS_UNAVAILABLE");
  }
  const view = parseProfileEgressStatusView(envelope.value);
  if (view === null) throw new Error("PROFILE_EGRESS_STATUS_INVALID");
  return view;
}

/**
 * Asks Main to run the activation. Main shows its own confirmation; the
 * answer is a closed status. Before PUB-G it is always `not-activated`.
 */
export async function requestProfileActivation(): Promise<ProfileActivationRequestResult> {
  const electron = bridge();
  if (!electron) return { status: "not-activated" };
  const envelope = await electron.invoke(PROFILE_ACTIVATION_REQUEST_COMMAND);
  const result = envelope.ok
    ? parseProfileActivationRequestResult(envelope.value)
    : null;
  return result ?? { status: "refused" };
}

/**
 * Subscribes to the state Main sends at stage 2 (`activating`), stage 6
 * (`restricted`) and on a failure (`unavailable` with its reason). A payload
 * outside the closed union is dropped. Returns the unsubscribe.
 */
export function onProfileEgressStatus(
  handler: (view: ProfileEgressStatusView) => void,
): () => void {
  const electron = bridge();
  if (!electron) return () => undefined;
  return electron.listen(PROFILE_EGRESS_STATE_EVENT, (payload) => {
    const view = parseProfileEgressStatusView(payload);
    if (view !== null) handler(view);
  });
}
