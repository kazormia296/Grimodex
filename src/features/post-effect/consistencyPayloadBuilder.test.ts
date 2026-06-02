// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks (必ず vi.hoisted で参照を確保してから vi.mock)
// ---------------------------------------------------------------------------

const { mockGetState, mockDb, mockComputeInputHash } = vi.hoisted(() => ({
  mockGetState: vi.fn(),
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
  listPhasesByEntryIds: vi.fn().mockResolvedValue([]),
  listDetailOverridesByPhaseIds: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/features/codex/phaseResolver", () => ({
  resolveCodexState: vi.fn().mockReturnValue({
    summary: null,
    content: "{}",
    contextMode: "always",
    detailValues: new Map(),
  }),
}));

vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: {
    getState: vi.fn().mockReturnValue({ globalSceneOrder: [] }),
  },
}));

vi.mock("@/features/codex/prosemirrorTextExtractor", () => ({
  extractPlainText: vi.fn().mockReturnValue(""),
}));

vi.mock("@/lib/prosemirror", () => ({
  prosemirrorToText: vi.fn().mockReturnValue(""),
}));

vi.mock("@/features/codex/rustMatcher", () => ({
  findMentionedEntriesAsync: vi.fn().mockResolvedValue([]),
}));

vi.mock("./canonicalize", () => ({
  computeInputHash: mockComputeInputHash,
  normalizeText: (s: string) => s.trim(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  getSceneIdsForScope,
  buildMultiPayload,
  CONSISTENCY_PROMPT_VERSION,
  INTRA_CONSISTENCY_PROMPT_VERSION,
} from "./consistencyPayloadBuilder";
import { REVIEW_PROMPT_VERSION } from "./reviewPayloadBuilder";
import { META_STRUCTURE_PROMPT_VERSION } from "./metaStructurePayloadBuilder";
import type { TreeNodeData } from "@/features/tree/treeStore";

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

    // db.select チェーンのモック (getScenePlainText 内)
    const chainMock = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mockDb.select.mockReturnValue(chainMock);
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
