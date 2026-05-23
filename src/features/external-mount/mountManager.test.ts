import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/features/tree/api";

const { mockUpdateNode, mockListAllNodes } = vi.hoisted(() => ({
  mockUpdateNode: vi.fn().mockResolvedValue(undefined),
  mockListAllNodes: vi.fn(),
}));

vi.mock("@/features/tree/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/tree/api")>();
  return {
    ...actual,
    updateNode: mockUpdateNode,
    listAllNodes: mockListAllNodes,
  };
});

import { buildDbByUriMap } from "./mountManager";

function node(
  overrides: Partial<TreeNode> & Pick<TreeNode, "id" | "sourceUri">,
): TreeNode {
  return {
    projectId: "p1",
    parentId: null,
    nodeType: "scene",
    title: "Scene",
    synopsis: null,
    sortOrder: "a0",
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
    ...overrides,
  };
}

describe("buildDbByUriMap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("archives duplicate active nodes that share the same sourceUri", async () => {
    const uri = "external-root://root-1/chapter/01.md";
    const map = await buildDbByUriMap(
      [
        node({
          id: "keep",
          sourceUri: uri,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
        node({
          id: "dup",
          sourceUri: uri,
          createdAt: "2026-01-02T00:00:00.000Z",
        }),
      ],
      "external-root://root-1/",
      "external-root://root-1/.mount",
    );

    expect(map.size).toBe(1);
    expect(map.get(uri)?.id).toBe("keep");
    expect(mockUpdateNode).toHaveBeenCalledTimes(1);
    expect(mockUpdateNode).toHaveBeenCalledWith(
      "dup",
      expect.objectContaining({ archivedAt: expect.any(String) }),
    );
  });
});
