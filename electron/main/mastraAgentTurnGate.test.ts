// MP-3b (DR-MP3-2, -4, -17): Main's gate L of the Mastra agent turn route and
// its journey seam, through the real router and the real profile gate with a
// mocked Native backend. The gate is Main's only: there is no Native entry, and
// with the gate open a start is still not run (the owner is 3c's).
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IPC,
  type Envelope,
  type NapiBackendLike,
} from "../shared/ipcContract.js";
import {
  MASTRA_AGENT_TURN_COMMANDS,
  MASTRA_AGENT_TURN_START_COMMAND,
  MASTRA_AGENT_TURN_CANCEL_COMMAND,
} from "../shared/mastraAgentTurnWire.js";
import { nativeSqlPolicyV2 } from "./d2aSqlPolicyFixture.js";
import {
  createMastraAgentTurnRoute,
  type MastraAgentTurnOwnerPort,
  MASTRA_AGENT_TURN_CI_ENV_NAMES,
  MASTRA_AGENT_TURN_CI_NONCE_ENV,
  MASTRA_AGENT_TURN_CI_OWNER_TOKEN,
  MASTRA_AGENT_TURN_CI_OWNER_TOKEN_ENV,
  MASTRA_AGENT_TURN_CI_USER_DATA_ENV,
  openMastraAgentTurnGate,
  parseMastraAgentTurnCiSeam,
  type MastraAgentTurnLaunch,
} from "./mastraAgentTurnGate.js";
import {
  NIR1_LOCAL_GENERATION_CI_NONCE_ENV,
  NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN,
  NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN_ENV,
  parseNir1LocalGenerationCiSeam,
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
const TURN_ID = "0b9a2f5e-1c3d-4e6f-8a7b-9c0d1e2f3a4b";

const START = {
  turnId: TURN_ID,
  chatSessionId: "session-1",
  messages: [
    { role: "system", content: "You write." },
    { role: "user", content: "Continue." },
  ],
  route: {
    provider: "anthropic",
    model: "claude-x",
    endpointId: null,
    apiVariant: null,
    expectedOllamaEndpoint: null,
    thinking: null,
    effort: null,
    reasoningEnabled: null,
    reasoningEffort: null,
    webSearch: null,
  },
  systemCacheSegments: null,
  systemVolatileTail: null,
  tools: [],
};
const CANCEL = { turnId: TURN_ID };
const ARGS: Record<string, Record<string, unknown>> = {
  [MASTRA_AGENT_TURN_START_COMMAND]: START,
  [MASTRA_AGENT_TURN_CANCEL_COMMAND]: CANCEL,
};

function journeyDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-mp3b-"));
  roots.push(root);
  return root;
}

function activeLaunch(
  overrides: Partial<MastraAgentTurnLaunch> = {},
  env: NodeJS.ProcessEnv = {},
): MastraAgentTurnLaunch {
  const userDataDir = overrides.userDataDir ?? journeyDir();
  return {
    isPackaged: false,
    env: {
      CI: "true",
      [MASTRA_AGENT_TURN_CI_OWNER_TOKEN_ENV]: MASTRA_AGENT_TURN_CI_OWNER_TOKEN,
      [MASTRA_AGENT_TURN_CI_NONCE_ENV]: NONCE,
      [MASTRA_AGENT_TURN_CI_USER_DATA_ENV]: userDataDir,
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
  };
  return sender;
}

function fakeWindow(id: number, webContents: unknown) {
  const win = {
    id,
    destroyed: false,
    webContents,
    isDestroyed() {
      return this.destroyed;
    },
    once() {
      return win;
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

interface Rig {
  calls: string[];
  gate: ProfileEgressGate;
  issued: ReturnType<typeof vi.fn>;
  asserted: ReturnType<typeof vi.fn>;
  invoke: (
    cmd: string,
    args?: Record<string, unknown>,
    sender?: ReturnType<typeof fakeSender>,
  ) => Promise<Envelope>;
  sender: ReturnType<typeof fakeSender>;
  win: ReturnType<typeof fakeWindow>;
}

async function rig(
  options: {
    restricted?: boolean;
    launch?: MastraAgentTurnLaunch;
    wrapGate?: (gate: ProfileEgressGate) => ProfileEgressGate;
    owner?: MastraAgentTurnOwnerPort;
  } = {},
): Promise<Rig> {
  mocks.handlers.clear();
  mocks.windows.clear();
  const calls: string[] = [];
  const record =
    (name: string, result?: () => unknown) =>
    (..._args: unknown[]) => {
      calls.push(name);
      return result?.();
    };
  const backend = {
    initializeProfileEgress: async () =>
      JSON.stringify(status(options.restricted ?? false)),
    registerProfileEgressCaller: record("registerProfileEgressCaller"),
    invalidateProfileEgressCallers: () => undefined,
    getAiSettings: async () => {
      calls.push("getAiSettings");
      return "{}";
    },
    mainOpenPrePublicationGate: record("mainOpenPrePublicationGate"),
    sendAgentMessage: record("sendAgentMessage"),
    aiAuditAppendBatch: record("aiAuditAppendBatch"),
    openWorkspace: async (workspacePath: string) => {
      calls.push("openWorkspace");
      return JSON.stringify({ path: workspacePath });
    },
  } as unknown as NapiBackendLike;
  const real = await createProfileEgressGate(backend);
  const gate = options.wrapGate ? options.wrapGate(real) : real;
  const issued = vi.fn(gate.issueCallerIdentity.bind(gate));
  const asserted = vi.fn(gate.assertInvoke.bind(gate));
  const spied = Object.assign(Object.create(gate) as ProfileEgressGate, {
    issueCallerIdentity: issued,
    assertInvoke: asserted,
  });
  calls.length = 0;
  registerIpcRouter(
    backend,
    {},
    undefined,
    undefined,
    { active: false } as never,
    spied,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.launch,
    options.owner as never,
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
    calls,
    gate,
    issued,
    asserted,
    sender,
    win,
    invoke: (cmd, invokeArgs = {}, from = sender) =>
      handler({ sender: from }, cmd, invokeArgs),
  };
}

function valueOf(envelope: Envelope): Record<string, unknown> {
  if (!envelope.ok) throw new Error(`expected ok, got: ${envelope.error}`);
  return envelope.value as Record<string, unknown>;
}

const REFUSED = (
  command: "start" | "cancel",
  reason: string,
): Record<string, unknown> => ({ status: "refused", command, reason });
const COMMAND_NAME: Record<string, "start" | "cancel"> = {
  [MASTRA_AGENT_TURN_START_COMMAND]: "start",
  [MASTRA_AGENT_TURN_CANCEL_COMMAND]: "cancel",
};

beforeEach(() => {
  mocks.app.isPackaged = true;
  mocks.app.getPath = () => "/nonexistent";
});

describe("the journey seam's launch (DR-MP3-17)", () => {
  it("is active only with the exact environment of an unpackaged journey launch", () => {
    expect(parseMastraAgentTurnCiSeam(activeLaunch())).toEqual({
      active: true,
      nonce: NONCE,
    });
    const userDataDir = journeyDir();
    for (const [label, launch] of [
      ["no CI", activeLaunch({}, { CI: undefined })],
      ["CI=1", activeLaunch({}, { CI: "1" })],
      [
        "other token",
        activeLaunch({}, { [MASTRA_AGENT_TURN_CI_OWNER_TOKEN_ENV]: "x" }),
      ],
      [
        "the local generation token",
        activeLaunch(
          {},
          {
            [MASTRA_AGENT_TURN_CI_OWNER_TOKEN_ENV]:
              NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN,
          },
        ),
      ],
      [
        "no nonce",
        activeLaunch({}, { [MASTRA_AGENT_TURN_CI_NONCE_ENV]: undefined }),
      ],
      [
        "nonce not v4",
        activeLaunch(
          {},
          {
            [MASTRA_AGENT_TURN_CI_NONCE_ENV]:
              "8f14e45f-ceea-167e-a5d4-1b9c6d0e2f3a",
          },
        ),
      ],
      [
        "no journey userData",
        activeLaunch({}, { [MASTRA_AGENT_TURN_CI_USER_DATA_ENV]: undefined }),
      ],
      [
        "relative userData",
        activeLaunch(
          {},
          { [MASTRA_AGENT_TURN_CI_USER_DATA_ENV]: "relative/dir" },
        ),
      ],
      [
        "userData of another launch",
        activeLaunch({}, { [MASTRA_AGENT_TURN_CI_USER_DATA_ENV]: userDataDir }),
      ],
      [
        "the default userData",
        activeLaunch(
          { userDataDir, defaultUserDataDirs: () => [userDataDir] },
          { [MASTRA_AGENT_TURN_CI_USER_DATA_ENV]: userDataDir },
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
      expect(parseMastraAgentTurnCiSeam(launch), label).toEqual({
        active: false,
      });
    }
  });

  it("is not the local generation seam: the two seams' names and tokens do not open each other", () => {
    expect(MASTRA_AGENT_TURN_CI_OWNER_TOKEN_ENV).not.toBe(
      NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN_ENV,
    );
    expect(MASTRA_AGENT_TURN_CI_NONCE_ENV).not.toBe(
      NIR1_LOCAL_GENERATION_CI_NONCE_ENV,
    );
    expect(MASTRA_AGENT_TURN_CI_OWNER_TOKEN).not.toBe(
      NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN,
    );
    // Only the application's userData variable is shared (DR-MP3-17).
    expect(MASTRA_AGENT_TURN_CI_ENV_NAMES).toEqual([
      "CI",
      MASTRA_AGENT_TURN_CI_OWNER_TOKEN_ENV,
      MASTRA_AGENT_TURN_CI_NONCE_ENV,
      "GRIMODEX_USER_DATA_DIR",
    ]);
    // The local generation seam's whole environment leaves this seam closed ...
    const userDataDir = journeyDir();
    const localEnv = {
      CI: "true",
      [NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN_ENV]:
        NIR1_LOCAL_GENERATION_CI_OWNER_TOKEN,
      [NIR1_LOCAL_GENERATION_CI_NONCE_ENV]: NONCE,
      GRIMODEX_USER_DATA_DIR: userDataDir,
    };
    expect(
      parseMastraAgentTurnCiSeam({
        isPackaged: false,
        env: localEnv,
        userDataDir,
        defaultUserDataDirs: () => [],
      }),
    ).toEqual({ active: false });
    // ... and this seam's whole environment leaves that one closed.
    expect(
      parseNir1LocalGenerationCiSeam({
        isPackaged: false,
        env: activeLaunch(
          { userDataDir },
          {
            GRIMODEX_USER_DATA_DIR: userDataDir,
          },
        ).env,
        userDataDir,
        defaultUserDataDirs: () => [],
      }),
    ).toEqual({ active: false });
  });

  it("reads only own environment values", () => {
    const launch = activeLaunch();
    expect(parseMastraAgentTurnCiSeam(launch).active).toBe(true);
    expect(
      parseMastraAgentTurnCiSeam({
        ...launch,
        env: Object.create(launch.env) as NodeJS.ProcessEnv,
      }),
    ).toEqual({ active: false });
  });

  it("a packaged launch reads no environment value and no directory", () => {
    const defaultUserDataDirs = vi.fn(() => []);
    expect(
      parseMastraAgentTurnCiSeam({
        isPackaged: true,
        env: untouchableEnv(),
        userDataDir: "/journey",
        defaultUserDataDirs,
      }),
    ).toEqual({ active: false });
    expect(defaultUserDataDirs).not.toHaveBeenCalled();
  });

  it("opens Main's gate only for an active seam of an unpackaged launch (no Native entry exists)", () => {
    const active = { active: true, nonce: NONCE } as const;
    expect(openMastraAgentTurnGate({ seam: active, isPackaged: false })).toBe(
      true,
    );
    expect(openMastraAgentTurnGate({ seam: active, isPackaged: true })).toBe(
      false,
    );
    expect(
      openMastraAgentTurnGate({
        seam: active,
        isPackaged: undefined as never,
      }),
    ).toBe(false);
    expect(
      openMastraAgentTurnGate({ seam: { active: false }, isPackaged: false }),
    ).toBe(false);
  });
});

describe("Main's gate", () => {
  it("refuses both commands with a typed gate-closed value before identity, the profile gate and any backend call", async () => {
    mocks.app.isPackaged = true;
    const r = await rig();
    for (const command of MASTRA_AGENT_TURN_COMMANDS) {
      const envelope = await r.invoke(command, ARGS[command]);
      // An ok:true value (not an error): the renderer falls back to legacy.
      expect(envelope.ok, command).toBe(true);
      expect(valueOf(envelope), command).toEqual(
        REFUSED(COMMAND_NAME[command], "gate-closed"),
      );
    }
    // Nothing was reached: no identity issued, no D2a check, no backend call.
    expect(r.issued).not.toHaveBeenCalled();
    expect(r.asserted).not.toHaveBeenCalled();
    expect(r.calls).toEqual([]);
  });

  it("answers gate-closed whatever the arguments are, restricted or not, without reading them", async () => {
    mocks.app.isPackaged = true;
    for (const restricted of [false, true]) {
      const r = await rig({ restricted });
      for (const command of MASTRA_AGENT_TURN_COMMANDS) {
        for (const args of [{}, { garbage: 1 }, ARGS[command]]) {
          expect(valueOf(await r.invoke(command, args))).toEqual(
            REFUSED(COMMAND_NAME[command], "gate-closed"),
          );
        }
      }
    }
  });

  it("stays closed in a packaged launch that carries the whole seam environment", async () => {
    mocks.app.isPackaged = true;
    const r = await rig({ launch: undefined });
    expect(
      valueOf(await r.invoke(MASTRA_AGENT_TURN_START_COMMAND, START)),
    ).toEqual(REFUSED("start", "gate-closed"));
    // An explicit launch that says packaged, whatever the env holds.
    const explicit = await rig({
      launch: { ...activeLaunch(), isPackaged: true },
    });
    expect(
      valueOf(await explicit.invoke(MASTRA_AGENT_TURN_START_COMMAND, START)),
    ).toEqual(REFUSED("start", "gate-closed"));
    expect(explicit.calls).toEqual([]);
  });

  it("a launch with the seam opens the gate, and a mismatching one does not", async () => {
    const open = await rig({ launch: activeLaunch() });
    expect(
      valueOf(await open.invoke(MASTRA_AGENT_TURN_CANCEL_COMMAND, CANCEL)),
    ).toEqual({ status: "ok", turnId: TURN_ID, found: false });
    const closed = await rig({
      launch: activeLaunch({}, { [MASTRA_AGENT_TURN_CI_OWNER_TOKEN_ENV]: "x" }),
    });
    expect(
      valueOf(await closed.invoke(MASTRA_AGENT_TURN_CANCEL_COMMAND, CANCEL)),
    ).toEqual(REFUSED("cancel", "gate-closed"));
  });

  it("does not touch other commands", () => {
    const route = createMastraAgentTurnRoute({ open: false });
    for (const command of [
      "send_agent_message",
      "send_chat_message",
      "chat_agent_ir_select",
      "mastra_agent_turn",
      "mastra_agent_turn_start_extra",
      "",
    ]) {
      expect(route.gateRefusal(command), command).toBeNull();
    }
    expect(
      createMastraAgentTurnRoute({ open: true }).gateRefusal(
        MASTRA_AGENT_TURN_START_COMMAND,
      ),
    ).toBeNull();
  });

  it("the handlers are closed by themselves too (defense in depth behind the router)", async () => {
    const route = createMastraAgentTurnRoute({ open: false });
    await expect(
      route.handlers[MASTRA_AGENT_TURN_START_COMMAND](START),
    ).resolves.toEqual(REFUSED("start", "gate-closed"));
    await expect(
      route.handlers[MASTRA_AGENT_TURN_CANCEL_COMMAND](CANCEL),
    ).resolves.toEqual(REFUSED("cancel", "gate-closed"));
    const admitted = route.admit(MASTRA_AGENT_TURN_START_COMMAND, {
      sender: fakeSender(1),
      win: null,
      callerIdentity: undefined,
    });
    expect(admitted).toEqual({
      ok: true,
      value: REFUSED("start", "gate-closed"),
    });
  });
});

describe("with the gate open (3b: the checks run, a start is not run)", () => {
  it("refuses a valid start as unsupported: there is no turn owner yet", async () => {
    const r = await rig({ launch: activeLaunch() });
    expect(
      valueOf(await r.invoke(MASTRA_AGENT_TURN_START_COMMAND, START)),
    ).toEqual(REFUSED("start", "unsupported"));
    // It went through the profile gate and the identity, never to Native.
    expect(r.issued).toHaveBeenCalled();
    expect(r.asserted).toHaveBeenCalledWith(
      MASTRA_AGENT_TURN_START_COMMAND,
      expect.anything(),
    );
    expect(r.calls).not.toContain("sendAgentMessage");
    expect(r.calls).not.toContain("aiAuditAppendBatch");
    expect(r.calls).not.toContain("getAiSettings");
  });

  it("re-checks the request in Main: an invalid start is invalid, not unsupported", async () => {
    const r = await rig({ launch: activeLaunch() });
    for (const args of [
      {},
      { ...START, tools: [{ name: "t" }] },
      { ...START, chatSessionId: "" },
      { ...START, chatSessionId: undefined },
      { ...START, turnId: "turn-1" },
      { ...START, route: { ...START.route, provider: "ollama" } },
      { ...START, messages: [{ role: "user", content: [{ type: "image" }] }] },
      // what is Main's, sent by the renderer
      { ...START, capability: "c" },
      { ...START, auditContext: {} },
      { ...START, pathId: "chat_agent_main" },
      { ...START, executionId: "e" },
    ]) {
      expect(
        valueOf(await r.invoke(MASTRA_AGENT_TURN_START_COMMAND, args)),
        JSON.stringify(args).slice(0, 60),
      ).toEqual(REFUSED("start", "invalid"));
    }
    expect(
      valueOf(await r.invoke(MASTRA_AGENT_TURN_CANCEL_COMMAND, {})),
    ).toEqual(REFUSED("cancel", "invalid"));
    expect(
      valueOf(
        await r.invoke(MASTRA_AGENT_TURN_CANCEL_COMMAND, {
          turnId: TURN_ID,
          executionId: "e",
        }),
      ),
    ).toEqual(REFUSED("cancel", "invalid"));
  });

  it("a renderer that sends a key that is Main's is refused as invalid, callerIdentity included (the router replaces it, so it is read first)", async () => {
    const r = await rig({ launch: activeLaunch() });
    for (const extra of [
      { callerIdentity: { senderId: 999, forged: true } },
      { callerIdentity: null },
      { capability: "c" },
      { executionId: "e" },
    ]) {
      expect(
        valueOf(
          await r.invoke(MASTRA_AGENT_TURN_START_COMMAND, {
            ...START,
            ...extra,
          }),
        ),
        JSON.stringify(extra),
      ).toEqual(REFUSED("start", "invalid"));
    }
    expect(
      valueOf(
        await r.invoke(MASTRA_AGENT_TURN_CANCEL_COMMAND, {
          ...CANCEL,
          callerIdentity: { senderId: 999 },
        }),
      ),
    ).toEqual(REFUSED("cancel", "invalid"));
    // A destroyed sender is refused as such first, and a closed gate answers
    // before any of this.
    r.sender.destroyed = true;
    expect(
      valueOf(
        await r.invoke(MASTRA_AGENT_TURN_START_COMMAND, {
          ...START,
          callerIdentity: {},
        }),
      ),
    ).toEqual(REFUSED("start", "sender-refused"));
    const closed = await rig();
    expect(
      valueOf(
        await closed.invoke(MASTRA_AGENT_TURN_START_COMMAND, {
          ...START,
          callerIdentity: {},
        }),
      ),
    ).toEqual(REFUSED("start", "gate-closed"));
  });

  it("cancel of a turn Main does not know is a no-op that says so", async () => {
    const r = await rig({ launch: activeLaunch() });
    expect(
      valueOf(await r.invoke(MASTRA_AGENT_TURN_CANCEL_COMMAND, CANCEL)),
    ).toEqual({ status: "ok", turnId: TURN_ID, found: false });
  });

  it("checks the sender, its own window and a caller identity Main issued", async () => {
    const r = await rig({ launch: activeLaunch() });
    // The sender is destroyed.
    r.sender.destroyed = true;
    expect(
      valueOf(await r.invoke(MASTRA_AGENT_TURN_START_COMMAND, START)),
    ).toEqual(REFUSED("start", "sender-refused"));
    r.sender.destroyed = false;
    // Its window is destroyed.
    r.win.destroyed = true;
    expect(
      valueOf(await r.invoke(MASTRA_AGENT_TURN_CANCEL_COMMAND, CANCEL)),
    ).toEqual(REFUSED("cancel", "sender-refused"));
    r.win.destroyed = false;
    // No window for the sender.
    const stray = fakeSender(9);
    expect(
      valueOf(await r.invoke(MASTRA_AGENT_TURN_START_COMMAND, START, stray)),
    ).toEqual(REFUSED("start", "sender-refused"));
    // A window whose webContents is another sender.
    const other = fakeSender(11);
    mocks.windows.set(other, fakeWindow(110, fakeSender(12)));
    expect(
      valueOf(await r.invoke(MASTRA_AGENT_TURN_START_COMMAND, START, other)),
    ).toEqual(REFUSED("start", "sender-refused"));
  });

  it("refuses a caller identity Main did not issue, or issued to another sender (unit)", () => {
    const issuedIdentity = { senderId: 7, token: "main" };
    const route = createMastraAgentTurnRoute({
      open: true,
      profileEgress: {
        isIssuedCallerIdentity: (identity) => identity === issuedIdentity,
      },
    });
    const sender = fakeSender(7);
    const win = fakeWindow(70, sender);
    const admit = (callerIdentity: unknown) =>
      route.admit(MASTRA_AGENT_TURN_START_COMMAND, {
        sender,
        win,
        callerIdentity,
      });
    expect(admit(issuedIdentity)).toBeNull();
    for (const identity of [
      undefined,
      null,
      "x",
      { senderId: 7, token: "main" }, // an equal value Main did not issue
      { ...issuedIdentity, senderId: 8 },
    ]) {
      expect(admit(identity), JSON.stringify(identity)).toEqual({
        ok: true,
        value: REFUSED("start", "sender-refused"),
      });
    }
    // No identity source at all: the route issues none itself.
    const noGate = createMastraAgentTurnRoute({ open: true });
    expect(
      noGate.admit(MASTRA_AGENT_TURN_START_COMMAND, {
        sender,
        win,
        callerIdentity: issuedIdentity,
      }),
    ).toEqual({ ok: true, value: REFUSED("start", "sender-refused") });
  });

  it("a restricted profile refuses the start as an old-external-ai denial and lets the cancel through", async () => {
    const r = await rig({ launch: activeLaunch(), restricted: true });
    const start = await r.invoke(MASTRA_AGENT_TURN_START_COMMAND, START);
    expect(start.ok).toBe(false);
    if (!start.ok) {
      expect(start.error).toContain(D2A_EGRESS_DENIED_MARKER);
      expect(start.error).toContain("old-external-ai");
    }
    expect(
      valueOf(await r.invoke(MASTRA_AGENT_TURN_CANCEL_COMMAND, CANCEL)),
    ).toEqual({ status: "ok", turnId: TURN_ID, found: false });
  });

  it("an admitted start and cancel go to the owner with the invoke's sender, window and issued identity (MP-3c)", async () => {
    const seen: { command: string; context: unknown; request: unknown }[] = [];
    const owner: MastraAgentTurnOwnerPort = {
      start: async (context, request) => {
        seen.push({ command: "start", context, request });
        return { status: "completed", turnId: request.turnId };
      },
      cancel: (context, request) => {
        seen.push({ command: "cancel", context, request });
        return { status: "ok", turnId: request.turnId, found: true };
      },
    };
    const r = await rig({ launch: activeLaunch(), owner });
    expect(
      valueOf(await r.invoke(MASTRA_AGENT_TURN_START_COMMAND, START)),
    ).toEqual({ status: "completed", turnId: TURN_ID });
    expect(
      valueOf(await r.invoke(MASTRA_AGENT_TURN_CANCEL_COMMAND, CANCEL)),
    ).toEqual({ status: "ok", turnId: TURN_ID, found: true });
    expect(seen.map((entry) => entry.command)).toEqual(["start", "cancel"]);
    const context = seen[0]!.context as {
      sender: unknown;
      win: unknown;
      callerIdentity: unknown;
    };
    expect(context.sender).toBe(r.sender);
    expect(context.win).toBe(r.win);
    // The identity is the one Main issued to this sender, never one the renderer sent.
    expect(r.gate.isIssuedCallerIdentity?.(context.callerIdentity)).toBe(true);
    expect(seen[0]!.request).toEqual(START);
  });

  it("an owner that rejects reaches the renderer as an error envelope, not as a typed value", async () => {
    const owner: MastraAgentTurnOwnerPort = {
      start: () => Promise.reject(new Error("MASTRA_AGENT_TURN_ABORTED: quit")),
      cancel: () => ({ status: "ok", turnId: TURN_ID, found: false }),
    };
    const r = await rig({ launch: activeLaunch(), owner });
    const start = await r.invoke(MASTRA_AGENT_TURN_START_COMMAND, START);
    expect(start.ok).toBe(false);
    if (!start.ok) expect(start.error).toContain("MASTRA_AGENT_TURN_ABORTED");
  });

  it("an invalid request never reaches the owner, and a closed gate never reaches it either", async () => {
    const start = vi.fn(async () => ({}));
    const cancel = vi.fn(() => ({}));
    const owner: MastraAgentTurnOwnerPort = { start, cancel };
    const open = await rig({ launch: activeLaunch(), owner });
    expect(
      valueOf(
        await open.invoke(MASTRA_AGENT_TURN_START_COMMAND, {
          ...START,
          tools: [{ name: "x" }],
        }),
      ),
    ).toEqual(REFUSED("start", "invalid"));
    expect(
      valueOf(await open.invoke(MASTRA_AGENT_TURN_CANCEL_COMMAND, {})),
    ).toEqual(REFUSED("cancel", "invalid"));
    const closed = await rig({ owner });
    expect(
      valueOf(await closed.invoke(MASTRA_AGENT_TURN_START_COMMAND, START)),
    ).toEqual(REFUSED("start", "gate-closed"));
    expect(start).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("the context-less handlers never reach an owner (a start is unsupported)", async () => {
    const start = vi.fn(async () => ({}));
    const route = createMastraAgentTurnRoute({
      open: true,
      owner: { start, cancel: vi.fn(() => ({})) },
    });
    expect(
      await route.handlers[MASTRA_AGENT_TURN_START_COMMAND]!(START),
    ).toEqual(REFUSED("start", "unsupported"));
    expect(start).not.toHaveBeenCalled();
  });

  it("a workspace switch takes the owner's lease before Native's open and resumes it after, with the open's result (MP-3c, DR-MP3-12)", async () => {
    const order: string[] = [];
    const owner = {
      start: async () => ({}),
      cancel: () => ({}),
      quiesceForWorkspaceSwitch: async () => {
        order.push("lease");
        return {
          resume: async (success: boolean) => {
            order.push(`resume ${success}`);
          },
        };
      },
    } as unknown as MastraAgentTurnOwnerPort;
    const r = await rig({ launch: activeLaunch(), owner });
    r.calls.length = 0;
    const result = await r.invoke("open_workspace", { path: "/work/new" });
    expect(result.ok).toBe(true);
    // Native's open ran between the lease and its resume.
    expect(r.calls).toContain("openWorkspace");
    expect(order).toEqual(["lease", "resume true"]);
    // A switch that fails resumes with false, and nothing is left closed.
    const failing = await rig({ launch: activeLaunch(), owner });
    order.length = 0;
    const refused = await failing.invoke("open_workspace", { path: "" });
    expect(refused.ok).toBe(false);
    // An invalid path is refused before any lease: no turn is aborted for nothing.
    expect(order).toEqual([]);
  });

  it("does not change what other commands see", async () => {
    const r = await rig({ launch: activeLaunch() });
    const unknown = await r.invoke("mastra_agent_turn_other", {});
    expect(unknown.ok).toBe(false);
  });
});
