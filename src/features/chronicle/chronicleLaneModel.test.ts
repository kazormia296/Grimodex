import { describe, it, expect } from "vitest";
import {
  buildChronicleLaneModel,
  type LaneInputEvent,
  type LanePerson,
} from "./chronicleLaneModel";

function ev(
  o: Partial<LaneInputEvent> & { id: string; ordinal: string },
): LaneInputEvent {
  return {
    primaryCodexId: null,
    precision: "exact",
    isOffpage: false,
    isInterval: false,
    ...o,
  };
}

const people: LanePerson[] = [
  { id: "alice", name: "Alice" },
  { id: "bob", name: "Bob" },
  { id: "carol", name: "Carol" }, // 出来事なし → レーンを作らない
];

describe("buildChronicleLaneModel", () => {
  it("primary を持つ人物だけレーン化し name 昇順で並べる", () => {
    const events = [
      ev({ id: "e2", ordinal: "a1", primaryCodexId: "bob" }),
      ev({ id: "e1", ordinal: "a0", primaryCodexId: "alice" }),
      ev({ id: "e3", ordinal: "a2", primaryCodexId: "alice" }),
    ];
    const model = buildChronicleLaneModel({ events, people });
    expect(model.lanes.map((l) => l.codexId)).toEqual(["alice", "bob"]);
    // carol は出来事が無いので除外
    expect(model.lanes.some((l) => l.codexId === "carol")).toBe(false);
  });

  it("各レーンの marker は ordinal 昇順", () => {
    const events = [
      ev({ id: "e3", ordinal: "a2", primaryCodexId: "alice" }),
      ev({ id: "e1", ordinal: "a0", primaryCodexId: "alice" }),
    ];
    const model = buildChronicleLaneModel({ events, people });
    const alice = model.lanes.find((l) => l.codexId === "alice")!;
    expect(alice.markers.map((m) => m.eventId)).toEqual(["e1", "e3"]);
  });

  it("primaryCodexId が null or 未知の出来事は unassigned 行へ", () => {
    const events = [
      ev({ id: "e1", ordinal: "a0", primaryCodexId: "alice" }),
      ev({ id: "u1", ordinal: "a1", primaryCodexId: null }),
      ev({ id: "u2", ordinal: "a2", primaryCodexId: "ghost" }), // people に居ない
    ];
    const model = buildChronicleLaneModel({ events, people });
    expect(model.unassigned.map((m) => m.eventId)).toEqual(["u1", "u2"]);
    expect(model.lanes.map((l) => l.codexId)).toEqual(["alice"]);
  });

  it("y は laneTop + index*laneHeight + laneHeight/2、contentHeight 整合", () => {
    const events = [
      ev({ id: "e1", ordinal: "a0", primaryCodexId: "alice" }),
      ev({ id: "e2", ordinal: "a1", primaryCodexId: "bob" }),
    ];
    const model = buildChronicleLaneModel({
      events,
      people,
      laneTop: 10,
      laneHeight: 40,
    });
    expect(model.laneHeight).toBe(40);
    expect(model.lanes[0].y).toBe(10 + 0 * 40 + 20);
    expect(model.lanes[1].y).toBe(10 + 1 * 40 + 20);
    expect(model.contentHeight).toBe(10 + 2 * 40);
  });

  it("offpage / interval フラグを marker に伝搬", () => {
    const events = [
      ev({
        id: "e1",
        ordinal: "a0",
        primaryCodexId: "alice",
        isOffpage: true,
        isInterval: true,
        precision: "approx",
      }),
    ];
    const model = buildChronicleLaneModel({ events, people });
    const m = model.lanes[0].markers[0];
    expect(m.isOffpage).toBe(true);
    expect(m.isInterval).toBe(true);
    expect(m.precision).toBe("approx");
  });

  it("空入力は空モデル", () => {
    const model = buildChronicleLaneModel({ events: [], people });
    expect(model.lanes).toEqual([]);
    expect(model.unassigned).toEqual([]);
  });
});
