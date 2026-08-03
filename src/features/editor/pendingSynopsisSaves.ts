import { registerQuiescenceProvider } from "@/lib/quiescenceProviders";

const DEFAULT_SAVE_DELAY_MS = 1000;
const MAX_DRAIN_ROUNDS = 50;

export type PendingSynopsisSaveOwner = symbol;

interface PendingSynopsisSave {
  owner: PendingSynopsisSaveOwner;
  value: string;
  persist: (value: string) => Promise<void>;
  onError?: (error: unknown) => void;
  cancelled: boolean;
}

interface FailedSynopsisSave {
  request: PendingSynopsisSave;
  error: unknown;
}

interface SynopsisSaveSlot {
  key: string;
  pending: PendingSynopsisSave | null;
  failed: FailedSynopsisSave | null;
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
  runningRequest: PendingSynopsisSave | null;
}

const slotsByKey = new Map<string, SynopsisSaveSlot>();

function getSlot(key: string): SynopsisSaveSlot {
  let slot = slotsByKey.get(key);
  if (!slot) {
    slot = {
      key,
      pending: null,
      failed: null,
      timer: null,
      running: null,
      runningRequest: null,
    };
    slotsByKey.set(key, slot);
  }
  return slot;
}

function cleanupSlotIfIdle(slot: SynopsisSaveSlot): void {
  if (slot.pending || slot.failed || slot.timer || slot.running) return;
  if (slotsByKey.get(slot.key) === slot) slotsByKey.delete(slot.key);
}

function reportFailure(request: PendingSynopsisSave, error: unknown): void {
  try {
    request.onError?.(error);
  } catch {
    // Persistence remains the authoritative failure. UI reporting is best-effort.
  }
}

function executeSave(request: PendingSynopsisSave): Promise<void> {
  try {
    return Promise.resolve(request.persist(request.value));
  } catch (error) {
    return Promise.reject(error);
  }
}

function startSlot(slot: SynopsisSaveSlot): Promise<void> {
  if (slot.running) return slot.running;

  const request = slot.pending;
  if (!request) return Promise.resolve();

  slot.pending = null;
  if (slot.timer) {
    clearTimeout(slot.timer);
    slot.timer = null;
  }
  slot.runningRequest = request;

  const execution = executeSave(request);
  const tracked = execution
    .then(() => {
      // A change that repeats the value already committed while this request
      // was in flight needs no second write.
      if (slot.pending?.value === request.value) {
        slot.pending = null;
        if (slot.timer) {
          clearTimeout(slot.timer);
          slot.timer = null;
        }
      }
      slot.failed = null;
    })
    .catch((error: unknown): never => {
      // A superseding edit is the value strict quiescence must protect. An
      // older failed attempt must neither veto nor overwrite that latest edit.
      if (!request.cancelled && slot.pending === null) {
        slot.failed = { request, error };
        reportFailure(request, error);
      }
      throw error;
    })
    .finally(() => {
      if (slot.running === tracked) slot.running = null;
      if (slot.runningRequest === request) slot.runningRequest = null;

      // If the latest value reached its deadline while a predecessor was
      // running, continue the per-node chain immediately.
      if (slot.pending && slot.timer === null) {
        void startSlot(slot).catch(() => {});
      } else {
        cleanupSlotIfIdle(slot);
      }
    });
  slot.running = tracked;
  return tracked;
}

export function schedulePendingSynopsisSave(options: {
  key: string;
  owner: PendingSynopsisSaveOwner;
  value: string;
  persist: (value: string) => Promise<void>;
  onError?: (error: unknown) => void;
  delayMs?: number;
}): void {
  const slot = getSlot(options.key);
  if (slot.timer) clearTimeout(slot.timer);

  // A new authoritative value supersedes any retained failure.
  slot.failed = null;
  slot.pending = {
    owner: options.owner,
    value: options.value,
    persist: options.persist,
    onError: options.onError,
    cancelled: false,
  };
  slot.timer = setTimeout(() => {
    slot.timer = null;
    void startSlot(slot).catch(() => {});
  }, options.delayMs ?? DEFAULT_SAVE_DELAY_MS);
}

/**
 * Cancel only the edit owned by one mounted editor. A newer edit for the same
 * node may already belong to another virtualized surface and must survive.
 */
export function cancelPendingSynopsisSave(
  key: string,
  owner: PendingSynopsisSaveOwner,
): void {
  const slot = slotsByKey.get(key);
  if (!slot) return;

  if (slot.pending?.owner === owner) {
    slot.pending.cancelled = true;
    slot.pending = null;
    if (slot.timer) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
  }
  if (slot.failed?.request.owner === owner) {
    slot.failed.request.cancelled = true;
    slot.failed = null;
  }
  if (slot.runningRequest?.owner === owner) {
    slot.runningRequest.cancelled = true;
  }
  cleanupSlotIfIdle(slot);
}

function retryRetainedFailure(slot: SynopsisSaveSlot): void {
  if (slot.pending || slot.running || !slot.failed) return;
  slot.pending = slot.failed.request;
  slot.failed = null;
}

async function drainSynopsisSaveSlots(key?: string): Promise<void> {
  const initialSlots =
    key === undefined
      ? [...slotsByKey.values()]
      : [slotsByKey.get(key)].filter(
          (slot): slot is SynopsisSaveSlot => slot !== undefined,
        );
  for (const slot of initialSlots) retryRetainedFailure(slot);

  for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
    const slots =
      key === undefined
        ? [...slotsByKey.values()]
        : [slotsByKey.get(key)].filter(
            (slot): slot is SynopsisSaveSlot => slot !== undefined,
          );
    if (slots.length === 0) return;

    for (const slot of slots) {
      if (slot.timer) {
        clearTimeout(slot.timer);
        slot.timer = null;
      }
    }

    const running = [...new Set(slots.map(startSlot))];
    await Promise.allSettled(running);

    const currentSlots =
      key === undefined
        ? [...slotsByKey.values()]
        : [slotsByKey.get(key)].filter(
            (slot): slot is SynopsisSaveSlot => slot !== undefined,
          );
    if (
      currentSlots.some(
        (slot) => slot.pending !== null || slot.running !== null,
      )
    ) {
      continue;
    }

    const failures = currentSlots.flatMap((slot) =>
      slot.failed ? [slot.failed.error] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        failures.length === 1 && failures[0] instanceof Error
          ? failures[0].message
          : "One or more synopsis saves failed",
      );
    }
    return;
  }

  throw new Error(
    `Synopsis saves did not reach quiescence after ${MAX_DRAIN_ROUNDS} rounds`,
  );
}

export function flushPendingSynopsisSave(key: string): Promise<void> {
  return drainSynopsisSaveSlots(key);
}

export function flushPendingSynopsisSaves(): Promise<void> {
  return drainSynopsisSaveSlots();
}

function discardPendingSynopsisSaves(): void {
  for (const slot of slotsByKey.values()) {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    if (slot.pending) slot.pending.cancelled = true;
    if (slot.failed) slot.failed.request.cancelled = true;
    if (slot.runningRequest) slot.runningRequest.cancelled = true;
    slot.pending = null;
    slot.failed = null;
    cleanupSlotIfIdle(slot);
  }
}

registerQuiescenceProvider({
  id: "inline-synopsis-saves",
  stage: "scoped-mutations",
  flush: flushPendingSynopsisSaves,
  discard: discardPendingSynopsisSaves,
  recovery: () =>
    [...slotsByKey.values()].flatMap((slot) => {
      const request = slot.pending ?? slot.failed?.request;
      if (!request || request.cancelled) return [];
      return [
        {
          kind: "inline-synopsis",
          documentKey: slot.key,
          value: request.value,
        },
      ];
    }),
});

export function _resetPendingSynopsisSavesForTests(): void {
  for (const slot of slotsByKey.values()) {
    if (slot.timer) clearTimeout(slot.timer);
    if (slot.pending) slot.pending.cancelled = true;
    if (slot.failed) slot.failed.request.cancelled = true;
    if (slot.runningRequest) slot.runningRequest.cancelled = true;
  }
  slotsByKey.clear();
}
