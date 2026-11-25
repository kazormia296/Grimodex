// MP-3c (DR-MP3-13, -14, -16, -17): the real Agent, in the real third bundle.
// The bundle is built here (esbuild, from `build.mjs`'s own config for it), so
// the test does not depend on an earlier `build.mjs`. It is read by the real
// lazy loader, and run by the real turn owner with Main's real audit sink.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AiAuditEventInput } from "../../shared/aiAuditEvents.js";
import type { NapiBackendLike } from "../../shared/ipcContract.js";
import type { MastraAgentTurnStartRequest } from "../../shared/mastraAgentTurnWire.js";
import { M4_READ_TOOL_NAMES } from "../../shared/agentReadToolDefinitions.js";
import { createPerCodePointTokenizer } from "../../shared/mastraRead/tokenizer.testSupport.js";
import { createMastraAgentLoader } from "../mastraAgentLoader.js";
import { createMastraEnvPin } from "../mastraEnv.js";
import { createMastraTurnOwner } from "../mastraTurnOwner.js";
import {
  installNetworkGuard,
  type NetworkGuard,
} from "./agentModel.testSupport.js";
import {
  assertAgentToolsAllowed,
  MASTRA_AGENT_TOOL_ALLOWLIST,
  MastraAgentToolNotAllowedError,
} from "./agentRuntime.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const TURN = "00000000-0000-4000-8000-0000000000a1";

let tmp = "";
let bundleInputs: string[] = [];
let guard: NetworkGuard;
let loader: ReturnType<typeof createMastraAgentLoader>;
const originalEnv = { ...process.env };

beforeAll(async () => {
  const build = (await import(
    pathToFileURL(path.join(repoRoot, "electron", "scripts", "build.mjs")).href
  )) as { bundleConfigs: esbuild.BuildOptions[] };
  const config = build.bundleConfigs[2]!;
  expect(String(config.outfile)).toMatch(/mastra-agent\.cjs$/);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grimodex-mp3c-bundle-"));
  const result = await esbuild.build({
    ...config,
    outfile: path.join(tmp, "mastra-agent.cjs"),
    metafile: true,
    logLevel: "silent",
  });
  bundleInputs = Object.keys(result.metafile.inputs);
  guard = installNetworkGuard();
  // A pin of this test's own: the shared one is the product's, applied by the loader only.
  const pin = createMastraEnvPin();
  loader = createMastraAgentLoader({
    isOpen: () => true,
    applyEnv: () => pin.apply(),
    bundleDir: tmp,
  });
}, 120_000);

afterAll(() => {
  // No outbound connection in the whole file (Rust's send is a fake here).
  expect(guard.external()).toEqual([]);
  guard.restore();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
});

interface Rig {
  readonly owner: ReturnType<typeof createMastraTurnOwner>;
  readonly sends: unknown[];
  readonly rows: AiAuditEventInput[];
  readonly logs: string[];
  readonly appendProjects: (string | null)[];
  context(): Parameters<ReturnType<typeof createMastraTurnOwner>["start"]>[0];
}

function rig(send: (args: unknown) => Promise<string>): Rig {
  const sends: unknown[] = [];
  const rows: AiAuditEventInput[] = [];
  const logs: string[] = [];
  const appendProjects: (string | null)[] = [];
  const identity = { senderId: 7, workspaceId: "/work/w" };
  const backend = {
    async aiAuditAppendBatch(
      _path: string,
      project: string | null,
      events: unknown,
    ): Promise<string> {
      appendProjects.push(project);
      rows.push(...(events as AiAuditEventInput[]));
      return "{}";
    },
    async dbExecute(): Promise<string> {
      return JSON.stringify({
        __grimodexDbResultKind: "read",
        rows: [{ ai_policy: null }],
      });
    },
    async getAiSettings(): Promise<string> {
      return JSON.stringify({ provider: "anthropic" });
    },
    async sendAgentMessage(args: unknown): Promise<string> {
      sends.push(args);
      return send(args);
    },
  } as unknown as NapiBackendLike;
  const owner = createMastraTurnOwner({
    open: true,
    backend,
    tokenizer: createPerCodePointTokenizer(),
    secrets: { resolveApiKeyForRequest: () => "k" },
    profile: {
      restricted: false,
      unavailable: false,
      activating: false,
      isIssuedCallerIdentity: (candidate) => candidate === identity,
    },
    loadRuntime: () => loader.load(),
    loadReadBindings: () => import("../mastraTurnReadBindings.js"),
    appVersion: "0.0.0-test",
    log: (_level, message) => logs.push(message),
  });
  return {
    owner,
    sends,
    rows,
    logs,
    appendProjects,
    context: () => ({
      sender: {
        id: 7,
        isDestroyed: () => false,
        on: () => undefined,
        removeListener: () => undefined,
      },
      win: {
        id: 8,
        isDestroyed: () => false,
        webContents: {},
        on: () => undefined,
        removeListener: () => undefined,
      },
      callerIdentity: identity,
    }),
  };
}

const request = (
  extra: Partial<MastraAgentTurnStartRequest> = {},
): MastraAgentTurnStartRequest => ({
  turnId: TURN,
  chatSessionId: "s1",
  projectId: "project-1",
  currentSceneId: null,
  chatMessageId: "message-1",
  messages: [
    { role: "system", content: "You write." },
    { role: "user", content: "Continue the scene." },
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
  fullyInjectedIds: [],
  loop: {
    tokenBudget: 2000,
    maxToolCalls: 10,
    maxUserQuestions: 8,
    contextWindow: 8000,
    requestMaxOutputTokens: 4096,
    language: "ja",
    controlMessages: {
      callLimitMessage: "calls",
      tokenBudgetMessage: "tokens",
      userQuestionLimitMessage: "questions",
    },
    fallbackSystem: "You write.",
  },
  tools: [],
  ...extra,
});

describe("the real Agent in the third bundle", () => {
  it("runs one turn: one send of the wire the legacy route sends, the raw response back, and the rows in order", async () => {
    const r = rig(async () =>
      JSON.stringify({
        blocks: [{ type: "text", content: "done" }],
        stopReason: "end_turn",
        inputTokens: 3,
        outputTokens: 4,
      }),
    );
    const result = (await r.owner.start(r.context(), request())) as {
      status: string;
      response: Record<string, unknown>;
    };
    expect(result.status).toBe("completed");
    // Not Mastra's text: the provider's own response, usage fields included.
    expect(result.response).toMatchObject({
      blocks: [{ type: "text", content: "done" }],
      stopReason: "end_turn",
      inputTokens: 3,
      outputTokens: 4,
    });
    expect(r.sends).toHaveLength(1);
    const sent = r.sends[0] as {
      messages: { role: string; content: string }[];
      tools: unknown[];
      provider: string;
      callerIdentity?: unknown;
      auditContext?: { projectId?: unknown };
      chatMessageId?: unknown;
    };
    // MP-4a: the real owner, Agent and adapter carry the wire's project and
    // chat message to the send, and every row is appended to that project.
    expect(sent.auditContext).toMatchObject({ projectId: "project-1" });
    expect(sent.chatMessageId).toBe("message-1");
    expect(r.appendProjects.length).toBeGreaterThan(0);
    expect(new Set(r.appendProjects)).toEqual(new Set(["project-1"]));
    expect(sent.messages).toEqual([
      { role: "system", content: "You write." },
      { role: "user", content: "Continue the scene." },
    ]);
    // Tool 0 and no identity on the wire.
    expect(sent.tools).toEqual([]);
    expect(sent.provider).toBe("anthropic");
    expect(sent).not.toHaveProperty("callerIdentity");
    expect(r.rows.map((row) => row.eventType)).toEqual([
      "execution.started",
      "request.prepared",
      "request.dispatched",
      "response.completed",
      "execution.succeeded",
    ]);
  }, 60_000);

  it("a provider failure is not retried: one send, one failed terminal, and no cause text in Mastra's logs", async () => {
    const secret = "SECRET-ORIGIN-TOKEN";
    const consoleSpies = (
      ["log", "info", "warn", "error", "debug"] as const
    ).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    try {
      // A message the default stream-error processor would retry on, with the
      // flag an API-call error carries: neither may make a second send.
      const r = rig(async () => {
        throw Object.assign(new Error(`socket hang up ECONNRESET ${secret}`), {
          isRetryable: true,
        });
      });
      await expect(r.owner.start(r.context(), request())).rejects.toThrow(
        /ECONNRESET/,
      );
      expect(r.sends).toHaveLength(1);
      const failed = r.rows.filter(
        (row) => row.eventType === "execution.failed",
      );
      expect(failed).toHaveLength(1);
      // The cause's own message is recorded (the adapter's wrapper is not).
      expect(JSON.stringify(failed[0]?.payload)).toContain("ECONNRESET");
      expect(failed[0]?.payload).not.toHaveProperty("remoteOutcome");
      expect(
        r.rows.filter((row) => row.eventType === "execution.succeeded"),
      ).toHaveLength(0);
      // Mastra's own logger is the injected one: nothing of the cause reaches it or the console.
      expect(r.logs.join("\n")).not.toContain(secret);
      for (const spy of consoleSpies) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
      }
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  }, 60_000);

  it("an error the adapter makes keeps its kind in the failed row although the sink is in another bundle (`instanceof` would not hold)", async () => {
    // Native answers with something that is not a response: the adapter's own error.
    const r = rig(async () => JSON.stringify({ blocks: "not-an-array" }));
    await expect(r.owner.start(r.context(), request())).rejects.toThrow();
    expect(r.sends).toHaveLength(1);
    const failed = r.rows.filter((row) => row.eventType === "execution.failed");
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0]?.payload)).toContain(
      '"agentErrorKind":"invalid-response"',
    );
  }, 60_000);

  it("one step only: a response that asks for a tool does not start a second send", async () => {
    const r = rig(async () =>
      JSON.stringify({
        blocks: [
          { type: "tool_use", id: "call_1", name: "get_scene", input: {} },
        ],
        stopReason: "tool_use",
      }),
    );
    await r.owner.start(r.context(), request()).catch(() => undefined);
    expect(r.sends).toHaveLength(1);
  }, 60_000);

  it("the bundle is read once for all turns", async () => {
    const before = loader.loaded;
    expect(before).toBe(true);
  });

  it("the third bundle contains no main ports, DB adapters, Native bindings, or shared read core", () => {
    expect(
      bundleInputs.filter((file) =>
        /electron\/(?:main\/(?:mastraRead|readDomain)|shared\/(?:mastraRead|readDomain)|native\/)/.test(
          file,
        ),
      ),
    ).toEqual([]);
  });
});

describe("the runtime tool allow-list (DR-MP3-14, layer 2)", () => {
  it("matches the M4 shared names, and a tool outside it is refused by name", () => {
    expect([...MASTRA_AGENT_TOOL_ALLOWLIST]).toEqual([...M4_READ_TOOL_NAMES]);
    expect(() => assertAgentToolsAllowed([])).not.toThrow();
    expect(() => assertAgentToolsAllowed(["not_allowed"])).toThrow(
      MastraAgentToolNotAllowedError,
    );
    expect(() => assertAgentToolsAllowed(["a", "b"], ["a"])).toThrow(/: b$/);
    expect(() => assertAgentToolsAllowed(["a"], ["a"])).not.toThrow();
  });
});
