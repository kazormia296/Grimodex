import {
  canonicalNarrativeMaintenanceWorkKey,
  NARRATIVE_MAINTENANCE_MAX_WORK_ITEMS_PER_CYCLE,
  normalizeWorkspaceBinding,
  type NarrativeMaintenanceRequest,
  type NarrativeMaintenanceScheduler,
  type NarrativeMaintenanceWorkspaceBinding,
} from "./narrativeMaintenance.js";

export type NarrativeMaintenanceWakeReason =
  | "workspace-opened"
  | "restore-completed"
  | "semantic-epoch-rotated";

export const NARRATIVE_MAINTENANCE_REDISCOVERY_DELAY_MS = 250;
export const NARRATIVE_MAINTENANCE_MAX_REDISCOVERY_ATTEMPTS = 3;

interface NarrativeMaintenanceDiscoveryBackend {
  getNarrativeMaintenanceWorkspaceBinding?():
    | string
    | NarrativeMaintenanceWorkspaceBinding
    | null;
  discoverNarrativeMaintenanceWork?(
    reason: NarrativeMaintenanceWakeReason,
  ): Promise<unknown>;
  /** Durable wake outbox written by Epoch rotations; see drainWakeOutbox. */
  listNarrativeMaintenanceWakeOutbox?(): Promise<unknown>;
  ackNarrativeMaintenanceWakeOutbox?(
    ids: string[],
    workspaceBinding: NarrativeMaintenanceWorkspaceBinding,
  ): Promise<unknown>;
}

interface NarrativeMaintenanceDiscoveryResult {
  workspaceBinding: NarrativeMaintenanceWorkspaceBinding;
  work: readonly NarrativeMaintenanceRequest[];
}

interface NarrativeMaintenanceUnavailable {
  status: "workspace-unavailable";
  reason?: string;
}

export interface NarrativeMaintenanceTriggerCoordinator {
  handleBackendEvent(channel: string, payload: unknown): void;
  requestRediscovery(): void;
  /**
   * Deliver Epoch-rotation wakes committed to the durable outbox. Each
   * pending row starts a discovery chain and is acknowledged only after the
   * discovery entry point has been registered; the durable maintenance state
   * machine is the crash backstop after an ACK.
   */
  drainWakeOutbox(): Promise<void>;
  dispose(): void;
}

export interface NarrativeMaintenanceTriggerCoordinatorOptions {
  warn?: (...args: unknown[]) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonWire(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("native maintenance discovery returned malformed JSON");
  }
}

function normalizeBinding(raw: unknown): NarrativeMaintenanceWorkspaceBinding {
  const normalized = normalizeWorkspaceBinding(raw);
  if (normalized === null) {
    throw new Error("native maintenance discovery returned invalid binding");
  }
  return normalized;
}

function normalizeOptionalBinding(
  raw: unknown,
): NarrativeMaintenanceWorkspaceBinding | null {
  const parsed = parseJsonWire(raw);
  return parsed === null || parsed === undefined
    ? null
    : normalizeBinding(parsed);
}

function sameBinding(
  left: NarrativeMaintenanceWorkspaceBinding | null,
  right: NarrativeMaintenanceWorkspaceBinding | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.authorityId === right.authorityId &&
    left.generation === right.generation
  );
}

function epochEventBinding(
  payload: unknown,
): NarrativeMaintenanceWorkspaceBinding {
  if (!isRecord(payload)) {
    throw new Error(
      "narrative maintenance epoch event has no workspace binding",
    );
  }
  return normalizeBinding({
    authorityId: payload.authorityId,
    generation: payload.generation,
  });
}

function normalizeWork(raw: unknown): NarrativeMaintenanceRequest[] {
  if (!isRecord(raw)) {
    throw new Error("native maintenance discovery returned invalid work item");
  }
  const allowedKeys = new Set([
    "projectId",
    "runKind",
    "workKey",
    "semanticEpochId",
    "reasons",
  ]);
  if (Object.keys(raw).some((key) => !allowedKeys.has(key))) {
    throw new Error(
      "native maintenance discovery returned renderer-owned or digest fields",
    );
  }
  if (
    typeof raw.projectId !== "string" ||
    typeof raw.runKind !== "string" ||
    typeof raw.workKey !== "string" ||
    !Array.isArray(raw.reasons) ||
    raw.reasons.length === 0 ||
    !raw.reasons.every(
      (reason) => typeof reason === "string" && reason.trim().length > 0,
    )
  ) {
    throw new Error("native maintenance discovery returned invalid work item");
  }
  const semanticEpochId =
    raw.semanticEpochId === null || raw.semanticEpochId === undefined
      ? null
      : typeof raw.semanticEpochId === "string"
        ? raw.semanticEpochId
        : (() => {
            throw new Error(
              "native maintenance discovery returned invalid semantic epoch",
            );
          })();

  const request = {
    projectId: raw.projectId,
    runKind: raw.runKind as NarrativeMaintenanceRequest["runKind"],
    workKey: raw.workKey,
    semanticEpochId,
  };
  // Validate the complete canonical identity at this boundary. This also
  // keeps Repair and path-shaped identities out of the scheduler queue.
  canonicalNarrativeMaintenanceWorkKey(request);
  return (raw.reasons as string[]).map((reason) => ({
    ...request,
    reason,
  }));
}

function normalizeDiscoveryResponse(
  rawResponse: unknown,
): NarrativeMaintenanceDiscoveryResult | NarrativeMaintenanceUnavailable {
  const raw = parseJsonWire(rawResponse);
  if (!isRecord(raw)) {
    throw new Error("native maintenance discovery returned invalid response");
  }
  if (raw.status === "workspace-unavailable") {
    if (Object.keys(raw).some((key) => key !== "status" && key !== "reason")) {
      throw new Error("native maintenance discovery returned invalid response");
    }
    return {
      status: "workspace-unavailable",
      ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
    };
  }

  const allowedKeys = new Set(["workspaceBinding", "pages"]);
  if (Object.keys(raw).some((key) => !allowedKeys.has(key))) {
    throw new Error("native maintenance discovery returned invalid response");
  }
  if (!Array.isArray(raw.pages)) {
    throw new Error("native maintenance discovery returned invalid page list");
  }

  const work: NarrativeMaintenanceRequest[] = [];
  for (const rawPage of raw.pages as unknown[]) {
    if (!isRecord(rawPage)) {
      throw new Error("native maintenance discovery returned invalid page");
    }
    if (
      Object.keys(rawPage).some((key) => key !== "work") ||
      !Array.isArray(rawPage.work)
    ) {
      throw new Error("native maintenance discovery returned invalid page");
    }
    if (rawPage.work.length > NARRATIVE_MAINTENANCE_MAX_WORK_ITEMS_PER_CYCLE) {
      throw new Error(
        `native maintenance discovery returned a page larger than ${NARRATIVE_MAINTENANCE_MAX_WORK_ITEMS_PER_CYCLE} work items`,
      );
    }
    for (const item of rawPage.work) {
      work.push(...normalizeWork(item));
    }
  }

  return {
    workspaceBinding: normalizeBinding(raw.workspaceBinding),
    work,
  };
}

function wakeOutboxAckAccepted(raw: unknown): boolean {
  const value = parseJsonWire(raw);
  if (!isRecord(value)) {
    throw new Error("native wake outbox acknowledgement returned invalid status");
  }
  if (
    value.status === "accepted" &&
    Number.isSafeInteger(value.acknowledged) &&
    (value.acknowledged as number) >= 0 &&
    Object.keys(value).every(
      (key) => key === "status" || key === "acknowledged",
    )
  ) {
    return true;
  }
  if (
    (value.status === "workspace-binding-mismatch" ||
      value.status === "workspace-unavailable") &&
    Object.keys(value).every((key) => key === "status")
  ) {
    return false;
  }
  throw new Error("native wake outbox acknowledgement returned invalid status");
}

function wakeReasonFromEventPayload(
  payload: unknown,
): NarrativeMaintenanceWakeReason {
  return isRecord(payload) && payload.reason === "restore"
    ? "restore-completed"
    : "workspace-opened";
}

export function createNarrativeMaintenanceTriggerCoordinator(
  backend: (NarrativeMaintenanceDiscoveryBackend & object) | null,
  scheduler: NarrativeMaintenanceScheduler,
  options: NarrativeMaintenanceTriggerCoordinatorOptions = {},
): NarrativeMaintenanceTriggerCoordinator {
  const warn = options.warn ?? console.warn;
  let disposed = false;
  let discoveryInFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scheduledReason: NarrativeMaintenanceWakeReason | null = null;
  let scheduledDelayMs: number | null = null;
  let scheduledGeneration: number | null = null;
  let pendingEvent: {
    reason: NarrativeMaintenanceWakeReason;
    generation: number;
  } | null = null;
  let pendingRetryDelayMs: number | null = null;
  let lastWakeReason: NarrativeMaintenanceWakeReason | null = null;
  let chainGeneration = 0;
  let rediscoveryAttempts = 0;
  let lastDiscoveryFingerprint: string | null = null;
  let pendingWakeOutboxAck: {
    ids: string[];
    workspaceBinding: NarrativeMaintenanceWorkspaceBinding;
    generation: number;
  } | null = null;

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    scheduledReason = null;
    scheduledDelayMs = null;
    scheduledGeneration = null;
  };

  const queueRetry = (delayMs: number): void => {
    pendingRetryDelayMs =
      pendingRetryDelayMs === null
        ? delayMs
        : Math.min(pendingRetryDelayMs, delayMs);
  };

  const armTimer = (
    reason: NarrativeMaintenanceWakeReason,
    delayMs: number,
    generation = chainGeneration,
  ): void => {
    if (disposed) return;
    if (generation !== chainGeneration) return;
    lastWakeReason = reason;
    if (timer !== null && scheduledDelayMs !== null) {
      if (delayMs >= scheduledDelayMs) return;
      clearTimer();
    }
    scheduledReason = reason;
    scheduledGeneration = generation;
    scheduledDelayMs = delayMs;
    const timerGeneration = generation;
    timer = setTimeout(() => {
      const nextReason = scheduledReason ?? reason;
      const nextGeneration = scheduledGeneration ?? timerGeneration;
      timer = null;
      scheduledReason = null;
      scheduledDelayMs = null;
      scheduledGeneration = null;
      startDiscovery(nextReason, nextGeneration);
    }, delayMs);
  };

  const startDiscovery = (
    reason: NarrativeMaintenanceWakeReason,
    generation: number,
  ): void => {
    if (disposed || generation !== chainGeneration) return;
    lastWakeReason = reason;
    if (discoveryInFlight) {
      queueRetry(0);
      return;
    }
    const discover = backend?.discoverNarrativeMaintenanceWork;
    if (typeof discover !== "function") {
      warn(
        "[narrative-maintenance] background discovery disabled: native method unavailable",
      );
      return;
    }
    discoveryInFlight = true;
    const discoveryGeneration = generation;
    void (async () => {
      try {
        const response = normalizeDiscoveryResponse(
          await discover.call(backend, reason),
        );
        if (discoveryGeneration !== chainGeneration) return;
        if ("status" in response) {
          requestRediscovery();
          return;
        }
        // A durable wake belongs to the authority that listed it.  Verify
        // the discovery response and the live binding *before* scheduler
        // registration: otherwise a replacement workspace response could
        // enqueue work before its eventual non-ACK leaves the old row
        // pending.  Registration is only meaningful after every page, work
        // identity, and this single top-level binding agrees.
        const pendingAck = pendingWakeOutboxAck;
        if (pendingAck?.generation === discoveryGeneration) {
          const getBinding = backend?.getNarrativeMaintenanceWorkspaceBinding;
          if (
            typeof getBinding !== "function" ||
            !sameBinding(pendingAck.workspaceBinding, response.workspaceBinding)
          ) {
            warn(
              "[narrative-maintenance] wake outbox discovery binding changed before registration",
            );
            return;
          } else {
            let currentBinding: NarrativeMaintenanceWorkspaceBinding | null;
            try {
              currentBinding = normalizeOptionalBinding(getBinding.call(backend));
            } catch (error) {
              warn(
                "[narrative-maintenance] wake outbox binding recheck failed:",
                error,
              );
              currentBinding = null;
            }
            if (!sameBinding(pendingAck.workspaceBinding, currentBinding)) {
              warn(
                "[narrative-maintenance] wake outbox binding changed before registration",
              );
              return;
            }
          }
        }
        scheduler.requestManyWithBinding(
          response.work,
          response.workspaceBinding,
        );
        // A durable wake cannot be ACKed merely because a timer was armed.
        // Its native discovery response must have been fully validated and
        // registered with the scheduler under the same live workspace
        // binding. Keep the row pending on any stale binding, malformed
        // response, or acknowledgement failure.
        if (pendingAck?.generation === discoveryGeneration) {
          const ack = backend?.ackNarrativeMaintenanceWakeOutbox;
          try {
            const accepted =
              typeof ack === "function" &&
              wakeOutboxAckAccepted(
                await Promise.resolve(
                  ack.call(
                    backend,
                    pendingAck.ids,
                    pendingAck.workspaceBinding,
                  ),
                ),
              );
            if (!accepted) {
              warn(
                "[narrative-maintenance] wake outbox acknowledgement was not accepted",
              );
            } else if (pendingWakeOutboxAck === pendingAck) {
              pendingWakeOutboxAck = null;
            }
          } catch (error) {
            // Leaving the rows pending is safe: the next drain replays the
            // exact durable trigger after a successful registration.
            warn("[narrative-maintenance] wake outbox ack failed:", error);
          }
        }
        if (response.work.length === 0) {
          // The Rust planner has no durable next phase. End this wake chain;
          // a later ordinary open must not inherit RestoreCompleted forever.
          // A rediscovery queued while this discovery was in flight means an
          // accepted cycle created newer durable work this (stale) empty
          // result cannot see, so keep the chain alive for that retry.
          if (pendingRetryDelayMs === null) {
            lastWakeReason = null;
          }
          rediscoveryAttempts = 0;
          lastDiscoveryFingerprint = null;
        } else {
          // A phase transition changes the DB-aware planner result and starts
          // a fresh bounded chain. If a stale/pure planner returns the exact
          // same work after an accepted cycle, retain the retry count so a
          // broken follow-up cannot spin forever.
          const fingerprint = JSON.stringify([
            response.workspaceBinding,
            response.work,
          ]);
          if (fingerprint !== lastDiscoveryFingerprint) {
            rediscoveryAttempts = 0;
            lastDiscoveryFingerprint = fingerprint;
          }
        }
      } catch (error) {
        if (!disposed && discoveryGeneration === chainGeneration) {
          warn("[narrative-maintenance] discovery failed:", error);
          requestRediscovery();
        }
      } finally {
        discoveryInFlight = false;
        if (!disposed && pendingEvent !== null) {
          const nextEvent = pendingEvent;
          pendingEvent = null;
          pendingRetryDelayMs = null;
          armTimer(nextEvent.reason, 0, nextEvent.generation);
        } else if (
          !disposed &&
          discoveryGeneration === chainGeneration &&
          pendingRetryDelayMs !== null &&
          lastWakeReason !== null
        ) {
          const nextDelay = pendingRetryDelayMs;
          pendingRetryDelayMs = null;
          armTimer(lastWakeReason, nextDelay, discoveryGeneration);
        }
      }
    })();
  };

  const requestRediscovery = (): void => {
    if (disposed || lastWakeReason === null) return;
    if (rediscoveryAttempts >= NARRATIVE_MAINTENANCE_MAX_REDISCOVERY_ATTEMPTS) {
      return;
    }
    rediscoveryAttempts += 1;
    if (discoveryInFlight) {
      queueRetry(NARRATIVE_MAINTENANCE_REDISCOVERY_DELAY_MS);
      return;
    }
    armTimer(
      lastWakeReason,
      NARRATIVE_MAINTENANCE_REDISCOVERY_DELAY_MS,
      chainGeneration,
    );
  };

  const drainWakeOutbox = async (): Promise<void> => {
    if (disposed) return;
    const list = backend?.listNarrativeMaintenanceWakeOutbox;
    const ack = backend?.ackNarrativeMaintenanceWakeOutbox;
    const getBinding = backend?.getNarrativeMaintenanceWorkspaceBinding;
    if (
      typeof list !== "function" ||
      typeof ack !== "function" ||
      typeof getBinding !== "function"
    ) {
      return;
    }
    let ids: string[];
    let workspaceBinding: NarrativeMaintenanceWorkspaceBinding | null = null;
    try {
      workspaceBinding = normalizeOptionalBinding(getBinding.call(backend));
      if (workspaceBinding === null) return;
      const raw = parseJsonWire(await list.call(backend));
      if (!Array.isArray(raw)) {
        throw new Error("native wake outbox returned an invalid list");
      }
      ids = raw.map((row) => {
        if (!isRecord(row) || typeof row.id !== "string") {
          throw new Error("native wake outbox returned an invalid row");
        }
        return row.id;
      });
    } catch (error) {
      warn("[narrative-maintenance] wake outbox listing failed:", error);
      return;
    }
    if (disposed || ids.length === 0 || workspaceBinding === null) return;
    // The wake payload is only "this workspace has a rotated Epoch"; the
    // discovery planner reads the durable state machine, so one discovery
    // chain covers every pending row.
    const generation = ++chainGeneration;
    rediscoveryAttempts = 0;
    lastDiscoveryFingerprint = null;
    lastWakeReason = "semantic-epoch-rotated";
    clearTimer();
    pendingRetryDelayMs = null;
    pendingWakeOutboxAck = {
      ids,
      workspaceBinding,
      generation,
    };
    if (discoveryInFlight) {
      pendingEvent = { reason: "semantic-epoch-rotated", generation };
    } else {
      pendingEvent = null;
      armTimer("semantic-epoch-rotated", 0, generation);
    }
  };

  return {
    handleBackendEvent(channel, payload): void {
      if (
        disposed ||
        (channel !== "workspace:opened" &&
          channel !== "narrative-maintenance:epoch-rotated")
      ) {
        return;
      }
      if (channel === "narrative-maintenance:epoch-rotated") {
        try {
          const eventBinding = epochEventBinding(payload);
          const getBinding = backend?.getNarrativeMaintenanceWorkspaceBinding;
          if (typeof getBinding !== "function") {
            warn(
              "[narrative-maintenance] ignored epoch event: native binding unavailable",
            );
            return;
          }
          const currentBinding = normalizeOptionalBinding(
            getBinding.call(backend),
          );
          if (!sameBinding(eventBinding, currentBinding)) {
            return;
          }
        } catch (error) {
          warn(
            "[narrative-maintenance] ignored malformed or stale epoch event:",
            error,
          );
          return;
        }
      }
      const generation = ++chainGeneration;
      rediscoveryAttempts = 0;
      const reason =
        channel === "narrative-maintenance:epoch-rotated"
          ? "semantic-epoch-rotated"
          : wakeReasonFromEventPayload(payload);
      lastDiscoveryFingerprint = null;
      lastWakeReason = reason;
      clearTimer();
      pendingRetryDelayMs = null;
      if (discoveryInFlight) {
        // A new backend event denotes a new authority/epoch chain. Keep only
        // the newest event; an old in-flight completion is observationally
        // stale and must not enqueue its binding or mutate retry state.
        pendingEvent = { reason, generation };
        return;
      }
      pendingEvent = null;
      armTimer(reason, 0, generation);
      // Both trigger channels double as outbox drain points: a wake row
      // whose live event was lost is re-delivered here, and a row whose
      // live event did arrive is acknowledged here.
      void drainWakeOutbox();
    },
    requestRediscovery,
    drainWakeOutbox,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimer();
      pendingEvent = null;
      pendingRetryDelayMs = null;
      pendingWakeOutboxAck = null;
    },
  };
}
