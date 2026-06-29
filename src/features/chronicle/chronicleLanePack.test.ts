import { describe, expect, it } from "vitest";
import {
  packLanes,
  type PackEventInput,
  type PackLaneInput,
  type PackSpacing,
} from "./chronicleLanePack";

const spacing: PackSpacing = { laneVPad: 4, tokenH: 20, rowGap: 6 };

function ev(
  id: string,
  startX: number,
  estWidth: number,
  isInterval = false,
): PackEventInput {
  return { id, startX, isInterval, barWidth: null, estWidth };
}

function lane(
  codexId: string | null,
  events: PackEventInput[],
  extra: Partial<PackLaneInput> = {},
): PackLaneInput {
  return {
    codexId,
    name: extra.name ?? "lane",
    kind: extra.kind ?? "character",
    unassigned: extra.unassigned ?? false,
    events,
    keepEmpty: extra.keepEmpty,
    pinKey: extra.pinKey,
  };
}

describe("packLanes", () => {
  it("(1) overlapping markers stack into two rows with cy differing by tokenH+rowGap", () => {
    // Two point events near each other so [left, left+estWidth] overlap.
    const a = ev("a", 100, 80);
    const b = ev("b", 120, 80);
    const result = packLanes({ lanes: [lane("c1", [a, b])], spacing });

    const packed = result.lanes[0];
    expect(packed.rows).toBe(2);

    const ca = result.centers.get("a")!;
    const cb = result.centers.get("b")!;
    expect(Math.abs(cb.cy - ca.cy)).toBeCloseTo(
      spacing.tokenH + spacing.rowGap,
    );
  });

  it("(2) far-apart markers share a single row and the same cy", () => {
    const a = ev("a", 0, 30);
    const b = ev("b", 1000, 30);
    const result = packLanes({ lanes: [lane("c1", [a, b])], spacing });

    const packed = result.lanes[0];
    expect(packed.rows).toBe(1);

    const ca = result.centers.get("a")!;
    const cb = result.centers.get("b")!;
    expect(ca.cy).toBe(cb.cy);
  });

  it("(3) center cx equals the event startX", () => {
    const a = ev("a", 137, 40);
    const result = packLanes({ lanes: [lane("c1", [a])], spacing });
    expect(result.centers.get("a")!.cx).toBe(137);
  });

  it("(4) lanes with no events are dropped", () => {
    const result = packLanes({
      lanes: [
        lane("empty", []),
        lane("full", [ev("a", 10, 20)]),
        lane("empty2", []),
      ],
      spacing,
    });
    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0].codexId).toBe("full");
    expect(result.laneSepTops).toHaveLength(1);
  });

  it("(4b) keepEmpty の空レーンは残す（ピン留め空レーン）", () => {
    const result = packLanes({
      lanes: [
        lane("pin", [], { keepEmpty: true, pinKey: "p1" }),
        lane("full", [ev("a", 10, 20)]),
      ],
      spacing,
    });
    expect(result.lanes).toHaveLength(2);
    const pin = result.lanes.find((l) => l.codexId === "pin")!;
    expect(pin.keepEmpty).toBe(true);
    expect(pin.pinKey).toBe("p1");
    expect(pin.count).toBe(0);
    expect(pin.markers).toHaveLength(0);
    // 1 行分の高さ（laneVPad*2 + tokenH）。
    expect(pin.height).toBe(spacing.laneVPad * 2 + spacing.tokenH);
  });

  it("(5) multiple lanes stack and laneSepTops match each lane top", () => {
    const result = packLanes({
      lanes: [
        lane("l0", [ev("a", 0, 20), ev("b", 10, 20)]), // overlap -> 2 rows
        lane("l1", [ev("c", 500, 20)]),
      ],
      spacing,
    });

    expect(result.lanes).toHaveLength(2);
    const l0 = result.lanes[0];
    const l1 = result.lanes[1];

    expect(l0.top).toBe(0);
    expect(l1.top).toBe(l0.top + l0.height);

    expect(result.laneSepTops[0]).toBe(l0.top);
    expect(result.laneSepTops[1]).toBe(l1.top);
  });

  it("(6) totalHeight is at least 80", () => {
    const small = packLanes({
      lanes: [lane("c1", [ev("a", 0, 5)])],
      spacing,
    });
    expect(small.totalHeight).toBeGreaterThanOrEqual(80);

    const empty = packLanes({ lanes: [], spacing });
    expect(empty.totalHeight).toBe(80);
  });
});

import { laneAtY } from "./chronicleLanePack";

describe("laneAtY", () => {
  const lanes = [
    {
      codexId: "a",
      name: "A",
      kind: "character",
      unassigned: false,
      count: 1,
      top: 0,
      height: 50,
      rows: 1,
      markers: [],
      keepEmpty: false,
    },
    {
      codexId: "b",
      name: "B",
      kind: "character",
      unassigned: false,
      count: 1,
      top: 50,
      height: 60,
      rows: 1,
      markers: [],
      keepEmpty: false,
    },
  ];
  it("範囲内の y は該当レーン", () => {
    expect(laneAtY(lanes, 10)?.codexId).toBe("a");
    expect(laneAtY(lanes, 80)?.codexId).toBe("b");
    expect(laneAtY(lanes, 50)?.codexId).toBe("b"); // 境界は下側レーン
  });
  it("上端より上は先頭、最終レーンより下は null（未割当領域）", () => {
    expect(laneAtY(lanes, -10)?.codexId).toBe("a");
    expect(laneAtY(lanes, 999)).toBeNull();
  });
  it("空なら null", () => {
    expect(laneAtY([], 10)).toBeNull();
  });
});
