import { describe, it, expect } from "vitest";
import { buildMapJSON, buildMapSVG } from "@/features/map/mapExport";
import { buildMapNodesFromData } from "@/features/map/boardToReactFlow";
import { DEFAULT_SHOW } from "@/features/map/types";
import { assignBoardSlugs } from "./mapSerializer";

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

describe("assignBoardSlugs", () => {
  it("disambiguates duplicate titles so archive paths do not collide", () => {
    // Regression: each serializeMapBoard call previously held its own
    // `used` Set, so two boards titled "Plot" both resolved to maps/Plot
    // and the second silently overwrote the first when the zip was keyed
    // by path.
    const result = assignBoardSlugs([
      { id: "a", title: "Plot" },
      { id: "b", title: "Plot" },
      { id: "c", title: "Other" },
      { id: "d", title: "Plot" },
    ]);
    expect(result.map((r) => r.slug)).toEqual([
      "Plot",
      "Plot-2",
      "Other",
      "Plot-3",
    ]);
    expect(result.map((r) => r.board.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("uses a fallback slug for empty/null titles and dedupes those too", () => {
    const result = assignBoardSlugs([
      { id: "a", title: null },
      { id: "b", title: "" },
      { id: "c", title: null },
    ]);
    expect(result.map((r) => r.slug)).toEqual(["board", "board-2", "board-3"]);
  });

  it("returns an empty list for empty input", () => {
    expect(assignBoardSlugs([])).toEqual([]);
  });
});
