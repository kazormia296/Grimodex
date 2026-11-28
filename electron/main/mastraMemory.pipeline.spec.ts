import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";
import type { NapiBackendLike } from "../shared/ipcContract.js";
import type {
  NapiMemoryBackendLike,
  NapiMemoryVectorBackendLike,
} from "./mastra/napiMemoryBackend.js";
import { NativeMemoryStorage } from "./mastra/nativeMemoryStorage.js";
import { NativeMemoryVector } from "./mastra/nativeMemoryVector.js";

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

afterAll(async () => {
  if (backend) await backend.shutdownWorkspaceLifecycle!();
});

async function openSampleWorkspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-mp8b-native-"));
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

    await storage.saveThread({
      thread: {
        id: threadId,
        resourceId,
        title: "MP-8b",
        createdAt: now,
        updatedAt: now,
      } as never,
    });
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
});
