import type {
  AiAuditCaptureState,
  AiAuditEventType,
  AiAuditStoredEvent,
} from "./types";

export const AI_AUDIT_TERMINAL_EVENT_TYPES = [
  "execution.succeeded",
  "execution.failed",
  "execution.cancelled",
  "execution.skipped",
  "execution.cache_hit",
] as const satisfies readonly AiAuditEventType[];

export type AiAuditTerminalEventType =
  (typeof AI_AUDIT_TERMINAL_EVENT_TYPES)[number];

export interface AiAuditCoverageReport {
  readonly eventCount: number;
  readonly executionCount: number;
  readonly startedExecutionCount: number;
  readonly terminalExecutions: Readonly<
    Record<AiAuditTerminalEventType, number>
  >;
  readonly ambiguousExecutionCount: number;
  readonly multipleTerminalExecutionCount: number;
  /** Ledger events whose sequence is greater than an execution's first terminal. */
  readonly postTerminalEventCount: number;
  /** Executions with at least one event after their first terminal. */
  readonly postTerminalExecutionCount: number;
  /** Post-terminal transport.attempt.started/finished events. */
  readonly postTerminalTransportAttemptCount: number;
  readonly eventsWithoutStartExecutionCount: number;
  readonly captureStates: Readonly<Record<AiAuditCaptureState, number>>;
  readonly affectedExecutions: Readonly<
    Record<
      | "redacted"
      | "partial"
      | "truncated"
      | "legacy_missing"
      | "unobservable_provider",
      number
    >
  >;
  readonly requestPreparedCount: number;
  readonly requestPreparedExecutionCount: number;
  readonly applicationDispatchEventCount: number;
  readonly applicationDispatchExecutionCount: number;
  readonly applicationDispatchMissingRequestPreparedExecutionCount: number;
  readonly noApplicationDispatchTerminalExecutions: Readonly<{
    skipped: number;
    cacheHit: number;
  }>;
  /**
   * Transport attempt events are emitted by the instrumented native HTTP 429
   * retry helper. They are not proof of every HTTP send made by every provider.
   */
  readonly transportAttemptStartedCount: number;
  readonly transportAttemptFinishedCount: number;
  readonly transportAttemptStartedWithoutFinishCount: number;
  readonly transportAttemptFinishedWithoutStartCount: number;
  /** Durable pre-send retry starts: started events with attemptNumber > 1. */
  readonly transportDerivedRetryCount: number;
  readonly executionRetryingEventCount: number;
  readonly transportHttp429FinishedCount: number;
  readonly transportWillRetryFinishedCount: number;
  readonly transportRetryExhaustedFinishedCount: number;
  /** request.prepared events that did not declare credentialsExcluded=true. */
  readonly requestPreparedCredentialExclusionViolationCount: number;
  readonly unknownAppVersionEventCount: number;
  readonly earliestRecordedAt: number | null;
  readonly latestRecordedAt: number | null;
  readonly priorHistoryStatus: "unknown_not_backfilled" | "no_recorded_events";
  readonly pathEventCounts: Readonly<Record<string, number>>;
  readonly versions: {
    readonly auditSchemaVersions: readonly string[];
    readonly captureContractVersions: readonly string[];
    readonly recorders: readonly string[];
    readonly appVersions: readonly string[];
  };
}

const CAPTURE_STATES: readonly AiAuditCaptureState[] = [
  "complete",
  "partial",
  "redacted",
  "truncated",
  "legacy_missing",
  "unobservable_provider",
];

interface ExecutionState {
  started: boolean;
  terminals: AiAuditTerminalEventType[];
  events: Array<{
    sequence: number;
    eventType: AiAuditEventType;
  }>;
  affected: Set<AiAuditCaptureState>;
  requestPreparedCount: number;
  requestDispatchedCount: number;
}

function emptyCaptureCounts(): Record<AiAuditCaptureState, number> {
  return {
    complete: 0,
    partial: 0,
    redacted: 0,
    truncated: 0,
    legacy_missing: 0,
    unobservable_provider: 0,
  };
}

function emptyTerminalCounts(): Record<AiAuditTerminalEventType, number> {
  return {
    "execution.succeeded": 0,
    "execution.failed": 0,
    "execution.cancelled": 0,
    "execution.skipped": 0,
    "execution.cache_hit": 0,
  };
}

export function compareUnicodeCodePoints(left: string, right: string): number {
  const leftCodePoints = [...left];
  const rightCodePoints = [...right];
  const length = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftCodePoints[index].codePointAt(0) ?? 0;
    const rightValue = rightCodePoints[index].codePointAt(0) ?? 0;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return leftCodePoints.length - rightCodePoints.length;
}

function sorted(values: Set<string>): string[] {
  return [...values].sort(compareUnicodeCodePoints);
}

export class AiAuditCoverageAccumulator {
  private eventCount = 0;
  private requestPreparedCount = 0;
  private applicationDispatchEventCount = 0;
  private transportAttemptStartedCount = 0;
  private transportAttemptFinishedCount = 0;
  private transportDerivedRetryCount = 0;
  private executionRetryingEventCount = 0;
  private transportHttp429FinishedCount = 0;
  private transportWillRetryFinishedCount = 0;
  private transportRetryExhaustedFinishedCount = 0;
  private requestPreparedCredentialExclusionViolationCount = 0;
  private unknownAppVersionEventCount = 0;
  private earliestRecordedAt: number | null = null;
  private latestRecordedAt: number | null = null;
  private readonly captureStates = emptyCaptureCounts();
  private readonly pathEventCounts = new Map<string, number>();
  private readonly executions = new Map<string, ExecutionState>();
  private readonly transportAttemptStarts = new Map<string, number>();
  private readonly transportAttemptFinishes = new Map<string, number>();
  private readonly auditSchemaVersions = new Set<string>();
  private readonly captureContractVersions = new Set<string>();
  private readonly recorders = new Set<string>();
  private readonly appVersions = new Set<string>();

  private transportAttemptKey(
    event: AiAuditStoredEvent,
    phase: "started" | "finished",
  ): string {
    const attemptNumber = event.payload.attemptNumber;
    if (
      typeof attemptNumber === "number" &&
      Number.isSafeInteger(attemptNumber) &&
      attemptNumber > 0
    ) {
      return `${event.executionId}\u0000${attemptNumber}`;
    }
    // Invalid/missing identifiers cannot truthfully be paired. Keeping each as
    // its own key makes the coverage report expose the mismatch.
    return `invalid\u0000${phase}\u0000${event.eventId}`;
  }

  private incrementAttempt(
    target: Map<string, number>,
    event: AiAuditStoredEvent,
    phase: "started" | "finished",
  ): void {
    const key = this.transportAttemptKey(event, phase);
    target.set(key, (target.get(key) ?? 0) + 1);
  }

  add(event: AiAuditStoredEvent): void {
    this.eventCount += 1;
    this.earliestRecordedAt =
      this.earliestRecordedAt === null
        ? event.recordedAt
        : Math.min(this.earliestRecordedAt, event.recordedAt);
    this.latestRecordedAt =
      this.latestRecordedAt === null
        ? event.recordedAt
        : Math.max(this.latestRecordedAt, event.recordedAt);
    this.pathEventCounts.set(
      event.pathId,
      (this.pathEventCounts.get(event.pathId) ?? 0) + 1,
    );

    const execution = this.executions.get(event.executionId) ?? {
      started: false,
      terminals: [],
      events: [],
      affected: new Set<AiAuditCaptureState>(),
      requestPreparedCount: 0,
      requestDispatchedCount: 0,
    };
    execution.events.push({
      sequence: event.sequence,
      eventType: event.eventType,
    });
    if (event.eventType === "execution.started") execution.started = true;
    if (
      AI_AUDIT_TERMINAL_EVENT_TYPES.includes(
        event.eventType as AiAuditTerminalEventType,
      )
    ) {
      execution.terminals.push(event.eventType as AiAuditTerminalEventType);
    }
    const captureState = event.payload.captureState;
    if (
      typeof captureState === "string" &&
      CAPTURE_STATES.includes(captureState as AiAuditCaptureState)
    ) {
      const state = captureState as AiAuditCaptureState;
      this.captureStates[state] += 1;
      if (state !== "complete") execution.affected.add(state);
    }
    this.executions.set(event.executionId, execution);

    if (event.eventType === "request.prepared") {
      this.requestPreparedCount += 1;
      execution.requestPreparedCount += 1;
      if (event.payload.credentialsExcluded !== true) {
        this.requestPreparedCredentialExclusionViolationCount += 1;
      }
    }
    if (event.eventType === "request.dispatched") {
      // This event means the application invoked its selected transport. It is
      // not an HTTP send, attempt, or provider receipt and must not be reported
      // as one.
      this.applicationDispatchEventCount += 1;
      execution.requestDispatchedCount += 1;
    }
    if (event.eventType === "transport.attempt.started") {
      this.transportAttemptStartedCount += 1;
      this.incrementAttempt(this.transportAttemptStarts, event, "started");
      const attemptNumber = event.payload.attemptNumber;
      if (
        typeof attemptNumber === "number" &&
        Number.isSafeInteger(attemptNumber) &&
        attemptNumber > 1
      ) {
        this.transportDerivedRetryCount += 1;
      }
    }
    if (event.eventType === "transport.attempt.finished") {
      this.transportAttemptFinishedCount += 1;
      this.incrementAttempt(this.transportAttemptFinishes, event, "finished");
      if (event.payload.status === 429) {
        this.transportHttp429FinishedCount += 1;
      }
      if (event.payload.willRetry === true) {
        this.transportWillRetryFinishedCount += 1;
      }
      if (event.payload.retryExhausted === true) {
        this.transportRetryExhaustedFinishedCount += 1;
      }
    }
    if (event.eventType === "execution.retrying") {
      this.executionRetryingEventCount += 1;
    }
    for (const [key, target] of [
      ["auditSchemaVersion", this.auditSchemaVersions],
      ["captureContractVersion", this.captureContractVersions],
      ["recorder", this.recorders],
      ["appVersion", this.appVersions],
    ] as const) {
      const value = event.payload[key];
      if (typeof value === "string" || typeof value === "number") {
        target.add(String(value));
      }
    }
    const appVersion = event.payload.appVersion;
    if (
      typeof appVersion !== "string" ||
      !appVersion.trim() ||
      appVersion === "unknown"
    ) {
      this.unknownAppVersionEventCount += 1;
    }
  }

  finish(): AiAuditCoverageReport {
    const terminalExecutions = emptyTerminalCounts();
    const affectedExecutions = {
      redacted: 0,
      partial: 0,
      truncated: 0,
      legacy_missing: 0,
      unobservable_provider: 0,
    };
    let startedExecutionCount = 0;
    let ambiguousExecutionCount = 0;
    let multipleTerminalExecutionCount = 0;
    let postTerminalEventCount = 0;
    let postTerminalExecutionCount = 0;
    let postTerminalTransportAttemptCount = 0;
    let eventsWithoutStartExecutionCount = 0;
    let requestPreparedExecutionCount = 0;
    let applicationDispatchMissingRequestPreparedExecutionCount = 0;
    let applicationDispatchExecutionCount = 0;
    const noApplicationDispatchTerminalExecutions = {
      skipped: 0,
      cacheHit: 0,
    };
    for (const execution of this.executions.values()) {
      const eventsBySequence = [...execution.events].sort(
        (left, right) => left.sequence - right.sequence,
      );
      const firstTerminalIndex = eventsBySequence.findIndex((event) =>
        AI_AUDIT_TERMINAL_EVENT_TYPES.includes(
          event.eventType as AiAuditTerminalEventType,
        ),
      );
      if (firstTerminalIndex >= 0) {
        const postTerminalEvents = eventsBySequence.slice(
          firstTerminalIndex + 1,
        );
        if (postTerminalEvents.length > 0) {
          postTerminalExecutionCount += 1;
          postTerminalEventCount += postTerminalEvents.length;
          postTerminalTransportAttemptCount += postTerminalEvents.filter(
            (event) =>
              event.eventType === "transport.attempt.started" ||
              event.eventType === "transport.attempt.finished",
          ).length;
        }
      }
      if (execution.started) startedExecutionCount += 1;
      else eventsWithoutStartExecutionCount += 1;
      if (execution.started && execution.terminals.length === 0) {
        ambiguousExecutionCount += 1;
      }
      if (execution.terminals.length > 1) {
        multipleTerminalExecutionCount += 1;
      }
      if (execution.requestPreparedCount > 0) {
        requestPreparedExecutionCount += 1;
      }
      if (execution.requestDispatchedCount > 0) {
        applicationDispatchExecutionCount += 1;
        if (execution.requestPreparedCount === 0) {
          applicationDispatchMissingRequestPreparedExecutionCount += 1;
        }
      } else {
        const terminals = new Set(execution.terminals);
        if (terminals.has("execution.skipped")) {
          noApplicationDispatchTerminalExecutions.skipped += 1;
        }
        if (terminals.has("execution.cache_hit")) {
          noApplicationDispatchTerminalExecutions.cacheHit += 1;
        }
      }
      for (const terminal of new Set(execution.terminals)) {
        terminalExecutions[terminal] += 1;
      }
      for (const state of execution.affected) {
        if (state !== "complete") affectedExecutions[state] += 1;
      }
    }

    const attemptKeys = new Set([
      ...this.transportAttemptStarts.keys(),
      ...this.transportAttemptFinishes.keys(),
    ]);
    let transportAttemptStartedWithoutFinishCount = 0;
    let transportAttemptFinishedWithoutStartCount = 0;
    for (const key of attemptKeys) {
      const starts = this.transportAttemptStarts.get(key) ?? 0;
      const finishes = this.transportAttemptFinishes.get(key) ?? 0;
      transportAttemptStartedWithoutFinishCount += Math.max(
        0,
        starts - finishes,
      );
      transportAttemptFinishedWithoutStartCount += Math.max(
        0,
        finishes - starts,
      );
    }

    return {
      eventCount: this.eventCount,
      executionCount: this.executions.size,
      startedExecutionCount,
      terminalExecutions,
      ambiguousExecutionCount,
      multipleTerminalExecutionCount,
      postTerminalEventCount,
      postTerminalExecutionCount,
      postTerminalTransportAttemptCount,
      eventsWithoutStartExecutionCount,
      captureStates: { ...this.captureStates },
      affectedExecutions,
      requestPreparedCount: this.requestPreparedCount,
      requestPreparedExecutionCount,
      applicationDispatchEventCount: this.applicationDispatchEventCount,
      applicationDispatchExecutionCount,
      applicationDispatchMissingRequestPreparedExecutionCount,
      noApplicationDispatchTerminalExecutions,
      transportAttemptStartedCount: this.transportAttemptStartedCount,
      transportAttemptFinishedCount: this.transportAttemptFinishedCount,
      transportAttemptStartedWithoutFinishCount,
      transportAttemptFinishedWithoutStartCount,
      transportDerivedRetryCount: this.transportDerivedRetryCount,
      executionRetryingEventCount: this.executionRetryingEventCount,
      transportHttp429FinishedCount: this.transportHttp429FinishedCount,
      transportWillRetryFinishedCount: this.transportWillRetryFinishedCount,
      transportRetryExhaustedFinishedCount:
        this.transportRetryExhaustedFinishedCount,
      requestPreparedCredentialExclusionViolationCount:
        this.requestPreparedCredentialExclusionViolationCount,
      unknownAppVersionEventCount: this.unknownAppVersionEventCount,
      earliestRecordedAt: this.earliestRecordedAt,
      latestRecordedAt: this.latestRecordedAt,
      priorHistoryStatus:
        this.eventCount === 0 ? "no_recorded_events" : "unknown_not_backfilled",
      pathEventCounts: Object.fromEntries(
        [...this.pathEventCounts.entries()].sort(([left], [right]) =>
          compareUnicodeCodePoints(left, right),
        ),
      ),
      versions: {
        auditSchemaVersions: sorted(this.auditSchemaVersions),
        captureContractVersions: sorted(this.captureContractVersions),
        recorders: sorted(this.recorders),
        appVersions: sorted(this.appVersions),
      },
    };
  }
}

export function calculateAiAuditCoverage(
  events: Iterable<AiAuditStoredEvent>,
): AiAuditCoverageReport {
  const accumulator = new AiAuditCoverageAccumulator();
  for (const event of events) accumulator.add(event);
  return accumulator.finish();
}
