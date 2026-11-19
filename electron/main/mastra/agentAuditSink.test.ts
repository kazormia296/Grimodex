// MP-3b (DR-MP3-10, -23): Electron main's audit writer for the Mastra agent
// turn. It writes the three rows a dispatch needs in the order the Rust side
// requires, through the contract's checks, with the path ID kept, one terminal
// per execution, the ambiguous terminal's payload, and no capability.
import { describe, expect, it } from "vitest";

import type { AiAuditEventInput } from "../../shared/aiAuditEvents.js";
import type { NapiBackendLike } from "../../shared/ipcContract.js";
import {
  createMainAgentAuditSink,
  MAIN_AGENT_AUDIT_OWNER,
  MAIN_AGENT_AUDIT_PATH_ID,
  type MainAgentAuditSink,
} from "./agentAuditSink.js";
import { AgentModelError } from "./agentModelPolicy.js";
import type { AgentAuditCompletion, AgentAuditRequest } from "./agentWire.js";

interface AppendCall {
  readonly expectedWorkspacePath: string;
  readonly projectId: string | null;
  readonly events: readonly AiAuditEventInput[];
}

function fakeBackend(
  behavior: (call: AppendCall, index: number) => void | Promise<void> = () =>
    undefined,
) {
  const calls: AppendCall[] = [];
  const touched: string[] = [];
  const target = {
    async aiAuditAppendBatch(
      expectedWorkspacePath: string,
      projectId: string | null,
      events: unknown,
    ): Promise<string> {
      const call = {
        expectedWorkspacePath,
        projectId,
        events: events as readonly AiAuditEventInput[],
      };
      calls.push(call);
      await behavior(call, calls.length - 1);
      return JSON.stringify({ insertedCount: call.events.length });
    },
  };
  // The sink is given the append method only: any other member it reached for
  // (the send, a settings read) would be recorded and fail the test.
  const backend = new Proxy(target, {
    get(object, key, receiver) {
      if (key !== "aiAuditAppendBatch") touched.push(String(key));
      return Reflect.get(object, key, receiver) as unknown;
    },
  }) as unknown as Pick<NapiBackendLike, "aiAuditAppendBatch">;
  return { backend, calls, touched };
}

function request(extra: Record<string, unknown> = {}): AgentAuditRequest {
  return {
    messages: [
      { role: "system", content: "You write." },
      { role: "user", content: "Continue the scene." },
    ],
    tools: [],
    thinking: null,
    effort: null,
    reasoningEnabled: null,
    reasoningEffort: null,
    systemCacheSegments: ["segment"],
    apiVariant: null,
    webSearch: null,
    systemVolatileTail: "tail",
    model: "claude-x",
    provider: "anthropic",
    endpointId: null,
    expectedOllamaEndpoint: null,
    ...extra,
  } as unknown as AgentAuditRequest;
}

function makeSink(
  behavior?: (call: AppendCall, index: number) => void | Promise<void>,
  options: { projectId?: string | null } = {},
) {
  const fake = fakeBackend(behavior);
  let uuid = 0;
  let clock = 1_000;
  const sink = createMainAgentAuditSink({
    backend: fake.backend,
    appVersion: "9.9.9",
    projectId:
      options.projectId === undefined ? "project-1" : options.projectId,
    expectedWorkspacePath: "/ws/a",
    operationId: "op-1",
    now: () => (clock += 1),
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  });
  return { sink, ...fake };
}

const types = (call: AppendCall) => call.events.map((event) => event.eventType);

const COMPLETION: AgentAuditCompletion = {
  response: {
    blocks: [{ type: "text", content: "Done." }],
    stopReason: "end_turn",
    inputTokens: 10,
    outputTokens: 2,
  },
  usage: {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cost: null,
    stopReason: "end_turn",
  },
};

async function begun(sink: MainAgentAuditSink) {
  const handle = await sink.begin(request());
  await sink.dispatched(handle);
  return handle;
}

describe("begin and dispatched", () => {
  it("writes started+prepared in one batch, then dispatched in a second, each awaited in order", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sink, calls } = makeSink(async (call, index) => {
      order.push(`start:${types(call).join("+")}`);
      if (index === 0) await gate;
      order.push(`end:${types(call).join("+")}`);
    });
    const beginning = sink.begin(request());
    // The begin batch is in flight; nothing else was written.
    await Promise.resolve();
    expect(calls.map(types)).toEqual([
      ["execution.started", "request.prepared"],
    ]);
    release();
    const handle = await beginning;
    expect(calls).toHaveLength(1);
    await sink.dispatched(handle);
    expect(calls.map(types)).toEqual([
      ["execution.started", "request.prepared"],
      ["request.dispatched"],
    ]);
    expect(order).toEqual([
      "start:execution.started+request.prepared",
      "end:execution.started+request.prepared",
      "start:request.dispatched",
      "end:request.dispatched",
    ]);
  });

  it("names every row by Main's execution, the kept path ID and a null parent, with appVersion last, and labels no row with an owner", async () => {
    const { sink, calls } = makeSink();
    const handle = await begun(sink);
    expect(handle.executionId).toBe("00000000-0000-4000-8000-000000000001");
    expect(handle.auditContext).toEqual({
      expectedWorkspacePath: "/ws/a",
      projectId: "project-1",
      operationId: "op-1",
      executionId: handle.executionId,
      parentExecutionId: null,
      pathId: "chat_agent_main",
    });
    expect(MAIN_AGENT_AUDIT_PATH_ID).toBe("chat_agent_main");
    const events = calls.flatMap((call) => call.events);
    expect(events).toHaveLength(3);
    for (const event of events) {
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
      expect(event).toMatchObject({
        executionId: handle.executionId,
        operationId: "op-1",
        parentExecutionId: null,
        pathId: "chat_agent_main",
      });
      expect(Object.keys(event.payload).at(-1)).toBe("appVersion");
      expect(event.payload.appVersion).toBe("9.9.9");
    }
    for (const call of calls) {
      expect(call.expectedWorkspacePath).toBe("/ws/a");
      expect(call.projectId).toBe("project-1");
    }
    expect(
      new Set(events.map((event) => event.eventId)).size,
      "event IDs are unique",
    ).toBe(3);
    // The owner is the registry's (an additional owner of the path), not a
    // label on a row; a main-written dispatch is told apart by its boundary.
    for (const event of events) {
      expect(JSON.stringify(event)).not.toContain("auditOwner");
      expect(JSON.stringify(event)).not.toContain(MAIN_AGENT_AUDIT_OWNER);
    }
    expect(events[2].payload).toMatchObject({
      command: "send_agent_message",
      dispatchBoundary: "before_electron_main_native_send",
      transportTarget: "electron-main-native",
      providerReceiptObserved: false,
    });
  });

  it("records the model-visible request by allow-list: no capability, no identity, no audit context", async () => {
    const { sink, calls } = makeSink();
    await sink.begin(
      request({
        callerIdentity: { senderId: 1 },
        auditContext: { pathId: "x" },
        chatMessageId: "m-1",
        capability: "bearer-token",
        agentAuthorityCapabilities: { t: { capability: "bearer-token" } },
        apiKey: "sk-secret-value",
      }),
    );
    const prepared = calls[0].events[1];
    expect(prepared.eventType).toBe("request.prepared");
    expect(prepared.payload.credentialsExcluded).toBe(true);
    const snapshot = JSON.stringify(prepared.payload.request);
    for (const forbidden of [
      "bearer-token",
      "sk-secret-value",
      "callerIdentity",
      "auditContext",
      "chatMessageId",
      "agentAuthorityCapabilities",
    ]) {
      expect(snapshot, forbidden).not.toContain(forbidden);
    }
    expect(prepared.payload.request).toMatchObject({
      messages: [
        { role: "system", content: "You write." },
        { role: "user", content: "Continue the scene." },
      ],
      provider: "anthropic",
      model: "claude-x",
      tools: [],
      modelVisibleContext: {
        systemCacheSegments: ["segment"],
        systemVolatileTail: "tail",
      },
    });
    // The route is the renderer's snapshot, not an effective one: partial.
    expect(prepared.payload.captureState).toBe("partial");
    expect(prepared.payload.limitations).toEqual([
      "effective-route-unresolved-before-transport",
    ]);
  });

  it("issues a fresh execution per begin under one operation, and a null project is the workspace chain", async () => {
    const { sink, calls } = makeSink(undefined, { projectId: null });
    const first = await sink.begin(request());
    const second = await sink.begin(request());
    expect(first.executionId).not.toBe(second.executionId);
    expect(first.operationId).toBe(second.operationId);
    expect(calls.every((call) => call.projectId === null)).toBe(true);
  });

  it("a failed begin leaves no handle: nothing is dispatched", async () => {
    const { sink, calls } = makeSink(() => {
      throw new Error("append failed");
    });
    await expect(sink.begin(request())).rejects.toThrow("append failed");
    // The same batch was tried twice (the idempotent re-send), and no other.
    expect(calls.map(types)).toEqual([
      ["execution.started", "request.prepared"],
      ["execution.started", "request.prepared"],
    ]);
  });

  it("dispatched needs a begun execution and writes once", async () => {
    const { sink, calls } = makeSink();
    const handle = await sink.begin(request());
    await sink.dispatched(handle);
    await expect(sink.dispatched(handle)).rejects.toThrow(
      "AGENT_AUDIT_NOT_BEGUN",
    );
    expect(calls.map(types)).toEqual([
      ["execution.started", "request.prepared"],
      ["request.dispatched"],
    ]);
    const unknown = { ...handle, executionId: "never-begun" };
    await expect(sink.dispatched(unknown)).rejects.toThrow(
      "AGENT_AUDIT_NOT_BEGUN",
    );
  });
});

describe("a terminal that is claimed while the dispatch is being written", () => {
  it("fails the dispatch before the send, even though its append went through", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sink, calls } = makeSink(async (call) => {
      if (types(call).includes("request.dispatched")) await gate;
    });
    const handle = await sink.begin(request());
    const dispatching = sink.dispatched(handle);
    // The dispatch row is in flight when the forced abort claims the terminal.
    await Promise.resolve();
    const terminal = sink.ambiguous(handle, { cause: "workspace-switch" });
    release();
    await expect(dispatching).rejects.toThrow(
      "AGENT_AUDIT_TERMINAL_ALREADY_WRITTEN",
    );
    await terminal;
    // Exactly one terminal, and the adapter would not reach the send.
    const terminals = calls
      .flatMap((call) => call.events)
      .filter((event) => event.eventType === "execution.failed");
    expect(terminals).toHaveLength(1);
  });
});

describe("a stop that is requested while a dispatch or a terminal is in flight", () => {
  const isTerminalBatch = (call: AppendCall) =>
    call.events.some((event) =>
      [
        "execution.failed",
        "execution.succeeded",
        "execution.cancelled",
      ].includes(event.eventType),
    );

  it("in-flight dispatched and a terminal whose append fails twice: the dispatch still does not go on to a send", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sink } = makeSink(async (call) => {
      if (types(call).includes("request.dispatched")) await gate;
      if (isTerminalBatch(call)) throw new Error("storage down");
    });
    const handle = await sink.begin(request());
    const dispatching = sink.dispatched(handle);
    await Promise.resolve();
    const stopping = sink.ambiguous(handle, { cause: "workspace-switch" });
    // The terminal's append fails (and is re-sent once and fails again), which
    // releases its claim; the dispatch must still be refused.
    await expect(stopping).rejects.toThrow("storage down");
    release();
    await expect(dispatching).rejects.toThrow(
      "AGENT_AUDIT_TERMINAL_ALREADY_WRITTEN",
    );
    // And a dispatch asked for later is refused too: the stop is remembered.
    await expect(sink.dispatched(handle)).rejects.toThrow(
      "AGENT_AUDIT_TERMINAL_ALREADY_WRITTEN",
    );
  });

  it("an ambiguous call waits for a complete in flight, and writes nothing if it was written", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sink, calls } = makeSink(async (call) => {
      if (types(call).includes("response.completed")) await gate;
    });
    const handle = await begun(sink);
    const completing = sink.complete(handle, COMPLETION);
    await Promise.resolve();
    let ambiguousDone = false;
    const ambiguous = sink.ambiguous(handle, { cause: "quit" }).then(() => {
      ambiguousDone = true;
    });
    await Promise.resolve();
    // It has not returned early: the complete is still in flight.
    expect(ambiguousDone).toBe(false);
    release();
    await Promise.all([completing, ambiguous]);
    expect(types(calls.at(-1)!)).toEqual([
      "response.completed",
      "execution.succeeded",
    ]);
    expect(calls.filter(isTerminalBatch)).toHaveLength(1);
  });

  it("an ambiguous call whose complete in flight fails writes its own terminal (never start-only)", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sink, calls } = makeSink(async (call) => {
      if (types(call).includes("response.completed")) {
        await gate;
        throw new Error("storage down");
      }
    });
    const handle = await begun(sink);
    const completing = sink.complete(handle, COMPLETION);
    await Promise.resolve();
    const ambiguous = sink.ambiguous(handle, { cause: "quit" });
    release();
    await expect(completing).rejects.toThrow("storage down");
    await ambiguous;
    const terminals = calls.filter(
      (call) =>
        isTerminalBatch(call) && !types(call).includes("response.completed"),
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0].events[0]).toMatchObject({
      eventType: "execution.failed",
      payload: { remoteOutcome: "unknown", responseObserved: false },
    });
  });

  it("two waiters behind one failing terminal write exactly one terminal between them", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sink, calls } = makeSink(async (call) => {
      if (types(call).includes("response.completed")) {
        await gate;
        throw new Error("storage down");
      }
    });
    const handle = await begun(sink);
    const completing = sink.complete(handle, COMPLETION);
    await Promise.resolve();
    const a = sink.ambiguous(handle, { cause: "quit" });
    const b = sink.fail(handle, new Error("late"));
    release();
    await expect(completing).rejects.toThrow();
    await Promise.all([a, b]);
    expect(
      calls.filter(
        (call) =>
          isTerminalBatch(call) && !types(call).includes("response.completed"),
      ),
    ).toHaveLength(1);
  });
});

describe("the append: one idempotent re-send, never a provider re-send", () => {
  it("re-sends a failed batch once with the same event IDs, and then reports the failure", async () => {
    let failures = 1;
    const { sink, calls } = makeSink((_call, index) => {
      if (index === 0 && failures-- > 0) throw new Error("lost reply");
    });
    await sink.begin(request());
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[1].events.map((event) => event.eventId)).toEqual(
      calls[0].events.map((event) => event.eventId),
    );
    const failing = makeSink(() => {
      throw new Error("down");
    });
    await expect(failing.sink.begin(request())).rejects.toThrow("down");
    expect(failing.calls).toHaveLength(2);
  });

  it("holds no reference to the send: only the append method of the backend is read", async () => {
    const { sink, touched } = makeSink();
    const handle = await begun(sink);
    await sink.complete(handle, COMPLETION);
    const other = await begun(sink);
    await sink.fail(other, new Error("x"));
    expect(touched).toEqual([]);
  });

  it("every batch passes the contract's checks of ai_audit_append_batch (a reserved namespace is refused before Native)", async () => {
    // The sink appends through `runAiAuditAppendBatch`: its checks run before
    // the backend. A workspace path that is empty is refused there.
    const fake = fakeBackend();
    const sink = createMainAgentAuditSink({
      backend: fake.backend,
      appVersion: "1",
      projectId: "p",
      expectedWorkspacePath: "",
    });
    await expect(sink.begin(request())).rejects.toThrow(
      /expectedWorkspacePath/u,
    );
    expect(fake.calls).toEqual([]);
  });
});

describe("complete and fail", () => {
  it("complete writes response.completed and execution.succeeded, with the usage, and never a capability", async () => {
    const { sink, calls } = makeSink();
    const handle = await begun(sink);
    await sink.complete(handle, {
      ...COMPLETION,
      response: {
        ...COMPLETION.response,
        agentAuthorityCapabilities: { t: { capability: "bearer-token" } },
      } as never,
    });
    const last = calls.at(-1)!;
    expect(types(last)).toEqual(["response.completed", "execution.succeeded"]);
    expect(JSON.stringify(last.events)).not.toContain("bearer-token");
    expect(JSON.stringify(last.events)).not.toContain("agentAuthority");
    expect(last.events[0].payload).toMatchObject({
      captureState: "complete",
      response: COMPLETION.response,
    });
    expect(last.events[0].payload).not.toHaveProperty("metadata");
    expect(last.events[1].payload).toMatchObject({
      captureState: "complete",
      usage: COMPLETION.usage,
    });
  });

  it("fail records the cause the adapter wrapped, sanitized, with the adapter's kind as metadata", async () => {
    const { sink, calls } = makeSink();
    const handle = await begun(sink);
    const origin = new Error(
      "provider said no; Authorization: Bearer sk-abcdefghijklmnop",
    );
    await sink.fail(
      handle,
      new AgentModelError(
        "send-failed",
        "send_agent_message failed (see origin)",
        origin,
      ),
    );
    const last = calls.at(-1)!;
    expect(types(last)).toEqual(["execution.failed"]);
    const payload = last.events[0].payload;
    expect(payload.captureState).toBe("redacted");
    expect(JSON.stringify(payload)).not.toContain("sk-abcdefghijklmnop");
    expect(payload.error).toMatchObject({ name: "Error" });
    expect(JSON.stringify(payload.error)).toContain("provider said no");
    expect(payload.metadata).toEqual({ agentErrorKind: "send-failed" });
    // The wrapper's own fixed text is not what is recorded.
    expect(JSON.stringify(payload.error)).not.toContain("see origin");
  });

  it("fail of an error that is not the adapter's records it as it is", async () => {
    const { sink, calls } = makeSink();
    const handle = await begun(sink);
    await sink.fail(handle, new Error("plain failure"));
    const payload = calls.at(-1)!.events[0].payload;
    expect(payload.captureState).toBe("complete");
    expect(payload.error).toEqual({ name: "Error", message: "plain failure" });
    expect(payload).not.toHaveProperty("metadata");
  });
});

describe("one terminal per execution", () => {
  it("a second terminal of any kind writes nothing", async () => {
    for (const second of ["complete", "fail", "ambiguous"] as const) {
      const { sink, calls } = makeSink();
      const handle = await begun(sink);
      await sink.complete(handle, COMPLETION);
      const before = calls.length;
      if (second === "complete") await sink.complete(handle, COMPLETION);
      if (second === "fail") await sink.fail(handle, new Error("late"));
      if (second === "ambiguous") {
        await sink.ambiguous(handle, { cause: "workspace-switch" });
      }
      expect(calls.length, second).toBe(before);
    }
    // The other order: the ambiguous terminal first, the adapter's late one dropped.
    const { sink, calls } = makeSink();
    const handle = await begun(sink);
    await sink.ambiguous(handle, { cause: "quit" });
    await sink.fail(handle, new Error("late"));
    await sink.complete(handle, COMPLETION);
    expect(
      calls.filter((call) => types(call).includes("execution.failed")),
    ).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });

  it("two terminals raced in the same tick: the first claim wins", async () => {
    const { sink, calls } = makeSink();
    const handle = await begun(sink);
    await Promise.all([
      sink.ambiguous(handle, { cause: "restricted" }),
      sink.complete(handle, COMPLETION),
    ]);
    const terminals = calls
      .slice(2)
      .flatMap((call) => call.events)
      .filter((event) =>
        /^execution\.(succeeded|failed|cancelled)$/u.test(event.eventType),
      );
    expect(terminals.map((event) => event.eventType)).toEqual([
      "execution.failed",
    ]);
  });

  it("after a terminal nothing is dispatched (a forced abort before the send)", async () => {
    const { sink, calls } = makeSink();
    const handle = await sink.begin(request());
    await sink.ambiguous(handle, { cause: "sender-gone" });
    const written = calls.length;
    await expect(sink.dispatched(handle)).rejects.toThrow(
      "AGENT_AUDIT_TERMINAL_ALREADY_WRITTEN",
    );
    expect(calls).toHaveLength(written);
  });

  it("each execution has its own terminal", async () => {
    const { sink, calls } = makeSink();
    const a = await begun(sink);
    const b = await begun(sink);
    await sink.complete(a, COMPLETION);
    await sink.ambiguous(b, { cause: "quit" });
    const terminalCount = calls
      .flatMap((call) => call.events)
      .filter((event) =>
        ["execution.succeeded", "execution.failed"].includes(event.eventType),
      ).length;
    expect(terminalCount).toBe(2);
  });

  it("a terminal whose append failed releases the claim so one more can be tried", async () => {
    let failing = false;
    const { sink, calls } = makeSink(() => {
      if (failing) throw new Error("storage down");
    });
    const handle = await begun(sink);
    failing = true;
    await expect(sink.complete(handle, COMPLETION)).rejects.toThrow(
      "storage down",
    );
    failing = false;
    await sink.ambiguous(handle, { cause: "unknown" });
    const lastTypes = types(calls.at(-1)!);
    expect(lastTypes).toEqual(["execution.failed"]);
  });
});

describe("the ambiguous terminal (DR-MP3-10)", () => {
  it("is the failed row with the four marks, not a new event type", async () => {
    const { sink, calls } = makeSink();
    const handle = await begun(sink);
    await sink.ambiguous(handle, { cause: "workspace-switch" });
    const last = calls.at(-1)!;
    expect(types(last)).toEqual(["execution.failed"]);
    const payload = last.events[0].payload;
    expect(payload).toMatchObject({
      remoteOutcome: "unknown",
      conservative: true,
      captureState: "partial",
      responseObserved: false,
    });
    expect(payload.error).toMatchObject({
      name: "AgentTurnAmbiguousOutcome",
      message: expect.stringContaining("workspace-switch"),
    });
    expect(Object.keys(payload).at(-1)).toBe("appVersion");
    expect(last.events[0]).toMatchObject({
      executionId: handle.executionId,
      pathId: "chat_agent_main",
      parentExecutionId: null,
    });
  });

  it("a cancel the user asked for is the cancelled row with the same marks", async () => {
    const { sink, calls } = makeSink();
    const handle = await begun(sink);
    await sink.ambiguous(handle, { cause: "unknown", kind: "cancelled" });
    const last = calls.at(-1)!;
    expect(types(last)).toEqual(["execution.cancelled"]);
    expect(last.events[0].payload).toMatchObject({
      remoteOutcome: "unknown",
      conservative: true,
      captureState: "partial",
      responseObserved: false,
    });
  });

  it("carries no capability or request body, and the mark is not on the other rows", async () => {
    const { sink, calls } = makeSink();
    const handle = await begun(sink);
    await sink.ambiguous(handle, { cause: "restricted" });
    const all = calls.flatMap((call) => call.events);
    const marked = all.filter((event) => "remoteOutcome" in event.payload);
    expect(marked).toHaveLength(1);
    expect(JSON.stringify(marked[0])).not.toContain("Continue the scene");
  });
});
