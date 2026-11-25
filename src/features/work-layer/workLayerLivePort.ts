import type {
  CandidateCountSnapshot,
  WorkLayerLiveEntry,
  WorkLayerLiveEntryReason,
  WorkLayerLivePortDependencies,
  WorkLayerModel,
  WorkLayerOpenSurface,
  WorkLayerPort,
} from "./types";

type StaleProposalRead =
  | { readonly state: "allowed"; readonly count: number }
  | { readonly state: "not-allowed" }
  | {
      readonly state: "unavailable";
      readonly reason: WorkLayerLiveEntryReason;
    };

type ScanOutcome = "completed" | "failed" | "timed-out" | "disposed";

const DEFAULT_DISPLAY_WAIT_LIMIT_MS = 60_000;

function emptyModel(projectId: string): WorkLayerModel {
  return {
    scopeId: projectId,
    liveEntries: [],
    focus: null,
    attention: [],
    disposedAttention: [],
    system: { state: "idle", label: "idle" },
  };
}

export function createWorkLayerLivePort(
  deps: WorkLayerLivePortDependencies,
): WorkLayerPort & {
  subscribe(listener: (model: WorkLayerModel) => void): () => void;
  openSurface(surface: WorkLayerOpenSurface): void;
  dispose(): void;
} {
  const waitLimit = deps.displayWaitLimitMs ?? DEFAULT_DISPLAY_WAIT_LIMIT_MS;
  const listeners = new Set<(model: WorkLayerModel) => void>();
  const subscriptionCleanups = new Set<() => void>();
  let disposed = false;
  let latestModel: WorkLayerModel | null = null;
  let candidateRevision = 0;
  let mountFlight: Promise<WorkLayerModel> | null = null;
  let trayFlight: Promise<WorkLayerModel> | null = null;
  let resolveDisposed!: () => void;
  const disposedSignal = new Promise<void>((resolve) => {
    resolveDisposed = resolve;
  });

  const canShowCandidates = (): boolean => {
    try {
      return deps.isCandidateExtractionApplicable();
    } catch {
      return false;
    }
  };

  const readCandidateCount = (): CandidateCountSnapshot => {
    try {
      return deps.readCandidateCount();
    } catch {
      return { status: "unavailable" };
    }
  };

  const candidateEntry = (
    snapshot: CandidateCountSnapshot,
    reason?: WorkLayerLiveEntryReason,
  ): WorkLayerLiveEntry => {
    const open: WorkLayerOpenSurface | undefined = (() => {
      try {
        return deps.structureReviewAvailable()
          ? { surface: "structure-extract-review" }
          : undefined;
      } catch {
        return undefined;
      }
    })();
    return {
      id: "codex-candidates",
      status: snapshot.status,
      count: snapshot.status === "ready" ? snapshot.count : null,
      ...(open == null ? {} : { open }),
      ...(snapshot.status === "unavailable"
        ? { reason: reason ?? ("failed" as const) }
        : {}),
    };
  };

  const readStaleProposalCount = async (): Promise<StaleProposalRead> => {
    try {
      const result = await deps.readStaleProposalCount();
      return result.allowed
        ? { state: "allowed", count: result.count }
        : { state: "not-allowed" };
    } catch {
      return { state: "unavailable", reason: "failed" };
    }
  };

  const buildModel = (
    candidateSnapshot: CandidateCountSnapshot,
    staleRead: StaleProposalRead,
    candidateReason?: WorkLayerLiveEntryReason,
  ): WorkLayerModel => {
    const liveEntries: WorkLayerLiveEntry[] = [];
    if (canShowCandidates())
      liveEntries.push(candidateEntry(candidateSnapshot, candidateReason));
    if (staleRead.state === "allowed") {
      liveEntries.push({
        id: "stale-proposals",
        status: "ready",
        count: staleRead.count,
      });
    } else if (staleRead.state === "unavailable") {
      liveEntries.push({
        id: "stale-proposals",
        status: "unavailable",
        count: null,
        reason: staleRead.reason,
      });
    }
    return { ...emptyModel(deps.projectId), liveEntries };
  };

  const remember = (model: WorkLayerModel): WorkLayerModel => {
    if (disposed) return emptyModel(deps.projectId);
    latestModel = model;
    return model;
  };

  const replaceCandidateEntry = (
    model: WorkLayerModel,
    snapshot: CandidateCountSnapshot,
  ): WorkLayerModel => {
    const entries = (model.liveEntries ?? []).filter(
      (entry) => entry.id !== "codex-candidates",
    );
    if (canShowCandidates()) entries.unshift(candidateEntry(snapshot));
    return { ...model, liveEntries: entries };
  };

  const openSurface = (surface: WorkLayerOpenSurface) => {
    if (disposed) return;
    if (surface.surface === "structure-extract-review") {
      deps.openStructureReview?.();
    }
  };

  const publishCandidateCount = (snapshot = readCandidateCount()) => {
    if (disposed || latestModel == null) return;
    const next = replaceCandidateEntry(latestModel, snapshot);
    latestModel = next;
    for (const listener of listeners) listener(next);
  };

  const replaceStaleEntry = (
    model: WorkLayerModel,
    read: StaleProposalRead,
  ): WorkLayerModel => {
    const entries = (model.liveEntries ?? []).filter(
      (entry) => entry.id !== "stale-proposals",
    );
    if (read.state === "allowed") {
      entries.push({
        id: "stale-proposals",
        status: "ready",
        count: read.count,
      });
    } else if (read.state === "unavailable") {
      entries.push({
        id: "stale-proposals",
        status: "unavailable",
        count: null,
        reason: read.reason,
      });
    }
    return { ...model, liveEntries: entries };
  };

  const publishStaleRead = (read: StaleProposalRead) => {
    if (disposed || latestModel == null) return;
    const next = replaceStaleEntry(latestModel, read);
    latestModel = next;
    for (const listener of listeners) listener(next);
  };

  /**
   * The policy and Inbox reads have no deadline of their own. Past the display
   * wait limit the row is shown as unavailable; the read keeps running, and a
   * late answer replaces the row when it arrives.
   */
  const readStaleProposalCountWithin = async (): Promise<StaleProposalRead> => {
    const read = readStaleProposalCount();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timed-out">((resolve) => {
      timer = setTimeout(() => resolve("timed-out"), waitLimit);
    });
    const result = await Promise.race([
      read,
      timeout,
      disposedSignal.then(() => "disposed" as const),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (result === "timed-out") {
      void read.then((late) => publishStaleRead(late));
      return { state: "unavailable", reason: "timed-out" };
    }
    if (result === "disposed")
      return { state: "unavailable", reason: "failed" };
    return result;
  };

  const raceDisposed = (promise: Promise<WorkLayerModel>) =>
    Promise.race([
      promise,
      disposedSignal.then(() => emptyModel(deps.projectId)),
    ]);

  const runMount = async (): Promise<WorkLayerModel> => {
    const candidateApplicable = canShowCandidates();
    const revision = candidateRevision;
    const candidateSnapshot = candidateApplicable
      ? readCandidateCount()
      : { status: "not-counted" as const };
    const staleRead = await readStaleProposalCountWithin();
    const currentSnapshot =
      candidateApplicable && revision !== candidateRevision
        ? readCandidateCount()
        : candidateSnapshot;
    return remember(buildModel(currentSnapshot, staleRead));
  };

  const runTrayOpen = async (): Promise<WorkLayerModel> => {
    const candidateApplicable = canShowCandidates();
    const revision = candidateRevision;
    const candidateSnapshot = candidateApplicable
      ? readCandidateCount()
      : { status: "not-counted" as const };
    const staleReadPromise = readStaleProposalCountWithin();
    const scanPromise = candidateApplicable
      ? Promise.resolve()
          .then(() => deps.ensureCandidateScan())
          .then(
            () => "completed" as const,
            () => "failed" as const,
          )
      : Promise.resolve("completed" as const);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ScanOutcome>((resolve) => {
      timer = setTimeout(() => resolve("timed-out"), waitLimit);
    });
    const outcome = await Promise.race<ScanOutcome>([
      scanPromise,
      timeout,
      disposedSignal.then(() => "disposed" as const),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    const staleRead = await staleReadPromise;
    if (disposed || outcome === "disposed") return emptyModel(deps.projectId);
    if (outcome === "timed-out") {
      // A count that arrived while we waited is newer than the timeout marker.
      const arrived =
        revision !== candidateRevision ? readCandidateCount() : null;
      const model = remember(
        buildModel(
          arrived?.status === "ready" ? arrived : { status: "unavailable" },
          staleRead,
          "timed-out",
        ),
      );
      void scanPromise.then((lateOutcome) => {
        if (disposed) return;
        candidateRevision += 1;
        publishCandidateCount(
          lateOutcome === "completed"
            ? readCandidateCount()
            : { status: "unavailable" },
        );
      });
      return model;
    }
    return remember(
      buildModel(
        outcome === "completed"
          ? canShowCandidates()
            ? readCandidateCount()
            : candidateSnapshot
          : { status: "unavailable" },
        staleRead,
      ),
    );
  };

  const finishFlight = (
    flight: Promise<WorkLayerModel>,
    reason: "mount" | "tray-open",
  ) => {
    const clear = () => {
      if (reason === "mount" && mountFlight === flight) mountFlight = null;
      if (reason === "tray-open" && trayFlight === flight) trayFlight = null;
    };
    void flight.then(clear, clear);
    return flight;
  };

  const load = ({ reason }: { readonly reason: "mount" | "tray-open" }) => {
    if (disposed) return Promise.resolve(emptyModel(deps.projectId));
    if (trayFlight != null) return trayFlight;
    if (reason === "mount" && mountFlight != null) return mountFlight;

    if (reason === "tray-open" && mountFlight != null) {
      const afterMount = mountFlight.then(() =>
        disposed
          ? emptyModel(deps.projectId)
          : runTrayOpen().catch(() =>
              remember(
                buildModel(
                  { status: "unavailable" },
                  { state: "unavailable", reason: "failed" },
                ),
              ),
            ),
      );
      const queuedFlight = raceDisposed(afterMount);
      trayFlight = queuedFlight;
      return finishFlight(queuedFlight, reason);
    }

    const run = reason === "mount" ? runMount() : runTrayOpen();
    const flight = raceDisposed(
      run.catch(() =>
        remember(
          buildModel(
            { status: "unavailable" },
            { state: "unavailable", reason: "failed" },
          ),
        ),
      ),
    );
    if (reason === "mount") {
      mountFlight = flight;
      return finishFlight(flight, reason);
    }
    trayFlight = flight;
    return finishFlight(flight, reason);
  };

  const subscribe = (listener: (model: WorkLayerModel) => void) => {
    if (disposed) return () => {};
    listeners.add(listener);
    if (listeners.size === 1) {
      const cleanup = deps.subscribeCandidateCount(() => {
        candidateRevision += 1;
        publishCandidateCount();
      });
      subscriptionCleanups.add(cleanup);
    }
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(listener);
      if (listeners.size === 0) {
        for (const cleanup of subscriptionCleanups) cleanup();
        subscriptionCleanups.clear();
      }
    };
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    resolveDisposed();
    for (const cleanup of subscriptionCleanups) cleanup();
    subscriptionCleanups.clear();
    listeners.clear();
    latestModel = null;
  };

  return {
    kind: "live",
    scopeKey: deps.projectId,
    load,
    subscribe,
    openSurface,
    dispose,
  };
}
