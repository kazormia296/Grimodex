import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { NapiBackendLike } from "../shared/ipcContract.js";
import type {
  NapiMemoryBackendLike,
  NapiMemoryVectorBackendLike,
} from "./mastra/napiMemoryBackend.js";
import { NativeMemoryStorage } from "./mastra/nativeMemoryStorage.js";
import { NativeMemoryVector } from "./mastra/nativeMemoryVector.js";
import {
  createAgentLanguageModel,
  grimodexProviderOptions,
} from "./mastra/agentLanguageModel.js";
import {
  createRecordingAudit,
  loadMastraForTest,
} from "./mastra/agentModel.testSupport.js";
import {
  AGENT_CALL_OPTIONS,
  AGENT_NO_RETRY_CONFIG,
} from "./mastra/agentModelPolicy.js";
import type { AgentWireMessage } from "./mastra/agentWire.js";

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
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
    on: vi.fn(),
  },
}));
vi.mock("./windows.js", () => ({
  focusPanelWindow: () => false,
  hasPanelWindow: () => false,
  openPanelWindow: () => undefined,
}));

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "..", "..");
const ADDON = path.join(
  ROOT,
  "electron",
  "native",
  "grimodex-node",
  "grimodex-node.node",
);
type NativeBackendInstance = NapiBackendLike &
  NapiMemoryBackendLike &
  NapiMemoryVectorBackendLike & {
    shutdownWorkspaceLifecycle(): Promise<void>;
  };
const { Backend: NativeBackend } = require(ADDON) as {
  Backend: new (appData: string) => NativeBackendInstance;
};
let backend: NativeBackendInstance | undefined;
let workspaceRoot: string | undefined;

afterEach(async () => {
  if (backend) await backend.shutdownWorkspaceLifecycle!();
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  backend = undefined;
  workspaceRoot = undefined;
});

async function openSampleWorkspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-mp8b-native-"));
  workspaceRoot = root;
  const appData = path.join(realpathSync(root), "app-data");
  mkdirSync(appData, { recursive: true });
  backend = new NativeBackend(appData);
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
    command: unknown,
    args: unknown,
  ) => Promise<{ ok: boolean; value: unknown; error?: string }>;
  const event = {
    sender: { id: 7, isDestroyed: () => false, once: () => undefined },
  };
  const route = async (command: string, args: Record<string, unknown> = {}) => {
    const response = await handler(event, command, args);
    if (!response.ok) throw new Error(response.error);
    return response.value as Record<string, unknown>;
  };
  const seeded = await route("seed_sample_workspace", {
    language: "ja",
    aiPolicy:
      '{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true,"structureWrite":true,"knowledgeWrite":true}}',
  });
  await route("open_workspace", { path: seeded.path });
  return { backend, projectId: seeded.projectId as string };
}

describe("Mastra memory adapters against the real Native addon", () => {
  it("round-trips resource dates and OM, and cascades vector chunks with message deletion", async () => {
    const ws = await openSampleWorkspace();
    const storage = new NativeMemoryStorage(
      ws.backend as unknown as NapiMemoryBackendLike,
      ws.projectId,
    );
    const vector = new NativeMemoryVector(
      ws.backend as unknown as NapiMemoryVectorBackendLike,
      ws.projectId,
    );
    const resourceId = `mp8b-resource-${Date.now()}`;
    const threadId = `mp8b-thread-${Date.now()}`;
    const messageId = `mp8b-message-${Date.now()}`;
    const now = new Date();

    const resource = await storage.saveResource({
      resource: {
        id: resourceId,
        workingMemory: "{}",
        metadata: {},
        createdAt: now,
        updatedAt: now,
      } as never,
    });
    expect(resource.createdAt).toBeInstanceOf(Date);
    expect(resource.updatedAt).toBeInstanceOf(Date);
    const readResource = await storage.getResourceById({ resourceId });
    expect(readResource?.createdAt).toBeInstanceOf(Date);
    expect(readResource?.updatedAt).toBeInstanceOf(Date);

    const threadFilter = { resourceId, metadata: { fixture: "thread-order" } };
    await storage.saveThread({
      thread: {
        id: threadId,
        resourceId,
        title: "MP-8b",
        createdAt: now,
        updatedAt: now,
        metadata: threadFilter.metadata,
      },
    });
    const updatedThreadId = `${threadId}-updated`;
    await storage.saveThread({
      thread: {
        id: updatedThreadId,
        resourceId,
        title: "Updated thread",
        createdAt: new Date(now.getTime() - 60_000),
        updatedAt: new Date(now.getTime() + 60_000),
        metadata: threadFilter.metadata,
      },
    });
    for (const direction of ["ASC", "DESC"] as const) {
      const { threads } = await storage.listThreads({
        filter: threadFilter,
        orderBy: { field: "updatedAt", direction },
      });
      expect(threads.map((thread) => thread.id)).toEqual(
        direction === "ASC"
          ? [threadId, updatedThreadId]
          : [updatedThreadId, threadId],
      );
    }
    await storage.saveMessages({
      messages: [
        {
          id: messageId,
          threadId,
          resourceId,
          role: "user",
          createdAt: now,
          content: { text: "vector body" },
        } as never,
      ],
    });
    await storage.initializeObservationalMemory({
      id: `mp8b-om-${Date.now()}`,
      resourceId,
      createdAt: now,
      updatedAt: now,
      originType: "initial",
      activeObservations: "observed",
      config: {},
      metadata: {},
    } as never);
    const observation = await storage.getObservationalMemory(null, resourceId);
    expect(observation?.activeObservations).toBe("observed");

    await vector.createIndex({ indexName: "memory", dimension: 2 });
    await vector.upsert({
      indexName: "memory",
      ids: ["mp8b-vector"],
      vectors: [[1, 0]],
      metadata: [{ messageId }],
    });
    await expect(
      vector.query({ indexName: "memory", queryVector: [1, 0], topK: 1 }),
    ).resolves.toHaveLength(1);
    await storage.deleteMessages([messageId]);
    await expect(
      vector.query({ indexName: "memory", queryVector: [1, 0], topK: 1 }),
    ).resolves.toEqual([]);
    await vector.deleteIndex({ indexName: "memory" });
  });

  it("characterizes R-2 for one tool round trip against Native message storage", async () => {
    const ws = await openSampleWorkspace();
    const { Agent, createTool, jsonSchema, guard } = await loadMastraForTest();
    onTestFinished(() => guard.restore());
    const { Memory } = await import("@mastra/memory");
    const { MastraCompositeStore } = await import("@mastra/core/storage");
    const storage = new NativeMemoryStorage(ws.backend, ws.projectId);
    const reader = new NativeMemoryStorage(ws.backend, ws.projectId);
    const resourceId = "mp9-fixture-resource";
    const threadId = "mp9-fixture-thread";
    const now = new Date();
    await storage.saveResource({
      resource: { id: resourceId, createdAt: now, updatedAt: now },
    });
    await storage.saveThread({
      thread: {
        id: threadId,
        resourceId,
        title: "R-2",
        createdAt: now,
        updatedAt: now,
      },
    });
    const saves = vi.spyOn(storage, "saveMessages");
    const memory = new Memory({
      storage: new MastraCompositeStore({
        id: "r2",
        domains: { memory: storage },
      }),
      options: { semanticRecall: false, workingMemory: { enabled: false } },
    });
    const readMessages = async () =>
      (await reader.listMessages({ threadId, resourceId, perPage: false }))
        .messages;
    const toolResult = "synthetic tool result";
    const sends: Array<{
      messages: AgentWireMessage[];
      saved: Awaited<ReturnType<typeof readMessages>>;
      saveCount: number;
    }> = [];
    const { model } = createAgentLanguageModel({
      originalTools: [
        {
          name: "probe",
          description: "probe",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
      audit: createRecordingAudit({
        expectedWorkspacePath: "/fixture",
        projectId: ws.projectId,
        operationId: "r2",
        parentExecutionId: null,
        pathId: "r2",
      }),
      send: async ({ messages }) => {
        sends.push({
          messages,
          saved: await readMessages(),
          saveCount: saves.mock.calls.length,
        });
        if (sends.length === 1) {
          return {
            blocks: [
              { type: "tool_use", id: "call-r2", name: "probe", input: {} },
            ],
            stopReason: "tool_use",
          };
        }
        return {
          blocks: [{ type: "text", content: "finished" }],
          stopReason: "end_turn",
        };
      },
    });
    const agent = new Agent({
      id: "r2",
      name: "r2",
      instructions: "system",
      memory,
      model,
      ...AGENT_NO_RETRY_CONFIG,
      tools: {
        probe: createTool({
          id: "probe",
          description: "probe",
          inputSchema: jsonSchema<Record<string, never>>({
            type: "object",
            properties: {},
          }),
          execute: async () => toolResult,
        }),
      },
    });
    const result = await agent.generate("synthetic input", {
      ...AGENT_CALL_OPTIONS,
      maxSteps: 2,
      memory: { thread: threadId, resource: resourceId },
      providerOptions: grimodexProviderOptions({
        route: {
          thinking: null,
          effort: null,
          reasoningEnabled: null,
          reasoningEffort: null,
          apiVariant: null,
          webSearch: null,
          model: "fixture",
          provider: "anthropic",
          endpointId: null,
          expectedOllamaEndpoint: null,
        },
        systemCacheSegments: null,
        systemVolatileTail: null,
      }),
    });
    await memory.settled();
    expect(result.text).toBe("finished");
    expect(sends.map(({ saved, saveCount }) => ({ saved, saveCount }))).toEqual(
      [
        { saved: [], saveCount: 0 },
        { saved: [], saveCount: 0 },
      ],
    );
    expect(sends[1]?.messages).toContainEqual({
      role: "tool_result",
      toolUseId: "call-r2",
      content: toolResult,
      isError: false,
    });
    expect(
      saves.mock.calls.map(([args]) =>
        args.messages.map((message) => message.role),
      ),
    ).toEqual([["user", "assistant"]]);
    const rows = await readMessages();
    const digest = createHash("sha256")
      .update(JSON.stringify(toolResult))
      .digest("hex");
    expect(rows).toMatchObject([
      {
        threadId,
        resourceId,
        role: "user",
        content: { content: "synthetic input" },
      },
      {
        threadId,
        resourceId,
        role: "assistant",
        content: {
          content: "finished",
          parts: expect.arrayContaining([
            expect.objectContaining({
              type: "tool-invocation",
              toolInvocation: {
                state: "result",
                args: {},
                toolCallId: "call-r2",
                toolName: "probe",
                result: `sha256:${digest}`,
              },
            }),
          ]),
        },
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(toolResult);
    expect(guard.external()).toEqual([]);
  });
});
