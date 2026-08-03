export const ORDERED_STREAM_AUDIT_MAX_BATCH_ITEMS = 64;
export const ORDERED_STREAM_AUDIT_MAX_FLUSH_INTERVAL_MS = 25;
export const ORDERED_STREAM_AUDIT_DEFAULT_MAX_PENDING_ITEMS = 4_096;
export const ORDERED_STREAM_AUDIT_DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;

const textEncoder = new TextEncoder();

export class AiAuditStreamBacklogExceededError extends Error {
  readonly code = "AI_AUDIT_STREAM_BACKLOG_EXCEEDED" as const;

  constructor(
    readonly attemptedPendingItemCount: number,
    readonly attemptedPendingByteCount: number,
    readonly maxPendingItems: number,
    readonly maxPendingBytes: number,
  ) {
    super(
      `AI audit stream backlog exceeded: ${attemptedPendingItemCount}/${maxPendingItems} items, ${attemptedPendingByteCount}/${maxPendingBytes} bytes`,
    );
    this.name = "AiAuditStreamBacklogExceededError";
  }
}

export interface OrderedStreamAuditBatchQueueOptions<Item> {
  /** One durable append for one ordered microbatch. */
  readonly persistBatch: (items: readonly Item[]) => Promise<void>;
  /** Called exactly once when persistence or backlog safety fails closed. */
  readonly onPersistenceFailure: (error: unknown) => void;
  /** Defaults to the UTF-8 byte length of the JSON representation. */
  readonly measureItem?: (item: Item) => number;
  /** Must be in [1, 64]. Defaults to 64. */
  readonly maxBatchItems?: number;
  /** Must be in [1, 25]ms. Defaults to 25ms. */
  readonly flushIntervalMs?: number;
  /** Counts both queued and in-flight, not-yet-confirmed items. */
  readonly maxPendingItems?: number;
  /** Counts both queued and in-flight, not-yet-confirmed bytes. */
  readonly maxPendingBytes?: number;
}

export interface OrderedStreamAuditBatchQueue<Item> {
  enqueue(item: Item, afterPersisted?: () => void): boolean;
  /** Flushes all observed items, then persists the terminal as a barrier. */
  close(
    persistTerminal: () => Promise<void>,
    afterPersisted?: () => void,
  ): boolean;
  /** Force the currently queued partial batch and wait for scheduled writes. */
  flush(): Promise<void>;
  /** Wait only for writes already scheduled by time/count/close. */
  whenIdle(): Promise<void>;
  readonly closed: boolean;
  readonly failed: boolean;
  /** Queued plus in-flight items awaiting durable confirmation. */
  readonly pendingItemCount: number;
  /** Queued plus in-flight bytes awaiting durable confirmation. */
  readonly pendingByteCount: number;
}

interface PendingBatchItem<Item> {
  readonly item: Item;
  readonly measuredBytes: number;
  readonly afterPersisted?: () => void;
}

function positiveIntegerAtMost(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(
      `${label} must be an integer between 1 and ${maximum}`,
    );
  }
  return resolved;
}

function positiveSafeInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return resolved;
}

function defaultMeasureItem(item: unknown): number {
  const serialized = JSON.stringify(item);
  return textEncoder.encode(serialized === undefined ? "null" : serialized)
    .byteLength;
}

/**
 * Generic fail-closed durable microbatch queue for model stream observations.
 * A received item is exposed to the application only after the batch that
 * contains it is durably appended. Batches and callbacks remain strictly
 * ordered, and close places the terminal after every observed partial.
 */
export function createOrderedStreamAuditBatchQueue<Item>(
  options: OrderedStreamAuditBatchQueueOptions<Item>,
): OrderedStreamAuditBatchQueue<Item> {
  const maxBatchItems = positiveIntegerAtMost(
    options.maxBatchItems,
    ORDERED_STREAM_AUDIT_MAX_BATCH_ITEMS,
    ORDERED_STREAM_AUDIT_MAX_BATCH_ITEMS,
    "maxBatchItems",
  );
  const flushIntervalMs = positiveIntegerAtMost(
    options.flushIntervalMs,
    ORDERED_STREAM_AUDIT_MAX_FLUSH_INTERVAL_MS,
    ORDERED_STREAM_AUDIT_MAX_FLUSH_INTERVAL_MS,
    "flushIntervalMs",
  );
  const maxPendingItems = positiveSafeInteger(
    options.maxPendingItems,
    ORDERED_STREAM_AUDIT_DEFAULT_MAX_PENDING_ITEMS,
    "maxPendingItems",
  );
  const maxPendingBytes = positiveSafeInteger(
    options.maxPendingBytes,
    ORDERED_STREAM_AUDIT_DEFAULT_MAX_PENDING_BYTES,
    "maxPendingBytes",
  );
  const measureItem = options.measureItem ?? defaultMeasureItem;

  let tail = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queued: PendingBatchItem<Item>[] = [];
  let closed = false;
  let failed = false;
  let failureDelivered = false;
  let pendingItemCount = 0;
  let pendingByteCount = 0;

  const clearFlushTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const deliverFailure = (error: unknown): void => {
    if (failureDelivered) return;
    failureDelivered = true;
    failed = true;
    closed = true;
    clearFlushTimer();
    queued = [];
    pendingItemCount = 0;
    pendingByteCount = 0;
    try {
      options.onPersistenceFailure(error);
    } catch (callbackError) {
      console.error(
        "AI stream persistence failure callback failed",
        callbackError,
      );
    }
  };

  const runAfterPersisted = (callback: (() => void) | undefined): void => {
    try {
      callback?.();
    } catch (error) {
      // Application callback failures cannot retroactively invalidate the
      // already durable audit batch or prevent the terminal barrier.
      console.error("AI stream callback failed after durable audit", error);
    }
  };

  const scheduleBatch = (batch: readonly PendingBatchItem<Item>[]): void => {
    tail = tail.then(async () => {
      if (failed) return;
      try {
        await options.persistBatch(batch.map((entry) => entry.item));
      } catch (error) {
        deliverFailure(error);
        return;
      }
      if (failed) return;
      pendingItemCount -= batch.length;
      pendingByteCount -= batch.reduce(
        (total, entry) => total + entry.measuredBytes,
        0,
      );
      for (const entry of batch) {
        runAfterPersisted(entry.afterPersisted);
      }
    });
  };

  const flushQueued = (): void => {
    clearFlushTimer();
    while (queued.length > 0) {
      const batch = queued.splice(0, maxBatchItems);
      scheduleBatch(batch);
    }
  };

  const armTimer = (): void => {
    if (timer !== null || queued.length === 0 || closed || failed) return;
    timer = setTimeout(() => {
      timer = null;
      flushQueued();
    }, flushIntervalMs);
  };

  return {
    enqueue(item, afterPersisted) {
      if (closed || failed) return false;
      let measuredBytes: number;
      try {
        const measured = measureItem(item);
        if (!Number.isFinite(measured) || measured < 0) {
          throw new RangeError(
            "measureItem must return a finite non-negative byte count",
          );
        }
        measuredBytes = Math.ceil(measured);
      } catch (error) {
        deliverFailure(error);
        return false;
      }
      const attemptedItemCount = pendingItemCount + 1;
      const attemptedByteCount = pendingByteCount + measuredBytes;
      if (
        attemptedItemCount > maxPendingItems ||
        attemptedByteCount > maxPendingBytes
      ) {
        deliverFailure(
          new AiAuditStreamBacklogExceededError(
            attemptedItemCount,
            attemptedByteCount,
            maxPendingItems,
            maxPendingBytes,
          ),
        );
        return false;
      }
      pendingItemCount = attemptedItemCount;
      pendingByteCount = attemptedByteCount;
      queued.push({ item, measuredBytes, afterPersisted });
      if (queued.length >= maxBatchItems) {
        flushQueued();
      } else {
        armTimer();
      }
      return true;
    },
    close(persistTerminal, afterPersisted) {
      if (closed || failed) return false;
      closed = true;
      flushQueued();
      tail = tail.then(async () => {
        if (failed) return;
        try {
          await persistTerminal();
        } catch (error) {
          deliverFailure(error);
          return;
        }
        if (!failed) runAfterPersisted(afterPersisted);
      });
      return true;
    },
    flush() {
      if (!failed) flushQueued();
      return tail;
    },
    whenIdle() {
      return tail;
    },
    get closed() {
      return closed;
    },
    get failed() {
      return failed;
    },
    get pendingItemCount() {
      return pendingItemCount;
    },
    get pendingByteCount() {
      return pendingByteCount;
    },
  };
}

/**
 * Compatibility queue for callers that still provide one persistence closure
 * per item. New stream integrations should use
 * createOrderedStreamAuditBatchQueue with recordAiAuditPartials.
 */
export interface OrderedStreamAuditQueue {
  enqueue(persist: () => Promise<void>, afterPersisted?: () => void): boolean;
  close(
    persistTerminal: () => Promise<void>,
    afterPersisted?: () => void,
  ): boolean;
  readonly closed: boolean;
  readonly failed: boolean;
}

export function createOrderedStreamAuditQueue(
  onPersistenceFailure: (error: unknown) => void,
): OrderedStreamAuditQueue {
  let tail = Promise.resolve();
  let closed = false;
  let failed = false;

  const schedule = (
    persist: () => Promise<void>,
    afterPersisted: (() => void) | undefined,
  ): void => {
    tail = tail.then(async () => {
      if (failed) return;
      try {
        await persist();
      } catch (error) {
        failed = true;
        onPersistenceFailure(error);
        return;
      }
      try {
        afterPersisted?.();
      } catch (error) {
        // Consumer callback failures are not audit persistence failures and
        // must not prevent the already queued terminal audit append.
        console.error("AI stream callback failed after durable audit", error);
      }
    });
  };

  return {
    enqueue(persist, afterPersisted) {
      if (closed || failed) return false;
      schedule(persist, afterPersisted);
      return true;
    },
    close(persistTerminal, afterPersisted) {
      if (closed || failed) return false;
      closed = true;
      schedule(persistTerminal, afterPersisted);
      return true;
    },
    get closed() {
      return closed;
    },
    get failed() {
      return failed;
    },
  };
}
