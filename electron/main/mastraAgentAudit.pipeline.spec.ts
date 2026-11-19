// MP-3b (DR-MP3-10, -23): the rows of Electron main's agent audit sink, through
// the real Native addon. A fake backend cannot say whether Native accepts what
// the sink writes (the three rows of a dispatch in two batches, an ambiguous
// terminal's payload, the kept path ID), so this spec drives the sink against
// the real audit ledger of a seeded workspace and reads the ledger back.
//
// The real addon is needed, so only `vitest.electron-native.config.ts` runs it.
// It is written without a built addon at hand (3b): run it before relying on it.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";
import { createMainAgentAuditSink } from "./mastra/agentAuditSink.js";
import type { AgentAuditRequest } from "./mastra/agentWire.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
    getPath: () => os.tmpdir(),
    getGPUFeatureStatus: () => ({}),
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    },
    on: vi.fn(),
  },
}));
vi.mock("./windows.js", () => ({
  focusPanelWindow: () => false,
  hasPanelWindow: () => false,
  openPanelWindow: () => undefined,
}));

const ROOT = path.resolve(__dirname, "..", "..");
const ADDON = path.join(
  ROOT,
  "electron",
  "native",
  "grimodex-node",
  "grimodex-node.node",
);
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NativeBackendInstance = NapiBackendLike & Record<string, any>;
const { Backend: NativeBackend } = require(ADDON) as {
  Backend: new (appData: string) => NativeBackendInstance;
};
const backends: NativeBackendInstance[] = [];
const roots: string[] = [];

afterAll(async () => {
  for (const backend of backends) {
    const wire = await backend.shutdownWorkspaceLifecycle!();
    expect(JSON.parse(wire).status).toBe("closed");
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function ok<T>(envelope: Envelope): T {
  if (!envelope.ok) throw new Error(`expected ok, got: ${envelope.error}`);
  return envelope.value as T;
}

interface StoredEvent {
  readonly eventType: string;
  readonly executionId: string;
  readonly pathId: string;
  readonly parentExecutionId: string | null;
  readonly payload: Record<string, unknown>;
}

const REQUEST = {
  messages: [
    { role: "system", content: "You write." },
    { role: "user", content: "Continue the scene." },
  ],
  tools: [],
  thinking: null,
  effort: null,
  reasoningEnabled: null,
  reasoningEffort: null,
  systemCacheSegments: null,
  apiVariant: null,
  webSearch: null,
  systemVolatileTail: null,
  model: "claude-x",
  provider: "anthropic",
  endpointId: null,
  expectedOllamaEndpoint: null,
} as unknown as AgentAuditRequest;

async function seededWorkspace(): Promise<{
  backend: NativeBackendInstance;
  workspacePath: string;
  projectId: string;
}> {
  const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-mp3b-audit-"));
  roots.push(root);
  const appData = path.join(realpathSync(root), "app-data");
  mkdirSync(appData, { recursive: true });
  mocks.handlers.clear();
  const backend = new NativeBackend(appData);
  backends.push(backend);
  const { createProfileEgressGate } = await import("./profileEgress.js");
  const { registerIpcRouter } = await import("./ipc.js");
  const { IPC } = await import("../shared/ipcContract.js");
  const gate = await createProfileEgressGate(backend as NapiBackendLike);
  registerIpcRouter(
    backend as NapiBackendLike,
    {} as never,
    undefined,
    undefined,
    { active: false } as never,
    gate,
  );
  const handler = mocks.handlers.get(IPC.invoke) as (
    event: unknown,
    cmd: unknown,
    args: unknown,
  ) => Promise<Envelope>;
  const event = {
    sender: { id: 7, isDestroyed: () => false, once: () => undefined },
  };
  const route = (cmd: string, args: Record<string, unknown> = {}) =>
    handler(event, cmd, args);
  const seeded = ok<{ path: string; projectId: string }>(
    await route("seed_sample_workspace", {
      language: "ja",
      aiPolicy: '{"preset":"full"}',
    }),
  );
  ok(await route("open_workspace", { path: seeded.path }));
  return {
    backend,
    workspacePath: seeded.path,
    projectId: seeded.projectId,
  };
}

async function ledger(
  backend: NativeBackendInstance,
  workspacePath: string,
  projectId: string,
): Promise<StoredEvent[]> {
  const snapshot = JSON.parse(
    await backend.aiAuditReadSnapshot(
      workspacePath,
      projectId,
      undefined,
      undefined,
      undefined,
    ),
  ) as { events: StoredEvent[] };
  return snapshot.events;
}

describe("the main agent audit sink against the real audit ledger", () => {
  it("Native accepts the begin in two batches, the three terminals and the kept path ID, and the chain verifies", async () => {
    const { backend, workspacePath, projectId } = await seededWorkspace();
    const sink = createMainAgentAuditSink({
      backend,
      appVersion: "0.0.0-test",
      projectId,
      expectedWorkspacePath: workspacePath,
    });

    // 1. a turn that completes
    const completed = await sink.begin(REQUEST);
    await sink.dispatched(completed);
    await sink.complete(completed, {
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
    });
    // 2. a turn the adapter fails
    const failed = await sink.begin(REQUEST);
    await sink.dispatched(failed);
    await sink.fail(failed, new Error("provider said no"));
    // 3. a turn Main closes as ambiguous (a switch, a quit, a gone sender)
    const ambiguous = await sink.begin(REQUEST);
    await sink.dispatched(ambiguous);
    await sink.ambiguous(ambiguous, { cause: "workspace-switch" });
    // The adapter's late terminal for the same execution writes nothing.
    await sink.fail(ambiguous, new Error("late"));

    const events = await ledger(backend, workspacePath, projectId);
    const byExecution = (executionId: string) =>
      events.filter((event) => event.executionId === executionId);
    expect(byExecution(completed.executionId).map((e) => e.eventType)).toEqual([
      "execution.started",
      "request.prepared",
      "request.dispatched",
      "response.completed",
      "execution.succeeded",
    ]);
    expect(byExecution(failed.executionId).map((e) => e.eventType)).toEqual([
      "execution.started",
      "request.prepared",
      "request.dispatched",
      "execution.failed",
    ]);
    const closed = byExecution(ambiguous.executionId);
    expect(closed.map((e) => e.eventType)).toEqual([
      "execution.started",
      "request.prepared",
      "request.dispatched",
      "execution.failed",
    ]);
    // The ambiguous terminal keeps its four marks through the ledger.
    expect(closed.at(-1)!.payload).toMatchObject({
      remoteOutcome: "unknown",
      conservative: true,
      captureState: "partial",
      responseObserved: false,
    });
    // The path ID is the main chat agent's, the parent is null (tool 0).
    for (const event of events.filter((e) => e.pathId === "chat_agent_main")) {
      expect(event.parentExecutionId).toBeNull();
    }
    // 5 + 4 + 4 rows: the adapter's late terminal for the ambiguous one wrote none.
    expect(events.filter((e) => e.pathId === "chat_agent_main")).toHaveLength(
      13,
    );

    const verify = JSON.parse(
      await backend.aiAuditVerify(workspacePath, projectId, undefined),
    ) as { ok: boolean };
    expect(verify.ok).toBe(true);
  });

  it("a begin under another workspace's path is refused by Native and writes nothing", async () => {
    const { backend, workspacePath, projectId } = await seededWorkspace();
    const before = (await ledger(backend, workspacePath, projectId)).length;
    const sink = createMainAgentAuditSink({
      backend,
      appVersion: "0.0.0-test",
      projectId,
      expectedWorkspacePath: path.join(
        workspacePath,
        "..",
        "another-workspace",
      ),
    });
    await expect(sink.begin(REQUEST)).rejects.toThrow();
    expect((await ledger(backend, workspacePath, projectId)).length).toBe(
      before,
    );
  });
});
