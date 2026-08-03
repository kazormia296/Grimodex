import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import packageJson from "../../../package.json";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));

import { useWorkspaceStore } from "@/features/workspace/store";
import {
  beginAiAuditExecution,
  beginAiAuditExecutionInWorkspace,
  cacheHitAiAuditExecution,
  cancelAiAuditExecution,
  completeAiAuditExecution,
  failAiAuditExecution,
  fallbackAiAuditExecution,
  markAiAuditDispatched,
  readAiAuditSnapshot,
  recordAiAuditPartial,
  recordAiAuditPartials,
  retryAiAuditExecution,
  sanitizeAiAuditDiagnostic,
  skipAiAuditExecution,
  verifyAiAuditChain,
} from "./api";
import type { AiAuditRequestSnapshot } from "./types";
import {
  _pendingAiAuditExecutionCountForTests,
  _resetPendingAiAuditExecutionsForTests,
  awaitPendingAiAuditExecutions,
} from "./executionRegistry";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";

const request: AiAuditRequestSnapshot = {
  provider: "openai",
  model: "gpt-5.6",
  messages: [{ role: "user", content: "全文をレビューして" }],
  options: { temperature: 0.2 },
};

// HTTP transport secrets are intentionally impossible at the public type.
const invalidRequest: AiAuditRequestSnapshot = {
  messages: [],
  // @ts-expect-error transport headers are not AI-visible request body data
  headers: { Authorization: "Bearer secret" },
};
void invalidRequest;

describe("AI audit renderer API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    _resetPendingAiAuditExecutionsForTests();
    _resetQuiescenceLeasesForTests();
  });

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({
      insertedCount: 1,
      tailSequence: 1,
      tailHash: "a".repeat(64),
    });
    useWorkspaceStore.setState({
      activeWorkspacePath: "/workspaces/novel",
      workspaceSwitchInProgress: false,
    });
  });

  it("durably appends started + exact request.prepared before resolving begin", async () => {
    let resolveAppend: ((value: unknown) => void) | undefined;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAppend = resolve;
        }),
    );
    let resolved = false;
    const pending = beginAiAuditExecution({
      projectId: "project-1",
      pathId: "chat.direct",
      operationId: "operation-1",
      executionId: "execution-1",
      parentExecutionId: null,
      request,
      metadata: { surface: "chat" },
      timestamp: 1_700_000_000_000,
    }).then((handle) => {
      resolved = true;
      return handle;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(_pendingAiAuditExecutionCountForTests()).toBe(1);
    let auditDrained = false;
    const drain = awaitPendingAiAuditExecutions().then(() => {
      auditDrained = true;
    });
    expect(invokeMock).toHaveBeenCalledWith("ai_audit_append_batch", {
      projectId: "project-1",
      expectedWorkspacePath: "/workspaces/novel",
      events: [
        expect.objectContaining({
          executionId: "execution-1",
          operationId: "operation-1",
          eventType: "execution.started",
          timestamp: 1_700_000_000_000,
          payload: expect.objectContaining({ captureState: "complete" }),
        }),
        expect.objectContaining({
          executionId: "execution-1",
          eventType: "request.prepared",
          payload: {
            captureState: "complete",
            credentialsExcluded: true,
            request,
            metadata: { surface: "chat" },
            appVersion: packageJson.version,
          },
        }),
      ],
    });

    resolveAppend?.({ insertedCount: 2, tailSequence: 2, tailHash: "b" });
    const handle = await pending;
    expect(handle).toMatchObject({
      projectId: "project-1",
      expectedWorkspacePath: "/workspaces/novel",
      operationId: "operation-1",
      executionId: "execution-1",
      parentExecutionId: null,
      pathId: "chat.direct",
    });
    expect(auditDrained).toBe(false);

    await completeAiAuditExecution(handle, {
      response: { text: "durable terminal" },
    });
    await drain;
    expect(auditDrained).toBe(true);
    expect(_pendingAiAuditExecutionCountForTests()).toBe(0);
  });

  it("rejects a new execution synchronously while audit export owns admission", async () => {
    const lease = acquireQuiescenceLease("audit-export");
    try {
      const blocked = beginAiAuditExecution({
        projectId: "project-1",
        pathId: "chat.direct",
        executionId: "blocked-execution",
        request,
      });

      await expect(blocked).rejects.toThrow("AI_AUDIT_ADMISSION_BLOCKED");
      expect(invokeMock).not.toHaveBeenCalled();
      expect(_pendingAiAuditExecutionCountForTests()).toBe(0);
    } finally {
      lease.release();
    }
  });

  it("abandons a begin that never became durable without making an export waiter reject", async () => {
    invokeMock.mockRejectedValue(new Error("begin audit storage failed"));
    const beginTask = beginAiAuditExecution({
      projectId: "project-1",
      pathId: "chat.direct",
      executionId: "failed-begin",
      request,
    });
    const drainTask = awaitPendingAiAuditExecutions();

    await expect(beginTask).rejects.toThrow("begin audit storage failed");
    await expect(drainTask).resolves.toBeUndefined();
    expect(_pendingAiAuditExecutionCountForTests()).toBe(0);
  });

  it("admits only a retry child of a pending parent after audit export closes admission", async () => {
    const parent = await beginAiAuditExecution({
      projectId: "project-1",
      pathId: "chat.direct",
      operationId: "operation-1",
      executionId: "execution-parent",
      request,
    });
    const lease = acquireQuiescenceLease("audit-export");
    try {
      let drained = false;
      const drain = awaitPendingAiAuditExecutions().then(() => {
        drained = true;
      });
      const retryTask = retryAiAuditExecution(parent, {
        request,
        reason: "HTTP 429",
        executionId: "execution-child",
      });

      // The child reservation is synchronous and closes the parent-to-retry
      // handoff before the export waiter can observe an empty registry.
      expect(_pendingAiAuditExecutionCountForTests()).toBe(2);
      await expect(
        beginAiAuditExecution({
          projectId: "project-1",
          pathId: "chat.direct",
          executionId: "unrelated-execution",
          request,
        }),
      ).rejects.toThrow("AI_AUDIT_ADMISSION_BLOCKED");

      const child = await retryTask;
      expect(child).toMatchObject({
        executionId: "execution-child",
        parentExecutionId: "execution-parent",
      });
      expect(drained).toBe(false);
      expect(_pendingAiAuditExecutionCountForTests()).toBe(1);

      await completeAiAuditExecution(child, {
        response: { text: "retry completed" },
      });
      await drain;
      expect(drained).toBe(true);
      expect(_pendingAiAuditExecutionCountForTests()).toBe(0);
    } finally {
      lease.release();
    }
  });

  it("keeps the original workspace snapshot for dispatch, partial, success, error and cancel", async () => {
    const handle = await beginAiAuditExecution({
      projectId: "project-1",
      pathId: "chat.direct",
      request,
    });
    useWorkspaceStore.setState({ activeWorkspacePath: "/workspaces/other" });
    invokeMock.mockClear();

    await markAiAuditDispatched(handle, { providerRequestId: "request-1" });
    await recordAiAuditPartial(handle, { text: "途中" });
    await completeAiAuditExecution(handle, {
      response: { text: "完了" },
      usage: { inputTokens: 10, outputTokens: 4 },
    });
    await failAiAuditExecution(handle, {
      error: { name: "ProviderError", message: "429" },
      partialResponse: { text: "途中" },
    });
    await cancelAiAuditExecution(handle, {
      reason: "user",
      partialResponse: { text: "途中" },
    });

    expect(invokeMock).toHaveBeenCalledTimes(5);
    for (const [, args] of invokeMock.mock.calls) {
      expect(args).toMatchObject({
        projectId: "project-1",
        expectedWorkspacePath: "/workspaces/novel",
      });
    }
    expect(invokeMock.mock.calls[1][1].events[0].payload).toMatchObject({
      captureState: "complete",
      response: { text: "途中" },
    });
    expect(
      invokeMock.mock.calls[2][1].events.map(
        (event: { eventType: string }) => event.eventType,
      ),
    ).toEqual(["response.completed", "execution.succeeded"]);
    expect(
      invokeMock.mock.calls[3][1].events.map(
        (event: { eventType: string }) => event.eventType,
      ),
    ).toEqual(["response.partial", "execution.failed"]);
    expect(
      invokeMock.mock.calls[4][1].events.map(
        (event: { eventType: string }) => event.eventType,
      ),
    ).toEqual(["response.partial", "execution.cancelled"]);
    expect(invokeMock.mock.calls[3][1].events[0].payload.captureState).toBe(
      "partial",
    );
  });

  it("wakes export drain fail-closed when a nonterminal append cannot persist and recovers at terminal", async () => {
    const handle = await beginAiAuditExecution({
      projectId: "project-1",
      pathId: "chat.direct",
      executionId: "nonterminal-storage-failure",
      request,
    });
    invokeMock.mockReset();
    invokeMock.mockRejectedValue(new Error("audit dispatch storage failed"));

    await expect(markAiAuditDispatched(handle)).rejects.toThrow(
      "audit dispatch storage failed",
    );
    expect(invokeMock).toHaveBeenCalledTimes(2);
    await expect(awaitPendingAiAuditExecutions()).rejects.toThrow(
      "did not persist required audit evidence",
    );
    expect(_pendingAiAuditExecutionCountForTests()).toBe(1);

    invokeMock.mockReset();
    invokeMock.mockResolvedValue({
      insertedCount: 2,
      tailSequence: 4,
      tailHash: "d".repeat(64),
    });
    await failAiAuditExecution(handle, {
      error: {
        name: "AuditPersistenceError",
        message: "provider was never dispatched",
      },
      metadata: { providerDispatched: false },
    });
    await expect(awaitPendingAiAuditExecutions()).resolves.toBeUndefined();
    expect(_pendingAiAuditExecutionCountForTests()).toBe(0);
  });

  it.each([
    [
      "skip",
      (handle: Awaited<ReturnType<typeof beginAiAuditExecution>>) =>
        skipAiAuditExecution(handle, { reason: "api_key=secret-value" }),
    ],
    [
      "failure",
      (handle: Awaited<ReturnType<typeof beginAiAuditExecution>>) =>
        failAiAuditExecution(handle, {
          error: new Error("api_key=secret-value"),
        }),
    ],
    [
      "cancellation",
      (handle: Awaited<ReturnType<typeof beginAiAuditExecution>>) =>
        cancelAiAuditExecution(handle, { reason: "api_key=secret-value" }),
    ],
  ])(
    "wakes export drain when %s terminal preprocessing fails",
    async (_label, terminalize) => {
      const handle = await beginAiAuditExecution({
        projectId: "project-1",
        pathId: "chat.direct",
        request,
      });
      invokeMock.mockClear();
      const digest = vi
        .spyOn(globalThis.crypto.subtle, "digest")
        .mockRejectedValueOnce(new Error("audit sanitizer hash failed"));

      await expect(terminalize(handle)).rejects.toThrow(
        "audit sanitizer hash failed",
      );
      expect(invokeMock).not.toHaveBeenCalled();
      await expect(awaitPendingAiAuditExecutions()).rejects.toThrow(
        "did not persist required audit evidence",
      );

      digest.mockRestore();
      await completeAiAuditExecution(handle, {
        response: { text: "terminal recovery" },
      });
      await expect(awaitPendingAiAuditExecutions()).resolves.toBeUndefined();
    },
  );

  it("fails the parent and abandons the child when retry reason preprocessing fails", async () => {
    const parent = await beginAiAuditExecution({
      projectId: "project-1",
      pathId: "chat.direct",
      executionId: "retry-preprocess-parent",
      request,
    });
    invokeMock.mockClear();
    const digest = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("retry reason hash failed"));

    await expect(
      retryAiAuditExecution(parent, {
        request,
        reason: "api_key=secret-value",
        executionId: "retry-preprocess-child",
      }),
    ).rejects.toThrow("retry reason hash failed");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(_pendingAiAuditExecutionCountForTests()).toBe(1);
    await expect(awaitPendingAiAuditExecutions()).rejects.toThrow(
      "did not persist required audit evidence",
    );

    digest.mockRestore();
    await failAiAuditExecution(parent, {
      error: new Error("retry preprocessing failed"),
    });
    await expect(awaitPendingAiAuditExecutions()).resolves.toBeUndefined();
  });

  it("places diagnostic redaction evidence at the partial event payload boundary", async () => {
    const handle = await beginAiAuditExecution({
      projectId: "project-1",
      pathId: "codex_app_server",
      request,
    });
    const sanitized = await sanitizeAiAuditDiagnostic(
      "OPENAI_API_KEY=runtime-secret",
      "response.partial.1.diagnostic.message",
    );
    invokeMock.mockClear();

    await recordAiAuditPartial(
      handle,
      { runtimeDiagnostic: { message: sanitized.value } },
      { captureState: "redacted", redactions: sanitized.redactions },
    );

    const payload = invokeMock.mock.calls[0][1].events[0].payload;
    expect(payload).toMatchObject({
      captureState: "redacted",
      response: {
        runtimeDiagnostic: { message: "OPENAI_API_KEY= [REDACTED:credential]" },
      },
    });
    expect(payload.redactions).toHaveLength(1);
    expect(payload.response).not.toHaveProperty("redactions");
    expect(JSON.stringify(payload)).not.toContain("runtime-secret");
  });

  it("redacts quoted and whitespace-separated provider auth diagnostics", async () => {
    const sanitized = await sanitizeAiAuditDiagnostic(
      `OPENAI_AUTH = "quoted auth secret" auth_anthropic: 'prefixed auth secret' body={"providerAuth":"json auth secret","message":"keep exact"}\nAuthentication: Basic authentication-secret\ninvalid key sk-ant-provider-secret`,
      "error.message",
    );

    expect(sanitized.value).not.toContain("quoted auth secret");
    expect(sanitized.value).not.toContain("prefixed auth secret");
    expect(sanitized.value).not.toContain("json auth secret");
    expect(sanitized.value).not.toContain("authentication-secret");
    expect(sanitized.value).not.toContain("sk-ant-provider-secret");
    expect(sanitized.value).toContain("keep exact");
    expect(sanitized.redactions).toHaveLength(5);
  });

  it("does not sanitize credential-shaped fiction inside model-visible content", async () => {
    const fictionalContent =
      '{"auth":"story oath","PRIVATE_KEY":"plot device","token":"arc token"}';
    await beginAiAuditExecution({
      projectId: "project-1",
      pathId: "chat.direct",
      request: { messages: [{ role: "user", content: fictionalContent }] },
    });

    expect(
      invokeMock.mock.calls[0][1].events[1].payload.request.messages[0].content,
    ).toBe(fictionalContent);
  });

  it("appends up to 64 exact partial rows in one native batch without losing receive timestamps", async () => {
    const handle = await beginAiAuditExecution({
      projectId: "project-1",
      pathId: "chat.direct",
      request,
    });
    invokeMock.mockClear();

    await recordAiAuditPartials(handle, [
      {
        response: {
          streamSequence: 1,
          blockType: "thinking",
          delta: "考",
        },
        receivedAt: 1_700_000_000_101,
      },
      {
        response: { streamSequence: 2, blockType: "text", delta: "本文" },
        receivedAt: 1_700_000_000_109,
        captureState: "partial",
      },
    ]);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const events = invokeMock.mock.calls[0][1].events;
    expect(events).toHaveLength(2);
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "response.partial",
        timestamp: 1_700_000_000_101,
        payload: expect.objectContaining({
          captureState: "complete",
          response: {
            streamSequence: 1,
            blockType: "thinking",
            delta: "考",
          },
        }),
      }),
      expect.objectContaining({
        eventType: "response.partial",
        timestamp: 1_700_000_000_109,
        payload: expect.objectContaining({
          captureState: "partial",
          response: {
            streamSequence: 2,
            blockType: "text",
            delta: "本文",
          },
        }),
      }),
    ]);
  });

  it("rejects an oversized partial batch before native dispatch", async () => {
    const handle = await beginAiAuditExecution({
      projectId: "project-1",
      pathId: "chat.direct",
      request,
    });
    invokeMock.mockClear();

    await expect(
      recordAiAuditPartials(
        handle,
        Array.from({ length: 65 }, (_, index) => ({
          response: { streamSequence: index + 1, delta: "x" },
          receivedAt: 1_700_000_000_000 + index,
        })),
      ),
    ).rejects.toThrow(/64/);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("retries a partial microbatch with the exact same ordered event IDs", async () => {
    const handle = await beginAiAuditExecution({
      projectId: "project-1",
      pathId: "chat.direct",
      request,
    });
    invokeMock.mockReset();
    invokeMock
      .mockRejectedValueOnce(new Error("native reply lost"))
      .mockResolvedValueOnce({
        insertedCount: 0,
        tailSequence: 4,
        tailHash: "b".repeat(64),
      });

    await recordAiAuditPartials(handle, [
      { response: { streamSequence: 1, delta: "a" }, receivedAt: 101 },
      { response: { streamSequence: 2, delta: "b" }, receivedAt: 102 },
    ]);

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls[0]).toEqual(invokeMock.mock.calls[1]);
    const eventIds = invokeMock.mock.calls[0][1].events.map(
      (item: { eventId: string }) => item.eventId,
    );
    expect(eventIds).toHaveLength(2);
    expect(new Set(eventIds).size).toBe(2);
  });

  it("redacts transport diagnostics with digest evidence while preserving AI-visible response text", async () => {
    const handle = await beginAiAuditExecution({
      projectId: "project-1",
      pathId: "chat.direct",
      request,
    });
    invokeMock.mockClear();
    const exactModelText =
      '作中の文字列 OPENAI_API_KEY=fictional、client_secret=fictional と {"ANTHROPIC_TOKEN":"fictional"} はそのまま保持する';

    await completeAiAuditExecution(handle, {
      response: { text: exactModelText },
    });
    await failAiAuditExecution(handle, {
      error: new Error(
        'request https://alice:password@example.com/v1?token=query-secret failed; Authorization: Bearer bearer-secret; api_key=key-secret; OPENAI_API_KEY=openai-prefixed-secret; client_secret=client-secret-value; AWS_ACCESS_KEY_ID=aws-id-value; Cookie=session-secret; {"api_key":"json-secret","ANTHROPIC_TOKEN":"anthropic-prefixed-secret","AWS_SECRET_ACCESS_KEY":"aws-secret-value","private_key":"pem-secret-value","headers":{"Authorization":"Bearer json-bearer","Cookie":"json-cookie"}}',
      ),
    });
    await cancelAiAuditExecution(handle, {
      reason: "cancelled password=cancel-secret",
    });

    const successEvents = invokeMock.mock.calls[0][1].events;
    expect(successEvents[0].payload.response.text).toBe(exactModelText);

    const failed = invokeMock.mock.calls[1][1].events.at(-1).payload;
    const cancelled = invokeMock.mock.calls[2][1].events.at(-1).payload;
    const diagnosticsJson = JSON.stringify({ failed, cancelled });
    for (const secret of [
      "alice",
      "query-secret",
      "bearer-secret",
      "key-secret",
      "openai-prefixed-secret",
      "client-secret-value",
      "aws-id-value",
      "session-secret",
      "json-secret",
      "anthropic-prefixed-secret",
      "aws-secret-value",
      "pem-secret-value",
      "json-bearer",
      "json-cookie",
      "cancel-secret",
    ]) {
      expect(diagnosticsJson).not.toContain(secret);
    }
    expect(diagnosticsJson).not.toContain("alice:password");
    expect(failed.captureState).toBe("redacted");
    expect(cancelled.captureState).toBe("redacted");
    expect(failed.redactions.length).toBeGreaterThan(0);
    for (const redaction of [...failed.redactions, ...cancelled.redactions]) {
      expect(redaction.originalSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(redaction.originalByteLength).toBeGreaterThan(0);
      expect(redaction.placeholder).toBe("[REDACTED:credential]");
      expect(redaction.reversible).toBe(false);
    }
  });

  it("retries a terminal append once with the exact same event IDs", async () => {
    const handle = await beginAiAuditExecution({
      projectId: "project-1",
      pathId: "chat.direct",
      request,
    });
    invokeMock.mockReset();
    invokeMock
      .mockRejectedValueOnce(new Error("native reply lost"))
      .mockResolvedValueOnce({
        insertedCount: 0,
        tailSequence: 4,
        tailHash: "b".repeat(64),
      });

    await completeAiAuditExecution(handle, {
      response: { text: "exact provider response" },
    });

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls[0]).toEqual(invokeMock.mock.calls[1]);
    const events = invokeMock.mock.calls[0][1].events;
    expect(events.map((item: { eventType: string }) => item.eventType)).toEqual(
      ["response.completed", "execution.succeeded"],
    );
    expect(events[0].payload.response).toEqual({
      text: "exact provider response",
    });
  });

  it("fails audit drain closed after both terminal appends fail and recovers on an explicit terminal retry", async () => {
    const handle = await beginAiAuditExecution({
      projectId: "project-1",
      pathId: "chat.direct",
      executionId: "recoverable-terminal",
      request,
    });
    invokeMock.mockReset();
    invokeMock.mockRejectedValue(new Error("audit storage unavailable"));

    await expect(
      completeAiAuditExecution(handle, {
        response: { text: "provider already completed" },
      }),
    ).rejects.toThrow("audit storage unavailable");
    expect(invokeMock).toHaveBeenCalledTimes(2);
    await expect(awaitPendingAiAuditExecutions()).rejects.toThrow(
      "did not persist required audit evidence",
    );
    expect(_pendingAiAuditExecutionCountForTests()).toBe(1);

    invokeMock.mockReset();
    invokeMock.mockResolvedValue({
      insertedCount: 2,
      tailSequence: 4,
      tailHash: "c".repeat(64),
    });
    await completeAiAuditExecution(handle, {
      response: { text: "provider already completed" },
    });

    await expect(awaitPendingAiAuditExecutions()).resolves.toBeUndefined();
    expect(_pendingAiAuditExecutionCountForTests()).toBe(0);
  });

  it("retry/fallback terminalize the prior attempt and create a child execution in the same operation", async () => {
    const handle = await beginAiAuditExecution({
      projectId: "project-1",
      pathId: "chat.direct",
      operationId: "operation-1",
      executionId: "execution-1",
      request,
    });
    invokeMock.mockClear();

    const retry = await retryAiAuditExecution(handle, {
      request,
      reason: "HTTP 429",
      executionId: "execution-2",
    });
    const fallback = await fallbackAiAuditExecution(retry, {
      request,
      reason: "App Server unavailable",
      pathId: "chat.cli",
      executionId: "execution-3",
    });

    expect(retry).toMatchObject({
      operationId: "operation-1",
      executionId: "execution-2",
      parentExecutionId: "execution-1",
    });
    expect(fallback).toMatchObject({
      operationId: "operation-1",
      executionId: "execution-3",
      parentExecutionId: "execution-2",
      pathId: "chat.cli",
    });
    expect(
      invokeMock.mock.calls[0][1].events.map(
        (event: { eventType: string }) => event.eventType,
      ),
    ).toEqual(["execution.retrying", "execution.failed"]);
    expect(
      invokeMock.mock.calls[2][1].events.map(
        (event: { eventType: string }) => event.eventType,
      ),
    ).toEqual(["execution.fallback", "execution.failed"]);
  });

  it("records cache reuse as a non-dispatched terminal execution", async () => {
    const handle = await beginAiAuditExecution({
      projectId: "project-1",
      pathId: "ab.cached_slot",
      request,
    });
    invokeMock.mockClear();

    await cacheHitAiAuditExecution(handle, {
      response: { text: "cached candidate" },
      metadata: { slot: "B" },
    });

    const events = invokeMock.mock.calls[0][1].events;
    expect(events.map((item: { eventType: string }) => item.eventType)).toEqual(
      ["execution.cache_hit"],
    );
    expect(events[0].payload).toMatchObject({
      captureState: "complete",
      modelDispatched: false,
      response: { text: "cached candidate" },
      metadata: { slot: "B" },
    });
  });

  it("records a pre-dispatch unsupported path as skipped instead of leaving an open execution", async () => {
    const handle = await beginAiAuditExecution({
      projectId: "project-1",
      pathId: "chat.single-shot",
      request,
    });
    invokeMock.mockClear();

    await skipAiAuditExecution(handle, {
      reason: "AI_SINGLE_SHOT_CLI_UNSUPPORTED",
      metadata: { unsupportedProvider: "cli" },
    });

    const events = invokeMock.mock.calls[0][1].events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "execution.skipped",
      payload: {
        captureState: "complete",
        modelDispatched: false,
        reason: "AI_SINGLE_SHOT_CLI_UNSUPPORTED",
        metadata: { unsupportedProvider: "cli" },
        appVersion: packageJson.version,
      },
    });
  });

  it("uses an explicit workspace authority and rejects a changed active workspace before append", async () => {
    await beginAiAuditExecutionInWorkspace(
      { projectId: "project-1", pathId: "codex_app_server", request },
      "/workspaces/novel",
    );
    expect(invokeMock).toHaveBeenLastCalledWith(
      "ai_audit_append_batch",
      expect.objectContaining({
        expectedWorkspacePath: "/workspaces/novel",
      }),
    );

    invokeMock.mockClear();
    useWorkspaceStore.setState({ activeWorkspacePath: "/workspaces/other" });
    await expect(
      beginAiAuditExecutionInWorkspace(
        { projectId: "project-1", pathId: "codex_app_server", request },
        "/workspaces/novel",
      ),
    ).rejects.toThrow("AI_AUDIT_WORKSPACE_CHANGED");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("honors an optional begin authority used by transport contexts", async () => {
    useWorkspaceStore.setState({
      activeWorkspacePath: "/workspaces/other",
      workspaceSwitchInProgress: false,
    });
    invokeMock.mockClear();

    await expect(
      beginAiAuditExecution({
        projectId: "project-1",
        expectedWorkspacePath: "/workspaces/original",
        pathId: "ab_inline",
        request,
      }),
    ).rejects.toThrow("AI_AUDIT_WORKSPACE_CHANGED");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("uses the workspace scope only through an explicit null projectId", async () => {
    await beginAiAuditExecution({
      projectId: null,
      pathId: "provider.connection_probe",
      request,
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "ai_audit_append_batch",
      expect.objectContaining({ projectId: null }),
    );
  });

  it("fails closed before invoke when no stable workspace is active", async () => {
    useWorkspaceStore.setState({ activeWorkspacePath: null });
    await expect(
      beginAiAuditExecution({
        projectId: "project-1",
        pathId: "chat.direct",
        request,
      }),
    ).rejects.toThrow(/workspace/i);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reads and verifies an explicitly pinned high-water snapshot", async () => {
    invokeMock
      .mockResolvedValueOnce({
        projectId: "project-1",
        afterSequence: 0,
        highWaterSequence: 7,
        highWaterHash: "c".repeat(64),
        nextAfterSequence: null,
        events: [],
      })
      .mockResolvedValueOnce({
        ok: true,
        verifiedThroughSequence: 7,
        brokenAtSequence: null,
        reason: null,
        tailHash: "c".repeat(64),
      });

    await readAiAuditSnapshot("project-1", {
      highWaterSequence: 7,
      limit: 500,
    });
    await verifyAiAuditChain("project-1", { highWaterSequence: 7 });
    expect(invokeMock.mock.calls).toEqual([
      [
        "ai_audit_read_snapshot",
        {
          projectId: "project-1",
          expectedWorkspacePath: "/workspaces/novel",
          afterSequence: undefined,
          highWaterSequence: 7,
          limit: 500,
        },
      ],
      [
        "ai_audit_verify",
        {
          projectId: "project-1",
          expectedWorkspacePath: "/workspaces/novel",
          highWaterSequence: 7,
        },
      ],
    ]);
  });

  it("keeps an explicitly pinned workspace path across later reads and verify", async () => {
    invokeMock.mockResolvedValue({
      scopeId: "project:project-1",
      projectId: "project-1",
      afterSequence: 0,
      highWaterSequence: 0,
      highWaterHash: "0".repeat(64),
      nextAfterSequence: null,
      events: [],
    });
    useWorkspaceStore.setState({ activeWorkspacePath: "/workspaces/other" });

    await readAiAuditSnapshot("project-1", {
      expectedWorkspacePath: "/workspaces/original",
      highWaterSequence: 0,
      limit: 1_000,
    });
    await verifyAiAuditChain("project-1", {
      expectedWorkspacePath: "/workspaces/original",
      highWaterSequence: 0,
    });

    expect(invokeMock.mock.calls).toEqual([
      [
        "ai_audit_read_snapshot",
        expect.objectContaining({
          expectedWorkspacePath: "/workspaces/original",
        }),
      ],
      [
        "ai_audit_verify",
        expect.objectContaining({
          expectedWorkspacePath: "/workspaces/original",
        }),
      ],
    ]);
  });
});
