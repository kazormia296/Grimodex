import { describe, it, expect } from "vitest";
import {
  scaleEvents,
  precisionStyle,
  type ScaleInputEvent,
} from "./chronicleTimeScale";

const params = { width: 1000, padX: 50, zoom: 1, scrollOffset: 0 };

function ev(
  o: Partial<ScaleInputEvent> & { id: string; ordinal: string },
): ScaleInputEvent {
  return { startTime: null, endTime: null, ...o };
}

describe("scaleEvents", () => {
  it("ordinal 等間隔: startTime 無しは rank で等間隔配置", () => {
    const events = [
      ev({ id: "b", ordinal: "a1" }),
      ev({ id: "a", ordinal: "a0" }),
      ev({ id: "c", ordinal: "a2" }),
    ];
    const out = scaleEvents(events, params);
    // ordinal 昇順 a,b,c。inner = (1000-100)*1 = 900, step = 900/2 = 450
    expect(out.map((p) => p.eventId)).toEqual(["a", "b", "c"]);
    expect(out[0].x).toBe(50);
    expect(out[1].x).toBe(500);
    expect(out[2].x).toBe(950);
    expect(out.every((p) => p.xEnd === null)).toBe(true);
  });

  it("時刻比例: 全 event に startTime があれば時刻に比例配置", () => {
    const events = [
      ev({ id: "a", ordinal: "a0", startTime: 0 }),
      ev({ id: "b", ordinal: "a1", startTime: 50 }),
      ev({ id: "c", ordinal: "a2", startTime: 100 }),
    ];
    const out = scaleEvents(events, params);
    // span=100, inner=900: a→50, b→50+450=500, c→50+900=950
    expect(out[0].x).toBe(50);
    expect(out[1].x).toBe(500);
    expect(out[2].x).toBe(950);
  });

  it("interval: 時刻モードで endTime があれば xEnd を返す", () => {
    const events = [
      ev({ id: "a", ordinal: "a0", startTime: 0, endTime: 50 }),
      ev({ id: "b", ordinal: "a1", startTime: 100 }),
    ];
    const out = scaleEvents(events, params);
    // span=100, inner=900: a.x=50, a.xEnd=50+(50/100)*900=500
    expect(out[0].x).toBe(50);
    expect(out[0].xEnd).toBe(500);
    expect(out[1].xEnd).toBeNull();
  });

  it("zoom と scrollOffset を反映", () => {
    const events = [
      ev({ id: "a", ordinal: "a0" }),
      ev({ id: "b", ordinal: "a1" }),
    ];
    const out = scaleEvents(events, { ...params, zoom: 2, scrollOffset: 100 });
    // inner=900*2=1800, step=1800, a.x=50-100=-50, b.x=50+1800-100=1750
    expect(out[0].x).toBe(-50);
    expect(out[1].x).toBe(1750);
  });

  it("単一 event は padX に置く", () => {
    const out = scaleEvents([ev({ id: "a", ordinal: "a0" })], params);
    expect(out[0].x).toBe(50);
  });

  it("空配列は空", () => {
    expect(scaleEvents([], params)).toEqual([]);
  });

  it("ordinal 順 != startTime 順（フラッシュバック）でも全 x/xEnd が帯内", () => {
    // ordinal は a0<a1<a2 だが startTime は 50,0,100 と前後する。
    const events = [
      ev({ id: "a", ordinal: "a0", startTime: 50, endTime: 70 }),
      ev({ id: "b", ordinal: "a1", startTime: 0 }),
      ev({ id: "c", ordinal: "a2", startTime: 100 }),
    ];
    const out = scaleEvents(events, params);
    // inner=900: band は [50, 950]
    const lo = params.padX;
    const hi = params.padX + 900;
    for (const p of out) {
      expect(p.x).toBeGreaterThanOrEqual(lo);
      expect(p.x).toBeLessThanOrEqual(hi);
      if (p.xEnd != null) {
        expect(p.xEnd).toBeGreaterThanOrEqual(lo);
        expect(p.xEnd).toBeLessThanOrEqual(hi);
      }
    }
  });

  it("末尾 interval の endTime が最大 startTime を超えても xEnd は帯内", () => {
    const events = [
      ev({ id: "a", ordinal: "a0", startTime: 0 }),
      ev({ id: "b", ordinal: "a1", startTime: 100, endTime: 150 }),
    ];
    const out = scaleEvents(events, params);
    const hi = params.padX + 900;
    // t0=0, t1=150(endTime), span=150 → b.xEnd=(150/150)*900+50=950
    expect(out[1].xEnd).toBe(950);
    expect(out[1].xEnd as number).toBeLessThanOrEqual(hi);
  });

  it("重複 ordinal は id で決定的に並ぶ", () => {
    const events = [
      ev({ id: "z", ordinal: "a0" }),
      ev({ id: "a", ordinal: "a0" }),
      ev({ id: "m", ordinal: "a0" }),
    ];
    const out = scaleEvents(events, params);
    expect(out.map((p) => p.eventId)).toEqual(["a", "m", "z"]);
  });
});

describe("precisionStyle", () => {
  it("exact=実線・不透明、approx=半透明、unknown=破線・薄い", () => {
    expect(precisionStyle("exact").dashed).toBe(false);
    expect(precisionStyle("exact").opacity).toBe(1);
    expect(precisionStyle("approx").opacity).toBeLessThan(1);
    expect(precisionStyle("unknown").dashed).toBe(true);
  });
});
