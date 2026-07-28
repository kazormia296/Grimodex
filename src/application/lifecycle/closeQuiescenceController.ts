import type { WindowCloseRequestedEvent } from "@/lib/windowControls";
import {
  acquireQuiescenceLease,
  isProjectWorkspaceLifecycleIdle,
  waitForProjectWorkspaceLifecycleIdle,
  type QuiescenceLease,
} from "./quiescenceLease";

export interface CloseQuiescenceController {
  handleCloseRequest: (event: WindowCloseRequestedEvent) => void;
  retry: () => void;
  cancel: () => void;
  discardAndClose: () => void;
}

interface CloseQuiescenceOptions {
  hasImmediateVeto: () => boolean;
  flush: () => Promise<void>;
  close: () => Promise<void>;
  onFailure: (error: unknown) => void;
}

export function createCloseQuiescenceController(
  options: CloseQuiescenceOptions,
): CloseQuiescenceController {
  let approved = false;
  let inFlight: Promise<void> | null = null;
  let lease: QuiescenceLease | null = null;
  let generation = 0;
  let waitAbortController: AbortController | null = null;

  const ensureLease = (): void => {
    lease ??= acquireQuiescenceLease("window-close");
  };

  const releaseLease = (
    disposition: "resume" | "renderer-teardown" = "resume",
  ): void => {
    lease?.release({ disposition });
    lease = null;
  };

  const runClose = async (attempt: number): Promise<void> => {
    if (attempt !== generation) return;
    approved = true;
    await options.close();
    if (attempt === generation) releaseLease("renderer-teardown");
  };

  const start = (): void => {
    if (approved || inFlight || options.hasImmediateVeto()) return;
    ensureLease();
    // A failed close leaves its authority barrier sealed. Re-open the
    // controlled read phase so retry can run persistence and so an existing
    // Project/Workspace lifecycle can finish before we attempt teardown.
    lease?.openTargetReadPhase();
    const attempt = ++generation;
    const abortController = new AbortController();
    waitAbortController = abortController;
    const runAttempt = async (): Promise<void> => {
      // Re-check synchronously after each wake-up and invoke flush in the same
      // microtask that observes idle. A lifecycle scheduled after the close
      // request but before this attempt runs is therefore included as well.
      while (attempt === generation && !isProjectWorkspaceLifecycleIdle()) {
        await waitForProjectWorkspaceLifecycleIdle(abortController.signal);
      }
      if (attempt !== generation) return;
      await options.flush();
      if (attempt !== generation) return;

      // A lifecycle can be scheduled while the async flush is draining.
      // Wait once more before closing so its native swap/hydration cannot be
      // cut off by renderer teardown.
      while (attempt === generation && !isProjectWorkspaceLifecycleIdle()) {
        await waitForProjectWorkspaceLifecycleIdle(abortController.signal);
      }
      if (attempt !== generation) return;
      // No await may occur between the final idle observation and sealing:
      // this is the authority-commit point that prevents an old-scope read
      // from entering while the renderer is being torn down.
      lease?.sealReadsForAuthorityCommit();
      await runClose(attempt);
    };
    const run = Promise.resolve()
      .then(runAttempt)
      .catch((error: unknown) => {
        if (attempt !== generation) return;
        approved = false;
        // Failure UI may offer an immediate retry. Release the single-flight
        // promise before notifying React so that action cannot be ignored. The
        // shared lifecycle lease itself remains held until retry, cancel, or a
        // successful close.
        if (inFlight === run) inFlight = null;
        options.onFailure(error);
      })
      .finally(() => {
        if (inFlight === run) inFlight = null;
        if (waitAbortController === abortController) {
          waitAbortController = null;
        }
      });
    inFlight = run;
  };

  return {
    handleCloseRequest(event) {
      if (approved) return;
      // Reply to Electron/Tauri synchronously. This cancels Electron's 1.5s
      // fallback timer; persistence may then take as long as required.
      event.preventDefault();
      start();
    },
    retry: start,
    cancel() {
      // During real Electron teardown the page can unmount before the close
      // IPC promise settles. Preserve the approved-close disposition so that
      // cleanup cannot briefly restart cancelled background work.
      const disposition = approved ? "renderer-teardown" : "resume";
      generation++;
      approved = false;
      waitAbortController?.abort();
      waitAbortController = null;
      releaseLease(disposition);
    },
    discardAndClose() {
      if (inFlight) return;
      ensureLease();
      lease?.openTargetReadPhase();
      const attempt = ++generation;
      const abortController = new AbortController();
      waitAbortController = abortController;
      const runDiscard = async (): Promise<void> => {
        while (attempt === generation && !isProjectWorkspaceLifecycleIdle()) {
          await waitForProjectWorkspaceLifecycleIdle(abortController.signal);
        }
        if (attempt !== generation) return;
        lease?.sealReadsForAuthorityCommit();
        await runClose(attempt);
      };
      const run = Promise.resolve()
        .then(runDiscard)
        .catch((error: unknown) => {
          if (attempt !== generation) return;
          approved = false;
          if (inFlight === run) inFlight = null;
          // Keep the lease so the failure dialog can retry/cancel without an
          // edit entering between an explicit discard and the next close.
          options.onFailure(error);
        })
        .finally(() => {
          if (inFlight === run) inFlight = null;
          if (waitAbortController === abortController) {
            waitAbortController = null;
          }
        });
      inFlight = run;
    },
  };
}
