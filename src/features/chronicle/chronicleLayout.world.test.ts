import { describe, expect, it } from "vitest";
import {
  buildChronicleWorldGeometry,
  projectChronicleWorldGeometry,
} from "./chronicleLayout";

const calendar = {
  daysPerYear: 360,
  seasonBoundaries: [],
  startYear: 0,
};

describe("chronicle world geometry projection", () => {
  it("reuses event/lane geometry when only viewStartDay changes", () => {
    const world = buildChronicleWorldGeometry({
      events: [
        {
          id: "e1",
          title: "出来事",
          primaryCodexId: "c1",
          kind: "generic",
          precision: "exact",
          secret: false,
          sceneLinked: true,
          startDay: 20,
          endDay: null,
        },
      ],
      lanes: [
        {
          codexId: "c1",
          name: "人物",
          kind: "character",
          unassigned: false,
          eventIds: ["e1"],
        },
      ],
      pxPerDay: 4,
      originDay: 10,
      density: "standard",
      labelsOn: true,
      relations: [],
      causalConflictPairs: new Set(),
    });
    const first = projectChronicleWorldGeometry({
      world,
      view: { pxPerDay: 4, viewStartDay: 10 },
      trackW: 800,
      calendar,
      hasCalendarAxis: true,
      dataStart: 10,
      dataEnd: 30,
    });
    const panned = projectChronicleWorldGeometry({
      world,
      view: { pxPerDay: 4, viewStartDay: 15 },
      trackW: 800,
      calendar,
      hasCalendarAxis: true,
      dataStart: 10,
      dataEnd: 30,
    });

    expect(panned.pack).toBe(first.pack);
    expect(panned.edges).toBe(first.edges);
    expect(panned.markerById).toBe(first.markerById);
    expect(first.worldOffsetX).toBe(0);
    expect(panned.worldOffsetX).toBe(-20);
  });
});
