import { describe, expect, it } from "vitest";

import type { AiAuditStoredEvent } from "./types";
import { calculateAiAuditCoverage } from "./reportCoverage";

function stored(
  sequence: number,
  executionId: string,
  eventType: AiAuditStoredEvent["eventType"],
  captureState: string = "complete",
  payloadOverrides: AiAuditStoredEvent["payload"] = {},
): AiAuditStoredEvent {
  return {
    sequence,
    eventId: `event-${sequence}`,
    scopeId: "project:project-1",
    projectId: "project-1",
    executionId,
    operationId: executionId,
    parentExecutionId: null,
    pathId: sequence % 2 === 0 ? "review" : "synopsis",
    eventType,
    timestamp: sequence,
    recordedAt: 1_700_000_000_000 + sequence,
    payload: {
      captureState,
      ...(eventType === "request.prepared"
        ? { credentialsExcluded: true }
        : {}),
      auditSchemaVersion: 1,
      captureContractVersion: 1,
      recorder: "grimodex-ai-audit",
      appVersion: "2.0.10",
      ...payloadOverrides,
    },
    payloadSha256: "a".repeat(64),
    prevHash: "b".repeat(64),
    hash: "c".repeat(64),
  };
}

describe("AI audit report coverage", () => {
  it("treats succeeded/failed/cancelled/skipped/cache_hit as single terminals and start-only as ambiguous", () => {
    const report = calculateAiAuditCoverage([
      stored(1, "success", "execution.started"),
      stored(2, "success", "request.prepared"),
      stored(3, "success", "request.dispatched"),
      stored(4, "success", "execution.succeeded"),
      stored(5, "failed", "execution.started"),
      stored(6, "failed", "execution.failed", "redacted"),
      stored(7, "cancelled", "execution.started"),
      stored(8, "cancelled", "execution.cancelled", "partial"),
      stored(9, "skipped", "execution.started"),
      stored(10, "skipped", "execution.skipped"),
      stored(11, "cached", "execution.started"),
      stored(12, "cached", "execution.cache_hit"),
      stored(13, "ambiguous", "execution.started", "truncated"),
      stored(14, "orphan", "response.completed", "unobservable_provider"),
      stored(15, "missing", "execution.started"),
      stored(16, "missing", "request.dispatched"),
      stored(17, "missing", "execution.succeeded"),
    ]);

    expect(report.executionCount).toBe(8);
    expect(report.startedExecutionCount).toBe(7);
    expect(report.ambiguousExecutionCount).toBe(1);
    expect(report.eventsWithoutStartExecutionCount).toBe(1);
    expect(report.multipleTerminalExecutionCount).toBe(0);
    expect(report.terminalExecutions).toEqual({
      "execution.succeeded": 2,
      "execution.failed": 1,
      "execution.cancelled": 1,
      "execution.skipped": 1,
      "execution.cache_hit": 1,
    });
    expect(report.affectedExecutions).toMatchObject({
      redacted: 1,
      partial: 1,
      truncated: 1,
      unobservable_provider: 1,
    });
    expect(report.priorHistoryStatus).toBe("unknown_not_backfilled");
    expect(report.requestPreparedCredentialExclusionViolationCount).toBe(0);
    expect(report.requestPreparedExecutionCount).toBe(1);
    expect(report.applicationDispatchMissingRequestPreparedExecutionCount).toBe(
      1,
    );
    expect(report.applicationDispatchEventCount).toBe(2);
    expect(report.applicationDispatchExecutionCount).toBe(2);
    expect(report.noApplicationDispatchTerminalExecutions).toEqual({
      skipped: 1,
      cacheHit: 1,
    });
    expect(report.versions).toEqual({
      auditSchemaVersions: ["1"],
      captureContractVersions: ["1"],
      recorders: ["grimodex-ai-audit"],
      appVersions: ["2.0.10"],
    });
  });

  it("does not invent legacy coverage when no event exists", () => {
    const report = calculateAiAuditCoverage([]);
    expect(report.eventCount).toBe(0);
    expect(report.earliestRecordedAt).toBeNull();
    expect(report.priorHistoryStatus).toBe("no_recorded_events");
  });

  it("separates application dispatch from helper-observed HTTP attempts and retries", () => {
    const report = calculateAiAuditCoverage([
      stored(1, "retried", "execution.started"),
      stored(2, "retried", "request.prepared"),
      stored(3, "retried", "request.dispatched"),
      stored(4, "retried", "transport.attempt.started", "complete", {
        attemptNumber: 1,
        sendOrdinal: 1,
        sendPhase: "pre-send",
        isRetry: false,
      }),
      stored(5, "retried", "transport.attempt.finished", "complete", {
        attemptNumber: 1,
        actualHttpSendCount: 1,
        sendPhase: "send-invoked",
        status: 429,
        willRetry: true,
        retryExhausted: false,
      }),
      stored(6, "retried", "execution.retrying"),
      stored(7, "retried", "transport.attempt.started", "complete", {
        attemptNumber: 2,
        sendOrdinal: 2,
        sendPhase: "pre-send",
        isRetry: true,
      }),
      stored(8, "retried", "transport.attempt.finished", "complete", {
        attemptNumber: 2,
        actualHttpSendCount: 2,
        sendPhase: "send-invoked",
        status: 200,
        willRetry: false,
        retryExhausted: false,
      }),
      stored(9, "retried", "execution.succeeded"),
      stored(10, "exhausted", "execution.started"),
      stored(11, "exhausted", "request.prepared"),
      stored(12, "exhausted", "request.dispatched"),
      stored(13, "exhausted", "transport.attempt.started", "complete", {
        attemptNumber: 1,
        sendOrdinal: 1,
        sendPhase: "pre-send",
        isRetry: false,
      }),
      stored(14, "exhausted", "transport.attempt.finished", "complete", {
        attemptNumber: 1,
        actualHttpSendCount: 1,
        sendPhase: "send-invoked",
        status: 429,
        willRetry: false,
        retryExhausted: true,
      }),
      stored(15, "exhausted", "execution.failed"),
      stored(16, "unmatched-start", "execution.started"),
      stored(17, "unmatched-start", "transport.attempt.started", "complete", {
        attemptNumber: 3,
        sendOrdinal: 3,
        sendPhase: "pre-send",
        isRetry: true,
      }),
      stored(18, "unmatched-finish", "execution.started"),
      stored(19, "unmatched-finish", "transport.attempt.finished", "complete", {
        attemptNumber: 4,
        actualHttpSendCount: 4,
        sendPhase: "send-invoked",
        status: null,
        willRetry: false,
        retryExhausted: false,
      }),
    ]);

    expect(report.applicationDispatchEventCount).toBe(2);
    expect(report.applicationDispatchExecutionCount).toBe(2);
    expect(report.transportAttemptStartedCount).toBe(4);
    expect(report.transportAttemptFinishedCount).toBe(4);
    expect(report.transportAttemptStartedWithoutFinishCount).toBe(1);
    expect(report.transportAttemptFinishedWithoutStartCount).toBe(1);
    expect(report.transportDerivedRetryCount).toBe(2);
    expect(report.executionRetryingEventCount).toBe(1);
    expect(report.transportHttp429FinishedCount).toBe(2);
    expect(report.transportWillRetryFinishedCount).toBe(1);
    expect(report.transportRetryExhaustedFinishedCount).toBe(1);
  });

  it("labels credential declaration violations as request.prepared-only coverage", () => {
    const report = calculateAiAuditCoverage([
      stored(1, "bad-declaration", "execution.started"),
      stored(2, "bad-declaration", "request.prepared", "complete", {
        credentialsExcluded: false,
      }),
    ]);

    expect(report.requestPreparedCredentialExclusionViolationCount).toBe(1);
  });

  it("counts every ledger event after the first terminal by sequence", () => {
    const report = calculateAiAuditCoverage([
      stored(1, "closed", "execution.started"),
      stored(2, "closed", "request.dispatched"),
      stored(3, "closed", "execution.cancelled"),
      stored(4, "closed", "transport.attempt.started", "complete", {
        attemptNumber: 2,
      }),
      stored(5, "closed", "transport.attempt.finished", "complete", {
        attemptNumber: 2,
      }),
      stored(6, "closed", "execution.succeeded"),
      stored(7, "healthy", "execution.started"),
      stored(8, "healthy", "execution.succeeded"),
    ]);

    expect(report.postTerminalEventCount).toBe(3);
    expect(report.postTerminalExecutionCount).toBe(1);
    expect(report.postTerminalTransportAttemptCount).toBe(2);
  });

  it("uses ledger sequence rather than iterable order for post-terminal detection", () => {
    const report = calculateAiAuditCoverage([
      stored(3, "ordered", "response.partial"),
      stored(1, "ordered", "execution.started"),
      stored(2, "ordered", "execution.failed"),
    ]);

    expect(report.postTerminalEventCount).toBe(1);
    expect(report.postTerminalExecutionCount).toBe(1);
    expect(report.postTerminalTransportAttemptCount).toBe(0);
  });
});
