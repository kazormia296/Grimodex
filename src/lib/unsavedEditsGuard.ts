/**
 * Renderer wrapper of the unsaved-edits guard (PUB-G #36, DR-PUBG-36-1 in
 * `docs/plans/nir1-lane-decisions/cp3b-decisions.md`).
 *
 * The renderer owns the unsaved text. It reports a single boolean to Electron
 * main whenever it flips, and shows a sticky notice when main sends the
 * "retained" event after the author chose to go back instead of exiting. No
 * text, path or id crosses this wrapper, and nothing is stored.
 *
 * Like `profileEgressStatus.ts`, the bridge is read directly so the report
 * bypasses the renderer IPC queue: it must still go through while a lifecycle
 * quiescence holds the queue, which is exactly when a save can be stuck.
 */
import {
  REPORT_UNSAVED_EDITS_COMMAND,
  UNSAVED_EDITS_RETAINED_EVENT,
} from "@/../electron/shared/unsavedEditsWire";

function bridge(): NonNullable<Window["grimodex"]> | undefined {
  return typeof window !== "undefined" ? window.grimodex : undefined;
}

/**
 * Report the flag when it changes. Failures are dropped: Main then keeps the
 * previous value, which only affects an already-fatal exit confirmation.
 */
export function createUnsavedEditsReporter(): (hasUnsaved: boolean) => void {
  let last = false;
  return (hasUnsaved) => {
    if (hasUnsaved === last) return;
    const electron = bridge();
    if (!electron) return;
    last = hasUnsaved;
    void electron
      .invoke(REPORT_UNSAVED_EDITS_COMMAND, { hasUnsaved })
      .then((envelope) => {
        if (!envelope.ok) last = !hasUnsaved;
      })
      .catch(() => {
        // Retry on the next flip.
        last = !hasUnsaved;
      });
  };
}

/** Main told this window the author went back; returns the unsubscribe. */
export function onUnsavedEditsRetained(handler: () => void): () => void {
  const electron = bridge();
  if (!electron) return () => undefined;
  return electron.listen(UNSAVED_EDITS_RETAINED_EVENT, () => handler());
}
