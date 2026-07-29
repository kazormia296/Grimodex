import { describe, it, expect } from "vitest";
import {
  moveEventToDayPatch,
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
    expect(p).toEqual({ startTime: 100, startMinute: 60 });
  });

  it("subDay=true: 日跨ぎの繰り上げ（23:00 + 2h → 翌日 01:00）", () => {
    const p = shiftEventPatch(ev({ startMinute: 1380 }), 120 / 1440, true);
    expect(p).toEqual({ startTime: 101, startMinute: 60 });
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
      endTime: 102,
      endMinute: 60,
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
      endTime: 202,
      endMinute: 1080,
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
