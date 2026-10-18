// NIR-1 DA-1 ST2 (K3/2 Negative (1)): "外へ出す経路の台帳" の拒否の各行が、
// 実 router + 実 gate + 実 Native を通して外へ到達しないことを固定する。
//
// 外への到達 = (1) AI provider への HTTP 送信、(2) 子 process の起動（login shell の
// `bash -lc` / `zsh -lc`、Windows の `where.exe`、CLI の `--version` を含む）、
// (3) URL の open。3 つとも 0 件でなければならない。
//
// 2 つの process を試す。(A) 起動したときは unrestricted で、同じ process の中で
// activation を経たもの。(B) 既に restricted な profile で起動し直したもの（main
// participant の停止が走らない）。どちらも同じ表を通す。
//
// 実 Native の addon が要るので、既定の `electron` stage（vitest.electron.config.ts）
// には載せず、`vitest.electron-native.config.ts` だけが拾う（`*.pipeline.spec.ts`）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  onHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  openExternal: [] as string[],
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
    getPath: () => os.tmpdir(),
    getGPUFeatureStatus: () => ({}),
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: {
    openExternal: async (url: string) => {
      mocks.openExternal.push(url);
    },
    openPath: vi.fn(),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    },
    on: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.onHandlers.set(channel, handler);
    },
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

const DENIED_MARKER = "D2A_EGRESS_DENIED:";

/** 外への到達の 3 つの計数。 */
interface Reach {
  providerHits: number;
  spawns: string[];
  urlOpens: string[];
  /** gate を通り抜けて Main の handler が呼ばれた command（0 件でなければならない）。 */
  handlerReached: string[];
}

interface Rig {
  route: (cmd: string, args?: Record<string, unknown>) => Promise<Envelope>;
  openExternal: (url: string) => Promise<Envelope>;
  gate: Awaited<
    ReturnType<(typeof import("./profileEgress.js"))["createProfileEgressGate"]>
  >;
  reach: Reach;
}

let provider: Server;
let providerHits = 0;
let providerUrl = "";
const roots: string[] = [];

beforeAll(async () => {
  provider = createServer((_req, res) => {
    providerHits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "model-a", name: "Model A" }] }));
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
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function newAppData(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-d2a-rows-"));
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

/** A fresh module graph + router on `appData`, as a Main process would start. */
async function startMain(appData: string): Promise<Rig> {
  vi.resetModules();
  mocks.handlers.clear();
  mocks.onHandlers.clear();
  mocks.openExternal.length = 0;

  const backend = new Backend(appData);
  const { createProfileEgressGate } = await import("./profileEgress.js");
  const { registerEventBus } = await import("./events.js");
  const { registerIpcRouter } = await import("./ipc.js");
  const { registerShellBridgeHandlers } = await import("./shellCommands.js");
  const { createCliAiManager } = await import("./cliAi.js");
  const { createVivliostyleManager } = await import("./vivliostyle.js");
  const { IPC } = await import("../shared/ipcContract.js");

  const reach: Reach = {
    providerHits: 0,
    spawns: [],
    urlOpens: mocks.openExternal,
    handlerReached: [],
  };
  const recordingRunner = {
    run: async (spec: { executable: string; args: readonly string[] }) => {
      reach.spawns.push(`${spec.executable} ${spec.args.join(" ")}`.trim());
      return { exitCode: 1, signal: null, stdout: "", stderr: "" };
    },
    start: (spec: { executable: string; args: readonly string[] }) => {
      reach.spawns.push(`start ${spec.executable}`);
      throw new Error("unexpected child process start");
    },
  };

  const cli = createCliAiManager(() => undefined, {
    runner: recordingRunner as never,
    platform: "linux",
    env: { PATH: "" },
    isFile: async () => false,
  });
  const vivliostyle = createVivliostyleManager(() => undefined, {
    runner: recordingRunner as never,
    platform: "linux",
    env: { PATH: "" },
    isFile: async () => false,
    authorizeExecutable: async () => false,
    pickSavePath: async () => null,
  });
  const stubbed = (name: string) => async () => {
    reach.handlerReached.push(name);
    return null;
  };
  const codexAndMcp = Object.fromEntries(
    [
      "codex_app_test_connection",
      "codex_app_list_models",
      "codex_app_start_turn",
      "codex_app_respond_to_request",
      "codex_app_get_status",
      "codex_app_update_history_revision",
      "codex_app_archive_session_thread",
      "codex_app_set_thread_name",
      "get_mcp_config",
    ].map((name) => [name, stubbed(name)]),
  );

  const gate = await createProfileEgressGate(backend);
  registerEventBus(backend, undefined, gate);
  registerIpcRouter(
    backend,
    {
      ...cli.handlers,
      ...vivliostyle.handlers,
      ...codexAndMcp,
    } as never,
    {
      resolveApiKeyForRequest: () => "sk-test",
      getApiKeyForRequest: () => "sk-test",
    } as never,
    undefined,
    { active: false },
    gate,
  );
  registerShellBridgeHandlers(undefined, undefined, () =>
    gate.assertExternalUrl(),
  );

  const routerHandler = mocks.handlers.get(IPC.invoke) as (
    event: unknown,
    cmd: unknown,
    args: unknown,
  ) => Promise<Envelope>;
  const openHandler = mocks.handlers.get(IPC.openExternal) as (
    event: unknown,
    url: unknown,
  ) => Promise<Envelope>;
  const event = {
    sender: { id: 7, isDestroyed: () => false, once: () => undefined },
  };
  return {
    gate,
    reach,
    route: (cmd, args) => routerHandler(event, cmd, args ?? {}),
    openExternal: (url) => openHandler(event, url),
  };
}

type Row = readonly [command: string, args: Record<string, unknown>];

/** K3/2 外へ出す経路の台帳の「拒否」の行（旧 AI、接続試験、CLI、Codex、MCP、Vivliostyle）。 */
const DENIED_ROWS: readonly Row[] = [
  ["send_chat_message", { messages: [], apiVariant: "loopback" }],
  ["send_chat_message_stream", { messages: [], endpointId: "proxy" }],
  ["send_inline_ai_stream", { messages: [], apiVariant: "redirect" }],
  ["send_agent_message", { messages: [], tools: [] }],
  ["list_ai_models", { provider: "openai-compatible", endpointId: "test" }],
  ["test_ai_connection", { provider: "openai-compatible", model: "m" }],
  ["start_post_effect_run", { sceneId: "s" }],
  ["start_post_effect_run_multi", { sceneIds: ["s"] }],
  ["send_cli_chat_stream", {}],
  ["detect_cli_binary", { cli: "codex" }],
  ["test_cli_connection", { cli: "codex" }],
  ["list_cli_models", { cli: "codex" }],
  ["codex_app_test_connection", {}],
  ["codex_app_list_models", {}],
  ["codex_app_start_turn", {}],
  ["codex_app_respond_to_request", {}],
  ["codex_app_get_status", {}],
  ["codex_app_update_history_revision", {}],
  ["codex_app_archive_session_thread", {}],
  ["codex_app_set_thread_name", {}],
  ["get_mcp_config", {}],
  ["vivliostyle_build", { format: "pdf", files: [] }],
  ["vivliostyle_preview_start", {}],
  ["vivliostyle_detect", {}],
];

async function assertNothingLeavesMain(rig: Rig): Promise<void> {
  const baselineProviderHits = providerHits;
  const baselineSpawns = rig.reach.spawns.length;
  const baselineOpens = rig.reach.urlOpens.length;
  for (const [command, args] of DENIED_ROWS) {
    const envelope = await rig.route(command, args);
    expect(envelope.ok, command).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error, command).toContain(DENIED_MARKER);
    }
  }
  const url = await rig.openExternal("https://example.com/");
  expect(url.ok).toBe(false);
  if (!url.ok) expect(url.error).toContain(DENIED_MARKER);

  expect(rig.reach.handlerReached, "Main handler reached").toEqual([]);
  expect(providerHits - baselineProviderHits, "provider requests").toBe(0);
  expect(rig.reach.spawns.slice(baselineSpawns), "child processes").toEqual([]);
  expect(rig.reach.urlOpens.slice(baselineOpens), "URL opens").toEqual([]);
}

describe("D2a egress rows reach nothing outside (real router + gate + Native)", () => {
  it("(A) after activation in the same process", async () => {
    const appData = newAppData();
    const rig = await startMain(appData);
    expect(rig.gate.restricted).toBe(false);

    // Control (unrestricted): the same router reaches all three, so the
    // counters below can fail.
    const before = providerHits;
    const models = await rig.route("list_ai_models", {
      provider: "openai-compatible",
      endpointId: "test",
    });
    expect(models.ok).toBe(true);
    expect(providerHits - before).toBe(1);
    await rig.route("vivliostyle_detect", {});
    await rig.route("detect_cli_binary", { cli: "codex" });
    expect(
      rig.reach.spawns.some((spawn) => /^bash -lc /.test(spawn)),
      `login shell probe: ${JSON.stringify(rig.reach.spawns)}`,
    ).toBe(true);
    const opened = await rig.openExternal("https://example.com/");
    expect(opened.ok).toBe(true);
    expect(rig.reach.urlOpens).toEqual(["https://example.com/"]);

    // The one-way transition, through the real gate and the real Native.
    await rig.gate.activateFirstRestrictedPublication!();
    expect(rig.gate.restricted).toBe(true);
    expect(rig.gate.unavailable).toBe(false);
    await assertNothingLeavesMain(rig);
  });

  it("(B) in a process restarted on an already restricted profile", async () => {
    const appData = newAppData();
    // Process 1 activates and exits; no main participant stop runs in process 2.
    const first = new Backend(appData);
    await first.initializeProfileEgress!();
    const activated = JSON.parse(await first.activateProfileEgress!()) as {
      restricted: boolean;
    };
    expect(activated.restricted).toBe(true);

    const rig = await startMain(appData);
    expect(rig.gate.restricted).toBe(true);
    expect(rig.gate.unavailable).toBe(false);
    await assertNothingLeavesMain(rig);
  });
});
