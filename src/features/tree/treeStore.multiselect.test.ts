import { describe, it, expect, beforeEach, vi } from "vitest";
import { useTreeStore } from "./treeStore";

// Mock the API module
vi.mock("./api", () => ({
  listNodes: vi.fn().mockResolvedValue([]),
  createNode: vi.fn().mockImplementation((node) => Promise.resolve(node)),
  updateNode: vi.fn().mockResolvedValue(undefined),
  deleteNode: vi.fn().mockResolvedValue(undefined),
}));

function resetStore() {
  useTreeStore.setState({
    nodes: [],
    selectedIds: [],
    activeSceneId: "",
    filterQuery: "",
    expandedIds: [],
  });
}

const NODE_DEFAULTS = {
  intent: null,
  storyTimeOrder: null,
  storyTimeLabel: null,
  povCharacterId: null,
  locationId: null,
  createdAt: "2024-01-01T00:00:00Z",

  charCount: 0,
  updatedAt: "2024-01-01T00:00:00Z",
} as const;

const NODES = [
  {
    id: "scene-1",
    projectId: "p",
    parentId: "ch-1",
    nodeType: "scene" as const,
    title: "Scene 1",
    synopsis: null,
    sortOrder: "a1",
    status: null,
    ...NODE_DEFAULTS,
  },
  {
    id: "scene-2",
    projectId: "p",
    parentId: "ch-1",
    nodeType: "scene" as const,
    title: "Scene 2",
    synopsis: null,
    sortOrder: "a2",
    status: null,
    ...NODE_DEFAULTS,
  },
  {
    id: "scene-3",
    projectId: "p",
    parentId: "ch-1",
    nodeType: "scene" as const,
    title: "Scene 3",
    synopsis: null,
    sortOrder: "a3",
    status: null,
    ...NODE_DEFAULTS,
  },
  {
    id: "scene-4",
    projectId: "p",
    parentId: "ch-1",
    nodeType: "scene" as const,
    title: "Scene 4",
    synopsis: null,
    sortOrder: "a4",
    status: null,
    ...NODE_DEFAULTS,
  },
];

describe("treeStore multi-selection", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("selectNode (Ctrl+Click)", () => {
    it("selects a single node when no prior selection", () => {
      useTreeStore.setState({ nodes: NODES });
      useTreeStore.getState().selectNode("scene-1", false);
      expect(useTreeStore.getState().selectedIds).toEqual(["scene-1"]);
    });

    it("clears previous selection and selects new node without extend", () => {
      useTreeStore.setState({
        nodes: NODES,
        selectedIds: ["scene-1", "scene-2"],
      });
      useTreeStore.getState().selectNode("scene-3", false);
      expect(useTreeStore.getState().selectedIds).toEqual(["scene-3"]);
    });

    it("adds a node to selection with extend=true (Ctrl+Click)", () => {
      useTreeStore.setState({ nodes: NODES, selectedIds: ["scene-1"] });
      useTreeStore.getState().selectNode("scene-3", true);
      expect(useTreeStore.getState().selectedIds).toContain("scene-1");
      expect(useTreeStore.getState().selectedIds).toContain("scene-3");
    });

    it("deselects an already-selected node with extend=true", () => {
      useTreeStore.setState({
        nodes: NODES,
        selectedIds: ["scene-1", "scene-2"],
      });
      useTreeStore.getState().selectNode("scene-1", true);
      expect(useTreeStore.getState().selectedIds).not.toContain("scene-1");
      expect(useTreeStore.getState().selectedIds).toContain("scene-2");
    });

    it("updates activeSceneId to the clicked node", () => {
      useTreeStore.setState({ nodes: NODES });
      useTreeStore.getState().selectNode("scene-2", false);
      expect(useTreeStore.getState().activeSceneId).toBe("scene-2");
    });
  });

  describe("rangeSelectNode (Shift+Click)", () => {
    it("selects a range from activeSceneId to clicked node (forward)", () => {
      useTreeStore.setState({
        nodes: NODES,
        activeSceneId: "scene-1",
        selectedIds: ["scene-1"],
      });
      useTreeStore.getState().rangeSelectNode("scene-3", NODES);
      const { selectedIds } = useTreeStore.getState();
      expect(selectedIds).toContain("scene-1");
      expect(selectedIds).toContain("scene-2");
      expect(selectedIds).toContain("scene-3");
    });

    it("selects a range backward (from activeSceneId to earlier node)", () => {
      useTreeStore.setState({
        nodes: NODES,
        activeSceneId: "scene-4",
        selectedIds: ["scene-4"],
      });
      useTreeStore.getState().rangeSelectNode("scene-2", NODES);
      const { selectedIds } = useTreeStore.getState();
      expect(selectedIds).toContain("scene-2");
      expect(selectedIds).toContain("scene-3");
      expect(selectedIds).toContain("scene-4");
      expect(selectedIds).not.toContain("scene-1");
    });

    it("selects single node when activeSceneId equals clicked node", () => {
      useTreeStore.setState({
        nodes: NODES,
        activeSceneId: "scene-2",
        selectedIds: ["scene-2"],
      });
      useTreeStore.getState().rangeSelectNode("scene-2", NODES);
      expect(useTreeStore.getState().selectedIds).toEqual(["scene-2"]);
    });

    it("falls back to single selection when activeSceneId is not in ordered list", () => {
      useTreeStore.setState({
        nodes: NODES,
        activeSceneId: "non-existent",
        selectedIds: [],
      });
      useTreeStore.getState().rangeSelectNode("scene-2", NODES);
      expect(useTreeStore.getState().selectedIds).toEqual(["scene-2"]);
    });
  });

  describe("clearSelection", () => {
    it("clears all selected nodes", () => {
      useTreeStore.setState({
        nodes: NODES,
        selectedIds: ["scene-1", "scene-2", "scene-3"],
      });
      useTreeStore.getState().clearSelection();
      expect(useTreeStore.getState().selectedIds).toEqual([]);
    });
  });
});
