import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MP-4b PR-7b：search_events の IR なしの部分（旗が false のとき）の、PR-0 の golden が覆わない legacy の
 * 挙動の特性試験。**共有 core へ移す前に未変更の legacy で通し、移した後も無変更で通る**ことが
 * 「結果を 1 byte も変えない」の証拠になる（DR-MP4-38）。
 *
 * 固定するもの：
 * - store の読取り位置：project は query の検査の直後に 1 回（dense の最中に変わっても最初の値）、
 *   nodes と activeSceneId は dense・events・sceneEvents の await の後に同じ同期区間で読む。
 * - scope があるとき（旗が false でも試験は作る）は、project・場面とも scope の値で、store の移動を見ない。
 * - hit の扱い：DB に無い id・重複 id は素通し、順序の保持、hidden を先に落としてから slice、位置 filter は無い。
 * - limit の表（dense に渡る fetchLimit を含む。0 < x < 1 でも dense は呼ぶ）、query の検査（空は何も読まない）。
 * - dense の失敗は warn して `[]`（握りの後も events・sceneEvents は読む）。
 * - 結果の形（key 順・tokensUsed）と、score が null の hit（f32 の NaN の写し）。
 *
 * 固定しないもの（移す前後で値が変わる）：`getState` の呼出し回数（空 query の 0 回だけ固定する）、
 * 空白だけの projectId（legacy は読み進め、core は No active project。DR-MP4-38d）、壊れた wire。
 * mock は `toolExecutors.chatIr.test.ts` の最小部分。旗は定数のまま false（getter で固定）。
 */
const h = vi.hoisted(() => ({
  tree: {
    projectId: "p1" as string | null | undefined,
    nodes: [] as unknown[],
    activeSceneId: "s0" as string | undefined,
  },
  hits: [] as unknown[],
  events: [] as Array<{
    id: string;
    secret: boolean;
    revealSceneId: string | null;
  }>,
  sceneEvents: [] as Array<{ eventId: string; sceneId: string }>,
  readingOrder: new Map<string, number>(),
  log: [] as string[],
  getState: vi.fn(),
  semantic: vi.fn(),
  getEvents: vi.fn(),
  getSceneEvents: vi.fn(),
  getReadingOrder: vi.fn(),
  countTokens: vi.fn(),
}));

vi.mock("./chatAgentIrAvailability", () => ({
  get CHAT_AGENT_IR_ENABLED() {
    return false;
  },
}));
vi.mock("@/features/chat/agent/chatAgentIrAvailability", () => ({
  get CHAT_AGENT_IR_ENABLED() {
    return false;
  },
}));
vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
  isD2aEgressDenied: () => false,
  isIpcLifecycleCancellation: () => false,
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: () => h.getState() },
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
  getSharedEvents: (projectId: string) => h.getEvents(projectId),
  getSharedSceneEvents: (projectId: string) => h.getSceneEvents(projectId),
  getSharedReadingOrder: (nodes: unknown) => h.getReadingOrder(nodes),
  invalidateChronicleToolCache: () => {},
}));
vi.mock("../contextBuilder", () => ({
  ensureTokenizer: vi.fn(async () => {}),
  countTokens: (s: string) => h.countTokens(s),
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

import { debugLog, errorDetail } from "@/lib/debugLog";
import type { ChatTurnToolScope } from "./chatTurnToolScope";
import { executeTool } from "./toolExecutors";

// 読む順：s0 < s1 < s2 < s3。
const ORDER = new Map([
  ["s0", 0],
  ["s1", 1],
  ["s2", 2],
  ["s3", 3],
]);
const NODES_A = [{ id: "nodes-a" }];
const NODES_B = [{ id: "nodes-b" }];

const hit = (eventId: string, score: number | null = 0.9) => ({
  eventId,
  title: `title ${eventId}`,
  kind: "generic",
  score,
});
const row = (
  id: string,
  secret = false,
  revealSceneId: string | null = null,
) => ({
  id,
  secret,
  revealSceneId,
});

const search = (
  params: Record<string, unknown>,
  context?: { scope?: ChatTurnToolScope },
) => executeTool("search_events", "t1", params, undefined, context);

const idsOf = (result: { content: unknown }): string[] =>
  (result.content as Array<{ eventId: string }>).map((e) => e.eventId);

beforeEach(() => {
  h.tree.projectId = "p1";
  h.tree.nodes = NODES_A;
  h.tree.activeSceneId = "s0";
  // secret の "sec" は s2 で公開、"pub" は公開済み。
  h.events = [row("pub"), row("sec", true, "s2")];
  h.sceneEvents = [];
  h.readingOrder = ORDER;
  h.hits = [hit("sec"), hit("pub")];
  h.log = [];
  h.getState.mockReset();
  // zustand の getState と同じく、呼ぶたびにその時点の snapshot を返す（同じ object を返すと、
  // 「いつ読んだか」が値に現れない）。
  h.getState.mockImplementation(() => ({ ...h.tree }));
  h.semantic.mockReset();
  h.semantic.mockImplementation(async () => {
    h.log.push("dense");
    return h.hits;
  });
  h.getEvents.mockReset();
  h.getEvents.mockImplementation(async () => {
    h.log.push("events");
    return h.events;
  });
  h.getSceneEvents.mockReset();
  h.getSceneEvents.mockImplementation(async () => {
    h.log.push("sceneEvents");
    return h.sceneEvents;
  });
  h.getReadingOrder.mockReset();
  h.getReadingOrder.mockImplementation(() => h.readingOrder);
  h.countTokens.mockReset();
  h.countTokens.mockImplementation((s: string) => (s ? s.length : 0));
});

describe("store の読取り位置（旗 false・scope なし）", () => {
  it("project は query の検査の直後に 1 回だけ読む：dense の最中に project が変わっても、dense・events・sceneEvents は最初の project で呼ばれる", async () => {
    h.semantic.mockImplementation(async () => {
      h.tree.projectId = "p2";
      return h.hits;
    });
    const result = await search({ query: "q" });
    expect(result.error).toBeUndefined();
    expect(h.semantic).toHaveBeenCalledTimes(1);
    expect(h.semantic).toHaveBeenCalledWith({
      projectId: "p1",
      query: "q",
      limit: 30,
    });
    expect(h.getEvents).toHaveBeenCalledWith("p1");
    expect(h.getSceneEvents).toHaveBeenCalledWith("p1");
  });

  it("nodes と activeSceneId は dense の await の後で読む（dense の最中に s2・別の nodes へ切り替えると、sec が見え、読む順は後の nodes で作る）", async () => {
    h.semantic.mockImplementation(async () => {
      h.tree.activeSceneId = "s2";
      h.tree.nodes = NODES_B;
      return h.hits;
    });
    const result = await search({ query: "q" });
    expect(idsOf(result)).toEqual(["sec", "pub"]);
    expect(h.getReadingOrder).toHaveBeenCalledTimes(1);
    expect(h.getReadingOrder.mock.calls[0]![0]).toBe(NODES_B);
  });

  it("nodes と activeSceneId は events の await の後で読む（events の最中の切替が反映される）", async () => {
    h.getEvents.mockImplementation(async () => {
      h.log.push("events");
      h.tree.activeSceneId = "s2";
      h.tree.nodes = NODES_B;
      return h.events;
    });
    const result = await search({ query: "q" });
    expect(idsOf(result)).toEqual(["sec", "pub"]);
    expect(h.getReadingOrder.mock.calls[0]![0]).toBe(NODES_B);
  });

  it("nodes と activeSceneId は sceneEvents の await の後で読む（sceneEvents の最中の切替が反映される）", async () => {
    h.getSceneEvents.mockImplementation(async () => {
      h.log.push("sceneEvents");
      h.tree.activeSceneId = "s2";
      h.tree.nodes = NODES_B;
      return h.sceneEvents;
    });
    const result = await search({ query: "q" });
    expect(idsOf(result)).toEqual(["sec", "pub"]);
    expect(h.getReadingOrder.mock.calls[0]![0]).toBe(NODES_B);
  });

  it("nodes と activeSceneId は同じ同期区間で読む（読む順を作る間に microtask を挟んで切り替えても、判定は読んだ値のまま）", async () => {
    h.getReadingOrder.mockImplementation(() => {
      void Promise.resolve().then(() => {
        h.tree.activeSceneId = "s2";
      });
      return h.readingOrder;
    });
    const result = await search({ query: "q" });
    // 読んだ時点の s0：sec は hidden。
    expect(idsOf(result)).toEqual(["pub"]);
  });

  it("呼び順は dense → events → sceneEvents（握りの後も同じ）", async () => {
    await search({ query: "q" });
    expect(h.log).toEqual(["dense", "events", "sceneEvents"]);
  });

  it("project が falsy（空文字・null・undefined）なら No active project（dense も読まない）", async () => {
    for (const projectId of ["", null, undefined]) {
      h.tree.projectId = projectId;
      h.semantic.mockClear();
      h.getEvents.mockClear();
      const result = await search({ query: "q" });
      expect(result.summary, String(projectId)).toBe("No active project");
      expect(result.content, String(projectId)).toEqual([]);
      expect(result.tokensUsed, String(projectId)).toBe(0);
      expect(h.semantic, String(projectId)).not.toHaveBeenCalled();
      expect(h.getEvents, String(projectId)).not.toHaveBeenCalled();
    }
  });
});

describe("scope があるとき（旗が false でも試験は作る。今までどおり scope の値で動く）", () => {
  const SCOPE: ChatTurnToolScope = {
    projectId: "p-turn",
    currentSceneId: "s2",
  };

  it("dense・events・sceneEvents は scope の projectId で呼ばれ、判定は scope の場面（store が動いても）", async () => {
    h.tree.projectId = "p-store";
    h.tree.activeSceneId = "s0";
    h.semantic.mockImplementation(async () => {
      h.tree.projectId = "p-moved";
      h.tree.activeSceneId = "s0";
      return h.hits;
    });
    const result = await search({ query: "q" }, { scope: SCOPE });
    // s2 では sec が公開される（store の s0 なら隠れる）。
    expect(idsOf(result)).toEqual(["sec", "pub"]);
    expect(h.semantic).toHaveBeenCalledWith({
      projectId: "p-turn",
      query: "q",
      limit: 30,
    });
    expect(h.getEvents).toHaveBeenCalledWith("p-turn");
    expect(h.getSceneEvents).toHaveBeenCalledWith("p-turn");
  });

  it("scope.projectId が空なら No active project（store に project があっても）", async () => {
    const result = await search(
      { query: "q" },
      { scope: { projectId: "", currentSceneId: "s2" } },
    );
    expect(result.summary).toBe("No active project");
    expect(result.content).toEqual([]);
    expect(h.semantic).not.toHaveBeenCalled();
  });

  it("scope.currentSceneId が null なら場面なし（secret を隠す側。store が s3 でも）", async () => {
    h.tree.activeSceneId = "s3";
    const result = await search(
      { query: "q" },
      { scope: { projectId: "p-turn", currentSceneId: null } },
    );
    expect(idsOf(result)).toEqual(["pub"]);
  });

  it("scope があっても、読む順の nodes は dense の後の store から読む", async () => {
    h.semantic.mockImplementation(async () => {
      h.tree.nodes = NODES_B;
      return h.hits;
    });
    await search({ query: "q" }, { scope: SCOPE });
    expect(h.getReadingOrder.mock.calls[0]![0]).toBe(NODES_B);
  });
});

describe("hit の扱い", () => {
  it("DB に無い id（他 project の id）と重複 id は素通しで、順序は dense の返した順のまま", async () => {
    h.hits = [hit("pub"), hit("x-unknown"), hit("sec"), hit("pub"), hit("x-2")];
    const result = await search({ query: "q" });
    expect(idsOf(result)).toEqual(["pub", "x-unknown", "pub", "x-2"]);
    expect(result.summary).toBe("4 events found");
  });

  it("hidden を先に落としてから slice する（先頭が hidden でも limit を食わない）", async () => {
    h.events = [row("s1", true), row("s2", true), row("p1"), row("p2")];
    h.hits = [hit("s1"), hit("s2"), hit("p1"), hit("p2")];
    const result = await search({ query: "q", limit: 2 });
    expect(idsOf(result)).toEqual(["p1", "p2"]);
  });

  it("位置の filter は無い（旗 false。公開済みの event が今の場面より後の場面にだけ結ばれていても残る）", async () => {
    h.events = [row("later")];
    h.sceneEvents = [{ eventId: "later", sceneId: "s3" }];
    h.hits = [hit("later")];
    const result = await search({ query: "q" });
    expect(idsOf(result)).toEqual(["later"]);
  });

  it("secret の event は、場面の読む順が reveal に届けば出る（s0 では隠れ、s2 で出る）", async () => {
    const atS0 = await search({ query: "q" });
    expect(idsOf(atS0)).toEqual(["pub"]);
    h.tree.activeSceneId = "s2";
    const atS2 = await search({ query: "q" });
    expect(idsOf(atS2)).toEqual(["sec", "pub"]);
  });

  it("activeSceneId が無いと secret は全部隠れる（fail-closed）", async () => {
    h.tree.activeSceneId = undefined;
    const result = await search({ query: "q" });
    expect(idsOf(result)).toEqual(["pub"]);
  });
});

describe("limit の表（limit → dense に渡る値と、結果の件数）", () => {
  const many = Array.from({ length: 40 }, (_, i) => hit(`e${i}`));
  const table: Array<[unknown, number, number]> = [
    [undefined, 30, 10],
    [null, 30, 10],
    [0, 30, 10],
    [-1, 30, 10],
    ["abc", 30, 10],
    [Number.NaN, 30, 10],
    [Number.POSITIVE_INFINITY, 30, 10],
    [0.5, 0, 0],
    [2, 6, 2],
    ["5", 15, 5],
    [5.7, 15, 5],
    [10, 30, 10],
    [100, 30, 30],
  ];
  it.each(table)(
    "limit=%s：dense の limit は %i、結果は %i 件",
    async (limit, fetchLimit, count) => {
      h.hits = many;
      const result = await search({ query: "q", limit });
      expect(h.semantic).toHaveBeenCalledTimes(1);
      expect(h.semantic).toHaveBeenCalledWith({
        projectId: "p1",
        query: "q",
        limit: fetchLimit,
      });
      expect((result.content as unknown[]).length).toBe(count);
      expect(result.summary).toBe(`${count} events found`);
    },
  );
});

describe("query の検査", () => {
  it.each([[""], ["   "], [undefined]])(
    "query=%j は 0 events found で、dense・events・store・countTokens を読まない",
    async (query) => {
      const params = query === undefined ? {} : { query };
      const result = await search(params);
      expect(result.summary).toBe("0 events found");
      expect(result.content).toEqual([]);
      expect(result.tokensUsed).toBe(0);
      expect(h.semantic).not.toHaveBeenCalled();
      expect(h.getEvents).not.toHaveBeenCalled();
      expect(h.getSceneEvents).not.toHaveBeenCalled();
      expect(h.getState).not.toHaveBeenCalled();
      expect(h.countTokens).not.toHaveBeenCalled();
    },
  );

  it("空の query は project の検査より先（project が無くても 0 events found）", async () => {
    h.tree.projectId = "";
    const result = await search({ query: "" });
    expect(result.summary).toBe("0 events found");
  });

  it("query は文字列にして trim する（数値 5 は '5'、前後の空白は落とす）", async () => {
    await search({ query: 5 });
    expect(h.semantic).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "5" }),
    );
    await search({ query: "  abc  " });
    expect(h.semantic).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: "abc" }),
    );
  });
});

describe("dense の握り", () => {
  it.each([
    ["Error", () => new Error("dense unavailable")],
    ["文字列", () => "unavailable"],
  ])(
    "%s で reject しても [] と 0 events found になり、debugLog.warn が 1 回呼ばれ、events・sceneEvents は読む",
    async (_label, make) => {
      const failure = make();
      const warn = vi.spyOn(debugLog, "warn").mockImplementation(() => {});
      try {
        h.semantic.mockImplementation(async () => {
          h.log.push("dense");
          throw failure;
        });
        const result = await search({ query: "q" });
        expect(result.error).toBeUndefined();
        expect(result.content).toEqual([]);
        expect(result.summary).toBe("0 events found");
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          "search_events",
          "dense events search failed (empty fallback)",
          errorDetail(failure),
        );
        expect(h.log).toEqual(["dense", "events", "sceneEvents"]);
      } finally {
        warn.mockRestore();
      }
    },
  );
});

describe("結果の形", () => {
  it("content の key 順は eventId・title・kind・score で、余計な key は落とし、tokensUsed は JSON の長さ", async () => {
    h.hits = [
      { ...hit("pub", 0.5), extra: "dropped" },
      { eventId: "x", title: "t", kind: "birth", score: 0.25, rank: 1 },
    ];
    const result = await search({ query: "q" });
    expect(result.name).toBe("search_events");
    const content = result.content as Array<Record<string, unknown>>;
    expect(content.map((c) => Object.keys(c))).toEqual([
      ["eventId", "title", "kind", "score"],
      ["eventId", "title", "kind", "score"],
    ]);
    expect(result.tokensUsed).toBe(JSON.stringify(content).length);
    expect(h.countTokens).toHaveBeenCalledWith(JSON.stringify(content));
    expect(result.summary).toBe("2 events found");
  });

  it("score が null の hit（Native の f32 が NaN のとき serde_json が null にする）は null のまま出る", async () => {
    h.hits = [hit("pub", null)];
    const result = await search({ query: "q" });
    expect(result.content).toEqual([
      { eventId: "pub", title: "title pub", kind: "generic", score: null },
    ]);
    expect(JSON.stringify(result.content)).toContain('"score":null');
  });
});
