import { describe, it, expect } from "vitest";
import { buildPlotLaneModel, laneY } from "./plotThreadLaneModel";
import type { PlotThreadRow, PlotThreadLinkRow } from "./api";
import type { PlotPhaseType } from "@/db/schema";

const thread = (id: string, sortOrder: string, name = id): PlotThreadRow => ({
  id,
  projectId: "p1",
  name,
  color: null,
  description: null,
  sortOrder,
  createdAt: "",
  updatedAt: "",
});
const link = (
  id: string,
  threadId: string,
  nodeId: string,
  phaseType: PlotPhaseType,
): PlotThreadLinkRow => ({
  id,
  threadId,
  nodeId,
  phaseType,
  note: null,
  sortOrder: null,
  createdAt: "",
  updatedAt: "",
});

describe("plotThreadLaneModel", () => {
  const sceneX = new Map([
    ["s1", 0],
    ["s2", 1],
    ["s3", 2],
  ]);

  it("orders lanes by sortOrder and assigns increasing y", () => {
    const m = buildPlotLaneModel({
      threads: [thread("b", "a1"), thread("a", "a0")],
      links: [],
      sceneX,
    });
    expect(m.lanes.map((l) => l.thread.id)).toEqual(["a", "b"]); // a0 < a1
    expect(m.lanes[0].y).toBe(laneY(0));
    expect(m.lanes[1].y).toBe(laneY(1));
    expect(m.contentHeight).toBe(laneY(2));
  });

  it("places markers at their scene x and drops markers whose scene is absent", () => {
    const m = buildPlotLaneModel({
      threads: [thread("t1", "a0")],
      links: [
        link("l1", "t1", "s2", "introduce"),
        link("l2", "t1", "GONE", "develop"),
      ],
      sceneX,
    });
    expect(m.lanes[0].markers).toHaveLength(1);
    expect(m.lanes[0].markers[0]).toMatchObject({ linkId: "l1", x: 1 });
    expect(m.contentWidth).toBe(1);
  });

  it("orders same-scene markers by canonical phase order then id", () => {
    const m = buildPlotLaneModel({
      threads: [thread("t1", "a0")],
      links: [
        link("l2", "t1", "s1", "develop"),
        link("l1", "t1", "s1", "introduce"),
      ],
      sceneX,
    });
    expect(m.lanes[0].markers.map((mk) => mk.linkId)).toEqual(["l1", "l2"]); // introduce < develop
  });

  it("returns an empty model with zero dimensions when there are no threads", () => {
    const m = buildPlotLaneModel({ threads: [], links: [], sceneX });
    expect(m.lanes).toEqual([]);
    expect(m.contentWidth).toBe(0);
    expect(m.contentHeight).toBe(laneY(0));
  });

  it("同一 sortOrder のレーンは thread.id で決定化する", () => {
    const m = buildPlotLaneModel({
      threads: [thread("b", "a0"), thread("a", "a0")],
      links: [],
      sceneX,
    });
    expect(m.lanes.map((l) => l.thread.id)).toEqual(["a", "b"]);
  });

  it("未知の phaseType でもクラッシュせず決定的にソートする", () => {
    const m = buildPlotLaneModel({
      threads: [thread("t1", "a0")],
      links: [
        // @ts-expect-error 不正値を意図的に注入（本来は CHECK で弾かれる）
        link("l1", "t1", "s1", "BOGUS"),
        link("l2", "t1", "s1", "introduce"),
      ],
      sceneX,
    });
    expect(m.lanes[0].markers).toHaveLength(2);
    // BOGUS(??0) と introduce(0) は同値 → linkId 昇順で決定化
    expect(m.lanes[0].markers.map((mk) => mk.linkId)).toEqual(["l1", "l2"]);
  });
});
