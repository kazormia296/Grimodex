import { describe, it, expect } from "vitest";
import {
  moveEventToDayPatch,
  resizeEventEndpointPatch,
  splitDayMinute,
  shiftEventPatch,
  type ShiftableEvent,
} from "./chronicleShift";

const ev = (o: Partial<ShiftableEvent> = {}): ShiftableEvent => ({
  startTime: 100,
  startMinute: null,
  endTime: null,
  endMinute: null,
  ...o,
});

describe("splitDayMinute", () => {
  it("subDay=false は日へ丸め、分は keepMinute 維持", () => {
    expect(splitDayMinute(130.42, false, 720)).toEqual({
      time: 130,
      minute: 720,
    });
  });
  it("subDay=true は floor 日＋分", () => {
    expect(splitDayMinute(100.5, true, null)).toEqual({
      time: 100,
      minute: 720,
    });
  });

  it("subDay=true は丸めで1440分を作らず翌日0分へcarryする", () => {
    expect(splitDayMinute(10 + 1439.6 / 1440, true, null)).toEqual({
      time: 11,
      minute: 0,
    });
  });

  it("subDay=true は負の日付でもminuteを0..1439へ正規化する", () => {
    expect(splitDayMinute(-0.25, true, null)).toEqual({
      time: -1,
      minute: 1080,
    });
  });
});

describe("shiftEventPatch", () => {
  it("subDay=false: グリッド端数差分は整数日へ丸めて移動・期間長保持・分不変", () => {
    const p = shiftEventPatch(ev({ endTime: 110 }), 30.42, false);
    expect(p).toEqual({ startTime: 130, endTime: 140 }); // round(30.42)=30
    expect("startMinute" in p).toBe(false); // 分は触らない
  });

  it("subDay=false: 分が違う2件も同量シフト（相対ズレを生まない）", () => {
    // 旧実装は各件で round(start + minute/1440 + delta) し分端数でズレた。
    const a = shiftEventPatch(ev({ startMinute: 0 }), 30.42, false);
    const b = shiftEventPatch(ev({ startMinute: 720 }), 30.42, false);
    expect(a.startTime).toBe(130);
    expect(b.startTime).toBe(130); // 720(=0.5日)でも +30 で一致
  });

  it("subDay=false: 差分が日丸めで 0 になっても startTime は出す（0.4→+0）", () => {
    const p = shiftEventPatch(ev(), 0.4, false);
    expect(p.startTime).toBe(100);
  });

  it("subDay=true: 端数を分へ反映（1/24日=60分）", () => {
    const p = shiftEventPatch(ev({ startMinute: 0 }), 1 / 24, true);
    expect(p).toEqual({
      startTime: 100,
      startMinute: 60,
      startGranularity: "time",
    });
  });

  it("subDay=true: 日跨ぎの繰り上げ（23:00 + 2h → 翌日 01:00）", () => {
    const p = shiftEventPatch(ev({ startMinute: 1380 }), 120 / 1440, true);
    expect(p).toEqual({
      startTime: 101,
      startMinute: 60,
      startGranularity: "time",
    });
  });

  it("subDay=true: 期間端も同量移動（期間長保持）", () => {
    const p = shiftEventPatch(
      ev({ startMinute: 0, endTime: 102, endMinute: 0 }),
      1 / 24,
      true,
    );
    expect(p).toEqual({
      startTime: 100,
      startMinute: 60,
      startGranularity: "time",
      endTime: 102,
      endMinute: 60,
      endGranularity: "time",
    });
  });

  it("点（endTime=null）は終了を触らない", () => {
    const p = shiftEventPatch(ev(), 5, false);
    expect(p).toEqual({ startTime: 105 });
  });
});

describe("moveEventToDayPatch", () => {
  it("hour/minute 移動は開始・終了の分を同量ずらして期間長を保持する", () => {
    expect(
      moveEventToDayPatch(
        ev({
          startMinute: 360,
          endTime: 102,
          endMinute: 720,
        }),
        200.5,
        true,
      ),
    ).toEqual({
      startTime: 200,
      startMinute: 720,
      startGranularity: "time",
      endTime: 202,
      endMinute: 1080,
      endGranularity: "time",
    });
  });

  it("日単位移動は開始・終了日を同量ずらして分を変更しない", () => {
    expect(
      moveEventToDayPatch(
        ev({
          startMinute: 360,
          endTime: 102,
          endMinute: 720,
        }),
        200,
        false,
      ),
    ).toEqual({
      startTime: 200,
      endTime: 202,
    });
  });
});

describe("resizeEventEndpointPatch", () => {
  const interval = ev({
    startTime: 10,
    startMinute: 18 * 60,
    endTime: 10,
    endMinute: 20 * 60,
  });

  it("同日内で終了を開始前へ動かすと開始日時へclampする", () => {
    expect(resizeEventEndpointPatch(interval, "end", 10.5, true)).toEqual({
      endTime: 10,
      endMinute: 18 * 60,
      endGranularity: "time",
    });
  });

  it("同日内で開始を終了後へ動かすと終了日時へclampする", () => {
    expect(resizeEventEndpointPatch(interval, "start", 10.875, true)).toEqual({
      startTime: 10,
      startMinute: 20 * 60,
      startGranularity: "time",
    });
  });

  it("日単位resizeでも保持minute込みで逆転を防ぐ", () => {
    expect(
      resizeEventEndpointPatch(
        ev({
          startTime: 9,
          startMinute: 21 * 60,
          endTime: 10,
          endMinute: 12 * 60,
        }),
        "start",
        10,
        false,
      ),
    ).toEqual({
      startTime: 10,
      startMinute: 12 * 60,
    });
  });

  it("coarse開始をtime終了へ日単位clampすると開始粒度もtimeへ昇格する", () => {
    expect(
      resizeEventEndpointPatch(
        ev({
          startTime: 10,
          startMinute: null,
          endTime: 11,
          endMinute: 10 * 60,
        }),
        "start",
        12,
        false,
      ),
    ).toEqual({
      startTime: 11,
      startMinute: 10 * 60,
      startGranularity: "time",
    });
  });

  it("coarse終了をtime開始へ日単位clampすると終了粒度もtimeへ昇格する", () => {
    expect(
      resizeEventEndpointPatch(
        ev({
          startTime: 10,
          startMinute: 10 * 60,
          endTime: 11,
          endMinute: null,
        }),
        "end",
        9,
        false,
      ),
    ).toEqual({
      endTime: 10,
      endMinute: 10 * 60,
      endGranularity: "time",
    });
  });

  it("sub-day開始をcoarse終了より後へ動かすと終了日の00:00へ完全なtimeとしてclampする", () => {
    expect(
      resizeEventEndpointPatch(
        ev({
          startTime: 10,
          startMinute: null,
          endTime: 11,
          endMinute: null,
        }),
        "start",
        11.75,
        true,
      ),
    ).toEqual({
      startTime: 11,
      startMinute: 0,
      startGranularity: "time",
    });
  });

  it("sub-day終了をcoarse開始より前へ動かすと開始日の00:00へ完全なtimeとしてclampする", () => {
    expect(
      resizeEventEndpointPatch(
        ev({
          startTime: 10,
          startMinute: null,
          endTime: 11,
          endMinute: null,
        }),
        "end",
        9.75,
        true,
      ),
    ).toEqual({
      endTime: 10,
      endMinute: 0,
      endGranularity: "time",
    });
  });
});
