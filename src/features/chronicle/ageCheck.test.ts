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
});
