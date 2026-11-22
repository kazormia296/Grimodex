import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MP-4b PR-7b：search_events の renderer の薄い層（`chronicleSearchPort.ts`）と、`toolExecutors.ts` の
 * 先頭の分岐の試験（DR-MP4-38）。
 *
 * - project が無いときの core の throw は `No active project`（content `[]`）に戻る。
 * - dense の握り（失敗→warn して空）はこの層の `denseEventHitsOrEmpty` が唯一の置き場で、
 *   scope あり・IR 経路の `chronicleCandidates` も同じ関数を使う。
 * - 旗×scope の 4 象限と null の scope が **どの経路を通ったか**を、core の executor への spy で固定する
 *   （両経路の結果は等しいので、結果の byte 一致だけでは経路の取り違えが見えない）。旗は呼出しごとに
 *   評価する（同じ executor で旗を切り替える）。
 * 旗は `toolExecutors.chatIr.test.ts` と同じく getter で差し替える（製品の定数は false のまま）。
 */
const h = vi.hoisted(() => ({
  gate: { enabled: false },
  tree: {
    projectId: "p-store" as string | null,
    nodes: [] as unknown[],
    activeSceneId: "s2" as string | undefined,
  },
  hits: [] as unknown[],
  events: [] as Array<{
    id: string;
    secret: boolean;
    revealSceneId: string | null;
  }>,
  semantic: vi.fn(),
  coreCalls: [] as Array<Record<string, unknown>>,
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
  invoke: vi.fn(),
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
  eventsSemanticSearch: (args: unknown) => h.semantic(args),
  codexSemanticSearch: vi.fn(async () => []),
}));
vi.mock("./chronicleToolCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chronicleToolCache")>()),
  getSharedEvents: async () => h.events,
  getSharedSceneEvents: async () => [],
  getSharedReadingOrder: () =>
    new Map([
      ["s0", 0],
      ["s1", 1],
      ["s2", 2],
    ]),
  invalidateChronicleToolCache: () => {},
}));
vi.mock("../contextBuilder", () => ({
  ensureTokenizer: vi.fn(async () => {}),
  countTokens: (s: string) => (s ? s.length : 0),
}));
// 経路の spy：core の executor を包む（実物へ委譲する）。
vi.mock(
  "@/../electron/shared/readDomain/core/chronicleReadExecutors",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/../electron/shared/readDomain/core/chronicleReadExecutors")
      >();
    return {
      ...actual,
      createChronicleSearchExecutors: (
        ctx: Parameters<typeof actual.createChronicleSearchExecutors>[0],
      ) => {
        const real = actual.createChronicleSearchExecutors(ctx);
        return Object.freeze({
          search_events: (params: Record<string, unknown>) => {
            h.coreCalls.push(params);
            return real.search_events(params);
          },
        });
      },
    };
  },
);
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

import { debugLog, errorDetail } from "@/lib/debugLog";
import type { ChatTurnToolScope } from "./chatTurnToolScope";
import {
  CHRONICLE_SEARCH_NO_PROJECT_CONTENT,
  CHRONICLE_SEARCH_TOOL_NAMES,
  chronicleSearchExecutor,
  denseEventHitsOrEmpty,
} from "./chronicleSearchPort";
import { executeReadOnlyTool, executeTool } from "./toolExecutors";

const SCOPE: ChatTurnToolScope = { projectId: "p-turn", currentSceneId: "s2" };
const hit = (eventId: string) => ({
  eventId,
  title: `title ${eventId}`,
  kind: "generic",
  score: 0.9,
});
const idsOf = (result: { content: unknown }) =>
  (result.content as Array<{ eventId: string }>).map((e) => e.eventId);

beforeEach(() => {
  h.gate.enabled = false;
  h.tree.projectId = "p-store";
  h.tree.activeSceneId = "s2";
  h.hits = [hit("a"), hit("b")];
  h.events = [
    { id: "a", secret: false, revealSceneId: null },
    { id: "b", secret: false, revealSceneId: null },
  ];
  h.coreCalls.length = 0;
  h.semantic.mockReset();
  h.semantic.mockImplementation(async () => h.hits);
});

describe("project が無いとき（core の throw を従来の結果に戻す）", () => {
  it("CHRONICLE_SEARCH_NO_PROJECT_CONTENT は毎回新しい空配列を返す", () => {
    expect(CHRONICLE_SEARCH_TOOL_NAMES).toEqual(["search_events"]);
    const a = CHRONICLE_SEARCH_NO_PROJECT_CONTENT.search_events();
    const b = CHRONICLE_SEARCH_NO_PROJECT_CONTENT.search_events();
    expect(a).toEqual([]);
    expect(a).not.toBe(b);
  });

  it.each([[""], [null], ["   "]])(
    "store の project が %j なら No active project・content []・tokensUsed 0 で、dense を呼ばない",
    async (projectId) => {
      h.tree.projectId = projectId;
      const result = await chronicleSearchExecutor({ query: "q" });
      expect(result).toEqual({
        name: "search_events",
        content: [],
        summary: "No active project",
        tokensUsed: 0,
      });
      expect(h.semantic).not.toHaveBeenCalled();
    },
  );

  it("空の query は project の検査より先（project が無くても 0 events found）", async () => {
    h.tree.projectId = "";
    const result = await chronicleSearchExecutor({ query: "" });
    expect(result.summary).toBe("0 events found");
    expect(result.content).toEqual([]);
  });

  it("project 以外の失敗は握らずそのまま投げる（narrow の失敗）", async () => {
    h.semantic.mockImplementation(async () => "not an array");
    await expect(chronicleSearchExecutor({ query: "q" })).rejects.toThrow(
      /events_semantic_search/,
    );
  });
});

describe("denseEventHitsOrEmpty（握りの唯一の置き場）", () => {
  it("成功ならそのまま返し、引数も同じ object の key だけで渡す（余計な key を足さない）", async () => {
    const warn = vi.spyOn(debugLog, "warn").mockImplementation(() => {});
    try {
      const args = { projectId: "p1", query: "q", limit: 7 };
      const hits = await denseEventHitsOrEmpty(args);
      expect(hits).toBe(h.hits);
      expect(h.semantic).toHaveBeenCalledWith({
        projectId: "p1",
        query: "q",
        limit: 7,
      });
      expect(Object.keys(h.semantic.mock.calls[0]![0] as object)).toEqual([
        "projectId",
        "query",
        "limit",
      ]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ["Error", () => new Error("model is not installed")],
    ["文字列", () => "unavailable"],
  ])(
    "%s で reject したら debugLog.warn（タグ・本文・errorDetail）を 1 回呼んで [] を返す",
    async (_label, make) => {
      const failure = make();
      const warn = vi.spyOn(debugLog, "warn").mockImplementation(() => {});
      try {
        h.semantic.mockRejectedValue(failure);
        await expect(
          denseEventHitsOrEmpty({ projectId: "p1", query: "q", limit: 3 }),
        ).resolves.toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          "search_events",
          "dense events search failed (empty fallback)",
          errorDetail(failure),
        );
      } finally {
        warn.mockRestore();
      }
    },
  );

  it("core を通る呼出しでも、dense の失敗は 0 events found に退避する（renderer の結果は変わらない）", async () => {
    const warn = vi.spyOn(debugLog, "warn").mockImplementation(() => {});
    try {
      h.semantic.mockRejectedValue(new Error("dense unavailable"));
      const result = await chronicleSearchExecutor({ query: "q" });
      expect(result.content).toEqual([]);
      expect(result.summary).toBe("0 events found");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("scope あり・旗 true の経路（chronicleCandidates）も同じ関数で握る（同じ message・同じ結果）", async () => {
    const warn = vi.spyOn(debugLog, "warn").mockImplementation(() => {});
    try {
      h.gate.enabled = true;
      h.semantic.mockRejectedValue(new Error("dense unavailable"));
      const result = await executeReadOnlyTool(
        "search_events",
        "t1",
        { query: "q" },
        { scope: SCOPE },
      );
      expect(result.content).toEqual([]);
      expect(result.summary).toBe("0 events found");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![1]).toBe(
        "dense events search failed (empty fallback)",
      );
      expect(h.coreCalls).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("toolExecutors.ts に握りの message は無い（置き場は chronicleSearchPort.ts の 1 か所）", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = (name: string) => readFileSync(resolve(here, name), "utf8");
    expect(source("toolExecutors.ts")).not.toContain(
      "dense events search failed",
    );
    expect(source("chronicleSearchPort.ts")).toContain(
      "dense events search failed (empty fallback)",
    );
  });
});

describe("旗×scope の 4 象限（どちらの経路を通ったか）", () => {
  const run = (
    scope: ChatTurnToolScope | null | undefined,
    entry: "main" | "read-only" = "main",
  ) =>
    entry === "main"
      ? executeTool(
          "search_events",
          "t1",
          { query: "q" },
          undefined,
          scope === undefined ? undefined : ({ scope } as never),
        )
      : executeReadOnlyTool(
          "search_events",
          "t1",
          { query: "q" },
          scope === undefined ? undefined : ({ scope } as never),
        );

  it("旗 false・scope なし：core を通る（store の project・場面で動く）。2 つの入口（executeTool・executeReadOnlyTool）とも", async () => {
    for (const entry of ["main", "read-only"] as const) {
      h.coreCalls.length = 0;
      h.semantic.mockClear();
      const result = await run(undefined, entry);
      expect(h.coreCalls, entry).toHaveLength(1);
      expect(idsOf(result), entry).toEqual(["a", "b"]);
      expect(h.semantic, entry).toHaveBeenCalledWith({
        projectId: "p-store",
        query: "q",
        limit: 30,
      });
    }
  });

  it("旗 false・scope あり：core を通らない（scope の project で動く）", async () => {
    const result = await run(SCOPE);
    expect(h.coreCalls).toHaveLength(0);
    expect(idsOf(result)).toEqual(["a", "b"]);
    expect(h.semantic).toHaveBeenCalledWith({
      projectId: "p-turn",
      query: "q",
      limit: 30,
    });
  });

  it("旗 true・scope なし：core を通らない（位置の filter がある経路）", async () => {
    h.gate.enabled = true;
    const result = await run(undefined);
    expect(h.coreCalls).toHaveLength(0);
    expect(result.error).toBeUndefined();
    expect(h.semantic).toHaveBeenCalledWith({
      projectId: "p-store",
      query: "q",
      limit: 30,
    });
  });

  it("旗 true・scope あり：core を通らない", async () => {
    h.gate.enabled = true;
    await run(SCOPE);
    expect(h.coreCalls).toHaveLength(0);
    expect(h.semantic).toHaveBeenCalledWith({
      projectId: "p-turn",
      query: "q",
      limit: 30,
    });
  });

  it("scope が null（型は許さないが truthiness は project・場面の読みと同じ）なら scope なしと同じ：core を通る", async () => {
    await run(null);
    expect(h.coreCalls).toHaveLength(1);
    expect(h.semantic).toHaveBeenCalledWith({
      projectId: "p-store",
      query: "q",
      limit: 30,
    });
  });

  it("旗は呼出しごとに評価する：同じ executor で false → true → false と切り替えると、core・非 core・core の順に通る", async () => {
    const entry = executeReadOnlyTool;
    const call = () => entry("search_events", "t1", { query: "q" });
    await call();
    expect(h.coreCalls).toHaveLength(1);
    h.gate.enabled = true;
    await call();
    expect(h.coreCalls).toHaveLength(1);
    h.gate.enabled = false;
    await call();
    expect(h.coreCalls).toHaveLength(2);
  });
});
