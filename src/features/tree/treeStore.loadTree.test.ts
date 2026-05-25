// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListNodes = vi.fn();

vi.mock("./api", () => ({
  listNodes: (...args: unknown[]) => mockListNodes(...args),
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
    content: "{}",
    unplacedBeatsDoc: "[]",
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

  it("falls back to the first scene when the previous active node is gone", async () => {
    mockListNodes.mockResolvedValue([sceneNode("scene-a", "a0")]);

    await useTreeStore.getState().loadTree("p1");

    expect(useTreeStore.getState().activeSceneId).toBe("scene-a");
  });
});
