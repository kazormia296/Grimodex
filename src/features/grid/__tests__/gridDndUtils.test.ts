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
  const parentMap: Record<string, string | null> = {
    s1: "ch1",
    s2: "ch1",
    s3: "ch2",
  };
  const rect = { top: 100, height: 60 };

  it("returns null when overId is empty", () => {
    expect(
      computeSceneDropTarget("s1", "", 120, rect, parentMap, "root"),
    ).toBeNull();
  });

  it("returns null when dragging scene over itself", () => {
    expect(
      computeSceneDropTarget(
        "s1",
        sceneDroppableId("s1"),
        120,
        rect,
        parentMap,
        "root",
      ),
    ).toBeNull();
  });

  it("inserts before target when pointer is above midpoint", () => {
    const result = computeSceneDropTarget(
      "s1",
      sceneDroppableId("s2"),
      110, // below rect.top=100, above mid=130
      rect,
      parentMap,
      "root",
    );
    expect(result).toEqual({ targetParentId: "ch1", afterId: null });
  });

  it("inserts after target when pointer is below midpoint", () => {
    const result = computeSceneDropTarget(
      "s1",
      sceneDroppableId("s3"),
      145, // above rect.top+height=160, below mid=130
      rect,
      parentMap,
      "root",
    );
    expect(result).toEqual({ targetParentId: "ch2", afterId: "s3" });
  });

  it("drops to column-end returns folder as targetParentId", () => {
    const result = computeSceneDropTarget(
      "s1",
      columnEndId("ch2"),
      0,
      rect,
      parentMap,
      "root",
    );
    expect(result).toEqual({ targetParentId: "ch2", afterId: null });
  });

  it("drops to column-empty-loose returns containerId as targetParentId", () => {
    const result = computeSceneDropTarget(
      "s1",
      columnEmptyId("loose"),
      0,
      rect,
      parentMap,
      "root",
    );
    expect(result).toEqual({ targetParentId: "root", afterId: null });
  });

  it("drops to column-end-loose returns containerId as targetParentId", () => {
    const result = computeSceneDropTarget(
      "s1",
      columnEndId("loose"),
      0,
      rect,
      parentMap,
      "root",
    );
    expect(result).toEqual({ targetParentId: "root", afterId: null });
  });

  it("drops to empty chapter column", () => {
    const result = computeSceneDropTarget(
      "s1",
      columnEmptyId("ch3"),
      0,
      rect,
      parentMap,
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

  it("returns null when overId is empty", () => {
    expect(computeColumnDropTarget("ch1", "", folderParentMap)).toBeNull();
  });

  it("returns null when dropping column on itself", () => {
    expect(
      computeColumnDropTarget("ch1", columnSlotId("ch1"), folderParentMap),
    ).toBeNull();
  });

  it("inserts column after target", () => {
    const result = computeColumnDropTarget(
      "ch1",
      columnSlotId("ch3"),
      folderParentMap,
    );
    expect(result).toEqual({ targetParentId: "root", afterId: "ch3" });
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
});
