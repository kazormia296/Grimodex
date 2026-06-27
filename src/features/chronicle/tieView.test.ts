import { describe, it, expect } from "vitest";
import { buildTieView } from "./tieView";

describe("buildTieView", () => {
  const base = {
    scenes: [
      { id: "s1", title: "場面1" },
      { id: "s2", title: "場面2" },
      { id: "s3", title: "場面3" },
    ],
    events: [
      { id: "e1", title: "出来事1", ordinal: "a1" },
      { id: "e2", title: "出来事2", ordinal: "a0" },
    ],
    links: [
      { sceneId: "s1", eventId: "e1" },
      { sceneId: "s2", eventId: "e2" },
    ],
    width: 400,
    padX: 50,
    topY: 20,
    bottomY: 80,
  };

  it("scene は reading 順で等間隔、event は ordinal 順で等間隔", () => {
    const m = buildTieView(base);
    expect(m.sceneDots.map((d) => [d.id, d.x])).toEqual([
      ["s1", 50],
      ["s2", 200],
      ["s3", 350],
    ]);
    // event は ordinal 昇順 e2(a0), e1(a1)。各トラック独立スペーシング(2点→50/350)。
    expect(m.eventDots.map((d) => [d.id, d.x])).toEqual([
      ["e2", 50],
      ["e1", 350],
    ]);
  });

  it("タイ線は scene-x(top) → event-x(bottom)", () => {
    const m = buildTieView(base);
    const t1 = m.ties.find((t) => t.sceneId === "s1" && t.eventId === "e1")!;
    expect(t1.x1).toBe(50); // s1
    expect(t1.x2).toBe(350); // e1
    const t2 = m.ties.find((t) => t.sceneId === "s2" && t.eventId === "e2")!;
    expect(t2.x1).toBe(200); // s2
    expect(t2.x2).toBe(50); // e2
    expect(m.topY).toBe(20);
    expect(m.bottomY).toBe(80);
  });

  it("scene/event のどちらかが無いリンクは除外", () => {
    const m = buildTieView({
      ...base,
      links: [{ sceneId: "s1", eventId: "missing" }],
    });
    expect(m.ties).toHaveLength(0);
  });

  it("空入力は空モデル", () => {
    const m = buildTieView({ ...base, scenes: [], events: [], links: [] });
    expect(m.sceneDots).toEqual([]);
    expect(m.eventDots).toEqual([]);
    expect(m.ties).toEqual([]);
  });

  it("1点は padX に配置（n=1 で step=0）", () => {
    const m = buildTieView({
      ...base,
      scenes: [{ id: "s1", title: "場面1" }],
      events: [{ id: "e1", title: "出来事1", ordinal: "a0" }],
      links: [{ sceneId: "s1", eventId: "e1" }],
    });
    expect(m.sceneDots).toEqual([{ id: "s1", title: "場面1", x: 50 }]);
    expect(m.eventDots).toEqual([{ id: "e1", title: "出来事1", x: 50 }]);
  });

  it("ordinal 同値は id 昇順で決定的（入力配列順に依存しない）", () => {
    // listEvents は ORDER BY 無しなので入力順が前後しうる。両順序で同じ x 配置になること。
    const evA = { id: "ea", title: "A", ordinal: "a0" };
    const evB = { id: "eb", title: "B", ordinal: "a0" }; // 同じ ordinal
    const forward = buildTieView({
      ...base,
      scenes: [{ id: "s1", title: "場面1" }],
      events: [evA, evB],
      links: [],
    });
    const reversed = buildTieView({
      ...base,
      scenes: [{ id: "s1", title: "場面1" }],
      events: [evB, evA], // 入力順を反転
      links: [],
    });
    // どちらも id 昇順: ea(50) → eb(350)
    expect(forward.eventDots.map((d) => [d.id, d.x])).toEqual([
      ["ea", 50],
      ["eb", 350],
    ]);
    expect(reversed.eventDots.map((d) => [d.id, d.x])).toEqual(
      forward.eventDots.map((d) => [d.id, d.x]),
    );
  });

  it("交差: 読む順 s1<s2 だが作中順 e2<e1 → x1 と x2 の順序が逆転", () => {
    // s1→e1, s2→e2。reading 順は s1<s2、作中順は e2(a0)<e1(a1)。
    const m = buildTieView({
      ...base,
      scenes: [
        { id: "s1", title: "場面1" },
        { id: "s2", title: "場面2" },
      ],
      events: [
        { id: "e1", title: "出来事1", ordinal: "a1" },
        { id: "e2", title: "出来事2", ordinal: "a0" },
      ],
      links: [
        { sceneId: "s1", eventId: "e1" },
        { sceneId: "s2", eventId: "e2" },
      ],
    });
    const t1 = m.ties.find((t) => t.sceneId === "s1")!;
    const t2 = m.ties.find((t) => t.sceneId === "s2")!;
    // 上トラック(reading): s1 が左、s2 が右
    expect(t1.x1).toBeLessThan(t2.x1);
    // 下トラック(作中): e1 が右、e2 が左 → 逆転（=線が交差）
    expect(t1.x2).toBeGreaterThan(t2.x2);
  });
});
