import {
  canonicalNarrativeMaintenanceWorkKey,
  NARRATIVE_MAINTENANCE_MAX_WORK_ITEMS_PER_CYCLE,
  type NarrativeMaintenanceRequest,
  type NarrativeMaintenanceScheduler,
  type NarrativeMaintenanceWorkspaceBinding,
} from "./narrativeMaintenance.js";

export type NarrativeMaintenanceWakeReason =
  | "workspace-opened"
  | "restore-completed";

export const NARRATIVE_MAINTENANCE_REDISCOVERY_DELAY_MS = 250;
export const NARRATIVE_MAINTENANCE_MAX_REDISCOVERY_ATTEMPTS = 3;

interface NarrativeMaintenanceDiscoveryBackend {
  discoverNarrativeMaintenanceWork?(
    reason: NarrativeMaintenanceWakeReason,
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
  if (!isRecord(raw)) {
    throw new Error("native maintenance discovery returned invalid binding");
  }
  if (
    typeof raw.authorityId !== "string" ||
    raw.authorityId.trim().length === 0 ||
    !Number.isSafeInteger(raw.generation) ||
    (raw.generation as number) < 0
  ) {
    throw new Error("native maintenance discovery returned invalid binding");
  }
  return {
    authorityId: raw.authorityId,
    generation: raw.generation as number,
  };
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
    if (
      Object.keys(raw).some((key) => key !== "status" && key !== "reason")
    ) {
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
    if (
      rawPage.work.length > NARRATIVE_MAINTENANCE_MAX_WORK_ITEMS_PER_CYCLE
    ) {
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

function wakeReasonFromEventPayload(
  payload: unknown,
): NarrativeMaintenanceWakeReason {
  return isRecord(payload) && payload.reason === "restore"
    ? "restore-completed"
    : "workspace-opened";
}

function mergeWakeReason(
  first: NarrativeMaintenanceWakeReason | null,
  second: NarrativeMaintenanceWakeReason,
): NarrativeMaintenanceWakeReason {
  return first === "restore-completed" || second === "restore-completed"
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
  let pendingReason: NarrativeMaintenanceWakeReason | null = null;
  let pendingDelayMs: number | null = null;
  let lastWakeReason: NarrativeMaintenanceWakeReason | null = null;
  let rediscoveryAttempts = 0;
  let lastDiscoveryFingerprint: string | null = null;

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    scheduledReason = null;
    scheduledDelayMs = null;
  };

  const queuePending = (
    reason: NarrativeMaintenanceWakeReason,
    delayMs: number,
  ): void => {
    pendingReason = mergeWakeReason(pendingReason, reason);
    pendingDelayMs =
      pendingDelayMs === null ? delayMs : Math.min(pendingDelayMs, delayMs);
  };

  const armTimer = (
    reason: NarrativeMaintenanceWakeReason,
    delayMs: number,
  ): void => {
    if (disposed) return;
    const timerReason =
      timer === null
        ? reason
        : mergeWakeReason(scheduledReason, reason);
    lastWakeReason = timerReason;
    scheduledReason = timerReason;
    if (timer !== null && scheduledDelayMs !== null) {
      if (delayMs >= scheduledDelayMs) return;
      clearTimer();
      scheduledReason = timerReason;
    }
    scheduledDelayMs = delayMs;
    timer = setTimeout(() => {
      const nextReason = scheduledReason ?? reason;
      timer = null;
      scheduledReason = null;
      scheduledDelayMs = null;
      startDiscovery(nextReason);
    }, delayMs);
  };

  const startDiscovery = (reason: NarrativeMaintenanceWakeReason): void => {
    if (disposed) return;
    lastWakeReason = reason;
    if (discoveryInFlight) {
      queuePending(reason, 0);
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
    void (async () => {
      try {
        const response = normalizeDiscoveryResponse(
          await discover.call(backend, reason),
        );
        if ("status" in response) {
          requestRediscovery();
          return;
        }
        // No page is enqueued until every page, work identity, and the single
        // top-level binding has been validated. This closes the partial-queue
        // hole if a later page is malformed or the native response is stale.
        scheduler.requestManyWithBinding(
          response.work,
          response.workspaceBinding,
        );
        if (response.work.length === 0) {
          // The Rust planner has no durable next phase. End this wake chain;
          // a later ordinary open must not inherit RestoreCompleted forever.
          lastWakeReason = null;
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
        if (!disposed) {
          warn("[narrative-maintenance] discovery failed:", error);
          requestRediscovery();
        }
      } finally {
        discoveryInFlight = false;
        if (!disposed && pendingReason !== null) {
          const nextReason = pendingReason;
          const nextDelay = pendingDelayMs ?? 0;
          pendingReason = null;
          pendingDelayMs = null;
          armTimer(nextReason, nextDelay);
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
      queuePending(lastWakeReason, NARRATIVE_MAINTENANCE_REDISCOVERY_DELAY_MS);
      return;
    }
    armTimer(lastWakeReason, NARRATIVE_MAINTENANCE_REDISCOVERY_DELAY_MS);
  };

  return {
    handleBackendEvent(channel, payload): void {
      if (disposed || channel !== "workspace:opened") return;
      rediscoveryAttempts = 0;
      const reason = wakeReasonFromEventPayload(payload);
      lastDiscoveryFingerprint = null;
      if (discoveryInFlight) {
        queuePending(reason, 0);
        return;
      }
      armTimer(reason, 0);
    },
    requestRediscovery,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimer();
      pendingReason = null;
      pendingDelayMs = null;
    },
  };
}
