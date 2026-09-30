import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  CodexAppEffectiveRequestReceipt,
  CodexRuntimeThreadBinding,
  JsonRpcId,
  StartCodexAppTurnPayload,
} from "../../shared/codexAppProtocol.js";
import { createCodexAppServerManager } from "./manager.js";
import type {
  AdvanceHistoryRevisionRequest,
  RuntimeThreadBindingStore,
} from "./threadBindingStore.js";
import { CodexAppServerTerminationUnconfirmedError } from "./process.js";

const TEST_WORKSPACE = process.cwd();

class FakeProcess {
  readonly writes: Array<Record<string, unknown>> = [];
  startCalls = 0;
  disposeCalls = 0;
  closeCalls = 0;
  emitTurnStartedBeforeResponse = false;
  deferTurnStartResponse = false;
  deferThreadStartResponse = false;
  resumeThreadIdOverride: string | null = null;
  turnResponseIdOverride: string | null = null;
  earlyTurnStartedIdOverride: string | null = null;
  turnStartError: string | null = null;
  modelPages: Array<{
    cursor: string | null;
    response: Record<string, unknown>;
  }> | null = null;
  private readonly deferredTurnStartResponses: Array<() => void> = [];
  private readonly deferredThreadStartResponses: Array<() => void> = [];
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly closeListeners = new Set<(cause?: Error) => void>();
  private readonly errorListeners = new Set<(cause: Error) => void>();
  private threadNumber = 0;
  private turnNumber = 0;
  constructor(
    private readonly threadStartConfigError: boolean | string = false,
  ) {}

  async start(): Promise<void> {
    this.startCalls += 1;
  }
  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }
  close(): void {
    this.closeCalls += 1;
  }

  write(line: string): void {
    const request = JSON.parse(line) as Record<string, unknown>;
    this.writes.push(request);
    if (!Object.hasOwn(request, "id")) return;
    const id = request.id as JsonRpcId;
    const method = request.method;
    let result: unknown = {};
    if (method === "initialize") {
      result = { userAgent: "fake-codex/1" };
    } else if (method === "model/list") {
      const params = request.params as Record<string, unknown> | undefined;
      const cursor = typeof params?.cursor === "string" ? params.cursor : null;
      result = this.modelPages?.find((page) => page.cursor === cursor)
        ?.response ?? { data: [{ id: "gpt-fake", displayName: "Fake GPT" }] };
    } else if (method === "thread/start") {
      const params = request.params as Record<string, unknown>;
      const config = params.config as Record<string, unknown> | undefined;
      if (
        this.threadStartConfigError &&
        config &&
        Object.hasOwn(config, "mcp_servers")
      ) {
        queueMicrotask(() => {
          this.emitData(
            JSON.stringify({
              id,
              error: {
                code: -32602,
                message:
                  typeof this.threadStartConfigError === "string"
                    ? this.threadStartConfigError
                    : "unknown config mcp_servers",
              },
            }) + "\n",
          );
        });
        return;
      }
      this.threadNumber += 1;
      result = { thread: { id: `thread-${this.threadNumber}` } };
    } else if (method === "thread/resume") {
      result = {
        thread: {
          id:
            this.resumeThreadIdOverride ??
            (request.params as Record<string, unknown>).threadId,
        },
      };
    } else if (method === "turn/start") {
      this.turnNumber += 1;
      const turnId = this.turnResponseIdOverride ?? `turn-${this.turnNumber}`;
      result = { turn: { id: turnId } };
      if (this.emitTurnStartedBeforeResponse) {
        const params = request.params as Record<string, unknown>;
        const startedTurnId = this.earlyTurnStartedIdOverride ?? turnId;
        this.emitData(
          JSON.stringify({
            method: "turn/started",
            params: {
              threadId: params.threadId,
              turn: { id: startedTurnId, status: "inProgress", items: [] },
            },
          }) + "\n",
        );
      }
      if (this.turnStartError) {
        queueMicrotask(() => {
          this.emitData(
            JSON.stringify({
              id,
              error: { code: -32000, message: this.turnStartError },
            }) + "\n",
          );
        });
        return;
      }
    }
    const respond = () => this.emitData(JSON.stringify({ id, result }) + "\n");
    if (method === "thread/start" && this.deferThreadStartResponse) {
      this.deferredThreadStartResponses.push(respond);
    } else if (method === "turn/start" && this.deferTurnStartResponse) {
      this.deferredTurnStartResponses.push(respond);
    } else {
      queueMicrotask(respond);
    }
  }

  onData(listener: (chunk: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }
  onClose(listener: (cause?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  onError(listener: (cause: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  emitData(value: string): void {
    for (const listener of this.dataListeners) listener(value);
  }
  emitClose(cause?: Error): void {
    for (const listener of this.closeListeners) listener(cause);
  }
  emitError(cause: Error): void {
    for (const listener of this.errorListeners) listener(cause);
  }
  releaseTurnStartResponses(): void {
    for (const respond of this.deferredTurnStartResponses.splice(0)) respond();
  }
  releaseThreadStartResponses(): void {
    for (const respond of this.deferredThreadStartResponses.splice(0)) {
      respond();
    }
  }
}

class DeferredDisposeProcess extends FakeProcess {
  private readonly disposeCompletion: Promise<void>;
  private rejectDispose!: (cause: Error) => void;

  constructor() {
    super();
    this.disposeCompletion = new Promise((_resolve, reject) => {
      this.rejectDispose = reject;
    });
  }

  override async dispose(): Promise<void> {
    this.disposeCalls += 1;
    await this.disposeCompletion;
  }

  failDispose(cause: Error): void {
    this.rejectDispose(cause);
  }
}

class DeferredStartTerminationProcess extends FakeProcess {
  private readonly startCompletion: Promise<void>;
  private rejectStart!: (cause: Error) => void;

  constructor() {
    super();
    this.startCompletion = new Promise((_resolve, reject) => {
      this.rejectStart = reject;
    });
  }

  override async start(): Promise<void> {
    this.startCalls += 1;
    await this.startCompletion;
  }

  failStart(cause: Error): void {
    this.rejectStart(cause);
  }
}

class FailingStartProcess extends FakeProcess {
  constructor(
    private readonly failure = new Error("Codex CLI executable was not found"),
  ) {
    super();
  }

  override async start(): Promise<void> {
    this.startCalls += 1;
    throw this.failure;
  }
}

function createBindings(): RuntimeThreadBindingStore & {
  rows: Map<string, CodexRuntimeThreadBinding>;
} {
  const rows = new Map<string, CodexRuntimeThreadBinding>();
  const key = (projectId: string, sessionId: string, runtime: string) =>
    `${projectId}/${sessionId}/${runtime}`;
  return {
    rows,
    async get(projectId, sessionId, runtime) {
      return rows.get(key(projectId, sessionId, runtime)) ?? null;
    },
    async upsert(binding) {
      rows.set(
        key(binding.projectId, binding.sessionId, binding.runtime),
        binding,
      );
    },
    async advanceHistoryRevision(request: AdvanceHistoryRevisionRequest) {
      const rowKey = key(request.projectId, request.sessionId, request.runtime);
      const current = rows.get(rowKey);
      if (
        !current ||
        current.externalThreadId !== request.externalThreadId ||
        current.lastTurnId !== request.lastTurnId ||
        current.historyRevision !== request.pendingHistoryRevision
      ) {
        return false;
      }
      rows.set(rowKey, {
        ...current,
        historyRevision: request.nextHistoryRevision,
        updatedAt: request.updatedAt,
      });
      return true;
    },
    async delete(projectId, sessionId, runtime) {
      rows.delete(key(projectId, sessionId, runtime));
    },
  };
}

const input = (revision: string, turnSuffix = revision) => ({
  projectId: "p1",
  sessionId: "s1",
  expectedWorkspacePath: TEST_WORKSPACE,
  grimodexTurnId: `grim-${turnSuffix}`,
  clientUserMessageId: "user-1",
  model: "gpt-fake",
  effort: "medium",
  contextPacket: "latest context",
  bootstrapHistory: "old history",
  historyRevision: revision,
  userMessage: "最新の質問",
});

function auditedInput(
  revision: string,
  turnSuffix = revision,
): StartCodexAppTurnPayload {
  const turn = input(revision, turnSuffix);
  return {
    ...turn,
    auditContext: {
      expectedWorkspacePath: TEST_WORKSPACE,
      projectId: turn.projectId,
      operationId: turn.grimodexTurnId,
      executionId: `execution-${turnSuffix}`,
      parentExecutionId: null,
      pathId: "codex_app_server",
    },
  };
}

function modelAffectingWrites(
  process: FakeProcess,
): Array<Record<string, unknown>> {
  return process.writes.filter((request) =>
    ["thread/start", "thread/resume", "turn/start"].includes(
      String(request.method),
    ),
  );
}

describe("Codex App Server manager", () => {
  it("durably ACKs exact effective requests before each model-affecting RPC", async () => {
    const process = new FakeProcess();
    const observations: CodexAppEffectiveRequestReceipt[] = [];
    const appendAuditObservations = vi.fn(
      async (_context, batch: readonly CodexAppEffectiveRequestReceipt[]) => {
        expect(batch).toHaveLength(1);
        const observation = batch[0];
        observations.push(observation);
        if (observation.rpcMethod === "thread/start") {
          expect(modelAffectingWrites(process)).toEqual([]);
        } else if (observation.rpcMethod === "turn/start") {
          expect(
            process.writes.filter(
              (request) => request.method === "thread/start",
            ),
          ).toHaveLength(1);
          expect(
            process.writes.filter((request) => request.method === "turn/start"),
          ).toHaveLength(0);
        }
      },
    );
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
      getReadOnlyMcpServer: async () => ({
        command: "/opt/grimodex-mcp",
        args: ["--workspace", TEST_WORKSPACE, "--readonly"],
        env: { GRIMODEX_TEST_SECRET: "must-not-enter-audit" },
      }),
      appendAuditObservations,
    });

    await expect(
      manager.startTurn(auditedInput("audit-exact")),
    ).resolves.toMatchObject({
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      reusedThread: false,
    });

    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      rpcMethod: "thread/start",
      provider: "cli",
      model: "gpt-fake",
      effort: null,
      modelVisibleMessages: [
        { role: "developer", content: expect.stringContaining("read-only") },
      ],
      approvalPolicy: "never",
      sandboxMode: "read-only",
      networkAccess: null,
      retryWithoutMcp: false,
      mcpObservation: {
        inheritedThreadConfigurationUnobserved: false,
        configurationIncluded: true,
        serverName: "grimodex",
        command: "/opt/grimodex-mcp",
        args: ["--workspace", TEST_WORKSPACE, "--readonly"],
        mcpServerEnvExcluded: true,
        toolSchemasObserved: false,
      },
    });
    expect(observations[1]).toMatchObject({
      rpcMethod: "turn/start",
      effort: "medium",
      modelVisibleMessages: [
        {
          role: "user",
          content: expect.stringMatching(
            /old history[\s\S]*latest context[\s\S]*最新の質問/,
          ),
        },
      ],
      networkAccess: false,
    });
    expect(JSON.stringify(observations)).not.toContain("must-not-enter-audit");
    expect(appendAuditObservations).toHaveBeenNthCalledWith(
      1,
      auditedInput("audit-exact").auditContext,
      [observations[0]],
    );
    await manager.dispose();
  });

  it("does not dispatch a model-affecting RPC when the audit append ACK rejects", async () => {
    const process = new FakeProcess();
    const appendAuditObservations = vi.fn(async () => {
      throw new Error("ledger append rejected");
    });
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
      appendAuditObservations,
    });

    await expect(
      manager.handlers.codex_app_start_turn({
        ...auditedInput("audit-rejected"),
      }),
    ).resolves.toMatchObject({
      status: "rejected-before-turn",
      message: "ledger append rejected",
    });
    expect(appendAuditObservations).toHaveBeenCalledOnce();
    expect(modelAffectingWrites(process)).toEqual([]);
    await manager.dispose();
  });

  it("ACKs the exact thread/resume receipt before resuming and excludes bootstrap history", async () => {
    const process = new FakeProcess();
    const bindings = createBindings();
    bindings.rows.set("p1/s1/codex-app-server", {
      projectId: "p1",
      sessionId: "s1",
      runtime: "codex-app-server",
      externalThreadId: "thread-existing",
      historyRevision: "resume-revision",
      lastTurnId: "turn-existing",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    let releaseResumeAppend!: () => void;
    let markResumeAppendStarted!: () => void;
    const resumeAppendGate = new Promise<void>((resolve) => {
      releaseResumeAppend = resolve;
    });
    const resumeAppendStarted = new Promise<void>((resolve) => {
      markResumeAppendStarted = resolve;
    });
    const observations: CodexAppEffectiveRequestReceipt[] = [];
    const appendAuditObservations = vi.fn(
      async (_context, batch: readonly CodexAppEffectiveRequestReceipt[]) => {
        const observation = batch[0];
        observations.push(observation);
        if (observation.rpcMethod === "thread/resume") {
          markResumeAppendStarted();
          await resumeAppendGate;
        } else if (observation.rpcMethod === "turn/start") {
          expect(
            process.writes.filter(
              (request) => request.method === "thread/resume",
            ),
          ).toHaveLength(1);
          expect(
            process.writes.filter((request) => request.method === "turn/start"),
          ).toHaveLength(0);
        }
      },
    );
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: bindings,
      getWorkspacePath: async () => TEST_WORKSPACE,
      appendAuditObservations,
    });

    const start = manager.startTurn(auditedInput("resume-revision"));
    await resumeAppendStarted;
    expect(modelAffectingWrites(process)).toEqual([]);
    releaseResumeAppend();
    await expect(start).resolves.toMatchObject({
      codexThreadId: "thread-existing",
      reusedThread: true,
    });

    expect(observations[0]).toMatchObject({
      rpcMethod: "thread/resume",
      effort: null,
      networkAccess: null,
      modelVisibleMessages: [
        { role: "developer", content: expect.stringContaining("read-only") },
      ],
      mcpObservation: expect.objectContaining({
        inheritedThreadConfigurationUnobserved: true,
        configurationIncluded: false,
      }),
    });
    expect(observations[1]).toMatchObject({
      rpcMethod: "turn/start",
      modelVisibleMessages: [
        {
          role: "user",
          content: expect.stringContaining("最新の質問"),
        },
      ],
    });
    expect(observations[1]?.modelVisibleMessages[0]?.content).not.toContain(
      "old history",
    );
    await manager.dispose();
  });

  it("ACKs an MCP-free retry receipt before the second thread/start RPC", async () => {
    const process = new FakeProcess(true);
    let releaseRetryAppend!: () => void;
    let markRetryAppendStarted!: () => void;
    const retryAppendGate = new Promise<void>((resolve) => {
      releaseRetryAppend = resolve;
    });
    const retryAppendStarted = new Promise<void>((resolve) => {
      markRetryAppendStarted = resolve;
    });
    const observations: CodexAppEffectiveRequestReceipt[] = [];
    const appendAuditObservations = vi.fn(
      async (_context, batch: readonly CodexAppEffectiveRequestReceipt[]) => {
        const observation = batch[0];
        observations.push(observation);
        if (
          observation.rpcMethod === "thread/start" &&
          observation.retryWithoutMcp
        ) {
          markRetryAppendStarted();
          await retryAppendGate;
        }
      },
    );
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
      getReadOnlyMcpServer: async () => ({
        command: "/opt/grimodex-mcp",
        args: ["--readonly"],
        env: { GRIMODEX_TEST_SECRET: "retry-secret" },
      }),
      appendAuditObservations,
    });

    const start = manager.startTurn(auditedInput("mcp-audit-retry"));
    await retryAppendStarted;
    expect(
      process.writes.filter((request) => request.method === "thread/start"),
    ).toHaveLength(1);
    expect(
      process.writes.filter((request) => request.method === "turn/start"),
    ).toHaveLength(0);
    const retryReceipt = observations.find(
      (observation) =>
        observation.rpcMethod === "thread/start" && observation.retryWithoutMcp,
    );
    expect(retryReceipt).toMatchObject({
      retryWithoutMcp: true,
      mcpObservation: {
        inheritedThreadConfigurationUnobserved: false,
        configurationIncluded: false,
        serverName: null,
        command: null,
        args: [],
        mcpServerEnvExcluded: true,
        toolSchemasObserved: false,
      },
    });
    expect(JSON.stringify(retryReceipt)).not.toContain("retry-secret");

    releaseRetryAppend();
    await expect(start).resolves.toMatchObject({
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
    });
    expect(
      process.writes.filter((request) => request.method === "thread/start"),
    ).toHaveLength(2);
    await manager.dispose();
  });

  it("rechecks an interrupt after the audit append ACK and dispatches no external turn", async () => {
    const process = new FakeProcess();
    let releaseAppend!: () => void;
    let markAppendStarted!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    const appendAuditObservations = vi.fn(async () => {
      markAppendStarted();
      await appendGate;
    });
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
      appendAuditObservations,
    });
    const start = manager.startTurn(auditedInput("audit-interrupted"));
    await appendStarted;
    expect(modelAffectingWrites(process)).toEqual([]);

    await manager.interruptTurn({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "grim-audit-interrupted",
    });
    releaseAppend();

    await expect(start).rejects.toThrow("interrupted before it started");
    expect(modelAffectingWrites(process)).toEqual([]);
    await manager.dispose();
  });

  it("rechecks workspace authority after the audit append ACK and dispatches no external turn", async () => {
    const process = new FakeProcess();
    let workspace = TEST_WORKSPACE;
    let releaseAppend!: () => void;
    let markAppendStarted!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    const appendAuditObservations = vi.fn(async () => {
      markAppendStarted();
      await appendGate;
    });
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => workspace,
      appendAuditObservations,
    });
    const start = manager.handlers.codex_app_start_turn({
      ...auditedInput("audit-workspace-race"),
    });
    await appendStarted;
    expect(modelAffectingWrites(process)).toEqual([]);

    workspace = tmpdir();
    releaseAppend();

    await expect(start).resolves.toMatchObject({
      status: "rejected-before-turn",
      message: expect.stringContaining("Active workspace changed"),
    });
    expect(modelAffectingWrites(process)).toEqual([]);
    await manager.dispose();
  });

  it("returns a typed IPC result for successful and proven pre-turn outcomes", async () => {
    const successManager = createCodexAppServerManager({
      createProcess: () => new FakeProcess(),
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    await expect(
      successManager.handlers.codex_app_start_turn(input("typed-success")),
    ).resolves.toMatchObject({
      status: "started",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      reusedThread: false,
    });
    await successManager.dispose();

    const preTurnManager = createCodexAppServerManager({
      createProcess: () => new FakeProcess(),
      threadBindings: createBindings(),
      getWorkspacePath: async () => "",
    });
    await expect(
      preTurnManager.handlers.codex_app_start_turn(input("typed-pre-turn")),
    ).resolves.toEqual({
      status: "rejected-before-turn",
      code: "CODEX_APP_SERVER_PRE_TURN",
      message: "Active workspace is unavailable",
    });
    await preTurnManager.dispose();
  });

  it("rejects stale renderer workspace paths before binding or thread mutation", async () => {
    const process = new FakeProcess();
    const bindings = createBindings();
    const getBinding = vi.spyOn(bindings, "get");
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: bindings,
      getWorkspacePath: async () => TEST_WORKSPACE,
    });
    const staleWorkspace = path.dirname(TEST_WORKSPACE);

    await expect(
      manager.handlers.codex_app_start_turn({
        ...input("stale-workspace-start"),
        expectedWorkspacePath: staleWorkspace,
      }),
    ).resolves.toMatchObject({
      status: "rejected-before-turn",
      code: "CODEX_APP_SERVER_WORKSPACE_STALE",
    });
    await expect(
      manager.archiveSessionThread({
        projectId: "p1",
        sessionId: "s1",
        expectedWorkspacePath: staleWorkspace,
      }),
    ).rejects.toThrow("no longer matches");
    await expect(
      manager.setThreadName({
        projectId: "p1",
        sessionId: "s1",
        expectedWorkspacePath: staleWorkspace,
        name: "stale title",
      }),
    ).rejects.toThrow("no longer matches");

    expect(getBinding).not.toHaveBeenCalled();
    expect(process.startCalls).toBe(0);
    expect(process.writes).toEqual([]);
    await manager.dispose();
  });

  it("keeps a lost turn/start response as an unclassified IPC rejection", async () => {
    const process = new FakeProcess();
    process.deferTurnStartResponse = true;
    const bindings = createBindings();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: bindings,
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    const start = manager.handlers.codex_app_start_turn(
      input("ambiguous-response"),
    );
    await vi.waitFor(() =>
      expect(
        process.writes.some((request) => request.method === "turn/start"),
      ).toBe(true),
    );
    process.emitClose(new Error("turn/start response lost"));

    await expect(start).rejects.toThrow("turn/start response lost");
    expect(bindings.rows.get("p1/s1/codex-app-server")).toMatchObject({
      externalThreadId: "thread-1",
      historyRevision: "__grimodex_pending_v1__:grim-ambiguous-response",
      lastTurnId: null,
    });
    await manager.dispose();
  });

  it("initializes once, enforces read-only thread/turn params, and resumes a binding", async () => {
    const process = new FakeProcess();
    const bindings = createBindings();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: bindings,
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    await expect(manager.listModels()).resolves.toEqual([
      { id: "gpt-fake", name: "Fake GPT" },
    ]);
    expect(manager.getStatus().version).toBe("fake-codex/1");
    await expect(manager.startTurn(input("rev-1"))).resolves.toMatchObject({
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      reusedThread: false,
    });

    const initialize = process.writes.filter(
      (item) => item.method === "initialize",
    );
    expect(initialize).toHaveLength(1);
    const threadStart = process.writes.find(
      (item) => item.method === "thread/start",
    );
    expect(threadStart?.params).toMatchObject({
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    const turnStart = process.writes.find(
      (item) => item.method === "turn/start",
    );
    expect(turnStart?.params).toMatchObject({
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      approvalPolicy: "never",
    });
    expect(JSON.stringify(turnStart?.params)).toContain("<grimodex-context");
    expect(JSON.stringify(turnStart?.params)).toContain("old history");

    process.emitData(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", items: [] },
        },
      }) + "\n",
    );
    await expect(
      manager.advanceHistoryRevision({
        projectId: "p1",
        sessionId: "s1",
        grimodexTurnId: "grim-rev-1",
        codexThreadId: "thread-1",
        codexTurnId: "turn-1",
        expectedHistoryRevision: "rev-1",
        nextHistoryRevision: "rev-2",
      }),
    ).resolves.toEqual({ status: "advanced" });
    await expect(
      manager.startTurn(input("rev-2", "rev-1-second")),
    ).resolves.toMatchObject({
      codexThreadId: "thread-1",
      codexTurnId: "turn-2",
      reusedThread: true,
    });
    expect(
      process.writes.filter((item) => item.method === "thread/resume"),
    ).toHaveLength(1);
    expect(
      process.writes.find((item) => item.method === "thread/resume")?.params,
    ).toMatchObject({
      cwd: TEST_WORKSPACE,
      sandbox: "read-only",
      approvalPolicy: "never",
      developerInstructions: expect.stringContaining("read-only"),
    });
    expect(
      process.writes.filter((item) => item.method === "thread/start"),
    ).toHaveLength(1);
    const turnStarts = process.writes.filter(
      (item) => item.method === "turn/start",
    );
    expect(JSON.stringify(turnStarts[1]?.params)).not.toContain("old history");
    await manager.dispose();
  });

  it("starts a fresh thread instead of resuming a completed turn whose revision is not committed", async () => {
    const process = new FakeProcess();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    await manager.startTurn(input("pending-revision", "pending-first"));
    process.emitData(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", items: [] },
        },
      }) + "\n",
    );

    await expect(
      manager.startTurn(input("pending-revision", "pending-second")),
    ).resolves.toMatchObject({
      codexThreadId: "thread-2",
      reusedThread: false,
    });
    expect(
      process.writes.filter((item) => item.method === "thread/resume"),
    ).toHaveLength(0);
    expect(
      process.writes.filter((item) => item.method === "thread/start"),
    ).toHaveLength(2);
    await manager.dispose();
  });

  it("does not resume a completed-but-uncommitted binding after manager restart", async () => {
    const bindings = createBindings();
    const firstProcess = new FakeProcess();
    const firstManager = createCodexAppServerManager({
      createProcess: () => firstProcess,
      threadBindings: bindings,
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    await firstManager.startTurn(
      input("restart-revision", "restart-uncommitted-first"),
    );
    firstProcess.emitData(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", items: [] },
        },
      }) + "\n",
    );
    expect(bindings.rows.get("p1/s1/codex-app-server")?.historyRevision).toBe(
      "__grimodex_pending_v1__:grim-restart-uncommitted-first",
    );
    await firstManager.dispose();

    const secondProcess = new FakeProcess();
    const secondManager = createCodexAppServerManager({
      createProcess: () => secondProcess,
      threadBindings: bindings,
      getWorkspacePath: async () => TEST_WORKSPACE,
    });
    await expect(
      secondManager.startTurn(
        input("restart-revision", "restart-uncommitted-second"),
      ),
    ).resolves.toMatchObject({ reusedThread: false });

    expect(
      secondProcess.writes.filter((item) => item.method === "thread/resume"),
    ).toHaveLength(0);
    expect(
      secondProcess.writes.find((item) => item.method === "thread/archive")
        ?.params,
    ).toEqual({ threadId: "thread-1" });
    expect(
      secondProcess.writes.filter((item) => item.method === "thread/start"),
    ).toHaveLength(1);
    await secondManager.dispose();
  });

  it("keeps legacy committed raw revisions resumable", async () => {
    const process = new FakeProcess();
    const bindings = createBindings();
    bindings.rows.set("p1/s1/codex-app-server", {
      projectId: "p1",
      sessionId: "s1",
      runtime: "codex-app-server",
      externalThreadId: "thread-legacy",
      historyRevision: "legacy-committed-revision",
      lastTurnId: "turn-legacy",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: bindings,
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    await expect(
      manager.startTurn(input("legacy-committed-revision", "legacy-resume")),
    ).resolves.toMatchObject({
      codexThreadId: "thread-legacy",
      reusedThread: true,
    });
    expect(
      process.writes.find((item) => item.method === "thread/resume")?.params,
    ).toMatchObject({ threadId: "thread-legacy" });
    expect(
      process.writes.filter((item) => item.method === "thread/start"),
    ).toHaveLength(0);
    expect(bindings.rows.get("p1/s1/codex-app-server")).toMatchObject({
      externalThreadId: "thread-legacy",
      historyRevision: "__grimodex_pending_v1__:grim-legacy-resume",
      lastTurnId: "turn-1",
    });
    await manager.dispose();
  });

  it("restores a reused committed binding after a definitive turn rejection", async () => {
    const bindings = createBindings();
    const committed: CodexRuntimeThreadBinding = {
      projectId: "p1",
      sessionId: "s1",
      runtime: "codex-app-server",
      externalThreadId: "thread-committed",
      historyRevision: "committed-revision",
      lastTurnId: "turn-committed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    };
    bindings.rows.set("p1/s1/codex-app-server", committed);
    const rejectingProcess = new FakeProcess();
    rejectingProcess.turnStartError = "turn rejected";
    const firstManager = createCodexAppServerManager({
      createProcess: () => rejectingProcess,
      threadBindings: bindings,
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    await expect(
      firstManager.startTurn(
        input("committed-revision", "rejected-resume-first"),
      ),
    ).rejects.toThrow("turn rejected");
    expect(bindings.rows.get("p1/s1/codex-app-server")).toEqual(committed);
    expect(
      rejectingProcess.writes.filter(
        (item) => item.method === "thread/archive",
      ),
    ).toHaveLength(0);
    await firstManager.dispose();

    const retryProcess = new FakeProcess();
    const secondManager = createCodexAppServerManager({
      createProcess: () => retryProcess,
      threadBindings: bindings,
      getWorkspacePath: async () => TEST_WORKSPACE,
    });
    await expect(
      secondManager.startTurn(
        input("committed-revision", "rejected-resume-retry"),
      ),
    ).resolves.toMatchObject({
      codexThreadId: "thread-committed",
      reusedThread: true,
    });
    expect(
      retryProcess.writes.find((item) => item.method === "thread/resume")
        ?.params,
    ).toMatchObject({ threadId: "thread-committed" });
    expect(
      retryProcess.writes.filter((item) => item.method === "thread/start"),
    ).toHaveLength(0);
    await secondManager.dispose();
  });

  it("removes a new pending binding after a definitive turn rejection", async () => {
    const process = new FakeProcess();
    process.turnStartError = "new turn rejected";
    const bindings = createBindings();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: bindings,
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    await expect(
      manager.startTurn(input("new-revision", "rejected-new-thread")),
    ).rejects.toThrow("new turn rejected");
    expect(bindings.rows.size).toBe(0);
    expect(
      process.writes.find((item) => item.method === "thread/archive")?.params,
    ).toEqual({ threadId: "thread-1" });
    await manager.dispose();
  });

  it("keeps remote turn rejection ambiguous after a turn-started notification", async () => {
    const process = new FakeProcess();
    process.emitTurnStartedBeforeResponse = true;
    process.turnStartError = "response rejected after notification";
    const bindings = createBindings();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: bindings,
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    await expect(
      manager.startTurn(input("ambiguous-revision", "ambiguous-rejection")),
    ).rejects.toThrow("response rejected after notification");
    expect(bindings.rows.get("p1/s1/codex-app-server")).toMatchObject({
      historyRevision: "__grimodex_pending_v1__:grim-ambiguous-rejection",
      lastTurnId: "turn-1",
    });
    expect(
      process.writes.find((item) => item.method === "turn/interrupt")?.params,
    ).toMatchObject({ threadId: "thread-1", turnId: "turn-1" });
    await expect(
      manager.interruptTurn({
        projectId: "p1",
        sessionId: "s1",
        grimodexTurnId: "grim-ambiguous-rejection",
      }),
    ).resolves.toBeUndefined();
    await manager.dispose();
  });

  it("serializes starts for the same session and rejects a second active turn", async () => {
    const process = new FakeProcess();
    process.deferTurnStartResponse = true;
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    const first = manager.startTurn(input("same-session", "concurrent-first"));
    await vi.waitFor(() =>
      expect(
        process.writes.filter((item) => item.method === "turn/start"),
      ).toHaveLength(1),
    );
    const second = manager.startTurn(
      input("same-session", "concurrent-second"),
    );
    process.releaseTurnStartResponses();

    await expect(first).resolves.toMatchObject({ codexTurnId: "turn-1" });
    await expect(second).rejects.toThrow(
      "Codex session already has an active turn",
    );
    expect(
      process.writes.filter((item) => item.method === "turn/start"),
    ).toHaveLength(1);
    await manager.dispose();
  });

  it("loads bounded model pages and rejects a repeated cursor", async () => {
    const process = new FakeProcess();
    process.modelPages = [
      {
        cursor: null,
        response: {
          data: [{ id: "gpt-first", displayName: "First" }],
          nextCursor: "page-2",
        },
      },
      {
        cursor: "page-2",
        response: {
          data: [{ id: "gpt-second", displayName: "Second" }],
          nextCursor: null,
        },
      },
    ];
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    await expect(manager.listModels()).resolves.toEqual([
      { id: "gpt-first", name: "First" },
      { id: "gpt-second", name: "Second" },
    ]);
    expect(
      process.writes.filter((item) => item.method === "model/list")[1]?.params,
    ).toEqual({ cursor: "page-2" });

    process.modelPages = [
      {
        cursor: null,
        response: { data: [], nextCursor: "loop" },
      },
      {
        cursor: "loop",
        response: { data: [], nextCursor: "loop" },
      },
    ];
    await expect(manager.listModels()).rejects.toThrow(
      "repeated a model cursor",
    );
    await manager.dispose();
  });

  it("advances a completed turn revision with CAS and reuses it on the next send", async () => {
    const process = new FakeProcess();
    const bindings = createBindings();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: bindings,
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    await manager.startTurn(input("revision-before", "history-first"));
    expect(bindings.rows.get("p1/s1/codex-app-server")).toMatchObject({
      historyRevision: "__grimodex_pending_v1__:grim-history-first",
      lastTurnId: "turn-1",
    });
    const advanceInput = {
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "grim-history-first",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      expectedHistoryRevision: "revision-before",
      nextHistoryRevision: "revision-after",
    };
    await expect(manager.advanceHistoryRevision(advanceInput)).rejects.toThrow(
      "receipt is missing or stale",
    );

    process.emitData(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", items: [] },
        },
      }) + "\n",
    );
    await expect(
      manager.advanceHistoryRevision({
        ...advanceInput,
        codexTurnId: "forged-turn",
      }),
    ).rejects.toThrow("receipt is missing or stale");
    await expect(manager.advanceHistoryRevision(advanceInput)).resolves.toEqual(
      { status: "advanced" },
    );
    await expect(manager.advanceHistoryRevision(advanceInput)).resolves.toEqual(
      { status: "already-advanced" },
    );
    expect(bindings.rows.get("p1/s1/codex-app-server")?.historyRevision).toBe(
      "revision-after",
    );

    await expect(
      manager.startTurn(input("revision-after", "history-second")),
    ).resolves.toMatchObject({
      codexThreadId: "thread-1",
      reusedThread: true,
    });
    expect(
      process.writes.filter((item) => item.method === "thread/start"),
    ).toHaveLength(1);
    expect(
      process.writes.filter((item) => item.method === "thread/resume"),
    ).toHaveLength(1);
    await manager.dispose();
  });

  it("waits for an early completion turn-id update before revision CAS", async () => {
    const process = new FakeProcess();
    process.emitTurnStartedBeforeResponse = true;
    process.deferTurnStartResponse = true;
    const bindings = createBindings();
    const originalUpsert = bindings.upsert.bind(bindings);
    let releaseUpsert!: () => void;
    let markUpsertStarted!: () => void;
    const upsertGate = new Promise<void>((resolve) => {
      releaseUpsert = resolve;
    });
    const upsertStarted = new Promise<void>((resolve) => {
      markUpsertStarted = resolve;
    });
    bindings.upsert = async (binding, expectedWorkspacePath) => {
      if (binding.lastTurnId === null) {
        await originalUpsert(binding, expectedWorkspacePath);
        return;
      }
      markUpsertStarted();
      await upsertGate;
      await originalUpsert(binding, expectedWorkspacePath);
    };
    const advanceSpy = vi.spyOn(bindings, "advanceHistoryRevision");
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: bindings,
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    const start = manager.startTurn(
      input("early-completion-revision", "early-completion"),
    );
    await upsertStarted;
    process.emitData(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", items: [] },
        },
      }) + "\n",
    );
    const advance = manager.advanceHistoryRevision({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "grim-early-completion",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      expectedHistoryRevision: "early-completion-revision",
      nextHistoryRevision: "early-completion-revision-next",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(advanceSpy).not.toHaveBeenCalled();

    releaseUpsert();
    process.releaseTurnStartResponses();
    await expect(start).resolves.toMatchObject({ codexTurnId: "turn-1" });
    await expect(advance).resolves.toEqual({ status: "advanced" });
    expect(advanceSpy).toHaveBeenCalledOnce();
    await manager.dispose();
  });

  it("does not issue a completion receipt for a failed authoritative turn", async () => {
    const process = new FakeProcess();
    const events: Array<Record<string, unknown>> = [];
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
      broadcast: (_channel, payload) =>
        events.push(payload as Record<string, unknown>),
    });
    await manager.startTurn(input("failed-revision", "failed-turn"));

    process.emitData(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "failed",
            error: { message: "model execution failed" },
            items: [],
          },
        },
      }) + "\n",
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "turn-error",
          message: "model execution failed",
          retryable: false,
        }),
      }),
    );
    await expect(
      manager.advanceHistoryRevision({
        projectId: "p1",
        sessionId: "s1",
        grimodexTurnId: "grim-failed-turn",
        codexThreadId: "thread-1",
        codexTurnId: "turn-1",
        expectedHistoryRevision: "failed-revision",
        nextHistoryRevision: "after-failure",
      }),
    ).rejects.toThrow("receipt is missing or stale");
    await manager.dispose();
  });

  it("archives the old thread on history divergence before starting a new one", async () => {
    const process = new FakeProcess();
    const bindings = createBindings();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: bindings,
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    await manager.startTurn(input("rev-1"));
    process.emitData(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", items: [] },
        },
      }) + "\n",
    );
    await manager.startTurn(input("rev-2"));

    expect(
      process.writes.filter((item) => item.method === "thread/archive"),
    ).toHaveLength(1);
    expect(
      process.writes.filter((item) => item.method === "thread/start"),
    ).toHaveLength(2);
    expect(bindings.rows.get("p1/s1/codex-app-server")).toMatchObject({
      historyRevision: "__grimodex_pending_v1__:grim-rev-2",
      lastTurnId: "turn-2",
    });
    await manager.dispose();
  });

  it("injects a read-only MCP sidecar and retries only for an unsupported MCP parameter", async () => {
    const process = new FakeProcess(true);
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
      getReadOnlyMcpServer: async () => ({
        command: "/opt/grimodex-mcp",
        args: ["--workspace", TEST_WORKSPACE, "--project", "p1", "--readonly"],
        env: {},
      }),
    });

    await expect(manager.startTurn(input("rev-mcp"))).resolves.toMatchObject({
      codexThreadId: "thread-1",
    });
    const starts = process.writes.filter(
      (item) => item.method === "thread/start",
    );
    expect(starts).toHaveLength(2);
    expect(starts[0].params).toMatchObject({
      config: {
        mcp_servers: {
          grimodex: {
            command: "/opt/grimodex-mcp",
            args: expect.arrayContaining(["--readonly"]),
          },
        },
      },
    });
    expect(starts[1].params).not.toHaveProperty("config");
    await manager.dispose();
  });

  it("does not retry thread/start when an invalid parameter is unrelated to MCP", async () => {
    const process = new FakeProcess("invalid sandboxPolicy");
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
      getReadOnlyMcpServer: async () => ({
        command: "/opt/grimodex-mcp",
        args: ["--readonly"],
      }),
    });

    await expect(manager.startTurn(input("rev-invalid"))).rejects.toThrow(
      "invalid sandboxPolicy",
    );
    expect(
      process.writes.filter((item) => item.method === "thread/start"),
    ).toHaveLength(1);
    await manager.dispose();
  });

  it("rejects a turn when the active workspace changes while MCP config is resolving", async () => {
    const process = new FakeProcess();
    let workspace = TEST_WORKSPACE;
    const getReadOnlyMcpServer = vi.fn(
      async (_projectId: string, expectedWorkspacePath: string) => {
        expect(expectedWorkspacePath).toBe(TEST_WORKSPACE);
        workspace = tmpdir();
        return null;
      },
    );
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => workspace,
      getReadOnlyMcpServer,
    });

    await expect(manager.startTurn(input("workspace-race"))).rejects.toThrow(
      "Active workspace changed",
    );
    expect(getReadOnlyMcpServer).toHaveBeenCalledOnce();
    expect(process.writes.some((item) => item.method === "thread/start")).toBe(
      false,
    );
    await manager.dispose();
  });

  it("returns an explicit error for approval requests while read-only mode is active", async () => {
    const process = new FakeProcess();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
    });
    await manager.startTurn(input("rev-1"));
    process.emitData(
      JSON.stringify({
        id: 800,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "command-1",
          reason: "write file",
          command: "echo denied",
        },
      }) + "\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const response = process.writes.find((item) => item.id === 800);
    expect(response).toMatchObject({
      id: 800,
      error: { code: -32000 },
    });
    await manager.dispose();
  });

  it("uses persisted approval opt-in and validates workspace paths before surfacing a request", async () => {
    const process = new FakeProcess();
    const events: unknown[] = [];
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
      getAllowApprovals: async () => true,
      broadcast: (_channel, payload) => events.push(payload),
    });
    await manager.startTurn(input("rev-approval"));

    expect(
      process.writes.find((item) => item.method === "thread/start")?.params,
    ).toMatchObject({
      sandbox: "read-only",
      approvalPolicy: "on-request",
    });
    expect(
      process.writes.find((item) => item.method === "turn/start")?.params,
    ).toMatchObject({
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      approvalPolicy: "on-request",
    });

    process.emitData(
      JSON.stringify({
        id: 799,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "another-turn",
          itemId: "command-wrong-turn",
          reason: "must not attach to this turn",
        },
      }) + "\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(process.writes.find((item) => item.id === 799)).toMatchObject({
      id: 799,
      error: { code: -32000 },
    });

    process.emitData(
      JSON.stringify({
        id: 801,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "command-1",
          reason: "read outside the workspace",
          command: "cat /etc/passwd",
          cwd: path.join(TEST_WORKSPACE, "notes"),
          availableDecisions: ["accept", "decline"],
        },
      }) + "\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(process.writes.find((item) => item.id === 801)).toMatchObject({
      error: { code: -32000 },
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({ requestId: 801 }),
      }),
    );

    process.emitData(
      JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "file-1",
            type: "fileChange",
            status: "inProgress",
            changes: [
              {
                path: path.join(TEST_WORKSPACE, "notes/example.txt"),
                kind: { type: "update", move_path: null },
                diff: "+ hello",
              },
            ],
          },
        },
      }) + "\n",
    );
    process.emitData(
      JSON.stringify({
        id: 802,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "file-1",
          reason: "write outside",
          grantRoot: "/tmp/outside.txt",
        },
      }) + "\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(process.writes.find((item) => item.id === 802)).toMatchObject({
      error: { code: -32000 },
    });

    process.emitData(
      JSON.stringify({
        id: 803,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "missing-file",
          reason: "missing details",
        },
      }) + "\n",
    );
    process.emitData(
      JSON.stringify({
        id: 804,
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "question-1",
          questions: [],
        },
      }) + "\n",
    );
    process.emitData(
      JSON.stringify({
        id: 805,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "command-network",
          reason: "network",
          command: "curl https://example.com",
          networkApprovalContext: { host: "example.com" },
        },
      }) + "\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const id of [803, 804, 805]) {
      expect(process.writes.find((item) => item.id === id)).toMatchObject({
        error: { code: -32000 },
      });
    }

    process.emitData(
      JSON.stringify({
        id: 806,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "file-1",
          reason: "update note",
          grantRoot: path.join(TEST_WORKSPACE, "notes"),
          availableDecisions: ["accept", "decline", "acceptForSession"],
        },
      }) + "\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(process.writes.find((item) => item.id === 806)).toMatchObject({
      error: { code: -32000 },
    });

    process.emitData(
      JSON.stringify({
        id: 807,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "file-1",
          reason: "update note",
          availableDecisions: ["accept", "decline"],
        },
      }) + "\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "approval-requested",
          summary: "update note",
          affectedPaths: ["notes/example.txt"],
          diff: "+ hello",
        }),
      }),
    );
    await manager.dispose();
  });

  it("binds turn events, approvals, and interrupts to the initiating renderer", async () => {
    const process = new FakeProcess();
    const targetedEvents: Array<{ ownerId: number; payload: unknown }> = [];
    const broadcast = vi.fn();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
      getAllowApprovals: async () => true,
      broadcast,
      sendToOwner: (ownerId, _channel, payload) =>
        targetedEvents.push({ ownerId, payload }),
    });
    const owner = manager.handlersForOwner(11);
    const other = manager.handlersForOwner(12);

    await owner.codex_app_start_turn(input("owned-turn"));
    expect(broadcast).not.toHaveBeenCalled();
    expect(targetedEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ ownerId: 11 })]),
    );

    process.emitData(
      JSON.stringify({
        id: 698,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          itemId: "missing-turn-id",
        },
      }) + "\n",
    );
    process.emitData(
      JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "owned-file",
            type: "fileChange",
            status: "inProgress",
            changes: [
              {
                path: path.join(TEST_WORKSPACE, "package.json"),
                kind: { type: "update", move_path: null },
                diff: "+ owned",
              },
            ],
          },
        },
      }) + "\n",
    );
    process.emitData(
      JSON.stringify({
        id: 699,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "owned-file",
          availableDecisions: ["accept", "decline"],
        },
      }) + "\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(process.writes.find((item) => item.id === 698)).toMatchObject({
      error: { code: -32000 },
    });
    expect(targetedEvents).toContainEqual(
      expect.objectContaining({
        ownerId: 11,
        payload: expect.objectContaining({
          event: expect.objectContaining({
            type: "approval-requested",
            requestId: 699,
          }),
        }),
      }),
    );

    const responseArgs = {
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "grim-owned-turn",
      requestId: 699,
      decision: "accept",
    };
    await expect(
      other.codex_app_respond_to_request(responseArgs),
    ).rejects.toThrow("authority mismatch");
    await owner.codex_app_respond_to_request(responseArgs);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(process.writes.find((item) => item.id === 699)).toMatchObject({
      result: { decision: "accept" },
    });

    const interruptArgs = {
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "grim-owned-turn",
    };
    await expect(other.codex_app_interrupt_turn(interruptArgs)).rejects.toThrow(
      "authority mismatch",
    );
    await owner.codex_app_interrupt_turn(interruptArgs);
    expect(
      process.writes.filter((item) => item.method === "turn/interrupt"),
    ).toHaveLength(1);
    await manager.dispose();
  });

  it("fails closed when an approval outlives its renderer deadline", async () => {
    const process = new FakeProcess();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
      getAllowApprovals: async () => true,
      approvalTimeoutMs: 5,
    });
    await manager.startTurn(input("approval-timeout"));
    process.emitData(
      JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "timed-file",
            type: "fileChange",
            status: "inProgress",
            changes: [
              {
                path: path.join(TEST_WORKSPACE, "package.json"),
                kind: { type: "update", move_path: null },
                diff: "+ timeout",
              },
            ],
          },
        },
      }) + "\n",
    );
    process.emitData(
      JSON.stringify({
        id: 710,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "timed-file",
          availableDecisions: ["accept", "decline"],
        },
      }) + "\n",
    );

    await vi.waitFor(() =>
      expect(process.writes.find((item) => item.id === 710)).toMatchObject({
        error: { code: -32000, message: expect.stringContaining("timed out") },
      }),
    );
    await expect(
      manager.respondToServerRequest({
        projectId: "p1",
        sessionId: "s1",
        grimodexTurnId: "grim-approval-timeout",
        requestId: 710,
        decision: "accept",
      }),
    ).rejects.toThrow("Unknown Codex server request");
    await manager.dispose();
  });

  it("does not accept a request consumed while path validation is awaiting", async () => {
    const process = new FakeProcess();
    const events: unknown[] = [];
    let deferValidation = false;
    let releaseValidation!: () => void;
    let markValidationStarted!: () => void;
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const validationStarted = new Promise<void>((resolve) => {
      markValidationStarted = resolve;
    });
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => {
        if (deferValidation) {
          markValidationStarted();
          await validationGate;
        }
        return TEST_WORKSPACE;
      },
      getAllowApprovals: async () => true,
      broadcast: (_channel, payload) => events.push(payload),
    });
    await manager.startTurn(input("approval-validation-race"));
    process.emitData(
      JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "racing-file",
            type: "fileChange",
            status: "inProgress",
            changes: [
              {
                path: path.join(TEST_WORKSPACE, "package.json"),
                kind: { type: "update", move_path: null },
                diff: "+ racing",
              },
            ],
          },
        },
      }) + "\n",
    );
    process.emitData(
      JSON.stringify({
        id: 711,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "racing-file",
          availableDecisions: ["accept", "decline"],
        },
      }) + "\n",
    );
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({ requestId: 711 }),
        }),
      ),
    );

    const response = {
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "grim-approval-validation-race",
      requestId: 711,
    };
    deferValidation = true;
    const accept = manager.respondToServerRequest({
      ...response,
      decision: "accept",
    });
    await validationStarted;
    await manager.respondToServerRequest({
      ...response,
      decision: "decline",
    });
    releaseValidation();

    await expect(accept).rejects.toThrow("no longer pending");
    await vi.waitFor(() =>
      expect(process.writes.find((item) => item.id === 711)).toMatchObject({
        result: { decision: "decline" },
      }),
    );
    await manager.dispose();
  });

  it("terminates an owned turn when its renderer is destroyed", async () => {
    const process = new FakeProcess();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
      sendToOwner: vi.fn(),
    });
    await manager.startTurn(input("owner-destroyed"), 41);

    await manager.handleOwnerDestroyed(41);

    expect(process.disposeCalls).toBeGreaterThan(0);
    await expect(
      manager.interruptTurn(
        {
          projectId: "p1",
          sessionId: "s1",
          grimodexTurnId: "grim-owner-destroyed",
        },
        41,
      ),
    ).rejects.toThrow("not active");
    await manager.dispose();
  });

  it("rejects file moves and symlinked paths that resolve outside the workspace", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "grimodex-approval-"));
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    mkdirSync(workspace);
    mkdirSync(outside);
    symlinkSync(outside, path.join(workspace, "linked-outside"), "dir");
    const process = new FakeProcess();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => workspace,
      getAllowApprovals: async () => true,
    });

    try {
      await manager.startTurn({
        ...input("rev-path-escape"),
        expectedWorkspacePath: workspace,
      });
      for (const [itemId, change] of [
        [
          "move-outside",
          {
            path: path.join(workspace, "source.txt"),
            kind: {
              type: "update",
              move_path: path.join(outside, "moved.txt"),
            },
            diff: "+ moved",
          },
        ],
        [
          "symlink-outside",
          {
            path: path.join(workspace, "linked-outside/escaped.txt"),
            kind: { type: "update", move_path: null },
            diff: "+ escaped",
          },
        ],
      ] as const) {
        process.emitData(
          JSON.stringify({
            method: "item/started",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: {
                id: itemId,
                type: "fileChange",
                status: "inProgress",
                changes: [change],
              },
            },
          }) + "\n",
        );
      }
      for (const [id, itemId] of [
        [901, "move-outside"],
        [902, "symlink-outside"],
      ] as const) {
        process.emitData(
          JSON.stringify({
            id,
            method: "item/fileChange/requestApproval",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId,
              reason: "unsafe path",
            },
          }) + "\n",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const id of [901, 902]) {
        expect(process.writes.find((item) => item.id === id)).toMatchObject({
          error: { code: -32000 },
        });
      }
    } finally {
      await manager.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("revalidates file paths when an approval is accepted", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "grimodex-approval-race-"));
    const canonicalWorkspace = path.join(root, "workspace-real");
    const workspace = path.join(root, "workspace");
    const inside = path.join(canonicalWorkspace, "inside");
    const outside = path.join(root, "outside");
    mkdirSync(canonicalWorkspace);
    mkdirSync(inside);
    mkdirSync(outside);
    symlinkSync(canonicalWorkspace, workspace, "dir");
    const linked = path.join(workspace, "linked");
    symlinkSync(inside, linked, "dir");
    const process = new FakeProcess();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => workspace,
      getAllowApprovals: async () => true,
    });

    try {
      await manager.startTurn({
        ...input("approval-race"),
        expectedWorkspacePath: workspace,
      });
      process.emitData(
        JSON.stringify({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "file-race",
              type: "fileChange",
              status: "inProgress",
              changes: [
                {
                  path: path.join(linked, "note.txt"),
                  kind: { type: "update", move_path: null },
                  diff: "+ raced",
                },
              ],
            },
          },
        }) + "\n",
      );
      process.emitData(
        JSON.stringify({
          id: 903,
          method: "item/fileChange/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "file-race",
            availableDecisions: ["accept", "decline"],
          },
        }) + "\n",
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      rmSync(linked);
      symlinkSync(outside, linked, "dir");

      await expect(
        manager.respondToServerRequest({
          projectId: "p1",
          sessionId: "s1",
          grimodexTurnId: "grim-approval-race",
          requestId: 903,
          decision: "accept",
        }),
      ).rejects.toThrow("outside the active workspace");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(process.writes.find((item) => item.id === 903)).toMatchObject({
        error: { code: -32000 },
      });
    } finally {
      await manager.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("correlates an early turn/started event and keeps retryable errors active", async () => {
    const process = new FakeProcess();
    process.emitTurnStartedBeforeResponse = true;
    const events: Array<Record<string, unknown>> = [];
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
      broadcast: (_channel, payload) =>
        events.push(payload as Record<string, unknown>),
    });

    await manager.startTurn(input("early"));
    expect(events).toContainEqual(
      expect.objectContaining({
        codexTurnId: "turn-1",
        event: { type: "turn-started", turnId: "turn-1" },
      }),
    );

    process.emitData(
      JSON.stringify({
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          willRetry: true,
          error: { message: "temporary disconnect" },
        },
      }) + "\n",
    );
    process.emitData(
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "message-1",
          delta: "continued",
        },
      }) + "\n",
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "turn-error",
          retryable: true,
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: { type: "text-delta", delta: "continued" },
      }),
    );
    await manager.dispose();
  });

  it("fails closed when cached file-change details exceed the path limit", async () => {
    const process = new FakeProcess();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
      getAllowApprovals: async () => true,
    });
    await manager.startTurn(input("oversized-file"));

    process.emitData(
      JSON.stringify({
        method: "item/fileChange/patchUpdated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "file-many",
          changes: Array.from({ length: 257 }, (_, index) => ({
            path:
              index === 256
                ? "/tmp/hidden-outside.txt"
                : path.join(TEST_WORKSPACE, `file-${index}.txt`),
            kind: { type: "update", move_path: null },
            diff: "+ value",
          })),
        },
      }) + "\n",
    );
    process.emitData(
      JSON.stringify({
        id: 900,
        method: "item/fileChange/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "file-many",
          reason: "many files",
        },
      }) + "\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(process.writes.find((item) => item.id === 900)).toMatchObject({
      error: { code: -32000 },
    });
    await manager.dispose();
  });

  it("cancels before turn/start and interrupts when cancellation wins its response", async () => {
    let resolveWorkspace!: (workspace: string) => void;
    const firstProcess = new FakeProcess();
    const firstManager = createCodexAppServerManager({
      createProcess: () => firstProcess,
      threadBindings: createBindings(),
      getWorkspacePath: () =>
        new Promise((resolve) => {
          resolveWorkspace = resolve;
        }),
    });
    const cancelledBeforeStart = firstManager.startTurn(input("cancel-early"));
    await vi.waitFor(() => expect(resolveWorkspace).toBeTypeOf("function"));
    await firstManager.interruptTurn({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "grim-cancel-early",
    });
    resolveWorkspace(TEST_WORKSPACE);
    await expect(cancelledBeforeStart).rejects.toThrow(
      "interrupted before it started",
    );
    expect(
      firstProcess.writes.some((item) => item.method === "turn/start"),
    ).toBe(false);
    await firstManager.dispose();

    const secondProcess = new FakeProcess();
    secondProcess.deferTurnStartResponse = true;
    const secondManager = createCodexAppServerManager({
      createProcess: () => secondProcess,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
    });
    const cancelledAfterRequest = secondManager.startTurn(input("cancel-late"));
    await vi.waitFor(() =>
      expect(
        secondProcess.writes.some((item) => item.method === "turn/start"),
      ).toBe(true),
    );
    await secondManager.interruptTurn({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "grim-cancel-late",
    });
    secondProcess.releaseTurnStartResponses();
    await expect(cancelledAfterRequest).resolves.toMatchObject({
      codexTurnId: "turn-1",
    });
    expect(
      secondProcess.writes.filter((item) => item.method === "turn/interrupt"),
    ).toHaveLength(1);
    await secondManager.dispose();
  });

  it("archives a newly-created thread when cancellation wins thread/start", async () => {
    const process = new FakeProcess();
    process.deferThreadStartResponse = true;
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    const starting = manager.startTurn(input("cancel-thread-start"));
    await vi.waitFor(() =>
      expect(
        process.writes.some((item) => item.method === "thread/start"),
      ).toBe(true),
    );
    await manager.interruptTurn({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "grim-cancel-thread-start",
    });
    process.releaseThreadStartResponses();

    await expect(starting).rejects.toThrow("interrupted before it started");
    await vi.waitFor(() =>
      expect(
        process.writes.filter((item) => item.method === "thread/archive"),
      ).toHaveLength(1),
    );
    expect(process.writes.some((item) => item.method === "turn/start")).toBe(
      false,
    );
    await manager.dispose();
  });

  it("rejects binding preflight failures before turn/start", async () => {
    const process = new FakeProcess();
    const bindings = createBindings();
    bindings.upsert = async () => {
      expect(process.writes.some((item) => item.method === "turn/start")).toBe(
        false,
      );
      throw new Error("binding write failed");
    };
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: bindings,
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    await expect(
      manager.handlers.codex_app_start_turn(input("binding-failure")),
    ).resolves.toEqual({
      status: "rejected-before-turn",
      code: "CODEX_APP_SERVER_PRE_TURN",
      message: "binding write failed",
    });
    expect(process.writes.some((item) => item.method === "turn/start")).toBe(
      false,
    );
    await vi.waitFor(() =>
      expect(
        process.writes.filter((item) => item.method === "thread/archive"),
      ).toHaveLength(1),
    );
    await manager.dispose();
  });

  it("rejects conflicting response ids without losing the authoritative active turn", async () => {
    const process = new FakeProcess();
    process.emitTurnStartedBeforeResponse = true;
    process.earlyTurnStartedIdOverride = "turn-authoritative";
    process.turnResponseIdOverride = "turn-conflict";
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    await expect(
      manager.startTurn(input("conflicting-turn-id")),
    ).rejects.toThrow("conflicting turn ids");
    await manager.interruptTurn({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "grim-conflicting-turn-id",
    });
    expect(
      process.writes.find((item) => item.method === "turn/interrupt")?.params,
    ).toMatchObject({ turnId: "turn-authoritative" });
    await manager.dispose();
  });

  it("rejects a mismatched resumed thread id", async () => {
    const process = new FakeProcess();
    process.resumeThreadIdOverride = "thread-other";
    const bindings = createBindings();
    bindings.rows.set("p1/s1/codex-app-server", {
      projectId: "p1",
      sessionId: "s1",
      runtime: "codex-app-server",
      externalThreadId: "thread-bound",
      historyRevision: "resume-revision",
      lastTurnId: "turn-old",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: bindings,
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    await expect(manager.startTurn(input("resume-revision"))).rejects.toThrow(
      "unexpected thread",
    );
    expect(process.writes.some((item) => item.method === "turn/start")).toBe(
      false,
    );
    await manager.dispose();
  });

  it("refuses to archive a session while its Codex turn is active", async () => {
    const process = new FakeProcess();
    const bindings = createBindings();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: bindings,
      getWorkspacePath: async () => TEST_WORKSPACE,
    });
    await manager.startTurn(input("archive-active"));

    await expect(
      manager.archiveSessionThread({
        projectId: "p1",
        sessionId: "s1",
        expectedWorkspacePath: TEST_WORKSPACE,
      }),
    ).rejects.toThrow("while its turn is active");
    process.emitData(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", items: [] },
        },
      }) + "\n",
    );
    await manager.archiveSessionThread({
      projectId: "p1",
      sessionId: "s1",
      expectedWorkspacePath: TEST_WORKSPACE,
    });
    expect(bindings.rows.size).toBe(0);
    await manager.dispose();
  });

  it("terminates active turns before a workspace-open event can swap databases", async () => {
    const process = new FakeProcess();
    const events: unknown[] = [];
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
      broadcast: (_channel, payload) => events.push(payload),
    });
    await manager.startTurn(input("workspace-open"));

    await manager.handleWorkspaceChanged();

    expect(process.disposeCalls).toBeGreaterThan(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "turn-error",
          code: "CODEX_APP_SERVER_CONNECTION_CLOSED",
        }),
      }),
    );
    await expect(
      manager.interruptTurn({
        projectId: "p1",
        sessionId: "s1",
        grimodexTurnId: "grim-workspace-open",
      }),
    ).rejects.toThrow("not active");
    await manager.dispose();
  });

  it("disposes a process when manager shutdown wins async creation", async () => {
    let resolveProcess!: (process: FakeProcess) => void;
    const process = new FakeProcess();
    const manager = createCodexAppServerManager({
      createProcess: () =>
        new Promise((resolve) => {
          resolveProcess = resolve;
        }),
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    const listing = manager.listModels();
    await vi.waitFor(() => expect(resolveProcess).toBeTypeOf("function"));
    const disposing = manager.dispose();
    resolveProcess(process);

    await disposing;
    await expect(listing).rejects.toThrow("manager is disposed");
    expect(process.startCalls).toBe(0);
    expect(process.disposeCalls).toBeGreaterThanOrEqual(1);
  });

  it("quiesces a pending app-server start before the child can start", async () => {
    let resolveProcess!: (process: FakeProcess) => void;
    const process = new FakeProcess();
    const manager = createCodexAppServerManager({
      createProcess: () =>
        new Promise((resolve) => {
          resolveProcess = resolve;
        }),
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    const listing = manager.listModels();
    await vi.waitFor(() => expect(resolveProcess).toBeTypeOf("function"));
    const quiescing = manager.quiesceForProfileEgress();
    resolveProcess(process);

    await quiescing;
    await expect(listing).rejects.toThrow("manager is disposed");
    expect(process.startCalls).toBe(0);
    expect(process.disposeCalls).toBeGreaterThanOrEqual(1);
  });

  it("quiesces an active app-server turn before activation resolves", async () => {
    const process = new FakeProcess();
    const events: unknown[] = [];
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
      broadcast: (_channel, payload) => events.push(payload),
    });
    await manager.startTurn(input("profile-egress-quiesce"));

    await manager.quiesceForProfileEgress();
    expect(process.disposeCalls).toBeGreaterThan(0);
    const eventCount = events.length;
    process.emitData(
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", items: [] },
        },
      }) + "\n",
    );
    expect(events).toHaveLength(eventCount);
  });

  it("quiesces an in-flight turn start before turn/start dispatch", async () => {
    const process = new FakeProcess();
    let resolveMcp!: (value: null) => void;
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
      getReadOnlyMcpServer: async () =>
        new Promise((resolve) => {
          resolveMcp = resolve;
        }),
    });
    const starting = manager.startTurn(input("profile-egress-start"));
    await vi.waitFor(() => expect(resolveMcp).toBeTypeOf("function"));

    let quiesced = false;
    const quiescing = manager.quiesceForProfileEgress().then(() => {
      quiesced = true;
    });
    expect(quiesced).toBe(false);
    resolveMcp(null);
    await expect(starting).rejects.toThrow(/disposed|connection|interrupted/i);
    await quiescing;
    expect(quiesced).toBe(true);
    expect(
      process.writes.some((request) => request.method === "thread/start"),
    ).toBe(false);
    expect(
      process.writes.some((request) => request.method === "turn/start"),
    ).toBe(false);
  });

  it("disposes the ready process after malformed server output", async () => {
    const process = new FakeProcess();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
    });
    await manager.listModels();

    process.emitData("not-json\n");
    await vi.waitFor(() => expect(process.disposeCalls).toBeGreaterThan(0));
    expect(manager.getStatus()).toMatchObject({ state: "failed" });
    await manager.dispose();
  });

  it("awaits an unexpected process teardown and propagates an unconfirmed close", async () => {
    const process = new DeferredDisposeProcess();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
    });
    await manager.listModels();

    process.emitClose(new Error("app-server closed unexpectedly"));
    await vi.waitFor(() => expect(process.disposeCalls).toBe(1));

    let quiesced = false;
    const quiescing = manager.quiesceForProfileEgress().then(() => {
      quiesced = true;
    });
    await Promise.resolve();
    expect(quiesced).toBe(false);

    process.failDispose(new Error("termination unconfirmed"));
    await expect(quiescing).rejects.toThrow("termination unconfirmed");
    expect(quiesced).toBe(false);
  });

  it("does not resolve profile quiescence after a detector termination failure", async () => {
    const process = new DeferredStartTerminationProcess();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
    });
    const listing = manager.listModels();
    await vi.waitFor(() => expect(process.startCalls).toBe(1));

    let quiesced = false;
    const quiescing = manager.quiesceForProfileEgress().then(() => {
      quiesced = true;
    });
    await Promise.resolve();
    expect(quiesced).toBe(false);

    process.failStart(
      new CodexAppServerTerminationUnconfirmedError(
        "Codex CLI detector child termination was not confirmed",
      ),
    );
    await expect(listing).rejects.toThrow(
      "Codex CLI detector child termination was not confirmed",
    );
    await expect(quiescing).rejects.toThrow(
      "Codex CLI detector child termination was not confirmed",
    );
    expect(quiesced).toBe(false);
  });

  it("does not make an ordinary start failure sticky for profile quiescence", async () => {
    const process = new FailingStartProcess();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    await expect(manager.listModels()).rejects.toThrow(
      /executable was not found/,
    );
    await expect(manager.quiesceForProfileEgress()).resolves.toBeUndefined();
  });

  it("does not make a dispose-only detector failure sticky for profile quiescence", async () => {
    const process = new FailingStartProcess(
      new Error("detector dispose failed"),
    );
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => TEST_WORKSPACE,
    });

    await expect(manager.listModels()).rejects.toThrow(
      "detector dispose failed",
    );
    await expect(manager.quiesceForProfileEgress()).resolves.toBeUndefined();
  });
});
