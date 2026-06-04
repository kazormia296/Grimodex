import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock deps so executors can be dispatched without a real Tauri / DB runtime.
const { mockInvoke, mockListOpenForeshadows, mockTreeProjectId } = vi.hoisted(
  () => ({
    mockInvoke: vi.fn(),
    mockListOpenForeshadows: vi.fn(),
    mockTreeProjectId: vi.fn<() => string | null>(),
  }),
);

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
vi.mock("@/features/tree/api", () => ({
  loadSceneContent: vi.fn(),
}));
vi.mock("@/lib/prosemirror", () => ({
  prosemirrorToText: vi.fn(),
}));
vi.mock("@/features/codex/prosemirrorTextExtractor", () => ({
  extractPlainText: vi.fn(),
}));
vi.mock("../contextBuilder", () => ({
  countTokens: (s: string) => (s ? s.length : 0),
}));

import { executeTool, EXECUTORS } from "./toolExecutors";
import { getDeterministicAgentTools } from "./toolDefinitions";

// ── read-only allowlist 不変条件 (security review F-2) ───────────────────────
// EXECUTORS は read-only ツールのみで構成される契約。mutating executor を追加
// すると下記 allowlist テストが落ち、agentLoop の宣言ゲート / AiPolicy bodyWrite
// 連動の再確認を強制する。
describe("EXECUTORS — read-only allowlist invariant", () => {
  // 凍結された期待リスト。新ツール追加でここを更新する＝意識的な追加になる。
  const EXPECTED_EXECUTOR_NAMES = [
    "find_related_entries",
    "get_chapter_summaries",
    "get_codex_entry",
    "get_foreshadow_detail",
    "get_scene",
    "get_scene_timeline_neighbors",
    "list_chapters",
    "list_codex_by_type",
    "list_codex_tags",
    "list_open_foreshadows",
    "search_codex",
    "search_codex_by_tags",
    "search_scenes",
    "search_snippets",
  ];

  it("matches the frozen read-only allowlist exactly", () => {
    expect(Object.keys(EXECUTORS).sort()).toEqual(EXPECTED_EXECUTOR_NAMES);
  });

  it("covers every non-ask_user AGENT_TOOL and excludes ask_user", () => {
    const executorNames = new Set(Object.keys(EXECUTORS));
    const dataToolNames = getDeterministicAgentTools()
      .map((t) => t.name)
      .filter((n) => n !== "ask_user");
    const missing = dataToolNames.filter((n) => !executorNames.has(n));
    expect(missing).toEqual([]);
    // ask_user は mutating ではないが executor を持たない（guardedExecuteTool が横取り）。
    expect(executorNames.has("ask_user")).toBe(false);
  });

  it("is frozen against runtime mutation", () => {
    expect(Object.isFrozen(EXECUTORS)).toBe(true);
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
});
