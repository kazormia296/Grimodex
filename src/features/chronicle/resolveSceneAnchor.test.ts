import { describe, it, expect } from "vitest";
import { resolveSceneAnchor, type SceneChronicle } from "./resolveSceneAnchor";
import type { EventRow, SceneEventRow } from "./api";

/** テスト用の最小 event 行。resolveSceneAnchor は id/ordinal/startTime/startMinute/startGranularity/precision を使う。 */
function ev(
  id: string,
  ordinal: string,
  startTime: number | null = null,
  precision: EventRow["precision"] = "exact",
  startMinute: number | null = null,
  startGranularity: EventRow["startGranularity"] = "none",
): Pick<
  EventRow,
  | "id"
  | "ordinal"
  | "startTime"
  | "startMinute"
  | "startGranularity"
  | "precision"
> {
  return { id, ordinal, startTime, startMinute, startGranularity, precision };
}
function link(sceneId: string, eventId: string): SceneEventRow {
  return { sceneId, eventId };
}
/** reading-order index を Map で与える（小さいほど前方）。 */
function order(...sceneIds: string[]): Map<string, number> {
  return new Map(sceneIds.map((id, i) => [id, i] as const));
}
/** シーン自身の暦日付（scene-own アンカー源）。 */
function sc(
  startTime: number | null,
  startGranularity: SceneChronicle["startGranularity"] = "day",
  startMinute: number | null = null,
  precision: SceneChronicle["precision"] = "exact",
): SceneChronicle {
  return { startTime, startMinute, startGranularity, precision };
}

describe("resolveSceneAnchor", () => {
  it("stamped: 現在シーンの紐づき event のうち ordinal 最大を採用し startTime も取る", () => {
    const a = resolveSceneAnchor("s1", {
      sceneEvents: [link("s1", "e1"), link("s1", "e2")],
      events: [ev("e1", "a0", 10), ev("e2", "a5", 30)],
      readingOrder: order("s1", "s2"),
    });
    expect(a).toEqual({
      ordinal: "a5",
      startTime: 30,
      startMinute: null,
      startGranularity: "none",
      precision: "exact",
      source: "stamped",
    });
  });

  it("stamped: アンカー event の startMinute / startGranularity を運ぶ", () => {
    const a = resolveSceneAnchor("s1", {
      sceneEvents: [link("s1", "e1")],
      events: [ev("e1", "a5", 96212, "exact", 540, "time")],
      readingOrder: order("s1"),
    });
    expect(a.source).toBe("stamped");
    expect(a.startMinute).toBe(540);
    expect(a.startGranularity).toBe("time");
  });

  it("proxy: 代理元 event の startMinute / startGranularity を運ぶ", () => {
    const a = resolveSceneAnchor("s2", {
      sceneEvents: [link("s1", "e1")],
      events: [ev("e1", "a1", 100, "exact", null, "day")],
      readingOrder: order("s1", "s2"),
    });
    expect(a.source).toBe("proxy");
    expect(a.startMinute).toBeNull();
    expect(a.startGranularity).toBe("day");
  });

  it("stamped: startTime=null の event でも ordinal は採用（暦系のみ null）", () => {
    const a = resolveSceneAnchor("s1", {
      sceneEvents: [link("s1", "e1")],
      events: [ev("e1", "a3", null)],
      readingOrder: order("s1"),
    });
    expect(a).toEqual({
      ordinal: "a3",
      startTime: null,
      startMinute: null,
      startGranularity: "none",
      precision: "exact",
      source: "stamped",
    });
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
      startMinute: null,
      startGranularity: "none",
      precision: "exact",
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
    expect(a).toEqual({
      ordinal: "",
      startTime: null,
      startMinute: null,
      startGranularity: "none",
      precision: null,
      source: "none",
    });
  });

  it("none: プロジェクト内に stamp が皆無", () => {
    const a = resolveSceneAnchor("s1", {
      sceneEvents: [],
      events: [ev("e1", "a0", 5)],
      readingOrder: order("s1", "s2"),
    });
    expect(a).toEqual({
      ordinal: "",
      startTime: null,
      startMinute: null,
      startGranularity: "none",
      precision: null,
      source: "none",
    });
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

describe("resolveSceneAnchor — scene-own (v2)", () => {
  it("scene-own: シーン自身の暦日付を source=scene で採用し synthetic ordinal を当てる", () => {
    const a = resolveSceneAnchor("s1", {
      sceneEvents: [],
      events: [ev("e1", "a1", 10), ev("e2", "a2", 50), ev("e3", "a3", 200)],
      readingOrder: order("s1"),
      sceneChronicle: new Map([["s1", sc(100, "day", 540, "approx")]]),
    });
    // startTime<=100 のうち最大 startTime=50(e2 a2) → synthetic ordinal=a2
    expect(a).toEqual({
      ordinal: "a2",
      startTime: 100,
      startMinute: 540,
      startGranularity: "day",
      precision: "approx",
      source: "scene",
    });
  });

  it("scene-own: 該当 event（startTime<=t）が無ければ ordinal は空", () => {
    const a = resolveSceneAnchor("s1", {
      sceneEvents: [],
      events: [ev("e1", "a5", 999)], // すべて t より未来
      readingOrder: order("s1"),
      sceneChronicle: new Map([["s1", sc(100, "day")]]),
    });
    expect(a.source).toBe("scene");
    expect(a.ordinal).toBe("");
  });

  it("scene-own は stamped より優先される（同一シーンが両方持つ）", () => {
    const a = resolveSceneAnchor("s1", {
      sceneEvents: [link("s1", "e1")],
      events: [ev("e1", "a9", 5)],
      readingOrder: order("s1"),
      sceneChronicle: new Map([["s1", sc(100, "day")]]),
    });
    expect(a.source).toBe("scene");
    expect(a.startTime).toBe(100);
  });

  it("granularity=none の scene 日付は scene-own を発火させない（stamped にフォールバック）", () => {
    const a = resolveSceneAnchor("s1", {
      sceneEvents: [link("s1", "e1")],
      events: [ev("e1", "a3", 30)],
      readingOrder: order("s1"),
      sceneChronicle: new Map([["s1", sc(100, "none")]]),
    });
    expect(a.source).toBe("stamped");
    expect(a.startTime).toBe(30);
  });

  it("startTime=null の scene 日付は scene-own を発火させない", () => {
    const a = resolveSceneAnchor("s1", {
      sceneEvents: [],
      events: [ev("e1", "a3", 30)],
      readingOrder: order("s1"),
      sceneChronicle: new Map([["s1", sc(null, "day")]]),
    });
    expect(a.source).toBe("none");
  });

  it("proxy: 前方の scene-own シーンも代理候補にする（その directAnchor を運ぶ）", () => {
    const a = resolveSceneAnchor("s2", {
      sceneEvents: [],
      events: [ev("e1", "a1", 10), ev("e2", "a2", 80)],
      readingOrder: order("s1", "s2"),
      sceneChronicle: new Map([["s1", sc(100, "day", 600, "exact")]]),
    });
    // 前方 s1 が scene-own。proxy はその anchor（startTime 100, synthetic a2）を運ぶ
    expect(a).toEqual({
      ordinal: "a2",
      startTime: 100,
      startMinute: 600,
      startGranularity: "day",
      precision: "exact",
      source: "proxy",
      proxySceneId: "s1",
    });
  });

  it("proxy: scene-own シーンと stamped シーンが両方前方にあれば最も近い前方を採る", () => {
    const a = resolveSceneAnchor("s3", {
      sceneEvents: [link("s1", "e1")],
      events: [ev("e1", "a1", 5), ev("e2", "a2", 60)],
      readingOrder: order("s1", "s2", "s3"),
      sceneChronicle: new Map([["s2", sc(100, "day")]]),
    });
    // s1(stamped, idx0) と s2(scene-own, idx1) → s3 の直前は s2
    expect(a.source).toBe("proxy");
    expect(a.proxySceneId).toBe("s2");
    expect(a.startTime).toBe(100);
  });

  it("sceneChronicle 未指定なら従来 stamped 挙動（後方互換）", () => {
    const a = resolveSceneAnchor("s1", {
      sceneEvents: [link("s1", "e1")],
      events: [ev("e1", "a0", 10)],
      readingOrder: order("s1"),
    });
    expect(a.source).toBe("stamped");
  });
});
