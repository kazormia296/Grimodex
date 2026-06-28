import { describe, it, expect } from "vitest";
import { resolveSceneAnchor } from "./resolveSceneAnchor";
import type { EventRow, SceneEventRow } from "./api";

/** テスト用の最小 event 行。resolveSceneAnchor は id/ordinal/startTime のみ使う。 */
function ev(
  id: string,
  ordinal: string,
  startTime: number | null = null,
): Pick<EventRow, "id" | "ordinal" | "startTime"> {
  return { id, ordinal, startTime };
}
function link(sceneId: string, eventId: string): SceneEventRow {
  return { sceneId, eventId };
}
/** reading-order index を Map で与える（小さいほど前方）。 */
function order(...sceneIds: string[]): Map<string, number> {
  return new Map(sceneIds.map((id, i) => [id, i] as const));
}

describe("resolveSceneAnchor", () => {
  it("stamped: 現在シーンの紐づき event のうち ordinal 最大を採用し startTime も取る", () => {
    const a = resolveSceneAnchor("s1", {
      sceneEvents: [link("s1", "e1"), link("s1", "e2")],
      events: [ev("e1", "a0", 10), ev("e2", "a5", 30)],
      readingOrder: order("s1", "s2"),
    });
    expect(a).toEqual({ ordinal: "a5", startTime: 30, source: "stamped" });
  });

  it("stamped: startTime=null の event でも ordinal は採用（暦系のみ null）", () => {
    const a = resolveSceneAnchor("s1", {
      sceneEvents: [link("s1", "e1")],
      events: [ev("e1", "a3", null)],
      readingOrder: order("s1"),
    });
    expect(a).toEqual({ ordinal: "a3", startTime: null, source: "stamped" });
  });

  it("proxy: 現在シーンに stamp 無し → 前方で最も近い stamp 済シーンを代理採用", () => {
    const a = resolveSceneAnchor("s3", {
      sceneEvents: [link("s1", "e1"), link("s2", "e2")],
      events: [ev("e1", "a0", 5), ev("e2", "a2", 20)],
      readingOrder: order("s1", "s2", "s3", "s4"),
    });
    // s3 の直前 stamp は s2 → e2
    expect(a).toEqual({
      ordinal: "a2",
      startTime: 20,
      source: "proxy",
      proxySceneId: "s2",
    });
  });

  it("proxy: 複数前方 stamp があれば最遠ではなく最も近い前方を採る", () => {
    const a = resolveSceneAnchor("s4", {
      sceneEvents: [link("s1", "e1"), link("s3", "e3")],
      events: [ev("e1", "a9", 99), ev("e3", "a1", 7)],
      readingOrder: order("s1", "s2", "s3", "s4"),
    });
    // 最も近い前方 = s3（e1 の ordinal が大きくても無関係）
    expect(a.source).toBe("proxy");
    expect(a.proxySceneId).toBe("s3");
    expect(a.ordinal).toBe("a1");
    expect(a.startTime).toBe(7);
  });

  it("proxy: 後方(未来)stamp は見ない（フラッシュバック誤 anchor 防止）", () => {
    const a = resolveSceneAnchor("s1", {
      sceneEvents: [link("s3", "e3")], // s1 より後方のみ stamp
      events: [ev("e3", "a5", 50)],
      readingOrder: order("s1", "s2", "s3"),
    });
    expect(a).toEqual({ ordinal: "", startTime: null, source: "none" });
  });

  it("none: プロジェクト内に stamp が皆無", () => {
    const a = resolveSceneAnchor("s1", {
      sceneEvents: [],
      events: [ev("e1", "a0", 5)],
      readingOrder: order("s1", "s2"),
    });
    expect(a).toEqual({ ordinal: "", startTime: null, source: "none" });
  });

  it("none: 現在シーンが reading-order に無く（削除済等）stamp も無いと proxy 不能", () => {
    const a = resolveSceneAnchor("ghost", {
      sceneEvents: [link("s1", "e1")],
      events: [ev("e1", "a0", 5)],
      readingOrder: order("s1", "s2"),
    });
    expect(a.source).toBe("none");
  });

  it("stamp 行が events に無い（孤児）場合は無視して none", () => {
    const a = resolveSceneAnchor("s1", {
      sceneEvents: [link("s1", "eX")], // eX は events に存在しない
      events: [],
      readingOrder: order("s1"),
    });
    expect(a.source).toBe("none");
  });
});
