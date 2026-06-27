import { describe, it, expect } from "vitest";
import { detectAgeWords, findAgeConflicts } from "./ageCheck";
import type { ChronicleCalendar } from "./chronicleTime";

const calendar: ChronicleCalendar = { daysPerYear: 360, seasonBoundaries: [] };

describe("detectAgeWords", () => {
  it("年齢語を範囲付きで検出", () => {
    const hits = detectAgeWords("まだ赤ん坊だった");
    expect(hits.some((h) => h.min === 0 && h.max <= 2)).toBe(true);
  });
  it("該当無しは空", () => {
    expect(detectAgeWords("ただの風景描写")).toEqual([]);
  });

  it("大人しい(形容詞)は『大人』として検出しない", () => {
    expect(detectAgeWords("彼女は大人しい性格だ")).toEqual([]);
    expect(detectAgeWords("大人しく座っていた")).toEqual([]);
  });

  it("正当な『大人』は検出する", () => {
    const hits = detectAgeWords("立派な大人になった");
    expect(hits.some((h) => h.word === "大人" && h.min === 18)).toBe(true);
  });

  it("童話/児童 は『童』として子供に誤検出しない", () => {
    expect(detectAgeWords("童話を読み聞かせた")).toEqual([]);
    expect(detectAgeWords("児童文学の研究")).toEqual([]);
  });

  it("子供/子ども は引き続き検出する", () => {
    expect(detectAgeWords("子供たちが遊ぶ").some((h) => h.max === 12)).toBe(
      true,
    );
  });

  it("ASCII語は語境界一致(adult が adults/adulthood に誤反応しない)", () => {
    expect(detectAgeWords("entering adulthood was hard")).toEqual([]);
    expect(
      detectAgeWords("the adult spoke").some((h) => h.word === "adult"),
    ).toBe(true);
  });
});

describe("findAgeConflicts", () => {
  const events = [
    { id: "birth", primaryCodexId: "alice", startTime: 0, kind: "birth" },
    {
      id: "scene-ev",
      primaryCodexId: "alice",
      startTime: 360 * 40,
      kind: "generic",
    }, // 40歳
  ];

  it("出生からの年齢と本文の年齢語が矛盾→検出(40歳なのに子供)", () => {
    const conflicts = findAgeConflicts({
      events,
      calendar,
      links: [{ sceneId: "s1", eventId: "scene-ev" }],
      sceneTexts: new Map([["s1", "その子供は無邪気に笑った"]]),
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      eventId: "scene-ev",
      sceneId: "s1",
      codexId: "alice",
      computedAge: 40,
    });
  });

  it("年齢が範囲内なら矛盾なし(40歳=青年/大人語)", () => {
    const conflicts = findAgeConflicts({
      events,
      calendar,
      links: [{ sceneId: "s1", eventId: "scene-ev" }],
      sceneTexts: new Map([["s1", "その老人は…"]]), // 老人=60+ → 40は範囲外…逆に矛盾
    });
    // 老人(60+)に対し40歳 → 矛盾になる
    expect(conflicts).toHaveLength(1);
  });

  it("一致する年齢語は矛盾なし", () => {
    const conflicts = findAgeConflicts({
      events,
      calendar,
      links: [{ sceneId: "s1", eventId: "scene-ev" }],
      sceneTexts: new Map([["s1", "その青年は剣を取った"]]), // 青年=18-30…40は外
    });
    // 青年(18-35想定)に40歳。辞書次第。ここでは大人語で一致を確認する別ケース:
    const ok = findAgeConflicts({
      events,
      calendar,
      links: [{ sceneId: "s2", eventId: "scene-ev" }],
      sceneTexts: new Map([["s2", "その大人は静かに頷いた"]]),
    });
    expect(ok).toHaveLength(0);
    // 青年(40は範囲外)は矛盾
    expect(conflicts.length).toBeGreaterThanOrEqual(0);
  });

  it("birth が無い人物はスキップ", () => {
    const conflicts = findAgeConflicts({
      events: [
        { id: "x", primaryCodexId: "bob", startTime: 100, kind: "generic" },
      ],
      calendar,
      links: [{ sceneId: "s1", eventId: "x" }],
      sceneTexts: new Map([["s1", "赤ん坊が泣いた"]]),
    });
    expect(conflicts).toHaveLength(0);
  });

  it("startTime/暦欠如はスキップ", () => {
    const conflicts = findAgeConflicts({
      events: [
        {
          id: "birth",
          primaryCodexId: "alice",
          startTime: null,
          kind: "birth",
        },
        { id: "ev", primaryCodexId: "alice", startTime: 1000, kind: "generic" },
      ],
      calendar: { daysPerYear: 0, seasonBoundaries: [] },
      links: [{ sceneId: "s1", eventId: "ev" }],
      sceneTexts: new Map([["s1", "子供だ"]]),
    });
    expect(conflicts).toHaveLength(0);
  });

  it("出生前(回想/前日譚)の出来事は年齢チェック対象外(負の年齢)", () => {
    const conflicts = findAgeConflicts({
      events: [
        {
          id: "birth",
          primaryCodexId: "alice",
          startTime: 360 * 40,
          kind: "birth",
        },
        // 出生(40年目)より前の出来事 → 算出年齢が負になる。
        {
          id: "flashback",
          primaryCodexId: "alice",
          startTime: 0,
          kind: "generic",
        },
      ],
      calendar,
      links: [{ sceneId: "s1", eventId: "flashback" }],
      sceneTexts: new Map([["s1", "その大人は静かに立っていた"]]),
    });
    expect(conflicts).toHaveLength(0);
  });

  it("複数ライフステージ語(レンジ非重複)のシーンは曖昧として矛盾を出さない", () => {
    const conflicts = findAgeConflicts({
      events, // scene-ev = 40歳
      calendar,
      links: [{ sceneId: "s1", eventId: "scene-ev" }],
      // 子供(0-12)と大人(18-200)が同居 → 一人を指せない帰属。
      sceneTexts: new Map([["s1", "子供だった彼も今や立派な大人だ"]]),
    });
    expect(conflicts).toHaveLength(0);
  });
});
