import { describe, it, expect } from "vitest";
import { buildCsvString } from "./exportCsv";
import type { MatrixRow } from "./deriveRows";
import type { MatrixColumnOrHeader } from "./deriveColumns";
import type { CellInfo } from "./deriveCells";
import type { TreeNodeData } from "@/features/tree/treeStore";

const BASE_NODE: Omit<
  TreeNodeData,
  "id" | "parentId" | "title" | "nodeType" | "sortOrder"
> = {
  projectId: "p1",
  synopsis: null,
  storyTimeOrder: null,
  charCount: 0,
  status: null,
  storyTimeLabel: null,
  povCharacterId: null,
  locationId: null,
  unplacedBeatPreview: null,
  placedBeatPreview: null,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

function makeScene(id: string, title: string): MatrixRow {
  return {
    node: {
      ...BASE_NODE,
      id,
      title,
      parentId: null,
      nodeType: "scene",
      sortOrder: "a",
    },
    depth: 0,
    isFolder: false,
  };
}

function makeFolder(id: string, title: string): MatrixRow {
  return {
    node: {
      ...BASE_NODE,
      id,
      title,
      parentId: null,
      nodeType: "folder",
      sortOrder: "a",
    },
    depth: 0,
    isFolder: true,
  };
}

function makeCol(id: string, name: string): MatrixColumnOrHeader {
  return {
    key: id,
    entry: { id, name, type: "character", aliases: [], excludedAliases: [] },
    isSectionHeader: false,
  };
}

function makeSection(type: string): MatrixColumnOrHeader {
  return { key: `section::${type}`, isSectionHeader: true, sectionType: type };
}

function cellInfo(sources: ("body" | "beat" | "relation")[]): CellInfo {
  return {
    sources: new Set(sources) as CellInfo["sources"],
    topSource: sources[0] as CellInfo["topSource"],
    role: "mentioned",
  };
}

describe("buildCsvString", () => {
  it("returns header + data row for a single scene with body mention", () => {
    const rows = [makeScene("s1", "Scene One")];
    const cols = [makeCol("e1", "Alice")];
    const cellMap = new Map([["s1::e1", cellInfo(["body"])]]);
    const csv = buildCsvString(rows, cols, cellMap);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("scene_id,scene_title,Alice");
    expect(lines[1]).toBe("s1,Scene One,B");
  });

  it("encodes B/R/M correctly for combined sources", () => {
    const rows = [makeScene("s1", "S1")];
    const cols = [makeCol("e1", "Bob")];
    const cellMap = new Map([
      ["s1::e1", cellInfo(["body", "beat", "relation"])],
    ]);
    const csv = buildCsvString(rows, cols, cellMap);
    expect(csv.split("\n")[1]).toBe("s1,S1,BRM");
  });

  it("outputs empty string for cell with no mention", () => {
    const rows = [makeScene("s1", "S1")];
    const cols = [makeCol("e1", "Charlie")];
    const cellMap = new Map<string, CellInfo>();
    const csv = buildCsvString(rows, cols, cellMap);
    expect(csv.split("\n")[1]).toBe('s1,S1,""');
  });

  it("skips folder rows", () => {
    const rows = [makeFolder("f1", "Chapter"), makeScene("s1", "S1")];
    const cols = [makeCol("e1", "Alice")];
    const cellMap = new Map([["s1::e1", cellInfo(["body"])]]);
    const csv = buildCsvString(rows, cols, cellMap);
    const lines = csv.split("\n").filter(Boolean);
    // header + 1 scene (folder skipped)
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("s1,S1,B");
  });

  it("skips section header columns", () => {
    const rows = [makeScene("s1", "S1")];
    const cols = [makeSection("character"), makeCol("e1", "Alice")];
    const cellMap = new Map([["s1::e1", cellInfo(["beat"])]]);
    const csv = buildCsvString(rows, cols, cellMap);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("scene_id,scene_title,Alice");
    expect(lines[1]).toBe("s1,S1,M");
  });

  it("escapes commas in title with double quotes", () => {
    const rows = [makeScene("s1", "Hello, World")];
    const cols = [makeCol("e1", "Alice")];
    const cellMap = new Map<string, CellInfo>();
    const csv = buildCsvString(rows, cols, cellMap);
    const lines = csv.split("\n");
    expect(lines[1]).toContain('"Hello, World"');
  });

  it("escapes double quotes in field values", () => {
    const rows = [makeScene("s1", 'Say "hi"')];
    const cols = [makeCol("e1", "Alice")];
    const cellMap = new Map<string, CellInfo>();
    const csv = buildCsvString(rows, cols, cellMap);
    expect(csv).toContain('"Say ""hi"""');
  });

  it("produces only relation code for relation-only cell", () => {
    const rows = [makeScene("s1", "S1")];
    const cols = [makeCol("e1", "Alice")];
    const cellMap = new Map([["s1::e1", cellInfo(["relation"])]]);
    const csv = buildCsvString(rows, cols, cellMap);
    expect(csv.split("\n")[1]).toBe("s1,S1,R");
  });

  it("neutralizes leading =/+/-/@ to prevent formula injection", () => {
    const rows = [
      makeScene("s1", "=cmd|'/c calc'!A1"),
      makeScene("s2", "+attack"),
      makeScene("s3", "-1+1"),
      makeScene("s4", "@SUM(A1)"),
    ];
    const cols = [makeCol("e1", "=danger")];
    const cellMap = new Map<string, CellInfo>();
    const csv = buildCsvString(rows, cols, cellMap);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(`scene_id,scene_title,'=danger`);
    expect(lines[1]).toBe(`s1,'=cmd|'/c calc'!A1,""`);
    expect(lines[2]).toBe(`s2,'+attack,""`);
    expect(lines[3]).toBe(`s3,'-1+1,""`);
    expect(lines[4]).toBe(`s4,'@SUM(A1),""`);
  });

  it("escapes bare CR in title to prevent record corruption", () => {
    const rows = [makeScene("s1", "line1\rline2")];
    const cols = [makeCol("e1", "Alice")];
    const cellMap = new Map<string, CellInfo>();
    const csv = buildCsvString(rows, cols, cellMap);
    const lines = csv.split("\n");
    expect(lines[1]).toBe(`s1,"line1\rline2",""`);
  });

  it("multiple columns in correct order", () => {
    const rows = [makeScene("s1", "S1")];
    const cols = [makeCol("e1", "Alice"), makeCol("e2", "Bob")];
    const cellMap = new Map([
      ["s1::e1", cellInfo(["body"])],
      ["s1::e2", cellInfo(["beat"])],
    ]);
    const csv = buildCsvString(rows, cols, cellMap);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("scene_id,scene_title,Alice,Bob");
    expect(lines[1]).toBe("s1,S1,B,M");
  });
});
