import { describe, it, expect } from "vitest";
import {
  deriveChronicleSnapshot,
  renderChronicleSnapshot,
  pickSnapshotCharacters,
  assembleChronicleSnapshotText,
  type ChronicleSnapshotInput,
} from "./chronicleSnapshot";
import type { ChronicleAnchor } from "./resolveSceneAnchor";
import type { EventRow, EventRelationRow } from "./api";
import type { ChronicleCalendar } from "./chronicleTime";
import { countTokens } from "@/features/chat/contextBuilder";

function mkEvent(p: Partial<EventRow> & { id: string }): EventRow {
  return {
    id: p.id,
    projectId: p.projectId ?? "p1",
    title: p.title ?? p.id,
    note: p.note ?? null,
    ordinal: p.ordinal ?? "a0",
    primaryCodexId: p.primaryCodexId ?? null,
    locationCodexId: p.locationCodexId ?? null,
    startTime: p.startTime ?? null,
    endTime: p.endTime ?? null,
    startMinute: p.startMinute ?? null,
    endMinute: p.endMinute ?? null,
    startGranularity: p.startGranularity ?? "none",
    endGranularity: p.endGranularity ?? "none",
    precision: p.precision ?? "exact",
    kind: p.kind ?? "generic",
    createdAt: "",
    updatedAt: "",
  };
}

const CAL: ChronicleCalendar = {
  daysPerYear: 360,
  seasonBoundaries: [
    { name: "春", startDayOfYear: 0 },
    { name: "夏", startDayOfYear: 90 },
    { name: "秋", startDayOfYear: 180 },
    { name: "冬", startDayOfYear: 270 },
  ],
};

function input(
  over: Partial<ChronicleSnapshotInput> & { anchor: ChronicleAnchor },
): ChronicleSnapshotInput {
  return {
    anchor: over.anchor,
    events: over.events ?? [],
    participants: over.participants ?? [],
    relations: over.relations ?? [],
    sceneEvents: over.sceneEvents ?? [],
    calendar: over.calendar ?? null,
    characterIds: over.characterIds ?? [],
    codexNames: over.codexNames ?? new Map(),
  };
}

const stamped = (
  ordinal: string,
  startTime: number | null,
): ChronicleAnchor => ({
  ordinal,
  startTime,
  source: "stamped",
});

describe("deriveChronicleSnapshot — character state", () => {
  it("alive: 誕生済み・死亡前 → alive ＋ 年齢算出", () => {
    const snap = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", 720),
        events: [
          mkEvent({
            id: "b",
            kind: "birth",
            primaryCodexId: "c1",
            startTime: 0,
            ordinal: "a0",
          }),
        ],
        calendar: CAL,
        characterIds: ["c1"],
        codexNames: new Map([["c1", "アリス"]]),
      }),
    );
    expect(snap.characters).toEqual([
      {
        codexId: "c1",
        name: "アリス",
        status: "alive",
        age: 2,
        location: null,
      },
    ]);
  });

  it("dead: 死亡 event が anchor 以前 → dead ＋ 死亡時年齢", () => {
    const snap = deriveChronicleSnapshot(
      input({
        anchor: stamped("a9", 720),
        events: [
          mkEvent({
            id: "b",
            kind: "birth",
            primaryCodexId: "c1",
            startTime: 0,
            ordinal: "a0",
          }),
          mkEvent({
            id: "d",
            kind: "death",
            primaryCodexId: "c1",
            startTime: 360,
            ordinal: "a3",
          }),
        ],
        calendar: CAL,
        characterIds: ["c1"],
        codexNames: new Map([["c1", "ボブ"]]),
      }),
    );
    expect(snap.characters[0].status).toBe("dead");
    expect(snap.characters[0].age).toBe(1); // 死亡時 (360-0)/360
  });

  it("unborn: 誕生が anchor より後 → unborn", () => {
    const snap = deriveChronicleSnapshot(
      input({
        anchor: stamped("a1", 100),
        events: [
          mkEvent({
            id: "b",
            kind: "birth",
            primaryCodexId: "c1",
            startTime: 500,
            ordinal: "a9",
          }),
        ],
        calendar: CAL,
        characterIds: ["c1"],
        codexNames: new Map([["c1", "未来子"]]),
      }),
    );
    expect(snap.characters[0].status).toBe("unborn");
    expect(snap.characters[0].age).toBeNull();
  });

  it("unknown: birth が無い or anchor.startTime=null → unknown・age=null", () => {
    const noBirth = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", 720),
        events: [],
        calendar: CAL,
        characterIds: ["c1"],
        codexNames: new Map([["c1", "謎"]]),
      }),
    );
    expect(noBirth.characters[0].status).toBe("unknown");
    expect(noBirth.characters[0].age).toBeNull();

    const noTime = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", null),
        events: [
          mkEvent({
            id: "b",
            kind: "birth",
            primaryCodexId: "c1",
            startTime: 0,
          }),
        ],
        calendar: CAL,
        characterIds: ["c1"],
        codexNames: new Map([["c1", "謎"]]),
      }),
    );
    expect(noTime.characters[0].status).toBe("unknown");
  });

  it("age=null: calendar 未設定なら年齢不明だが生死は出る", () => {
    const snap = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", 720),
        events: [
          mkEvent({
            id: "b",
            kind: "birth",
            primaryCodexId: "c1",
            startTime: 0,
          }),
        ],
        calendar: null,
        characterIds: ["c1"],
        codexNames: new Map([["c1", "アリス"]]),
      }),
    );
    expect(snap.characters[0].status).toBe("alive");
    expect(snap.characters[0].age).toBeNull();
  });
});

describe("deriveChronicleSnapshot — location", () => {
  it("最後に判明する居場所: location 付き event のうち ordinal<=anchor の最新", () => {
    const snap = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", null),
        events: [
          mkEvent({
            id: "e1",
            primaryCodexId: "c1",
            locationCodexId: "loc1",
            ordinal: "a1",
          }),
          mkEvent({
            id: "e2",
            primaryCodexId: "c1",
            locationCodexId: "loc2",
            ordinal: "a4",
          }),
          mkEvent({
            id: "e3",
            primaryCodexId: "c1",
            locationCodexId: "loc3",
            ordinal: "a8",
          }), // anchor 超
        ],
        characterIds: ["c1"],
        codexNames: new Map([
          ["c1", "アリス"],
          ["loc1", "村"],
          ["loc2", "城"],
          ["loc3", "未来都市"],
        ]),
      }),
    );
    expect(snap.characters[0].location).toBe("城"); // a4 が anchor 以前で最新
  });

  it("participant としての関与でも居場所を拾う", () => {
    const snap = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", null),
        events: [
          mkEvent({
            id: "e1",
            primaryCodexId: "cOther",
            locationCodexId: "loc1",
            ordinal: "a2",
          }),
        ],
        participants: [{ eventId: "e1", codexEntryId: "c1", role: null }],
        characterIds: ["c1"],
        codexNames: new Map([
          ["c1", "アリス"],
          ["loc1", "戦場"],
        ]),
      }),
    );
    expect(snap.characters[0].location).toBe("戦場");
  });
});

describe("deriveChronicleSnapshot — recent events", () => {
  it("ordinal<=anchor 降順 K=8、birth/death は除外（state へ畳む）", () => {
    const events = [
      mkEvent({ id: "g1", title: "戴冠", ordinal: "a1" }),
      mkEvent({ id: "g2", title: "戦争", ordinal: "a3" }),
      mkEvent({
        id: "b1",
        title: "誕生",
        kind: "birth",
        primaryCodexId: "c1",
        startTime: 0,
        ordinal: "a2",
      }),
      mkEvent({ id: "future", title: "未来", ordinal: "a9" }),
    ];
    const snap = deriveChronicleSnapshot(
      input({ anchor: stamped("a5", null), events, characterIds: [] }),
    );
    expect(snap.recentEvents.map((e) => e.title)).toEqual(["戦争", "戴冠"]);
  });

  it("K=8 で打ち切る", () => {
    const events = Array.from({ length: 12 }, (_, i) =>
      mkEvent({ id: `e${i}`, title: `E${i}`, ordinal: `a${i}` }),
    );
    const snap = deriveChronicleSnapshot(
      input({ anchor: stamped("a9", null), events, characterIds: [] }),
    );
    expect(snap.recentEvents.length).toBe(8);
  });
});

describe("deriveChronicleSnapshot — unresolved causal (ordinal)", () => {
  it("原因<=anchor かつ 結果>anchor の因果のみ拾う", () => {
    const events = [
      mkEvent({ id: "cause", title: "毒を盛る", ordinal: "a2" }),
      mkEvent({ id: "effect", title: "王の死", ordinal: "a8" }),
      mkEvent({ id: "done", title: "既済因果結果", ordinal: "a3" }),
      mkEvent({ id: "doneCause", title: "既済因果原因", ordinal: "a1" }),
    ];
    const snap = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", null),
        events,
        relations: [
          { causeId: "cause", effectId: "effect" }, // a2<=a5, a8>a5 → 未回収
          { causeId: "doneCause", effectId: "done" }, // 両方<=a5 → 回収済み
        ] as EventRelationRow[],
        characterIds: [],
      }),
    );
    expect(snap.unresolvedCausal).toEqual([
      { causeTitle: "毒を盛る", effectTitle: "王の死" },
    ]);
  });
});

describe("deriveChronicleSnapshot — offpage (D1)", () => {
  it("未 stamp event を kind 優先・ordinal 降順で最大3件", () => {
    const events = [
      mkEvent({ id: "on", title: "オンページ", ordinal: "a1" }),
      mkEvent({ id: "off1", title: "古い戦争", ordinal: "a2" }),
      mkEvent({
        id: "off2",
        title: "ある誕生",
        kind: "birth",
        primaryCodexId: "z",
        startTime: 0,
        ordinal: "a3",
      }),
      mkEvent({ id: "off3", title: "別の事件", ordinal: "a4" }),
      mkEvent({ id: "off4", title: "さらに事件", ordinal: "a0" }),
    ];
    const snap = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", null),
        events,
        sceneEvents: [{ sceneId: "s1", eventId: "on" }], // on のみ stamp 済
        characterIds: [],
      }),
    );
    // birth(off2) 優先 → 残りは ordinal 降順(off3 a4, off1 a2) で計3件
    expect(snap.offpage.map((e) => e.title)).toEqual([
      "ある誕生",
      "別の事件",
      "古い戦争",
    ]);
  });
});

describe("deriveChronicleSnapshot — none mode", () => {
  it("source=none は offpage のみ（全 event 対象）、recent/causal は空", () => {
    const snap = deriveChronicleSnapshot(
      input({
        anchor: { ordinal: "", startTime: null, source: "none" },
        events: [
          mkEvent({ id: "e1", title: "背景A", ordinal: "a1" }),
          mkEvent({ id: "e2", title: "背景B", ordinal: "a2" }),
        ],
        sceneEvents: [],
        characterIds: [],
      }),
    );
    expect(snap.recentEvents).toEqual([]);
    expect(snap.offpage.map((e) => e.title).sort()).toEqual(["背景A", "背景B"]);
  });
});

describe("deriveChronicleSnapshot — time/season", () => {
  it("startTime があれば季節を出す", () => {
    const snap = deriveChronicleSnapshot(
      input({ anchor: stamped("a5", 100), calendar: CAL, characterIds: [] }),
    );
    expect(snap.time.season).toBe("夏"); // day 100 → 夏(90-)
  });
  it("startTime=null なら season=null", () => {
    const snap = deriveChronicleSnapshot(
      input({ anchor: stamped("a5", null), calendar: CAL, characterIds: [] }),
    );
    expect(snap.time.season).toBeNull();
  });
});

describe("renderChronicleSnapshot", () => {
  it("人物名・出来事を含む本文を返す（ja）", () => {
    const snap = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", 100),
        events: [
          mkEvent({
            id: "b",
            kind: "birth",
            primaryCodexId: "c1",
            startTime: 0,
            ordinal: "a0",
          }),
          mkEvent({ id: "g", title: "戴冠式", ordinal: "a3" }),
        ],
        calendar: CAL,
        characterIds: ["c1"],
        codexNames: new Map([["c1", "アリス"]]),
      }),
    );
    const text = renderChronicleSnapshot(snap, "ja");
    expect(text).toContain("アリス");
    expect(text).toContain("戴冠式");
  });

  it("none モードはオフページ背景のみを描画", () => {
    const snap = deriveChronicleSnapshot(
      input({
        anchor: { ordinal: "", startTime: null, source: "none" },
        events: [mkEvent({ id: "e1", title: "古の大戦", ordinal: "a1" })],
        characterIds: [],
      }),
    );
    const text = renderChronicleSnapshot(snap, "ja");
    expect(text).toContain("古の大戦");
  });

  it("英語 lang でも描画できる", () => {
    const snap = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", null),
        events: [mkEvent({ id: "g", title: "Coronation", ordinal: "a1" })],
        characterIds: [],
      }),
    );
    const text = renderChronicleSnapshot(snap, "en");
    expect(text).toContain("Coronation");
  });

  it("トークン上限: 大量入力でも render は ≤600 トークン", () => {
    const events = Array.from({ length: 40 }, (_, i) =>
      mkEvent({
        id: `e${i}`,
        title: `非常に長い出来事のタイトル番号${i}`.repeat(3),
        note: "詳細な脚注テキスト".repeat(20),
        ordinal: `a${i}`,
      }),
    );
    const characterIds = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const codexNames = new Map(characterIds.map((id) => [id, `登場人物${id}`]));
    const snap = deriveChronicleSnapshot(
      input({
        anchor: stamped("z9", 100),
        events,
        calendar: CAL,
        characterIds,
        codexNames,
      }),
    );
    const text = renderChronicleSnapshot(snap, "ja");
    expect(countTokens(text)).toBeLessThanOrEqual(600);
  });
});

describe("pickSnapshotCharacters", () => {
  it("none アンカーは空（オフページのみ）", () => {
    const ids = pickSnapshotCharacters({
      anchor: { ordinal: "", startTime: null, source: "none" },
      events: [mkEvent({ id: "e1", primaryCodexId: "c1", ordinal: "a1" })],
      participants: [],
      sceneCodexIds: ["sceneChar"],
    });
    expect(ids).toEqual([]);
  });

  it("sceneCodexIds ＋ 直近イベントの primary/participant を集める", () => {
    const ids = pickSnapshotCharacters({
      anchor: stamped("a5", null),
      events: [
        mkEvent({ id: "e1", primaryCodexId: "c1", ordinal: "a2" }),
        mkEvent({ id: "future", primaryCodexId: "cFuture", ordinal: "a9" }),
      ],
      participants: [{ eventId: "e1", codexEntryId: "c2", role: null }],
      sceneCodexIds: ["sceneChar"],
    });
    expect(new Set(ids)).toEqual(new Set(["sceneChar", "c1", "c2"]));
    expect(ids).not.toContain("cFuture"); // anchor 超のイベントは拾わない
  });

  it("@mention された人物は recent/scene に居なくても必ず含める", () => {
    const ids = pickSnapshotCharacters({
      anchor: stamped("a5", null),
      events: [mkEvent({ id: "e1", primaryCodexId: "c1", ordinal: "a2" })],
      participants: [],
      sceneCodexIds: [],
      mentionedCodexIds: ["mentioned"],
    });
    expect(ids).toContain("mentioned");
  });

  it("@mention 人物は cap が一杯でも優先的に残る（最優先 seed）", () => {
    const ids = pickSnapshotCharacters({
      anchor: stamped("a5", null),
      events: [],
      participants: [],
      sceneCodexIds: ["s1", "s2"],
      mentionedCodexIds: ["mentioned"],
      max: 2,
    });
    expect(ids.length).toBe(2);
    expect(ids).toContain("mentioned"); // mention は cap を超えて捨てられない
  });

  it("none アンカーでは @mention 人物も含めない（D1: オフページのみ）", () => {
    const ids = pickSnapshotCharacters({
      anchor: { ordinal: "", startTime: null, source: "none" },
      events: [],
      participants: [],
      sceneCodexIds: [],
      mentionedCodexIds: ["mentioned"],
    });
    expect(ids).toEqual([]);
  });
});

describe("assembleChronicleSnapshotText", () => {
  it("stamp 済シーンで本文テキストを返す", () => {
    const text = assembleChronicleSnapshotText({
      sceneId: "s1",
      events: [
        mkEvent({ id: "e1", title: "戴冠式", ordinal: "a3" }),
        mkEvent({
          id: "b",
          kind: "birth",
          primaryCodexId: "c1",
          startTime: 0,
          ordinal: "a0",
        }),
      ],
      participants: [],
      relations: [],
      sceneEvents: [{ sceneId: "s1", eventId: "e1" }],
      calendar: CAL,
      readingOrder: new Map([["s1", 0]]),
      codexNames: new Map([["c1", "アリス"]]),
      sceneCodexIds: ["c1"],
      lang: "ja",
    });
    expect(text).toContain("戴冠式");
    expect(text).toContain("アリス");
  });

  it("events 空・全 none で出力が空なら undefined", () => {
    const text = assembleChronicleSnapshotText({
      sceneId: "s1",
      events: [],
      participants: [],
      relations: [],
      sceneEvents: [],
      calendar: null,
      readingOrder: new Map(),
      codexNames: new Map(),
      lang: "ja",
    });
    expect(text).toBeUndefined();
  });
});
