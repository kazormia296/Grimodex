import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * search_events with approved IR (chat IR S1-B PR-B2, commit 3b): B-T7〜B-T15.
 *
 * The constant is opened here only (`vi.mock`); the product's constant stays
 * `false` (B-T6). The wrapper is the real one: `invoke` is the Native call.
 * One character is one token (`countTokens` of the stub), so the cap arithmetic
 * is exact and the agent loop's own cut can be compared with the executor's.
 */
const h = vi.hoisted(() => ({
  gate: { enabled: true },
  tree: {
    projectId: "p-store" as string | null,
    nodes: [] as unknown[],
    activeSceneId: "s0" as string | undefined,
  },
  hits: [] as Array<{
    eventId: string;
    title: string;
    kind: string;
    score: number;
  }>,
  events: [] as Array<{ id: string; secret: boolean; revealSceneId: null }>,
  sceneEvents: [] as Array<{ eventId: string; sceneId: string }>,
  readingOrder: new Map<string, number>(),
  invoke: vi.fn(),
  semantic: vi.fn(),
  log: [] as string[],
}));

vi.mock("./chatAgentIrAvailability", () => ({
  get CHAT_AGENT_IR_ENABLED() {
    return h.gate.enabled;
  },
}));
vi.mock("@/features/chat/agent/chatAgentIrAvailability", () => ({
  get CHAT_AGENT_IR_ENABLED() {
    return h.gate.enabled;
  },
}));
vi.mock("@/lib/tauri", () => ({
  invoke: h.invoke,
  isD2aEgressDenied: () => false,
  isIpcLifecycleCancellation: () => false,
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: () => h.tree },
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p-store",
}));
vi.mock("@/features/semantic-search/api", () => ({
  eventsSemanticSearch: h.semantic,
  codexSemanticSearch: vi.fn(async () => []),
}));
vi.mock("./chronicleToolCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chronicleToolCache")>()),
  getSharedEvents: async () => h.events,
  getSharedSceneEvents: async () => h.sceneEvents,
  getSharedReadingOrder: () => h.readingOrder,
  invalidateChronicleToolCache: () => {},
}));
vi.mock("../contextBuilder", () => ({
  ensureTokenizer: vi.fn(async () => {}),
  countTokens: (s: string) => (s ? s.length : 0),
}));
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/features/tree/api", () => ({ loadSceneContent: vi.fn() }));
vi.mock("@/features/codex/prosemirrorTextExtractor", () => ({
  extractPlainText: vi.fn(),
}));
vi.mock("@/features/foreshadow/api", () => ({
  listOpenForeshadowsForContext: vi.fn(),
}));
vi.mock("@/features/agent-writes/codex", () => ({}));
vi.mock("@/features/agent-writes/snippet", () => ({}));
vi.mock("@/features/agent-writes/foreshadow", () => ({}));
vi.mock("@/features/agent-writes/event", () => ({}));

import {
  createChatTurnToolContext,
  createGuardedExecuteTool,
  withUiOperationLimit,
} from "@/application/chat/chatAgentToolHandlers";
import type { ChatAgentIrItem } from "@/../electron/shared/chatAgentIrWire";
import { CHAT_AGENT_IR_STATUSES } from "@/../electron/shared/chatAgentIrWire";
import { runAgentLoop } from "./agentLoop";
import type {
  AgentLLMResponse,
  AgentMessagePayload,
  ToolCallRecord,
} from "./agentTypes";
import type { ChatIrCapability, ChatTurnToolScope } from "./chatTurnToolScope";
import {
  CHAT_IR_MAX_CALLS_PER_TURN,
  CHAT_IR_MAX_CHARS_PER_TURN,
  buildChatIrContent,
} from "./chatIrToolResult";
import { executeReadOnlyTool, executeTool } from "./toolExecutors";

// Reading order: s0 < s1 < s2 < s3.
const ORDER = new Map([
  ["s0", 0],
  ["s1", 1],
  ["s2", 2],
  ["s3", 3],
]);

function item(index: number, summary = "approved summary"): ChatAgentIrItem {
  return {
    $grimodexIr: 1,
    origin: "manuscript",
    revisionId: `rev-${index}`,
    sceneId: `scene-${index}`,
    sceneTitle: `Scene ${index}`,
    summary,
    review: "human-approved",
    quotes: [`quote ${index}`],
    score: 0.5,
  };
}

function answer(
  items: ChatAgentIrItem[],
  status = "available",
  extra: {
    eventIds?: Record<string, string>;
    excludedEventIds?: string[] | null;
  } = {},
) {
  const success = status === "available" || status === "none-above-threshold";
  return {
    status,
    success,
    items,
    eventIds: extra.eventIds ?? {},
    excludedEventIds:
      extra.excludedEventIds !== undefined
        ? extra.excludedEventIds
        : success
          ? []
          : null,
  };
}

function hit(eventId: string, title = `title ${eventId}`) {
  return { eventId, title, kind: "event", score: 0.9 };
}

const SCOPE: ChatTurnToolScope = { projectId: "p-turn", currentSceneId: "s2" };

function makeIr(over: Partial<ChatIrCapability> = {}) {
  const noted: Array<{
    key: object;
    ids: readonly string[];
    eventIds: readonly string[];
  }> = [];
  const ir: ChatIrCapability = {
    workspacePath: "/w",
    tokenCap: 100_000,
    counter: { chars: 0, calls: 0 },
    assertCurrent: () => {},
    noteUsedIds: (key, ids, eventIds) => {
      noted.push({ key, ids, eventIds });
    },
    ...over,
  };
  return { ir, noted };
}

async function runSearch(
  ir: ChatIrCapability | undefined,
  params: Record<string, unknown> = { query: "the secret door" },
  scope: ChatTurnToolScope | undefined = SCOPE,
) {
  return executeTool("search_events", "t1", params, undefined, {
    scope,
    ir,
  });
}

function contentOf(result: { content: unknown }) {
  return result.content as {
    chronicleIr: {
      status: string;
      items: ChatAgentIrItem[];
      eventIds?: Record<string, string>;
      note?: string;
    };
    events: Array<{ eventId: string }>;
  };
}

beforeEach(() => {
  h.gate.enabled = true;
  h.tree.projectId = "p-store";
  h.tree.activeSceneId = "s0";
  h.hits = [hit("e1"), hit("e2")];
  h.events = [
    { id: "e1", secret: false, revealSceneId: null },
    { id: "e2", secret: false, revealSceneId: null },
  ];
  h.sceneEvents = [];
  h.readingOrder = ORDER;
  h.log = [];
  h.invoke.mockReset();
  h.invoke.mockImplementation(async () => answer([item(1)]));
  h.semantic.mockReset();
  h.semantic.mockImplementation(async () => h.hits);
});

describe("B-T8: the sub-agent's path", () => {
  beforeEach(() => {
    h.hits = [hit("before"), hit("at"), hit("after"), hit("untied")];
    h.events = h.hits.map((x) => ({
      id: x.eventId,
      secret: false,
      revealSceneId: null,
    }));
    h.sceneEvents = [
      { eventId: "before", sceneId: "s1" },
      { eventId: "at", sceneId: "s2" },
      { eventId: "after", sceneId: "s3" },
    ];
  });

  it("never calls Native, has no IR in the content, and filters by the bound Scene", async () => {
    // The store's Scene would let s0 hide more; the bound Scene (s2) decides.
    h.tree.activeSceneId = "s0";
    const result = await executeReadOnlyTool(
      "search_events",
      "t1",
      { query: "q" },
      { scope: SCOPE },
    );
    expect(h.invoke).not.toHaveBeenCalled();
    expect(Array.isArray(result.content)).toBe(true);
    expect(JSON.stringify(result.content)).not.toContain("$grimodexIr");
    expect(
      (result.content as Array<{ eventId: string }>).map((e) => e.eventId),
    ).toEqual(["before", "at", "untied"]);
  });

  it("does not take the IR branch even when a runtime `ir` is smuggled in", async () => {
    const { ir } = makeIr();
    const result = await executeReadOnlyTool(
      "search_events",
      "t1",
      { query: "q" },
      { scope: SCOPE, ir } as never,
    );
    expect(h.invoke).not.toHaveBeenCalled();
    expect(Array.isArray(result.content)).toBe(true);
  });

  it("does not call Native while the constant is false, even with an IR capability (summary is today's)", async () => {
    h.gate.enabled = false;
    const { ir } = makeIr();
    const result = await runSearch(ir);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(ir.counter).toEqual({ chars: 0, calls: 0 });
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.summary).toBe("4 events found");
  });

  it("keeps today's content while the constant is false (no position filter)", async () => {
    h.gate.enabled = false;
    const result = await executeReadOnlyTool(
      "search_events",
      "t1",
      { query: "q" },
      { scope: SCOPE },
    );
    expect(
      (result.content as Array<{ eventId: string }>).map((e) => e.eventId),
    ).toEqual(["before", "at", "after", "untied"]);
  });
});

describe("B-T10: the position filter lives in the shared searchEvents", () => {
  beforeEach(() => {
    h.hits = [hit("before"), hit("after")];
    h.events = [
      { id: "before", secret: false, revealSceneId: null },
      { id: "after", secret: false, revealSceneId: null },
    ];
    h.sceneEvents = [
      { eventId: "before", sceneId: "s1" },
      { eventId: "after", sceneId: "s3" },
    ];
  });

  it("applies in both paths while the constant is true, and in neither while false", async () => {
    const { ir } = makeIr();
    const main = contentOf(await runSearch(ir));
    expect(main.events.map((e) => e.eventId)).toEqual(["before"]);
    const sub = await executeReadOnlyTool(
      "search_events",
      "t1",
      { query: "q" },
      { scope: SCOPE },
    );
    expect(
      (sub.content as Array<{ eventId: string }>).map((e) => e.eventId),
    ).toEqual(["before"]);

    h.gate.enabled = false;
    const plain = await runSearch(undefined);
    expect(
      (plain.content as Array<{ eventId: string }>).map((e) => e.eventId),
    ).toEqual(["before", "after"]);
  });

  it("cuts the position filter before slice(limit), in both paths", async () => {
    // The first hit is a later event: a filter after the slice would return [].
    h.hits = [hit("after"), hit("before")];
    const { ir } = makeIr();
    const main = contentOf(await runSearch(ir, { query: "q", limit: 1 }));
    expect(main.events.map((e) => e.eventId)).toEqual(["before"]);
    const sub = await executeReadOnlyTool(
      "search_events",
      "t1",
      { query: "q", limit: 1 },
      { scope: SCOPE },
    );
    expect(
      (sub.content as Array<{ eventId: string }>).map((e) => e.eventId),
    ).toEqual(["before"]);
  });

  it("hides a secret event that reveals later than the bound Scene", async () => {
    h.events = [
      { id: "before", secret: true, revealSceneId: "s3" as never },
      { id: "after", secret: false, revealSceneId: null },
    ];
    const { ir } = makeIr();
    const out = contentOf(await runSearch(ir));
    expect(out.events).toEqual([]);
  });

  it("decides the secrecy by the bound Scene, not the store's (main and sub-agent)", async () => {
    // Revealed at s1: visible at the bound s2, hidden at the store's s0.
    h.events = [
      { id: "before", secret: true, revealSceneId: "s1" as never },
      { id: "after", secret: false, revealSceneId: null },
    ];
    h.tree.activeSceneId = "s0";
    const { ir } = makeIr();
    const main = contentOf(await runSearch(ir));
    expect(main.events.map((e) => e.eventId)).toEqual(["before"]);
    const sub = await executeReadOnlyTool(
      "search_events",
      "t1",
      { query: "q" },
      { scope: SCOPE },
    );
    expect(
      (sub.content as Array<{ eventId: string }>).map((e) => e.eventId),
    ).toEqual(["before"]);
  });

  it("reads the store's Scene after the awaits for a caller without a scope (constant false)", async () => {
    h.gate.enabled = false;
    h.events = [
      { id: "before", secret: true, revealSceneId: "s1" as never },
      { id: "after", secret: false, revealSceneId: null },
    ];
    h.tree.activeSceneId = "s0";
    // The Scene changes while the semantic search is awaited: today's code
    // judges the secrecy by the Scene read after the awaits (s2: visible).
    h.semantic.mockImplementation(async () => {
      h.tree.activeSceneId = "s2";
      return h.hits;
    });
    const result = await executeTool("search_events", "t1", { query: "q" });
    expect(
      (result.content as Array<{ eventId: string }>).map((e) => e.eventId),
    ).toEqual(["before", "after"]);
  });

  it("falls back to the store's Scene for a caller without a turn scope", async () => {
    h.tree.activeSceneId = "s2";
    h.tree.projectId = "p-store";
    const result = await executeTool(
      "search_events",
      "t1",
      { query: "q" },
      undefined,
      undefined,
    );
    expect(
      (result.content as Array<{ eventId: string }>).map((e) => e.eventId),
    ).toEqual(["before"]);
    expect(h.semantic).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p-store" }),
    );
  });
});

describe("B-T9: the Scene and the project of the bound scope", () => {
  it("uses the scope's Scene and project though the store moves between two calls", async () => {
    const { ir } = makeIr();
    h.tree.activeSceneId = "s0";
    h.tree.projectId = "p-other";
    await runSearch(ir);
    h.tree.activeSceneId = "s3";
    await runSearch(ir);
    expect(h.invoke).toHaveBeenCalledTimes(2);
    for (const call of h.invoke.mock.calls) {
      expect(call[1]).toEqual({
        query: "the secret door",
        projectId: "p-turn",
        expectedWorkspacePath: "/w",
        currentSceneId: "s2",
        // 秘匿と位置の filter の後の年表の候補（c3）。
        chronicleEventIds: ["e1", "e2"],
      });
    }
    expect(h.semantic).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p-turn" }),
    );
  });

  it("does not call Native without a Scene or a workspace, and says why", async () => {
    const noScene = contentOf(
      await runSearch(makeIr().ir, undefined, {
        projectId: "p-turn",
        currentSceneId: null,
      }),
    );
    expect(noScene.chronicleIr.status).toBe("no-current-scene");
    const noWorkspace = contentOf(
      await runSearch(makeIr({ workspacePath: null }).ir),
    );
    expect(noWorkspace.chronicleIr.status).toBe("no-workspace");
    expect(h.invoke).not.toHaveBeenCalled();
    // The year table still returns, and the refusals are not counted as calls.
    expect(noScene.events.length).toBe(2);
  });

  it.each([
    ["no workspace", { workspacePath: null }, undefined, undefined],
    [
      "no current Scene",
      {},
      { projectId: "p-turn", currentSceneId: null },
      undefined,
    ],
    ["a query over the bound", {}, undefined, "あ".repeat(501)],
  ] as const)(
    "does not count a refusal before the IPC as a call of Native (%s)",
    async (_name, over, scope, query) => {
      const { ir } = makeIr(over as Partial<ChatIrCapability>);
      await runSearch(
        ir,
        query === undefined ? undefined : { query },
        scope as ChatTurnToolScope | undefined,
      );
      expect(h.invoke).not.toHaveBeenCalled();
      expect(ir.counter).toEqual({ chars: 0, calls: 0 });
    },
  );
});

describe("B-T11: a failure is separated from the year table", () => {
  it.each(CHAT_AGENT_IR_STATUSES)(
    "Native status %s: the year table returns, the tool does not fail, one call",
    async (status) => {
      h.invoke.mockImplementation(async () => answer([], status));
      const result = await runSearch(makeIr().ir);
      expect(result.error).toBeUndefined();
      const content = contentOf(result);
      expect(content.chronicleIr.status).toBe(status);
      expect(content.events.map((e) => e.eventId)).toEqual(["e1", "e2"]);
      expect(h.invoke).toHaveBeenCalledTimes(1);
      if (status === "available") {
        expect(content.chronicleIr.note).toBeUndefined();
      } else if (status === "none-above-threshold") {
        expect(content.chronicleIr.note).toMatch(/search completed/);
      } else if (status === "query-invalid") {
        expect(content.chronicleIr.note).toMatch(/query was rejected/);
      } else {
        expect(content.chronicleIr.note).toMatch(/not evidence/);
      }
    },
  );

  it("maps the wrapper's own failures to a status and keeps the year table", async () => {
    const cases: Array<[unknown, string]> = [
      [{ code: "IPC_TIMEOUT" }, "caller-timeout"],
      [new Error("boom"), "ipc-error"],
      [new Error("CHAT_IR_GATE_CLOSED"), "gate-closed"],
    ];
    for (const [error, status] of cases) {
      h.invoke.mockReset();
      h.invoke.mockRejectedValue(error);
      const result = await runSearch(makeIr().ir);
      expect(result.error).toBeUndefined();
      expect(contentOf(result).chronicleIr.status).toBe(status);
      expect(contentOf(result).events.length).toBe(2);
      expect(h.invoke).toHaveBeenCalledTimes(1);
    }
    h.invoke.mockReset();
    h.invoke.mockResolvedValue({ nonsense: true });
    expect(contentOf(await runSearch(makeIr().ir)).chronicleIr.status).toBe(
      "invalid-response",
    );
  });

  it("tells 'nothing matched' from a failure by the note", async () => {
    h.invoke.mockResolvedValue(answer([], "none-above-threshold"));
    const none = contentOf(await runSearch(makeIr().ir)).chronicleIr;
    h.invoke.mockResolvedValue(answer([], "busy"));
    const busy = contentOf(await runSearch(makeIr().ir)).chronicleIr;
    expect(none.note).not.toEqual(busy.note);
    expect(none.note).not.toMatch(/not evidence/);
  });
});

describe("B-T12: authority after the await", () => {
  it("asks assertCurrent after Native, and a throw becomes the tool's error, not an item", async () => {
    const order: string[] = [];
    h.invoke.mockImplementation(async () => {
      order.push("invoke");
      return answer([item(1)]);
    });
    const { ir, noted } = makeIr({
      assertCurrent: () => {
        order.push("assertCurrent");
        throw new Error("project changed");
      },
    });
    const result = await runSearch(ir);
    expect(order).toEqual(["invoke", "assertCurrent"]);
    expect(result.error).toBe("project changed");
    expect(result.content).toBeNull();
    expect(noted).toEqual([]);
  });

  it("passes the turn's project to the year table and Native, not the store's", async () => {
    h.tree.projectId = "p-store";
    await runSearch(makeIr().ir);
    expect(h.semantic).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p-turn" }),
    );
    expect(h.invoke.mock.calls[0]![1]).toMatchObject({ projectId: "p-turn" });
  });
});

describe("B-T13: the year table first, then one call of Native", () => {
  it("calls Native only after the year table has resolved", async () => {
    let resolveHits!: (value: typeof h.hits) => void;
    h.semantic.mockImplementation(
      () =>
        new Promise((resolve) => {
          h.log.push("semantic-start");
          resolveHits = (value) => {
            h.log.push("semantic-done");
            resolve(value);
          };
        }),
    );
    h.invoke.mockImplementation(async () => {
      h.log.push("invoke");
      return answer([item(1)]);
    });
    const pending = runSearch(makeIr().ir);
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Promise.all would already have called Native here.
    expect(h.log).toEqual(["semantic-start"]);
    expect(h.invoke).not.toHaveBeenCalled();
    resolveHits(h.hits);
    await pending;
    expect(h.log).toEqual(["semantic-start", "semantic-done", "invoke"]);
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });
});

describe("B-T14: the cumulative limit of a turn", () => {
  it("does not call Native past the call limit, and a fresh counter starts over", async () => {
    const { ir } = makeIr();
    for (let n = 0; n < CHAT_IR_MAX_CALLS_PER_TURN; n += 1) {
      expect(contentOf(await runSearch(ir)).chronicleIr.status).toBe(
        "available",
      );
    }
    expect(h.invoke).toHaveBeenCalledTimes(CHAT_IR_MAX_CALLS_PER_TURN);
    const over = contentOf(await runSearch(ir));
    expect(over.chronicleIr.status).toBe("turn-limit");
    expect(over.events.length).toBe(2);
    expect(h.invoke).toHaveBeenCalledTimes(CHAT_IR_MAX_CALLS_PER_TURN);

    const next = makeIr().ir;
    expect(contentOf(await runSearch(next)).chronicleIr.status).toBe(
      "available",
    );
  });

  it("does not call Native once the character limit is spent", async () => {
    const { ir } = makeIr({
      counter: { chars: CHAT_IR_MAX_CHARS_PER_TURN, calls: 0 },
    });
    const out = contentOf(await runSearch(ir));
    expect(out.chronicleIr.status).toBe("turn-limit");
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("counts UTF-16 length, not characters", async () => {
    const astral = item(1, "𠮷".repeat(20));
    h.invoke.mockResolvedValue(answer([astral]));
    const { ir } = makeIr();
    await runSearch(ir);
    const expected = JSON.stringify(astral).length;
    expect(ir.counter.chars).toBe(expected);
    expect([...JSON.stringify(astral)].length).toBeLessThan(expected);
  });

  it("counts the sum of every item that is left, not of the dropped ones", async () => {
    const items = [item(1, "a".repeat(30)), item(2, "b".repeat(40)), item(3)];
    h.invoke.mockResolvedValue(answer(items));
    const { ir } = makeIr();
    const out = contentOf(await runSearch(ir, { query: "q", limit: 2 }));
    expect(out.chronicleIr.items.map((i) => i.revisionId)).toEqual([
      "rev-1",
      "rev-2",
    ]);
    expect(ir.counter.chars).toBe(
      JSON.stringify(items[0]).length + JSON.stringify(items[1]).length,
    );
  });

  it("keeps the turn's char total within the limit: only the items that fit are left", async () => {
    const items = [item(1), item(2), item(3)];
    const one = JSON.stringify(items[0]).length;
    h.invoke.mockResolvedValue(answer(items));
    const used = CHAT_IR_MAX_CHARS_PER_TURN - one * 2 + 1;
    const { ir } = makeIr({ counter: { chars: used, calls: 0 } });
    const out = contentOf(await runSearch(ir));
    expect(out.chronicleIr.status).toBe("available");
    expect(out.chronicleIr.items).toHaveLength(1);
    expect(ir.counter.chars).toBe(used + one);
    expect(ir.counter.chars).toBeLessThanOrEqual(CHAT_IR_MAX_CHARS_PER_TURN);
  });

  it("answers turn-limit when Native's items do not fit what is left of the turn", async () => {
    h.invoke.mockResolvedValue(answer([item(1)]));
    const used = CHAT_IR_MAX_CHARS_PER_TURN - 1;
    const { ir, noted } = makeIr({ counter: { chars: used, calls: 0 } });
    const out = contentOf(await runSearch(ir));
    expect(out.chronicleIr.status).toBe("turn-limit");
    expect(out.chronicleIr.items).toEqual([]);
    expect(ir.counter.chars).toBe(used);
    expect(noted).toEqual([]);
  });

  it("does not spend the limit on a precheck that never called Native", async () => {
    h.hits = [hit("e1", "x".repeat(400))];
    const { ir } = makeIr({ tokenCap: 100 });
    const out = contentOf(await runSearch(ir));
    expect(out.chronicleIr.status).toBe("cap-exceeded");
    expect(h.invoke).not.toHaveBeenCalled();
    expect(ir.counter).toEqual({ chars: 0, calls: 0 });
  });
});

describe("usedIds and the result's shape", () => {
  it("notes only the kept items' revision IDs, keyed by params", async () => {
    const items = [item(1), item(2), item(3)];
    h.invoke.mockResolvedValue(answer(items));
    const { ir, noted } = makeIr();
    const params = { query: "q", limit: 2 };
    const result = await runSearch(ir, params);
    const content = contentOf(result);
    // `limit` 2 drops the third; the model never saw it.
    expect(content.chronicleIr.items.map((i) => i.revisionId)).toEqual([
      "rev-1",
      "rev-2",
    ]);
    expect(noted).toHaveLength(1);
    expect(noted[0]!.key).toBe(params);
    expect(noted[0]!.ids).toEqual(["rev-1", "rev-2"]);
    expect(result.summary).toBe("manuscript 2, chronicle 2");
    expect(JSON.stringify(content)).toContain(JSON.stringify(items[0]));
  });

  it("notes nothing when no item is given", async () => {
    h.invoke.mockResolvedValue(answer([], "none-above-threshold"));
    const { ir, noted } = makeIr();
    await runSearch(ir);
    expect(noted).toEqual([]);
  });

  it("returns today's array for a caller without an IR capability", async () => {
    const result = await runSearch(undefined);
    expect(Array.isArray(result.content)).toBe(true);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(result.summary).toBe("2 events found");
  });

  it("keeps a slot for IR when 0 < limit < 1 (no empty `available`)", async () => {
    h.invoke.mockResolvedValue(answer([item(1), item(2)]));
    const out = contentOf(
      await runSearch(makeIr().ir, { query: "q", limit: 0.5 }),
    );
    expect(out.chronicleIr.status).toBe("available");
    expect(out.chronicleIr.items).toHaveLength(1);
  });

  it("leaves an empty query to the year table's own answer", async () => {
    const result = await runSearch(makeIr().ir, { query: "  " });
    expect(result.content).toEqual([]);
    expect(h.invoke).not.toHaveBeenCalled();
  });
});

describe("the real agent loop (B-T7, B-T15)", () => {
  function toolUse(params: Record<string, unknown>): AgentLLMResponse {
    return {
      blocks: [
        { type: "tool_use", id: "tu-1", name: "search_events", input: params },
      ],
      stopReason: "tool_use",
    };
  }

  async function runLoop(input: {
    tokenBudget: number;
    params?: Record<string, unknown>;
  }) {
    const assertTurnAuthority = vi.fn();
    const context = createChatTurnToolContext({
      executeTool,
      executeReadOnlyTool,
      enabled: true,
      projectId: "p-turn",
      workspacePath: "/w",
      currentSceneId: "s2",
      tokenBudget: input.tokenBudget,
      assertTurnAuthority,
    });
    const guarded = createGuardedExecuteTool({
      executeTool: context.executeTool,
      assertTurnAuthority,
      handleAskUserTool: (() => null) as never,
      runResearchSubagent: (() => null) as never,
      beforeExecute: async () => null,
      fullyInjectedIds: new Set(),
      chatMessageId: "m1",
    });
    const accToolCalls: ToolCallRecord[] = [];
    const sent: AgentMessagePayload[][] = [];
    const params = input.params ?? { query: "the secret door" };
    let step = 0;
    const result = await runAgentLoop({
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "search_events",
          description: "d",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
      tokenBudget: input.tokenBudget,
      sendToLLM: async (messages) => {
        sent.push([...messages]);
        step += 1;
        return step === 1
          ? toolUse(params)
          : {
              blocks: [{ type: "text", content: "done" }],
              stopReason: "end_turn",
            };
      },
      executeTool: withUiOperationLimit(guarded),
      onProgress: () => {},
      onTextChunk: () => {},
      onToolComplete: (record) => {
        // The turn writes usedIds first, before anything can return early.
        // The store's own wiring (this position, the bound executors) is held by
        // chatTurnStoreActions.chatIrWiring.static.test.ts.
        context.attachUsedIds(record);
        accToolCalls.push(record);
      },
      callLimitMessage: "CALL_LIMIT",
      tokenBudgetMessage: "TOKEN_LIMIT",
    });
    const last = sent[sent.length - 1]!;
    const toolResult = last.find((m) => m.role === "tool_result") as
      | { content: string }
      | undefined;
    return { result, accToolCalls, toolText: toolResult?.content ?? "" };
  }

  it("B-T7: keeps the IR content under the loop's cut (no [truncated), dropping items from the tail", async () => {
    const items = Array.from({ length: 8 }, (_, index) =>
      item(index + 1, "s".repeat(60)),
    );
    h.invoke.mockResolvedValue(answer(items));
    // cap = floor(2000 * 0.25) = 500 characters.
    const { toolText } = await runLoop({ tokenBudget: 2000 });
    expect(toolText).not.toContain("[truncated");
    expect(toolText.length).toBeLessThanOrEqual(500);
    const content = JSON.parse(toolText) as ReturnType<typeof contentOf>;
    const kept = content.chronicleIr.items;
    expect(kept.length).toBeGreaterThanOrEqual(1);
    expect(kept.length).toBeLessThan(8);
    // The tail goes; what stays is the head, unchanged.
    expect(kept).toEqual(items.slice(0, kept.length));
    expect(content.events.length).toBe(2);
  });

  it("B-T7: the cap ratio the executor copies is the loop's (a drift shows as [truncated)", async () => {
    const items = Array.from({ length: 8 }, (_, index) =>
      item(index + 1, "s".repeat(60)),
    );
    h.invoke.mockResolvedValue(answer(items));
    for (const tokenBudget of [1200, 2000, 4000, 9000]) {
      const { toolText } = await runLoop({ tokenBudget });
      expect(toolText, String(tokenBudget)).not.toContain("[truncated");
    }
  });

  it("B-T7: when the year table alone uses the cap, Native is not called", async () => {
    h.hits = [hit("e1", "x".repeat(600))];
    h.invoke.mockResolvedValue(answer([item(1)]));
    const { toolText } = await runLoop({ tokenBudget: 2000 });
    expect(h.invoke).not.toHaveBeenCalled();
    // The loop's own cut takes over, and the status at the head survives.
    expect(toolText).toContain('"status":"cap-exceeded"');
  });

  it("B-T15: usedIds reach the accumulated record and the loop's final record by params identity", async () => {
    const items = [item(1, "SENTINEL-SUMMARY"), item(2)];
    h.invoke.mockResolvedValue(answer(items));
    const { result, accToolCalls } = await runLoop({ tokenBudget: 100_000 });
    expect(accToolCalls).toHaveLength(1);
    expect(result.toolCallRecords).toHaveLength(1);
    const expected = {
      revisionIds: ["rev-1", "rev-2"],
      eventIds: [],
      generation: null,
    };
    expect(accToolCalls[0]!.usedIds).toEqual(expected);
    expect(result.toolCallRecords[0]!.usedIds).toEqual(expected);
    // The same record object, so one write serves both.
    expect(result.toolCallRecords[0]).toBe(accToolCalls[0]);
    // The saved metadata has ids and a count, never the item's text.
    const metadata = JSON.stringify(accToolCalls);
    expect(metadata).not.toContain("SENTINEL-SUMMARY");
    expect(metadata).not.toContain("quote 1");
    expect(metadata).not.toContain("Scene 1");
    expect(accToolCalls[0]!.resultSummary).toBe("manuscript 2, chronicle 2");
  });

  it("B-T15: items dropped by the cap are not in usedIds", async () => {
    const items = Array.from({ length: 8 }, (_, index) =>
      item(index + 1, "s".repeat(60)),
    );
    h.invoke.mockResolvedValue(answer(items));
    const { accToolCalls, toolText } = await runLoop({ tokenBudget: 2000 });
    const content = JSON.parse(toolText) as ReturnType<typeof contentOf>;
    expect(accToolCalls[0]!.usedIds!.revisionIds).toEqual(
      content.chronicleIr.items.map((i) => i.revisionId),
    );
  });

  it("B-T15: a repeated query asks Native again (nothing is memoized)", async () => {
    h.invoke.mockResolvedValue(answer([item(1)]));
    const { ir } = makeIr();
    await runSearch(ir);
    await runSearch(ir);
    expect(h.invoke).toHaveBeenCalledTimes(2);
  });

  it("B-T15: a params copy breaks the link (the mutation this identity guards against)", async () => {
    // The executor keys by the object it was given; a record with another
    // object gets nothing.
    h.invoke.mockResolvedValue(answer([item(1)]));
    const assertTurnAuthority = vi.fn();
    const context = createChatTurnToolContext({
      executeTool,
      executeReadOnlyTool,
      enabled: true,
      projectId: "p-turn",
      workspacePath: "/w",
      currentSceneId: "s2",
      tokenBudget: 100_000,
      assertTurnAuthority,
    });
    const params = { query: "q" };
    await context.executeTool("search_events", "t1", params);
    const copy = { params: { ...params } } as {
      params: Record<string, unknown>;
      usedIds?: unknown;
    };
    context.attachUsedIds(copy as never);
    expect(copy.usedIds).toBeUndefined();
    const same = { params } as {
      params: Record<string, unknown>;
      usedIds?: unknown;
    };
    context.attachUsedIds(same as never);
    expect(same.usedIds).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// S1-A2b c3 (P15〜P18): the year table's candidates, the exclusion, the merge.
// ---------------------------------------------------------------------------

type EventRowStub = { id: string; secret: boolean; revealSceneId: null };

/** The current Scene is s2 (SCOPE). */
function setChronicle(
  rows: Array<{
    id: string;
    secret?: boolean;
    reveal?: string;
    ties?: string[];
    title?: string;
  }>,
) {
  h.hits = rows.map((r) => hit(r.id, r.title));
  h.events = rows.map(
    (r) =>
      ({
        id: r.id,
        secret: r.secret ?? false,
        revealSceneId: (r.reveal ?? null) as never,
      }) as EventRowStub,
  );
  h.sceneEvents = rows.flatMap((r) =>
    (r.ties ?? []).map((sceneId) => ({ eventId: r.id, sceneId })),
  );
}

function eventIdsOf(result: { content: unknown }): string[] {
  return contentOf(result).events.map((e) => e.eventId);
}

function sentCandidates(): string[] {
  return (h.invoke.mock.calls[0]![1] as { chronicleEventIds: string[] })
    .chronicleEventIds;
}

describe("E1: the candidates are the year table after the secrecy and position filters", () => {
  it("sends only what the model could see, never a hidden or later event's ID", async () => {
    setChronicle([
      { id: "a", ties: ["s1"] },
      // secret, revealed at s3: hidden at s2 (secrecy filter).
      { id: "hidden", secret: true, reveal: "s3", ties: ["s1"] },
      // tied to s3 only: dropped by the position filter.
      { id: "later", ties: ["s3"] },
      { id: "d" },
    ]);
    // A repeated hit is one candidate.
    h.hits = [hit("a"), hit("hidden"), hit("later"), hit("d"), hit("a")];
    await runSearch(makeIr().ir);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(sentCandidates()).toEqual(["a", "d"]);
  });

  it("sends an empty list when nothing is visible (Native is still asked)", async () => {
    setChronicle([{ id: "later", ties: ["s3"] }]);
    await runSearch(makeIr().ir);
    expect(sentCandidates()).toEqual([]);
  });

  it("does not send an ID the wire would refuse, nor more than 30, and still asks Native", async () => {
    const long = "x".repeat(201);
    const rows = [
      ...Array.from({ length: 31 }, (_, i) => ({ id: `e${i}`, ties: ["s1"] })),
      { id: long, ties: ["s1"] },
      { id: "   ", ties: ["s1"] },
    ];
    setChronicle(rows);
    h.hits = [
      hit(long),
      hit("   "),
      ...rows.slice(0, 31).map((r) => hit(r.id)),
    ];
    const { ir } = makeIr();
    const out = contentOf(await runSearch(ir, { query: "q", limit: 30 }));
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(ir.counter.calls).toBe(1);
    expect(sentCandidates()).toEqual(
      Array.from({ length: 30 }, (_, i) => `e${i}`),
    );
    expect(out.chronicleIr.status).toBe("available");
  });

  it("sends the pool before slice(limit): up to 30", async () => {
    setChronicle(
      Array.from({ length: 12 }, (_, i) => ({ id: `e${i}`, ties: ["s1"] })),
    );
    await runSearch(makeIr().ir, { query: "q", limit: 2 });
    // The year table over-fetches min(limit * 3, 30) = 6 hits.
    expect(h.semantic).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 6 }),
    );
    expect(sentCandidates()).toHaveLength(12);
  });
});

describe("E2: the exclusion is applied before slice(limit) and backfilled", () => {
  beforeEach(() => {
    setChronicle(["e1", "e2", "e3", "e4"].map((id) => ({ id, ties: ["s1"] })));
  });

  it("drops the excluded event and takes the next candidate in its place", async () => {
    h.invoke.mockResolvedValue(
      answer([], "none-above-threshold", { excludedEventIds: ["e1"] }),
    );
    const out = await runSearch(makeIr().ir, { query: "q", limit: 2 });
    // Slicing first and dropping after would leave ["e2"].
    expect(eventIdsOf(out)).toEqual(["e2", "e3"]);
  });

  it("applies the exclusion when the status is none-above-threshold too", async () => {
    h.invoke.mockResolvedValue(
      answer([], "none-above-threshold", { excludedEventIds: ["e2", "e3"] }),
    );
    expect(eventIdsOf(await runSearch(makeIr().ir))).toEqual(["e1", "e4"]);
  });

  it("does not apply the approximation when the exclusion arrived", async () => {
    setChronicle([
      { id: "span", secret: true, reveal: "s1", ties: ["s1", "s2"] },
      { id: "e2", ties: ["s1"] },
    ]);
    h.invoke.mockResolvedValue(
      answer([item(1)], "available", { excludedEventIds: [] }),
    );
    expect(eventIdsOf(await runSearch(makeIr().ir))).toEqual(["span", "e2"]);
  });
});

describe("E3〜E7: the merge", () => {
  beforeEach(() => {
    setChronicle(["e1", "e2", "e3"].map((id) => ({ id, ties: ["s1"] })));
  });

  it("E3: keeps the IR item and drops the year table's entry of the same event", async () => {
    const i1 = item(1);
    h.invoke.mockResolvedValue(
      answer([i1], "available", { eventIds: { "rev-1": "e1" } }),
    );
    const out = contentOf(await runSearch(makeIr().ir));
    expect(out.chronicleIr.items).toEqual([i1]);
    expect(out.events.map((e) => e.eventId)).toEqual(["e2", "e3"]);
    // The item is not rewritten (B-T4).
    expect(JSON.stringify(out)).toContain(JSON.stringify(i1));
  });

  it("E3: merges only an event that is in the year table", async () => {
    h.invoke.mockResolvedValue(
      answer([item(1)], "available", { eventIds: { "rev-1": "unrelated" } }),
    );
    const out = contentOf(await runSearch(makeIr().ir));
    expect(out.events.map((e) => e.eventId)).toEqual(["e1", "e2", "e3"]);
    expect(out.chronicleIr).not.toHaveProperty("eventIds");
  });

  it("E3: an item without an eventId is not merged", async () => {
    h.invoke.mockResolvedValue(answer([item(1)]));
    const out = contentOf(await runSearch(makeIr().ir));
    expect(out.events).toHaveLength(3);
    expect(out.chronicleIr).not.toHaveProperty("eventIds");
  });

  it("E4: an item the cap drops leaves its year-table entry in place", async () => {
    const items = [item(1, "a".repeat(10)), item(2, "b".repeat(300))];
    const eventIds = { "rev-1": "e1", "rev-2": "e2" };
    h.invoke.mockResolvedValue(answer(items, "available", { eventIds }));
    const table = (ids: string[]) =>
      ids.map((id) => ({
        eventId: id,
        title: `title ${id}`,
        kind: "event",
        score: 0.9,
      }));
    const measureOf = (n: number) =>
      JSON.stringify(
        buildChatIrContent(
          "available",
          items.slice(0, n),
          n === 2 ? table(["e3"]) : table(["e2", "e3"]),
          null,
          n === 2 ? eventIds : { "rev-1": "e1" },
        ),
      ).length;
    // The cap fits one item with its merge but not the second.
    const tokenCap = measureOf(1);
    expect(measureOf(2)).toBeGreaterThan(tokenCap);
    const { ir, noted } = makeIr({ tokenCap });
    const out = contentOf(await runSearch(ir));
    expect(out.chronicleIr.items.map((i) => i.revisionId)).toEqual(["rev-1"]);
    // e2 would be gone if the merge were decided before the cap.
    expect(out.events.map((e) => e.eventId)).toEqual(["e2", "e3"]);
    expect(out.chronicleIr.eventIds).toEqual({ "rev-1": "e1" });
    expect(noted[0]!.ids).toEqual(["rev-1"]);
    expect(noted[0]!.eventIds).toEqual(["e1"]);
  });

  it("E5: the tokens a merge frees let one more item in", async () => {
    setChronicle(
      ["e1", "e2", "e3"].map((id) => ({
        id,
        ties: ["s1"],
        title: "t".repeat(120),
      })),
    );
    const items = [item(1, "a".repeat(20)), item(2, "b".repeat(20))];
    const eventIds = { "rev-1": "e1", "rev-2": "e2" };
    h.invoke.mockResolvedValue(answer(items, "available", { eventIds }));
    const entry = (id: string) => ({
      eventId: id,
      title: "t".repeat(120),
      kind: "event",
      score: 0.9,
    });
    const merged = JSON.stringify(
      buildChatIrContent("available", items, [entry("e3")], null, eventIds),
    ).length;
    const unmerged = JSON.stringify(
      buildChatIrContent("available", items, [
        entry("e1"),
        entry("e2"),
        entry("e3"),
      ]),
    ).length;
    expect(merged).toBeLessThan(unmerged);
    const { ir } = makeIr({ tokenCap: merged });
    const out = contentOf(await runSearch(ir));
    expect(out.chronicleIr.items).toHaveLength(2);
    expect(out.events.map((e) => e.eventId)).toEqual(["e3"]);
  });

  it("E6: shows an eventId only for a merged item, never a hidden event's", async () => {
    setChronicle([
      { id: "e1", ties: ["s1"] },
      { id: "hidden", secret: true, reveal: "s3", ties: ["s1"] },
    ]);
    const items = [item(1), item(2)];
    h.invoke.mockResolvedValue(
      answer(items, "available", {
        eventIds: { "rev-1": "e1", "rev-2": "hidden" },
      }),
    );
    const { ir, noted } = makeIr();
    const out = contentOf(await runSearch(ir));
    expect(out.chronicleIr.items).toHaveLength(2);
    expect(out.chronicleIr.eventIds).toEqual({ "rev-1": "e1" });
    expect(noted[0]!.eventIds).toEqual(["e1"]);
    expect(JSON.stringify(out)).not.toContain("hidden");
    expect(Object.keys(out.chronicleIr)).toEqual([
      "status",
      "items",
      "eventIds",
    ]);
  });

  it("E6: shows no eventId for an event the exclusion took out of the year table", async () => {
    setChronicle([
      { id: "e1", ties: ["s1"] },
      { id: "e2", ties: ["s1"] },
    ]);
    // Native binds rev-1 to e1 and also excludes e1: e1 is not in the table
    // the model sees, so it is neither merged nor shown nor noted.
    h.invoke.mockResolvedValue(
      answer([item(1)], "available", {
        eventIds: { "rev-1": "e1" },
        excludedEventIds: ["e1"],
      }),
    );
    const { ir, noted } = makeIr();
    const out = await runSearch(ir);
    const content = contentOf(out);
    expect(eventIdsOf(out)).toEqual(["e2"]);
    expect(content.chronicleIr.items).toHaveLength(1);
    expect(content.chronicleIr.eventIds).toBeUndefined();
    expect(Object.keys(content.chronicleIr)).toEqual(["status", "items"]);
    expect(noted).toHaveLength(1);
    expect(noted[0]!.eventIds).toEqual([]);
  });

  it("E6: shows no eventId for an event beyond slice(limit), and merges nothing for it", async () => {
    setChronicle(["e1", "e2", "e3"].map((id) => ({ id, ties: ["s1"] })));
    // The year table keeps e1 and e2 (limit 2). rev-1 is bound to e3, which is
    // a visible candidate but outside the slice: it stays unmerged and hidden.
    // rev-2 is bound to e1, inside the slice (the control: merged and shown).
    h.invoke.mockResolvedValue(
      answer([item(1), item(2)], "available", {
        eventIds: { "rev-1": "e3", "rev-2": "e1" },
      }),
    );
    const { ir, noted } = makeIr();
    const out = await runSearch(ir, { query: "q", limit: 2 });
    const content = contentOf(out);
    expect(sentCandidates()).toEqual(["e1", "e2", "e3"]);
    expect(content.chronicleIr.eventIds).toEqual({ "rev-2": "e1" });
    expect(eventIdsOf(out)).toEqual(["e2"]);
    expect(JSON.stringify(content)).not.toContain("e3");
    expect(noted[0]!.eventIds).toEqual(["e1"]);
  });

  it("E6: without a merge the content is B2's (no eventIds key)", async () => {
    h.invoke.mockResolvedValue(answer([item(1)]));
    const out = contentOf(await runSearch(makeIr().ir));
    expect(Object.keys(out.chronicleIr)).toEqual(["status", "items"]);
  });

  it("E7: usedIds.eventIds is the set the model saw, once each", async () => {
    const items = [item(1), item(2), item(3)];
    h.invoke.mockResolvedValue(
      answer(items, "available", {
        // rev-3 is a second revision of the same event.
        eventIds: { "rev-1": "e1", "rev-2": "ghost", "rev-3": "e1" },
      }),
    );
    const { ir, noted } = makeIr();
    const result = await runSearch(ir);
    expect(noted).toHaveLength(1);
    expect(noted[0]!.ids).toEqual(["rev-1", "rev-2", "rev-3"]);
    // "ghost" is not in the year table (never shown), and e1 is given once.
    expect(noted[0]!.eventIds).toEqual(["e1"]);
    expect(contentOf(result).chronicleIr.eventIds).toEqual({
      "rev-1": "e1",
      "rev-3": "e1",
    });
    expect(result.summary).toBe("manuscript 3, chronicle 2");
  });

  it("E7: an item dropped by the cap leaves its event out of usedIds", async () => {
    const items = [item(1, "a".repeat(10)), item(2, "b".repeat(300))];
    h.invoke.mockResolvedValue(
      answer(items, "available", {
        eventIds: { "rev-1": "e1", "rev-2": "e2" },
      }),
    );
    const one = JSON.stringify(
      buildChatIrContent(
        "available",
        [items[0]!],
        ["e2", "e3"].map((id) => ({
          eventId: id,
          title: `title ${id}`,
          kind: "event",
          score: 0.9,
        })),
        null,
        { "rev-1": "e1" },
      ),
    ).length;
    const received: Array<readonly string[]> = [];
    const { ir } = makeIr({
      tokenCap: one,
      noteUsedIds: (_key, _ids, eventIds) => {
        received.push(eventIds);
      },
    });
    await runSearch(ir);
    expect(received).toEqual([["e1"]]);
  });
});

describe("E8: when the exclusion is not at hand", () => {
  // current Scene s2. After the secrecy filter (revealed at s1) and the
  // position filter, four stay; the approximation drops the two that are not
  // wholly before s2.
  beforeEach(() => {
    setChronicle([
      { id: "old", secret: true, reveal: "s1", ties: ["s1"] },
      { id: "span", secret: true, reveal: "s1", ties: ["s1", "s2"] },
      { id: "unknown", secret: true, reveal: "s1", ties: ["s1", "s-gone"] },
      { id: "pub", ties: ["s1", "s2"] },
      { id: "plain" },
    ]);
  });
  const ALL = ["old", "span", "unknown", "pub", "plain"];
  const APPROXIMATED = ["old", "pub", "plain"];

  it("the precheck's cap-exceeded does not call Native and approximates", async () => {
    setChronicle([
      {
        id: "old",
        secret: true,
        reveal: "s1",
        ties: ["s1"],
        title: "x".repeat(200),
      },
      {
        id: "span",
        secret: true,
        reveal: "s1",
        ties: ["s1", "s2"],
        title: "x".repeat(200),
      },
      { id: "pub", ties: ["s2"], title: "x".repeat(200) },
    ]);
    const { ir } = makeIr({ tokenCap: 100 });
    const out = await runSearch(ir);
    expect(contentOf(out).chronicleIr.status).toBe("cap-exceeded");
    expect(h.invoke).not.toHaveBeenCalled();
    expect(eventIdsOf(out)).toEqual(["old", "pub"]);
  });

  it("measures the precheck on the year table before the approximation (it only costs a call, never leaks)", async () => {
    setChronicle([
      { id: "old", secret: true, reveal: "s1", ties: ["s1"], title: "o" },
      {
        id: "span",
        secret: true,
        reveal: "s1",
        ties: ["s1", "s2"],
        title: "x".repeat(300),
      },
    ]);
    // With the approximation the table is only "old" and would leave room; the
    // precheck measures before it, so Native is not called.
    const out = await runSearch(makeIr({ tokenCap: 200 }).ir);
    expect(contentOf(out).chronicleIr.status).toBe("cap-exceeded");
    expect(h.invoke).not.toHaveBeenCalled();
    expect(eventIdsOf(out)).toEqual(["old"]);
  });

  it("a turn-limit reached before the call does not call Native and approximates", async () => {
    const { ir } = makeIr({
      counter: { chars: 0, calls: CHAT_IR_MAX_CALLS_PER_TURN },
    });
    const out = await runSearch(ir);
    expect(contentOf(out).chronicleIr.status).toBe("turn-limit");
    expect(h.invoke).not.toHaveBeenCalled();
    expect(eventIdsOf(out)).toEqual(APPROXIMATED);
    const spent = makeIr({
      counter: { chars: CHAT_IR_MAX_CHARS_PER_TURN, calls: 0 },
    }).ir;
    expect(eventIdsOf(await runSearch(spent))).toEqual(APPROXIMATED);
  });

  it("a query the renderer refuses (over 500) does not call Native and approximates", async () => {
    const out = await runSearch(makeIr().ir, { query: "あ".repeat(501) });
    expect(contentOf(out).chronicleIr.status).toBe("query-invalid");
    expect(h.invoke).not.toHaveBeenCalled();
    expect(eventIdsOf(out)).toEqual(APPROXIMATED);
  });

  it("a query-invalid that Native returns, with no exclusion, approximates", async () => {
    h.invoke.mockResolvedValue(answer([], "query-invalid"));
    const out = await runSearch(makeIr().ir);
    expect(contentOf(out).chronicleIr.status).toBe("query-invalid");
    expect(eventIdsOf(out)).toEqual(APPROXIMATED);
  });

  it("a ledger-full that Native returns, with no exclusion, approximates (T20: the model can fill the ledger)", async () => {
    h.invoke.mockResolvedValue(answer([], "ledger-full"));
    const { ir } = makeIr();
    const out = await runSearch(ir);
    expect(contentOf(out).chronicleIr.status).toBe("ledger-full");
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(eventIdsOf(out)).toEqual(APPROXIMATED);
  });

  it("a ledger-full backfills after the approximation (before slice(limit))", async () => {
    h.invoke.mockResolvedValue(answer([], "ledger-full"));
    const out = await runSearch(makeIr().ir, { query: "q", limit: 2 });
    expect(eventIdsOf(out)).toEqual(["old", "pub"]);
  });

  it("backfills after the approximation (it is applied before slice(limit))", async () => {
    const out = await runSearch(
      makeIr({ counter: { chars: 0, calls: CHAT_IR_MAX_CALLS_PER_TURN } }).ir,
      { query: "q", limit: 2 },
    );
    expect(eventIdsOf(out)).toEqual(["old", "pub"]);
  });

  it("a turn-limit after Native answered applies the real exclusion, not the approximation", async () => {
    h.invoke.mockResolvedValue(
      answer([item(1)], "available", { excludedEventIds: ["old"] }),
    );
    const used = CHAT_IR_MAX_CHARS_PER_TURN - 1;
    const out = await runSearch(
      makeIr({ counter: { chars: used, calls: 0 } }).ir,
    );
    expect(contentOf(out).chronicleIr.status).toBe("turn-limit");
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(eventIdsOf(out)).toEqual(["span", "unknown", "pub", "plain"]);
  });

  it("a cap-exceeded after Native answered applies the real exclusion", async () => {
    h.invoke.mockResolvedValue(
      answer([item(1, "z".repeat(500))], "available", {
        excludedEventIds: ["plain"],
      }),
    );
    const entries = (ids: string[]) =>
      ids.map((id) => ({
        eventId: id,
        title: `title ${id}`,
        kind: "event",
        score: 0.9,
      }));
    // The precheck (5 events, before the exclusion) lets Native be called;
    // the 500-character item then does not fit.
    const bare = JSON.stringify(
      buildChatIrContent("cap-exceeded", [], entries(ALL)),
    ).length;
    const out = await runSearch(makeIr({ tokenCap: bare + 20 }).ir);
    expect(contentOf(out).chronicleIr.status).toBe("cap-exceeded");
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(eventIdsOf(out)).toEqual(["old", "span", "unknown", "pub"]);
  });

  it.each(
    CHAT_AGENT_IR_STATUSES.filter(
      (status) =>
        ![
          "available",
          "none-above-threshold",
          "query-invalid",
          "ledger-full",
        ].includes(status),
    ),
  )(
    "a failure (%s) applies neither (4) nor the approximation",
    async (status) => {
      h.invoke.mockResolvedValue(answer([], status));
      const out = await runSearch(makeIr().ir);
      expect(contentOf(out).chronicleIr.status).toBe(status);
      expect(eventIdsOf(out)).toEqual(ALL);
    },
  );

  it.each([
    ["an IPC error", () => Promise.reject(new Error("boom"))],
    ["a malformed answer", () => Promise.resolve({ nonsense: true })],
    [
      "an exclusion that was not sent",
      () =>
        Promise.resolve(
          answer([], "available", { excludedEventIds: ["not-a-candidate"] }),
        ),
    ],
  ])("%s applies neither (4) nor the approximation", async (_name, impl) => {
    h.invoke.mockImplementation(impl);
    expect(eventIdsOf(await runSearch(makeIr().ir))).toEqual(ALL);
  });

  it("the renderer's own refusals other than query-invalid apply neither", async () => {
    // No current Scene: the secrecy filter has already hidden every secret
    // event, and nothing more is taken away.
    expect(
      eventIdsOf(
        await runSearch(makeIr().ir, undefined, {
          projectId: "p-turn",
          currentSceneId: null,
        }),
      ),
    ).toEqual(["pub", "plain"]);
    expect(
      eventIdsOf(await runSearch(makeIr({ workspacePath: null }).ir)),
    ).toEqual(ALL);
  });

  it("an approximation never touches an event that is not secret", async () => {
    setChronicle([
      { id: "pub-span", ties: ["s1", "s2"] },
      { id: "pub-now", ties: ["s2"] },
    ]);
    const out = await runSearch(
      makeIr({ counter: { chars: 0, calls: CHAT_IR_MAX_CALLS_PER_TURN } }).ir,
    );
    expect(eventIdsOf(out)).toEqual(["pub-span", "pub-now"]);
  });

  it("the approximation is applied only by search_events (no other tool imports it)", () => {
    const dir = join(process.cwd(), "src");
    const users: string[] = [];
    const walk = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          /\.(ts|tsx)$/.test(entry.name) &&
          !/\.test\./.test(entry.name)
        ) {
          if (
            readFileSync(full, "utf8").includes(
              "passesIrExclusionApproximation",
            )
          ) {
            users.push(full.slice(dir.length + 1));
          }
        }
      }
    };
    walk(dir);
    expect(users.sort()).toEqual([
      "features/chat/agent/toolExecutors.ts",
      "features/chronicle/chronicleReadingPosition.ts",
    ]);
  });
});

describe("E9: the sub-agent's search_events", () => {
  beforeEach(() => {
    setChronicle([
      { id: "old", secret: true, reveal: "s1", ties: ["s1"] },
      { id: "span", secret: true, reveal: "s1", ties: ["s1", "s2"] },
      { id: "unknown", secret: true, reveal: "s1", ties: ["s1", "s-gone"] },
      { id: "pub", ties: ["s1", "s2"] },
      { id: "plain" },
    ]);
  });
  const sub = (params: Record<string, unknown>, scope = SCOPE) =>
    executeReadOnlyTool("search_events", "t1", params, { scope });

  it("approximates every time and never calls Native", async () => {
    const out = (await sub({ query: "q" })).content as Array<{
      eventId: string;
    }>;
    expect(out.map((e) => e.eventId)).toEqual(["old", "pub", "plain"]);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("applies before slice(limit) and backfills", async () => {
    const out = (await sub({ query: "q", limit: 2 })).content as Array<{
      eventId: string;
    }>;
    expect(out.map((e) => e.eventId)).toEqual(["old", "pub"]);
  });

  it("does not approximate without a turn scope", async () => {
    // The store's Scene is s2 too, so the secrecy and position filters keep
    // "span" (tied to s1 and s2): only the approximation could drop it, and it
    // must not run without a scope.
    h.tree.activeSceneId = "s2";
    const out = (
      await executeReadOnlyTool("search_events", "t1", {
        query: "q",
      })
    ).content as Array<{ eventId: string }>;
    expect(out.map((e) => e.eventId)).toEqual([
      "old",
      "span",
      "unknown",
      "pub",
      "plain",
    ]);
  });

  it("without a turn scope the store's Scene decides (s0 hides the secret ones)", async () => {
    const out = (
      await executeReadOnlyTool("search_events", "t1", {
        query: "q",
      })
    ).content as Array<{ eventId: string }>;
    // Without a scope the store's Scene (s0) decides: the secrecy filter hides
    // the secret ones and the position filter drops "pub" (tied to s1, s2).
    expect(out.map((e) => e.eventId)).toEqual(["plain"]);
  });

  it("does not approximate while the constant is false", async () => {
    h.gate.enabled = false;
    const out = (await sub({ query: "q" })).content as Array<{
      eventId: string;
    }>;
    expect(out.map((e) => e.eventId)).toEqual([
      "old",
      "span",
      "unknown",
      "pub",
      "plain",
    ]);
  });
});

describe("E10: the constant false is today's result, byte for byte", () => {
  const GOLDEN_CONTENT = [
    { eventId: "old", title: "title old", kind: "event", score: 0.9 },
    { eventId: "span", title: "title span", kind: "event", score: 0.9 },
    { eventId: "later", title: "title later", kind: "event", score: 0.9 },
    { eventId: "plain", title: "title plain", kind: "event", score: 0.9 },
  ];
  const GOLDEN_JSON = JSON.stringify({
    name: "search_events",
    content: GOLDEN_CONTENT,
    summary: "4 events found",
    tokensUsed: JSON.stringify(GOLDEN_CONTENT).length,
  });

  beforeEach(() => {
    h.gate.enabled = false;
    // "later" is after the current Scene and "span" spans it: with the
    // constant true both would be dropped; with it false neither is.
    setChronicle([
      { id: "old", secret: true, reveal: "s1", ties: ["s1"] },
      { id: "span", secret: true, reveal: "s1", ties: ["s1", "s2"] },
      { id: "later", ties: ["s3"] },
      { id: "plain" },
    ]);
  });

  it("every caller returns the golden result and calls neither Native nor the wrapper", async () => {
    const { ir } = makeIr();
    const main = await runSearch(ir);
    const sub = await executeReadOnlyTool(
      "search_events",
      "t1",
      { query: "the secret door" },
      { scope: SCOPE },
    );
    for (const result of [main, sub]) {
      expect(JSON.stringify({ ...result, toolCallId: undefined })).toBe(
        GOLDEN_JSON,
      );
    }
    expect(h.invoke).not.toHaveBeenCalled();
    expect(ir.counter).toEqual({ chars: 0, calls: 0 });
    expect(h.semantic).toHaveBeenCalledWith({
      projectId: "p-turn",
      query: "the secret door",
      limit: 30,
    });
  });

  it("the product's false path (no scope, no capability) reads the store and returns the golden result", async () => {
    // The caller without a scope judges by the store's Scene (s2 here).
    h.tree.activeSceneId = "s2";
    const results = [
      await executeTool("search_events", "t1", { query: "the secret door" }),
      await executeReadOnlyTool("search_events", "t1", {
        query: "the secret door",
      }),
    ];
    for (const result of results) {
      expect(JSON.stringify({ ...result, toolCallId: undefined })).toBe(
        GOLDEN_JSON,
      );
    }
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.semantic).toHaveBeenCalledWith({
      projectId: "p-store",
      query: "the secret door",
      limit: 30,
    });
  });
});
