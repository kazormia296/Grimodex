// AI project policy repair: both Main policy gates read the value persisted by
// the product's project_patch writer against the real Native database.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

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

const VALID_POLICY = JSON.stringify({
  preset: "full",
  toggles: {
    chat: true,
    bodyWrite: true,
    analysis: true,
    structureWrite: true,
    knowledgeWrite: true,
  },
});

describe("AI policy repair through Main and Native", () => {
  it("denies capabilities and chat for a damaged saved policy, then allows both after repair", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-ai-policy-"));
    roots.push(root);
    const appData = path.join(realpathSync(root), "app-data");
    mkdirSync(appData, { recursive: true });
    const backend = new NativeBackend(appData);
    backends.push(backend);
    const dbExecute = vi.fn(
      (...args: Parameters<NapiBackendLike["dbExecute"]>) =>
        backend.dbExecute(...args),
    );

    // Keep the route deterministic and offline; every other method, including
    // dbExecute used by capability issuance, remains the Native backend call.
    const routedBackend = new Proxy(backend, {
      get(target, property) {
        if (property === "sendAgentMessage") {
          return async () =>
            JSON.stringify({
              blocks: [
                {
                  type: "tool_use",
                  id: "call-policy-repair",
                  name: "create_foreshadow",
                  input: { title: "from the model" },
                },
              ],
              stopReason: "tool_use",
            });
        }
        if (property === "dbExecute") return dbExecute;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const { createProfileEgressGate } = await import("./profileEgress.js");
    const { registerEventBus } = await import("./events.js");
    const { registerIpcRouter } = await import("./ipc.js");
    const { IPC } = await import("../shared/ipcContract.js");
    const { projectAiChatPolicyAllows } = await import("./mastraChatPolicy.js");
    const gate = await createProfileEgressGate(backend as NapiBackendLike);
    registerEventBus(routedBackend as NapiBackendLike, undefined, gate);
    registerIpcRouter(
      routedBackend as NapiBackendLike,
      {},
      {
        resolveApiKeyForRequest: () => "offline-test-key",
        getApiKeyForRequest: () => null,
      },
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
      sender: { id: 711, isDestroyed: () => false, once: () => undefined },
    };
    const route = (cmd: string, args: Record<string, unknown> = {}) =>
      handler(event, cmd, args);

    const seeded = ok<{ path: string; projectId: string }>(
      await route("seed_sample_workspace", {
        language: "ja",
        aiPolicy: VALID_POLICY,
      }),
    );
    ok(await route("open_workspace", { path: seeded.path }));

    const patchPolicy = async (aiPolicy: string) => {
      const current = JSON.parse(
        await backend.dbExecute(
          "SELECT updated_at FROM projects WHERE id = ? LIMIT 1",
          [seeded.projectId],
          "get",
        ),
      ) as { rows: Array<{ updated_at: string }> };
      const baseUpdatedAt = current.rows[0]!.updated_at;
      const requestId = randomUUID();
      const sessionId = randomUUID();
      ok(
        await route("project_patch", {
          payload: {
            projectId: seeded.projectId,
            requestId,
            sessionId,
            writerSessionId: sessionId,
            eventUid: randomUUID(),
            origin: "human",
            authorityRoute: "human-direct",
            caller: "human-ui",
            controls: [
              "runtime-policy",
              "actor-context",
              "typed-writer",
              "occ",
              "change-event",
              "change-feed",
            ],
            provenance: null,
            writesAuthorityProtectedField: false,
            originalTransactionId: null,
            undoJournalId: null,
            baseUpdatedAt,
            updatedAt: new Date(Date.now() + 1).toISOString(),
            patch: { aiPolicy },
          },
        }),
      );
    };
    const policyRead = async () =>
      backend.dbExecute(
        "SELECT ai_policy FROM projects WHERE id = ? LIMIT 1",
        [seeded.projectId],
        "get",
      );
    const capabilities = async () => {
      dbExecute.mockClear();
      const envelope = await route("send_agent_message", {
        messages: [{ role: "user", content: "write a clue" }],
        tools: [{ name: "create_foreshadow" }],
        provider: "openai",
        chatMessageId: "assistant-policy-repair",
        auditContext: {
          expectedWorkspacePath: seeded.path,
          projectId: seeded.projectId,
          operationId: "turn-policy-repair",
          executionId: "execution-policy-repair",
          parentExecutionId: null,
          pathId: "chat_agent_main",
        },
      });
      // The issuance read carries the main-issued caller identity.
      expect(dbExecute).toHaveBeenCalledWith(
        "SELECT ai_policy FROM projects WHERE id = ? LIMIT 1",
        [seeded.projectId],
        "get",
        expect.any(String),
      );
      return ok<Record<string, unknown>>(envelope).agentAuthorityCapabilities;
    };

    await patchPolicy("not-json");
    expect(await capabilities()).toBeUndefined();
    expect(projectAiChatPolicyAllows(await policyRead())).toBe(false);

    await patchPolicy(VALID_POLICY);
    expect(await capabilities()).toMatchObject({
      "call-policy-repair": expect.objectContaining({
        capability: expect.any(String),
      }),
    });
    expect(projectAiChatPolicyAllows(await policyRead())).toBe(true);
  });
});
