// chat IR S1-A (DR-CHATIR-S1-27, design S1A-2): Main's gate of
// `chat_agent_ir_select` is closed in every launch and runs first in the invoke
// handler; nothing in the product opens Native's gate for it; the command's
// argument adapter holds the same bounds Native does.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  IPC,
  NAPI_COMMANDS,
  type Envelope,
  type NapiBackendLike,
} from "../shared/ipcContract.js";
import {
  CHAT_AGENT_IR_COMMAND,
  CHAT_AGENT_IR_GATE_CLOSED,
  chatAgentIrGateRefusal,
} from "./chatAgentIr.js";
import { nativeSqlPolicyV3 } from "./d2aSqlPolicyFixture.js";
import { createProfileEgressGate } from "./profileEgress.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  app: {
    isPackaged: true as boolean | undefined,
    getPath: ((_name: string) => "/nonexistent") as (name: string) => string,
  },
}));

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: { fromWebContents: () => null },
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

const ARGS = {
  query: "a query",
  projectId: "project-1",
  expectedWorkspacePath: "/workspace",
  currentSceneId: "scene-1",
  chronicleEventIds: ["event-1", "event-2"],
};

function fakeBackend(restricted: boolean) {
  const select = vi.fn(async () =>
    JSON.stringify({
      status: "available",
      success: true,
      items: [],
      eventIds: {},
      excludedEventIds: [],
    }),
  );
  const calls: string[] = [];
  const backend = {
    initializeProfileEgress: async () =>
      JSON.stringify({
        profileId: "profile-1",
        callerEpoch: 4,
        restricted,
        handlesInvalidated: restricted,
        inFlightStopped: true,
        sqlPolicy: nativeSqlPolicyV3(),
      }),
    registerProfileEgressCaller: () => {
      calls.push("registerProfileEgressCaller");
    },
    invalidateProfileEgressCallers: () => undefined,
    mainOpenPrePublicationGate: (kind: string) => {
      calls.push(`mainOpenPrePublicationGate:${kind}`);
    },
    chatAgentIrSelect: select,
  } as unknown as NapiBackendLike;
  return { backend, select, calls };
}

async function invokeThroughRouter(restricted: boolean, args: unknown) {
  mocks.handlers.clear();
  const fake = fakeBackend(restricted);
  registerIpcRouter(
    fake.backend,
    {},
    undefined,
    undefined,
    { active: false } as never,
    await createProfileEgressGate(fake.backend),
  );
  const handler = mocks.handlers.get(IPC.invoke) as (
    event: unknown,
    cmd: unknown,
    args: unknown,
  ) => Promise<Envelope>;
  const sender = {
    id: 7,
    isDestroyed: () => false,
    once: () => sender,
  };
  const envelope = await handler({ sender }, CHAT_AGENT_IR_COMMAND, args);
  return { envelope, ...fake };
}

beforeEach(() => {
  mocks.handlers.clear();
});

describe("Main's gate of chat_agent_ir_select", () => {
  it("answers a closed-gate error for this command and nothing for any other", () => {
    const refusal = chatAgentIrGateRefusal(CHAT_AGENT_IR_COMMAND);
    expect(refusal).toEqual({
      ok: false,
      error: expect.stringContaining(CHAT_AGENT_IR_GATE_CLOSED),
    });
    for (const command of [
      "related_scenes_begin",
      "events_semantic_search",
      "chat_agent_ir_select_extra",
      "",
    ]) {
      expect(chatAgentIrGateRefusal(command), command).toBeNull();
    }
  });

  it.each([false, true])(
    "refuses before Native is reached (restricted: %s), even with valid arguments",
    async (restricted) => {
      const { envelope, select } = await invokeThroughRouter(restricted, ARGS);
      expect(envelope.ok).toBe(false);
      expect(JSON.stringify(envelope)).toContain(CHAT_AGENT_IR_GATE_CLOSED);
      expect(select).not.toHaveBeenCalled();
    },
  );

  it("refuses invalid arguments with the gate's error first, not an argument error", async () => {
    const { envelope, select } = await invokeThroughRouter(false, {
      ...ARGS,
      extra: 1,
    });
    expect(envelope).toMatchObject({ ok: false });
    expect(JSON.stringify(envelope)).toContain(CHAT_AGENT_IR_GATE_CLOSED);
    expect(select).not.toHaveBeenCalled();
  });

  it("registers no opener: starting the router opens no Native gate for it", async () => {
    const { calls } = await invokeThroughRouter(false, ARGS);
    expect(calls.filter((call) => call.includes("chat-agent-ir"))).toEqual([]);
  });
});

describe("no product source opens the chat IR gate (S1-7)", () => {
  const roots = ["electron", "src", "packages"].map((dir) =>
    path.resolve(__dirname, "..", "..", dir),
  );

  function* sources(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "target" || name === "dist") {
        continue;
      }
      const full = path.join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) yield* sources(full);
      else if (
        /\.(ts|tsx|mjs|js)$/u.test(name) &&
        !/\.(test|spec)\.(ts|tsx|mjs|js)$/u.test(name) &&
        !name.endsWith(".d.ts")
      ) {
        yield full;
      }
    }
  }

  it("has no non-test source that names the Native gate kind", () => {
    const naming: string[] = [];
    for (const root of roots) {
      for (const file of sources(root)) {
        if (readFileSync(file, "utf8").includes("chat-agent-ir")) {
          naming.push(path.relative(path.resolve(root, ".."), file));
        }
      }
    }
    expect(naming).toEqual([]);
  });
});

describe("the argument adapter holds Native's bounds", () => {
  const answer = async () =>
    JSON.stringify({
      status: "available",
      success: true,
      items: [],
      eventIds: {},
      excludedEventIds: [],
    });
  const run = (args: Record<string, unknown>, select = vi.fn(answer)) =>
    NAPI_COMMANDS.chat_agent_ir_select.run(
      { chatAgentIrSelect: select } as unknown as NapiBackendLike,
      args,
      {} as never,
    );

  it("passes exactly the five keys, in the typed shape", async () => {
    const select = vi.fn(answer);
    await run(ARGS, select);
    expect(select).toHaveBeenCalledWith(ARGS);
    // A copy: Native gets an array of its own, not the caller's.
    const passed = (select.mock.calls[0] as unknown[])[0] as {
      chronicleEventIds: string[];
    };
    expect(passed.chronicleEventIds).not.toBe(ARGS.chronicleEventIds);
  });

  // M1 (S1-A2, DR-CHATIR-S1-41): the candidate list is required, at most 30
  // distinct IDs of 1 to 200 UTF-16 units. Native checks the same.
  describe("chronicleEventIds", () => {
    const ids = (count: number) =>
      Array.from({ length: count }, (_, index) => `event-${index}`);

    it.each([
      ["no candidate", []],
      ["one", ["e"]],
      ["30 IDs", ids(30)],
      ["200 units", ["a".repeat(200)]],
      ["100 surrogate pairs (200 units)", ["\u{1F600}".repeat(100)]],
    ])("accepts %s", async (_name, chronicleEventIds) => {
      const select = vi.fn(answer);
      await run({ ...ARGS, chronicleEventIds }, select);
      expect(select).toHaveBeenCalledWith({ ...ARGS, chronicleEventIds });
    });

    it.each([
      ["31 IDs", ids(31)],
      ["an empty ID", [""]],
      ["a white-space ID", ["   "]],
      ["201 units", ["a".repeat(201)]],
      ["101 surrogate pairs (202 units)", ["\u{1F600}".repeat(101)]],
      ["a next-line (U+0085) only ID", ["\u0085"]],
      ["a mixed white-space and U+0085 ID", [" \u0085\u00a0\ufeff"]],
      // eslint-disable-next-line no-sparse-arrays
      ["a sparse array (a hole)", [, "a"]],
      ["a repeated ID", ["e", "e"]],
      ["a repeat inside 30", [...ids(29), "event-0"]],
      ["a number", [1]],
      ["null", [null]],
      ["a string", "event-1"],
      ["null itself", null],
      ["an object", { 0: "e" }],
    ])(
      "refuses %s before Native is reached",
      async (_name, chronicleEventIds) => {
        const select = vi.fn(answer);
        await expect(
          run({ ...ARGS, chronicleEventIds }, select),
          _name,
        ).rejects.toThrow(/IPC_INVALID_REQUEST/u);
        expect(select).not.toHaveBeenCalled();
      },
    );

    it("refuses a missing key (not read as no candidate)", async () => {
      const { chronicleEventIds: _omitted, ...missing } = ARGS;
      const select = vi.fn(answer);
      await expect(run(missing, select)).rejects.toThrow(
        /IPC_INVALID_REQUEST/u,
      );
      expect(select).not.toHaveBeenCalled();
    });
  });

  it("counts the query in UTF-16 code units", async () => {
    await expect(
      run({ ...ARGS, query: "a".repeat(500) }),
    ).resolves.toBeDefined();
    await expect(
      run({ ...ARGS, query: "あ".repeat(500) }),
    ).resolves.toBeDefined();
    await expect(run({ ...ARGS, query: "a".repeat(501) })).rejects.toThrow(
      /IPC_INVALID_REQUEST/u,
    );
    // 251 surrogate pairs are 502 units.
    await expect(
      run({ ...ARGS, query: "\u{1F600}".repeat(251) }),
    ).rejects.toThrow(/IPC_INVALID_REQUEST/u);
    await expect(
      run({ ...ARGS, query: "\u{1F600}".repeat(250) }),
    ).resolves.toBeDefined();
  });

  it.each([
    [{ query: "" }],
    [{ query: "   " }],
    [{ projectId: "" }],
    [{ expectedWorkspacePath: "" }],
    [{ currentSceneId: "" }],
    [{ query: 1 }],
    [{ extra: true }],
  ])("refuses %j", async (override) => {
    const select = vi.fn();
    await expect(run({ ...ARGS, ...override }, select)).rejects.toThrow();
    expect(select).not.toHaveBeenCalled();
  });

  it("refuses a missing key", async () => {
    const { currentSceneId: _omitted, ...missing } = ARGS;
    await expect(run(missing)).rejects.toThrow();
  });

  it("fails with a named error when the backend lacks the method", async () => {
    await expect(
      NAPI_COMMANDS.chat_agent_ir_select.run(
        {} as NapiBackendLike,
        ARGS,
        {} as never,
      ),
    ).rejects.toThrow(/chatAgentIrSelect/u);
  });
});
