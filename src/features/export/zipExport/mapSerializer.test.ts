import { describe, it, expect } from "vitest";
import { buildMapJSON, buildMapSVG } from "@/features/map/mapExport";
import { buildMapNodesFromData } from "@/features/map/boardToReactFlow";
import { DEFAULT_SHOW } from "@/features/map/types";

describe("mapSerializer (pure export path)", () => {
  it("generates JSON and SVG from board nodes", () => {
    const nodes = buildMapNodesFromData({
      positions: [
        {
          id: "pos-1",
          boardId: "b1",
          nodeRefType: "scene",
          treeNodeId: "scene-1",
          codexEntryId: null,
          snippetId: null,
          stickyId: null,
          aiBranchId: null,
          x: 50,
          y: 80,
          pinned: 0,
          zIndex: 0,
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ],
      userEdges: [],
      treeNodes: [
        {
          id: "scene-1",
          nodeType: "scene",
          title: "Test Scene",
          synopsis: null,
          status: "draft",
        },
      ],
      codexEntries: [],
      snippets: [],
      stickies: [],
      aiBranches: [],
      frames: [],
      phasesByEntry: {},
      show: DEFAULT_SHOW,
    });

    const json = buildMapJSON(nodes, []);
    const parsed = JSON.parse(json);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0].id).toBe("scene:scene-1");

    const svg = buildMapSVG(nodes, []);
    expect(svg).toContain("<svg");
    expect(svg).toContain("Test Scene");
  });
});
