import { describe, expect, it } from "vitest";

import type {
  CodexRuntimeThreadBinding,
  JsonRpcId,
} from "../../shared/codexAppProtocol.js";
import { createCodexAppServerManager } from "./manager.js";
import type { RuntimeThreadBindingStore } from "./threadBindingStore.js";

class FakeProcess {
  readonly writes: Array<Record<string, unknown>> = [];
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly closeListeners = new Set<(cause?: Error) => void>();
  private readonly errorListeners = new Set<(cause: Error) => void>();
  private threadNumber = 0;
  private turnNumber = 0;
  constructor(private readonly rejectMcp = false) {}

  async start(): Promise<void> {}
  async dispose(): Promise<void> {}
  close(): void {}

  write(line: string): void {
    const request = JSON.parse(line) as Record<string, unknown>;
    this.writes.push(request);
    if (!Object.hasOwn(request, "id")) return;
    const id = request.id as JsonRpcId;
    const method = request.method;
    let result: unknown = {};
    if (method === "initialize") {
      result = { serverInfo: { version: "fake-1" } };
    } else if (method === "model/list") {
      result = { models: [{ id: "gpt-fake", name: "Fake GPT" }] };
    } else if (method === "thread/start") {
      if (
        this.rejectMcp &&
        typeof request.params === "object" &&
        request.params !== null &&
        Object.hasOwn(request.params, "mcpServers")
      ) {
        queueMicrotask(() => {
          this.emitData(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: "unknown field mcpServers" },
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
          id: (request.params as Record<string, unknown>).threadId,
        },
      };
    } else if (method === "turn/start") {
      this.turnNumber += 1;
      result = { turn: { id: `turn-${this.turnNumber}` } };
    }
    queueMicrotask(() => {
      this.emitData(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
    });
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
    async delete(projectId, sessionId, runtime) {
      rows.delete(key(projectId, sessionId, runtime));
    },
  };
}

const input = (revision: string) => ({
  projectId: "p1",
  sessionId: "s1",
  grimodexTurnId: `grim-${revision}`,
  clientUserMessageId: "user-1",
  model: "gpt-fake",
  effort: "medium",
  contextPacket: "latest context",
  bootstrapHistory: "old history",
  historyRevision: revision,
  userMessage: "最新の質問",
});

describe("Codex App Server manager", () => {
  it("initializes once, enforces read-only thread/turn params, and resumes a binding", async () => {
    const process = new FakeProcess();
    const bindings = createBindings();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: bindings,
      getWorkspacePath: async () => "/workspace",
    });

    await expect(manager.listModels()).resolves.toEqual([
      { id: "gpt-fake", name: "Fake GPT" },
    ]);
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
    expect(JSON.stringify(turnStart?.params)).toContain("<grimodex-context");
    expect(JSON.stringify(turnStart?.params)).toContain("old history");

    await expect(manager.startTurn(input("rev-1"))).resolves.toMatchObject({
      codexThreadId: "thread-1",
      codexTurnId: "turn-2",
      reusedThread: true,
    });
    expect(
      process.writes.filter((item) => item.method === "thread/resume"),
    ).toHaveLength(1);
    expect(
      process.writes.filter((item) => item.method === "thread/start"),
    ).toHaveLength(1);
    await manager.dispose();
  });

  it("archives the old thread on history divergence before starting a new one", async () => {
    const process = new FakeProcess();
    const bindings = createBindings();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: bindings,
      getWorkspacePath: async () => "/workspace",
    });

    await manager.startTurn(input("rev-1"));
    await manager.startTurn(input("rev-2"));

    expect(
      process.writes.filter((item) => item.method === "thread/archive"),
    ).toHaveLength(1);
    expect(
      process.writes.filter((item) => item.method === "thread/start"),
    ).toHaveLength(2);
    expect(bindings.rows.get("p1/s1/codex-app-server")?.historyRevision).toBe(
      "rev-2",
    );
    await manager.dispose();
  });

  it("injects a read-only MCP sidecar and retries only for an unsupported MCP parameter", async () => {
    const process = new FakeProcess(true);
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => "/workspace",
      getReadOnlyMcpServer: async () => ({
        command: "/opt/grimodex-mcp",
        args: ["--workspace", "/workspace", "--project", "p1", "--readonly"],
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
      mcpServers: {
        grimodex: {
          command: "/opt/grimodex-mcp",
          args: expect.arrayContaining(["--readonly"]),
        },
      },
    });
    expect(starts[1].params).not.toHaveProperty("mcpServers");
    await manager.dispose();
  });

  it("returns an explicit error for approval requests while read-only mode is active", async () => {
    const process = new FakeProcess();
    const manager = createCodexAppServerManager({
      createProcess: () => process,
      threadBindings: createBindings(),
      getWorkspacePath: async () => "/workspace",
    });
    await manager.startTurn(input("rev-1"));
    process.emitData(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 800,
        method: "item/commandApproval",
        params: { turnId: "turn-1", summary: "write file" },
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
      getWorkspacePath: async () => "/workspace",
      getAllowApprovals: async () => true,
      broadcast: (_channel, payload) => events.push(payload),
    });
    await manager.startTurn(input("rev-approval"));

    expect(
      process.writes.find((item) => item.method === "thread/start")?.params,
    ).toMatchObject({
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    });
    expect(
      process.writes.find((item) => item.method === "turn/start")?.params,
    ).toMatchObject({
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    });

    process.emitData(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 799,
        method: "item/commandExecution/requestApproval",
        params: {
          turnId: "another-turn",
          summary: "must not attach to this turn",
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
        jsonrpc: "2.0",
        id: 801,
        method: "item/commandExecution/requestApproval",
        params: {
          turnId: "turn-1",
          summary: "write a note",
          command: ["echo", "hello"],
          affectedPaths: ["notes/example.txt"],
          diff: "+ hello",
        },
      }) + "\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "approval-requested",
          affectedPaths: ["notes/example.txt"],
          command: ["echo", "hello"],
          diff: "+ hello",
        }),
      }),
    );
    await manager.respondToServerRequest({
      projectId: "p1",
      sessionId: "s1",
      grimodexTurnId: "grim-rev-approval",
      requestId: 801,
      decision: "accept",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(process.writes.find((item) => item.id === 801)).toMatchObject({
      result: { decision: "accept" },
    });

    process.emitData(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 802,
        method: "item/fileChange/requestApproval",
        params: { turnId: "turn-1", affectedPaths: ["/tmp/outside.txt"] },
      }) + "\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(process.writes.find((item) => item.id === 802)).toMatchObject({
      error: { code: -32000 },
    });
    await manager.dispose();
  });
});
