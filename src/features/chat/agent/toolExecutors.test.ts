import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock deps so executors can be dispatched without a real Tauri / DB runtime.
const {
  mockInvoke,
  mockListOpenForeshadows,
  mockTreeProjectId,
  mockAgentCreateForeshadow,
  mockAgentUpdateForeshadow,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockListOpenForeshadows: vi.fn(),
  mockTreeProjectId: vi.fn<() => string | null>(),
  mockAgentCreateForeshadow: vi.fn(),
  mockAgentUpdateForeshadow: vi.fn(),
}));

vi.mock("@/features/agent-writes/foreshadow", () => ({
  agentCreateForeshadow: mockAgentCreateForeshadow,
  agentUpdateForeshadow: mockAgentUpdateForeshadow,
}));

vi.mock("@/lib/tauri", () => ({ invoke: mockInvoke }));

vi.mock("@/features/foreshadow/api", () => ({
  listOpenForeshadowsForContext: mockListOpenForeshadows,
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: () => ({ projectId: mockTreeProjectId() }) },
}));

// db client returns empty arrays for any query — enough to exercise the
// executor branch without a real sqlite instance.
vi.mock("@/db/client", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  };
  return { db: chain };
});

// Heavy imports unrelated to the dispatcher branches we exercise.
// @/lib/prosemirror は依存なしの純関数なので実装をそのまま使う
// （search 系の excerpt plain-text 化を実変換で検証するため）。
vi.mock("@/features/tree/api", () => ({
  loadSceneContent: vi.fn(),
}));
vi.mock("@/features/codex/prosemirrorTextExtractor", () => ({
  extractPlainText: vi.fn(),
}));
vi.mock("../contextBuilder", () => ({
  countTokens: (s: string) => (s ? s.length : 0),
}));

import {
  executeTool,
  executeReadOnlyTool,
  EXECUTORS,
  READ_ONLY_EXECUTORS,
  MUTATING_EXECUTORS,
} from "./toolExecutors";
import { MUTATING_TOOL_NAMES } from "../toolProtocolParse";
import {
  getDeterministicAgentTools,
  READ_ONLY_TOOL_NAMES,
} from "./toolDefinitions";

// ── read-only allowlist 不変条件 (security review F-2) ───────────────────────
// EXECUTORS は read-only ツールのみで構成される契約。mutating executor を追加
// すると下記 allowlist テストが落ち、agentLoop の宣言ゲート / AiPolicy bodyWrite
// 連動の再確認を強制する。
describe("EXECUTORS — read-only allowlist invariant", () => {
  const EXPECTED_READ_ONLY_NAMES = [
    "find_related_entries",
    "get_chapter_summaries",
    "get_character_timeline",
    "get_chronicle_state",
    "get_codex_entry",
    "get_event_detail",
    "get_foreshadow_detail",
    "get_scene",
    "get_scene_timeline_neighbors",
    "get_thread_scenes",
    "list_chapters",
    "list_codex_by_type",
    "list_codex_tags",
    "list_events",
    "list_open_foreshadows",
    "list_plot_threads",
    "search_codex",
    "search_codex_by_tags",
    "search_events",
    "search_scenes",
    "search_snippets",
  ];

  const EXPECTED_MUTATING_NAMES = [
    "add_event_relation",
    "apply_ai_tree_plan",
    "create_codex_entry",
    "create_event",
    "create_foreshadow",
    "create_snippet",
    "delete_event",
    "propose_scene_body",
    "remove_event_relation",
    "set_event_participants",
    "stamp_scene_event",
    "unstamp_scene_event",
    "update_codex_entry",
    "update_event",
    "update_foreshadow",
  ];

  it("matches the frozen read-only allowlist exactly", () => {
    expect(Object.keys(READ_ONLY_EXECUTORS).sort()).toEqual(
      EXPECTED_READ_ONLY_NAMES,
    );
  });

  it("matches the frozen mutating allowlist exactly", () => {
    expect(Object.keys(MUTATING_EXECUTORS).sort()).toEqual(
      EXPECTED_MUTATING_NAMES,
    );
  });

  it("MUTATING_TOOL_NAMES (Hermes write block) tracks MUTATING_EXECUTORS", () => {
    // The Hermes body-channel block list must cover every mutating executor,
    // or a new write tool could be invoked via injected <tool_call> body text.
    expect([...MUTATING_TOOL_NAMES].sort()).toEqual(
      Object.keys(MUTATING_EXECUTORS).sort(),
    );
  });

  it("covers every AGENT_TOOL except the chatStore-intercepted ones", () => {
    // ask_user / run_research は EXECUTORS に入れず、chatStore の
    // guardedExecuteTool が UI 往復 / サブエージェントとして横取りする。
    const intercepted = new Set(["ask_user", "run_research"]);
    const executorNames = new Set(Object.keys(EXECUTORS));
    const dataToolNames = getDeterministicAgentTools()
      .map((t) => t.name)
      .filter((n) => !intercepted.has(n));
    const missing = dataToolNames.filter((n) => !executorNames.has(n));
    expect(missing).toEqual([]);
    expect(executorNames.has("ask_user")).toBe(false);
    expect(executorNames.has("run_research")).toBe(false);
  });

  it("is frozen against runtime mutation", () => {
    expect(Object.isFrozen(READ_ONLY_EXECUTORS)).toBe(true);
    expect(Object.isFrozen(MUTATING_EXECUTORS)).toBe(true);
    expect(Object.isFrozen(EXECUTORS)).toBe(true);
  });

  it("READ_ONLY_TOOL_NAMES (research subagent allowlist) tracks READ_ONLY_EXECUTORS", () => {
    // toolDefinitions の正本 list が toolExecutors の実体とドリフトすると、
    // リサーチ・サブエージェントに「宣言したのに dispatch できない」ツールが
    // 紛れる / 逆に read-only ツールが欠ける。両者の一致を gate する。
    expect([...READ_ONLY_TOOL_NAMES].sort()).toEqual(
      Object.keys(READ_ONLY_EXECUTORS).sort(),
    );
  });
});

// ── executeReadOnlyTool（リサーチ・サブエージェント用 dispatcher）─────────────
describe("executeReadOnlyTool — read-only dispatch invariant", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockTreeProjectId.mockReset();
    mockAgentCreateForeshadow.mockReset();
  });

  it("rejects every mutating tool (cannot write from a sub-agent)", async () => {
    for (const name of Object.keys(MUTATING_EXECUTORS)) {
      const res = await executeReadOnlyTool(name, "t1", {});
      expect(res.error).toBeTruthy();
      expect(res.content).toBeNull();
      expect(res.error).toContain("read-only");
    }
    // 念のため代表的な mutating executor が一切呼ばれていないこと。
    expect(mockAgentCreateForeshadow).not.toHaveBeenCalled();
  });

  it("rejects ask_user and run_research (no questions, no recursion)", async () => {
    for (const name of ["ask_user", "run_research"]) {
      const res = await executeReadOnlyTool(name, "t1", {});
      expect(res.error).toBeTruthy();
      expect(res.content).toBeNull();
    }
  });

  it("dispatches a read-only tool through to its executor", async () => {
    mockTreeProjectId.mockReturnValue("p1");
    const res = await executeReadOnlyTool("list_chapters", "t1", {});
    // db mock は空配列を返すので成功（error なし）で抜ける。
    expect(res.error).toBeUndefined();
    expect(res.name).toBe("list_chapters");
  });
});

describe("executeTool — Phase 3 dispatch", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockListOpenForeshadows.mockReset();
    mockTreeProjectId.mockReset();
  });

  it("list_open_foreshadows returns rows from foreshadow API", async () => {
    mockTreeProjectId.mockReturnValue("p1");
    mockListOpenForeshadows.mockResolvedValue([
      {
        id: "f1",
        title: "失われた剣",
        intent: "勇者の使命",
        loadBearing: "critical" as const,
        setupCount: 2,
      },
    ]);

    const result = await executeTool("list_open_foreshadows", "call-1", {});
    expect(result.error).toBeUndefined();
    expect(result.name).toBe("list_open_foreshadows");
    expect(Array.isArray(result.content)).toBe(true);
    expect((result.content as unknown[]).length).toBe(1);
    expect(mockListOpenForeshadows).toHaveBeenCalledWith("p1");
  });

  it("list_open_foreshadows returns empty when no project is active", async () => {
    mockTreeProjectId.mockReturnValue(null);
    const result = await executeTool("list_open_foreshadows", "call-2", {});
    expect(result.error).toBeUndefined();
    expect(result.summary).toContain("No active project");
    expect(mockListOpenForeshadows).not.toHaveBeenCalled();
  });

  it("get_foreshadow_detail rejects empty id without throwing", async () => {
    const result = await executeTool("get_foreshadow_detail", "call-3", {
      id: "",
    });
    expect(result.error).toBeUndefined();
    expect(result.summary).toBe("No id provided");
    expect(result.content).toBeNull();
  });

  it("get_scene_timeline_neighbors rejects empty sceneId without throwing", async () => {
    const result = await executeTool("get_scene_timeline_neighbors", "call-4", {
      sceneId: "",
    });
    expect(result.error).toBeUndefined();
    expect(result.summary).toBe("No sceneId provided");
    expect(result.content).toEqual({
      previous: [],
      next: [],
      currentSceneStoryTimeLabel: null,
    });
  });

  it("unknown tool dispatches to the not-found branch", async () => {
    const result = await executeTool("nope_does_not_exist", "call-5", {});
    expect(result.error).toBe("Unknown tool: nope_does_not_exist");
  });
});

// ── foreshadow write executors（knowledgeWrite gated, tracked path）──────────
describe("foreshadow write executors", () => {
  beforeEach(() => {
    mockAgentCreateForeshadow.mockReset();
    mockAgentUpdateForeshadow.mockReset();
  });

  it("create_foreshadow requires title (error result, no write)", async () => {
    const result = await executeTool("create_foreshadow", "call-f1", {});
    expect(result.error).toBeTruthy();
    expect(mockAgentCreateForeshadow).not.toHaveBeenCalled();
  });

  it("create_foreshadow returns id/title/secret on success", async () => {
    mockAgentCreateForeshadow.mockResolvedValue({
      id: "f1",
      title: "刻印の謎",
      secret: true,
    });
    const result = await executeTool("create_foreshadow", "call-f2", {
      title: "刻印の謎",
      intent: "後で回収",
      loadBearing: "critical",
    });
    expect(result.error).toBeUndefined();
    expect(result.content).toMatchObject({
      id: "f1",
      title: "刻印の謎",
      secret: true,
    });
    expect(mockAgentCreateForeshadow).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "刻印の謎",
        intent: "後で回収",
        loadBearing: "critical",
      }),
    );
  });

  it("create_foreshadow wraps agent-write failures as error results", async () => {
    mockAgentCreateForeshadow.mockRejectedValue(
      new Error("knowledgeWrite policy is off"),
    );
    const result = await executeTool("create_foreshadow", "call-f3", {
      title: "x",
    });
    expect(result.error).toBe("knowledgeWrite policy is off");
  });

  it("update_foreshadow requires id (error result, no write)", async () => {
    const result = await executeTool("update_foreshadow", "call-f4", {
      title: "renamed",
    });
    expect(result.error).toBeTruthy();
    expect(mockAgentUpdateForeshadow).not.toHaveBeenCalled();
  });

  it("update_foreshadow passes boolean patch fields through", async () => {
    mockAgentUpdateForeshadow.mockResolvedValue({
      id: "f1",
      title: "刻印の謎",
      payoffConfirmed: true,
      abandoned: false,
    });
    const result = await executeTool("update_foreshadow", "call-f5", {
      id: "f1",
      payoffConfirmed: true,
    });
    expect(result.error).toBeUndefined();
    expect(mockAgentUpdateForeshadow).toHaveBeenCalledWith(
      expect.objectContaining({
        foreshadowId: "f1",
        payoffConfirmed: true,
      }),
    );
  });
});

// ── search 結果の整形契約 ─────────────────────────────────────────────────────
// tree_nodes.content / snippets.content は ProseMirror JSON。excerpt/preview は
// plain text に変換してから LLM に渡し、tags は {name,color}[] でなく name の
// string[] にする（listCodexByType と同経路）。
describe("search result shaping — plain-text excerpts & tag names", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockTreeProjectId.mockReset();
    mockTreeProjectId.mockReturnValue("p1");
  });

  const pmDoc = (text: string) =>
    JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });

  it("search_scenes (FTS path) returns a plain-text excerpt, not raw ProseMirror JSON", async () => {
    mockInvoke.mockResolvedValue({
      rows: [
        { id: "s1", title: "T", content: pmDoc("ドラゴンが火を吹いた。") },
      ],
    });
    const res = await executeTool("search_scenes", "c", { query: "ドラゴン" });
    const [row] = res.content as Array<{ excerpt: string }>;
    expect(row.excerpt).toBe("ドラゴンが火を吹いた。");
    expect(row.excerpt).not.toContain('"type"');
  });

  it("search_scenes (LIKE fallback) also plain-texts the excerpt", async () => {
    mockInvoke.mockResolvedValue({
      rows: [{ id: "s1", title: "T", content: pmDoc("火を吹いた。") }],
    });
    const res = await executeTool("search_scenes", "c", { query: "火" });
    const [row] = res.content as Array<{ excerpt: string }>;
    expect(row.excerpt).toBe("火を吹いた。");
  });

  it("search_scenes centers the excerpt around the first matched token", async () => {
    const long = "あ".repeat(300) + "ドラゴン" + "い".repeat(300);
    mockInvoke.mockResolvedValue({
      rows: [{ id: "s1", title: "T", content: pmDoc(long) }],
    });
    const res = await executeTool("search_scenes", "c", { query: "ドラゴン" });
    const [row] = res.content as Array<{ excerpt: string }>;
    expect(row.excerpt).toContain("ドラゴン");
    expect(row.excerpt.startsWith("...")).toBe(true);
    expect(row.excerpt.endsWith("...")).toBe(true);
    expect(row.excerpt.length).toBeLessThanOrEqual(206);
  });

  it("search_scenes tolerates NULL content", async () => {
    mockInvoke.mockResolvedValue({
      rows: [{ id: "s1", title: "T", content: null }],
    });
    const res = await executeTool("search_scenes", "c", { query: "ドラゴン" });
    const [row] = res.content as Array<{ excerpt: string }>;
    expect(row.excerpt).toBe("");
  });

  it("search_snippets returns tag names (string[]) and a plain-text preview", async () => {
    mockInvoke.mockResolvedValue({
      rows: [
        {
          id: "n1",
          title: "雨",
          tags_cache: JSON.stringify([
            { name: "伏線", color: "#fff" },
            { name: "終盤", color: null },
          ]),
          content: pmDoc("雨の描写。"),
        },
      ],
    });
    const res = await executeTool("search_snippets", "c", {
      query: "雨の描写",
    });
    const [row] = res.content as Array<{ tags: string[]; preview: string }>;
    expect(row.tags).toEqual(["伏線", "終盤"]);
    expect(row.preview).toBe("雨の描写。");
    expect(row.preview).not.toContain('"type"');
  });
});

// ── project スコープ不変条件 (security audit XPROJ-1) ─────────────────────────
// agent の read ツールはアクティブプロジェクトに限定されなければならない
// (単一 grimodex.db に複数プロジェクトが同居するため、述語が欠けると別プロジェクト
// の本文/設定資料/スニペットが漏れる)。raw-SQL 経路は SQL に project_id 述語と
// 束縛パラメータが入ることを assert し、全 read ツールは projectId 未設定時に
// fail-closed (DB を引かず "No active project") であることを assert する。
// いずれかのツールから述語を外すと当該テストが落ちる差分検証。
describe("project scoping — agent read tools (XPROJ-1)", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockTreeProjectId.mockReset();
  });

  // db_execute (raw SQL) に直接到達し、先行する Drizzle ゲートを持たないツール。
  const RAW_SQL_TOOLS = [
    { tool: "search_codex", params: { query: "ドラゴン" } },
    { tool: "search_scenes", params: { query: "ドラゴン" } },
    { tool: "search_snippets", params: { query: "ドラゴン" } },
    { tool: "search_codex_by_tags", params: { tags: ["世界観"] } },
    { tool: "list_codex_tags", params: {} },
  ];

  it.each(RAW_SQL_TOOLS)(
    "$tool binds the active project_id into its SQL",
    async ({ tool, params }) => {
      mockTreeProjectId.mockReturnValue("proj-A");
      mockInvoke.mockResolvedValue({ rows: [] });

      const res = await executeTool(tool, "c", params);
      expect(res.error).toBeUndefined();

      const dbExecCalls = mockInvoke.mock.calls.filter(
        (c) => c[0] === "db_execute",
      );
      expect(dbExecCalls.length).toBeGreaterThan(0);
      const call = dbExecCalls[dbExecCalls.length - 1][1] as {
        sql: string;
        params: unknown[];
      };
      expect(call.sql).toContain("project_id");
      expect(call.params).toContain("proj-A");
    },
  );

  // raw-SQL + Drizzle 両系統の全 read ツール。projectId 未設定で必ず fail-closed。
  const ALL_READ_TOOLS = [
    ...RAW_SQL_TOOLS,
    { tool: "find_related_entries", params: { id: "e1" } },
    { tool: "list_codex_by_type", params: { type: "character" } },
    { tool: "list_chapters", params: {} },
    { tool: "get_chapter_summaries", params: {} },
    { tool: "get_codex_entry", params: { id: "e1" } },
    { tool: "get_scene", params: { id: "s1" } },
    { tool: "get_foreshadow_detail", params: { id: "f1" } },
    { tool: "get_scene_timeline_neighbors", params: { sceneId: "s1" } },
    { tool: "list_plot_threads", params: {} },
    { tool: "get_thread_scenes", params: { threadId: "t1" } },
  ];

  it.each(ALL_READ_TOOLS)(
    "$tool fails closed (no DB query) when no project is active",
    async ({ tool, params }) => {
      mockTreeProjectId.mockReturnValue(null);
      mockInvoke.mockResolvedValue({ rows: [] });

      const res = await executeTool(tool, "c", params);
      expect(res.error).toBeUndefined();
      expect(res.summary).toContain("No active project");
      const dbExecCalls = mockInvoke.mock.calls.filter(
        (c) => c[0] === "db_execute",
      );
      expect(dbExecCalls.length).toBe(0);
    },
  );

  // get_thread_scenes は 2 段 XPROJ: まず thread_id → plot_threads.project_id を
  // 検証し、別 project のスレッドはシーン/リンクに触れる前に弾く（nodeId 単独
  // lookup 禁止）。共有 db mock は where() を [] で解決するため、アクティブ
  // project に当該スレッドが無い = 別 project のスレッドを渡したのと同値で、
  // 「Thread not found」を返し、本文ロード(loadSceneContent)に進まないこと。
  it("get_thread_scenes gates on the thread's project before touching scenes", async () => {
    mockTreeProjectId.mockReturnValue("proj-A");
    const { loadSceneContent } = await import("@/features/tree/api");
    (loadSceneContent as ReturnType<typeof vi.fn>).mockClear();

    const res = await executeTool("get_thread_scenes", "c", {
      threadId: "t-foreign",
    });

    expect(res.error).toBeUndefined();
    expect(res.summary).toContain("not found");
    expect(loadSceneContent).not.toHaveBeenCalled();
  });
});

// search_codex は段階3で dense(codex_semantic_search) + sparse(codex_fts) を
// RRF 融合する。dense が失敗 (feature 無効 / 未 index) なら sparse 単独へ退避する。
describe("search_codex hybrid fusion (段階3)", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockTreeProjectId.mockReset();
    mockTreeProjectId.mockReturnValue("proj-A");
  });

  it("fuses dense and sparse results", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "codex_semantic_search") {
        return Promise.resolve([
          {
            entryId: "e-dense",
            entryName: "DenseHit",
            entryType: "character",
            summary: "d",
            score: 0.9,
          },
        ]);
      }
      if (cmd === "db_execute") {
        return Promise.resolve({
          rows: [
            {
              id: "e-sparse",
              name: "SparseHit",
              type: "location",
              summary: "s",
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await executeTool("search_codex", "c", {
      query: "ドラクタール",
    });
    expect(res.error).toBeUndefined();
    const ids = (res.content as { id: string }[]).map((r) => r.id);
    expect(ids).toContain("e-dense");
    expect(ids).toContain("e-sparse");
    expect(
      mockInvoke.mock.calls.some((c) => c[0] === "codex_semantic_search"),
    ).toBe(true);
  });

  it("falls back to sparse-only when dense search rejects", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "codex_semantic_search") {
        return Promise.reject(new Error("semantic-embedding disabled"));
      }
      if (cmd === "db_execute") {
        return Promise.resolve({
          rows: [
            {
              id: "e-sparse",
              name: "SparseHit",
              type: "location",
              summary: "s",
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await executeTool("search_codex", "c", {
      query: "ドラクタール",
    });
    expect(res.error).toBeUndefined();
    const ids = (res.content as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(["e-sparse"]);
  });
});
