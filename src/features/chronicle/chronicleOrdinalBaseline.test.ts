import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveSceneAnchorByDate } from "@/../electron/shared/readDomain/features/chronicle/chronicleAnchorByDate";
import { classifyEventRelation } from "@/../electron/shared/readDomain/features/chronicle/chronicleOrder";
import {
  deriveChronicleSnapshot,
  pickSnapshotCharacters,
} from "@/../electron/shared/readDomain/features/chronicle/chronicleSnapshot";
import type {
  EventRelationRow,
  EventRow,
  SceneEventRow,
} from "@/../electron/shared/readDomain/features/chronicle/eventRows";
const baseEvent: EventRow = {
  id: "",
  projectId: "p1",
  title: "",
  note: null,
  detail: null,
  ordinal: "a0",
  primaryCodexId: null,
  laneGroup: null,
  locationCodexId: null,
  startTime: null,
  endTime: null,
  startMinute: null,
  endMinute: null,
  startGranularity: "day",
  endGranularity: "none",
  precision: "exact",
  kind: "generic",
  secret: false,
  revealSceneId: null,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function event(over: Partial<EventRow> & { id: string }): EventRow {
  return { ...baseEvent, ...over };
}

// 日付はばらばら、裏の並びは全部 "a0"。配列の順は、日付の順とは関係なく並べる。
const e300 = event({
  id: "e300",
  title: "最後の出来事",
  startTime: 300,
  primaryCodexId: "c1",
  locationCodexId: "loc-far",
});
const e10 = event({
  id: "e10",
  title: "古い出来事",
  startTime: 10,
  primaryCodexId: "c1",
  locationCodexId: "loc-home",
});
const e50 = event({ id: "e50", title: "今の場面の出来事", startTime: 50 });
const e120 = event({ id: "e120", title: "少し後の出来事", startTime: 120 });
const e200 = event({
  id: "e200",
  title: "ずっと後の出来事",
  startTime: 200,
  primaryCodexId: "c2",
});
const events: EventRow[] = [e300, e10, e50, e120, e200];

const sceneEvents: SceneEventRow[] = [{ sceneId: "s1", eventId: "e50" }];
// 10 日の出来事が原因で、300 日の出来事が結果（結果は、50 日の現在地から見て、まだ起きていない）。
const relations: EventRelationRow[] = [{ causeId: "e10", effectId: "e300" }];
const codexNames = new Map([
  ["loc-home", "故郷の村"],
  ["loc-far", "遠い港町"],
  ["c1", "主人公"],
  ["c2", "旅の商人"],
]);
const readingOrder = new Map([["s1", 0]]);

function snapshotOf(
  anchor: ReturnType<typeof resolveSceneAnchorByDate>,
  characterIds: string[],
  eventRows: EventRow[] = events,
) {
  return deriveChronicleSnapshot({
    anchor,
    events: eventRows,
    participants: [],
    relations,
    sceneEvents,
    calendar: null,
    characterIds,
    codexNames,
  });
}

describe("同じ ordinal の出来事も日時で判定する", () => {
  const anchor = resolveSceneAnchorByDate("s1", {
    sceneEvents,
    events,
    readingOrder,
    calendar: null,
  });
  it("導出は ordinal を直接参照せず、日時の共有関数で比較する", () => {
    const source = readFileSync(
      new URL(
        "../../../electron/shared/readDomain/features/chronicle/chronicleSnapshot.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).not.toMatch(/\.ordinal\b/);
  });
  it("50 日時点で所在、直近、背景、因果、登場人物が一致する", () => {
    for (const rows of [events, [...events].reverse()]) {
      const snapshot = snapshotOf(anchor, ["c1"], rows);
      expect(snapshot.characters[0].location).toBe("故郷の村");
      expect(snapshot.recentEvents.map((e) => e.eventId)).toEqual([
        "e50",
        "e10",
      ]);
      expect(snapshot.offpage.map((e) => e.eventId)).toEqual(["e10"]);
      expect(snapshot.unresolvedCausal).toEqual([
        {
          causeTitle: e10.title,
          effectTitle: e300.title,
          causePrecision: "exact",
          effectPrecision: "exact",
        },
      ]);
      expect(
        pickSnapshotCharacters({ anchor, events: rows, participants: [] }),
      ).toEqual(["c1"]);
    }
  });
  it("作中日付のある場面は同日までを直近に含める", () => {
    const byScene = resolveSceneAnchorByDate("s2", {
      events,
      sceneEvents,
      readingOrder,
      calendar: null,
      sceneChronicle: new Map([
        [
          "s2",
          {
            startTime: 120,
            startMinute: null,
            startGranularity: "day",
            precision: "exact",
          },
        ],
      ]),
    });
    expect(events.map((e) => classifyEventRelation(e, byScene, null))).toEqual([
      "after",
      "before",
      "before",
      "concurrent",
      "after",
    ]);
    expect(snapshotOf(byScene, []).recentEvents.map((e) => e.eventId)).toEqual([
      "e120",
      "e50",
      "e10",
    ]);
  });
});
