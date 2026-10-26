// NIR-1 DD-1b (DR-DD1B-1..7; K5/3 必須防御 16, 17): Main's gate and the
// journey seam of the local generation route, the sender, window and caller
// checks, the handle binding, the stops on a destroyed sender, a closed
// window or a replaced caller, and Main's key verdict — through the real
// router and the real profile gate with a mocked Native backend.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IPC,
  NIR1_LOCAL_GENERATION_COMMANDS,
  type Envelope,
  type NapiBackendLike,
  type SecretsResolver,
} from "../shared/ipcContract.js";
import { nativeSqlPolicyV2 } from "./d2aSqlPolicyFixture.js";
import { createKeyStore, type SafeStorageLike } from "./keyStore.js";
import {
  createNir1LocalGenerationRoute,
  NIR1_LOCAL_GENERATION_CI_GATE_ENTRY,
  NIR1_LOCAL_GENERATION_CI_NONCE_ENV,
  NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN,
  NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN_ENV,
  NIR1_LOCAL_GENERATION_CI_USER_DATA_ENV,
  parseNir1LocalGenerationCiSeam,
  startNir1LocalGenerationCiSeam,
  type Nir1LocalGenerationLaunch,
} from "./nir1LocalGeneration.js";
import {
  createProfileEgressGate,
  D2A_EGRESS_DENIED_MARKER,
  type ProfileEgressGate,
} from "./profileEgress.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  windows: new Map<unknown, unknown>(),
  app: {
    isPackaged: true as boolean | undefined,
    getPath: ((_name: string) => "/nonexistent") as (name: string) => string,
  },
}));

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: {
    fromWebContents: (sender: unknown) => mocks.windows.get(sender) ?? null,
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    },
  },
}));
vi.mock("./shellCommands.js", () => ({
  buildShellCommandHandlers: vi.fn(() => ({})),
  registerShellBridgeHandlers: vi.fn(),
}));
vi.mock("./windows.js", () => ({
  focusPanelWindow: vi.fn(),
  hasPanelWindow: vi.fn(),
  openPanelWindow: vi.fn(),
}));

const { registerIpcRouter } = await import("./ipc.js");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const NONCE = "8f14e45f-ceea-467e-a5d4-1b9c6d0e2f3a";
const HANDLE = "0123456789abcdef0123456789abcdef";
const CONVERSATION = "nir1-local-writing-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const START = {
  purpose: "writing",
  conversationId: CONVERSATION,
  sceneId: "scene-1",
};
const ARGS: Record<string, Record<string, unknown>> = {
  nir1_local_generation_start: START,
  nir1_local_generation_continue: { handle: HANDLE },
  nir1_local_generation_cancel: { handle: HANDLE },
  nir1_local_conversation_create: { purpose: "writing", sceneId: "scene-1" },
  nir1_local_conversation_list: {},
  nir1_local_conversation_read: {
    conversationId: CONVERSATION,
    offset: 0,
    limit: 8,
  },
};

function journeyDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-dd1b-"));
  roots.push(root);
  return root;
}

function activeLaunch(
  overrides: Partial<Nir1LocalGenerationLaunch> = {},
  env: NodeJS.ProcessEnv = {},
): Nir1LocalGenerationLaunch {
  const userDataDir = overrides.userDataDir ?? journeyDir();
  return {
    isPackaged: false,
    env: {
      CI: "true",
      [NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN_ENV]:
        NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN,
      [NIR1_LOCAL_GENERATION_CI_NONCE_ENV]: NONCE,
      [NIR1_LOCAL_GENERATION_CI_USER_DATA_ENV]: userDataDir,
      ...env,
    },
    userDataDir,
    defaultUserDataDirs: () => ["/home/user/.config/Grimodex Dev"],
    ...overrides,
  };
}

/** An env whose every read fails the test (a packaged launch reads none). */
function untouchableEnv(): NodeJS.ProcessEnv {
  return new Proxy(
    {},
    {
      get(_target, key) {
        throw new Error(`env read: ${String(key)}`);
      },
      has(_target, key) {
        throw new Error(`env has: ${String(key)}`);
      },
    },
  );
}

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
    listenerCount(event: string) {
      return (listeners.get(event) ?? []).length;
    },
  };
  return sender;
}

function fakeWindow(id: number, webContents: unknown) {
  const listeners = new Map<string, Listener[]>();
  const win = {
    id,
    destroyed: false,
    webContents,
    isDestroyed() {
      return this.destroyed;
    },
    once(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return win;
    },
    emit(event: string) {
      const due = listeners.get(event) ?? [];
      listeners.delete(event);
      for (const listener of due) listener();
    },
    listenerCount(event: string) {
      return (listeners.get(event) ?? []).length;
    },
  };
  return win;
}

function status(restricted: boolean) {
  return {
    profileId: "profile-1",
    callerEpoch: 4,
    restricted,
    handlesInvalidated: restricted,
    inFlightStopped: true,
    sqlPolicy: nativeSqlPolicyV2(),
  };
}

interface FakeNative {
  backend: NapiBackendLike;
  calls: Array<{ method: string; args: unknown[] }>;
  answer: Record<string, unknown>;
  settings: unknown;
  /** A method waits on this before answering (a pending Native call). */
  hold: Partial<Record<string, Promise<void>>>;
}

const NATIVE_METHODS = [
  "nir1LocalGenerationStart",
  "nir1LocalGenerationContinue",
  "nir1LocalGenerationCancel",
  "nir1LocalConversationCreate",
  "nir1LocalConversationList",
  "nir1LocalConversationRead",
] as const;

function fakeNative(restricted: boolean): FakeNative {
  const native: FakeNative = {
    calls: [],
    answer: {
      nir1LocalGenerationStart: { status: "started", handle: HANDLE },
      nir1LocalGenerationContinue: {
        status: "ok",
        text: "Hel",
        thinking: "",
        state: "running",
        drained: false,
      },
      nir1LocalGenerationCancel: { status: "ok" },
      nir1LocalConversationCreate: {
        status: "created",
        conversationId: CONVERSATION,
        displayName: { purpose: "writing", createdAt: null },
      },
      nir1LocalConversationList: {
        status: "ok",
        conversations: [],
        truncated: false,
      },
      nir1LocalConversationRead: {
        status: "ok",
        purpose: "writing",
        rows: [],
        total: 0,
        truncated: false,
      },
    },
    settings: {
      provider: "openai-compatible",
      activeOpenaiCompatibleEndpointId: "local-1",
    },
    hold: {},
    backend: undefined as never,
  };
  const record =
    (method: string, result?: () => unknown) =>
    (...args: unknown[]) => {
      native.calls.push({ method, args });
      return result?.();
    };
  const backend: Record<string, unknown> = {
    initializeProfileEgress: async () => JSON.stringify(status(restricted)),
    registerProfileEgressCaller: record("registerProfileEgressCaller"),
    invalidateProfileEgressCallers: () => undefined,
    getAiSettings: async () => {
      native.calls.push({ method: "getAiSettings", args: [] });
      await native.hold.getAiSettings;
      return JSON.stringify(native.settings);
    },
    mainOpenPrePublicationGate: record("mainOpenPrePublicationGate"),
    mainNir1LocalGenerationCancelSender: record(
      "mainNir1LocalGenerationCancelSender",
      () => 0,
    ),
  };
  for (const method of NATIVE_METHODS) {
    backend[method] = async (...args: unknown[]) => {
      native.calls.push({ method, args });
      await native.hold[method];
      const answer = native.answer[method];
      // `{ __raw }` answers a string that is not JSON.
      return isRaw(answer) ? answer.__raw : JSON.stringify(answer);
    };
  }
  native.backend = backend as unknown as NapiBackendLike;
  return native;
}

function isRaw(value: unknown): value is { __raw: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { __raw?: unknown }).__raw === "string"
  );
}

function callsOf(native: FakeNative, method: string): unknown[][] {
  return native.calls
    .filter((call) => call.method === method)
    .map((call) => call.args);
}

function routeCalls(native: FakeNative): string[] {
  return native.calls
    .map((call) => call.method)
    .filter(
      (method) => method.startsWith("nir1Local") || method === "getAiSettings",
    );
}

interface Rig {
  native: FakeNative;
  gate: ProfileEgressGate;
  invoke: (
    cmd: string,
    args?: Record<string, unknown>,
    sender?: ReturnType<typeof fakeSender>,
  ) => Promise<Envelope>;
  sender: ReturnType<typeof fakeSender>;
  win: ReturnType<typeof fakeWindow>;
  hasApiKey: ReturnType<typeof vi.fn>;
}

async function rig(
  options: {
    restricted?: boolean;
    launch?: Nir1LocalGenerationLaunch;
    secrets?: SecretsResolver | null;
    wrapGate?: (gate: ProfileEgressGate) => ProfileEgressGate;
  } = {},
): Promise<Rig> {
  mocks.handlers.clear();
  mocks.windows.clear();
  const native = fakeNative(options.restricted ?? true);
  const real = await createProfileEgressGate(native.backend);
  const gate = options.wrapGate ? options.wrapGate(real) : real;
  const hasApiKey = vi.fn(() => false);
  const secrets =
    options.secrets === null
      ? undefined
      : (options.secrets ??
        ({
          resolveApiKeyForRequest: () => "",
          hasApiKey,
        } as SecretsResolver));
  // `undefined` for the launch takes the product's default (Electron's `app`).
  registerIpcRouter(
    native.backend,
    {},
    secrets,
    undefined,
    { active: false } as never,
    gate,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.launch,
  );
  const handler = mocks.handlers.get(IPC.invoke) as (
    event: unknown,
    cmd: unknown,
    args: unknown,
  ) => Promise<Envelope>;
  const sender = fakeSender(7);
  const win = fakeWindow(70, sender);
  mocks.windows.set(sender, win);
  return {
    native,
    gate,
    sender,
    win,
    hasApiKey,
    invoke: (cmd, invokeArgs = {}, from = sender) =>
      handler({ sender: from }, cmd, invokeArgs),
  };
}

function valueOf(envelope: Envelope): Record<string, unknown> {
  if (!envelope.ok) throw new Error(`expected ok, got: ${envelope.error}`);
  return envelope.value as Record<string, unknown>;
}

const GATE_CLOSED = (command: string) => ({
  ok: true,
  value: {
    status:
      command === "nir1_local_generation_start" ? "unavailable" : "refused",
    reason: "NIR1_LOCAL_GATE_CLOSED",
  },
});

beforeEach(() => {
  mocks.app.isPackaged = true;
  mocks.app.getPath = () => "/nonexistent";
});

describe("the journey seam's launch (K5/3 必須防御 17, DR-DD1B-4)", () => {
  it("is active only with the exact environment of an unpackaged journey launch", () => {
    expect(parseNir1LocalGenerationCiSeam(activeLaunch())).toEqual({
      active: true,
      nonce: NONCE,
    });
    const userDataDir = journeyDir();
    for (const [label, launch] of [
      ["no CI", activeLaunch({}, { CI: undefined })],
      ["CI=1", activeLaunch({}, { CI: "1" })],
      [
        "other token",
        activeLaunch({}, { [NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN_ENV]: "x" }),
      ],
      [
        "the profile activation token",
        activeLaunch(
          {},
          {
            [NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN_ENV]:
              "da2-profile-activation-owner-v1",
          },
        ),
      ],
      [
        "no nonce",
        activeLaunch({}, { [NIR1_LOCAL_GENERATION_CI_NONCE_ENV]: undefined }),
      ],
      [
        "nonce not v4",
        activeLaunch(
          {},
          {
            [NIR1_LOCAL_GENERATION_CI_NONCE_ENV]:
              "8f14e45f-ceea-167e-a5d4-1b9c6d0e2f3a",
          },
        ),
      ],
      [
        "no journey userData",
        activeLaunch(
          {},
          { [NIR1_LOCAL_GENERATION_CI_USER_DATA_ENV]: undefined },
        ),
      ],
      [
        "relative userData",
        activeLaunch(
          {},
          { [NIR1_LOCAL_GENERATION_CI_USER_DATA_ENV]: "relative/dir" },
        ),
      ],
      [
        "userData of another launch",
        activeLaunch(
          {},
          { [NIR1_LOCAL_GENERATION_CI_USER_DATA_ENV]: userDataDir },
        ),
      ],
      [
        "the default userData",
        activeLaunch(
          {
            userDataDir,
            defaultUserDataDirs: () => [userDataDir],
          },
          { [NIR1_LOCAL_GENERATION_CI_USER_DATA_ENV]: userDataDir },
        ),
      ],
      [
        "defaults unreadable",
        activeLaunch({
          defaultUserDataDirs: () => {
            throw new Error("no home");
          },
        }),
      ],
      ["isPackaged unknown", activeLaunch({ isPackaged: undefined as never })],
    ] as const) {
      expect(parseNir1LocalGenerationCiSeam(launch), label).toEqual({
        active: false,
      });
    }
  });

  it("reads only own environment values and compares real directories (security P3-3, P3-4)", async () => {
    const { symlinkSync, mkdirSync } = await import("node:fs");
    // A seam value inherited through the prototype is not read.
    const launch = activeLaunch();
    expect(parseNir1LocalGenerationCiSeam(launch).active).toBe(true);
    expect(
      parseNir1LocalGenerationCiSeam({
        ...launch,
        env: Object.create(launch.env) as NodeJS.ProcessEnv,
      }),
    ).toEqual({ active: false });
    // A link to the launch's userData is the same directory …
    const root = journeyDir();
    const real = path.join(root, "user-data");
    mkdirSync(real);
    const link = path.join(root, "link");
    symlinkSync(real, link);
    expect(
      parseNir1LocalGenerationCiSeam(
        activeLaunch(
          { userDataDir: real },
          { [NIR1_LOCAL_GENERATION_CI_USER_DATA_ENV]: link },
        ),
      ).active,
    ).toBe(true);
    // … and a link to a default directory is still refused.
    expect(
      parseNir1LocalGenerationCiSeam(
        activeLaunch(
          { userDataDir: link, defaultUserDataDirs: () => [real] },
          { [NIR1_LOCAL_GENERATION_CI_USER_DATA_ENV]: link },
        ),
      ),
    ).toEqual({ active: false });
    // A default directory named through a linked parent is still the same
    // directory (security P3-1 of the re-review).
    const linkedParent = path.join(root, "linked-parent");
    symlinkSync(root, linkedParent);
    expect(
      parseNir1LocalGenerationCiSeam(
        activeLaunch(
          {
            userDataDir: real,
            defaultUserDataDirs: () => [path.join(linkedParent, "user-data")],
          },
          { [NIR1_LOCAL_GENERATION_CI_USER_DATA_ENV]: real },
        ),
      ),
    ).toEqual({ active: false });
    // A directory that does not resolve is inert.
    const missing = path.join(root, "missing");
    expect(
      parseNir1LocalGenerationCiSeam(
        activeLaunch(
          { userDataDir: missing },
          { [NIR1_LOCAL_GENERATION_CI_USER_DATA_ENV]: missing },
        ),
      ),
    ).toEqual({ active: false });
  });

  it("a packaged launch reads no environment value and no directory", () => {
    const defaultUserDataDirs = vi.fn(() => []);
    expect(
      parseNir1LocalGenerationCiSeam({
        isPackaged: true,
        env: untouchableEnv(),
        userDataDir: "/journey",
        defaultUserDataDirs,
      }),
    ).toEqual({ active: false });
    expect(defaultUserDataDirs).not.toHaveBeenCalled();
  });

  it("opens Native's entry once, and never for a packaged or inactive launch", () => {
    const open = vi.fn();
    const backend = { mainOpenPrePublicationGate: open };
    const seam = parseNir1LocalGenerationCiSeam(activeLaunch());
    expect(
      startNir1LocalGenerationCiSeam({ seam, backend, isPackaged: true }),
    ).toBe(false);
    expect(
      startNir1LocalGenerationCiSeam({
        seam: { active: false },
        backend,
        isPackaged: false,
      }),
    ).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(
      startNir1LocalGenerationCiSeam({ seam, backend, isPackaged: false }),
    ).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(NIR1_LOCAL_GENERATION_CI_GATE_ENTRY);
    const failing = {
      mainOpenPrePublicationGate: () => {
        throw new Error("MAIN_GATE_KIND");
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      startNir1LocalGenerationCiSeam({
        seam,
        backend: failing,
        isPackaged: false,
      }),
    ).toBe(false);
    error.mockRestore();
    expect(
      startNir1LocalGenerationCiSeam({
        seam,
        backend: null,
        isPackaged: false,
      }),
    ).toBe(false);
  });
});

describe("Main's gate (K5/3 必須防御 16, DR-DD1B-3)", () => {
  it("refuses the six commands in an ordinary launch before identity, D2a, the key store and Native", async () => {
    // The product passes no launch: the router reads Electron's `app`.
    mocks.app.isPackaged = false;
    const { native, invoke, hasApiKey } = await rig();
    for (const command of NIR1_LOCAL_GENERATION_COMMANDS) {
      expect(await invoke(command, ARGS[command]), command).toEqual(
        GATE_CLOSED(command),
      );
    }
    expect(native.calls).toEqual([]); // not even the caller registration
    expect(hasApiKey).not.toHaveBeenCalled();
  });

  it("stays closed in a packaged launch that carries the whole seam environment", async () => {
    // Through Electron's `app` (the product's path) …
    const userDataDir = journeyDir();
    mocks.app.isPackaged = true;
    mocks.app.getPath = () => userDataDir;
    const saved = { ...process.env };
    Object.assign(process.env, activeLaunch({ userDataDir }).env);
    try {
      const { native, invoke } = await rig();
      for (const command of NIR1_LOCAL_GENERATION_COMMANDS) {
        expect(await invoke(command, ARGS[command]), command).toEqual(
          GATE_CLOSED(command),
        );
      }
      expect(callsOf(native, "mainOpenPrePublicationGate")).toEqual([]);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    }
    // … and through an explicit packaged launch.
    const packaged = await rig({
      launch: { ...activeLaunch(), isPackaged: true },
    });
    for (const command of NIR1_LOCAL_GENERATION_COMMANDS) {
      expect(await packaged.invoke(command, ARGS[command])).toEqual(
        GATE_CLOSED(command),
      );
    }
    expect(callsOf(packaged.native, "mainOpenPrePublicationGate")).toEqual([]);
  });

  it("the seam launch opens Native's gate once and lets the commands through", async () => {
    const { native, invoke } = await rig({ launch: activeLaunch() });
    expect(callsOf(native, "mainOpenPrePublicationGate")).toEqual([
      [NIR1_LOCAL_GENERATION_CI_GATE_ENTRY],
    ]);
    expect(valueOf(await invoke("nir1_local_conversation_list"))).toEqual({
      status: "ok",
      conversations: [],
      truncated: false,
    });
  });

  it("a failed open leaves Main's gate closed as well", async () => {
    const native = fakeNative(true);
    (
      native.backend as unknown as Record<string, unknown>
    ).mainOpenPrePublicationGate = () => {
      throw new Error("MAIN_GATE_KIND");
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.handlers.clear();
    registerIpcRouter(
      native.backend,
      {},
      undefined,
      undefined,
      { active: false } as never,
      await createProfileEgressGate(native.backend),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      activeLaunch(),
    );
    error.mockRestore();
    const handler = mocks.handlers.get(IPC.invoke) as (
      ...args: unknown[]
    ) => Promise<Envelope>;
    expect(
      await handler(
        { sender: fakeSender(7) },
        "nir1_local_conversation_list",
        {},
      ),
    ).toEqual(GATE_CLOSED("nir1_local_conversation_list"));
    expect(routeCalls(native)).toEqual([]);
  });

  it("does not touch other commands", () => {
    const route = createNir1LocalGenerationRoute({
      open: false,
      backend: null,
    });
    for (const command of [
      "capture_current_chat_input",
      "cancel_current_chat_input",
      "main_nir1_local_generation_cancel_sender",
      "nir1_local_generation_restart",
    ]) {
      expect(route.gateRefusal(command), command).toBeNull();
    }
  });
});

describe("with the seam open (DR-DD1B-2, -5, -6, -7)", () => {
  it("refuses the route while unrestricted (nir1-restricted-only)", async () => {
    const { native, invoke } = await rig({
      restricted: false,
      launch: activeLaunch(),
    });
    for (const command of NIR1_LOCAL_GENERATION_COMMANDS) {
      const envelope = await invoke(command, ARGS[command]);
      expect(envelope.ok, command).toBe(false);
      if (!envelope.ok) {
        expect(envelope.error).toMatch(
          new RegExp(`^${D2A_EGRESS_DENIED_MARKER} nir1-restricted-only:`),
        );
      }
    }
    expect(routeCalls(native)).toEqual([]);
  });

  it("attaches Main's verdict for the active endpoint and Main's caller to the start", async () => {
    const { native, invoke, hasApiKey } = await rig({ launch: activeLaunch() });
    expect(valueOf(await invoke("nir1_local_generation_start", START))).toEqual(
      { status: "started", handle: HANDLE },
    );
    const [intent, verdict, caller] = callsOf(
      native,
      "nir1LocalGenerationStart",
    )[0];
    expect(intent).toEqual(START);
    expect(verdict).toEqual({ endpointId: "local-1", keyVerdict: "absent" });
    expect(JSON.parse(caller as string)).toMatchObject({ senderId: 7 });
    expect(hasApiKey).toHaveBeenCalledWith("openai-compatible", "local-1");
  });

  it("judges the key per endpoint id, the `default` endpoint including the legacy account", async () => {
    const storage: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "gnome_libsecret",
      encryptString: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
      decryptString: (buffer) => buffer.toString("utf8").slice(4),
    };
    const verdictFor = async (
      endpointId: string,
      save: (store: ReturnType<typeof createKeyStore>) => void,
    ): Promise<unknown> => {
      const store = createKeyStore(journeyDir(), storage, "linux");
      save(store);
      const { native, invoke } = await rig({
        launch: activeLaunch(),
        secrets: store,
      });
      native.settings = {
        provider: "openai-compatible",
        activeOpenaiCompatibleEndpointId: endpointId,
      };
      await invoke("nir1_local_generation_start", START);
      return callsOf(native, "nir1LocalGenerationStart")[0]?.[1];
    };
    // The endpoint's own account.
    expect(
      await verdictFor("local-1", (store) =>
        store.saveApiKey("openai-compatible", "local-1", "sk"),
      ),
    ).toEqual({ endpointId: "local-1", keyVerdict: "present" });
    // The legacy account counts for `default` only.
    expect(
      await verdictFor("default", (store) =>
        store.saveApiKey("openai-compatible", null, "sk"),
      ),
    ).toEqual({ endpointId: "default", keyVerdict: "present" });
    expect(
      await verdictFor("local-1", (store) =>
        store.saveApiKey("openai-compatible", null, "sk"),
      ),
    ).toEqual({ endpointId: "local-1", keyVerdict: "absent" });
    // Another endpoint's key is not this endpoint's.
    expect(
      await verdictFor("local-1", (store) =>
        store.saveApiKey("openai-compatible", "local-2", "sk"),
      ),
    ).toEqual({ endpointId: "local-1", keyVerdict: "absent" });
  });

  it("a failed key check is check-failed, and no endpoint id is Main's typed refusal", async () => {
    const failing = await rig({
      launch: activeLaunch(),
      secrets: {
        resolveApiKeyForRequest: () => "",
        hasApiKey: () => {
          throw new Error("API キーストアを読み込めません");
        },
      },
    });
    await failing.invoke("nir1_local_generation_start", START);
    expect(callsOf(failing.native, "nir1LocalGenerationStart")[0][1]).toEqual({
      endpointId: "local-1",
      keyVerdict: "check-failed",
    });
    const noWindow = await rig({ launch: activeLaunch(), secrets: null });
    await noWindow.invoke("nir1_local_generation_start", START);
    expect(callsOf(noWindow.native, "nir1LocalGenerationStart")[0][1]).toEqual({
      endpointId: "local-1",
      keyVerdict: "check-failed",
    });
    for (const settings of [
      { provider: "openai-compatible" },
      { activeOpenaiCompatibleEndpointId: " local-1" },
      { activeOpenaiCompatibleEndpointId: 7 },
      "not json object",
    ]) {
      const { native, invoke } = await rig({ launch: activeLaunch() });
      native.settings = settings;
      expect(await invoke("nir1_local_generation_start", START)).toEqual({
        ok: true,
        value: {
          status: "unavailable",
          reason: "NIR1_LOCAL_ENDPOINT_UNAVAILABLE",
        },
      });
      expect(callsOf(native, "nir1LocalGenerationStart")).toEqual([]);
    }
  });

  it("a key check that is not a synchronous boolean is check-failed (lifecycle P3-8)", async () => {
    for (const answer of [Promise.resolve(false), undefined, "no"]) {
      const { native, invoke } = await rig({
        launch: activeLaunch(),
        secrets: {
          resolveApiKeyForRequest: () => "",
          hasApiKey: () => answer as unknown as boolean,
        },
      });
      await invoke("nir1_local_generation_start", START);
      expect(
        callsOf(native, "nir1LocalGenerationStart")[0][1],
        String(answer),
      ).toEqual({ endpointId: "local-1", keyVerdict: "check-failed" });
    }
  });

  it("a renderer cannot supply the verdict", async () => {
    const { native, invoke } = await rig({ launch: activeLaunch() });
    const envelope = await invoke("nir1_local_generation_start", {
      ...START,
      keyVerdict: "absent",
    });
    expect(envelope.ok).toBe(false);
    expect(callsOf(native, "nir1LocalGenerationStart")).toEqual([]);
  });

  it("checks the sender, its own window and the caller before Native", async () => {
    const { native, invoke, sender, win } = await rig({
      launch: activeLaunch(),
    });
    const refused = {
      ok: true,
      value: { status: "refused", reason: "NIR1_LOCAL_SENDER_REFUSED" },
    };
    // A sender without a window.
    const orphan = fakeSender(9);
    expect(await invoke("nir1_local_conversation_list", {}, orphan)).toEqual(
      refused,
    );
    // A sender inside another sender's window (not that window's own page).
    const embedded = fakeSender(10);
    mocks.windows.set(embedded, win);
    expect(await invoke("nir1_local_conversation_list", {}, embedded)).toEqual(
      refused,
    );
    // A destroyed window.
    win.destroyed = true;
    expect(await invoke("nir1_local_conversation_list")).toEqual(refused);
    win.destroyed = false;
    // A destroyed sender.
    sender.destroyed = true;
    expect(await invoke("nir1_local_generation_start", START)).toEqual({
      ok: true,
      value: { status: "unavailable", reason: "NIR1_LOCAL_SENDER_REFUSED" },
    });
    sender.destroyed = false;
    expect(routeCalls(native)).toEqual([]);
    expect(valueOf(await invoke("nir1_local_conversation_list")).status).toBe(
      "ok",
    );
  });

  it("binds a handle to the sender that started it", async () => {
    const { native, invoke } = await rig({ launch: activeLaunch() });
    expect(valueOf(await invoke("nir1_local_generation_start", START))).toEqual(
      { status: "started", handle: HANDLE },
    );
    expect(
      valueOf(
        await invoke("nir1_local_generation_continue", { handle: HANDLE }),
      ).state,
    ).toBe("running");
    const other = fakeSender(8);
    mocks.windows.set(other, fakeWindow(80, other));
    for (const command of [
      "nir1_local_generation_continue",
      "nir1_local_generation_cancel",
    ]) {
      expect(await invoke(command, { handle: HANDLE }, other), command).toEqual(
        {
          ok: true,
          value: { status: "refused", reason: "NIR1_LOCAL_HANDLE_NOT_FOUND" },
        },
      );
    }
    // An unknown handle never reaches Native either.
    expect(
      await invoke("nir1_local_generation_continue", {
        handle: "f".repeat(32),
      }),
    ).toEqual({
      ok: true,
      value: { status: "refused", reason: "NIR1_LOCAL_HANDLE_NOT_FOUND" },
    });
    expect(callsOf(native, "nir1LocalGenerationContinue")).toHaveLength(1);
    expect(callsOf(native, "nir1LocalGenerationCancel")).toHaveLength(0);
  });

  it("drops the binding when drained, Native no longer knows it, or a cancel's capture is settled", async () => {
    const { native, invoke } = await rig({ launch: activeLaunch() });
    await invoke("nir1_local_generation_start", START);
    native.answer.nir1LocalGenerationContinue = {
      status: "ok",
      text: "",
      thinking: "",
      state: "succeeded",
      reason: "stop",
      drained: true,
    };
    await invoke("nir1_local_generation_continue", { handle: HANDLE });
    expect(
      valueOf(
        await invoke("nir1_local_generation_continue", { handle: HANDLE }),
      ).reason,
    ).toBe("NIR1_LOCAL_HANDLE_NOT_FOUND");
    expect(callsOf(native, "nir1LocalGenerationContinue")).toHaveLength(1);

    // A cancel whose capture writer failed keeps the handle through a drained
    // continue so it can be retried (DR-DD1A-15).
    await invoke("nir1_local_generation_start", START);
    native.answer.nir1LocalGenerationCancel = {
      status: "refused",
      reason: "NIR1_LOCAL_CANCEL_CAPTURE_FAILED",
    };
    await invoke("nir1_local_generation_cancel", { handle: HANDLE });
    await invoke("nir1_local_generation_continue", { handle: HANDLE });
    native.answer.nir1LocalGenerationCancel = { status: "ok" };
    expect(
      valueOf(await invoke("nir1_local_generation_cancel", { handle: HANDLE })),
    ).toEqual({ status: "ok" });
    expect(callsOf(native, "nir1LocalGenerationCancel")).toHaveLength(2);

    native.answer.nir1LocalGenerationContinue = {
      status: "refused",
      reason: "NIR1_LOCAL_CALLER_REVOKED",
    };
    await invoke("nir1_local_generation_continue", { handle: HANDLE });
    expect(
      valueOf(await invoke("nir1_local_generation_cancel", { handle: HANDLE }))
        .reason,
    ).toBe("NIR1_LOCAL_HANDLE_NOT_FOUND");
  });

  it("stops the sender's generations when it is destroyed or its window closes", async () => {
    const { native, invoke, sender, win } = await rig({
      launch: activeLaunch(),
    });
    await invoke("nir1_local_generation_start", START);
    await invoke("nir1_local_conversation_list");
    // One listener each, whatever the number of invokes.
    expect(sender.listenerCount("destroyed")).toBe(1);
    expect(win.listenerCount("closed")).toBe(1);
    win.emit("closed");
    expect(callsOf(native, "mainNir1LocalGenerationCancelSender")).toEqual([
      [7],
    ]);
    // The binding is gone with the stop.
    expect(
      valueOf(
        await invoke("nir1_local_generation_continue", { handle: HANDLE }),
      ).reason,
    ).toBe("NIR1_LOCAL_HANDLE_NOT_FOUND");
    sender.emit("destroyed");
    expect(callsOf(native, "mainNir1LocalGenerationCancelSender")).toEqual([
      [7],
      [7],
    ]);
  });

  it("a completion check that refuses a start stops the sender's generations (DR-DD1B-7)", async () => {
    const { native, invoke } = await rig({
      launch: activeLaunch(),
      wrapGate: (real) => ({
        restricted: real.restricted,
        unavailable: real.unavailable,
        issueCallerIdentity: (senderId) => real.issueCallerIdentity(senderId),
        isIssuedCallerIdentity: (identity) =>
          real.isIssuedCallerIdentity?.(identity) ?? false,
        assertInvoke: (command, args) => real.assertInvoke(command, args),
        assertPlaintextPublication: (command, args) => {
          if (command === "nir1_local_generation_start") {
            throw new Error(
              `${D2A_EGRESS_DENIED_MARKER} nir1-restricted-only: route ${command} completed after profile restriction began`,
            );
          }
          real.assertPlaintextPublication(command, args);
        },
        allowsBackendEvent: () => true,
        assertExternalUrl: () => undefined,
        registerMainEgressParticipant: () => undefined,
      }),
    });
    const envelope = await invoke("nir1_local_generation_start", START);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error).not.toContain(HANDLE);
    expect(callsOf(native, "mainNir1LocalGenerationCancelSender")).toEqual([
      [7],
    ]);
    // The unpublished handle was never bound.
    expect(
      valueOf(
        await invoke("nir1_local_generation_continue", { handle: HANDLE }),
      ).reason,
    ).toBe("NIR1_LOCAL_HANDLE_NOT_FOUND");
  });

  it("a replaced caller or a status change stops what the old caller started", async () => {
    const listeners: Array<() => void> = [];
    const cancelSender = vi.fn(() => 1);
    const issued = new Set<unknown>();
    const route = createNir1LocalGenerationRoute({
      open: true,
      backend: {
        mainNir1LocalGenerationCancelSender: cancelSender,
        getAiSettings: async () =>
          JSON.stringify({ activeOpenaiCompatibleEndpointId: "local-1" }),
      } as unknown as NapiBackendLike,
      secrets: { resolveApiKeyForRequest: () => "", hasApiKey: () => false },
      profileEgress: {
        isIssuedCallerIdentity: (identity) => issued.has(identity),
        onStatusChange: (listener) => {
          listeners.push(() => listener({ state: "restricted" }));
          return () => undefined;
        },
      },
    });
    const sender = fakeSender(7);
    const win = fakeWindow(70, sender);
    const first = { senderId: 7, callerEpoch: 4 };
    const second = { senderId: 7, callerEpoch: 5 };
    issued.add(first);
    issued.add(second);
    const context = (callerIdentity: unknown) => ({
      sender,
      win,
      callerIdentity,
    });
    const firstContext = context(first);
    expect(
      await route.admit("nir1_local_conversation_list", firstContext, {}),
    ).toBeNull();
    route.settle(
      "nir1_local_generation_start",
      firstContext,
      {},
      { ok: true, value: { status: "started", handle: HANDLE } },
    );
    expect(cancelSender).not.toHaveBeenCalled();
    // The same sender with a new identity: the old one's work stops first,
    // and the old handle is no longer reachable.
    expect(
      await route.admit("nir1_local_generation_continue", context(second), {
        handle: HANDLE,
      }),
    ).toEqual({
      ok: true,
      value: { status: "refused", reason: "NIR1_LOCAL_HANDLE_NOT_FOUND" },
    });
    expect(cancelSender).toHaveBeenCalledTimes(1);
    expect(cancelSender).toHaveBeenCalledWith(7);
    // A profile status change stops every bound sender, and never throws.
    cancelSender.mockImplementation(() => {
      throw new Error("native gone");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => listeners.forEach((listener) => listener())).not.toThrow();
    warn.mockRestore();
    expect(cancelSender).toHaveBeenCalledTimes(2);
  });

  it("stops every bound sender, and a failing stop never blocks the others (lifecycle P2-1)", async () => {
    const listeners: Array<() => void> = [];
    const stopped: number[] = [];
    const route = createNir1LocalGenerationRoute({
      open: true,
      backend: {
        mainNir1LocalGenerationCancelSender: (senderId: number) => {
          stopped.push(senderId);
          if (senderId === 7) throw new Error("native gone");
          return 0;
        },
      } as unknown as NapiBackendLike,
      profileEgress: {
        isIssuedCallerIdentity: () => true,
        onStatusChange: (listener) => {
          listeners.push(() => listener({ state: "restricted" }));
          return () => undefined;
        },
      },
    });
    const senders = [7, 8, 9].map((id) => {
      const sender = fakeSender(id);
      return { sender, win: fakeWindow(id * 10, sender) };
    });
    for (const { sender, win } of senders) {
      expect(
        await route.admit(
          "nir1_local_conversation_list",
          { sender, win, callerIdentity: { senderId: sender.id } },
          {},
        ),
      ).toBeNull();
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => listeners.forEach((listener) => listener())).not.toThrow();
      expect([...stopped].sort()).toEqual([7, 8, 9]);
      // A throwing stop inside the destroyed and closed listeners does not
      // escape them.
      stopped.length = 0;
      expect(() => senders[0].win.emit("closed")).not.toThrow();
      expect(() => senders[0].sender.emit("destroyed")).not.toThrow();
      expect(stopped).toEqual([7, 7]);
      // The destroyed sender is no longer bound; the others still are.
      stopped.length = 0;
      listeners.forEach((listener) => listener());
      expect([...stopped].sort()).toEqual([8, 9]);
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses an identity Main did not issue, or issued to another sender (defense in depth behind D2a)", async () => {
    const issued = { senderId: 7 };
    const route = createNir1LocalGenerationRoute({
      open: true,
      backend: null,
      profileEgress: {
        isIssuedCallerIdentity: (identity) => identity === issued,
      },
    });
    const sender = fakeSender(7);
    const win = fakeWindow(70, sender);
    const refused = {
      ok: true,
      value: { status: "refused", reason: "NIR1_LOCAL_SENDER_REFUSED" },
    };
    for (const callerIdentity of [
      { senderId: 7 }, // a copy, not the issued object
      { ...issued, senderId: 8 },
      null,
      "caller",
    ]) {
      expect(
        await route.admit(
          "nir1_local_conversation_list",
          { sender, win, callerIdentity },
          {},
        ),
        JSON.stringify(callerIdentity),
      ).toEqual(refused);
    }
    expect(
      await route.admit(
        "nir1_local_conversation_list",
        { sender, win, callerIdentity: issued },
        {},
      ),
    ).toBeNull();
  });

  it("a stop by a status change while a start's verdict is pending refuses that start (the stop count)", async () => {
    const listeners: Array<() => void> = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stopped: number[] = [];
    const route = createNir1LocalGenerationRoute({
      open: true,
      backend: {
        getAiSettings: async () => {
          await pending;
          return JSON.stringify({
            activeOpenaiCompatibleEndpointId: "local-1",
          });
        },
        mainNir1LocalGenerationCancelSender: (senderId: number) => {
          stopped.push(senderId);
          return 0;
        },
      } as unknown as NapiBackendLike,
      secrets: { resolveApiKeyForRequest: () => "", hasApiKey: () => false },
      profileEgress: {
        isIssuedCallerIdentity: () => true,
        onStatusChange: (listener) => {
          listeners.push(() =>
            listener({ state: "unavailable", reason: "activation-failed" }),
          );
          return () => undefined;
        },
      },
    });
    const sender = fakeSender(7);
    const win = fakeWindow(70, sender);
    const admitted = route.admit(
      "nir1_local_generation_start",
      { sender, win, callerIdentity: { senderId: 7 } },
      {},
    );
    listeners.forEach((listener) => listener()); // the sender stays alive
    release();
    expect(await admitted).toEqual({
      ok: true,
      value: { status: "unavailable", reason: "NIR1_LOCAL_SENDER_REFUSED" },
    });
    expect(stopped).toEqual([7]);
  });

  it("the first start after a replaced caller goes through (N8)", async () => {
    const stopped: number[] = [];
    const route = createNir1LocalGenerationRoute({
      open: true,
      backend: {
        getAiSettings: async () =>
          JSON.stringify({ activeOpenaiCompatibleEndpointId: "local-1" }),
        mainNir1LocalGenerationCancelSender: (senderId: number) => {
          stopped.push(senderId);
          return 0;
        },
      } as unknown as NapiBackendLike,
      secrets: { resolveApiKeyForRequest: () => "", hasApiKey: () => false },
      profileEgress: { isIssuedCallerIdentity: () => true },
    });
    const sender = fakeSender(7);
    const win = fakeWindow(70, sender);
    expect(
      await route.admit(
        "nir1_local_conversation_list",
        { sender, win, callerIdentity: { senderId: 7, epoch: 1 } },
        {},
      ),
    ).toBeNull();
    const replaced = { sender, win, callerIdentity: { senderId: 7, epoch: 2 } };
    expect(
      await route.admit("nir1_local_generation_start", replaced, {}),
    ).toBeNull();
    expect(stopped).toEqual([7]); // the old caller's work was stopped
    expect(
      route.settle(
        "nir1_local_generation_start",
        replaced,
        {},
        {
          ok: true,
          value: { status: "started", handle: HANDLE },
        },
      ),
    ).toEqual({ ok: true, value: { status: "started", handle: HANDLE } });
    expect(
      await route.admit("nir1_local_generation_continue", replaced, {
        handle: HANDLE,
      }),
    ).toBeNull();
  });

  it("a running continue does not make a binding settled (N9)", async () => {
    const issued = { senderId: 7 };
    const route = createNir1LocalGenerationRoute({
      open: true,
      backend: null,
      profileEgress: {
        isIssuedCallerIdentity: (identity) => identity === issued,
      },
    });
    const sender = fakeSender(7);
    const win = fakeWindow(70, sender);
    const context = { sender, win, callerIdentity: issued };
    await route.admit("nir1_local_conversation_list", context, {});
    const handleOf = (index: number) => index.toString(16).padStart(32, "0");
    for (let index = 0; index < 64; index++) {
      route.settle(
        "nir1_local_generation_start",
        context,
        {},
        {
          ok: true,
          value: { status: "started", handle: handleOf(index) },
        },
      );
    }
    route.settle(
      "nir1_local_generation_continue",
      context,
      { handle: handleOf(5) },
      {
        ok: true,
        value: {
          status: "ok",
          text: "x",
          thinking: "",
          state: "running",
          drained: false,
        },
      },
    );
    route.settle(
      "nir1_local_generation_start",
      context,
      {},
      {
        ok: true,
        value: { status: "started", handle: handleOf(64) },
      },
    );
    const reachable = async (index: number) =>
      (await route.admit("nir1_local_generation_continue", context, {
        handle: handleOf(index),
      })) === null;
    expect(await reachable(5)).toBe(true);
    expect(await reachable(0)).toBe(false);
  });

  it("forgets a destroyed sender entirely (lifecycle P3-3)", async () => {
    const route = createNir1LocalGenerationRoute({
      open: true,
      backend: null,
      profileEgress: { isIssuedCallerIdentity: () => true },
    });
    const sender = fakeSender(7);
    const win = fakeWindow(70, sender);
    await route.admit(
      "nir1_local_conversation_list",
      { sender, win, callerIdentity: { senderId: 7 } },
      {},
    );
    win.emit("closed");
    expect(route.trackedSendersForTest()).toEqual({
      live: 1,
      identities: 1,
      stopCounts: 1,
    });
    sender.destroyed = true;
    sender.emit("destroyed");
    expect(route.trackedSendersForTest()).toEqual({
      live: 0,
      identities: 0,
      stopCounts: 0,
    });
  });

  it("keeps at most 64 handle bindings, dropping a settled one first and a running one last", async () => {
    const issued = { senderId: 7 };
    const route = createNir1LocalGenerationRoute({
      open: true,
      backend: null,
      profileEgress: {
        isIssuedCallerIdentity: (identity) => identity === issued,
      },
    });
    const sender = fakeSender(7);
    const win = fakeWindow(70, sender);
    const context = { sender, win, callerIdentity: issued };
    expect(
      await route.admit("nir1_local_conversation_list", context, {}),
    ).toBeNull();
    const handleOf = (index: number) => index.toString(16).padStart(32, "0");
    const start = (index: number) =>
      route.settle(
        "nir1_local_generation_start",
        context,
        {},
        {
          ok: true,
          value: { status: "started", handle: handleOf(index) },
        },
      );
    const reachable = async (index: number) =>
      (await route.admit("nir1_local_generation_continue", context, {
        handle: handleOf(index),
      })) === null;
    for (let index = 0; index < 64; index++) start(index);
    // 5 is final (not drained) and 9 had its cancel accepted: settled.
    route.settle(
      "nir1_local_generation_continue",
      context,
      { handle: handleOf(5) },
      {
        ok: true,
        value: {
          status: "ok",
          text: "x",
          thinking: "",
          state: "failed",
          drained: false,
        },
      },
    );
    route.settle(
      "nir1_local_generation_cancel",
      context,
      { handle: handleOf(9) },
      { ok: true, value: { status: "ok" } },
    );
    start(64);
    expect(await reachable(5)).toBe(false);
    expect(await reachable(0)).toBe(true); // the oldest, running, stays
    start(65);
    expect(await reachable(9)).toBe(false);
    expect(await reachable(0)).toBe(true);
    // No settled binding left: the oldest goes.
    start(66);
    expect(await reachable(0)).toBe(false);
    expect(await reachable(66)).toBe(true);
  });

  it("keeps the bindings in step with Native (M2, M3, M4, M6)", async () => {
    const { native, invoke, sender, win } = await rig({
      launch: activeLaunch(),
    });
    const continues = () =>
      callsOf(native, "nir1LocalGenerationContinue").length;
    const cancels = () => callsOf(native, "nir1LocalGenerationCancel").length;
    // M3: Native no longer knows the handle → Main forgets it.
    await invoke("nir1_local_generation_start", START);
    native.answer.nir1LocalGenerationContinue = {
      status: "refused",
      reason: "NIR1_LOCAL_HANDLE_NOT_FOUND",
    };
    await invoke("nir1_local_generation_continue", { handle: HANDLE });
    await invoke("nir1_local_generation_continue", { handle: HANDLE });
    expect(continues()).toBe(1);

    // M2: a retried cancel that succeeds clears the pending withdrawal, so
    // the drained continue drops the binding.
    await invoke("nir1_local_generation_start", START);
    native.answer.nir1LocalGenerationCancel = {
      status: "refused",
      reason: "NIR1_LOCAL_CANCEL_CAPTURE_FAILED",
    };
    await invoke("nir1_local_generation_cancel", { handle: HANDLE });
    native.answer.nir1LocalGenerationCancel = { status: "ok" };
    await invoke("nir1_local_generation_cancel", { handle: HANDLE });
    native.answer.nir1LocalGenerationContinue = {
      status: "ok",
      text: "",
      thinking: "",
      state: "cancelled",
      reason: "cancelled",
      drained: true,
    };
    await invoke("nir1_local_generation_continue", { handle: HANDLE });
    const before = continues();
    await invoke("nir1_local_generation_continue", { handle: HANDLE });
    expect(continues()).toBe(before);

    // M6: the sender stop drops a binding with a pending withdrawal too.
    await invoke("nir1_local_generation_start", START);
    native.answer.nir1LocalGenerationCancel = {
      status: "refused",
      reason: "NIR1_LOCAL_CANCEL_CAPTURE_FAILED",
    };
    await invoke("nir1_local_generation_cancel", { handle: HANDLE });
    const cancelsBefore = cancels();
    win.emit("closed");
    await invoke("nir1_local_generation_cancel", { handle: HANDLE });
    expect(cancels()).toBe(cancelsBefore);

    // M4: a destroyed sender's identity is forgotten; a later sender with
    // the same id and another identity triggers no extra stop.
    sender.destroyed = true;
    sender.emit("destroyed");
    const stops = callsOf(native, "mainNir1LocalGenerationCancelSender").length;
    const route = createNir1LocalGenerationRoute({
      open: true,
      backend: native.backend,
      profileEgress: { isIssuedCallerIdentity: () => true },
    });
    const reused = fakeSender(7);
    const reusedWin = fakeWindow(71, reused);
    await route.admit(
      "nir1_local_conversation_list",
      { sender: reused, win: reusedWin, callerIdentity: { senderId: 7, n: 1 } },
      {},
    );
    reused.destroyed = true;
    reused.emit("destroyed");
    const afterDestroy = callsOf(
      native,
      "mainNir1LocalGenerationCancelSender",
    ).length;
    expect(afterDestroy).toBe(stops + 1);
    const again = fakeSender(7);
    await route.admit(
      "nir1_local_conversation_list",
      {
        sender: again,
        win: fakeWindow(72, again),
        callerIdentity: { senderId: 7, n: 2 },
      },
      {},
    );
    expect(callsOf(native, "mainNir1LocalGenerationCancelSender").length).toBe(
      afterDestroy,
    );
  });
});

describe("races between a pending start and the sender's end (lifecycle review P1-1, P2-2)", () => {
  function deferred(): { promise: Promise<void>; release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }
  const stops = (native: FakeNative) =>
    callsOf(native, "mainNir1LocalGenerationCancelSender").length;

  for (const end of ["destroyed", "closed"] as const) {
    it(`a sender ${end} during Main's key verdict is refused before Native (RACE1)`, async () => {
      const { native, invoke, sender, win } = await rig({
        launch: activeLaunch(),
      });
      await invoke("nir1_local_conversation_list"); // binds the listeners
      const pending = deferred();
      native.hold.getAiSettings = pending.promise;
      const started = invoke("nir1_local_generation_start", START);
      await vi.waitFor(() =>
        expect(callsOf(native, "getAiSettings")).toHaveLength(1),
      );
      if (end === "destroyed") {
        sender.destroyed = true;
        sender.emit("destroyed");
      } else {
        win.destroyed = true;
        win.emit("closed");
      }
      pending.release();
      expect(await started).toEqual({
        ok: true,
        value: { status: "unavailable", reason: "NIR1_LOCAL_SENDER_REFUSED" },
      });
      expect(callsOf(native, "nir1LocalGenerationStart")).toEqual([]);
    });
  }

  it("a sender destroyed during Native's start: the handle is not returned and the generation is stopped (RACE3)", async () => {
    const { native, invoke, sender } = await rig({ launch: activeLaunch() });
    await invoke("nir1_local_conversation_list");
    const pending = deferred();
    native.hold.nir1LocalGenerationStart = pending.promise;
    const started = invoke("nir1_local_generation_start", START);
    await vi.waitFor(() =>
      expect(callsOf(native, "nir1LocalGenerationStart")).toHaveLength(1),
    );
    sender.destroyed = true;
    sender.emit("destroyed");
    const stopsAtDestroy = stops(native);
    pending.release();
    const envelope = await started;
    expect(JSON.stringify(envelope)).not.toContain(HANDLE);
    // Stopped again once Native's entry exists.
    expect(stops(native)).toBeGreaterThan(stopsAtDestroy);
  });

  it("a window closed during Native's start stops the generation too (RACE3)", async () => {
    const { native, invoke, win } = await rig({ launch: activeLaunch() });
    await invoke("nir1_local_conversation_list");
    const pending = deferred();
    native.hold.nir1LocalGenerationStart = pending.promise;
    const started = invoke("nir1_local_generation_start", START);
    await vi.waitFor(() =>
      expect(callsOf(native, "nir1LocalGenerationStart")).toHaveLength(1),
    );
    win.destroyed = true;
    win.emit("closed");
    const stopsAtClose = stops(native);
    pending.release();
    expect(JSON.stringify(await started)).not.toContain(HANDLE);
    expect(stops(native)).toBeGreaterThan(stopsAtClose);
  });

  it("a start answer Main refuses as malformed still stops what Native started (RACE4)", async () => {
    const { native, invoke } = await rig({ launch: activeLaunch() });
    native.answer.nir1LocalGenerationStart = {
      status: "started",
      handle: HANDLE,
      extra: 1,
    };
    const envelope = await invoke("nir1_local_generation_start", START);
    expect(envelope.ok).toBe(false);
    expect(stops(native)).toBe(1);
    // A start refused before Native (a malformed request) stops nothing.
    await invoke("nir1_local_generation_start", { ...START, purpose: "x" });
    expect(stops(native)).toBe(1);
  });
  it("Main's refusal of an answer stops the sender's other generations too (X1, recorded)", async () => {
    const { native, invoke } = await rig({ launch: activeLaunch() });
    // H: a running generation bound to the sender.
    expect(
      valueOf(await invoke("nir1_local_generation_start", START)).status,
    ).toBe("started");
    const stopsBefore = stops(native);
    // A: a start whose answer Main refuses; B: a start pending its verdict.
    const atNative = deferred();
    native.hold.nir1LocalGenerationStart = atNative.promise;
    native.answer.nir1LocalGenerationStart = {
      status: "started",
      handle: "f".repeat(32),
      extra: 1,
    };
    const a = invoke("nir1_local_generation_start", START);
    await vi.waitFor(() =>
      expect(callsOf(native, "nir1LocalGenerationStart")).toHaveLength(2),
    );
    const atVerdict = deferred();
    native.hold.getAiSettings = atVerdict.promise;
    const b = invoke("nir1_local_generation_start", START);
    await vi.waitFor(() =>
      expect(callsOf(native, "getAiSettings")).toHaveLength(3),
    );
    atNative.release();
    expect((await a).ok).toBe(false);
    expect(stops(native)).toBe(stopsBefore + 1);
    atVerdict.release();
    expect(await b).toEqual({
      ok: true,
      value: { status: "unavailable", reason: "NIR1_LOCAL_SENDER_REFUSED" },
    });
    // H's binding went with the stop.
    expect(
      valueOf(
        await invoke("nir1_local_generation_continue", { handle: HANDLE }),
      ).reason,
    ).toBe("NIR1_LOCAL_HANDLE_NOT_FOUND");
    expect(callsOf(native, "nir1LocalGenerationContinue")).toEqual([]);
  });

  it("a start answer that is not JSON is refused like a malformed one and stops what Native started (lifecycle P3-2)", async () => {
    const { native, invoke } = await rig({ launch: activeLaunch() });
    native.answer.nir1LocalGenerationStart = { __raw: "started:" + HANDLE };
    const envelope = await invoke("nir1_local_generation_start", START);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error).not.toContain(HANDLE);
    expect(stops(native)).toBe(1);
  });
});
