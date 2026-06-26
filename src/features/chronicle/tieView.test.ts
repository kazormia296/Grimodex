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
});
