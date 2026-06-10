import { describe, it, expect } from "vitest";
import {
  buildMapEdgesFromData,
  buildMapNodesFromData,
} from "./boardToReactFlow";
import { DEFAULT_SHOW } from "./types";

describe("boardToReactFlow", () => {
  const treeNodes = [
    {
      id: "scene-1",
      nodeType: "scene" as const,
      title: "Hero Opening",
      synopsis: "Hero arrives",
      status: "draft",
    },
  ];

  const codexEntries = [
    {
      id: "codex-1",
      name: "Hero",
      type: "character",
      parentId: null,
      summary: "Main character",
      tagsCache: null,
    },
  ];

  const positions = [
    {
      id: "pos-scene",
      boardId: "b1",
      nodeRefType: "scene" as const,
      treeNodeId: "scene-1",
      codexEntryId: null,
      snippetId: null,
      stickyId: null,
      aiBranchId: null,
      x: 100,
      y: 200,
      pinned: 0,
      zIndex: 0,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "pos-codex",
      boardId: "b1",
      nodeRefType: "codex" as const,
      treeNodeId: null,
      codexEntryId: "codex-1",
      snippetId: null,
      stickyId: null,
      aiBranchId: null,
      x: 400,
      y: 200,
      pinned: 0,
      zIndex: 0,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ];

  it("builds scene and codex nodes from DB positions", () => {
    const nodes = buildMapNodesFromData({
      positions,
      userEdges: [],
      treeNodes,
      codexEntries,
      snippets: [],
      stickies: [],
      aiBranches: [],
      frames: [],
      phasesByEntry: {},
      show: DEFAULT_SHOW,
    });

    expect(nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining(["scene:scene-1", "codex:codex-1"]),
    );
    expect(nodes.find((n) => n.id === "scene:scene-1")?.position).toEqual({
      x: 100,
      y: 200,
    });
  });

  it("builds derived codex relation edges when enabled", () => {
    const edges = buildMapEdgesFromData({
      codexEntries,
      treeNodes,
      snippetEntries: [],
      phasesByEntry: {},
      userEdges: [],
      positions,
      show: { ...DEFAULT_SHOW, derivedEdges: true },
      codexRelations: [
        {
          id: "rel-1",
          fromCodexId: "codex-1",
          toCodexId: "codex-1",
          label: "師匠",
          relationType: "custom",
        },
      ],
    });

    expect(edges.some((e) => e.id === "codex-relation:rel-1")).toBe(true);
  });

  const hierarchyPair = [
    {
      id: "p",
      name: "Kingdom",
      type: "lore",
      parentId: null,
      summary: null,
      tagsCache: null,
    },
    {
      id: "c",
      name: "Knights",
      type: "faction",
      parentId: "p",
      summary: null,
      tagsCache: null,
    },
  ];

  it("draws a gray parent-derived edge for the parentId hierarchy", () => {
    const edges = buildMapEdgesFromData({
      codexEntries: hierarchyPair,
      treeNodes: [],
      snippetEntries: [],
      phasesByEntry: {},
      userEdges: [],
      positions: [],
      show: { ...DEFAULT_SHOW, derivedEdges: true },
    });

    expect(edges.some((e) => e.id === "derived:c->p")).toBe(true);
  });

  it("suppresses the parent-derived edge when a typed relation connects the same pair", () => {
    const edges = buildMapEdgesFromData({
      codexEntries: hierarchyPair,
      treeNodes: [],
      snippetEntries: [],
      phasesByEntry: {},
      userEdges: [],
      positions: [],
      show: { ...DEFAULT_SHOW, derivedEdges: true },
      codexRelations: [
        {
          id: "rel-pc",
          fromCodexId: "p",
          toCodexId: "c",
          label: "配下",
          relationType: "custom",
        },
      ],
    });

    // The labeled typed relation is kept...
    expect(edges.some((e) => e.id === "codex-relation:rel-pc")).toBe(true);
    // ...and the redundant unlabeled parent edge is dropped (no overlap).
    expect(edges.some((e) => e.id === "derived:c->p")).toBe(false);
  });

  it("suppresses the parent-derived edge regardless of typed relation direction", () => {
    const edges = buildMapEdgesFromData({
      codexEntries: hierarchyPair,
      treeNodes: [],
      snippetEntries: [],
      phasesByEntry: {},
      userEdges: [],
      positions: [],
      show: { ...DEFAULT_SHOW, derivedEdges: true },
      // Relation runs child -> parent (opposite of the parent edge direction).
      codexRelations: [
        {
          id: "rel-cp",
          fromCodexId: "c",
          toCodexId: "p",
          label: "所属",
          relationType: "custom",
        },
      ],
    });

    expect(edges.some((e) => e.id === "codex-relation:rel-cp")).toBe(true);
    expect(edges.some((e) => e.id === "derived:c->p")).toBe(false);
  });

  it("builds derived codex mention edges when enabled", () => {
    const edges = buildMapEdgesFromData({
      codexEntries,
      treeNodes,
      snippetEntries: [],
      phasesByEntry: {},
      userEdges: [],
      positions,
      show: { ...DEFAULT_SHOW, derivedEdges: true },
    });

    expect(edges.some((e) => e.id.startsWith("mention:"))).toBe(true);
  });
});
