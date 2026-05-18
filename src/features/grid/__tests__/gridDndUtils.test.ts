import { describe, it, expect } from "vitest";
import {
  parseId,
  computeSceneDropTarget,
  computeColumnDropTarget,
  computeColumnDropIndicator,
  activeDragKind,
  sceneDroppableId,
  columnSlotId,
  columnEndId,
  columnEmptyId,
  columnNestId,
  sceneDraggableId,
  columnDraggableId,
  resolveSceneDragMode,
  computeSceneAxisLockTarget,
  computeSceneAxisLockShifts,
  computeSceneAxisLockPxOffsets,
  computeColumnAxisLockTarget,
  computeColumnAxisLockShifts,
  computeColumnAxisLockPxOffsets,
  findFolderBlockLastVisibleId,
} from "../gridDndUtils";
import { makeNodeData } from "@/test-utils/nodeFixture";

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

  it("drops onto a nested folder card (column-nest) → append into that folder", () => {
    // Folder cards register `column-nest-{id}` droppables; without this case
    // the folder's hover highlight fires during a scene drag but the drop
    // does nothing.
    const result = computeSceneDropTarget(
      "s1",
      columnNestId("fB"),
      0,
      rect,
      orderedScenes,
      "root",
    );
    expect(result).toEqual({ targetParentId: "fB", afterId: undefined });
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
  const rect = { left: 0, width: 200, top: 0, height: 100 };

  it("returns null when overId is empty", () => {
    expect(
      computeColumnDropTarget(
        "ch1",
        "",
        100,
        50, // pointerY (middle of rect → "inside" zone for nest tests)
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
        50, // pointerY (middle of rect → "inside" zone for nest tests)
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
      50, // pointerY (middle of rect → "inside" zone for nest tests)
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
      50, // pointerY (middle of rect → "inside" zone for nest tests)
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
      50, // pointerY (middle of rect → "inside" zone for nest tests)
      rect,
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toEqual({ targetParentId: "root", afterId: null });
  });

  it("scene-drop Y-axis 2-zone: bottom half → column becomes sibling AFTER the scene in scene's parent", () => {
    // Dragging ch1 over scene-drop-s1 where s1.parentId === "ch3". With the
    // new Y-axis semantic, the column becomes a sibling of the scene inside
    // ch3 (a reparent + position insert in one drop). pointerY > midY → after.
    const result = computeColumnDropTarget(
      "ch1",
      "scene-drop-s1",
      150, // pointerX irrelevant
      80, // pointerY below midY (50) → "after"
      rect,
      folderParentMap,
      orderedFolders,
      { s1: "ch3" },
      null,
    );
    expect(result).toEqual({ targetParentId: "ch3", afterId: "s1" });
  });

  it("scene-drop Y-axis 2-zone: top half → column becomes sibling BEFORE the scene (predecessor null when scene is first)", () => {
    const result = computeColumnDropTarget(
      "ch1",
      "scene-drop-s1",
      150,
      10, // top half → "before"
      rect,
      folderParentMap,
      orderedFolders,
      { s1: "ch3" },
      null,
    );
    // s1 not present in orderedFolders → predecessor among ch3's children = null.
    expect(result).toEqual({ targetParentId: "ch3", afterId: null });
  });

  it("returns null when hovering adjacent right-neighbor's left zone (no-op, no flip)", () => {
    // ch1 hovering ch2's left zone = "before ch2" = no-op (ch1 is already there).
    // Previously this silently flipped to "after ch2", surprising the user.
    // Now returns null so no indicator/move occurs; user aims for the FAR side
    // of the neighbor to swap.
    const result = computeColumnDropTarget(
      "ch1",
      columnSlotId("ch2"),
      50, // left zone (would be "before ch2")
      50, // pointerY (middle of rect → "inside" zone for nest tests)
      rect,
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toBeNull();
  });

  it("returns null when hovering adjacent left-neighbor's right zone (no-op, no flip)", () => {
    // ch2 hovering ch1's right zone = "after ch1" = no-op (ch2 is already there).
    const result = computeColumnDropTarget(
      "ch2",
      columnSlotId("ch1"),
      150, // right zone (would be "after ch1")
      50, // pointerY (middle of rect → "inside" zone for nest tests)
      rect,
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toBeNull();
  });

  it("scene-drop Y-axis adjacent no-op: column landing back in its current slot inside scene's parent", () => {
    // Active column F is at index 0 in chapter ch's children, scene s1 at index 1.
    // Drop F on s1's top half → "before s1" → would land F at index 0 (its
    // current slot) — no-op rejected per isAdjacentColumnNoOp.
    const fpm: Record<string, string | null> = { ch: "root", F: "ch" };
    const ofs = [
      { id: "ch", parentId: "root" },
      { id: "F", parentId: "ch" },
      { id: "s1", parentId: "ch" },
    ];
    const result = computeColumnDropTarget(
      "F",
      "scene-drop-s1",
      100,
      10, // top → "before s1"
      { left: 0, width: 100, top: 0, height: 100 },
      fpm,
      ofs,
      { s1: "ch" },
      null,
    );
    expect(result).toBeNull();
  });

  it("dropping ch1 (idx=1) on ch2's right zone yields swap (after ch2) — the ergonomic swap path", () => {
    const result = computeColumnDropTarget(
      "ch1",
      columnSlotId("ch2"),
      150, // right zone of ch2
      50, // pointerY (middle of rect → "inside" zone for nest tests)
      rect,
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toEqual({ targetParentId: "root", afterId: "ch2" });
  });

  it("returns null when both sides would be no-op (only two columns adjacent — should never happen since target!=active is filtered)", () => {
    // Sanity: can't construct a real "both sides no-op" given target !== active and at least one direction is real.
    // This test just documents that a self-target is filtered earlier.
    const result = computeColumnDropTarget(
      "ch1",
      columnSlotId("ch1"),
      100,
      50, // pointerY (middle of rect → "inside" zone for nest tests)
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
      50, // pointerY (middle of rect → "inside" zone for nest tests)
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
      50, // pointerY (middle of rect → "inside" zone for nest tests)
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
      50, // pointerY (middle of rect → "inside" zone for nest tests)
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
      50, // pointerY (middle of rect → "inside" zone for nest tests)
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
      50, // pointerY (middle of rect → "inside" zone for nest tests)
      rect,
      fpm,
      ofs,
      sceneParentMap,
      null,
    );
    expect(result).toBeNull();
  });

  it("scene-drop Y-axis: dropping a column on a loose scene inside the same container reorders it within the container (Part stays in container)", () => {
    // Previously this branch rejected via target===containerId. With Y-axis
    // semantic, the dragged column simply becomes a sibling of the loose
    // scene inside the container — no "bubbling out" risk because the column
    // lands in the scene's parent, which IS the container.
    const fpm = { ...folderParentMap, X: null, ch1: "X" };
    const ofs = [
      { id: "X", parentId: null },
      { id: "ch1", parentId: "X" },
      { id: "loose1", parentId: "X" },
    ];
    const result = computeColumnDropTarget(
      "ch1",
      "scene-drop-loose1",
      100,
      80, // bottom → "after loose1"
      rect,
      fpm,
      ofs,
      { loose1: "X" },
      "X", // containerId
    );
    expect(result).toEqual({ targetParentId: "X", afterId: "loose1" });
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
      50, // pointerY (middle of rect → "inside" zone for nest tests)
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
      50, // pointerY (middle of rect → "inside" zone for nest tests)
      rect,
      fpm,
      ofs,
      {},
      null,
    );
    expect(result).toBeNull();
  });

  it("nests via column-empty drop zone of an empty folder column (regression: silently no-op'd as adjacent sibling)", () => {
    // The empty drop zone is rendered only when the target folder has NO
    // children. Previously the code resolved this to the enclosing folder and
    // ran the 3-zone sibling logic on the empty area's rect — when the empty
    // folder was an adjacent sibling, the resulting before/after was rejected
    // as a no-op and the drop did nothing. Now empty-folder drops are treated
    // as explicit nest targets.
    const result = computeColumnDropTarget(
      "ch1",
      columnEmptyId("ch2"), // ch2 has no children
      400, // any pointerX inside the empty zone
      50, // pointerY (middle of rect → "inside" zone for nest tests)
      { left: 300, width: 200, top: 0, height: 100 },
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toEqual({ targetParentId: "ch2", afterId: undefined });
  });

  it("rejects nesting into own column-empty drop zone", () => {
    const result = computeColumnDropTarget(
      "ch1",
      columnEmptyId("ch1"),
      100,
      50, // pointerY (middle of rect → "inside" zone for nest tests)
      rect,
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toBeNull();
  });

  it("rejects column-empty nest when active is already a direct child of the empty folder", () => {
    const fpm = { ...folderParentMap, sub1: "ch1" };
    const ofs = [...orderedFolders, { id: "sub1", parentId: "ch1" }];
    const result = computeColumnDropTarget(
      "sub1",
      columnEmptyId("ch1"),
      100,
      50, // pointerY (middle of rect → "inside" zone for nest tests)
      rect,
      fpm,
      ofs,
      sceneParentMap,
      null,
    );
    expect(result).toBeNull();
  });

  it("rejects cycle: column-empty drop of an ancestor onto its descendant", () => {
    const fpm: Record<string, string | null> = { A: null, B: "A", C: "B" };
    const ofs = [
      { id: "A", parentId: null },
      { id: "B", parentId: "A" },
      { id: "C", parentId: "B" },
    ];
    const result = computeColumnDropTarget(
      "A",
      columnEmptyId("C"),
      100,
      50, // pointerY (middle of rect → "inside" zone for nest tests)
      rect,
      fpm,
      ofs,
      {},
      null,
    );
    expect(result).toBeNull();
  });

  it("rejects column drop on column-empty-loose (loose area can't host a folder)", () => {
    const result = computeColumnDropTarget(
      "ch1",
      columnEmptyId("loose"),
      100,
      50, // pointerY (middle of rect → "inside" zone for nest tests)
      rect,
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toBeNull();
  });

  it("column-nest 3-zone: top 25% Y → before target as sibling", () => {
    // Drop ch3 in top zone of ch2's folder card → insert ch3 BEFORE ch2.
    // Predecessor among same-parent siblings (excluding active) is ch1.
    const result = computeColumnDropTarget(
      "ch3",
      columnNestId("ch2"),
      100, // pointerX irrelevant for nest 3-zone
      10, // pointerY: top of 100-height rect → "before" zone
      { left: 0, width: 200, top: 0, height: 100 },
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toEqual({ targetParentId: "root", afterId: "ch1" });
  });

  it("column-nest 3-zone: bottom 25% Y → after target as sibling", () => {
    const result = computeColumnDropTarget(
      "ch3",
      columnNestId("ch1"),
      100,
      90, // pointerY: bottom of 100-height rect → "after" zone
      { left: 0, width: 200, top: 0, height: 100 },
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toEqual({ targetParentId: "root", afterId: "ch1" });
  });

  it("column-nest 3-zone: middle 50% Y → inside (nest into target)", () => {
    // Drop ch1 into the middle of ch3's folder card → nest into ch3 (append).
    const result = computeColumnDropTarget(
      "ch1",
      columnNestId("ch3"),
      100,
      50, // middle
      { left: 0, width: 200, top: 0, height: 100 },
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toEqual({ targetParentId: "ch3", afterId: undefined });
  });

  it("column-nest 3-zone: top-zone on adjacent right sibling is a no-op (active would land back in its slot)", () => {
    // ch1 over ch2.top → "before ch2" — ch1 is already directly before ch2, no-op.
    const result = computeColumnDropTarget(
      "ch1",
      columnNestId("ch2"),
      100,
      10,
      { left: 0, width: 200, top: 0, height: 100 },
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toBeNull();
  });

  it("column-nest 3-zone: bottom-zone on adjacent left sibling is a no-op", () => {
    // ch2 over ch1.bottom → "after ch1" — ch2 is already directly after ch1, no-op.
    const result = computeColumnDropTarget(
      "ch2",
      columnNestId("ch1"),
      100,
      90,
      { left: 0, width: 200, top: 0, height: 100 },
      folderParentMap,
      orderedFolders,
      sceneParentMap,
      null,
    );
    expect(result).toBeNull();
  });

  it("column-nest 3-zone: before/after when target's parent differs from active's parent (cross-column reparenting)", () => {
    // ch_inner is inside ch1; dragging ch_outer (root child) onto ch_inner.top
    // should reparent ch_outer to ch1 (ch_inner's parent), placed before ch_inner.
    const fpm = { ...folderParentMap, ch_inner: "ch1", ch_outer: "root" };
    const ofs = [
      ...orderedFolders,
      { id: "ch_inner", parentId: "ch1" },
      { id: "ch_outer", parentId: "root" },
    ];
    const result = computeColumnDropTarget(
      "ch_outer",
      columnNestId("ch_inner"),
      100,
      10, // top zone → "before ch_inner"
      { left: 0, width: 200, top: 0, height: 100 },
      fpm,
      ofs,
      sceneParentMap,
      null,
    );
    // ch_inner has no sibling before it inside ch1 → predecessor null (prepend).
    expect(result).toEqual({ targetParentId: "ch1", afterId: null });
  });

  it("scene-drop Y-axis: predecessor resolution across interleaved siblings (column inserted between scene and folder)", () => {
    // Chapter ch has children [scene_a, folder_b, scene_c]. Dropping column
    // pa1 on scene_c's TOP half → "before scene_c" → predecessor among ch's
    // children excluding pa1 is folder_b (immediately preceding scene_c).
    const fpm: Record<string, string | null> = {
      ch: null,
      folder_b: "ch",
      pa1: null,
    };
    const orderedSiblings = [
      { id: "ch", parentId: null },
      { id: "scene_a", parentId: "ch" },
      { id: "folder_b", parentId: "ch" },
      { id: "scene_c", parentId: "ch" },
      { id: "pa1", parentId: null },
    ];
    const spm = { scene_a: "ch", scene_c: "ch" };
    const result = computeColumnDropTarget(
      "pa1",
      "scene-drop-scene_c",
      100,
      10, // top → "before scene_c"
      { left: 0, width: 100, top: 0, height: 100 },
      fpm,
      orderedSiblings,
      spm,
      null,
    );
    expect(result).toEqual({ targetParentId: "ch", afterId: "folder_b" });
  });

  it("scene-drop Y-axis: cycle prevention — scene's parent is descendant of active", () => {
    // A → B → C, scene_in_C.parent = C. Dragging A onto scene_in_C would
    // make A a child of C (a descendant of A) → cycle. Reject.
    const fpm: Record<string, string | null> = { A: null, B: "A", C: "B" };
    const ofs = [
      { id: "A", parentId: null },
      { id: "B", parentId: "A" },
      { id: "C", parentId: "B" },
    ];
    const result = computeColumnDropTarget(
      "A",
      "scene-drop-scene_in_C",
      100,
      50,
      { left: 0, width: 100, top: 0, height: 100 },
      fpm,
      ofs,
      { scene_in_C: "C" },
      null,
    );
    expect(result).toBeNull();
  });
});

describe("computeColumnDropIndicator", () => {
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
  const rect = { left: 0, width: 200, top: 0, height: 100 };

  it("shows nest indicator for column-empty drop zone of an empty folder", () => {
    const result = computeColumnDropIndicator(
      "ch1",
      columnEmptyId("ch2"),
      100,
      50, // pointerY (middle of rect → "inside" zone for nest tests)
      rect,
      sceneParentMap,
      folderParentMap,
      orderedFolders,
      null,
    );
    expect(result).toEqual({ targetId: "ch2", position: "nest" });
  });

  it("rejects nest indicator when target empty folder is the active itself", () => {
    const result = computeColumnDropIndicator(
      "ch1",
      columnEmptyId("ch1"),
      100,
      50, // pointerY (middle of rect → "inside" zone for nest tests)
      rect,
      sceneParentMap,
      folderParentMap,
      orderedFolders,
      null,
    );
    expect(result).toBeNull();
  });

  it("rejects column-empty nest indicator when active is already a direct child", () => {
    const fpm = { ...folderParentMap, sub1: "ch1" };
    const ofs = [...orderedFolders, { id: "sub1", parentId: "ch1" }];
    const result = computeColumnDropIndicator(
      "sub1",
      columnEmptyId("ch1"),
      100,
      50, // pointerY (middle of rect → "inside" zone for nest tests)
      rect,
      sceneParentMap,
      fpm,
      ofs,
      null,
    );
    expect(result).toBeNull();
  });

  it("rejects column-empty nest indicator for descendant-cycle (mirror of target-side check)", () => {
    const fpm: Record<string, string | null> = { A: null, B: "A", C: "B" };
    const ofs = [
      { id: "A", parentId: null },
      { id: "B", parentId: "A" },
      { id: "C", parentId: "B" },
    ];
    const result = computeColumnDropIndicator(
      "A",
      columnEmptyId("C"),
      100,
      50, // pointerY (middle of rect → "inside" zone for nest tests)
      rect,
      {},
      fpm,
      ofs,
      null,
    );
    expect(result).toBeNull();
  });

  it("column-nest 3-zone indicator: top 25% Y → before", () => {
    const result = computeColumnDropIndicator(
      "ch3",
      columnNestId("ch2"),
      100,
      10, // top zone
      { left: 0, width: 200, top: 0, height: 100 },
      sceneParentMap,
      folderParentMap,
      orderedFolders,
      null,
    );
    expect(result).toEqual({ targetId: "ch2", position: "before" });
  });

  it("column-nest 3-zone indicator: bottom 25% Y → after", () => {
    const result = computeColumnDropIndicator(
      "ch3",
      columnNestId("ch1"),
      100,
      90, // bottom zone
      { left: 0, width: 200, top: 0, height: 100 },
      sceneParentMap,
      folderParentMap,
      orderedFolders,
      null,
    );
    expect(result).toEqual({ targetId: "ch1", position: "after" });
  });

  it("column-nest 3-zone indicator: adjacent no-op (top zone on right-neighbor)", () => {
    const result = computeColumnDropIndicator(
      "ch1",
      columnNestId("ch2"),
      100,
      10,
      { left: 0, width: 200, top: 0, height: 100 },
      sceneParentMap,
      folderParentMap,
      orderedFolders,
      null,
    );
    expect(result).toBeNull();
  });

  it("scene-drop Y-axis indicator: top half → before scene", () => {
    const result = computeColumnDropIndicator(
      "ch1",
      "scene-drop-s1",
      100,
      10,
      { left: 0, width: 200, top: 0, height: 100 },
      { s1: "ch3" },
      folderParentMap,
      orderedFolders,
      null,
    );
    expect(result).toEqual({ targetId: "s1", position: "before" });
  });

  it("scene-drop Y-axis indicator: bottom half → after scene", () => {
    const result = computeColumnDropIndicator(
      "ch1",
      "scene-drop-s1",
      100,
      90,
      { left: 0, width: 200, top: 0, height: 100 },
      { s1: "ch3" },
      folderParentMap,
      orderedFolders,
      null,
    );
    expect(result).toEqual({ targetId: "s1", position: "after" });
  });

  it("ignores column-empty-loose (no nest indicator)", () => {
    const result = computeColumnDropIndicator(
      "ch1",
      columnEmptyId("loose"),
      100,
      50, // pointerY (middle of rect → "inside" zone for nest tests)
      rect,
      sceneParentMap,
      folderParentMap,
      orderedFolders,
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

describe("resolveSceneDragMode", () => {
  const threshold = 40;

  it("starts in axis-locked when initial deltaX is 0", () => {
    expect(resolveSceneDragMode("axis-locked", 0, threshold)).toBe(
      "axis-locked",
    );
  });

  it("stays axis-locked while |deltaX| < threshold", () => {
    expect(resolveSceneDragMode("axis-locked", 20, threshold)).toBe(
      "axis-locked",
    );
    expect(resolveSceneDragMode("axis-locked", -39, threshold)).toBe(
      "axis-locked",
    );
  });

  it("transitions to free when |deltaX| >= threshold", () => {
    expect(resolveSceneDragMode("axis-locked", 40, threshold)).toBe("free");
    expect(resolveSceneDragMode("axis-locked", -50, threshold)).toBe("free");
  });

  it("hysteresis: free never reverts to axis-locked", () => {
    expect(resolveSceneDragMode("free", 0, threshold)).toBe("free");
    expect(resolveSceneDragMode("free", 5, threshold)).toBe("free");
  });
});

describe("computeSceneAxisLockTarget", () => {
  // Three siblings stacked vertically in ch1; sibling rect tops at 0, 100, 200
  // (each card height 80, gap 20)
  const orderedScenes = [
    { id: "s1", parentId: "ch1" },
    { id: "s2", parentId: "ch1" },
    { id: "s3", parentId: "ch1" },
    { id: "s4", parentId: "ch2" }, // different parent — must be ignored
  ];
  const rects = {
    s1: { top: 0, bottom: 80 },
    s2: { top: 100, bottom: 180 },
    s3: { top: 200, bottom: 280 },
    s4: { top: 0, bottom: 80 },
  };

  it("returns null when pointer stays within active's own rect", () => {
    // Dragging s2; pointer at its midpoint (140)
    expect(
      computeSceneAxisLockTarget("s2", 140, orderedScenes, rects),
    ).toBeNull();
  });

  it("swap with upper neighbor when pointer crosses upper sibling midpoint", () => {
    // Dragging s2 up; s1 midpoint = 40. pointerY = 30 (above mid) → land before s1
    const result = computeSceneAxisLockTarget("s2", 30, orderedScenes, rects);
    expect(result).toEqual({ targetParentId: "ch1", afterId: null });
  });

  it("swap with lower neighbor when pointer crosses lower sibling midpoint", () => {
    // Dragging s2 down; s3 midpoint = 240. pointerY = 250 → land after s3
    const result = computeSceneAxisLockTarget("s2", 250, orderedScenes, rects);
    expect(result).toEqual({ targetParentId: "ch1", afterId: "s3" });
  });

  it("skip past multiple neighbors when pointer is far up", () => {
    // Dragging s3 up past both s1 and s2 (s1 mid = 40, pointerY 20)
    const result = computeSceneAxisLockTarget("s3", 20, orderedScenes, rects);
    expect(result).toEqual({ targetParentId: "ch1", afterId: null });
  });

  it("skip past multiple neighbors when pointer is far down", () => {
    // Dragging s1 down past s2 and s3 (s3 mid = 240, pointerY = 260)
    const result = computeSceneAxisLockTarget("s1", 260, orderedScenes, rects);
    expect(result).toEqual({ targetParentId: "ch1", afterId: "s3" });
  });

  it("ignores siblings in a different parent", () => {
    // s2 in ch1; s4 in ch2 — pointer way down shouldn't pick s4
    const result = computeSceneAxisLockTarget("s2", 999, orderedScenes, rects);
    expect(result).toEqual({ targetParentId: "ch1", afterId: "s3" });
  });

  it("returns null for an only-child scene (no reorder possible)", () => {
    const single = [{ id: "x1", parentId: "p1" }];
    expect(
      computeSceneAxisLockTarget("x1", 0, single, {
        x1: { top: 0, bottom: 50 },
      }),
    ).toBeNull();
  });

  it("returns null when active scene id is unknown", () => {
    expect(
      computeSceneAxisLockTarget("ghost", 50, orderedScenes, rects),
    ).toBeNull();
  });

  it("returns null when no sibling rects are provided", () => {
    expect(computeSceneAxisLockTarget("s2", 50, orderedScenes, {})).toBeNull();
  });
});

describe("computeSceneAxisLockShifts", () => {
  // Same fixture as above
  const orderedScenes = [
    { id: "s1", parentId: "ch1" },
    { id: "s2", parentId: "ch1" },
    { id: "s3", parentId: "ch1" },
  ];
  const rects = {
    s1: { top: 0, bottom: 80 },
    s2: { top: 100, bottom: 180 },
    s3: { top: 200, bottom: 280 },
  };

  it("returns empty map when no displacement", () => {
    const shifts = computeSceneAxisLockShifts("s2", 140, orderedScenes, rects);
    expect(shifts.size).toBe(0);
  });

  it("shifts upper sibling DOWN when active moves above it", () => {
    // Dragging s2 above s1 mid (pointer=30, mid=40) → s1 must shift down to
    // make room above it for s2
    const shifts = computeSceneAxisLockShifts("s2", 30, orderedScenes, rects);
    expect(shifts.get("s1")).toBe("down");
    expect(shifts.has("s3")).toBe(false);
  });

  it("shifts lower sibling UP when active moves below it", () => {
    // Dragging s2 below s3 mid (pointer=250, s3 mid=240) → s3 shifts up
    const shifts = computeSceneAxisLockShifts("s2", 250, orderedScenes, rects);
    expect(shifts.get("s3")).toBe("up");
    expect(shifts.has("s1")).toBe(false);
  });

  it("shifts multiple siblings when active jumps two slots", () => {
    // Dragging s3 up past both s1 and s2 → both shift down
    const shifts = computeSceneAxisLockShifts("s3", 20, orderedScenes, rects);
    expect(shifts.get("s1")).toBe("down");
    expect(shifts.get("s2")).toBe("down");
  });

  it("excludes active itself from the shift map", () => {
    const shifts = computeSceneAxisLockShifts("s2", 30, orderedScenes, rects);
    expect(shifts.has("s2")).toBe(false);
  });
});

describe("computeSceneAxisLockPxOffsets", () => {
  // Mixed-height column: active s2 is 80px tall, neighbors vary.
  // gap = 8. Positions (top..bottom):
  //   s1: 0..50    (h=50)
  //   s2: 58..138  (h=80)  ← active
  //   s3: 146..246 (h=100)
  //   s4: 254..324 (h=70)
  const orderedScenes = [
    { id: "s1", parentId: "ch1" },
    { id: "s2", parentId: "ch1" },
    { id: "s3", parentId: "ch1" },
    { id: "s4", parentId: "ch1" },
  ];
  const rects = {
    s1: { top: 0, bottom: 50 },
    s2: { top: 58, bottom: 138 },
    s3: { top: 146, bottom: 246 },
    s4: { top: 254, bottom: 324 },
  };
  const gap = 8;
  const activeSlot = 80 + gap; // active's height + gap

  it("returns empty when no displacement", () => {
    // pointer inside s2 (its midpoint 98)
    const m = computeSceneAxisLockPxOffsets(
      "s2",
      98,
      orderedScenes,
      rects,
      gap,
    );
    expect(m.size).toBe(0);
  });

  it("active shifts by lower-sibling slot height, sibling shifts by active slot", () => {
    // s3 midpoint = 196. pointer 200 → active s2 passes s3.
    const m = computeSceneAxisLockPxOffsets(
      "s2",
      200,
      orderedScenes,
      rects,
      gap,
    );
    // s3 moves up by active's slot
    expect(m.get("s3")).toBe(-activeSlot);
    // s2 (active) moves down by s3's slot (100 + 8)
    expect(m.get("s2")).toBe(100 + gap);
    // s1, s4 not in map
    expect(m.has("s1")).toBe(false);
    expect(m.has("s4")).toBe(false);
  });

  it("active offset is the SUM of passed-sibling slot heights", () => {
    // pointer 260 → past s3 (mid 196) and s4 (mid 289). Wait s4 mid = 289 > 260.
    // Adjust to pointer 300 to pass both.
    const m = computeSceneAxisLockPxOffsets(
      "s2",
      300,
      orderedScenes,
      rects,
      gap,
    );
    // s3 shifts up by active slot
    expect(m.get("s3")).toBe(-activeSlot);
    // s4 also shifts up by active slot — vacancy propagates at active's slot size
    expect(m.get("s4")).toBe(-activeSlot);
    // active moves down by sum of s3's slot + s4's slot
    expect(m.get("s2")).toBe(100 + gap + 70 + gap);
  });

  it("upward pass: active moves up by upper-sibling slot, sibling moves down by active slot", () => {
    // s1 midpoint = 25. pointer 20 → active passes s1 upward.
    const m = computeSceneAxisLockPxOffsets(
      "s2",
      20,
      orderedScenes,
      rects,
      gap,
    );
    expect(m.get("s1")).toBe(activeSlot);
    // s2 moves up by -(s1.height + gap) = -(50 + 8)
    expect(m.get("s2")).toBe(-(50 + gap));
  });

  it("returns empty when active rect is missing (no height to compute slot)", () => {
    const m = computeSceneAxisLockPxOffsets(
      "s2",
      200,
      orderedScenes,
      { s3: rects.s3 },
      gap,
    );
    expect(m.size).toBe(0);
  });
});

describe("computeSceneAxisLockPxOffsets — folder-mixed siblings", () => {
  // Regression: axis-lock used to filter siblings to nodeType=scene only, which
  // ignored the vertical space a sibling folder card occupies. When dragging a
  // scene past an interleaved folder, the folder must shift too so the visual
  // matches the post-drop sort order. `orderedScenes` here is the misnomer —
  // the function treats it as "ordered siblings of the active node's parent"
  // regardless of node type.
  //
  // Layout (all parentId="ch1"):
  //   sceneA: 0..60     (h=60)  ← active
  //   folderF: 68..148  (h=80)
  //   sceneB: 156..236  (h=80)
  const orderedSiblings = [
    { id: "sceneA", parentId: "ch1" },
    { id: "folderF", parentId: "ch1" },
    { id: "sceneB", parentId: "ch1" },
  ];
  const rects = {
    sceneA: { top: 0, bottom: 60 },
    folderF: { top: 68, bottom: 148 },
    sceneB: { top: 156, bottom: 236 },
  };
  const gap = 8;
  const activeSlot = 60 + gap; // sceneA's slot

  it("shifts folder card up when active scene passes it downward", () => {
    // pointer past folderF mid (108) but not yet past sceneB mid (196)
    const m = computeSceneAxisLockPxOffsets(
      "sceneA",
      120,
      orderedSiblings,
      rects,
      gap,
    );
    expect(m.get("folderF")).toBe(-activeSlot);
    expect(m.has("sceneB")).toBe(false);
    // active moves down by folderF's slot (80 + 8)
    expect(m.get("sceneA")).toBe(80 + gap);
  });

  it("active offset accumulates folder + scene slots when passing both", () => {
    // pointer past both folderF mid (108) and sceneB mid (196)
    const m = computeSceneAxisLockPxOffsets(
      "sceneA",
      210,
      orderedSiblings,
      rects,
      gap,
    );
    expect(m.get("folderF")).toBe(-activeSlot);
    expect(m.get("sceneB")).toBe(-activeSlot);
    // active moves down by folderF's slot + sceneB's slot
    expect(m.get("sceneA")).toBe(80 + gap + 80 + gap);
  });

  it("excludes descendants of an open folder from siblings (different parentId)", () => {
    // sceneInside is a child of folderF, NOT a sibling of sceneA. Even if it
    // appears in the rendered list (folderF expanded), it must not participate
    // in axis-lock against sceneA — the caller is responsible for passing only
    // same-parent items, and computeSceneAxisLockPxOffsets relies on that.
    const orderedWithDescendant = [
      ...orderedSiblings,
      { id: "sceneInside", parentId: "folderF" },
    ];
    const m = computeSceneAxisLockPxOffsets(
      "sceneA",
      120,
      orderedWithDescendant,
      { ...rects, sceneInside: { top: 100, bottom: 130 } },
      gap,
    );
    expect(m.has("sceneInside")).toBe(false);
  });
});

describe("computeColumnAxisLockTarget", () => {
  // Three folder columns in containerId=root, laid out horizontally.
  // Card width 200, gap 20 → lefts at 0, 220, 440.
  const orderedFolders = [
    { id: "f1", parentId: "root" },
    { id: "f2", parentId: "root" },
    { id: "f3", parentId: "root" },
    { id: "f4", parentId: "other" }, // different parent — ignored
  ];
  const rects = {
    f1: { left: 0, right: 200 },
    f2: { left: 220, right: 420 },
    f3: { left: 440, right: 640 },
    f4: { left: 0, right: 200 },
  };

  it("returns null when pointer stays within active's own rect", () => {
    expect(
      computeColumnAxisLockTarget("f2", 320, orderedFolders, rects),
    ).toBeNull();
  });

  it("swap with left neighbor when pointer crosses left sibling midpoint", () => {
    // Dragging f2 left; f1 mid = 100. pointerX = 80 → land before f1
    const result = computeColumnAxisLockTarget("f2", 80, orderedFolders, rects);
    expect(result).toEqual({ targetParentId: "root", afterId: null });
  });

  it("swap with right neighbor when pointer crosses right sibling midpoint", () => {
    // Dragging f2 right; f3 mid = 540. pointerX = 560 → land after f3
    const result = computeColumnAxisLockTarget(
      "f2",
      560,
      orderedFolders,
      rects,
    );
    expect(result).toEqual({ targetParentId: "root", afterId: "f3" });
  });

  it("skip past multiple neighbors when pointer is far left", () => {
    // Dragging f3 left past both f1 and f2 (f1 mid 100, pointerX 50)
    const result = computeColumnAxisLockTarget("f3", 50, orderedFolders, rects);
    expect(result).toEqual({ targetParentId: "root", afterId: null });
  });

  it("skip past multiple neighbors when pointer is far right", () => {
    // Dragging f1 right past f2 and f3 (f3 mid 540, pointerX 600)
    const result = computeColumnAxisLockTarget(
      "f1",
      600,
      orderedFolders,
      rects,
    );
    expect(result).toEqual({ targetParentId: "root", afterId: "f3" });
  });

  it("ignores siblings in a different parent", () => {
    const result = computeColumnAxisLockTarget(
      "f2",
      9999,
      orderedFolders,
      rects,
    );
    expect(result).toEqual({ targetParentId: "root", afterId: "f3" });
  });

  it("returns null for an only-child folder (no reorder possible)", () => {
    const single = [{ id: "x1", parentId: "p1" }];
    expect(
      computeColumnAxisLockTarget("x1", 0, single, {
        x1: { left: 0, right: 200 },
      }),
    ).toBeNull();
  });

  it("returns null when active folder id is unknown", () => {
    expect(
      computeColumnAxisLockTarget("ghost", 50, orderedFolders, rects),
    ).toBeNull();
  });

  it("returns null when no sibling rects are provided", () => {
    expect(
      computeColumnAxisLockTarget("f2", 50, orderedFolders, {}),
    ).toBeNull();
  });

  it("handles project-root siblings (parentId === null)", () => {
    const rootSiblings = [
      { id: "f1", parentId: null },
      { id: "f2", parentId: null },
      { id: "f3", parentId: null },
    ];
    // Dragging f2 right past f3 mid (540) at pointerX 560
    const result = computeColumnAxisLockTarget("f2", 560, rootSiblings, rects);
    expect(result).toEqual({ targetParentId: null, afterId: "f3" });
  });
});

describe("computeColumnAxisLockShifts", () => {
  const orderedFolders = [
    { id: "f1", parentId: "root" },
    { id: "f2", parentId: "root" },
    { id: "f3", parentId: "root" },
  ];
  const rects = {
    f1: { left: 0, right: 200 },
    f2: { left: 220, right: 420 },
    f3: { left: 440, right: 640 },
  };

  it("returns empty map when no displacement", () => {
    const shifts = computeColumnAxisLockShifts(
      "f2",
      320,
      orderedFolders,
      rects,
    );
    expect(shifts.size).toBe(0);
  });

  it("shifts left sibling RIGHT when active moves left of it", () => {
    // Dragging f2 left past f1 mid (pointerX=80, f1 mid=100) → f1 shifts right
    const shifts = computeColumnAxisLockShifts("f2", 80, orderedFolders, rects);
    expect(shifts.get("f1")).toBe("right");
    expect(shifts.has("f3")).toBe(false);
  });

  it("shifts right sibling LEFT when active moves right of it", () => {
    // Dragging f2 right past f3 mid (pointerX=560, f3 mid=540) → f3 shifts left
    const shifts = computeColumnAxisLockShifts(
      "f2",
      560,
      orderedFolders,
      rects,
    );
    expect(shifts.get("f3")).toBe("left");
    expect(shifts.has("f1")).toBe(false);
  });

  it("shifts multiple siblings when active jumps two slots", () => {
    // Dragging f3 left past both f1 and f2 → both shift right
    const shifts = computeColumnAxisLockShifts("f3", 50, orderedFolders, rects);
    expect(shifts.get("f1")).toBe("right");
    expect(shifts.get("f2")).toBe("right");
  });

  it("excludes active itself from the shift map", () => {
    const shifts = computeColumnAxisLockShifts("f2", 80, orderedFolders, rects);
    expect(shifts.has("f2")).toBe(false);
  });
});

describe("computeColumnAxisLockPxOffsets", () => {
  // Mixed-width row: active f2 is 200px, neighbors vary.
  // gap = 12. Lefts/rights:
  //   f1: 0..150    (w=150)
  //   f2: 162..362  (w=200) ← active
  //   f3: 374..624  (w=250)
  //   f4: 636..811  (w=175)
  const orderedFolders = [
    { id: "f1", parentId: "root" },
    { id: "f2", parentId: "root" },
    { id: "f3", parentId: "root" },
    { id: "f4", parentId: "root" },
  ];
  const rects = {
    f1: { left: 0, right: 150 },
    f2: { left: 162, right: 362 },
    f3: { left: 374, right: 624 },
    f4: { left: 636, right: 811 },
  };
  const gap = 12;
  const activeSlot = 200 + gap;

  it("returns empty when no displacement", () => {
    const m = computeColumnAxisLockPxOffsets(
      "f2",
      262,
      orderedFolders,
      rects,
      gap,
    );
    expect(m.size).toBe(0);
  });

  it("active shifts by right-sibling slot width, sibling shifts by active slot", () => {
    // f3 midpoint = 499. pointer 510 → active f2 passes f3 toward the right.
    const m = computeColumnAxisLockPxOffsets(
      "f2",
      510,
      orderedFolders,
      rects,
      gap,
    );
    expect(m.get("f3")).toBe(-activeSlot);
    // f2 (active) shifts right by f3's slot (250 + 12)
    expect(m.get("f2")).toBe(250 + gap);
    expect(m.has("f1")).toBe(false);
    expect(m.has("f4")).toBe(false);
  });

  it("active offset is the SUM of passed-sibling slot widths", () => {
    // pointer 800 → past f3 (mid 499) and f4 (mid 723.5).
    const m = computeColumnAxisLockPxOffsets(
      "f2",
      800,
      orderedFolders,
      rects,
      gap,
    );
    expect(m.get("f3")).toBe(-activeSlot);
    expect(m.get("f4")).toBe(-activeSlot);
    // active shifts right by sum of f3's slot + f4's slot
    expect(m.get("f2")).toBe(250 + gap + 175 + gap);
  });

  it("leftward pass: active moves left by left-sibling slot, sibling moves right by active slot", () => {
    // f1 midpoint = 75. pointerX 60 → active passes f1 toward the left.
    const m = computeColumnAxisLockPxOffsets(
      "f2",
      60,
      orderedFolders,
      rects,
      gap,
    );
    expect(m.get("f1")).toBe(activeSlot);
    // f2 moves left by -(f1 width + gap) = -(150 + 12)
    expect(m.get("f2")).toBe(-(150 + gap));
  });

  it("returns empty when active rect is missing (no width to compute slot)", () => {
    const m = computeColumnAxisLockPxOffsets(
      "f2",
      510,
      orderedFolders,
      { f3: rects.f3 },
      gap,
    );
    expect(m.size).toBe(0);
  });
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

describe("findFolderBlockLastVisibleId", () => {
  // Tree:
  //   ch1 (folder, parent=root)
  //     fA (folder, parent=ch1)
  //       s1 (scene, parent=fA)
  //       fB (folder, parent=fA)
  //         s2 (scene, parent=fB)
  //     s3 (scene, parent=ch1)
  const nodes = [
    makeNodeData({
      id: "root",
      nodeType: "folder",
      parentId: null,
      sortOrder: "a0",
    }),
    makeNodeData({
      id: "ch1",
      nodeType: "folder",
      parentId: "root",
      sortOrder: "a1",
    }),
    makeNodeData({
      id: "fA",
      nodeType: "folder",
      parentId: "ch1",
      sortOrder: "a1",
    }),
    makeNodeData({
      id: "s1",
      nodeType: "scene",
      parentId: "fA",
      sortOrder: "a1",
    }),
    makeNodeData({
      id: "fB",
      nodeType: "folder",
      parentId: "fA",
      sortOrder: "a2",
    }),
    makeNodeData({
      id: "s2",
      nodeType: "scene",
      parentId: "fB",
      sortOrder: "a1",
    }),
    makeNodeData({
      id: "s3",
      nodeType: "scene",
      parentId: "ch1",
      sortOrder: "a2",
    }),
  ];

  it("returns null for an empty folder", () => {
    const empty = [
      makeNodeData({
        id: "f1",
        nodeType: "folder",
        parentId: null,
        sortOrder: "a0",
      }),
    ];
    expect(findFolderBlockLastVisibleId("f1", empty, new Set())).toBeNull();
  });

  it("returns null when the folder itself is collapsed", () => {
    expect(
      findFolderBlockLastVisibleId("fA", nodes, new Set(["fA"])),
    ).toBeNull();
  });

  it("returns the deepest right-most scene for a fully expanded tree", () => {
    // fA expanded, fB expanded → last visible node inside fA's block is s2.
    expect(findFolderBlockLastVisibleId("fA", nodes, new Set())).toBe("s2");
  });

  it("returns the collapsed inner folder card when its contents are hidden", () => {
    // fA expanded, fB collapsed → fB card is still visible, but s2 is not.
    // Block ends at the fB card.
    expect(findFolderBlockLastVisibleId("fA", nodes, new Set(["fB"]))).toBe(
      "fB",
    );
  });

  it("returns the deepest descendant when last child is a scene", () => {
    // ch1's last visible direct child is s3 (a scene).
    expect(findFolderBlockLastVisibleId("ch1", nodes, new Set())).toBe("s3");
  });

  it("returns the deepest right-most descendant when last child is an expanded folder", () => {
    // Move s3 BEFORE fA so the last child of ch1 is fA (an expanded folder).
    // Use the existing nodes but with reversed sortOrders.
    const reordered = nodes.map((n) => {
      if (n.id === "fA") return { ...n, sortOrder: "a2" };
      if (n.id === "s3") return { ...n, sortOrder: "a1" };
      return n;
    });
    expect(findFolderBlockLastVisibleId("ch1", reordered, new Set())).toBe(
      "s2",
    );
  });
});
