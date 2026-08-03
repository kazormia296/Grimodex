import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import {
  listEventParticipantsForProject,
  listEventRelations,
  listEvents,
  listSceneEvents,
  type EventRelationRow,
  type EventRow,
  type ParticipantRow,
  type SceneEventRow,
} from "./api";
import {
  chronicleScopeKey,
  type ChronicleScope,
  type ChronicleScopeKey,
} from "./chronicleScope";

export interface ChronicleQueryState {
  events: EventRow[];
  sceneLinks: SceneEventRow[];
  relations: EventRelationRow[];
  participants: ParticipantRow[];
}

export type ChronicleQueryStatus =
  | "idle"
  | "loading"
  | "ready"
  | "refreshing"
  | "error";

export interface ChronicleQueryResult extends ChronicleQueryState {
  /** Exact owner of the displayed last-good snapshot. */
  snapshotScopeKey: ChronicleScopeKey | null;
  /**
   * The currently requested generation. It changes for scope, external
   * invalidation, local reload, and retry.
   */
  requestGeneration: string | null;
  status: ChronicleQueryStatus;
  error: Error | null;
  /**
   * True only when all four reads succeeded for the current request
   * generation. A same-scope lastGood can remain visible while this is false.
   */
  isSnapshotFresh: boolean;
  /** Retry the exact current scope/invalidation inputs with a new generation. */
  retry: () => void;
  /** Optimistic event patches stay inside the exact snapshot owner. */
  setEvents: (action: SetStateAction<EventRow[]>) => void;
}

export interface ChronicleQueryOptions {
  scope: ChronicleScope | null;
  /** Hidden keepalive panels defer all Chronicle reads until reactivated. */
  enabled: boolean;
  reloadKey: number;
  revisionCounter: number;
  /** Scope-local transient state must be reset before the next snapshot. */
  onScopeChanged?: (scope: ChronicleScope | null) => void;
  /** Called after the first complete snapshot for an exact scope. */
  onScopeLoaded?: (eventCount: number) => void;
  /** Lets the owner sanitize selection after a complete atomic snapshot. */
  onEventsLoaded?: (events: EventRow[]) => void;
}

const EMPTY_STATE: ChronicleQueryState = {
  events: [],
  sceneLinks: [],
  relations: [],
  participants: [],
};

interface ChronicleSnapshot {
  scopeKey: ChronicleScopeKey;
  requestGeneration: string;
  data: ChronicleQueryState;
}

interface ChronicleRequest {
  scopeKey: ChronicleScopeKey;
  requestGeneration: string;
  status: Exclude<ChronicleQueryStatus, "idle">;
  error: Error | null;
}

interface ChronicleQueryMachine {
  snapshot: ChronicleSnapshot | null;
  request: ChronicleRequest | null;
}

const INITIAL_MACHINE: ChronicleQueryMachine = {
  snapshot: null,
  request: null,
};

function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(
    typeof reason === "string" ? reason : "Chronicle snapshot read failed",
  );
}

function requestGenerationKey(args: {
  scopeKey: ChronicleScopeKey;
  reloadKey: number;
  revisionCounter: number;
  retryCounter: number;
}): string {
  return JSON.stringify([
    args.scopeKey,
    args.reloadKey,
    args.revisionCounter,
    args.retryCounter,
  ]);
}

/**
 * Owns the Chronicle read snapshot at an exact workspace/open/project scope.
 *
 * The four collections publish as one snapshot. Scope changes synchronously
 * hide the previous database's rows. Same-scope invalidations retain lastGood
 * while loading or after a read error, but the stale snapshot is never marked
 * fresh. Hidden panels perform no reads and coalesce invalidations into the
 * single latest generation that is loaded on activation.
 */
export function useChronicleQuery({
  scope,
  enabled,
  reloadKey,
  revisionCounter,
  onScopeChanged,
  onScopeLoaded,
  onEventsLoaded,
}: ChronicleQueryOptions): ChronicleQueryResult {
  const [machine, setMachine] =
    useState<ChronicleQueryMachine>(INITIAL_MACHINE);
  const [retryCounter, setRetryCounter] = useState(0);

  const scopeKey = scope ? chronicleScopeKey(scope) : null;
  const requestGeneration = scopeKey
    ? requestGenerationKey({
        scopeKey,
        reloadKey,
        revisionCounter,
        retryCounter,
      })
    : null;

  const currentScopeKeyRef = useRef<ChronicleScopeKey | null>(scopeKey);
  const currentRequestGenerationRef = useRef<string | null>(requestGeneration);
  const enabledRef = useRef(enabled);
  const scopeRef = useRef(scope);
  const lastGoodRef = useRef<ChronicleSnapshot | null>(null);
  const announcedLoadedScopeKeyRef = useRef<ChronicleScopeKey | null>(null);
  const notifiedScopeKeyRef = useRef<ChronicleScopeKey | null | undefined>(
    undefined,
  );
  const callbacksRef = useRef({
    onScopeChanged,
    onScopeLoaded,
    onEventsLoaded,
  });

  // These guards intentionally update during render. A response that settles
  // between render and effect cleanup must already see the new ownership.
  currentScopeKeyRef.current = scopeKey;
  currentRequestGenerationRef.current = requestGeneration;
  enabledRef.current = enabled;
  scopeRef.current = scope;
  callbacksRef.current = {
    onScopeChanged,
    onScopeLoaded,
    onEventsLoaded,
  };

  useEffect(() => {
    if (notifiedScopeKeyRef.current === scopeKey) return;

    const previousScopeKey = notifiedScopeKeyRef.current;
    notifiedScopeKeyRef.current = scopeKey;
    announcedLoadedScopeKeyRef.current = null;
    lastGoodRef.current = null;
    setMachine(INITIAL_MACHINE);

    // Initial null is not a boundary. A real initial scope and every later
    // transition (including scope -> null) are.
    if (previousScopeKey !== undefined || scopeKey !== null) {
      callbacksRef.current.onScopeChanged?.(scopeRef.current);
    }
  }, [scopeKey]);

  useEffect(() => {
    if (!enabled || !scopeKey || !requestGeneration) return;

    const requestScope = scopeRef.current;
    if (
      !requestScope ||
      chronicleScopeKey(requestScope) !== scopeKey ||
      currentRequestGenerationRef.current !== requestGeneration
    ) {
      return;
    }

    const lastGood =
      lastGoodRef.current?.scopeKey === scopeKey ? lastGoodRef.current : null;

    // A hide/show without an invalidation keeps the already complete snapshot
    // and must not create another DB query.
    if (lastGood?.requestGeneration === requestGeneration) return;

    setMachine((current) => ({
      snapshot:
        current.snapshot?.scopeKey === scopeKey ? current.snapshot : lastGood,
      request: {
        scopeKey,
        requestGeneration,
        status: lastGood ? "refreshing" : "loading",
        error: null,
      },
    }));

    let cancelled = false;
    const projectId = requestScope.projectId;
    const eventsPromise = Promise.resolve().then(() => listEvents(projectId));
    const sceneLinksPromise = eventsPromise.then((events) =>
      listSceneEvents(events.map((event) => event.id)),
    );
    const relationsPromise = Promise.resolve().then(() =>
      listEventRelations(projectId),
    );
    const participantsPromise = Promise.resolve().then(() =>
      listEventParticipantsForProject(projectId),
    );

    void Promise.all([
      eventsPromise,
      sceneLinksPromise,
      relationsPromise,
      participantsPromise,
    ])
      .then(([events, sceneLinks, relations, participants]) => {
        if (
          cancelled ||
          !enabledRef.current ||
          currentScopeKeyRef.current !== scopeKey ||
          currentRequestGenerationRef.current !== requestGeneration
        ) {
          return;
        }

        const snapshot: ChronicleSnapshot = {
          scopeKey,
          requestGeneration,
          data: { events, sceneLinks, relations, participants },
        };
        lastGoodRef.current = snapshot;
        setMachine({
          snapshot,
          request: {
            scopeKey,
            requestGeneration,
            status: "ready",
            error: null,
          },
        });

        callbacksRef.current.onEventsLoaded?.(events);
        if (announcedLoadedScopeKeyRef.current !== scopeKey) {
          announcedLoadedScopeKeyRef.current = scopeKey;
          callbacksRef.current.onScopeLoaded?.(events.length);
        }
      })
      .catch((reason: unknown) => {
        if (
          cancelled ||
          !enabledRef.current ||
          currentScopeKeyRef.current !== scopeKey ||
          currentRequestGenerationRef.current !== requestGeneration
        ) {
          return;
        }

        const currentLastGood =
          lastGoodRef.current?.scopeKey === scopeKey
            ? lastGoodRef.current
            : null;
        setMachine({
          snapshot: currentLastGood,
          request: {
            scopeKey,
            requestGeneration,
            status: "error",
            error: toError(reason),
          },
        });
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, requestGeneration, scopeKey]);

  const retry = useCallback(() => {
    setRetryCounter((current) => current + 1);
  }, []);

  const setEvents = useCallback((action: SetStateAction<EventRow[]>) => {
    const ownerScopeKey = currentScopeKeyRef.current;
    if (!ownerScopeKey) return;

    setMachine((current) => {
      const snapshot = current.snapshot;
      if (!snapshot || snapshot.scopeKey !== ownerScopeKey) return current;

      const events =
        typeof action === "function" ? action(snapshot.data.events) : action;
      const nextSnapshot: ChronicleSnapshot = {
        ...snapshot,
        data: { ...snapshot.data, events },
      };
      lastGoodRef.current = nextSnapshot;
      return { ...current, snapshot: nextSnapshot };
    });
  }, []);

  // Filtering by the render's exact scope makes the boundary synchronous:
  // effects are not required to run before old-workspace rows disappear.
  const visibleSnapshot =
    scopeKey && machine.snapshot?.scopeKey === scopeKey
      ? machine.snapshot
      : null;
  const matchingRequest =
    scopeKey &&
    requestGeneration &&
    machine.request?.scopeKey === scopeKey &&
    machine.request.requestGeneration === requestGeneration
      ? machine.request
      : null;

  let status: ChronicleQueryStatus;
  if (!scopeKey || !enabled) {
    status = "idle";
  } else if (matchingRequest) {
    status = matchingRequest.status;
  } else if (visibleSnapshot?.requestGeneration === requestGeneration) {
    status = "ready";
  } else if (visibleSnapshot) {
    status = "refreshing";
  } else {
    status = "loading";
  }

  const isSnapshotFresh =
    visibleSnapshot !== null &&
    visibleSnapshot.requestGeneration === requestGeneration &&
    matchingRequest?.status === "ready";

  return {
    ...(visibleSnapshot?.data ?? EMPTY_STATE),
    snapshotScopeKey: visibleSnapshot?.scopeKey ?? null,
    requestGeneration,
    status,
    error: status === "error" ? (matchingRequest?.error ?? null) : null,
    isSnapshotFresh,
    retry,
    setEvents,
  };
}
