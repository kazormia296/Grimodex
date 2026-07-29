import { registerQuiescenceProvider } from "@/lib/quiescenceProviders";
import { IpcInvokeError } from "@/lib/tauri";
import { isPanelWindow } from "@/features/layout/multiwindow/panelWindow";
import {
  isQuiescenceLeaseActive,
  isRendererTeardownStarted,
  subscribeQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";

import { semanticCancelBackground } from "./api";

export async function cancelSemanticBackgroundForLifecycle(): Promise<void> {
  try {
    await semanticCancelBackground();
  } catch (error) {
    if (
      error instanceof IpcInvokeError &&
      (error.code === "IPC_BACKEND_UNAVAILABLE" ||
        error.code === "IPC_UNIMPLEMENTED")
    ) {
      // Version-skewed native modules cannot have started a command they do
      // not implement. Keep document lifecycle operations available.
      return;
    }
    throw error;
  }
}

/**
 * A cancelled close or failed Project/Workspace transition keeps the same
 * published authority. Notify the main App when the last lease releases so
 * auto-index guards cleared by IPC_DERIVED_CANCELLED can retry immediately.
 * A successful native close is different: restarting a backfill while the
 * renderer is being destroyed can keep Electron's N-API process alive.
 */
export function subscribeSemanticRetryAfterLifecycle(
  listener: () => void,
): () => void {
  return subscribeQuiescenceLease((change) => {
    if (
      !isQuiescenceLeaseActive() &&
      !isRendererTeardownStarted() &&
      change.releaseDisposition !== "renderer-teardown"
    ) {
      listener();
    }
  });
}

export function shouldOwnSemanticLifecycle(panelWindow: boolean): boolean {
  return !panelWindow;
}

// Semantic auto-index ownership belongs to the main renderer. A detached panel
// must not rotate the process-global native epoch and cancel work started by
// another renderer merely because that panel is closing.
if (shouldOwnSemanticLifecycle(isPanelWindow())) {
  registerQuiescenceProvider({
    id: "semantic-background-index",
    stage: "scoped-mutations",
    flush: cancelSemanticBackgroundForLifecycle,
  });
}
