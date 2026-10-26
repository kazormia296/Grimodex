// NIR-1 DD-1b (K5/3 必須防御 16, 17 and their A-1 and seam tests; DR-DD1B-8):
// the local generation route through the renderer's own `invoke`
// (`src/lib/tauri.ts`, over a `window.grimodex` shim onto Main's `grim:invoke`
// handler, as the preload exposes it), the real router, Main's gate, the real
// profile gate and the real Native addon.
//
// * Without the journey seam the six commands are refused by Main's gate and,
//   reached directly, by Native's gate; nothing is created, sent or recorded,
//   restricted or not.
// * With the seam's exact launch, the route runs as the product's:
//   unrestricted is refused (`nir1-restricted-only`); restricted, create →
//   capture → start → continue → read reaches a loopback recorder once with
//   Main's key verdict; another sender cannot read or stop the generation; a
//   destroyed sender stops the send.
//
// The recorder is a loopback HTTP server inside this test process (the real
// Electron journey's out-of-process recorder is DD-1d). The real addon is
// needed, so only `vitest.electron-native.config.ts` runs it.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  windows: new Map<unknown, unknown>(),
}));

vi.mock("electron", () => ({
  app: {
    // The router's default launch reads this: closed unless a test passes
    // the seam's launch explicitly.
    isPackaged: true,
    getVersion: () => "0.0.0-test",
    getPath: () => os.tmpdir(),
    getGPUFeatureStatus: () => ({}),
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  BrowserWindow: {
    fromWebContents: (sender: unknown) => mocks.windows.get(sender) ?? null,
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
type NativeBackendInstance = NapiBackendLike & Record<string, any>;
const { Backend: NativeBackend } = require(ADDON) as {
  Backend: new (appData: string) => NativeBackendInstance;
};
const backends: NativeBackendInstance[] = [];
const roots: string[] = [];
const servers: http.Server[] = [];

afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const backend of backends) {
    const wire = await backend.shutdownWorkspaceLifecycle!();
    expect(JSON.parse(wire).status).toBe("closed");
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>).window;
});

const COMMANDS = [
  "nir1_local_generation_start",
  "nir1_local_generation_continue",
  "nir1_local_generation_cancel",
  "nir1_local_conversation_create",
  "nir1_local_conversation_list",
  "nir1_local_conversation_read",
] as const;
const SOME_HANDLE = "0123456789abcdef0123456789abcdef";
const SOME_CONVERSATION =
  "nir1-local-writing-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

type Listener = () => void;

function fakeSender(id: number) {
  const listeners = new Map<string, Listener[]>();
  const sender = {
    id,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    once(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return sender;
    },
    emit(event: string) {
      const due = listeners.get(event) ?? [];
      listeners.delete(event);
      for (const listener of due) listener();
    },
  };
  const win = {
    id: id * 10,
    webContents: sender,
    isDestroyed: () => false,
    once: () => win,
  };
  mocks.windows.set(sender, win);
  return sender;
}

interface Recorder {
  readonly baseUrl: string;
  readonly connections: () => number;
  readonly bodies: string[];
  readonly peerClosed: () => boolean;
}

/** A loopback chat-completions recorder: `ok` streams "Hello"; `hold` stalls. */
async function startRecorder(mode: "ok" | "hold"): Promise<Recorder> {
  let connections = 0;
  let peerClosed = false;
  const bodies: string[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "close",
      });
      const event = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      if (mode === "ok") {
        response.write(event({ reasoning_content: "hm" }, null));
        response.write(event({ content: "Hel" }, null));
        response.write(event({ content: "lo" }, "stop"));
        response.write("data: [DONE]\n\n");
        response.end();
      } else {
        response.write(event({ content: "partial" }, null));
        response.on("close", () => {
          peerClosed = true;
        });
      }
    });
  });
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    connections: () => connections,
    bodies,
    peerClosed: () => peerClosed,
  };
}

interface Rig {
  native: NativeBackendInstance;
  route: (
    cmd: string,
    args?: Record<string, unknown>,
    sender?: ReturnType<typeof fakeSender>,
  ) => Promise<Envelope>;
  sender: ReturnType<typeof fakeSender>;
  /** The identity Main issued to a sender (for Native's direct reach). */
  callerOf: (senderId: number) => string;
  activate: () => Promise<void>;
}

function newAppData(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-dd1b-"));
  roots.push(root);
  const appData = path.join(realpathSync(root), "app-data");
  mkdirSync(appData, { recursive: true });
  return appData;
}

async function startMain(appData: string, seam: boolean): Promise<Rig> {
  vi.resetModules();
  mocks.handlers.clear();
  mocks.windows.clear();
  const native = new NativeBackend(appData);
  backends.push(native);
  const { createProfileEgressGate } = await import("./profileEgress.js");
  const { activateThroughMain } =
    await import("./profileActivation.test.support.js");
  const { registerEventBus } = await import("./events.js");
  const { registerIpcRouter } = await import("./ipc.js");
  const { IPC } = await import("../shared/ipcContract.js");
  const seamModule = await import("./nir1LocalGeneration.js");
  const userData = path.join(appData, "journey-user-data");
  mkdirSync(userData, { recursive: true });

  const gate = await createProfileEgressGate(native as NapiBackendLike);
  registerEventBus(native as NapiBackendLike, undefined, gate);
  registerIpcRouter(
    native as NapiBackendLike,
    {},
    // The key store's presence check (an empty store: no key).
    { resolveApiKeyForRequest: () => "", hasApiKey: () => false },
    undefined,
    { active: false } as never,
    gate,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    seam
      ? {
          isPackaged: false,
          env: {
            CI: "true",
            [seamModule.NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN_ENV]:
              seamModule.NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN,
            [seamModule.NIR1_LOCAL_GENERATION_CI_NONCE_ENV]:
              "3c9d2f4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
            [seamModule.NIR1_LOCAL_GENERATION_CI_USER_DATA_ENV]: userData,
          },
          userDataDir: userData,
          defaultUserDataDirs: () => [],
        }
      : undefined,
  );
  const handler = mocks.handlers.get(IPC.invoke) as (
    event: unknown,
    cmd: unknown,
    args: unknown,
  ) => Promise<Envelope>;
  const sender = fakeSender(7);
  const route: Rig["route"] = (cmd, args, from = sender) =>
    handler({ sender: from }, cmd, args ?? {});
  // The renderer bridge, as the preload exposes it, onto Main's handler.
  (globalThis as Record<string, unknown>).window = {
    grimodex: {
      invoke: (cmd: string, args?: Record<string, unknown>) => route(cmd, args),
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  return {
    native,
    route,
    sender,
    callerOf: (senderId) => JSON.stringify(gate.issueCallerIdentity(senderId)),
    activate: async () => {
      expect(
        await activateThroughMain(native as NapiBackendLike, gate),
      ).toEqual({ status: "activated" });
    },
  };
}

type RendererInvoke = <T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/** A renderer module, loaded through the `@` alias of this vitest config. */
function renderer<T>(specifier: string): Promise<T> {
  return import(/* @vite-ignore */ specifier) as Promise<T>;
}

/** The renderer's own `invoke` (`src/lib/tauri.ts`). */
async function rendererInvoke(): Promise<RendererInvoke> {
  return (await renderer<{ invoke: RendererInvoke }>("@/lib/tauri")).invoke;
}

function ok<T>(envelope: Envelope): T {
  if (!envelope.ok) throw new Error(`expected ok, got: ${envelope.error}`);
  return envelope.value as T;
}

interface Seeded {
  path: string;
  projectId: string;
  sceneId: string;
}

async function seed(rig: Rig): Promise<Seeded> {
  // The renderer's default AI usage policy (K5/3 17: the journey keeps the
  // default and does not write the policy).
  const { DEFAULT_AI_POLICY } = await renderer<{ DEFAULT_AI_POLICY: unknown }>(
    "@/features/ai-policy/types",
  );
  const seeded = ok<{ path: string; projectId: string }>(
    await rig.route("seed_sample_workspace", {
      language: "ja",
      aiPolicy: JSON.stringify(DEFAULT_AI_POLICY),
    }),
  );
  ok(await rig.route("open_workspace", { path: seeded.path }));
  const one = async (sql: string, params: unknown[]): Promise<string> => {
    const [row] = ok<{ rows: Array<Record<string, unknown>> }>(
      await rig.route("db_execute", { sql, params, method: "all" }),
    ).rows;
    return String(Object.values(row)[0]);
  };
  const sceneId = await one(
    "SELECT id FROM tree_nodes WHERE project_id = ? AND node_type = 'scene' AND archived_at IS NULL ORDER BY id LIMIT 1",
    [seeded.projectId],
  );
  return { ...seeded, sceneId };
}

/** The normal path for the destination (`save_ai_settings`, K5/3 17). */
async function pointRouteAt(rig: Rig, baseUrl: string): Promise<void> {
  const settings = ok<Record<string, unknown>>(
    await rig.route("get_ai_settings"),
  );
  ok(
    await rig.route("save_ai_settings", {
      settings: {
        ...settings,
        provider: "openai-compatible",
        model: "fixture-local-model",
        toolProtocolMode: "native",
        openaiCompatibleEndpoints: [
          {
            id: "local-1",
            label: "recorder",
            baseUrl,
            customMaxContext: 16_384,
            customMaxOutput: 1024,
          },
        ],
        activeOpenaiCompatibleEndpointId: "local-1",
      },
    }),
  );
}

const nativeCaller = JSON.stringify({
  profileId: "profile",
  callerId: "caller",
  callerEpoch: 0,
  senderId: 7,
  workspaceId: null,
  sessionId: "session",
});

describe("DD-1b: the local generation route through the renderer's invoke, the router, the gates and Native", () => {
  it("without the seam every command is refused by Main's gate and by Native's gate, restricted or not", async () => {
    const rig = await startMain(newAppData(), false);
    const invoke = await rendererInvoke();
    const recorder = await startRecorder("ok");
    const seeded = await seed(rig);
    await pointRouteAt(rig, recorder.baseUrl);
    const args: Record<string, Record<string, unknown>> = {
      nir1_local_generation_start: {
        purpose: "writing",
        conversationId: SOME_CONVERSATION,
        sceneId: seeded.sceneId,
      },
      nir1_local_generation_continue: { handle: SOME_HANDLE },
      nir1_local_generation_cancel: { handle: SOME_HANDLE },
      nir1_local_conversation_create: {
        purpose: "writing",
        sceneId: seeded.sceneId,
      },
      nir1_local_conversation_list: {},
      nir1_local_conversation_read: {
        conversationId: SOME_CONVERSATION,
        offset: 0,
        limit: 8,
      },
    };
    const closed = (command: string) => ({
      status:
        command === "nir1_local_generation_start" ? "unavailable" : "refused",
      reason: "NIR1_LOCAL_GATE_CLOSED",
    });
    for (const phase of ["unrestricted", "restricted"] as const) {
      if (phase === "restricted") await rig.activate();
      for (const command of COMMANDS) {
        expect(
          await invoke(command, args[command]),
          `${phase} ${command}`,
        ).toEqual(closed(command));
      }
    }
    // Native's own gate, reached directly with a well-formed request.
    expect(
      JSON.parse(await rig.native.nir1LocalConversationList!(nativeCaller)),
    ).toEqual({ status: "refused", reason: "NIR1_LOCAL_GATE_CLOSED" });
    expect(
      JSON.parse(
        await rig.native.nir1LocalConversationCreate!(
          { purpose: "writing", sceneId: seeded.sceneId },
          nativeCaller,
        ),
      ),
    ).toEqual({ status: "refused", reason: "NIR1_LOCAL_GATE_CLOSED" });
    expect(
      JSON.parse(
        await rig.native.nir1LocalGenerationStart!(
          args.nir1_local_generation_start,
          { endpointId: "local-1", keyVerdict: "absent" },
          nativeCaller,
        ),
      ),
    ).toEqual({ status: "unavailable", reason: "NIR1_LOCAL_GATE_CLOSED" });
    // Nothing was created or sent.
    const marked = ok<{ rows: unknown[] }>(
      await rig.route("db_execute", {
        sql: "SELECT id FROM chat_sessions WHERE id GLOB 'nir1-local-*'",
        params: [],
        method: "all",
      }),
    );
    expect(marked.rows).toEqual([]);
    expect(recorder.connections()).toBe(0);
  });

  it("with the seam: unrestricted is refused; restricted reaches Native through every command with Main's verdict and caller", async () => {
    const rig = await startMain(newAppData(), true);
    const invoke = await rendererInvoke();
    const recorder = await startRecorder("ok");
    const seeded = await seed(rig);
    await pointRouteAt(rig, recorder.baseUrl);

    // Unrestricted: nir1-restricted-only.
    await expect(
      invoke("nir1_local_conversation_create", {
        purpose: "writing",
        sceneId: seeded.sceneId,
      }),
    ).rejects.toThrow(/D2A_EGRESS_DENIED/);

    await rig.activate();
    const created = await invoke<{
      status: string;
      conversationId: string;
      displayName: { purpose: string; createdAt: string | null };
    }>("nir1_local_conversation_create", {
      purpose: "writing",
      sceneId: seeded.sceneId,
    });
    expect(created.status).toBe("created");
    expect(created.conversationId).toMatch(/^nir1-local-writing-/);
    expect(created.displayName.purpose).toBe("writing");
    expect(await invoke("nir1_local_conversation_list", {})).toMatchObject({
      status: "ok",
      conversations: [{ conversationId: created.conversationId }],
    });

    const start = {
      purpose: "writing",
      conversationId: created.conversationId,
      sceneId: seeded.sceneId,
    };
    // Before a capture: Native's typed refusal before DT-2's capture (not
    // recorded, so it can be pressed again).
    expect(await invoke("nir1_local_generation_start", start)).toEqual({
      status: "unavailable",
      reason: "NIR1_LOCAL_CAPTURE_NOT_CURRENT",
    });
    // Review on a Writing conversation is refused the same way.
    expect(
      await invoke("nir1_local_generation_start", {
        ...start,
        purpose: "review",
      }),
    ).toEqual({ status: "unavailable", reason: "NIR1_LOCAL_PURPOSE_MISMATCH" });

    ok(
      await rig.route("capture_current_chat_input", {
        submission: {
          submissionId: "dd1b-submission-1",
          messageId: "dd1b-message-1",
          chatSessionId: created.conversationId,
          sceneId: seeded.sceneId,
          content: "次の場面を書いて。",
          createdAt: "2026-10-26T10:00:00.000Z",
        },
      }),
    );
    const started = await invoke<{ status: string; handle?: string }>(
      "nir1_local_generation_start",
      start,
    );
    expect(started, JSON.stringify(started)).toMatchObject({
      status: "started",
    });
    const handle = started.handle!;

    // Another sender can neither read nor stop it: Main's binding refuses
    // before Native, and Native's caller match refuses a direct reach.
    const other = fakeSender(8);
    for (const command of [
      "nir1_local_generation_continue",
      "nir1_local_generation_cancel",
    ]) {
      expect(ok(await rig.route(command, { handle }, other)), command).toEqual({
        status: "refused",
        reason: "NIR1_LOCAL_HANDLE_NOT_FOUND",
      });
    }
    expect(
      JSON.parse(
        await rig.native.nir1LocalGenerationContinue!(
          { handle },
          rig.callerOf(8),
        ),
      ),
    ).toEqual({ status: "refused", reason: "NIR1_LOCAL_HANDLE_NOT_FOUND" });

    // The sample workspace has no human-approved typed Revision, so D-final
    // (in the starter thread, after the capture) ends the run with a typed
    // reason and nothing is sent. The successful dispatch is DD-1a's E10 and
    // DD-1d's journey.
    let last: Record<string, unknown> = {};
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      last = await invoke<Record<string, unknown>>(
        "nir1_local_generation_continue",
        { handle },
      );
      if (last.drained === true) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(last).toEqual({
      status: "ok",
      text: "",
      thinking: "",
      state: "failed",
      reason: "NIR1_LOCAL_PREPARATION_FAILED",
      drained: true,
    });
    // Drained: Main's binding and Native's handle are gone.
    expect(await invoke("nir1_local_generation_continue", { handle })).toEqual({
      status: "refused",
      reason: "NIR1_LOCAL_HANDLE_NOT_FOUND",
    });
    // The same capture cannot be started again (DD-1a's start record).
    expect(await invoke("nir1_local_generation_start", start)).toEqual({
      status: "unavailable",
      reason: "NIR1_LOCAL_ALREADY_STARTED",
    });

    const page = await invoke<{
      status: string;
      purpose: string;
      rows: Array<{ kind: string; text?: string }>;
    }>("nir1_local_conversation_read", {
      conversationId: created.conversationId,
      offset: 0,
      limit: 8,
    });
    expect(page).toMatchObject({ status: "ok", purpose: "writing" });
    expect(page.rows.map((row) => [row.kind, row.text])).toEqual([
      ["input", "次の場面を書いて。"],
    ]);
    expect(recorder.connections()).toBe(0);
  });

  it("with the seam: a destroyed sender reaches Native's sender stop", async () => {
    const rig = await startMain(newAppData(), true);
    const invoke = await rendererInvoke();
    const seeded = await seed(rig);
    await pointRouteAt(rig, (await startRecorder("hold")).baseUrl);
    await rig.activate();
    const created = await invoke<{ conversationId: string }>(
      "nir1_local_conversation_create",
      { purpose: "writing", sceneId: seeded.sceneId },
    );
    ok(
      await rig.route("capture_current_chat_input", {
        submission: {
          submissionId: "dd1b-submission-hold",
          messageId: "dd1b-message-hold",
          chatSessionId: created.conversationId,
          sceneId: seeded.sceneId,
          content: "続きを。",
          createdAt: "2026-10-26T10:00:00.000Z",
        },
      }),
    );
    const started = await invoke<{ status: string; handle: string }>(
      "nir1_local_generation_start",
      {
        purpose: "writing",
        conversationId: created.conversationId,
        sceneId: seeded.sceneId,
      },
    );
    expect(started.status).toBe("started");
    const caller = rig.callerOf(7);
    // No continue before the stop: a drained continue would remove the
    // handle itself, so only the sender stop explains its absence below.
    rig.sender.destroyed = true;
    rig.sender.emit("destroyed");
    // Main called `mainNir1LocalGenerationCancelSender(7)`: Native removed
    // every handle of the sender, so even the exact caller finds none.
    expect(
      JSON.parse(
        await rig.native.nir1LocalGenerationContinue!(
          { handle: started.handle },
          caller,
        ),
      ),
    ).toEqual({ status: "refused", reason: "NIR1_LOCAL_HANDLE_NOT_FOUND" });
    // And the destroyed sender is refused by Main before Native.
    expect(
      ok(
        await rig.route("nir1_local_generation_continue", {
          handle: started.handle,
        }),
      ),
    ).toEqual({ status: "refused", reason: "NIR1_LOCAL_SENDER_REFUSED" });
  });
});
