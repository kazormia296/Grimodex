import type { WindowCloseRequestedEvent } from "@/lib/windowControls";
import {
  isAuthorityBlockingLifecycleIdle,
  waitForAuthorityBlockingLifecycleIdle,
  type QuiescenceLease,
} from "./quiescenceLease";
import { acquireQuiescenceLeaseAfterTimelapseGenesis } from "@/features/timelapse/genesisQuiescence";
import {
  clearQuiescenceDiagnostics,
  publishCloseQuiescenceDiagnostics,
  type ClosePhase,
} from "./quiescenceDiagnostics";
import {
  StrictQuiescenceError,
  type QuiescenceFailure,
} from "./quiescenceCoordinator";

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
  onFailure: (error: unknown, closePhase: ClosePhase) => void;
}

export function createCloseQuiescenceController(
  options: CloseQuiescenceOptions,
): CloseQuiescenceController {
  let approved = false;
  let inFlight: Promise<void> | null = null;
  let lease: QuiescenceLease | null = null;
  let generation = 0;
  let waitAbortController: AbortController | null = null;
  let closePhase: ClosePhase = "genesis-prelude";

  const ensureLease = async (
    signal?: AbortSignal,
  ): Promise<QuiescenceLease> => {
    if (lease) return lease;
    const acquired = await acquireQuiescenceLeaseAfterTimelapseGenesis(
      "window-close",
      { signal },
    );
    if (lease) {
      acquired.release();
      return lease;
    }
    lease = acquired;
    return acquired;
  };

  const releaseLease = (
    disposition: "resume" | "renderer-teardown" = "resume",
  ): void => {
    lease?.release({ disposition });
    lease = null;
  };

  const notifyFailure = (error: unknown, phase: ClosePhase): void => {
    // Diagnostics are strictly best-effort. In particular, `instanceof` and
    // property reads can cross a rejected IPC/Proxy boundary and must never
    // prevent the existing failure dialog from opening with the original
    // error object.
    let failures: readonly QuiescenceFailure[] | undefined;
    try {
      let isStrictFailure = false;
      try {
        isStrictFailure = error instanceof StrictQuiescenceError;
      } catch {
        isStrictFailure = false;
      }
      if (isStrictFailure) {
        try {
          failures = (error as StrictQuiescenceError).failures;
        } catch {
          failures = undefined;
        }
      }
    } catch {
      failures = undefined;
    }
    try {
      publishCloseQuiescenceDiagnostics(phase, error, failures);
    } catch {
      // A diagnostics failure must not change retry/cancel/discard behavior.
    }
    options.onFailure(error, phase);
  };

  const runClose = async (attempt: number): Promise<void> => {
    if (attempt !== generation) return;
    approved = true;
    await options.close();
    if (attempt === generation) releaseLease("renderer-teardown");
  };

  const start = (): void => {
    if (approved || inFlight || options.hasImmediateVeto()) return;
    clearQuiescenceDiagnostics();
    const attempt = ++generation;
    const abortController = new AbortController();
    const leaseReady = ensureLease(abortController.signal);
    waitAbortController = abortController;
    const runAttempt = async (): Promise<void> => {
      closePhase = "genesis-prelude";
      const activeLease = await leaseReady;
      if (attempt !== generation) {
        if (lease === activeLease) releaseLease();
        else activeLease.release();
        return;
      }
      closePhase = "strict-quiescence";
      // A failed close leaves its authority barrier sealed. Re-open the
      // controlled read phase so retry can run persistence and so an existing
      // Project/Workspace lifecycle or destructive data operation can finish.
      activeLease.openTargetReadPhase();
      // Re-check synchronously after each wake-up and invoke flush in the same
      // microtask that observes idle. A lifecycle scheduled after the close
      // request but before this attempt runs is therefore included as well.
      while (attempt === generation && !isAuthorityBlockingLifecycleIdle()) {
        await waitForAuthorityBlockingLifecycleIdle(abortController.signal);
      }
      if (attempt !== generation) return;
      await options.flush();
      if (attempt !== generation) return;

      // An authority-blocking lifecycle can be scheduled while the async
      // flush is draining. Wait once more before closing so its native work
      // cannot be cut off by renderer teardown.
      while (attempt === generation && !isAuthorityBlockingLifecycleIdle()) {
        await waitForAuthorityBlockingLifecycleIdle(abortController.signal);
      }
      if (attempt !== generation) return;
      // No await may occur between the final idle observation and sealing:
      // this is the authority-commit point that prevents an old-scope read
      // from entering while the renderer is being torn down.
      lease?.sealReadsForAuthorityCommit();
      closePhase = "native-close";
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
        notifyFailure(error, closePhase);
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
      clearQuiescenceDiagnostics();
      const attempt = ++generation;
      const abortController = new AbortController();
      const leaseReady = ensureLease(abortController.signal);
      waitAbortController = abortController;
      const runDiscard = async (): Promise<void> => {
        closePhase = "genesis-prelude";
        const activeLease = await leaseReady;
        if (attempt !== generation) {
          if (lease === activeLease) releaseLease();
          else activeLease.release();
          return;
        }
        closePhase = "authority-quiescence";
        activeLease.openTargetReadPhase();
        while (attempt === generation && !isAuthorityBlockingLifecycleIdle()) {
          await waitForAuthorityBlockingLifecycleIdle(abortController.signal);
        }
        if (attempt !== generation) return;
        lease?.sealReadsForAuthorityCommit();
        closePhase = "native-close";
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
          notifyFailure(error, closePhase);
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
