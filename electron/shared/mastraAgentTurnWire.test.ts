// MP-3b (DR-MP3-4, -24): the wire of the Mastra agent turn route. The parser
// is exact (keys, UUID, text only, supported provider, tool 0, bounds) and
// echoes no value of a request.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AGENT_WIRE_ARG_KEYS,
  type AgentAdapterOwnedKey,
} from "../main/mastra/agentWire.js";
import {
  hasMastraAgentTurnForbiddenKey,
  isMastraAgentTurnCommand,
  MASTRA_AGENT_TURN_CANCEL_COMMAND,
  MASTRA_AGENT_TURN_COMMANDS,
  MASTRA_AGENT_TURN_FORBIDDEN_KEYS,
  MASTRA_AGENT_TURN_ID_UTF16_MAX,
  MASTRA_AGENT_TURN_MESSAGE_TEXT_UTF16_MAX,
  MASTRA_AGENT_TURN_MESSAGES_MAX,
  MASTRA_AGENT_TURN_PROVIDERS,
  MASTRA_AGENT_TURN_REFUSAL_REASONS,
  MASTRA_AGENT_TURN_ROUTE_JSON_DEPTH_MAX,
  MASTRA_AGENT_TURN_ROUTE_KEYS,
  MASTRA_AGENT_TURN_SEGMENTS_MAX,
  MASTRA_AGENT_TURN_START_COMMAND,
  MASTRA_AGENT_TURN_TOTAL_TEXT_UTF16_MAX,
  mastraAgentTurnRefusalValue,
  parseMastraAgentTurnCancelRequest,
  parseMastraAgentTurnCancelResult,
  parseMastraAgentTurnStartRequest,
  parseMastraAgentTurnStartResult,
} from "./mastraAgentTurnWire.js";

const TURN_ID = "8f14e45f-ceea-467e-a5d4-1b9c6d0e2f3a";

function route(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function start(overrides: Record<string, unknown> = {}) {
  return {
    turnId: TURN_ID,
    chatSessionId: "session-1",
    messages: [
      { role: "system", content: "You write." },
      { role: "user", content: "Continue." },
    ],
    route: route(),
    systemCacheSegments: ["a", "b"],
    systemVolatileTail: "tail",
    tools: [],
    ...overrides,
  };
}

function issueOf(value: unknown): string | null {
  const parsed = parseMastraAgentTurnStartRequest(value);
  return parsed.ok ? null : parsed.issue;
}

describe("the commands and the refusal set", () => {
  it("names the two commands and the six refusal reasons, closed", () => {
    expect(MASTRA_AGENT_TURN_COMMANDS).toEqual([
      "mastra_agent_turn_start",
      "mastra_agent_turn_cancel",
    ]);
    expect(MASTRA_AGENT_TURN_REFUSAL_REASONS).toEqual([
      "gate-closed",
      "restricted",
      "unsupported",
      "busy",
      "sender-refused",
      "invalid",
    ]);
    expect(isMastraAgentTurnCommand(MASTRA_AGENT_TURN_START_COMMAND)).toBe(
      true,
    );
    expect(isMastraAgentTurnCommand(MASTRA_AGENT_TURN_CANCEL_COMMAND)).toBe(
      true,
    );
    expect(isMastraAgentTurnCommand("send_agent_message")).toBe(false);
    expect(isMastraAgentTurnCommand(undefined)).toBe(false);
  });

  it("builds a typed refusal per command", () => {
    expect(
      mastraAgentTurnRefusalValue("mastra_agent_turn_start", "busy"),
    ).toEqual({
      status: "refused",
      command: "start",
      reason: "busy",
    });
    expect(
      mastraAgentTurnRefusalValue("mastra_agent_turn_cancel", "gate-closed"),
    ).toEqual({ status: "refused", command: "cancel", reason: "gate-closed" });
  });

  it("supports the three providers of the adapter", () => {
    expect(MASTRA_AGENT_TURN_PROVIDERS).toEqual([
      "anthropic",
      "openai",
      "openrouter",
    ]);
    // The adapter's own list is the authority; a drift fails here.
    const policy = readFileSync(
      new URL("../main/mastra/agentModelPolicy.ts", import.meta.url),
      "utf8",
    );
    const listed = /AGENT_SUPPORTED_PROVIDERS = \[([^\]]*)\]/u.exec(
      policy,
    )?.[1];
    expect(
      listed?.match(/"([a-z]+)"/gu)?.map((name) => name.slice(1, -1)),
    ).toEqual([...MASTRA_AGENT_TURN_PROVIDERS]);
  });

  it("the route's keys are the adapter's route keys (the wire does not drift from AgentWireArgs)", () => {
    const adapterRoute = (AGENT_WIRE_ARG_KEYS as readonly string[]).filter(
      (key) =>
        !(
          [
            "messages",
            "tools",
            "systemCacheSegments",
            "systemVolatileTail",
            "chatMessageId",
            "auditContext",
            "callerIdentity",
          ] satisfies AgentAdapterOwnedKey[] as string[]
        ).includes(key),
    );
    expect([...MASTRA_AGENT_TURN_ROUTE_KEYS].sort()).toEqual(
      [...adapterRoute].sort(),
    );
  });
});

describe("parseMastraAgentTurnStartRequest", () => {
  it("accepts the exact request and returns the same object", () => {
    const request = start();
    const parsed = parseMastraAgentTurnStartRequest(request);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toBe(request);
  });

  it("accepts null segments and tail, the three providers and the optional route keys", () => {
    for (const provider of MASTRA_AGENT_TURN_PROVIDERS) {
      expect(
        issueOf(
          start({
            route: route({
              provider,
              requestMaxOutputTokens: 4096,
              resolvedToolProtocol: "native",
              thinking: { type: "enabled", budget: 1024 },
              webSearch: { enabled: true, domains: ["a.example"] },
              reasoningEnabled: true,
            }),
            systemCacheSegments: null,
            systemVolatileTail: null,
          }),
        ),
      ).toBeNull();
    }
  });

  it("refuses a value that is not an object, an array and a class instance", () => {
    for (const value of [null, undefined, "x", 1, [], new Date(), new Map()]) {
      expect(issueOf(value)).toBe("not-object");
    }
  });

  it("is exact on keys: an unknown key and a missing key", () => {
    expect(issueOf({ ...start(), extra: 1 })).toBe("unknown-key");
    for (const key of [
      "turnId",
      "chatSessionId",
      "messages",
      "route",
      "systemCacheSegments",
      "systemVolatileTail",
      "tools",
    ]) {
      const request: Record<string, unknown> = start();
      delete request[key];
      expect(issueOf(request), key).toBe("missing-key");
    }
    // An own `__proto__` key is an unknown key, not a prototype.
    const polluted = JSON.parse(`{"__proto__":{"x":1}}`) as Record<
      string,
      unknown
    >;
    expect(issueOf({ ...start(), ...polluted })).toBe("unknown-key");
  });

  it("refuses what is Main's: capability, auditContext, pathId, executionId, callerIdentity", () => {
    expect([...MASTRA_AGENT_TURN_FORBIDDEN_KEYS].sort()).toEqual(
      [
        "auditContext",
        "callerIdentity",
        "capabilities",
        "capability",
        "executionId",
        "pathId",
      ].sort(),
    );
    for (const key of MASTRA_AGENT_TURN_FORBIDDEN_KEYS) {
      expect(issueOf({ ...start(), [key]: "x" }), key).toBe("forbidden-key");
    }
    // Inside the route and a message too.
    expect(issueOf(start({ route: route({ pathId: "x" }) }))).toBe(
      "forbidden-key",
    );
    expect(
      issueOf(
        start({ messages: [{ role: "user", content: "a", capability: "x" }] }),
      ),
    ).toBe("forbidden-key");
  });

  it("does not see Main's own sidecar: a non-enumerable callerIdentity is skipped", () => {
    // The router defines the identity as a non-enumerable property on the
    // dispatch arguments; the parser must accept such an object.
    const request = { ...start() };
    Object.defineProperty(request, "callerIdentity", {
      value: { senderId: 1 },
      enumerable: false,
    });
    expect(issueOf(request)).toBeNull();
    // The same key, enumerable, is a forgery.
    expect(issueOf({ ...start(), callerIdentity: { senderId: 1 } })).toBe(
      "forbidden-key",
    );
  });

  it("refuses an accessor and an enumerable symbol key (not plain wire data)", () => {
    const withGetter = { ...start() };
    Object.defineProperty(withGetter, "chatSessionId", {
      get: () => "s",
      enumerable: true,
    });
    expect(issueOf(withGetter)).toBe("not-object");
    expect(issueOf({ ...start(), [Symbol("x")]: 1 })).toBe("not-object");
  });

  it("requires a canonical lower-case UUID turn ID", () => {
    for (const turnId of [
      "",
      "turn-1",
      TURN_ID.toUpperCase(),
      TURN_ID.slice(1),
      ` ${TURN_ID}`,
      "8f14e45f-ceea-967e-a5d4-1b9c6d0e2f3a",
      1,
      null,
    ]) {
      expect(issueOf(start({ turnId })), String(turnId)).toBe("turn-id");
    }
  });

  it("requires a trimmed, bounded, non-empty chatSessionId (an unsettled session is invalid)", () => {
    for (const chatSessionId of [
      "",
      " ",
      " s",
      "s ",
      null,
      undefined,
      7,
      "s".repeat(MASTRA_AGENT_TURN_ID_UTF16_MAX + 1),
    ]) {
      expect(issueOf(start({ chatSessionId })), String(chatSessionId)).toBe(
        "chat-session-id",
      );
    }
    expect(
      issueOf(
        start({ chatSessionId: "s".repeat(MASTRA_AGENT_TURN_ID_UTF16_MAX) }),
      ),
    ).toBeNull();
  });

  it("accepts messages of text only", () => {
    expect(issueOf(start({ messages: [] }))).toBe("messages");
    expect(issueOf(start({ messages: "x" }))).toBe("messages");
    // A hole is not a message.
    // eslint-disable-next-line no-sparse-arrays
    expect(
      issueOf(start({ messages: [, { role: "user", content: "a" }] })),
    ).toBe("messages");
    for (const message of [
      // tool calls, thinking blocks and tool results are not on this wire
      { role: "assistant", content: "a", toolUses: [] },
      { role: "assistant", content: "a", thinkingBlocks: [] },
      { role: "tool_result", toolUseId: "t", content: "a" },
      // a non-text content (an image, a block list, a number)
      { role: "user", content: [{ type: "image", url: "https://x" }] },
      { role: "user", content: { type: "text", text: "a" } },
      { role: "user", content: 1 },
      { role: "user", content: null },
      // an unknown role, a missing field, a non-object
      { role: "developer", content: "a" },
      { role: "user" },
      { content: "a" },
      "user: a",
      null,
    ]) {
      const issue = issueOf(start({ messages: [message] }));
      expect(
        issue === "message" || issue === "unknown-key",
        JSON.stringify(message),
      ).toBe(true);
    }
  });

  it("bounds the number of messages and the text", () => {
    const one = { role: "user", content: "a" };
    expect(
      issueOf(
        start({
          messages: Array.from(
            { length: MASTRA_AGENT_TURN_MESSAGES_MAX },
            () => one,
          ),
        }),
      ),
    ).toBeNull();
    expect(
      issueOf(
        start({
          messages: Array.from(
            { length: MASTRA_AGENT_TURN_MESSAGES_MAX + 1 },
            () => one,
          ),
        }),
      ),
    ).toBe("messages");
    expect(
      issueOf(
        start({
          messages: [
            {
              role: "user",
              content: "x".repeat(MASTRA_AGENT_TURN_MESSAGE_TEXT_UTF16_MAX),
            },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      issueOf(
        start({
          messages: [
            {
              role: "user",
              content: "x".repeat(MASTRA_AGENT_TURN_MESSAGE_TEXT_UTF16_MAX + 1),
            },
          ],
        }),
      ),
    ).toBe("text-too-long");
    // The total, from messages that are each within the bound.
    const chunk = "x".repeat(MASTRA_AGENT_TURN_MESSAGE_TEXT_UTF16_MAX);
    const needed =
      Math.floor(MASTRA_AGENT_TURN_TOTAL_TEXT_UTF16_MAX / chunk.length) + 1;
    expect(
      issueOf(
        start({
          messages: Array.from({ length: needed }, () => ({
            role: "user",
            content: chunk,
          })),
        }),
      ),
    ).toBe("text-too-long");
  });

  it("requires a route of a supported provider and no other key", () => {
    expect(issueOf(start({ route: null }))).toBe("route");
    expect(issueOf(start({ route: [] }))).toBe("route");
    const missing: Record<string, unknown> = route();
    delete missing.model;
    expect(issueOf(start({ route: missing }))).toBe("route");
    expect(issueOf(start({ route: route({ extra: 1 }) }))).toBe("unknown-key");
    for (const provider of [
      "ollama",
      "openai-compatible",
      "sakana",
      "ai-novelist",
      "cli",
      "",
      null,
      undefined,
      "Anthropic",
    ]) {
      expect(
        issueOf(start({ route: route({ provider }) })),
        String(provider),
      ).toBe("provider");
    }
  });

  it("checks the route's values", () => {
    for (const [key, value] of [
      ["model", 1],
      ["endpointId", {}],
      ["apiVariant", []],
      ["effort", 1],
      ["reasoningEnabled", "yes"],
      ["reasoningEffort", false],
      ["thinking", "x"],
      ["thinking", [1]],
      ["webSearch", 1],
      ["requestMaxOutputTokens", 0],
      ["requestMaxOutputTokens", 1.5],
      ["requestMaxOutputTokens", 4_294_967_296],
      ["requestMaxOutputTokens", "10"],
      ["resolvedToolProtocol", "mcp"],
      ["model", "m".repeat(2_001)],
    ] as const) {
      expect(
        issueOf(start({ route: route({ [key]: value }) })),
        `${key}=${String(value)}`,
      ).toBe("route-value");
    }
  });

  it("bounds the route's JSON (depth, nodes, non-JSON values)", () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (
      let depth = 0;
      depth < MASTRA_AGENT_TURN_ROUTE_JSON_DEPTH_MAX + 1;
      depth += 1
    ) {
      nested = { inner: nested };
    }
    expect(issueOf(start({ route: route({ thinking: nested }) }))).toBe(
      "route-value",
    );
    expect(
      issueOf(
        start({
          route: route({
            webSearch: { many: Array.from({ length: 600 }, (_, i) => i) },
          }),
        }),
      ),
    ).toBe("route-value");
    for (const bad of [
      { n: Number.NaN },
      { n: Infinity },
      { f: () => 1 },
      { d: new Date() },
      { u: undefined },
    ]) {
      expect(
        issueOf(start({ route: route({ thinking: bad }) })),
        JSON.stringify(bad),
      ).toBe("route-value");
    }
  });

  it("allows tool 0 only: tools must be the empty array", () => {
    expect(issueOf(start({ tools: [{ name: "t" }] }))).toBe("tools");
    expect(issueOf(start({ tools: null }))).toBe("tools");
    expect(issueOf(start({ tools: {} }))).toBe("tools");
    expect(issueOf(start({ tools: undefined }))).toBe("tools");
    // An empty array that carries an enumerable property is not empty.
    const tools = Object.assign([], { extra: { name: "t" } });
    expect(issueOf(start({ tools }))).toBe("tools");
  });

  it("checks the cache segments and the volatile tail", () => {
    expect(issueOf(start({ systemCacheSegments: "a" }))).toBe("segments");
    expect(issueOf(start({ systemCacheSegments: [1] }))).toBe("segments");
    expect(
      issueOf(
        start({
          systemCacheSegments: Array.from(
            { length: MASTRA_AGENT_TURN_SEGMENTS_MAX + 1 },
            () => "a",
          ),
        }),
      ),
    ).toBe("segments");
    expect(issueOf(start({ systemVolatileTail: 1 }))).toBe("volatile-tail");
    expect(
      issueOf(
        start({
          systemVolatileTail: "t".repeat(
            MASTRA_AGENT_TURN_MESSAGE_TEXT_UTF16_MAX + 1,
          ),
        }),
      ),
    ).toBe("volatile-tail");
  });

  it("counts the cache segments and the volatile tail toward the total text", () => {
    const chunk = "x".repeat(MASTRA_AGENT_TURN_MESSAGE_TEXT_UTF16_MAX);
    const full = Math.floor(
      MASTRA_AGENT_TURN_TOTAL_TEXT_UTF16_MAX / chunk.length,
    );
    const messages = Array.from({ length: full }, () => ({
      role: "user",
      content: chunk,
    }));
    const rest = MASTRA_AGENT_TURN_TOTAL_TEXT_UTF16_MAX - full * chunk.length;
    // Exactly at the total: accepted.
    expect(
      issueOf(
        start({
          messages,
          systemCacheSegments: ["y".repeat(rest)],
          systemVolatileTail: null,
        }),
      ),
    ).toBeNull();
    // One unit over, in the segments or in the tail.
    expect(
      issueOf(
        start({
          messages,
          systemCacheSegments: ["y".repeat(rest + 1)],
          systemVolatileTail: null,
        }),
      ),
    ).toBe("text-too-long");
    expect(
      issueOf(
        start({
          messages,
          systemCacheSegments: null,
          systemVolatileTail: "y".repeat(rest + 1),
        }),
      ),
    ).toBe("text-too-long");
    expect(
      issueOf(
        start({
          messages,
          systemCacheSegments: ["y".repeat(rest)],
          systemVolatileTail: "z",
        }),
      ),
    ).toBe("text-too-long");
  });

  it("tells whether a request's own keys include one that is Main's", () => {
    expect(hasMastraAgentTurnForbiddenKey(start())).toBe(false);
    for (const key of MASTRA_AGENT_TURN_FORBIDDEN_KEYS) {
      expect(hasMastraAgentTurnForbiddenKey({ ...start(), [key]: 1 })).toBe(
        true,
      );
    }
    // A non-enumerable key (Main's own sidecar) is not the renderer's.
    const sidecar = { ...start() };
    Object.defineProperty(sidecar, "callerIdentity", {
      value: {},
      enumerable: false,
    });
    expect(hasMastraAgentTurnForbiddenKey(sidecar)).toBe(false);
    expect(hasMastraAgentTurnForbiddenKey(null)).toBe(false);
  });

  it("never echoes a value of the request in its issue", () => {
    const secret = "sk-SECRET-VALUE-0123456789";
    for (const request of [
      start({ turnId: secret }),
      start({ chatSessionId: ` ${secret}` }),
      start({ messages: [{ role: secret, content: secret }] }),
      start({ route: route({ provider: secret }) }),
      { ...start(), [secret]: secret },
    ]) {
      const parsed = parseMastraAgentTurnStartRequest(request);
      expect(parsed.ok).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain("SECRET");
    }
  });
});

describe("parseMastraAgentTurnCancelRequest", () => {
  it("accepts exactly a UUID turnId", () => {
    const request = { turnId: TURN_ID };
    const parsed = parseMastraAgentTurnCancelRequest(request);
    expect(parsed.ok && parsed.value).toBe(request);
  });

  it("refuses every other shape", () => {
    expect(parseMastraAgentTurnCancelRequest({})).toEqual({
      ok: false,
      issue: "missing-key",
    });
    expect(parseMastraAgentTurnCancelRequest({ turnId: "x" })).toEqual({
      ok: false,
      issue: "turn-id",
    });
    expect(
      parseMastraAgentTurnCancelRequest({ turnId: TURN_ID, extra: 1 }),
    ).toEqual({
      ok: false,
      issue: "unknown-key",
    });
    expect(
      parseMastraAgentTurnCancelRequest({ turnId: TURN_ID, executionId: "e" }),
    ).toEqual({
      ok: false,
      issue: "forbidden-key",
    });
    expect(parseMastraAgentTurnCancelRequest(null)).toEqual({
      ok: false,
      issue: "not-object",
    });
  });
});

describe("the results", () => {
  it("accepts a refusal for each reason and the completed value", () => {
    for (const reason of MASTRA_AGENT_TURN_REFUSAL_REASONS) {
      const refused = { status: "refused", command: "start", reason };
      expect(parseMastraAgentTurnStartResult(refused)).toBe(refused);
      const cancelRefused = { status: "refused", command: "cancel", reason };
      expect(parseMastraAgentTurnCancelResult(cancelRefused)).toBe(
        cancelRefused,
      );
    }
    const completed = {
      status: "completed",
      turnId: TURN_ID,
      executionId: "e-1",
      response: { blocks: [], stopReason: "end_turn" },
    };
    expect(parseMastraAgentTurnStartResult(completed)).toBe(completed);
    const ok = { status: "ok", turnId: TURN_ID, found: false };
    expect(parseMastraAgentTurnCancelResult(ok)).toBe(ok);
  });

  it("refuses an answer that is not of the route (drift in either direction)", () => {
    for (const value of [
      null,
      "x",
      {},
      { status: "refused", command: "cancel", reason: "busy" },
      { status: "refused", command: "start", reason: "nope" },
      { status: "refused", command: "start", reason: "busy", extra: 1 },
      { status: "completed", turnId: TURN_ID, executionId: "e", response: [] },
      { status: "completed", turnId: "t", executionId: "e", response: {} },
      { status: "completed", turnId: TURN_ID, executionId: "", response: {} },
      {
        status: "completed",
        turnId: TURN_ID,
        executionId: "e",
        response: {},
        extra: 1,
      },
    ]) {
      expect(
        parseMastraAgentTurnStartResult(value),
        JSON.stringify(value),
      ).toBeNull();
    }
    for (const value of [
      { status: "ok", turnId: TURN_ID },
      { status: "ok", turnId: "t", found: true },
      { status: "ok", turnId: TURN_ID, found: 1 },
      { status: "refused", command: "start", reason: "busy" },
      { status: "cancelled", turnId: TURN_ID, found: true },
    ]) {
      expect(
        parseMastraAgentTurnCancelResult(value),
        JSON.stringify(value),
      ).toBeNull();
    }
  });
});
