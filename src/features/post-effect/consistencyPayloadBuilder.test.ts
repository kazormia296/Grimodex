// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks (必ず vi.hoisted で参照を確保してから vi.mock)
// ---------------------------------------------------------------------------

const {
  mockGetState,
  mockPhaseGetState,
  mockResolveCodexState,
  mockListPhases,
  mockListOverrides,
  mockFindMentioned,
  mockExtractPlainText,
  mockDb,
  mockComputeInputHash,
} = vi.hoisted(() => ({
  mockGetState: vi.fn(),
  mockPhaseGetState: vi.fn(),
  mockResolveCodexState: vi.fn(),
  mockListPhases: vi.fn(),
  mockListOverrides: vi.fn(),
  mockFindMentioned: vi.fn(),
  mockExtractPlainText: vi.fn(),
  mockDb: {
    select: vi.fn(),
  },
  mockComputeInputHash: vi.fn(),
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: mockGetState },
}));

vi.mock("@/db/client", () => ({
  db: mockDb,
}));

vi.mock("@/db/schema", () => ({
  treeNodes: {},
  codexEntries: {},
  codexDetailValues: {},
  codexDetailDefinitions: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_a: unknown, _b: unknown) => ({})),
  and: vi.fn((...args: unknown[]) => args),
  inArray: vi.fn((_a: unknown, _b: unknown) => ({})),
}));

vi.mock("@/features/codex/phaseApi", () => ({
  listPhasesByEntryIds: mockListPhases,
  listDetailOverridesByPhaseIds: mockListOverrides,
}));

vi.mock("@/features/codex/phaseResolver", () => ({
  resolveCodexState: mockResolveCodexState,
}));

vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: {
    getState: mockPhaseGetState,
  },
}));

vi.mock("@/features/codex/prosemirrorTextExtractor", () => ({
  extractPlainText: mockExtractPlainText,
}));

vi.mock("@/lib/prosemirror", () => ({
  prosemirrorToText: vi.fn().mockReturnValue(""),
}));

vi.mock("@/features/codex/rustMatcher", () => ({
  findMentionedEntriesAsync: mockFindMentioned,
}));

vi.mock("./canonicalize", () => ({
  computeInputHash: mockComputeInputHash,
  normalizeText: (s: string) => s.trim(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  buildConsistencyPayload,
  getSceneIdsForScope,
  buildMultiPayload,
  CONSISTENCY_PROMPT_VERSION,
  INTRA_CONSISTENCY_PROMPT_VERSION,
} from "./consistencyPayloadBuilder";
import { REVIEW_PROMPT_VERSION } from "./reviewPayloadBuilder";
import { META_STRUCTURE_PROMPT_VERSION } from "./metaStructurePayloadBuilder";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { buildSceneTimeIndex } from "@/features/codex/context/sceneTimeIndex";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(
  id: string,
  nodeType: "scene" | "folder" | "note",
  parentId: string | null = null,
): TreeNodeData {
  return {
    id,
    projectId: "proj-1",
    parentId,
    nodeType,
    title: id,
    synopsis: null,

    intent: null,
    sortOrder: id,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
}

function mockConsistencyDb(
  entry: {
    id: string;
    projectId: string;
    type: string;
    name: string;
    summary: string | null;
    content: string;
    contextMode: string;
  },
  details: Array<{
    entryId: string;
    definitionId: string;
    value: string | null;
    name: string;
  }> = [],
  sceneContent = "{}",
): void {
  const sceneChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([{ content: sceneContent }]),
  };
  const entriesChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([entry]),
  };
  const detailsChain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(details),
  };
  mockDb.select
    .mockReturnValueOnce(sceneChain)
    .mockReturnValueOnce(entriesChain)
    .mockReturnValueOnce(detailsChain);
}

// ---------------------------------------------------------------------------
// getSceneIdsForScope
// ---------------------------------------------------------------------------

describe("getSceneIdsForScope", () => {
  const nodes: TreeNodeData[] = [
    makeNode("folder-1", "folder", null),
    makeNode("scene-A", "scene", "folder-1"),
    makeNode("scene-B", "scene", "folder-1"),
    makeNode("folder-2", "folder", null),
    makeNode("scene-C", "scene", "folder-2"),
    makeNode("scene-root", "scene", null),
    makeNode("note-1", "note", "folder-1"),
  ];

  describe("project scope", () => {
    it("全シーンを返す（note/folder 除外）", () => {
      const ids = getSceneIdsForScope(nodes, "project", null);
      expect(ids).toContain("scene-A");
      expect(ids).toContain("scene-B");
      expect(ids).toContain("scene-C");
      expect(ids).toContain("scene-root");
      expect(ids).not.toContain("note-1");
      expect(ids).not.toContain("folder-1");
    });

    it("scope_target_id が渡されても無視する（project は全件）", () => {
      const ids = getSceneIdsForScope(nodes, "project", "folder-1");
      expect(ids).toContain("scene-C");
      expect(ids).toContain("scene-root");
    });
  });

  describe("folder scope", () => {
    it("指定フォルダ直下のシーンのみ返す", () => {
      const ids = getSceneIdsForScope(nodes, "folder", "folder-1");
      expect(ids).toContain("scene-A");
      expect(ids).toContain("scene-B");
      expect(ids).not.toContain("scene-C");
      expect(ids).not.toContain("scene-root");
    });

    it("ネストしたフォルダ内のシーンも再帰的に返す", () => {
      const nested: TreeNodeData[] = [
        makeNode("outer", "folder", null),
        makeNode("inner", "folder", "outer"),
        makeNode("scene-deep", "scene", "inner"),
        makeNode("scene-shallow", "scene", "outer"),
      ];
      const ids = getSceneIdsForScope(nested, "folder", "outer");
      expect(ids).toContain("scene-deep");
      expect(ids).toContain("scene-shallow");
    });

    it("scope_target_id が null の場合は空配列", () => {
      const ids = getSceneIdsForScope(nodes, "folder", null);
      expect(ids).toEqual([]);
    });

    it("存在しないフォルダ ID は空配列", () => {
      const ids = getSceneIdsForScope(nodes, "folder", "no-such-folder");
      expect(ids).toEqual([]);
    });

    it("フォルダ内に note のみ存在する場合は空配列", () => {
      const noScenes: TreeNodeData[] = [
        makeNode("folder-empty", "folder", null),
        makeNode("note-only", "note", "folder-empty"),
      ];
      const ids = getSceneIdsForScope(noScenes, "folder", "folder-empty");
      expect(ids).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// buildMultiPayload
// ---------------------------------------------------------------------------

describe("buildMultiPayload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComputeInputHash.mockResolvedValue("hash-abc");
    mockListPhases.mockResolvedValue([]);
    mockListOverrides.mockResolvedValue([]);
    mockFindMentioned.mockResolvedValue([]);
    mockExtractPlainText.mockImplementation((value: string) => value);
    mockPhaseGetState.mockReturnValue({
      sceneTimeIndex: buildSceneTimeIndex([]),
      resolutionMode: "reading",
    });
    mockResolveCodexState.mockReturnValue({
      summary: null,
      content: "{}",
      contextMode: "always",
      detailValues: new Map(),
    });

    // db.select チェーンのモック (getScenePlainText 内)
    const chainMock = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mockDb.select.mockReturnValue(chainMock);
  });

  it("consistency は対象 scene の TemporalAnchor と store の index/mode で Phase 解決する", async () => {
    const sceneTimeIndex = buildSceneTimeIndex([makeNode("scene-1", "scene")]);
    mockPhaseGetState.mockReturnValue({
      sceneTimeIndex,
      resolutionMode: "auto",
    });

    const sceneChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ content: "{}" }]),
    };
    const entriesChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          id: "entry-1",
          projectId: "proj-1",
          type: "character",
          name: "アリス",
          summary: "主人公",
          content: "{}",
          contextMode: "always",
        },
      ]),
    };
    const detailsChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mockDb.select
      .mockReturnValueOnce(sceneChain)
      .mockReturnValueOnce(entriesChain)
      .mockReturnValueOnce(detailsChain);

    await buildConsistencyPayload("proj-1", "scene-1", "gpt-4o-mini");

    expect(mockResolveCodexState).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "主人公" }),
      [],
      expect.any(Map),
      expect.any(Map),
      { kind: "scene", sceneId: "scene-1" },
      sceneTimeIndex,
      "auto",
    );
  });

  it.each(["hidden", "suppress"])(
    "consistency excludes a Base-mentioned entry after Phase %s resolution",
    async (contextMode) => {
      mockResolveCodexState.mockReturnValue({
        summary: "Phase secret",
        content: "Phase secret body",
        contextMode,
        detailValues: new Map(),
        appliedPhaseIds: ["phase-1"],
        activePhaseId: "phase-1",
        activePhaseLabel: "Current",
        axisUsed: "reading",
        fallbackReason: null,
      });
      mockFindMentioned.mockImplementation(async (_text, entries) => entries);
      mockConsistencyDb({
        id: "entry-1",
        projectId: "proj-1",
        type: "character",
        name: "Alice",
        summary: "Base summary",
        content: "Base body",
        contextMode: "mentioned",
      });

      const result = await buildConsistencyPayload(
        "proj-1",
        "scene-1",
        "gpt-4o-mini",
      );

      expect(mockFindMentioned).toHaveBeenCalledWith("", []);
      expect(result.codexPayload).toEqual([]);
      expect(result.codexPayloadJson).not.toContain("Phase secret");
    },
  );

  it.each(["mentioned", "always"])(
    "consistency selects a Base-hidden entry after Phase %s resolution",
    async (contextMode) => {
      mockResolveCodexState.mockReturnValue({
        summary: "Phase summary",
        content: "Phase body",
        contextMode,
        detailValues: new Map(),
        appliedPhaseIds: ["phase-1"],
        activePhaseId: "phase-1",
        activePhaseLabel: "Current",
        axisUsed: "reading",
        fallbackReason: null,
      });
      mockFindMentioned.mockImplementation(async (_text, entries) =>
        contextMode === "mentioned" ? entries : [],
      );
      mockConsistencyDb({
        id: "entry-1",
        projectId: "proj-1",
        type: "character",
        name: "Alice",
        summary: "Base summary",
        content: "Base body",
        contextMode: "hidden",
      });

      const result = await buildConsistencyPayload(
        "proj-1",
        "scene-1",
        "gpt-4o-mini",
      );

      expect(result.codexPayload).toEqual([
        expect.objectContaining({
          id: "entry-1",
          summary: "Phase summary",
          content_plain: "Phase body",
        }),
      ]);
    },
  );

  it("includes a mentioned Codex entry selected only by a semantic link", async () => {
    mockResolveCodexState.mockReturnValue({
      summary: "Phase summary",
      content: "Phase body",
      contextMode: "mentioned",
      detailValues: new Map(),
    });
    mockFindMentioned.mockResolvedValue([]);
    const sceneContent = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "彼女",
              marks: [
                {
                  type: "codexSemanticLink",
                  attrs: { entryId: "entry-1", label: "Alice" },
                },
              ],
            },
          ],
        },
      ],
    });
    mockConsistencyDb(
      {
        id: "entry-1",
        projectId: "proj-1",
        type: "character",
        name: "Alice",
        summary: "Base summary",
        content: "Base body",
        contextMode: "mentioned",
      },
      [],
      sceneContent,
    );

    const result = await buildConsistencyPayload(
      "proj-1",
      "scene-1",
      "gpt-4o-mini",
    );

    expect(mockFindMentioned).toHaveBeenCalledWith("", [
      expect.objectContaining({ id: "entry-1" }),
    ]);
    expect(result.codexPayload).toEqual([
      expect.objectContaining({ id: "entry-1", name: "Alice" }),
    ]);
  });

  it.each(["hidden", "suppress"])(
    "does not let a semantic link bypass resolved %s policy",
    async (contextMode) => {
      mockResolveCodexState.mockReturnValue({
        summary: "Secret",
        content: "Secret body",
        contextMode,
        detailValues: new Map(),
      });
      const sceneContent = JSON.stringify({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "彼女",
                marks: [
                  {
                    type: "codexSemanticLink",
                    attrs: { entryId: "entry-1", label: "Alice" },
                  },
                ],
              },
            ],
          },
        ],
      });
      mockConsistencyDb(
        {
          id: "entry-1",
          projectId: "proj-1",
          type: "character",
          name: "Alice",
          summary: "Base summary",
          content: "Base body",
          contextMode: "mentioned",
        },
        [],
        sceneContent,
      );

      const result = await buildConsistencyPayload(
        "proj-1",
        "scene-1",
        "gpt-4o-mini",
      );

      expect(result.codexPayload).toEqual([]);
      expect(result.codexPayloadJson).not.toContain("Secret");
    },
  );

  it("keeps an explicit null Phase detail clear omitted instead of restoring Base", async () => {
    mockResolveCodexState.mockReturnValue({
      summary: "Phase summary",
      content: "Phase body",
      contextMode: "always",
      detailValues: new Map([["detail-1", null]]),
      appliedPhaseIds: ["phase-1"],
      activePhaseId: "phase-1",
      activePhaseLabel: "Current",
      axisUsed: "reading",
      fallbackReason: null,
    });
    mockConsistencyDb(
      {
        id: "entry-1",
        projectId: "proj-1",
        type: "character",
        name: "Alice",
        summary: "Base summary",
        content: "Base body",
        contextMode: "always",
      },
      [
        {
          entryId: "entry-1",
          definitionId: "detail-1",
          value: "Base detail",
          name: "Role",
        },
      ],
    );

    const result = await buildConsistencyPayload(
      "proj-1",
      "scene-1",
      "gpt-4o-mini",
    );

    expect(result.codexPayload[0]?.detail_values).toEqual([]);
    expect(result.codexPayloadJson).not.toContain("Base detail");
  });

  it("uses definition metadata for a Phase-only context detail without a Base value row", async () => {
    mockResolveCodexState.mockReturnValue({
      summary: "Phase summary",
      content: "Phase body",
      contextMode: "always",
      detailValues: new Map([["detail-phase-only", "Phase role"]]),
      appliedPhaseIds: ["phase-1"],
      activePhaseId: "phase-1",
      activePhaseLabel: "Current",
      axisUsed: "reading",
      fallbackReason: null,
    });
    const sceneChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ content: "{}" }]),
    };
    const entriesChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          id: "entry-1",
          projectId: "proj-1",
          type: "character",
          name: "Alice",
          summary: "Base summary",
          content: "Base body",
          contextMode: "always",
        },
      ]),
    };
    const detailsChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          entryId: "entry-1",
          definitionId: "detail-phase-only",
          value: null,
          name: "Role",
        },
      ]),
    };
    mockDb.select
      .mockReturnValueOnce(sceneChain)
      .mockReturnValueOnce(entriesChain)
      .mockReturnValueOnce(detailsChain);

    const result = await buildConsistencyPayload(
      "proj-1",
      "scene-1",
      "gpt-4o-mini",
    );

    expect(detailsChain.leftJoin).toHaveBeenCalledTimes(1);
    expect(result.codexPayload[0]?.detail_values).toEqual([
      { name: "Role", value: "Phase role" },
    ]);
    expect(result.codexPayloadJson).not.toContain("detail-phase-only");
  });

  it("ノードがゼロのとき scenes は空配列", async () => {
    mockGetState.mockReturnValue({ nodes: [] });

    const result = await buildMultiPayload(
      "proj-1",
      "project",
      null,
      "gpt-4o-mini",
      "intra_scene_consistency",
    );
    expect(result.scenes).toEqual([]);
  });

  it("project scope で全シーンのエントリを生成する", async () => {
    const nodes: TreeNodeData[] = [
      makeNode("s1", "scene", null),
      makeNode("s2", "scene", null),
      makeNode("folder", "folder", null),
    ];
    mockGetState.mockReturnValue({ nodes });
    mockComputeInputHash.mockResolvedValue("hash-multi");

    const result = await buildMultiPayload(
      "proj-1",
      "project",
      null,
      "gpt-4o-mini",
      "intra_scene_consistency",
    );
    expect(result.scenes).toHaveLength(2);
    const ids = result.scenes.map((s) => s.scene_id);
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
  });

  it("multi consistency は各 payload をその scene anchor で解決する", async () => {
    const nodes = [makeNode("s1", "scene"), makeNode("s2", "scene")];
    mockGetState.mockReturnValue({ nodes });
    const sceneTimeIndex = buildSceneTimeIndex(nodes);
    mockPhaseGetState.mockReturnValue({
      sceneTimeIndex,
      resolutionMode: "story",
    });

    const sceneChain = () => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ content: "{}" }]),
    });
    const entriesChain = () => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          id: "entry-1",
          projectId: "proj-1",
          type: "character",
          name: "アリス",
          summary: "主人公",
          content: "{}",
          contextMode: "always",
        },
      ]),
    });
    const detailsChain = () => ({
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    });
    mockDb.select
      .mockReturnValueOnce(sceneChain())
      .mockReturnValueOnce(entriesChain())
      .mockReturnValueOnce(detailsChain())
      .mockReturnValueOnce(sceneChain())
      .mockReturnValueOnce(entriesChain())
      .mockReturnValueOnce(detailsChain());

    await buildMultiPayload(
      "proj-1",
      "project",
      null,
      "gpt-4o-mini",
      "consistency",
    );

    expect(mockResolveCodexState.mock.calls.map((call) => call[4])).toEqual([
      { kind: "scene", sceneId: "s1" },
      { kind: "scene", sceneId: "s2" },
    ]);
    expect(mockResolveCodexState.mock.calls[0]?.slice(5)).toEqual([
      sceneTimeIndex,
      "story",
    ]);
    expect(mockResolveCodexState.mock.calls[1]?.slice(5)).toEqual([
      sceneTimeIndex,
      "story",
    ]);
  });

  it("intra_scene_consistency では codex_payload_json が '[]'", async () => {
    mockGetState.mockReturnValue({
      nodes: [makeNode("s1", "scene", null)],
    });
    mockComputeInputHash.mockResolvedValue("hash-x");

    const result = await buildMultiPayload(
      "proj-1",
      "project",
      null,
      "gpt-4o-mini",
      "intra_scene_consistency",
    );
    expect(result.scenes[0].codex_payload_json).toBe("[]");
  });

  it("inputHash が scope 毎に異なる値を使う (scope 文字列が異なる)", async () => {
    const nodes: TreeNodeData[] = [makeNode("s1", "scene", null)];
    mockGetState.mockReturnValue({ nodes });
    mockComputeInputHash
      .mockResolvedValueOnce("hash-project")
      .mockResolvedValueOnce("hash-folder");

    const r1 = await buildMultiPayload(
      "proj-1",
      "project",
      null,
      "gpt-4o-mini",
      "intra_scene_consistency",
    );
    const r2 = await buildMultiPayload(
      "proj-1",
      "folder",
      "folder-1",
      "gpt-4o-mini",
      "intra_scene_consistency",
    );

    // computeInputHash に渡した scope 引数が異なることを確認
    const call1 = mockComputeInputHash.mock.calls[0][0] as { scope: string };
    const call2 = mockComputeInputHash.mock.calls[1][0] as { scope: string };
    expect(call1.scope).toBe("project:all");
    expect(call2.scope).toBe("folder:folder-1");
    expect(r1.inputHash).not.toBe(r2.inputHash);
  });

  it("consistency では promptVersion に CONSISTENCY_PROMPT_VERSION を使う", async () => {
    mockGetState.mockReturnValue({
      nodes: [makeNode("s1", "scene", null)],
    });
    mockComputeInputHash.mockResolvedValue("hash-c");

    await buildMultiPayload(
      "proj-1",
      "project",
      null,
      "gpt-4o-mini",
      "consistency",
    );

    const call = mockComputeInputHash.mock.calls[0][0] as {
      promptVersion: string;
    };
    expect(CONSISTENCY_PROMPT_VERSION).toBe("consistency_v1.4");
    expect(call.promptVersion).toBe(CONSISTENCY_PROMPT_VERSION);
  });

  it("intra_scene_consistency では promptVersion に INTRA_CONSISTENCY_PROMPT_VERSION を使う", async () => {
    mockGetState.mockReturnValue({
      nodes: [makeNode("s1", "scene", null)],
    });
    mockComputeInputHash.mockResolvedValue("hash-i");

    await buildMultiPayload(
      "proj-1",
      "project",
      null,
      "gpt-4o-mini",
      "intra_scene_consistency",
    );

    const call = mockComputeInputHash.mock.calls[0][0] as {
      promptVersion: string;
    };
    expect(call.promptVersion).toBe(INTRA_CONSISTENCY_PROMPT_VERSION);
  });

  it("review では promptVersion に REVIEW_PROMPT_VERSION を使う", async () => {
    mockGetState.mockReturnValue({
      nodes: [makeNode("s1", "scene", null)],
    });
    mockComputeInputHash.mockResolvedValue("hash-r");

    await buildMultiPayload("proj-1", "project", null, "gpt-4o-mini", "review");

    const call = mockComputeInputHash.mock.calls[0][0] as {
      promptVersion: string;
    };
    expect(call.promptVersion).toBe(REVIEW_PROMPT_VERSION);
  });

  it("meta_structure では promptVersion に META_STRUCTURE_PROMPT_VERSION を使う", async () => {
    mockGetState.mockReturnValue({
      nodes: [makeNode("s1", "scene", null)],
    });
    mockComputeInputHash.mockResolvedValue("hash-m");

    await buildMultiPayload(
      "proj-1",
      "project",
      null,
      "gpt-4o-mini",
      "meta_structure",
    );

    const call = mockComputeInputHash.mock.calls[0][0] as {
      promptVersion: string;
    };
    expect(call.promptVersion).toBe(META_STRUCTURE_PROMPT_VERSION);
  });
});
