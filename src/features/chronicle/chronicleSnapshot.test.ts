import { describe, it, expect } from "vitest";
import {
  deriveChronicleSnapshot,
  renderChronicleSnapshot,
  pickSnapshotCharacters,
  assembleChronicleSnapshotText,
  type ChronicleSnapshotInput,
} from "./chronicleSnapshot";
import type { ChronicleAnchor, SceneChronicle } from "./resolveSceneAnchor";
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
    secret: p.secret ?? false,
    revealSceneId: p.revealSceneId ?? null,
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
  precision: ChronicleAnchor["precision"] = "exact",
  startMinute: number | null = null,
  startGranularity: string = "none",
): ChronicleAnchor => ({
  ordinal,
  startTime,
  startMinute,
  startGranularity,
  precision,
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
        anchor: {
          ordinal: "",
          startTime: null,
          startMinute: null,
          startGranularity: "none",
          precision: null,
          source: "none",
        },
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

// 月＋開始年つき暦（formattedDate 用）。12ヶ月×30日=360 で CAL と dpy 整合。
const CAL_MONTHS: ChronicleCalendar = {
  daysPerYear: 360,
  startYear: 1000,
  seasonBoundaries: CAL.seasonBoundaries,
  months: Array.from({ length: 12 }, (_, i) => ({
    name: `${i + 1}月`,
    days: 30,
  })),
  weekdayNames: ["日", "月", "火", "水", "木", "金", "土"],
};

describe("deriveChronicleSnapshot — formattedDate", () => {
  it("暦＋粒度(time)＋startTime が揃うと整形済み日付を出す（ja）", () => {
    const snap = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", 96212, "exact", 540, "time"),
        calendar: CAL_MONTHS,
        characterIds: [],
      }),
      "ja",
    );
    // 1000 + floor(96212/360)=1267年, dayOfYear 92 → 4月3日, 540分 → 09:00
    expect(snap.time.formattedDate).toBe("1267年4月3日 09:00");
  });

  it("粒度 day は時刻を付けない", () => {
    const snap = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", 96212, "exact", 540, "day"),
        calendar: CAL_MONTHS,
        characterIds: [],
      }),
      "ja",
    );
    expect(snap.time.formattedDate).toBe("1267年4月3日");
  });

  it("lang=en は英語整形", () => {
    const snap = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", 96212, "exact", 540, "time"),
        calendar: CAL_MONTHS,
        characterIds: [],
      }),
      "en",
    );
    expect(snap.time.formattedDate).toBe("4月 3, 1267 09:00");
  });

  it("粒度 none は formattedDate=null", () => {
    const snap = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", 96212, "exact", null, "none"),
        calendar: CAL_MONTHS,
        characterIds: [],
      }),
      "ja",
    );
    expect(snap.time.formattedDate).toBeNull();
  });

  it("暦未設定なら formattedDate=null", () => {
    const snap = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", 96212, "exact", 540, "time"),
        calendar: null,
        characterIds: [],
      }),
      "ja",
    );
    expect(snap.time.formattedDate).toBeNull();
  });

  it("startTime=null なら formattedDate=null", () => {
    const snap = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", null, "exact", 540, "time"),
        calendar: CAL_MONTHS,
        characterIds: [],
      }),
      "ja",
    );
    expect(snap.time.formattedDate).toBeNull();
  });

  it("既定 lang（引数省略）は ja 整形", () => {
    const snap = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", 96212, "exact", 540, "time"),
        calendar: CAL_MONTHS,
        characterIds: [],
      }),
    );
    expect(snap.time.formattedDate).toBe("1267年4月3日 09:00");
  });

  it("render の時刻行は formattedDate を載せる（ja）", () => {
    const snap = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", 96212, "exact", 540, "time"),
        calendar: CAL_MONTHS,
        characterIds: [],
      }),
      "ja",
    );
    const text = renderChronicleSnapshot(snap, "ja");
    expect(text).toContain("作中時刻: 1267年4月3日 09:00");
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

  it("確度 approx/unknown は時刻行に確度注記を付す（ja）", () => {
    const approx = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", 100, "approx"),
        events: [],
        calendar: CAL,
        characterIds: [],
      }),
    );
    expect(renderChronicleSnapshot(approx, "ja")).toContain("日付はおおよそ");
    const unknown = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", 100, "unknown"),
        events: [],
        calendar: CAL,
        characterIds: [],
      }),
    );
    expect(renderChronicleSnapshot(unknown, "ja")).toContain("日付は不確実");
    // exact は注記なし。
    const exact = deriveChronicleSnapshot(
      input({
        anchor: stamped("a5", 100, "exact"),
        events: [],
        calendar: CAL,
        characterIds: [],
      }),
    );
    expect(renderChronicleSnapshot(exact, "ja")).not.toContain("日付は");
  });

  it("none モードはオフページ背景のみを描画", () => {
    const snap = deriveChronicleSnapshot(
      input({
        anchor: {
          ordinal: "",
          startTime: null,
          startMinute: null,
          startGranularity: "none",
          precision: null,
          source: "none",
        },
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
      anchor: {
        ordinal: "",
        startTime: null,
        startMinute: null,
        startGranularity: "none",
        precision: null,
        source: "none",
      },
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
      anchor: {
        ordinal: "",
        startTime: null,
        startMinute: null,
        startGranularity: "none",
        precision: null,
        source: "none",
      },
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

  it("AI 秘匿: secret イベントは reveal シーン前で隠れ reveal シーン以降で出る", () => {
    const events = [
      mkEvent({ id: "e1", title: "戴冠式", ordinal: "a2" }),
      mkEvent({
        id: "sec",
        title: "毒殺の真相",
        ordinal: "a1",
        secret: true,
        revealSceneId: "s2",
      }),
    ];
    const base = {
      events,
      participants: [],
      relations: [],
      sceneEvents: [{ sceneId: "s1", eventId: "e1" }],
      calendar: CAL,
      readingOrder: new Map<string, number>([
        ["s1", 0],
        ["s2", 1],
      ]),
      codexNames: new Map<string, string>(),
      lang: "ja",
    };
    // s1（reveal s2 より前）: 秘匿イベントは出ない。
    const before = assembleChronicleSnapshotText({ ...base, sceneId: "s1" });
    expect(before).toContain("戴冠式");
    expect(before ?? "").not.toContain("毒殺");
    // s2（reveal 以降）: 秘匿イベントが背景に出る。
    const after = assembleChronicleSnapshotText({ ...base, sceneId: "s2" });
    expect(after).toContain("毒殺");
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

  it("scene-own: sceneChronicle の暦日付で source=scene の時刻行(formattedDate)を出す", () => {
    const sceneChronicle = new Map<string, SceneChronicle>([
      [
        "s1",
        {
          startTime: 96212,
          startMinute: 540,
          startGranularity: "time",
          precision: "exact",
        },
      ],
    ]);
    const text = assembleChronicleSnapshotText({
      sceneId: "s1",
      events: [
        mkEvent({ id: "e1", title: "邂逅", ordinal: "a1", startTime: 96000 }),
      ],
      participants: [],
      relations: [],
      sceneEvents: [], // stamp なし → scene-own が発火する条件
      calendar: CAL_MONTHS,
      readingOrder: new Map([["s1", 0]]),
      codexNames: new Map(),
      sceneChronicle,
      lang: "ja",
    });
    expect(text).toContain("作中時刻: 1267年4月3日 09:00");
    expect(text).toContain("邂逅"); // synthetic ordinal 経由で recent も出る
  });

  it("events 0件でも現在シーンに暦日付があれば注入する（source=scene）", () => {
    const sceneChronicle = new Map<string, SceneChronicle>([
      [
        "s1",
        {
          startTime: 96212,
          startMinute: null,
          startGranularity: "day",
          precision: "exact",
        },
      ],
    ]);
    const text = assembleChronicleSnapshotText({
      sceneId: "s1",
      events: [],
      participants: [],
      relations: [],
      sceneEvents: [],
      calendar: CAL_MONTHS,
      readingOrder: new Map([["s1", 0]]),
      codexNames: new Map(),
      sceneChronicle,
      lang: "ja",
    });
    expect(text).toBeDefined();
    expect(text).toContain("作中時刻: 1267年4月3日");
  });

  it("暦日付が全 event より前のシーン: 時刻行は出るが未来の出来事は背景に漏らさない（source=scene, synthetic ordinal=''）", () => {
    // scene の startTime(0) が全 event(>=96000)より前 → syntheticOrdinal="".
    // recent/offpage/causal は空（まだ何も起きていない＝正しい）が、時刻行は注入される。
    // 未来の出来事を offpage に出すと「既に起きた背景」と誤読させる spoiler になるため出さない。
    const sceneChronicle = new Map<string, SceneChronicle>([
      [
        "s1",
        {
          startTime: 0,
          startMinute: null,
          startGranularity: "day",
          precision: "exact",
        },
      ],
    ]);
    const text = assembleChronicleSnapshotText({
      sceneId: "s1",
      events: [
        mkEvent({
          id: "e1",
          title: "未来の出立",
          ordinal: "a1",
          startTime: 96000,
        }),
        mkEvent({
          id: "e3",
          title: "未来の決戦",
          ordinal: "a3",
          startTime: 96500,
        }),
      ],
      participants: [],
      relations: [],
      sceneEvents: [],
      calendar: CAL_MONTHS,
      readingOrder: new Map([["s1", 0]]),
      codexNames: new Map(),
      sceneChronicle,
      lang: "ja",
    });
    expect(text).toBeDefined();
    expect(text).toContain("作中時刻: 1000年1月1日"); // barren ではない＝日付は注入される
    expect(text).not.toContain("未来の出立"); // 未来の出来事は背景に漏らさない
    expect(text).not.toContain("未来の決戦");
  });
});
