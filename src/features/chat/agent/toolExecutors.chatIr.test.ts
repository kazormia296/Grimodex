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

function answer(items: ChatAgentIrItem[], status = "available") {
  return {
    status,
    success: status === "available" || status === "none-above-threshold",
    items,
  };
}

function hit(eventId: string, title = `title ${eventId}`) {
  return { eventId, title, kind: "event", score: 0.9 };
}

const SCOPE: ChatTurnToolScope = { projectId: "p-turn", currentSceneId: "s2" };

function makeIr(over: Partial<ChatIrCapability> = {}) {
  const noted: Array<{ key: object; ids: readonly string[] }> = [];
  const ir: ChatIrCapability = {
    workspacePath: "/w",
    tokenCap: 100_000,
    counter: { chars: 0, calls: 0 },
    assertCurrent: () => {},
    noteUsedIds: (key, ids) => {
      noted.push({ key, ids });
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
