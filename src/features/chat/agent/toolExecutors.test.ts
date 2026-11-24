import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock deps so executors can be dispatched without a real Tauri / DB runtime.
const {
  mockInvoke,
  mockReadOpenForeshadowWire,
  mockTreeProjectId,
  mockAgentCreateForeshadow,
  mockAgentUpdateForeshadow,
  mockAgentCreateCodexEntry,
  mockAgentUpdateCodexEntry,
  mockAgentCreateSnippet,
  mockAgentCreateEvent,
  mockAgentUpdateEvent,
  mockAgentDeleteEvent,
  mockAgentSetEventParticipants,
  mockAgentLinkSceneEvent,
  mockAgentUnlinkSceneEvent,
  mockAgentAddEventRelation,
  mockAgentRemoveEventRelation,
  mockProjectId,
  mockDbRows,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockReadOpenForeshadowWire: vi.fn(),
  mockTreeProjectId: vi.fn<() => string | null>(),
  mockAgentCreateForeshadow: vi.fn(),
  mockAgentUpdateForeshadow: vi.fn(),
  mockAgentCreateCodexEntry: vi.fn(),
  mockAgentUpdateCodexEntry: vi.fn(),
  mockAgentCreateSnippet: vi.fn(),
  mockAgentCreateEvent: vi.fn(),
  mockAgentUpdateEvent: vi.fn(),
  mockAgentDeleteEvent: vi.fn(),
  mockAgentSetEventParticipants: vi.fn(),
  mockAgentLinkSceneEvent: vi.fn(),
  mockAgentUnlinkSceneEvent: vi.fn(),
  mockAgentAddEventRelation: vi.fn(),
  mockAgentRemoveEventRelation: vi.fn(),
  mockProjectId: vi.fn<() => string>(),
  mockDbRows: vi.fn<() => unknown[]>(),
}));

vi.mock("@/features/agent-writes/codex", () => ({
  agentCreateCodexEntry: mockAgentCreateCodexEntry,
  agentUpdateCodexEntry: mockAgentUpdateCodexEntry,
}));

vi.mock("@/features/agent-writes/snippet", () => ({
  agentCreateSnippet: mockAgentCreateSnippet,
}));

vi.mock("@/features/agent-writes/foreshadow", () => ({
  agentCreateForeshadow: mockAgentCreateForeshadow,
  agentUpdateForeshadow: mockAgentUpdateForeshadow,
}));

vi.mock("@/features/agent-writes/event", () => ({
  agentCreateEvent: mockAgentCreateEvent,
  agentUpdateEvent: mockAgentUpdateEvent,
  agentDeleteEvent: mockAgentDeleteEvent,
  agentSetEventParticipants: mockAgentSetEventParticipants,
  agentLinkSceneEvent: mockAgentLinkSceneEvent,
  agentUnlinkSceneEvent: mockAgentUnlinkSceneEvent,
  agentAddEventRelation: mockAgentAddEventRelation,
  agentRemoveEventRelation: mockAgentRemoveEventRelation,
}));

// hidden の判定（DB）は toolExecutors.codexHidden.test.ts が検証する。ここは素通し。
vi.mock("@/features/codex/context/codexHiddenFromAi", () => ({
  dropCodexHiddenFromAi: async <T>(rows: readonly T[]) => [...rows],
  resolveCodexForAi: async () => ({
    hidden: new Set<string>(),
    texts: new Map(),
  }),
  visibleCodexIdsForAi: async (ids: readonly string[]) => [...ids],
  visibleCodexForAi: async (ids: readonly string[]) => ({
    ids: [...ids],
    summaries: new Map(),
  }),
}));

// 4 本の Codex tool（search_codex など）は MP-4b PR-8b で共有 core の判定を通る。core は Phase を
// renderer の `listPhasesByEntryIds` から読む（loader port）ので、ここでは Phase 無しにする。
// hidden の判定そのものは toolExecutors.codexHidden.test.ts が検証する。
vi.mock("@/features/codex/phaseApi", () => ({
  listPhasesByEntryIds: async () => [],
  listDetailOverridesByPhaseIds: async () => [],
}));

vi.mock("@/lib/tauri", () => ({ invoke: mockInvoke }));

vi.mock("@/features/foreshadow/api", () => ({
  readOpenForeshadowWire: mockReadOpenForeshadowWire,
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: () => ({ projectId: mockTreeProjectId() }) },
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: mockProjectId,
}));

// db client returns empty arrays for any query — enough to exercise the
// executor branch without a real sqlite instance.
vi.mock("@/db/client", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    selectDistinct: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: (
      resolve: (value: unknown[]) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve(mockDbRows()).then(resolve, reject),
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
// propose_setting_change の本体は settingProposalTools.test.ts で検証する。ここは dispatch だけ。
const { mockProposeSettingChange } = vi.hoisted(() => ({
  mockProposeSettingChange: vi.fn(),
}));
vi.mock("./settingProposalTools", () => ({
  proposeSettingChangeTool: mockProposeSettingChange,
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
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { invalidateChronicleToolCache } from "./chronicleToolCache";

const TOOL_TEST_WORKSPACE_PATH = "/workspace/tool-executors-test";

beforeEach(() => {
  mockProjectId.mockReturnValue("project-1");
  mockDbRows.mockReset();
  mockDbRows.mockReturnValue([]);
  setCurrentWorkspaceIdentity({
    path: TOOL_TEST_WORKSPACE_PATH,
    openRevision: 1,
  });
});

afterEach(() => {
  setCurrentWorkspaceIdentity(null);
});

// ── read-only allowlist 不変条件 (security review F-2) ───────────────────────
// EXECUTORS は read-only ツールのみで構成される契約。mutating executor を追加
// すると下記 allowlist テストが落ち、agentLoop の宣言ゲート / AiPolicy bodyWrite
// 連動の再確認を強制する。
describe("EXECUTORS — read-only allowlist invariant", () => {
  const EXPECTED_READ_ONLY_NAMES = [
    "find_related_entries",
    "get_app_help",
    "get_app_help_index",
    "get_chapter_summaries",
    "get_character_timeline",
    "get_chronicle_state",
    "get_codex_entry",
    "get_event_detail",
    "get_foreshadow_detail",
    "get_scene",
    "get_scene_timeline_neighbors",
    "get_thread_scenes",
    "get_ui_state",
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
    "apply_layout_preset",
    "create_codex_entry",
    "create_event",
    "create_foreshadow",
    "create_snippet",
    "delete_event",
    "propose_scene_body",
    "propose_setting_change",
    "remove_event_relation",
    "run_app_command",
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
    mockReadOpenForeshadowWire.mockReset();
    mockTreeProjectId.mockReset();
  });

  // MP-4b PR-5b：port は「wire を返すだけ」（`readOpenForeshadowWire`）で、組み立ては共有 core。
  // PR-4 の方針（mock の seam を保つ）から外れる（この it と下の「project が無い」の 2 件の mock。DR-MP4-35）。意図は同じ：
  // 結果の各 field（id・title・intent・loadBearing・setupCount）を確かめ続ける。
  it("list_open_foreshadows builds its rows from the foreshadow wire", async () => {
    mockTreeProjectId.mockReturnValue("p1");
    mockReadOpenForeshadowWire.mockResolvedValue({
      foreshadows: [
        {
          id: "f1",
          title: "失われた剣",
          intent: "勇者の使命",
          load_bearing: "critical",
          version: 0,
          payoff_confirmed: 0,
          abandoned: 0,
          updated_at: 1_767_225_600_000,
        },
      ],
      setups: [
        { foreshadow_id: "f1", is_orphan: 0 },
        { foreshadow_id: "f1", is_orphan: 0 },
        { foreshadow_id: "f1", is_orphan: 1 },
      ],
    });

    const result = await executeTool("list_open_foreshadows", "call-1", {});
    expect(result.error).toBeUndefined();
    expect(result.name).toBe("list_open_foreshadows");
    expect(result.content).toEqual([
      {
        id: "f1",
        title: "失われた剣",
        intent: "勇者の使命",
        loadBearing: "critical",
        setupCount: 2,
      },
    ]);
    expect(result.summary).toBe("1 open foreshadowing items");
    expect(mockReadOpenForeshadowWire).toHaveBeenCalledWith("p1");
  });

  it("list_open_foreshadows returns empty when no project is active", async () => {
    mockTreeProjectId.mockReturnValue(null);
    const result = await executeTool("list_open_foreshadows", "call-2", {});
    expect(result.error).toBeUndefined();
    expect(result.summary).toContain("No active project");
    expect(mockReadOpenForeshadowWire).not.toHaveBeenCalled();
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

  it("create_foreshadow rejects secret=true, string, number, and null without writing", async () => {
    for (const secret of [true, "true", 1, null]) {
      const result = await executeTool("create_foreshadow", "call-f2", {
        title: "刻印の謎",
        secret,
      });
      expect(result.error).toBe(
        "secret is no longer supported: foreshadows cannot be hidden from the AI. Omit it.",
      );
      expect(mockAgentCreateForeshadow).not.toHaveBeenCalled();
    }
  });

  it.each([{}, { secret: false }])(
    "create_foreshadow returns id/title and always writes secret=false (%#)",
    async (secretInput) => {
      mockAgentCreateForeshadow.mockResolvedValue({
        id: "f1",
        title: "刻印の謎",
        secret: false,
      });
      const result = await executeTool("create_foreshadow", "call-f2", {
        title: "刻印の謎",
        intent: "後で回収",
        loadBearing: "critical",
        ...secretInput,
      });
      expect(result.error).toBeUndefined();
      expect(result.content).toEqual({
        id: "f1",
        title: "刻印の謎",
      });
      expect(result.summary).toBe("Created foreshadow '刻印の謎'");
      expect(mockAgentCreateForeshadow).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "刻印の謎",
          intent: "後で回収",
          loadBearing: "critical",
          secret: false,
        }),
      );
    },
  );

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
      baseVersion: 3,
      payoffConfirmed: true,
    });
    expect(result.error).toBeUndefined();
    expect(mockAgentUpdateForeshadow).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.stringMatching(/^agent-tool:[0-9a-f]{64}$/),
        foreshadowId: "f1",
        baseVersion: 3,
        payoffConfirmed: true,
      }),
    );
    expect(mockAgentUpdateForeshadow.mock.calls[0]?.[0]).not.toHaveProperty(
      "secret",
    );
  });

  it.each([true, false])(
    "update_foreshadow rejects the secret key with value %s without writing",
    async (secret) => {
      const result = await executeTool("update_foreshadow", "call-f6", {
        id: "f1",
        baseVersion: 3,
        secret,
      });
      expect(result.error).toBe(
        "secret is no longer supported: foreshadows cannot be hidden from the AI. Omit it.",
      );
      expect(mockAgentUpdateForeshadow).not.toHaveBeenCalled();
    },
  );
});

describe("Codex and Snippet rich-text write executors", () => {
  beforeEach(() => {
    mockAgentCreateCodexEntry.mockReset();
    mockAgentUpdateCodexEntry.mockReset();
    mockAgentCreateSnippet.mockReset();
  });

  it("converts Markdown and serializes structured aliases before creating Codex", async () => {
    mockAgentCreateCodexEntry.mockResolvedValue({
      id: "entry-1",
      name: "Akane",
      type: "character",
    });

    const result = await executeTool("create_codex_entry", "call-c1", {
      type: "character",
      name: "Akane",
      content: "# Profile\n\nMain character.",
      aliases: ["Hero", "  Protagonist  "],
    });

    expect(result.error).toBeUndefined();
    const input = mockAgentCreateCodexEntry.mock.calls[0]![0] as {
      content: string;
      aliases: string;
    };
    expect(input.aliases).toBe(JSON.stringify(["Hero", "Protagonist"]));
    expect(JSON.parse(input.content)).toMatchObject({
      type: "doc",
      content: expect.arrayContaining([
        expect.objectContaining({ type: "heading" }),
        expect.objectContaining({ type: "paragraph" }),
      ]),
    });
  });

  it("rejects malformed aliases without calling a Codex writer", async () => {
    const result = await executeTool("update_codex_entry", "call-c2", {
      id: "entry-1",
      aliases: ["valid", 42],
    });

    expect(result.error).toContain("array of strings");
    expect(mockAgentUpdateCodexEntry).not.toHaveBeenCalled();
  });

  it("rejects excessive aliases without calling a Codex writer", async () => {
    const result = await executeTool("create_codex_entry", "call-c3", {
      type: "character",
      name: "Akane",
      aliases: Array.from({ length: 101 }, (_, index) => `alias-${index}`),
    });

    expect(result.error).toContain("at most 100");
    expect(mockAgentCreateCodexEntry).not.toHaveBeenCalled();
  });

  it("converts Snippet Markdown into schema-valid ProseMirror JSON", async () => {
    mockAgentCreateSnippet.mockResolvedValue({
      id: "snippet-1",
      title: "Opening",
    });

    const result = await executeTool("create_snippet", "call-s1", {
      title: "Opening",
      content: "**Storm** at midnight.",
    });

    expect(result.error).toBeUndefined();
    const input = mockAgentCreateSnippet.mock.calls[0]![0] as {
      content: string;
    };
    expect(JSON.parse(input.content)).toMatchObject({
      type: "doc",
      content: expect.arrayContaining([
        expect.objectContaining({ type: "paragraph" }),
      ]),
    });
  });
});

describe("durable mutation tool request identity", () => {
  beforeEach(() => {
    mockAgentCreateCodexEntry.mockReset();
    mockAgentCreateSnippet.mockReset();
    mockAgentCreateForeshadow.mockReset();
    mockAgentUpdateForeshadow.mockReset();
    mockAgentCreateEvent.mockReset();
    mockAgentUpdateEvent.mockReset();
    mockAgentDeleteEvent.mockReset();
    mockAgentSetEventParticipants.mockReset();
    mockAgentLinkSceneEvent.mockReset();
    mockAgentUnlinkSceneEvent.mockReset();
    mockAgentAddEventRelation.mockReset();
    mockAgentRemoveEventRelation.mockReset();
    mockProjectId.mockReset();
    mockProjectId.mockReturnValue("project-1");
  });

  it("derives one stable, tool-scoped requestId from the same toolCallId", async () => {
    mockAgentCreateCodexEntry.mockResolvedValue({
      id: "codex-1",
      name: "Akane",
      type: "character",
    });
    mockAgentCreateSnippet.mockResolvedValue({
      id: "snippet-1",
      title: "Opening",
    });
    mockAgentCreateForeshadow.mockResolvedValue({
      id: "foreshadow-1",
      title: "The seal",
      secret: true,
    });
    mockAgentUpdateForeshadow.mockResolvedValue({
      id: "foreshadow-1",
      title: "The opened seal",
      payoffConfirmed: false,
      abandoned: false,
    });
    mockAgentCreateEvent.mockResolvedValue({
      id: "event-1",
      title: "Arrival",
    });

    const cases = [
      {
        name: "create_codex_entry",
        params: { type: "character", name: "Akane" },
        writer: mockAgentCreateCodexEntry,
      },
      {
        name: "create_snippet",
        params: { title: "Opening" },
        writer: mockAgentCreateSnippet,
      },
      {
        name: "create_foreshadow",
        params: { title: "The seal" },
        writer: mockAgentCreateForeshadow,
      },
      {
        name: "update_foreshadow",
        params: {
          id: "foreshadow-1",
          baseVersion: 0,
          title: "The opened seal",
        },
        writer: mockAgentUpdateForeshadow,
      },
      {
        name: "create_event",
        params: { title: "Arrival" },
        writer: mockAgentCreateEvent,
      },
    ] as const;

    const requestIds = new Set<string>();
    for (const { name, params, writer } of cases) {
      await executeTool(name, "stable-tool-call", params);
      await executeTool(name, "stable-tool-call", params);

      const firstRequestId = writer.mock.calls[0]![0].requestId as string;
      const retryRequestId = writer.mock.calls[1]![0].requestId as string;
      expect(firstRequestId).toMatch(/^agent-tool:[0-9a-f]{64}$/);
      expect(retryRequestId).toBe(firstRequestId);
      requestIds.add(firstRequestId);
    }

    expect(requestIds.size).toBe(cases.length);

    mockProjectId.mockReturnValue("project-2");
    await executeTool("create_codex_entry", "stable-tool-call", {
      type: "character",
      name: "Akane",
    });
    expect(mockAgentCreateCodexEntry.mock.calls[2]![0].requestId).not.toBe(
      mockAgentCreateCodexEntry.mock.calls[0]![0].requestId,
    );

    await executeTool("create_codex_entry", "different-tool-call", {
      type: "character",
      name: "Akane",
    });
    expect(mockAgentCreateCodexEntry.mock.calls[3]![0].requestId).not.toBe(
      mockAgentCreateCodexEntry.mock.calls[0]![0].requestId,
    );
  });

  it("forwards the main-issued entity id through both create tools", async () => {
    mockAgentCreateEvent.mockResolvedValue({
      id: "event-from-main",
      title: "Arrival",
    });
    mockAgentCreateForeshadow.mockResolvedValue({
      id: "foreshadow-from-main",
      title: "The seal",
      secret: true,
    });

    const commonAuthorization = {
      capability: "main-capability",
      chatMessageId: "assistant-1",
      executionId: "execution-1",
      mainOwnedProvenanceId: "provenance-1",
    };
    await executeTool(
      "create_event",
      "event-call",
      { title: "Arrival" },
      { ...commonAuthorization, expectedEntityId: "event-from-main" },
    );
    await executeTool(
      "create_foreshadow",
      "foreshadow-call",
      { title: "The seal" },
      { ...commonAuthorization, expectedEntityId: "foreshadow-from-main" },
    );

    expect(mockAgentCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "event-from-main" }),
      expect.objectContaining({ agentAuthorityCapability: "main-capability" }),
    );
    expect(mockAgentCreateForeshadow).toHaveBeenCalledWith(
      expect.objectContaining({ foreshadowId: "foreshadow-from-main" }),
      expect.objectContaining({ agentAuthorityCapability: "main-capability" }),
    );
  });

  it("propagates the stable tool-call requestId to every Chronicle mutation", async () => {
    invalidateChronicleToolCache();
    mockTreeProjectId.mockReturnValue("project-1");
    mockDbRows.mockReturnValue([
      { id: "event-1", project_id: "project-1", version: 4, secret: 0 },
      { id: "event-a", project_id: "project-1", version: 2, secret: 0 },
      { id: "event-b", project_id: "project-1", version: 3, secret: 0 },
    ]);
    const cases = [
      {
        name: "update_event",
        params: { eventId: "event-1", title: "After" },
        writer: mockAgentUpdateEvent,
        requestIdAt: (call: unknown[]) =>
          (call[1] as { requestId: string }).requestId,
      },
      {
        name: "delete_event",
        params: { eventId: "event-1" },
        writer: mockAgentDeleteEvent,
        requestIdAt: (call: unknown[]) =>
          (call[1] as { requestId: string }).requestId,
      },
      {
        name: "stamp_scene_event",
        params: { sceneId: "scene-1", eventId: "event-1" },
        writer: mockAgentLinkSceneEvent,
        requestIdAt: (call: unknown[]) =>
          (call[2] as { requestId: string }).requestId,
      },
      {
        name: "unstamp_scene_event",
        params: { sceneId: "scene-1", eventId: "event-1" },
        writer: mockAgentUnlinkSceneEvent,
        requestIdAt: (call: unknown[]) =>
          (call[2] as { requestId: string }).requestId,
      },
      {
        name: "set_event_participants",
        params: { eventId: "event-1", codexEntryIds: [] },
        writer: mockAgentSetEventParticipants,
        requestIdAt: (call: unknown[]) =>
          (call[2] as { requestId: string }).requestId,
      },
      {
        name: "add_event_relation",
        params: {
          causeEventId: "event-a",
          effectEventId: "event-b",
        },
        writer: mockAgentAddEventRelation,
        requestIdAt: (call: unknown[]) =>
          (call[2] as { requestId: string }).requestId,
      },
      {
        name: "remove_event_relation",
        params: {
          causeEventId: "event-a",
          effectEventId: "event-b",
        },
        writer: mockAgentRemoveEventRelation,
        requestIdAt: (call: unknown[]) =>
          (call[2] as { requestId: string }).requestId,
      },
    ] as const;

    const requestIds = new Set<string>();
    for (const { name, params, writer, requestIdAt } of cases) {
      const first = await executeTool(name, "stable-chronicle-call", params);
      const retry = await executeTool(name, "stable-chronicle-call", params);
      expect(first.error).toBeUndefined();
      expect(retry.error).toBeUndefined();
      const firstRequestId = requestIdAt(writer.mock.calls[0] as unknown[]);
      const retryRequestId = requestIdAt(writer.mock.calls[1] as unknown[]);
      expect(firstRequestId).toMatch(/^agent-tool:[0-9a-f]{64}$/);
      expect(retryRequestId).toBe(firstRequestId);
      requestIds.add(firstRequestId);
    }
    expect(requestIds.size).toBe(cases.length);
  });

  it("rejects a create when Project authority changes during request hashing", async () => {
    let releaseDigest!: () => void;
    const digestGate = new Promise<void>((resolve) => {
      releaseDigest = resolve;
    });
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementation(async () => {
        await digestGate;
        return new Uint8Array(32).buffer;
      });
    mockAgentCreateCodexEntry.mockResolvedValue({
      id: "codex-stale",
      name: "Stale",
      type: "character",
    });

    try {
      const pending = executeTool("create_codex_entry", "stale-call", {
        type: "character",
        name: "Stale",
      });
      await vi.waitFor(() => expect(digest).toHaveBeenCalledOnce());
      mockProjectId.mockReturnValue("project-2");
      releaseDigest();

      const result = await pending;
      expect(result.error).toContain("authority changed");
      expect(mockAgentCreateCodexEntry).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
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
    mockInvoke.mockResolvedValue([{ sourceType: "scene", id: "s1" }]);
    mockDbRows.mockReturnValue([
      { id: "s1", title: "T", content: pmDoc("ドラゴンが火を吹いた。") },
    ]);
    const res = await executeTool("search_scenes", "c", { query: "ドラゴン" });
    const [row] = res.content as Array<{ excerpt: string }>;
    expect(row.excerpt).toBe("ドラゴンが火を吹いた。");
    expect(row.excerpt).not.toContain('"type"');
  });

  it("search_scenes (LIKE fallback) also plain-texts the excerpt", async () => {
    mockDbRows.mockReturnValue([
      { id: "s1", title: "T", content: pmDoc("火を吹いた。") },
    ]);
    const res = await executeTool("search_scenes", "c", { query: "火" });
    const [row] = res.content as Array<{ excerpt: string }>;
    expect(row.excerpt).toBe("火を吹いた。");
  });

  it("search_scenes centers the excerpt around the first matched token", async () => {
    const long = "あ".repeat(300) + "ドラゴン" + "い".repeat(300);
    mockInvoke.mockResolvedValue([{ sourceType: "scene", id: "s1" }]);
    mockDbRows.mockReturnValue([
      { id: "s1", title: "T", content: pmDoc(long) },
    ]);
    const res = await executeTool("search_scenes", "c", { query: "ドラゴン" });
    const [row] = res.content as Array<{ excerpt: string }>;
    expect(row.excerpt).toContain("ドラゴン");
    expect(row.excerpt.startsWith("...")).toBe(true);
    expect(row.excerpt.endsWith("...")).toBe(true);
    expect(row.excerpt.length).toBeLessThanOrEqual(206);
  });

  it("search_scenes tolerates NULL content", async () => {
    mockInvoke.mockResolvedValue([{ sourceType: "scene", id: "s1" }]);
    mockDbRows.mockReturnValue([{ id: "s1", title: "T", content: null }]);
    const res = await executeTool("search_scenes", "c", { query: "ドラゴン" });
    const [row] = res.content as Array<{ excerpt: string }>;
    expect(row.excerpt).toBe("");
  });

  it("search_snippets returns tag names (string[]) and a plain-text preview", async () => {
    mockInvoke.mockResolvedValue([{ sourceType: "snippet", id: "n1" }]);
    mockDbRows.mockReturnValue([
      {
        id: "n1",
        title: "雨",
        tagsCache: JSON.stringify([
          { name: "伏線", color: "#fff" },
          { name: "終盤", color: null },
        ]),
        content: pmDoc("雨の描写。"),
      },
    ]);
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
// agent の read ツールはアクティブプロジェクトに限定されなければならない。
// FTS は typed command の projectId を assert し、全 read ツールは projectId
// 未設定時に fail-closed (DBを引かず "No active project") を守る。
describe("project scoping — agent read tools (XPROJ-1)", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockTreeProjectId.mockReset();
  });

  const PROJECT_SCOPED_TOOLS = [
    { tool: "search_codex", params: { query: "ドラゴン" } },
    { tool: "search_scenes", params: { query: "ドラゴン" } },
    { tool: "search_snippets", params: { query: "ドラゴン" } },
    { tool: "search_codex_by_tags", params: { tags: ["世界観"] } },
    { tool: "list_codex_tags", params: {} },
  ];

  it.each(PROJECT_SCOPED_TOOLS)(
    "$tool uses typed FTS/Drizzle without the generic DB bridge",
    async ({ tool, params }) => {
      mockTreeProjectId.mockReturnValue("proj-A");
      mockInvoke.mockResolvedValue([]);

      const res = await executeTool(tool, "c", params);
      expect(res.error).toBeUndefined();

      expect(
        mockInvoke.mock.calls.some((call) => call[0] === "db_execute"),
      ).toBe(false);
      for (const [, args] of mockInvoke.mock.calls.filter(
        (call) => call[0] === "fts_search",
      )) {
        expect(args).toMatchObject({ projectId: "proj-A" });
      }
    },
  );

  const ALL_READ_TOOLS = [
    ...PROJECT_SCOPED_TOOLS,
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
      mockInvoke.mockResolvedValue([]);

      const res = await executeTool(tool, "c", params);
      expect(res.error).toBeUndefined();
      expect(res.summary).toContain("No active project");
      expect(mockInvoke).not.toHaveBeenCalled();
      expect(mockDbRows).not.toHaveBeenCalled();
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
    // どの select にも同じ行が返る。core の判定（entries の select）が読む contextMode を持たせ、
    // dense の hit（e-dense）も DB に在る行にする（DB に無い id は hidden に数えて落ちる）。
    mockDbRows.mockReturnValue([
      {
        id: "e-sparse",
        name: "SparseHit",
        type: "location",
        summary: "s",
        contextMode: "mentioned",
      },
      {
        id: "e-dense",
        name: "DenseHit",
        type: "character",
        summary: "d",
        contextMode: "mentioned",
      },
    ]);
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
      if (cmd === "fts_search") {
        return Promise.resolve([{ sourceType: "codex", id: "e-sparse" }]);
      }
      return Promise.resolve([]);
    });

    const res = await executeTool("search_codex", "c", {
      query: "ドラクタール",
    });
    expect(res.error).toBeUndefined();
    const ids = (res.content as { id: string }[]).map((r) => r.id);
    expect(ids).toContain("e-dense");
    expect(ids).toContain("e-sparse");
    expect(mockInvoke).toHaveBeenCalledWith("codex_semantic_search", {
      expectedWorkspacePath: TOOL_TEST_WORKSPACE_PATH,
      projectId: "proj-A",
      query: "ドラクタール",
      limit: 30,
    });
  });

  it("falls back to sparse-only when dense search rejects", async () => {
    // どの select にも同じ行が返る。core の判定（entries の select）が読む contextMode を持たせ、
    // dense の hit（e-dense）も DB に在る行にする（DB に無い id は hidden に数えて落ちる）。
    mockDbRows.mockReturnValue([
      {
        id: "e-sparse",
        name: "SparseHit",
        type: "location",
        summary: "s",
        contextMode: "mentioned",
      },
      {
        id: "e-dense",
        name: "DenseHit",
        type: "character",
        summary: "d",
        contextMode: "mentioned",
      },
    ]);
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "codex_semantic_search") {
        return Promise.reject(new Error("semantic-embedding disabled"));
      }
      if (cmd === "fts_search") {
        return Promise.resolve([{ sourceType: "codex", id: "e-sparse" }]);
      }
      return Promise.resolve([]);
    });

    const res = await executeTool("search_codex", "c", {
      query: "ドラクタール",
    });
    expect(res.error).toBeUndefined();
    const ids = (res.content as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(["e-sparse"]);
  });
});

describe("executeTool — propose_setting_change の dispatch", () => {
  beforeEach(() => {
    mockProposeSettingChange.mockReset();
    mockProjectId.mockReset();
  });

  it("DB を書く mutation ではないので request id・project authority を作らず、検証済みの提案を結果に載せる", async () => {
    const proposal = { id: "p1", key: "editor.fontSize", value: "20" };
    mockProposeSettingChange.mockResolvedValue({
      name: "propose_setting_change",
      content: { status: "proposed" },
      summary: "Proposed",
      tokensUsed: 3,
      settingProposal: proposal,
    });
    const params = { key: "editor.fontSize", value: "20" };
    const result = await executeTool(
      "propose_setting_change",
      "call-p",
      params,
    );
    expect(mockProposeSettingChange).toHaveBeenCalledWith(params);
    expect(mockProjectId).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      toolCallId: "call-p",
      name: "propose_setting_change",
      settingProposal: proposal,
    });
    expect(result.error).toBeUndefined();
  });

  it("executor が投げたら error の結果になり、提案は載らない", async () => {
    mockProposeSettingChange.mockRejectedValue(new Error("boom"));
    const result = await executeTool("propose_setting_change", "call-q", {});
    expect(result.error).toBe("boom");
    expect(result.settingProposal).toBeUndefined();
  });
});
