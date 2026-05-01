import { describe, it, expect } from "vitest";
import {
  parseId,
  computeSceneDropTarget,
  computeColumnDropTarget,
  activeDragKind,
  sceneDroppableId,
  columnSlotId,
  columnEndId,
  columnEmptyId,
  columnNestId,
  sceneDraggableId,
  columnDraggableId,
} from "../gridDndUtils";

describe("parseId", () => {
  it("parses scene-drop- prefix", () => {
    expect(parseId("scene-drop-abc")).toEqual({ kind: "drop", rawId: "abc" });
  });
  it("parses column-slot- prefix", () => {
    expect(parseId("column-slot-f1")).toEqual({ kind: "slot", rawId: "f1" });
  });
  it("parses column-end- prefix", () => {
    expect(parseId("column-end-f2")).toEqual({ kind: "end", rawId: "f2" });
  });
  it("parses column-empty- prefix", () => {
    expect(parseId("column-empty-loose")).toEqual({
      kind: "empty",
      rawId: "loose",
    });
  });
  it("parses scene- prefix", () => {
    expect(parseId("scene-s1")).toEqual({ kind: "scene", rawId: "s1" });
  });
  it("parses column- prefix", () => {
    expect(parseId("column-f3")).toEqual({ kind: "column", rawId: "f3" });
  });
});

describe("computeSceneDropTarget", () => {
  // Ordered by sortOrder within each parent
  const orderedScenes = [
    { id: "s1", parentId: "ch1" },
    { id: "s2", parentId: "ch1" },
    { id: "s3", parentId: "ch2" },
  ];
  const rect = { top: 100, height: 60 };

  it("returns null when overId is empty", () => {
    expect(
      computeSceneDropTarget("s1", "", 120, rect, orderedScenes, "root"),
    ).toBeNull();
  });

  it("returns null when dragging scene over itself", () => {
    expect(
      computeSceneDropTarget(
        "s1",
        sceneDroppableId("s1"),
        120,
        rect,
        orderedScenes,
        "root",
      ),
    ).toBeNull();
  });

  it("inserts before first scene in column → prepend (afterId null)", () => {
    // Drag s3 (ch2) before s1 (first in ch1) — no predecessor → prepend
    const result = computeSceneDropTarget(
      "s3",
      sceneDroppableId("s1"),
      110, // above mid=130
      rect,
      orderedScenes,
      "root",
    );
    expect(result).toEqual({ targetParentId: "ch1", afterId: null });
  });

  it("inserts before non-first scene → resolves predecessor", () => {
    // Drag s3 (ch2) before s2 (second in ch1) → afterId = s1
    const result = computeSceneDropTarget(
      "s3",
      sceneDroppableId("s2"),
      110, // above mid=130
      rect,
      orderedScenes,
      "root",
    );
    expect(result).toEqual({ targetParentId: "ch1", afterId: "s1" });
  });

  it("dragging within same column before self-adjacent: active excluded from siblings", () => {
    // Drag s2 (ch1) before s1 (first in ch1) — active excluded → predecessor null
    const result = computeSceneDropTarget(
      "s2",
      sceneDroppableId("s1"),
      110,
      rect,
      orderedScenes,
      "root",
    );
    expect(result).toEqual({ targetParentId: "ch1", afterId: null });
  });

  it("inserts after target when pointer is below midpoint", () => {
    const result = computeSceneDropTarget(
      "s1",
      sceneDroppableId("s3"),
      145, // below mid=130
      rect,
      orderedScenes,
      "root",
    );
    expect(result).toEqual({ targetParentId: "ch2", afterId: "s3" });
  });

  it("drops to column-end appends (afterId undefined)", () => {
    const result = computeSceneDropTarget(
      "s1",
      columnEndId("ch2"),
      0,
      rect,
      orderedScenes,
      "root",
    );
    expect(result).toEqual({ targetParentId: "ch2", afterId: undefined });
  });

  it("drops to column-slot appends to non-empty column (afterId undefined)", () => {
    const result = computeSceneDropTarget(
      "s3",
      columnSlotId("ch1"),
      0,
      rect,
      orderedScenes,
      "root",
    );
    expect(result).toEqual({ targetParentId: "ch1", afterId: undefined });
  });

  it("drops to column-empty-loose returns containerId as targetParentId", () => {
    const result = computeSceneDropTarget(
      "s1",
      columnEmptyId("loose"),
      0,
      rect,
      orderedScenes,
      "root",
    );
    expect(result).toEqual({ targetParentId: "root", afterId: null });
  });

  it("drops to column-end-loose appends (afterId undefined)", () => {
    const result = computeSceneDropTarget(
      "s1",
      columnEndId("loose"),
      0,
      rect,
      orderedScenes,
      "root",
    );
    expect(result).toEqual({ targetParentId: "root", afterId: undefined });
  });

  it("drops to empty chapter column", () => {
    const result = computeSceneDropTarget(
      "s1",
      columnEmptyId("ch3"),
      0,
      rect,
      orderedScenes,
      "root",
    );
    expect(result).toEqual({ targetParentId: "ch3", afterId: null });
  });
});

describe("computeColumnDropTarget", () => {
  const folderParentMap: Record<string, string | null> = {
    ch1: "root",
    ch2: "root",
    ch3: "root",
  };
  const orderedFolders = [
    { id: "ch1", parentId: "root" },
    { id: "ch2", parentId: "root" },
    { id: "ch3", parentId: "root" },
  ];
  const sceneParentMap: Record<string, string | null> = {};
  const rect = { left: 0, width: 200 };

  it("returns null when overId is empty", () => {
    expect(
      computeColumnDropTarget(
        "ch1",
        "",
        100,
        rect,
        folderParentMap,
        orderedFolders,
        sceneParentMap,
        null,
      ),
    ).toBeNull();
  });

  it("returns null when dropping column on itself", () => {
    expect(
      computeColumnDropTarget(
        "ch1",
        columnSlotId("ch1"),
        100,
        rect,
        folderParentMap,
        orderedFolders,
        sceneParentMap,
        null,
      ),
    ).toBeNull();
  });

  it("inserts column AFTER target when pointer is on right half", () => {
    const result = computeColumnDropTarget(
      "ch1",
      columnSlotId("ch3"),
      150, // right zone (>70%)
      rect,
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toEqual({ targetParentId: "root", afterId: "ch3" });
  });

  it("inserts column BEFORE target when pointer is on left half", () => {
    // Drop ch3 before ch2: predecessor is ch1
    const result = computeColumnDropTarget(
      "ch3",
      columnSlotId("ch2"),
      50, // left zone (<30%)
      rect,
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toEqual({ targetParentId: "root", afterId: "ch1" });
  });

  it("inserts column at start (afterId=null) when target is first sibling", () => {
    // Drop ch3 before ch1: no predecessor → prepend
    const result = computeColumnDropTarget(
      "ch3",
      columnSlotId("ch1"),
      50, // left zone
      rect,
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toEqual({ targetParentId: "root", afterId: null });
  });

  it("resolves enclosing column when over.id is a scene-drop inside a target column", () => {
    // Dragging ch1 over scene-drop-s1, where s1.parentId === "ch3"
    const result = computeColumnDropTarget(
      "ch1",
      "scene-drop-s1",
      150, // right zone
      rect,
      folderParentMap,
      orderedFolders,
      { s1: "ch3" },
      null,
    );
    expect(result).toEqual({ targetParentId: "root", afterId: "ch3" });
  });

  it("flips no-op side to the meaningful side when hovering an adjacent column (right→left)", () => {
    // ch1 hovering ch2's left zone = "before ch2" = no-op (ch1 is already there).
    // Should flip to "after ch2" so the cursor anywhere over ch2 produces a real move.
    const result = computeColumnDropTarget(
      "ch1",
      columnSlotId("ch2"),
      50, // left zone (would be "before ch2")
      rect,
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toEqual({ targetParentId: "root", afterId: "ch2" });
  });

  it("flips no-op side to the meaningful side when hovering an adjacent column (left→right)", () => {
    // ch2 hovering ch1's right zone = "after ch1" = no-op.
    // Should flip to "before ch1" → afterId=null (prepend).
    const result = computeColumnDropTarget(
      "ch2",
      columnSlotId("ch1"),
      150, // right zone (would be "after ch1")
      rect,
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toEqual({ targetParentId: "root", afterId: null });
  });

  it("returns null when both sides would be no-op (only two columns adjacent — should never happen since target!=active is filtered)", () => {
    // Sanity: can't construct a real "both sides no-op" given target !== active and at least one direction is real.
    // This test just documents that a self-target is filtered earlier.
    const result = computeColumnDropTarget(
      "ch1",
      columnSlotId("ch1"),
      100,
      rect,
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toBeNull();
  });

  it("nests via center zone (20% middle) of an unrelated target column", () => {
    // ch1 (parent root) over ch3's center zone → nest INTO ch3
    const result = computeColumnDropTarget(
      "ch1",
      columnSlotId("ch3"),
      100, // center zone (30-70%)
      rect,
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toEqual({ targetParentId: "ch3", afterId: undefined });
  });

  it("nests via explicit column-nest droppable (folder card)", () => {
    const result = computeColumnDropTarget(
      "ch1",
      columnNestId("ch3"),
      0,
      rect,
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toEqual({ targetParentId: "ch3", afterId: undefined });
  });

  it("rejects nest onto self", () => {
    const result = computeColumnDropTarget(
      "ch1",
      columnNestId("ch1"),
      0,
      rect,
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toBeNull();
  });

  it("rejects nest when active is already a direct child of target", () => {
    // sub1's parent is ch1 already → nesting into ch1 is no-op
    const fpm = { ...folderParentMap, sub1: "ch1" };
    const ofs = [...orderedFolders, { id: "sub1", parentId: "ch1" }];
    const result = computeColumnDropTarget(
      "sub1",
      columnNestId("ch1"),
      0,
      rect,
      fpm,
      ofs,
      sceneParentMap,
      null,
    );
    expect(result).toBeNull();
  });

  it("rejects center-zone nest when active is already a direct child of target column", () => {
    const fpm = { ...folderParentMap, sub1: "ch1" };
    const ofs = [...orderedFolders, { id: "sub1", parentId: "ch1" }];
    const result = computeColumnDropTarget(
      "sub1",
      columnSlotId("ch1"),
      100, // center zone
      rect,
      fpm,
      ofs,
      sceneParentMap,
      null,
    );
    expect(result).toBeNull();
  });

  it("rejects loose-area drop (target === containerId) — does not bubble Part out of container", () => {
    // Inside Part X (containerId="X"), looseScene.parentId === "X".
    // Dragging ch1 over a loose scene resolves to "X" → must reject (not move ch1 to root).
    const fpm = { ...folderParentMap, X: null, ch1: "X" };
    const ofs = [
      { id: "X", parentId: null },
      { id: "ch1", parentId: "X" },
    ];
    const result = computeColumnDropTarget(
      "ch1",
      "scene-drop-loose1",
      100,
      rect,
      fpm,
      ofs,
      { loose1: "X" },
      "X", // containerId
    );
    expect(result).toBeNull();
  });

  it("rejects cycle: nesting an ancestor folder into its descendant via column-nest", () => {
    // Tree: A → B → C. Dragging A onto C.nest would create A→…→C→A cycle.
    const fpm: Record<string, string | null> = {
      A: null,
      B: "A",
      C: "B",
    };
    const ofs = [
      { id: "A", parentId: null },
      { id: "B", parentId: "A" },
      { id: "C", parentId: "B" },
    ];
    const result = computeColumnDropTarget(
      "A",
      columnNestId("C"),
      0,
      rect,
      fpm,
      ofs,
      {},
      null,
    );
    expect(result).toBeNull();
  });

  it("rejects cycle: nesting an ancestor folder into its descendant via center-zone", () => {
    const fpm: Record<string, string | null> = {
      A: null,
      B: "A",
      C: "B",
    };
    const ofs = [
      { id: "A", parentId: null },
      { id: "B", parentId: "A" },
      { id: "C", parentId: "B" },
    ];
    const result = computeColumnDropTarget(
      "A",
      columnSlotId("C"),
      100, // center zone
      rect,
      fpm,
      ofs,
      {},
      null,
    );
    expect(result).toBeNull();
  });
});

describe("activeDragKind", () => {
  it("detects scene", () => expect(activeDragKind("scene-abc")).toBe("scene"));
  it("detects column", () =>
    expect(activeDragKind("column-f1")).toBe("column"));
  it("returns null for unknown", () =>
    expect(activeDragKind("unknown")).toBeNull());
});

describe("id helpers", () => {
  it("sceneDraggableId", () => expect(sceneDraggableId("s1")).toBe("scene-s1"));
  it("columnDraggableId", () =>
    expect(columnDraggableId("f1")).toBe("column-f1"));
  it("sceneDroppableId", () =>
    expect(sceneDroppableId("s1")).toBe("scene-drop-s1"));
  it("columnSlotId", () => expect(columnSlotId("f1")).toBe("column-slot-f1"));
  it("columnEndId", () => expect(columnEndId("f1")).toBe("column-end-f1"));
  it("columnEmptyId", () =>
    expect(columnEmptyId("loose")).toBe("column-empty-loose"));
  it("columnNestId", () => expect(columnNestId("f1")).toBe("column-nest-f1"));
});
