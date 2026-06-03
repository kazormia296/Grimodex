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
