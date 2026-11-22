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
import {
  resolveSceneAnchor,
  type SceneChronicle,
} from "@/../electron/shared/readDomain/features/chronicle/resolveSceneAnchor";

// この試験は、今の挙動（裏の並び ordinal で前後を決める）を固定する試験である（CED/1 の DR-CED-9）。
// 切り替えの PR（CED/1 の §5 の 5）で、前後を比べている箇所を日時の比べ方に通すときに、
// 「今の判定」の期待値（describe「今の判定」）を改める。新しい関数（現在地と判定）の期待値は、
// 日時どおりの前後で、切り替えの後も変わらない（describe「新しい関数」）。
//
// 再現する状況：年表の画面（と、アプリ内の AI・MCP）で新しく作った出来事は、裏の並びを渡さずに保存され、
// Native が同じ既定値 "a0" を入れる。日付はばらばらでも、裏の並びは全部同じになる。
// 今の判定は、「裏の並びが現在地以下」を「これまで」とする。等しいときも「これまで」なので、
// 現在地より後の日付の出来事まで、全部「これまで」に入る。

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
  anchor: ReturnType<typeof resolveSceneAnchor>,
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

const sortedIds = (ids: string[]) => [...ids].sort();

describe("今の判定（裏の並びで前後を決める）：切り替えの PR（CED/1 の §5 の 5）で期待値を改める", () => {
  // 今の場面 s1 に、50 日の出来事が結び付いている。現在地は 50 日。
  const anchor = resolveSceneAnchor("s1", {
    sceneEvents,
    events,
    readingOrder,
  });

  it("現在地は、結び付いた出来事で決まり、その裏の並びは全部と同じ a0", () => {
    expect(anchor).toMatchObject({
      source: "stamped",
      startTime: 50,
      ordinal: "a0",
    });
  });

  it("直近の出来事：現在地（50 日）より後の日付の出来事まで「これまで」に入る", () => {
    const snapshot = snapshotOf(anchor, []);
    expect(sortedIds(snapshot.recentEvents.map((e) => e.eventId))).toEqual([
      "e10",
      "e120",
      "e200",
      "e300",
      "e50",
    ]);
  });

  it("人物の所在：現在地より後の出来事（300 日）の場所が、最後に判明した居場所になる", () => {
    const snapshot = snapshotOf(anchor, ["c1"]);
    // c1 の 10 日（故郷の村）と 300 日（遠い港町）。裏の並びが同じなので、配列で先に出るほうが残る。
    expect(snapshot.characters[0].location).toBe("遠い港町");
  });

  it("人物の所在：同点の出来事の順に依存する（配列を逆にすると、故郷の村になる）", () => {
    // 裏の並びが同じなので、どちらが残るかは配列の順で決まる。順に依存しない形では固定できない。
    // 現在地（50 日）より後の出来事（300 日）が候補に入ることは、「直近の出来事」と
    // 「人物の選び方」の試験が、順に依存しない形で固定している。
    const snapshot = snapshotOf(anchor, ["c1"], [...events].reverse());
    expect(snapshot.characters[0].location).toBe("故郷の村");
  });

  it("未回収の因果：結果（300 日）が現在地より後でも、「これまで」に入るので、未回収に出ない", () => {
    expect(snapshotOf(anchor, []).unresolvedCausal).toEqual([]);
  });

  it("本文未描写の背景：現在地より後の出来事が入る", () => {
    const offpage = snapshotOf(anchor, []).offpage.map((e) => e.eventId);
    // 今の場面に結び付いていない 4 件のうち、並びが同点なので配列の順で上位 3 件。
    expect(offpage).toEqual(["e300", "e10", "e120"]);
  });

  it("人物の選び方：現在地より後の出来事だけに登場する人物（c2。200 日）が選ばれる", () => {
    const picked = pickSnapshotCharacters({
      anchor,
      events,
      participants: [],
    });
    expect(picked).toContain("c2");
  });

  it("場面の作中日付で現在地が決まるときも、裏の並びが全部同じなら、全部が「これまで」", () => {
    const scenes = new Map<string, SceneChronicle>([
      [
        "s2",
        {
          startTime: 120,
          startMinute: null,
          startGranularity: "day",
          precision: "exact",
        },
      ],
    ]);
    const byScene = resolveSceneAnchor("s2", {
      sceneEvents: [],
      events,
      readingOrder: new Map([["s2", 0]]),
      sceneChronicle: scenes,
    });
    // 120 日以下の出来事がある：その裏の並び "a0" が、現在地の裏の並びになる。
    expect(byScene).toMatchObject({
      source: "scene",
      startTime: 120,
      ordinal: "a0",
    });
    const snapshot = snapshotOf(byScene, []);
    expect(sortedIds(snapshot.recentEvents.map((e) => e.eventId))).toEqual([
      "e10",
      "e120",
      "e200",
      "e300",
      "e50",
    ]);
  });
});

describe("新しい関数（現在地と判定）：同じ入力が、日時どおりに分かれる", () => {
  const anchor = resolveSceneAnchorByDate("s1", {
    sceneEvents,
    events,
    readingOrder,
    calendar: null,
  });
  const relationOf = (e: EventRow) => classifyEventRelation(e, anchor, null);

  it("現在地は、結び付いた出来事（50 日）で決まる", () => {
    expect(anchor).toMatchObject({
      source: "stamped",
      startTime: 50,
      startGranularity: "day",
    });
  });

  it("50 日より前は before、同じ日は concurrent、後は after に分かれる", () => {
    expect(relationOf(e10)).toBe("before");
    expect(relationOf(e50)).toBe("concurrent");
    expect(relationOf(e120)).toBe("after");
    expect(relationOf(e200)).toBe("after");
    expect(relationOf(e300)).toBe("after");
  });

  it("今の判定が「これまで」に入れた出来事のうち、日時では after のものが、今の判定との違い", () => {
    const old = resolveSceneAnchor("s1", { sceneEvents, events, readingOrder });
    const oldRecent = snapshotOf(old, []).recentEvents.map((e) => e.eventId);
    const dateBefore = events
      .filter((e) => {
        const relation = relationOf(e);
        return relation === "before" || relation === "concurrent";
      })
      .map((e) => e.id);
    expect(sortedIds(dateBefore)).toEqual(["e10", "e50"]);
    const wronglyBefore = oldRecent.filter((id) => !dateBefore.includes(id));
    expect(sortedIds(wronglyBefore)).toEqual(["e120", "e200", "e300"]);
  });

  it("場面の作中日付（120 日）が現在地のとき、120 日は concurrent、それ以前は before、後は after", () => {
    const scenes = new Map<string, SceneChronicle>([
      [
        "s2",
        {
          startTime: 120,
          startMinute: null,
          startGranularity: "day",
          precision: "exact",
        },
      ],
    ]);
    const byScene = resolveSceneAnchorByDate("s2", {
      sceneEvents: [],
      events,
      readingOrder: new Map([["s2", 0]]),
      sceneChronicle: scenes,
      calendar: null,
    });
    const at = (e: EventRow) => classifyEventRelation(e, byScene, null);
    expect(at(e10)).toBe("before");
    expect(at(e50)).toBe("before");
    expect(at(e120)).toBe("concurrent");
    expect(at(e200)).toBe("after");
    expect(at(e300)).toBe("after");
  });
});
