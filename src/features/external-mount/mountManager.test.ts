// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/features/tree/api";

const {
  mockUpdateNode,
  mockListAllNodes,
  mockSaveSceneContent,
  mockLoadTree,
  mockSetCharCount,
} = vi.hoisted(() => ({
  mockUpdateNode: vi.fn().mockResolvedValue(undefined),
  mockListAllNodes: vi.fn(),
  mockSaveSceneContent: vi.fn().mockResolvedValue({ placedBeatPreview: null }),
  mockLoadTree: vi.fn().mockResolvedValue(undefined),
  mockSetCharCount: vi.fn(),
}));

vi.mock("@/features/tree/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/tree/api")>();
  return {
    ...actual,
    updateNode: mockUpdateNode,
    listAllNodes: mockListAllNodes,
    saveSceneContent: mockSaveSceneContent,
  };
});

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({
      loadTree: mockLoadTree,
      setCharCount: mockSetCharCount,
    }),
  },
}));

vi.mock("@/features/semantic-search/scheduler", () => ({
  scheduleSceneIndex: vi.fn(),
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p1",
}));

vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: {
    getState: () => ({ tabs: [], dirtyTabIds: new Set<string>() }),
  },
}));

import { contentHash } from "./contentHash";
import { markdownToPmJson, pmJsonToMarkdown } from "./markdownBridge";
import {
  applyExternalContent,
  buildDbByUriMap,
  hashForNodeContent,
} from "./mountManager";
import { useExternalRootStore } from "./externalRootStore";

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

describe("hashForNodeContent", () => {
  it("matches disk contentHash from ProseMirror JSON via markdown", async () => {
    const markdown = "Hello, rename detection.";
    const pmJson = JSON.stringify(markdownToPmJson(markdown));
    const diskHash = await contentHash(pmJsonToMarkdown(pmJson));

    const nodeHash = await hashForNodeContent(pmJson);

    expect(nodeHash).toBe(diskHash);
  });

  it("does not match raw ProseMirror JSON against markdown hash", async () => {
    const markdown = "Different formats must not compare equal.";
    const pmJson = JSON.stringify(markdownToPmJson(markdown));
    const wrongHash = await contentHash(pmJson);

    const nodeHash = await hashForNodeContent(pmJson);

    expect(nodeHash).not.toBe(wrongHash);
  });
});

describe("applyExternalContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useExternalRootStore.setState({ mutedWrites: [], conflicts: [] });
  });

  it("updates charCount and does not mute the path", async () => {
    const markdown = "External sync body text.";
    const mtime = "2026-05-24T12:00:00.000Z";

    await applyExternalContent(
      "scene-1",
      "root-1",
      "chapter/01.md",
      markdown,
      mtime,
    );

    expect(mockSaveSceneContent).toHaveBeenCalledWith(
      "scene-1",
      expect.objectContaining({
        content: expect.any(String),
        charCount: markdown.length,
      }),
    );
    expect(mockUpdateNode).toHaveBeenCalledWith("scene-1", {
      sourceMtime: mtime,
    });
    expect(mockSetCharCount).toHaveBeenCalledWith("scene-1", markdown.length);
    expect(
      useExternalRootStore.getState().isMuted("root-1", "chapter/01.md"),
    ).toBe(false);
  });
});

describe("reload conflict queue", () => {
  beforeEach(() => {
    useExternalRootStore.setState({ conflicts: [] });
  });

  it("queues multiple conflicts instead of overwriting", () => {
    const first = {
      sceneId: "s1",
      rootId: "r1",
      relPath: "a.md",
      incomingContent: "a",
      incomingMtime: "2026-01-01T00:00:00.000Z",
    };
    const second = {
      sceneId: "s2",
      rootId: "r1",
      relPath: "b.md",
      incomingContent: "b",
      incomingMtime: "2026-01-02T00:00:00.000Z",
    };

    useExternalRootStore.getState().enqueueConflict(first);
    useExternalRootStore.getState().enqueueConflict(second);

    expect(useExternalRootStore.getState().conflicts).toEqual([first, second]);

    useExternalRootStore.getState().shiftConflict();

    expect(useExternalRootStore.getState().conflicts).toEqual([second]);
  });
});
