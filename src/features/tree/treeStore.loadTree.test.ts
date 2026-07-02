// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListNodes = vi.fn();
const mockListNoteContents = vi.fn();

vi.mock("./api", () => ({
  listNodes: (...args: unknown[]) => mockListNodes(...args),
  listNoteContents: (...args: unknown[]) => mockListNoteContents(...args),
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p1",
}));

vi.mock("@/features/settings/api", () => ({
  getProjectSetting: vi.fn(),
}));

vi.mock("@/features/attribution/api", () => ({
  loadBatchAiRatio: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: {
    getState: () => ({
      recomputeSceneOrder: vi.fn(),
    }),
  },
}));

import { useTreeStore } from "./treeStore";

// listNodes は H4 projection で content / unplacedBeatsDoc を返さない
// (TreeNodeLite 相当の行)。note 本文は listNoteContents の別クエリで来る。
function sceneNode(id: string, sortOrder: string) {
  return {
    id,
    projectId: "p1",
    parentId: null,
    nodeType: "scene" as const,
    title: id,
    synopsis: null,
    sortOrder,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    status: "outline",
    charCount: 0,
    unplacedBeatPreview: null,
    placedBeatPreview: null,
    sourceUri: null,
    sourceMtime: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("loadTree activeSceneId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListNoteContents.mockResolvedValue(new Map<string, string>());
    useTreeStore.setState({
      activeSceneId: "scene-b",
      nodes: [],
      scenes: [],
      isLoading: false,
    });
  });

  it("preserves activeSceneId when the active node still exists after reload", async () => {
    mockListNodes.mockResolvedValue([
      sceneNode("scene-a", "a0"),
      sceneNode("scene-b", "a1"),
    ]);

    await useTreeStore.getState().loadTree("p1");

    expect(useTreeStore.getState().activeSceneId).toBe("scene-b");
  });

  it("keeps scene bodies out of store but loads note content", async () => {
    mockListNodes.mockResolvedValue([
      sceneNode("scene-a", "a0"),
      {
        ...sceneNode("note-a", "a1"),
        nodeType: "note" as const,
        title: "Note",
        contextMode: "mentioned",
        aliases: "[]",
        excludedAliases: "[]",
      },
    ]);
    // note 本文は 2 段目クエリ (listNoteContents) から来る。scene id が
    // 混入しても nodeType ゲートで store には載らないこと (不変条件) も見る。
    mockListNoteContents.mockResolvedValue(
      new Map([
        [
          "note-a",
          '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"note body"}]}]}',
        ],
        [
          "scene-a",
          '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"scene body"}]}]}',
        ],
      ]),
    );

    await useTreeStore.getState().loadTree("p1");

    expect(mockListNoteContents).toHaveBeenCalledWith("p1");
    const scene = useTreeStore.getState().nodes.find((n) => n.id === "scene-a");
    const note = useTreeStore.getState().nodes.find((n) => n.id === "note-a");
    expect(scene?.content).toBeUndefined();
    expect(note?.content).toContain("note body");
  });

  it("falls back to the first scene when the previous active node is gone", async () => {
    mockListNodes.mockResolvedValue([sceneNode("scene-a", "a0")]);

    await useTreeStore.getState().loadTree("p1");

    expect(useTreeStore.getState().activeSceneId).toBe("scene-a");
  });
});
