// NIR-1 DA-2 ST2（K3/2 Positive (3)、Negative (15)、待ちの上限）: 実 router + 実 gate +
// 実 Native で、外部 provider が応答しないまま待っている非 stream の旧 AI 要求
// （`list_ai_models`）があっても、Main の activation（preview → 承認 → issue → 消費 →
// 段 2〜7）が上限の内で一度だけ成立し、その要求の結果が返らず、待ち続けないことを固定する。
// 取消は Native の段 5（DR-DA2-6）、結果の拒否は Main の完了時の検査（DR-DA2-18）。
//
// 実 Native の addon が要るので `vitest.electron-native.config.ts` だけが拾う。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
    getPath: () => os.tmpdir(),
    getGPUFeatureStatus: () => ({}),
  },
  dialog: {
    showMessageBox: vi.fn(async () => {
      throw new Error("the product dialog must not be shown in this spec");
    }),
  },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    },
    on: () => undefined,
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
const { Backend } = require(ADDON) as {
  Backend: new (appData: string) => NapiBackendLike & Record<string, any>;
};

/** A provider that accepts the request and never answers it. */
let provider: Server;
let providerUrl = "";
let providerHits = 0;
const heldResponses: ServerResponse<IncomingMessage>[] = [];
const roots: string[] = [];

beforeAll(async () => {
  provider = createServer((_req, res) => {
    providerHits += 1;
    heldResponses.push(res);
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = provider.address();
  if (address === null || typeof address === "string") {
    throw new Error("provider listener has no port");
  }
  providerUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const res of heldResponses) res.destroy();
  provider.closeAllConnections?.();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function newAppData(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-da2-activation-"));
  roots.push(root);
  const appData = path.join(root, "app-data");
  mkdirSync(appData, { recursive: true });
  writeFileSync(
    path.join(appData, "ai-settings.json"),
    JSON.stringify({
      provider: "openai-compatible",
      model: "mock-model",
      ollamaEndpoint: "",
      openaiCompatibleEndpoints: [{ id: "test", baseUrl: providerUrl }],
      activeOpenaiCompatibleEndpointId: "test",
    }),
  );
  return appData;
}

describe("activation with a legacy AI request in flight (real router + gate + Native)", () => {
  it("completes within the bound with an in-flight non-stream request, which is cancelled and not returned", async () => {
    vi.resetModules();
    mocks.handlers.clear();
    const backend = new Backend(newAppData());
    const { createProfileEgressGate } = await import("./profileEgress.js");
    const { activateThroughMain } =
      await import("./profileActivation.test.support.js");
    const { registerEventBus } = await import("./events.js");
    const { registerIpcRouter } = await import("./ipc.js");
    const { IPC } = await import("../shared/ipcContract.js");

    const gate = await createProfileEgressGate(backend);
    registerEventBus(backend, undefined, gate);
    registerIpcRouter(
      backend,
      {} as never,
      {
        resolveApiKeyForRequest: () => "sk-test",
        getApiKeyForRequest: () => "sk-test",
      } as never,
      undefined,
      { active: false },
      gate,
    );
    const route = mocks.handlers.get(IPC.invoke) as (
      event: unknown,
      cmd: unknown,
      args: unknown,
    ) => Promise<Envelope>;
    const event = {
      sender: { id: 7, isDestroyed: () => false, once: () => undefined },
    };

    const hitsBefore = providerHits;
    const pending = route(event, "list_ai_models", {
      provider: "openai-compatible",
      endpointId: "test",
    });
    // The request reached the provider and waits there.
    await vi.waitFor(() => expect(providerHits).toBe(hitsBefore + 1), {
      timeout: 20_000,
    });

    const startedAt = Date.now();
    const result = await activateThroughMain(backend, gate);
    const elapsed = Date.now() - startedAt;
    expect(result).toEqual({ status: "activated" });
    expect(gate.restricted).toBe(true);
    expect(gate.unavailable).toBe(false);
    // Inside the 30 s bound of stage 5 (the request did not hold the drain).
    expect(elapsed).toBeLessThan(30_000);

    // The admitted request ends (no endless wait) without its result.
    const envelope = await pending;
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error).toContain("D2A_EGRESS_DENIED");

    // Afterwards a new legacy request is refused at invoke, before Native.
    const after = await route(event, "list_ai_models", {
      provider: "openai-compatible",
      endpointId: "test",
    });
    expect(after.ok).toBe(false);
    expect(providerHits).toBe(hitsBefore + 1);

  });
});
