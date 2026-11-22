// MP-3b: the pure part of the AI audit writer, moved from the renderer's
// `api.ts` unchanged and shared with Electron main's agent audit sink. The
// renderer's own tests (`api.test.ts`, `chatApi.audit.test.ts`) pass untouched;
// these hold the shape the two writers depend on.
import { describe, expect, it } from "vitest";

import {
  AI_AUDIT_EVENT_TYPES,
  buildAiAuditBeginEvents,
  buildAiAuditCancelledEvents,
  buildAiAuditCompletedEvents,
  buildAiAuditDispatchedEvent,
  buildAiAuditFailedEvents,
  createAiAuditEvent,
  sanitizedErrorSnapshot,
  sanitizeAiAuditDiagnostic,
  TERMINAL_AI_AUDIT_EVENT_TYPES,
  type AiAuditEventContext,
} from "./aiAuditEvents.js";

const CONTEXT: AiAuditEventContext = {
  executionId: "exec-1",
  operationId: "op-1",
  parentExecutionId: null,
  pathId: "chat_agent_main",
  appVersion: "1.2.3",
};

describe("createAiAuditEvent", () => {
  it("keeps the event's key order and puts appVersion last in the payload", () => {
    const event = createAiAuditEvent(
      CONTEXT,
      "execution.started",
      { captureState: "complete", a: 1 },
      42,
    );
    expect(Object.keys(event)).toEqual([
      "eventId",
      "executionId",
      "operationId",
      "parentExecutionId",
      "pathId",
      "eventType",
      "timestamp",
      "payload",
    ]);
    expect(Object.keys(event.payload)).toEqual([
      "captureState",
      "a",
      "appVersion",
    ]);
    expect(event).toMatchObject({
      executionId: "exec-1",
      operationId: "op-1",
      parentExecutionId: null,
      pathId: "chat_agent_main",
      timestamp: 42,
    });
    expect(event.payload.appVersion).toBe("1.2.3");
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("takes appVersion from the argument, never from anywhere else", () => {
    const event = createAiAuditEvent(
      { ...CONTEXT, appVersion: "7.7.7" },
      "request.dispatched",
      { captureState: "complete", appVersion: "payload-wins?" },
      1,
    );
    expect(event.payload.appVersion).toBe("7.7.7");
  });
});

describe("the builders", () => {
  it("begin: started then prepared, with the exact request and no credentials", () => {
    const events = buildAiAuditBeginEvents(
      CONTEXT,
      {
        request: { messages: [] },
        limitations: ["l"],
        metadata: { m: 1 },
      },
      5,
    );
    expect(events.map((event) => event.eventType)).toEqual([
      "execution.started",
      "request.prepared",
    ]);
    expect(events[0].payload).toEqual({
      captureState: "complete",
      limitations: ["l"],
      metadata: { m: 1 },
      appVersion: "1.2.3",
    });
    expect(events[1].payload).toEqual({
      captureState: "complete",
      credentialsExcluded: true,
      request: { messages: [] },
      limitations: ["l"],
      metadata: { m: 1 },
      appVersion: "1.2.3",
    });
    expect(events.every((event) => event.timestamp === 5)).toBe(true);
  });

  it("dispatched, completed, failed and cancelled build the rows the writers append", () => {
    expect(
      buildAiAuditDispatchedEvent(CONTEXT, { command: "c" }, 1).payload,
    ).toEqual({ captureState: "complete", command: "c", appVersion: "1.2.3" });
    const completed = buildAiAuditCompletedEvents(
      CONTEXT,
      { response: { r: 1 }, usage: { u: 1 } },
      2,
    );
    expect(completed.map((event) => event.eventType)).toEqual([
      "response.completed",
      "execution.succeeded",
    ]);
    const failed = buildAiAuditFailedEvents(
      CONTEXT,
      { error: { name: "E", message: "m" }, redactions: [] },
      { partialResponse: { p: 1 } },
      3,
    );
    expect(failed.map((event) => event.eventType)).toEqual([
      "response.partial",
      "execution.failed",
    ]);
    expect(failed[1].payload.captureState).toBe("partial");
    const cancelled = buildAiAuditCancelledEvents(
      CONTEXT,
      { value: "stop", redactions: [] },
      {},
      4,
    );
    expect(cancelled.map((event) => event.eventType)).toEqual([
      "execution.cancelled",
    ]);
    expect(cancelled[0].payload).toMatchObject({
      captureState: "complete",
      reason: "stop",
    });
  });

  it("the terminal set and the event types are the renderer's", () => {
    expect([...TERMINAL_AI_AUDIT_EVENT_TYPES].sort()).toEqual([
      "execution.cache_hit",
      "execution.cancelled",
      "execution.failed",
      "execution.skipped",
      "execution.succeeded",
    ]);
    expect(AI_AUDIT_EVENT_TYPES).toHaveLength(14);
  });
});

describe("the redaction", () => {
  it("redacts a credential in a diagnostic and records its hash, not the value", async () => {
    const sanitized = await sanitizeAiAuditDiagnostic(
      "failed: Authorization: Bearer sk-abcdefghijklmnop at https://u:p@h.example/x?token=t",
      "error.message",
    );
    expect(sanitized.value).not.toContain("sk-abcdefghijklmnop");
    expect(sanitized.value).not.toContain("u:p@");
    expect(sanitized.redactions.length).toBeGreaterThan(0);
    for (const redaction of sanitized.redactions) {
      expect(redaction.originalSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(redaction.placeholder).toBe("[REDACTED:credential]");
      expect(redaction.reversible).toBe(false);
    }
  });

  it("snapshots an error by name, message and code, sanitized", async () => {
    const error = Object.assign(new Error("token: abc123"), { code: "E_X" });
    const snapshot = await sanitizedErrorSnapshot(error);
    expect(snapshot.error.name).toBe("Error");
    expect(snapshot.error.code).toBe("E_X");
    expect(snapshot.error.message).not.toContain("abc123");
    expect((await sanitizedErrorSnapshot("plain")).error).toEqual({
      name: "Error",
      message: "plain",
    });
  });
});
