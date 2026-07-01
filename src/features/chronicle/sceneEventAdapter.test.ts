import { describe, it, expect } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";
import {
  SCENE_EVENT_PREFIX,
  sceneEventId,
  isSceneEventId,
  sceneIdFromEventId,
  buildSceneEventRow,
  deriveSceneEventRows,
} from "./sceneEventAdapter";

function scene(over: Partial<TreeNodeData> = {}): TreeNodeData {
  return {
    id: "n1",
    projectId: "p1",
    parentId: null,
    nodeType: "scene",
    title: "旅立ち",
    synopsis: "村を発つ",
    intent: null,
    sortOrder: "a0",
    status: "draft",
    storyTimeOrder: "a5",
    storyTimeLabel: null,
    povCharacterId: "char-1",
    locationId: "loc-1",
    chronicleStartTime: 100,
    chronicleStartMinute: 30,
    chronicleStartGranularity: "day",
    chronicleEndTime: null,
    chronicleEndMinute: null,
    chronicleEndGranularity: "none",
    chroniclePrecision: "approx",
    charCount: 0,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...over,
  };
}

describe("scene-event id namespace", () => {
  it("sceneEventId は scene: 接頭辞を付ける", () => {
    expect(sceneEventId("abc")).toBe(`${SCENE_EVENT_PREFIX}abc`);
  });
  it("isSceneEventId は scene: id のみ真", () => {
    expect(isSceneEventId("scene:abc")).toBe(true);
    expect(isSceneEventId("550e8400-uuid")).toBe(false);
    expect(isSceneEventId("evt::char-1")).toBe(false); // レーン複製 id は別物
  });
  it("sceneIdFromEventId は接頭辞を剥がす（非 scene id はそのまま）", () => {
    expect(sceneIdFromEventId("scene:abc")).toBe("abc");
    expect(sceneIdFromEventId("plain")).toBe("plain");
  });
});

describe("buildSceneEventRow", () => {
  it("シーンのプロパティを EventRow 形へ写像する", () => {
    const row = buildSceneEventRow(scene());
    expect(row.id).toBe("scene:n1");
    expect(row.projectId).toBe("p1");
    expect(row.title).toBe("旅立ち");
    expect(row.note).toBe("村を発つ"); // synopsis → note
    expect(row.detail).toBeNull();
    expect(row.primaryCodexId).toBe("char-1"); // POV → lane
    expect(row.locationCodexId).toBe("loc-1");
    expect(row.startTime).toBe(100);
    expect(row.endTime).toBeNull(); // 点
    expect(row.startMinute).toBe(30);
    expect(row.startGranularity).toBe("day");
    expect(row.precision).toBe("approx");
    expect(row.kind).toBe("generic"); // シーンは誕生/死亡にならない
    expect(row.secret).toBe(false);
    expect(row.revealSceneId).toBeNull();
    expect(row.ordinal).toBe("a5"); // storyTimeOrder を流用
  });

  it("欠損 synopsis/POV/location は null、粒度/確度は既定へ", () => {
    const row = buildSceneEventRow(
      scene({
        synopsis: null,
        povCharacterId: null,
        locationId: null,
        storyTimeOrder: null,
        chronicleStartGranularity: undefined,
        chroniclePrecision: undefined,
      }),
    );
    expect(row.note).toBeNull();
    expect(row.primaryCodexId).toBeNull();
    expect(row.locationCodexId).toBeNull();
    expect(row.ordinal).toBe("a0");
    expect(row.startGranularity).toBe("none");
    expect(row.precision).toBe("exact");
  });

  it("chronicleEndTime があれば期間になる", () => {
    const row = buildSceneEventRow(scene({ chronicleEndTime: 200 }));
    expect(row.endTime).toBe(200);
  });
});

describe("deriveSceneEventRows", () => {
  it("作中日付を持つ非アーカイブのシーンのみを EventRow 化する", () => {
    const nodes: TreeNodeData[] = [
      scene({ id: "s1", chronicleStartTime: 10 }),
      scene({ id: "s2", chronicleStartTime: null }), // 日付なし=除外
      scene({ id: "s3", chronicleStartTime: 20, archivedAt: "2026-06-01" }), // アーカイブ=除外
      scene({ id: "f1", nodeType: "folder", chronicleStartTime: 5 }), // 非シーン=除外
      scene({ id: "note1", nodeType: "note", chronicleStartTime: 5 }), // note=除外
    ];
    const rows = deriveSceneEventRows(nodes);
    expect(rows.map((r) => r.id)).toEqual(["scene:s1"]);
  });

  it("0 件でも安全（空配列）", () => {
    expect(deriveSceneEventRows([])).toEqual([]);
  });
});
