import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";

import { afterAll } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

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

import { vi } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const ADDON = path.join(
  ROOT,
  "electron",
  "native",
  "grimodex-node",
  "grimodex-node.node",
);
const require = createRequire(import.meta.url);
const { Backend: NativeBackend } = require(ADDON) as {
  Backend: new (appData: string) => NativeBackendInstance;
};
const backends: NativeBackendInstance[] = [];
const roots: string[] = [];
let requestedSceneId = "";

interface NativeBackendInstance extends NapiBackendLike {
  shutdownWorkspaceLifecycle(): Promise<string>;
}

afterAll(async () => {
  for (const backend of backends) {
    expect(JSON.parse(await backend.shutdownWorkspaceLifecycle()).status).toBe(
      "closed",
    );
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Rig {
  route: (cmd: string, args?: Record<string, unknown>) => Promise<Envelope>;
}

async function startMain(): Promise<Rig> {
  vi.resetModules();
  mocks.handlers.clear();
  const appRoot = mkdtempSync(path.join(os.tmpdir(), "grimodex-prose-auth-"));
  roots.push(appRoot);
  const backend = new NativeBackend(
    path.join(realpathSync(appRoot), "app-data"),
  );
  backends.push(backend);
  const proxied = new Proxy(backend, {
    get(target, property) {
      if (property === "getAiSettings") {
        return async () =>
          JSON.stringify({ provider: "openai", model: "gpt-test" });
      }
      if (property === "sendAgentMessage") {
        return async () =>
          JSON.stringify({
            blocks: [
              {
                type: "tool_use",
                id: "propose-call",
                name: "propose_scene_body",
                input: {
                  sceneId: requestedSceneId,
                  text: "試験本文",
                  mode: "append",
                },
              },
            ],
            stopReason: "tool_use",
          });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { createProfileEgressGate } = await import("./profileEgress.js");
  const { registerEventBus } = await import("./events.js");
  const { registerIpcRouter } = await import("./ipc.js");
  const { IPC } = await import("../shared/ipcContract.js");
  const gate = await createProfileEgressGate(proxied as never);
  registerEventBus(proxied as never, undefined, gate);
  registerIpcRouter(
    proxied as never,
    {} as never,
    {
      resolveApiKeyForRequest: () => "test-key",
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
    sender: { id: 73, isDestroyed: () => false, once: () => undefined },
  };
  return { route: (cmd, args) => handler(event, cmd, args ?? {}) };
}

function ok<T>(envelope: Envelope): T {
  if (!envelope.ok) throw new Error(`expected ok, got: ${envelope.error}`);
  return envelope.value as T;
}

function fail(envelope: Envelope): string {
  expect(envelope.ok).toBe(false);
  return envelope.ok ? "" : envelope.error;
}

describe("prose body renderer authority through the real Native addon", () => {
  it("drops array payloads before Native and persists only a capability-bound object", async () => {
    const rig = await startMain();
    const seeded = ok<{ path: string; projectId: string }>(
      await rig.route("seed_sample_workspace", {
        language: "ja",
        aiPolicy:
          '{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true,"structureWrite":true,"knowledgeWrite":true}}',
      }),
    );
    ok(await rig.route("open_workspace", { path: seeded.path }));
    const readRows = async <T>(sql: string, params: unknown[] = []) =>
      ok<{ rows: T[] }>(
        await rig.route("db_execute", { sql, params, method: "all" }),
      ).rows;
    const [scene] = await readRows<{ id: string }>(
      "SELECT id FROM tree_nodes WHERE project_id = ? AND node_type = 'scene' ORDER BY id LIMIT 1",
      [seeded.projectId],
    );
    requestedSceneId = scene.id;
    const counts = () =>
      readRows<{ staged: number; proposed: number }>(
        "SELECT (SELECT count(*) FROM prose_staging WHERE project_id = ?) AS staged, (SELECT count(*) FROM change_events WHERE op_type = 'prose.propose') AS proposed",
        [seeded.projectId],
      );

    const malformed = [
      seeded.projectId,
      "forged-session",
      scene.id,
      "text",
      "append",
      "in-app-agent",
      null,
      null,
    ];
    expect(
      fail(await rig.route("agent_propose_scene_body", { payload: malformed })),
    ).toBeTruthy();
    expect(await counts()).toEqual([{ staged: 0, proposed: 0 }]);

    const capabilityResponse = ok<{
      agentAuthorityCapabilities: Record<
        string,
        {
          capability: string;
          executionId: string;
          mainOwnedProvenanceId: string;
        }
      >;
    }>(
      await rig.route("send_agent_message", {
        messages: [{ role: "user", content: "本文を提案" }],
        tools: [{ name: "propose_scene_body" }],
        provider: "openai",
        chatMessageId: "assistant-propose",
        auditContext: {
          expectedWorkspacePath: seeded.path,
          projectId: seeded.projectId,
          operationId: "propose-operation",
          executionId: "propose-execution",
          parentExecutionId: null,
          pathId: "chat_agent_main",
        },
      }),
    );
    const grant = capabilityResponse.agentAuthorityCapabilities["propose-call"];
    const requestId = `agent-tool:${createHash("sha256")
      .update(`propose_scene_body\0${seeded.projectId}\0propose-call`)
      .digest("hex")}`;
    const base = {
      projectId: seeded.projectId,
      requestId,
      eventUid: `${requestId}:event`,
      origin: "ai-apply",
      sessionId: "valid-session",
      sceneId: scene.id,
      proposedContent: "試験本文",
      mode: "append",
      sourceSurface: "in-app-agent",
      chatMessageId: "assistant-propose",
      toolCallId: "propose-call",
      executionId: grant.executionId,
      mainOwnedProvenanceId: grant.mainOwnedProvenanceId,
    };

    expect(
      fail(
        await rig.route("agent_propose_scene_body", {
          payload: base,
        }),
      ),
    ).toBeTruthy();
    expect(await counts()).toEqual([{ staged: 0, proposed: 0 }]);

    const proposed = await rig.route("agent_propose_scene_body", {
      payload: {
        ...base,
        agentAuthorityCapability: grant.capability,
      },
    });
    ok(proposed);
    expect(await counts()).toEqual([{ staged: 1, proposed: 1 }]);
  });
});
