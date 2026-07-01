import { describe, it, expect } from "vitest";
import {
  collectFulfilledSceneTexts,
  mergeAgeCheckEvents,
} from "./useSeasonConflicts";

type E = { id: string; startTime: number | null };

describe("mergeAgeCheckEvents", () => {
  const events: E[] = [{ id: "e1", startTime: 10 }];
  const links = [{ sceneId: "sA", eventId: "e1" }];

  it("ageExtraEvents 未指定なら入力をそのまま返す（季節チェック影響なし）", () => {
    const r = mergeAgeCheckEvents(events, links, undefined);
    expect(r.ageEvents).toBe(events);
    expect(r.ageLinks).toBe(links);
  });

  it("空配列も入力そのまま", () => {
    const r = mergeAgeCheckEvents(events, links, []);
    expect(r.ageEvents).toBe(events);
    expect(r.ageLinks).toBe(links);
  });

  it("scene-event を足し、暗黙リンク(scene:<id> ↔ <id>)を張る", () => {
    const extra: E[] = [
      { id: "scene:sc1", startTime: 20 },
      { id: "scene:sc2", startTime: 30 },
    ];
    const r = mergeAgeCheckEvents(events, links, extra);
    expect(r.ageEvents.map((e) => e.id)).toEqual([
      "e1",
      "scene:sc1",
      "scene:sc2",
    ]);
    expect(r.ageLinks).toEqual([
      { sceneId: "sA", eventId: "e1" },
      { sceneId: "sc1", eventId: "scene:sc1" }, // 自分自身の本文を参照
      { sceneId: "sc2", eventId: "scene:sc2" },
    ]);
  });
});

describe("collectFulfilledSceneTexts", () => {
  it("成功分のみ Map 化する（失敗は無視）", () => {
    const m = collectFulfilledSceneTexts([
      { status: "fulfilled", value: ["s1", "本文1"] },
      { status: "rejected", reason: new Error("x") },
      { status: "fulfilled", value: ["s2", "本文2"] },
    ] as PromiseSettledResult<readonly [string, string]>[]);
    expect(m.get("s1")).toBe("本文1");
    expect(m.get("s2")).toBe("本文2");
    expect(m.size).toBe(2);
  });
});
