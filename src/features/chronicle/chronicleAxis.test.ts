import { describe, it, expect } from "vitest";
import {
  effectiveDays,
  clampPxPerDay,
  fitAll,
  zoomAt,
  zoomByCenter,
  panByPx,
  dayToX,
  xToDay,
  scrollGeom,
  viewStartFromThumb,
  type AxisEventInput,
  type View,
} from "./chronicleAxis";

const ev = (
  id: string,
  ordinal: string,
  startTime: number | null,
  endTime: number | null = null,
): AxisEventInput => ({ id, ordinal, startTime, endTime });

describe("effectiveDays", () => {
  it("empty input", () => {
    const r = effectiveDays([]);
    expect(r.byId.size).toBe(0);
    expect(r.hasCalendarAxis).toBe(false);
    expect(r.dataStart).toBe(0);
    expect(r.dataEnd).toBe(0);
  });

  it("calendar mode when every startTime present", () => {
    const r = effectiveDays([
      ev("a", "a0", 10, null),
      ev("b", "a1", 5, 8),
      ev("c", "a2", 20, 18), // endTime < startTime -> max clamps to startTime
    ]);
    expect(r.hasCalendarAxis).toBe(true);
    expect(r.byId.get("a")).toEqual({ startDay: 10, endDay: null });
    expect(r.byId.get("b")).toEqual({ startDay: 5, endDay: 8 });
    // endTime 18 < startTime 20 -> endDay = max(18,20) = 20
    expect(r.byId.get("c")).toEqual({ startDay: 20, endDay: 20 });
    // dataStart = min over startDay & endDay = 5; dataEnd = max = 20
    expect(r.dataStart).toBe(5);
    expect(r.dataEnd).toBe(20);
  });

  it("dataStart/dataEnd account for interval endDay extending the range", () => {
    const r = effectiveDays([
      ev("a", "a0", 0, 100), // long interval
      ev("b", "a1", 3, null),
    ]);
    expect(r.dataStart).toBe(0);
    expect(r.dataEnd).toBe(100);
    expect(r.byId.get("a")).toEqual({ startDay: 0, endDay: 100 });
  });

  it("sequence mode when any startTime missing; ranks in cmpKeys order", () => {
    // ordinals deliberately out of array order; effective rank should follow cmpKeys
    const r = effectiveDays([
      ev("z", "a2", null, null),
      ev("y", "a0", 5, null),
      ev("x", "a1", null, null),
    ]);
    expect(r.hasCalendarAxis).toBe(false);
    // sorted by ordinal: a0(y)=0, a1(x)=1, a2(z)=2
    expect(r.byId.get("y")).toEqual({ startDay: 0, endDay: null });
    expect(r.byId.get("x")).toEqual({ startDay: 1, endDay: null });
    expect(r.byId.get("z")).toEqual({ startDay: 2, endDay: null });
    expect(r.dataStart).toBe(0);
    expect(r.dataEnd).toBe(2);
  });

  it("sequence mode tie-breaks equal ordinals by id string", () => {
    const r = effectiveDays([
      ev("b", "a0", null, null),
      ev("a", "a0", 1, null),
    ]);
    expect(r.byId.get("a")).toEqual({ startDay: 0, endDay: null });
    expect(r.byId.get("b")).toEqual({ startDay: 1, endDay: null });
    expect(r.dataEnd).toBe(1);
  });
});

describe("clampPxPerDay", () => {
  it("clamps to lower and upper bounds", () => {
    expect(clampPxPerDay(0.001)).toBe(0.06);
    expect(clampPxPerDay(999999999)).toBe(130000);
    expect(clampPxPerDay(100)).toBe(100);
  });
});

describe("fitAll", () => {
  it("centers data with viewStartDay before dataStart", () => {
    const dataStart = 0;
    const dataEnd = 100;
    const trackW = 800;
    const view = fitAll({ dataStart, dataEnd, trackW });
    expect(view.viewStartDay).toBeLessThan(dataStart);
    // dataEnd should be visible within track width
    const xEnd = dayToX(view, dataEnd);
    expect(xEnd).toBeLessThanOrEqual(trackW);
    expect(xEnd).toBeGreaterThan(trackW * 0.8);
    // dataStart roughly near left edge
    const xStart = dayToX(view, dataStart);
    expect(xStart).toBeGreaterThan(0);
    expect(xStart).toBeLessThan(trackW * 0.1);
  });

  it("uses minimum span of 30 for tiny data ranges", () => {
    const view = fitAll({ dataStart: 5, dataEnd: 5, trackW: 600 });
    // span=30 -> viewStartDay = 5 - 30*0.03 = 4.1
    expect(view.viewStartDay).toBeCloseTo(4.1, 6);
  });

  it("guards trackW <= 0", () => {
    const view = fitAll({ dataStart: 0, dataEnd: 10, trackW: 0 });
    expect(view.pxPerDay).toBeGreaterThan(0);
    expect(Number.isFinite(view.viewStartDay)).toBe(true);
  });
});

describe("zoomAt", () => {
  it("keeps the day under pivotPx invariant", () => {
    const view: View = { pxPerDay: 4, viewStartDay: 10 };
    const pivotPx = 250;
    const before = xToDay(view, pivotPx);
    const zoomed = zoomAt({ view, pivotPx, factor: 2.5 });
    const after = xToDay(zoomed, pivotPx);
    expect(after).toBeCloseTo(before, 6);
    expect(zoomed.pxPerDay).toBeCloseTo(10, 6);
  });

  it("zoom out preserves pivot day too", () => {
    const view: View = { pxPerDay: 50, viewStartDay: -3 };
    const pivotPx = 120;
    const before = xToDay(view, pivotPx);
    const zoomed = zoomAt({ view, pivotPx, factor: 0.3 });
    const after = xToDay(zoomed, pivotPx);
    expect(after).toBeCloseTo(before, 6);
  });

  it("respects clamp at extreme zoom factors", () => {
    const view: View = { pxPerDay: 100, viewStartDay: 0 };
    const zoomed = zoomAt({ view, pivotPx: 0, factor: 1e9 });
    expect(zoomed.pxPerDay).toBe(130000);
  });
});

describe("zoomByCenter", () => {
  it("keeps the center day invariant", () => {
    const view: View = { pxPerDay: 8, viewStartDay: 2 };
    const trackW = 640;
    const centerBefore = xToDay(view, trackW / 2);
    const zoomed = zoomByCenter({ view, trackW, factor: 1.7 });
    const centerAfter = xToDay(zoomed, trackW / 2);
    expect(centerAfter).toBeCloseTo(centerBefore, 6);
  });
});

describe("panByPx", () => {
  it("shifts viewStartDay by -dx/ppd and preserves pxPerDay", () => {
    const view: View = { pxPerDay: 4, viewStartDay: 10 };
    const panned = panByPx({ view, dx: 80 });
    expect(panned.pxPerDay).toBe(4);
    expect(panned.viewStartDay).toBeCloseTo(10 - 80 / 4, 6);
  });

  it("negative dx moves the other way", () => {
    const view: View = { pxPerDay: 5, viewStartDay: 0 };
    const panned = panByPx({ view, dx: -25 });
    expect(panned.viewStartDay).toBeCloseTo(5, 6);
  });
});

describe("dayToX / xToDay", () => {
  it("round-trips across a range of inputs", () => {
    const view: View = { pxPerDay: 3.5, viewStartDay: -12.25 };
    for (const day of [-50, -12.25, 0, 7, 123.75, 1000]) {
      expect(xToDay(view, dayToX(view, day))).toBeCloseTo(day, 6);
    }
  });

  it("xToDay guards pxPerDay 0", () => {
    const view: View = { pxPerDay: 0, viewStartDay: 42 };
    expect(xToDay(view, 500)).toBe(42);
  });
});

describe("scrollGeom", () => {
  it("thumbLeft stays within [0, trackW - thumbW] and thumbFrac >= 0.04", () => {
    const trackW = 1000;
    for (const viewStartDay of [-200, -60, 0, 50, 250, 400]) {
      const view: View = { pxPerDay: 20, viewStartDay };
      const g = scrollGeom({ view, trackW, dataStart: 0, dataEnd: 300 });
      expect(g.thumbW / trackW).toBeGreaterThanOrEqual(0.04 - 1e-9);
      expect(g.thumbLeft).toBeGreaterThanOrEqual(-1e-9);
      expect(g.thumbLeft).toBeLessThanOrEqual(trackW - g.thumbW + 1e-9);
    }
  });

  it("enforces minimum thumb fraction when zoomed in very far", () => {
    const view: View = { pxPerDay: 130000, viewStartDay: 0 };
    const g = scrollGeom({ view, trackW: 800, dataStart: 0, dataEnd: 10000 });
    expect(g.thumbW / 800).toBeCloseTo(0.04, 6);
  });

  it("uses padDays default of 60 for fullStart", () => {
    const view: View = { pxPerDay: 10, viewStartDay: 0 };
    const g = scrollGeom({ view, trackW: 500, dataStart: 100, dataEnd: 200 });
    expect(g.fullStart).toBe(40); // 100 - 60
  });

  it("honors custom padDays", () => {
    const view: View = { pxPerDay: 10, viewStartDay: 0 };
    const g = scrollGeom({
      view,
      trackW: 500,
      dataStart: 100,
      dataEnd: 200,
      padDays: 10,
    });
    expect(g.fullStart).toBe(90);
  });
});

describe("viewStartFromThumb", () => {
  it("is monotonic in thumb position", () => {
    const view: View = { pxPerDay: 25, viewStartDay: 0 };
    const g = scrollGeom({ view, trackW: 900, dataStart: 0, dataEnd: 500 });
    const room = g.trackW - g.thumbW;
    const a = viewStartFromThumb(g, 0);
    const b = viewStartFromThumb(g, room / 2);
    const c = viewStartFromThumb(g, room);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    // left edge maps to fullStart
    expect(a).toBeCloseTo(g.fullStart, 6);
    // right edge maps to fullStart + denom
    expect(c).toBeCloseTo(g.fullStart + g.denom, 6);
  });

  it("clamps out-of-range thumb positions", () => {
    const view: View = { pxPerDay: 25, viewStartDay: 0 };
    const g = scrollGeom({ view, trackW: 900, dataStart: 0, dataEnd: 500 });
    const room = g.trackW - g.thumbW;
    expect(viewStartFromThumb(g, -100)).toBeCloseTo(g.fullStart, 6);
    expect(viewStartFromThumb(g, room + 100)).toBeCloseTo(
      g.fullStart + g.denom,
      6,
    );
  });
});
