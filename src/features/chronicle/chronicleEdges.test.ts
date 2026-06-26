import { describe, it, expect } from "vitest";
import { eventPositions, buildCausalEdges } from "./chronicleEdges";
import type { ChronicleLaneModel } from "./chronicleLaneModel";

const model: ChronicleLaneModel = {
  laneHeight: 40,
  contentHeight: 80,
  lanes: [
    {
      codexId: "alice",
      name: "Alice",
      y: 20,
      markers: [
        {
          eventId: "e1",
          ordinal: "a0",
          precision: "exact",
          isOffpage: false,
          isInterval: false,
        },
      ],
    },
    {
      codexId: "bob",
      name: "Bob",
      y: 60,
      markers: [
        {
          eventId: "e2",
          ordinal: "a1",
          precision: "exact",
          isOffpage: false,
          isInterval: false,
        },
      ],
    },
  ],
  unassigned: [
    {
      eventId: "u1",
      ordinal: "a2",
      precision: "exact",
      isOffpage: false,
      isInterval: false,
    },
  ],
};

const xById = new Map([
  ["e1", 100],
  ["e2", 200],
  ["u1", 300],
]);

describe("eventPositions", () => {
  it("レーン marker は (x, lane.y)、未割当は contentHeight+laneHeight/2", () => {
    const pos = eventPositions(model, xById);
    expect(pos.get("e1")).toEqual({ x: 100, y: 20 });
    expect(pos.get("e2")).toEqual({ x: 200, y: 60 });
    expect(pos.get("u1")).toEqual({ x: 300, y: 80 + 20 });
  });
  it("x が無い event は除外", () => {
    const pos = eventPositions(model, new Map([["e1", 100]]));
    expect(pos.has("e2")).toBe(false);
  });
});

describe("buildCausalEdges", () => {
  it("両端の位置が揃うエッジのみ幾何化（conflict 判定込み）", () => {
    const pos = eventPositions(model, xById);
    const edges = buildCausalEdges(
      [
        { causeId: "e1", effectId: "e2" },
        { causeId: "e2", effectId: "missing" }, // 片端欠落 → 除外
      ],
      pos,
      new Set(["e1|e2"]),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({
      causeId: "e1",
      effectId: "e2",
      x1: 100,
      y1: 20,
      x2: 200,
      y2: 60,
      conflict: true,
    });
  });

  it("決定的順序 (causeId,effectId 昇順)", () => {
    const pos = eventPositions(model, xById);
    const edges = buildCausalEdges(
      [
        { causeId: "e2", effectId: "u1" },
        { causeId: "e1", effectId: "e2" },
      ],
      pos,
      new Set(),
    );
    expect(edges.map((e) => e.causeId)).toEqual(["e1", "e2"]);
    expect(edges.every((e) => e.conflict === false)).toBe(true);
  });
});
