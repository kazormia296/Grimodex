// MP-3c (DR-MP3-4, -5, -6, -7, -10, -11, -12, -13): Main's turn owner. The
// runtime here is a stand-in that makes the adapter's calls in the adapter's
// order (begin, dispatched, send, complete or fail) against Main's real audit
// sink; the real Agent and the third bundle are in `mastra/agentRuntime.bundle.test.ts`.
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiAuditEventInput } from "../shared/aiAuditEvents.js";
import { nativeSqlPolicyV2 } from "./d2aSqlPolicyFixture.js";
import {
  consumeProfileActivation,
  createProfileEgressGate,
} from "./profileEgress.js";
import type { NapiBackendLike } from "../shared/ipcContract.js";
import type {
  MastraAgentTurnStartRequest,
  MastraAgentTurnStartResult,
} from "../shared/mastraAgentTurnWire.js";
import { AgentModelError } from "./mastra/agentModelPolicy.js";
import type {
  MastraAgentRuntimeModule,
  MastraAgentTurnInput,
} from "./mastra/agentRuntime.js";
import type { AgentAuditRequest, AgentWireArgs } from "./mastra/agentWire.js";
import {
  createMastraTurnOwner,
  MASTRA_TURN_FORCED_BOUND_MS,
  MASTRA_TURN_PER_SENDER_MAX,
  MASTRA_TURN_QUIT_BOUND_MS,
  MASTRA_TURN_TOTAL_MAX,
  type MastraTurnInvokeContext,
  type MastraTurnOwner,
  type MastraTurnOwnerOptions,
} from "./mastraTurnOwner.js";

const WORKSPACE = "/work/old";
const TURN_A = "00000000-0000-4000-8000-00000000000a";
const RESPONSE = {
  blocks: [{ type: "text", content: "ok" }],
  stopReason: "end_turn",
};

class FakeSender extends EventEmitter {
  destroyed = false;
  constructor(readonly id: number) {
    super();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

class FakeWindow extends EventEmitter {
  destroyed = false;
  readonly webContents = {};
  constructor(readonly id: number) {
    super();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

function startRequest(
  turnId: string,
  extra: Partial<MastraAgentTurnStartRequest> = {},
): MastraAgentTurnStartRequest {
  return {
    turnId,
    chatSessionId: `session-${turnId}`,
    messages: [
      { role: "system", content: "You write." },
      { role: "user", content: "Continue." },
    ],
    route: {
      provider: "anthropic",
      model: "claude-x",
      endpointId: null,
      apiVariant: null,
      expectedOllamaEndpoint: null,
      thinking: null,
      effort: null,
      reasoningEnabled: null,
      reasoningEffort: null,
      webSearch: null,
    },
    systemCacheSegments: null,
    systemVolatileTail: null,
    tools: [],
    ...extra,
  };
}

let nextTurn = 0;
const uuid = (): string =>
  `00000000-0000-4000-8000-${String(100 + nextTurn++).padStart(12, "0")}`;

interface Harness {
  readonly owner: MastraTurnOwner;
  readonly appended: {
    path: string;
    projectId: string | null;
    events: AiAuditEventInput[];
  }[];
  readonly sends: { args: AgentWireArgs; settings: unknown; apiKey: string }[];
  /** Resolves the oldest pending Native send. */
  nativeSends: Deferred<string>[];
  readonly loads: { count: number };
  readonly issued: Set<unknown>;
  readonly profile: {
    restricted: boolean;
    unavailable: boolean;
    activating: boolean;
  };
  readonly logs: string[];
  appendBehavior: { fail: boolean; hang: Deferred<void> | null };
  newContext(senderId?: number): {
    context: MastraTurnInvokeContext;
    sender: FakeSender;
    win: FakeWindow;
    identity: Record<string, unknown>;
  };
  terminalsOf(executionId?: string): AiAuditEventInput[];
  types(): string[];
}

/**
 * A runtime that calls the sink and the send as the adapter does. `native`
 * decides what Native does: `"hold"` keeps the send pending until the test
 * settles `nativeSends[n]`.
 */
function harness(
  overrides: Partial<MastraTurnOwnerOptions> & {
    native?: "hold" | "immediate";
    loadFails?: boolean;
  } = {},
): Harness {
  const appended: Harness["appended"] = [];
  const sends: Harness["sends"] = [];
  const nativeSends: Deferred<string>[] = [];
  const loads = { count: 0 };
  const issued = new Set<unknown>();
  const logs: string[] = [];
  const profile = { restricted: false, unavailable: false, activating: false };
  const appendBehavior: Harness["appendBehavior"] = { fail: false, hang: null };
  const native = overrides.native ?? "immediate";
  let loadFailuresLeft = overrides.loadFails ? 1 : 0;

  const backend = {
    async aiAuditAppendBatch(
      path: string,
      projectId: string | null,
      events: unknown,
    ): Promise<string> {
      if (appendBehavior.hang) await appendBehavior.hang.promise;
      if (appendBehavior.fail) throw new Error("append failed");
      appended.push({ path, projectId, events: events as AiAuditEventInput[] });
      return JSON.stringify({ insertedCount: 1 });
    },
    async getAiSettings(): Promise<string> {
      return JSON.stringify({ provider: "anthropic" });
    },
    async sendAgentMessage(
      args: unknown,
      settings: unknown,
      apiKey: string,
    ): Promise<string> {
      sends.push({ args: args as AgentWireArgs, settings, apiKey });
      if (native === "immediate") return JSON.stringify(RESPONSE);
      const hold = deferred<string>();
      nativeSends.push(hold);
      return hold.promise;
    },
  } as unknown as NapiBackendLike;

  const runtimeModule: MastraAgentRuntimeModule = {
    createMastraAgentRuntime: () => ({
      async runTurn(input: MastraAgentTurnInput) {
        const request = {
          messages: [
            { role: "system", content: input.instructions },
            ...input.messages,
          ],
          tools: [],
          ...input.route,
          systemCacheSegments: input.systemCacheSegments,
          systemVolatileTail: input.systemVolatileTail,
        } as unknown as AgentAuditRequest;
        const handle = await input.audit.begin(request);
        let raw;
        try {
          await input.audit.dispatched(handle);
          raw = await input.send(
            { ...request, auditContext: handle.auditContext } as AgentWireArgs,
            { signal: input.signal },
          );
        } catch (error) {
          await input.audit.fail(handle, error);
          throw error instanceof AgentModelError
            ? error
            : new AgentModelError("send-failed", "send failed", error);
        }
        await input.audit.complete(handle, {
          response: raw,
          usage: {
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            cost: null,
            stopReason: raw.stopReason,
          },
        });
      },
    }),
  };

  const owner = createMastraTurnOwner({
    open: true,
    backend,
    secrets: { resolveApiKeyForRequest: () => "key-1" },
    profile: {
      get restricted() {
        return profile.restricted;
      },
      get unavailable() {
        return profile.unavailable;
      },
      get activating() {
        return profile.activating;
      },
      isIssuedCallerIdentity: (identity) => issued.has(identity),
    },
    loadRuntime: async () => {
      loads.count += 1;
      if (loadFailuresLeft > 0) {
        loadFailuresLeft -= 1;
        throw new Error("MASTRA_LOAD_FAILED");
      }
      return runtimeModule;
    },
    appVersion: "0.0.0-test",
    log: (_level, message) => logs.push(message),
    randomUUID: uuid,
    ...overrides,
  });

  let senderSeq = 1;
  return {
    owner,
    appended,
    sends,
    nativeSends,
    loads,
    issued,
    profile,
    logs,
    appendBehavior,
    newContext(senderId = senderSeq++) {
      const sender = new FakeSender(senderId);
      const win = new FakeWindow(senderId + 1000);
      const identity = { senderId, workspaceId: WORKSPACE };
      issued.add(identity);
      return {
        context: { sender, win, callerIdentity: identity },
        sender,
        win,
        identity,
      };
    },
    terminalsOf(executionId) {
      return appended
        .flatMap((call) => call.events)
        .filter(
          (event) =>
            (event.eventType === "execution.failed" ||
              event.eventType === "execution.cancelled" ||
              event.eventType === "execution.succeeded") &&
            (executionId === undefined || event.executionId === executionId),
        );
    },
    types() {
      return appended.flatMap((call) =>
        call.events.map((event) => event.eventType),
      );
    },
  };
}

const completed = (
  value: unknown,
): MastraAgentTurnStartResult & {
  status: "completed";
} => {
  const result = value as MastraAgentTurnStartResult;
  expect(result.status).toBe("completed");
  return result as MastraAgentTurnStartResult & { status: "completed" };
};

const refusalReason = (value: unknown): string => {
  const result = value as { status: string; reason?: string };
  expect(result.status).toBe("refused");
  return result.reason ?? "";
};

beforeEach(() => {
  nextTurn = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("start: the turn's route and result", () => {
  it("runs one turn: audit rows in order, the raw response and Main's execution ID come back, settings and key are resolved for the send", async () => {
    const h = harness();
    const { context, identity } = h.newContext();
    const result = completed(
      await h.owner.start(context, startRequest(TURN_A)),
    );
    expect(result.turnId).toBe(TURN_A);
    expect(result.response).toEqual(RESPONSE);
    expect(h.types()).toEqual([
      "execution.started",
      "request.prepared",
      "request.dispatched",
      "response.completed",
      "execution.succeeded",
    ]);
    // Rows are written to the issued identity's workspace, in the workspace chain.
    expect(h.appended.every((call) => call.path === identity.workspaceId)).toBe(
      true,
    );
    expect(h.appended.every((call) => call.projectId === null)).toBe(true);
    // The result's execution ID is the one of the rows.
    expect(h.terminalsOf()[0]?.executionId).toBe(result.executionId);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]?.apiKey).toBe("key-1");
    expect(h.sends[0]?.settings).toEqual({ provider: "anthropic" });
    // Native does not get the caller identity (a legacy permit); the audit context is Main's.
    expect(h.sends[0]?.args).not.toHaveProperty("callerIdentity");
    expect(h.sends[0]?.args.auditContext).toMatchObject({
      expectedWorkspacePath: WORKSPACE,
      projectId: null,
      pathId: "chat_agent_main",
      parentExecutionId: null,
      executionId: result.executionId,
    });
    expect(h.owner.activeTurnCount()).toBe(0);
    expect(h.owner.slotsInUse()).toBe(0);
  });

  it("loads the runtime once for many turns, and a failed load is not cached (no rows; the next start tries again)", async () => {
    const h = harness({ loadFails: true });
    const { context } = h.newContext();
    await expect(h.owner.start(context, startRequest(TURN_A))).rejects.toThrow(
      /MASTRA_LOAD_FAILED/,
    );
    expect(h.appended).toHaveLength(0);
    expect(h.owner.slotsInUse()).toBe(0);
    completed(await h.owner.start(context, startRequest(uuid())));
    completed(await h.owner.start(context, startRequest(uuid())));
    expect(h.loads.count).toBe(2);
  });

  it("a closed gate loads nothing and writes nothing", async () => {
    const h = harness({ open: false });
    const { context } = h.newContext();
    expect(
      refusalReason(await h.owner.start(context, startRequest(TURN_A))),
    ).toBe("gate-closed");
    expect(h.loads.count).toBe(0);
    expect(h.appended).toHaveLength(0);
  });

  it("a provider failure ends the turn with one failed terminal (no ambiguous mark), the cause's message, and no second send", async () => {
    const h = harness({ native: "hold" });
    const { context } = h.newContext();
    const started = h.owner.start(context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    h.nativeSends[0]!.reject(new Error("provider 500"));
    await expect(started).rejects.toThrow("provider 500");
    expect(h.sends).toHaveLength(1);
    expect(h.types().filter((t) => t === "execution.failed")).toHaveLength(1);
    expect(h.terminalsOf()[0]?.payload).not.toHaveProperty("remoteOutcome");
    expect(h.owner.slotsInUse()).toBe(0);
  });

  it("refuses what it cannot run as it is, and does not reassemble the messages", async () => {
    const h = harness();
    const { context } = h.newContext();
    const cases: [string, Partial<MastraAgentTurnStartRequest>][] = [
      ["no system first", { messages: [{ role: "user", content: "hi" }] }],
      [
        "a later system",
        {
          messages: [
            { role: "system", content: "a" },
            { role: "user", content: "b" },
            { role: "system", content: "c" },
            { role: "user", content: "d" },
          ],
        },
      ],
      [
        "the last is not the user's",
        {
          messages: [
            { role: "system", content: "a" },
            { role: "user", content: "b" },
            { role: "assistant", content: "c" },
          ],
        },
      ],
      ["system only", { messages: [{ role: "system", content: "a" }] }],
    ];
    for (const [label, extra] of cases) {
      expect(
        refusalReason(
          await h.owner.start(context, startRequest(uuid(), extra)),
        ),
        label,
      ).toBe("unsupported");
    }
    expect(h.loads.count).toBe(0);
    expect(h.appended).toHaveLength(0);
  });

  it("refuses a sender whose identity is not one Main issued, a destroyed sender and a profile that is closed", async () => {
    const h = harness();
    const { context, identity } = h.newContext();
    h.issued.delete(identity);
    expect(
      refusalReason(await h.owner.start(context, startRequest(uuid()))),
    ).toBe("sender-refused");
    const second = h.newContext();
    second.sender.destroyed = true;
    expect(
      refusalReason(await h.owner.start(second.context, startRequest(uuid()))),
    ).toBe("sender-refused");
    const third = h.newContext();
    h.profile.restricted = true;
    expect(
      refusalReason(await h.owner.start(third.context, startRequest(uuid()))),
    ).toBe("restricted");
    expect(h.loads.count).toBe(0);
  });

  it("a workspace path that is not on the identity is not run (the audit needs it)", async () => {
    const h = harness();
    const { context, identity } = h.newContext();
    identity.workspaceId = null;
    expect(
      refusalReason(await h.owner.start(context, startRequest(uuid()))),
    ).toBe("unsupported");
  });
});

describe("re-entry and limits (DR-MP3-4)", () => {
  it("one turn per sender and chat session: a second is `busy`; another session of the same sender runs", async () => {
    const h = harness({ native: "hold" });
    const { context } = h.newContext();
    const first = h.owner.start(
      context,
      startRequest(TURN_A, { chatSessionId: "s1" }),
    );
    first.catch(() => undefined);
    await flush();
    expect(
      refusalReason(
        await h.owner.start(
          context,
          startRequest(uuid(), { chatSessionId: "s1" }),
        ),
      ),
    ).toBe("busy");
    // The same turn ID is not accepted twice either.
    expect(
      refusalReason(
        await h.owner.start(
          context,
          startRequest(TURN_A, { chatSessionId: "s2" }),
        ),
      ),
    ).toBe("busy");
    const other = h.owner.start(
      context,
      startRequest(uuid(), { chatSessionId: "s2" }),
    );
    other.catch(() => undefined);
    await flush();
    expect(h.owner.activeTurnCount()).toBe(2);
    for (const hold of h.nativeSends) hold.resolve(JSON.stringify(RESPONSE));
    completed(await first);
    completed(await other);
    // Free again once finished.
    expect(h.owner.slotsInUse()).toBe(0);
  });

  it(`at most ${MASTRA_TURN_PER_SENDER_MAX} turns per sender and ${MASTRA_TURN_TOTAL_MAX} in all`, async () => {
    const h = harness({ native: "hold" });
    const single = h.newContext();
    const running: Promise<unknown>[] = [];
    for (let i = 0; i < MASTRA_TURN_PER_SENDER_MAX; i += 1) {
      const started = h.owner.start(
        single.context,
        startRequest(uuid(), { chatSessionId: `s${i}` }),
      );
      started.catch(() => undefined);
      running.push(started);
    }
    await flush();
    expect(
      refusalReason(
        await h.owner.start(
          single.context,
          startRequest(uuid(), { chatSessionId: "over" }),
        ),
      ),
    ).toBe("busy");
    // Other senders fill the rest; the total stops the next.
    for (
      let i = 0;
      i < MASTRA_TURN_TOTAL_MAX - MASTRA_TURN_PER_SENDER_MAX;
      i += 1
    ) {
      const other = h.newContext();
      const started = h.owner.start(other.context, startRequest(uuid()));
      started.catch(() => undefined);
      running.push(started);
    }
    await flush();
    expect(h.owner.slotsInUse()).toBe(MASTRA_TURN_TOTAL_MAX);
    const last = h.newContext();
    expect(
      refusalReason(await h.owner.start(last.context, startRequest(uuid()))),
    ).toBe("busy");
    for (const hold of h.nativeSends) hold.resolve(JSON.stringify(RESPONSE));
    await Promise.all(running);
    expect(h.owner.slotsInUse()).toBe(0);
  });
});

describe("user-stop (a cancel; DR-MP3-6)", () => {
  it("before the dispatch: no send, one `execution.cancelled` terminal with no ambiguous mark, and the start ends as cancelled", async () => {
    const h = harness({ native: "hold" });
    const { context } = h.newContext();
    // The append of the begin batch is held so the cancel lands before the dispatch.
    h.appendBehavior.hang = deferred<void>();
    const started = h.owner.start(context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    expect(h.owner.cancel(context, { turnId: TURN_A })).toEqual({
      status: "ok",
      turnId: TURN_A,
      found: true,
    });
    h.appendBehavior.hang.resolve();
    await expect(started).rejects.toThrow(/MASTRA_AGENT_TURN_CANCELLED/);
    expect(h.sends).toHaveLength(0);
    expect(h.types()).toEqual([
      "execution.started",
      "request.prepared",
      "execution.cancelled",
    ]);
    expect(h.terminalsOf()[0]?.payload).not.toHaveProperty("remoteOutcome");
  });

  it("stopped while the runtime loads: no row at all, and the runtime is not run", async () => {
    const gate = deferred<void>();
    const h = harness({
      loadRuntime: async () => {
        await gate.promise;
        return {
          createMastraAgentRuntime: () => ({
            runTurn: () => Promise.reject(new Error("must not run")),
          }),
        };
      },
    });
    const { context } = h.newContext();
    const started = h.owner.start(context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    expect(
      (h.owner.cancel(context, { turnId: TURN_A }) as { found: boolean }).found,
    ).toBe(true);
    gate.resolve();
    await expect(started).rejects.toThrow(/MASTRA_AGENT_TURN_CANCELLED/);
    expect(h.appended).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
  });

  it("after the dispatch the send is not cut: the turn completes normally", async () => {
    const h = harness({ native: "hold" });
    const { context } = h.newContext();
    const started = h.owner.start(context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    expect(h.sends).toHaveLength(1);
    expect(
      (h.owner.cancel(context, { turnId: TURN_A }) as { found: boolean }).found,
    ).toBe(true);
    h.nativeSends[0]!.resolve(JSON.stringify(RESPONSE));
    completed(await started);
    expect(h.types()).toContain("execution.succeeded");
  });

  it("only the sender that started a turn (in its own window) can stop it", async () => {
    const h = harness({ native: "hold" });
    const owner = h.newContext();
    const started = h.owner.start(owner.context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    const stranger = h.newContext();
    expect(
      (
        h.owner.cancel(stranger.context, { turnId: TURN_A }) as {
          found: boolean;
        }
      ).found,
    ).toBe(false);
    expect(
      (
        h.owner.cancel(
          { ...owner.context, win: new FakeWindow(99) },
          { turnId: TURN_A },
        ) as { found: boolean }
      ).found,
    ).toBe(false);
    expect(
      (h.owner.cancel(owner.context, { turnId: uuid() }) as { found: boolean })
        .found,
    ).toBe(false);
    h.nativeSends[0]!.resolve(JSON.stringify(RESPONSE));
    completed(await started);
  });
});

describe("a sender that is gone (DR-MP3-7)", () => {
  for (const [label, trigger] of [
    [
      "destroyed",
      (c: { sender: FakeSender; win: FakeWindow }) =>
        c.sender.emit("destroyed"),
    ],
    [
      "render-process-gone",
      (c: { sender: FakeSender; win: FakeWindow }) =>
        c.sender.emit("render-process-gone"),
    ],
    [
      "a main-frame navigation (a reload)",
      (c: { sender: FakeSender; win: FakeWindow }) =>
        c.sender.emit("did-start-navigation", {
          isMainFrame: true,
          isSameDocument: false,
        }),
    ],
    [
      "the window's closed",
      (c: { sender: FakeSender; win: FakeWindow }) => c.win.emit("closed"),
    ],
  ] as const) {
    it(`${label}: the start settles at once, one ambiguous terminal is written, and the late Native settle is dropped`, async () => {
      const h = harness({ native: "hold" });
      const c = h.newContext();
      const started = h.owner.start(c.context, startRequest(TURN_A));
      const outcome = started.then(
        () => "resolved",
        (error: Error) => error.message,
      );
      await flush();
      trigger(c);
      expect(await outcome).toMatch(/MASTRA_AGENT_TURN_ABORTED: sender-gone/);
      await flush();
      const terminals = h.terminalsOf();
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.payload).toMatchObject({
        remoteOutcome: "unknown",
        conservative: true,
        captureState: "partial",
        responseObserved: false,
      });
      // Native's send was not stopped; the slot is held until it settles.
      expect(h.owner.activeTurnCount()).toBe(0);
      expect(h.owner.slotsInUse()).toBe(1);
      h.nativeSends[0]!.resolve(JSON.stringify(RESPONSE));
      await flush();
      expect(h.terminalsOf()).toHaveLength(1);
      expect(h.types().filter((t) => t === "execution.completed")).toHaveLength(
        0,
      );
      expect(h.owner.slotsInUse()).toBe(0);
      // No listener is left on the sender or the window.
      expect(c.sender.listenerCount("destroyed")).toBe(0);
      expect(c.sender.listenerCount("did-start-navigation")).toBe(0);
      expect(c.win.listenerCount("closed")).toBe(0);
    });
  }

  it("a sub-frame navigation and a same-document change do not end the turn; the listeners go with the turn", async () => {
    const h = harness({ native: "hold" });
    const c = h.newContext();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    c.sender.emit("did-start-navigation", { isMainFrame: false });
    c.sender.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: true,
    });
    await flush();
    expect(h.owner.activeTurnCount()).toBe(1);
    h.nativeSends[0]!.resolve(JSON.stringify(RESPONSE));
    completed(await started);
    expect(c.sender.listenerCount("destroyed")).toBe(0);
    expect(c.sender.listenerCount("render-process-gone")).toBe(0);
    expect(c.sender.listenerCount("did-start-navigation")).toBe(0);
    expect(c.win.listenerCount("closed")).toBe(0);
  });

  it("an identity that is replaced before the send (a workspace or epoch change) stops the send: Native is never called", async () => {
    const h = harness({ native: "hold" });
    const c = h.newContext();
    // Revoke the identity while the settings are being read (the await before the send).
    const owner = h.owner;
    const original = c.context.callerIdentity as object;
    const started = owner.start(c.context, startRequest(TURN_A));
    const outcome = started.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    h.issued.delete(original);
    expect(await outcome).toMatch(
      /MASTRA_AGENT_TURN_ABORTED: workspace-switch/,
    );
    expect(h.sends).toHaveLength(0);
  });
});

describe("restricted: the egress participant (DR-MP3-11)", () => {
  it("closes admission, asks Native to stop what is in Native (reserved), and returns once the terminal is written", async () => {
    const h = harness({ native: "hold" });
    const c = h.newContext();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    const outcome = started.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await flush();
    const abortNativeInFlight = vi.fn(() => true);
    await h.owner.quiesceForProfileEgress({ abortNativeInFlight });
    expect(abortNativeInFlight).toHaveBeenCalledTimes(1);
    expect(h.terminalsOf()).toHaveLength(1);
    expect(h.terminalsOf()[0]?.payload).toMatchObject({
      remoteOutcome: "unknown",
    });
    expect(await outcome).toMatch(/ABORTED: restricted/);
    // One-way: nothing new is admitted.
    expect(
      refusalReason(await h.owner.start(c.context, startRequest(uuid()))),
    ).toBe("restricted");
    // Native's late settle changes nothing.
    h.nativeSends[0]!.resolve(JSON.stringify(RESPONSE));
    await flush();
    expect(h.terminalsOf()).toHaveLength(1);
  });

  it("with no turn it does not touch Native's stop (the launch's stage 5 stays where it is)", async () => {
    const h = harness();
    const abortNativeInFlight = vi.fn(() => true);
    await h.owner.quiesceForProfileEgress({ abortNativeInFlight });
    expect(abortNativeInFlight).not.toHaveBeenCalled();
    expect(h.appended).toHaveLength(0);
  });

  it("a turn that is not yet in Native is aborted without Native's stop", async () => {
    const h = harness({ native: "hold" });
    const c = h.newContext();
    h.appendBehavior.hang = deferred<void>();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    const abortNativeInFlight = vi.fn(() => true);
    const quiesce = h.owner.quiesceForProfileEgress({ abortNativeInFlight });
    h.appendBehavior.hang.resolve();
    await quiesce;
    expect(abortNativeInFlight).not.toHaveBeenCalled();
    expect(h.sends).toHaveLength(0);
    // The begin batch finished first, then the terminal: never start-only.
    expect(h.types()).toEqual([
      "execution.started",
      "request.prepared",
      "execution.failed",
    ]);
  });

  it("a terminal that cannot be written fails the quiesce (the activation fails closed)", async () => {
    const h = harness({ native: "hold" });
    const c = h.newContext();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    h.appendBehavior.fail = true;
    await expect(
      h.owner.quiesceForProfileEgress({ abortNativeInFlight: () => true }),
    ).rejects.toThrow();
  });

  it("the profile gate's own state also stops a send: a turn that began is ended at the send", async () => {
    const h = harness({ native: "hold" });
    const c = h.newContext();
    h.appendBehavior.hang = deferred<void>();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    const outcome = started.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await flush();
    h.profile.activating = true;
    h.appendBehavior.hang.resolve();
    expect(await outcome).toMatch(/ABORTED: restricted/);
    expect(h.sends).toHaveLength(0);
  });
});

describe("workspace switch: the owner's lease (DR-MP3-12)", () => {
  it("aborts, writes the ambiguous terminal to the OLD workspace before it returns, refuses new turns until resume, then reopens", async () => {
    const h = harness({ native: "hold" });
    const c = h.newContext();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    const outcome = started.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await flush();
    const lease = await h.owner.quiesceForWorkspaceSwitch();
    // Nothing start-only is left on the old workspace.
    expect(h.types().filter((t) => t === "execution.started")).toHaveLength(1);
    expect(h.terminalsOf()).toHaveLength(1);
    expect(h.appended.every((call) => call.path === WORKSPACE)).toBe(true);
    expect(await outcome).toMatch(/ABORTED: workspace-switch/);
    expect(
      refusalReason(await h.owner.start(c.context, startRequest(uuid()))),
    ).toBe("busy");
    await lease.resume(true);
    await lease.resume(true);
    const again = h.newContext();
    h.nativeSends.length = 0;
    const next = h.owner.start(again.context, startRequest(uuid()));
    next.catch(() => undefined);
    await flush();
    h.nativeSends.at(-1)?.resolve(JSON.stringify(RESPONSE));
    h.nativeSends[0]?.resolve(JSON.stringify(RESPONSE));
    completed(await next);
  });

  it("with no turn it writes nothing; two switches at once keep admission closed until both resume", async () => {
    const h = harness();
    const first = await h.owner.quiesceForWorkspaceSwitch();
    const second = await h.owner.quiesceForWorkspaceSwitch();
    expect(h.appended).toHaveLength(0);
    const c = h.newContext();
    await first.resume(false);
    expect(
      refusalReason(await h.owner.start(c.context, startRequest(uuid()))),
    ).toBe("busy");
    await second.resume(true);
    completed(await h.owner.start(c.context, startRequest(uuid())));
  });

  it("the wait is bounded: a terminal that never lands does not hold the switch", async () => {
    vi.useFakeTimers();
    const h = harness({
      native: "hold",
      forcedBoundMs: MASTRA_TURN_FORCED_BOUND_MS,
    });
    const c = h.newContext();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    started.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    h.appendBehavior.hang = deferred<void>();
    let leased = false;
    const lease = h.owner.quiesceForWorkspaceSwitch().then((value) => {
      leased = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(MASTRA_TURN_FORCED_BOUND_MS - 1);
    expect(leased).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(leased).toBe(true);
    await (await lease).resume(false);
    expect(
      h.logs.some((m) =>
        /terminals not written within the switch bound/.test(m),
      ),
    ).toBe(true);
    h.appendBehavior.hang.resolve();
  });
});

describe("quit (DR-MP3-13)", () => {
  it("ends the turns with an ambiguous terminal each and is idempotent", async () => {
    const h = harness({ native: "hold" });
    const c = h.newContext();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    const first = h.owner.shutdown();
    const second = h.owner.shutdown();
    expect(second).toBe(first);
    await first;
    expect(h.terminalsOf()).toHaveLength(1);
    await h.owner.shutdown();
    expect(h.terminalsOf()).toHaveLength(1);
    // Nothing is admitted after it.
    expect(
      refusalReason(await h.owner.start(c.context, startRequest(uuid()))),
    ).toBe("unsupported");
  });

  it(`is bounded by T_quit (${MASTRA_TURN_QUIT_BOUND_MS} ms) when the append hangs, and never rejects when it fails`, async () => {
    vi.useFakeTimers();
    const h = harness({
      native: "hold",
      quitBoundMs: MASTRA_TURN_QUIT_BOUND_MS,
    });
    const c = h.newContext();
    const started = h.owner.start(c.context, startRequest(TURN_A));
    started.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    h.appendBehavior.hang = deferred<void>();
    let done = false;
    const quit = h.owner.shutdown().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(MASTRA_TURN_QUIT_BOUND_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await quit;
    expect(done).toBe(true);
    // A start-only row remains (no recovery; the report counts it).
    expect(h.terminalsOf()).toHaveLength(0);
    h.appendBehavior.hang.resolve();

    const failing = harness({ native: "hold" });
    const d = failing.newContext();
    const second = failing.owner.start(d.context, startRequest(TURN_A));
    second.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    failing.appendBehavior.fail = true;
    await expect(failing.owner.shutdown()).resolves.toBeUndefined();
  });

  it("with no turn it returns at once", async () => {
    const h = harness();
    await expect(h.owner.shutdown()).resolves.toBeUndefined();
    expect(h.appended).toHaveLength(0);
  });
});

describe("a replaced workspace binding (the event hook)", () => {
  it("ends only the turns whose identity is no longer issued; other events and unchanged identities are ignored", async () => {
    const h = harness({ native: "hold" });
    const stays = h.newContext();
    const goes = h.newContext();
    const keep = h.owner.start(stays.context, startRequest(uuid()));
    keep.catch(() => undefined);
    const drop = h.owner.start(goes.context, startRequest(uuid()));
    const dropped = drop.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await flush();
    h.owner.handleBackendEvent("workspace:lifecycle-state", {});
    h.owner.handleBackendEvent("some:other", {});
    expect(h.owner.activeTurnCount()).toBe(2);
    h.issued.delete(goes.identity);
    h.owner.handleBackendEvent("some:other", {});
    expect(h.owner.activeTurnCount()).toBe(2);
    h.owner.handleBackendEvent("workspace:opened", { path: "/work/new" });
    expect(await dropped).toMatch(/ABORTED: workspace-switch/);
    expect(h.owner.activeTurnCount()).toBe(1);
    for (const hold of h.nativeSends) hold.resolve(JSON.stringify(RESPONSE));
    await keep;
  });
});

// ---------------------------------------------------------------------------
// The real profile gate: the owner is registered as the product registers it
// (`index.ts`), and a real `beginProfileActivation` runs stages 2 to 7 over it.
// ---------------------------------------------------------------------------

describe("restricted: the real activation (stage 3 of the egress gate)", () => {
  const UNRESTRICTED = {
    profileId: "profile-1",
    callerEpoch: 4,
    restricted: false,
    handlesInvalidated: false,
    inFlightStopped: true,
    sqlPolicy: nativeSqlPolicyV2(),
  };
  const RESTRICTED = {
    ...UNRESTRICTED,
    callerEpoch: 5,
    restricted: true,
    handlesInvalidated: true,
  };

  async function activationRig(options: { participantBoundMs?: number } = {}) {
    const order: string[] = [];
    const native = {
      initializeProfileEgress: async () => JSON.stringify(UNRESTRICTED),
      registerProfileEgressCaller: () => undefined,
      invalidateProfileEgressCallers: () => undefined,
      profileActivationConsume: () => undefined,
      profileActivationCommit: vi.fn(async () => {
        order.push("commit");
        return JSON.stringify(RESTRICTED);
      }),
      profileActivationAbortInFlight: vi.fn(() => {
        order.push("native-abort");
        return true;
      }),
    } as unknown as NapiBackendLike;
    const gate = await createProfileEgressGate(native, options);
    // The workspace the identity will carry (Native's `workspace:opened` event).
    gate.observeBackendEvent?.("workspace:opened", { path: WORKSPACE });
    const h = harness({ native: "hold", profile: gate });
    gate.registerMainEgressParticipant(
      "mastra-turn-owner",
      (context) => h.owner.quiesceForProfileEgress(context),
      () => h.owner.forceStopForProfileEgress(),
    );
    const sender = new FakeSender(7);
    const win = new FakeWindow(70);
    const context: MastraTurnInvokeContext = {
      sender,
      win,
      callerIdentity: gate.issueCallerIdentity(7),
    };
    const activate = () =>
      gate.beginProfileActivation!(
        consumeProfileActivation(native, "grant", 7, 70),
      );
    return { gate, h, context, activate, native, order };
  }

  it("an in-flight turn is stopped inside stage 3: Native's stop is asked once, the terminal is written before Native's commit, and the profile becomes restricted", async () => {
    const { gate, h, context, activate, native, order } = await activationRig();
    const started = h.owner.start(context, startRequest(TURN_A));
    const outcome = started.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await flush();
    expect(h.sends).toHaveLength(1);
    const real = h.appendBehavior;
    // Record the append in the same order list as Native's own calls.
    const appendTypes = () => h.types().length;
    expect(appendTypes()).toBe(3);
    const view = await activate();
    expect(view).toEqual({ state: "restricted" });
    expect(gate.restricted).toBe(true);
    expect(
      (
        native.profileActivationAbortInFlight as unknown as ReturnType<
          typeof vi.fn
        >
      ).mock.calls,
    ).toHaveLength(1);
    expect(order).toEqual(["native-abort", "commit"]);
    // The terminal is durable by the time the activation went on to the commit.
    expect(h.terminalsOf()).toHaveLength(1);
    expect(h.terminalsOf()[0]?.payload).toMatchObject({
      remoteOutcome: "unknown",
    });
    expect(await outcome).toMatch(/ABORTED: restricted/);
    // Native's send (stopped by Native's own cancel in reality) settles late: nothing is added.
    h.nativeSends[0]!.reject(new Error("cancelled by Native"));
    await flush();
    expect(h.terminalsOf()).toHaveLength(1);
    expect(real.fail).toBe(false);
    // Closed for good.
    expect(
      refusalReason(await h.owner.start(context, startRequest(uuid()))),
    ).toBe("restricted");
  });

  it("with no turn the participant asks Native for nothing: stage 5 stays where it was", async () => {
    const { gate, activate, native } = await activationRig();
    expect(await activate()).toEqual({ state: "restricted" });
    expect(gate.restricted).toBe(true);
    expect(
      (
        native.profileActivationAbortInFlight as unknown as ReturnType<
          typeof vi.fn
        >
      ).mock.calls,
    ).toHaveLength(0);
  });

  it("a terminal that cannot be written makes the activation fail closed (participant-failed), and the owner stays closed", async () => {
    const { gate, h, context, activate, native } = await activationRig();
    const started = h.owner.start(context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    h.appendBehavior.fail = true;
    expect(await activate()).toEqual({
      state: "unavailable",
      reason: "participant-failed",
    });
    expect(gate.unavailable).toBe(true);
    expect(
      (native.profileActivationCommit as unknown as ReturnType<typeof vi.fn>)
        .mock.calls,
    ).toHaveLength(0);
    h.appendBehavior.fail = false;
    expect(
      refusalReason(await h.owner.start(context, startRequest(uuid()))),
    ).toBe("restricted");
  });

  it("a terminal that never lands is cut by the gate's bound: unavailable (participant-timeout), the owner is force-stopped", async () => {
    const { gate, h, context, activate } = await activationRig({
      participantBoundMs: 20,
    });
    const started = h.owner.start(context, startRequest(TURN_A));
    started.catch(() => undefined);
    await flush();
    h.appendBehavior.hang = deferred<void>();
    expect(await activate()).toEqual({
      state: "unavailable",
      reason: "participant-timeout",
    });
    expect(gate.unavailable).toBe(true);
    h.appendBehavior.hang.resolve();
  });
});
