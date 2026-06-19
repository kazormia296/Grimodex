import { describe, it, expect } from "vitest";
import { computeFinishLineProgress } from "./finishLine";

// ローカルタイムゾーン非依存にするため now は local Date から作る。
// localDayKey も daysBetween もローカル基準なので、どの TZ でも同じ日キーになる。
const NOW = new Date(2026, 5, 18, 10, 0, 0).getTime(); // 2026-06-18 (local)
const dayKey = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

describe("computeFinishLineProgress", () => {
  it("目標未設定（target<=0）は hasTarget=false", () => {
    const r = computeFinishLineProgress({
      target: 0,
      current: 1000,
      pace: 500,
      deadlineKey: null,
      now: NOW,
    });
    expect(r.hasTarget).toBe(false);
    expect(r.daysToFinish).toBeNull();
    expect(r.projectedFinishKey).toBeNull();
    expect(r.requiredPace).toBeNull();
  });

  it("目標未設定でも締切があれば残り日数だけは返す", () => {
    const r = computeFinishLineProgress({
      target: 0,
      current: 0,
      pace: 0,
      deadlineKey: dayKey(2026, 6, 28), // +10 日
      now: NOW,
    });
    expect(r.hasTarget).toBe(false);
    expect(r.hasDeadline).toBe(true);
    expect(r.daysUntilDeadline).toBe(10);
    expect(r.requiredPace).toBeNull();
  });

  it("締切なし：現ペースで完走予定日を出す", () => {
    const r = computeFinishLineProgress({
      target: 100_000,
      current: 62_300,
      pace: 1850,
      deadlineKey: null,
      now: NOW,
    });
    expect(r.hasTarget).toBe(true);
    expect(r.remaining).toBe(37_700);
    expect(r.pct).toBe(62);
    expect(r.reached).toBe(false);
    // ceil(37700 / 1850) = ceil(20.38) = 21
    expect(r.daysToFinish).toBe(21);
    expect(r.projectedFinishKey).toBe(dayKey(2026, 7, 9)); // 6/18 + 21 = 7/9
    expect(r.hasDeadline).toBe(false);
    expect(r.requiredPace).toBeNull();
    expect(r.onTrack).toBeNull();
    expect(r.deltaDays).toBeNull();
  });

  it("達成済み：reached=true・pct=100・予測は伏せる", () => {
    const r = computeFinishLineProgress({
      target: 50_000,
      current: 52_000,
      pace: 1000,
      deadlineKey: dayKey(2026, 6, 20),
      now: NOW,
    });
    expect(r.reached).toBe(true);
    expect(r.remaining).toBe(0);
    expect(r.pct).toBe(100);
    expect(r.daysToFinish).toBe(0);
    expect(r.projectedFinishKey).toBeNull();
    expect(r.requiredPace).toBeNull();
    expect(r.onTrack).toBeNull();
  });

  it("ペース0・残りあり：完走予定なし", () => {
    const r = computeFinishLineProgress({
      target: 100_000,
      current: 10_000,
      pace: 0,
      deadlineKey: null,
      now: NOW,
    });
    expect(r.daysToFinish).toBeNull();
    expect(r.projectedFinishKey).toBeNull();
  });

  it("締切あり・間に合う：onTrack=true・deltaDays<=0", () => {
    const r = computeFinishLineProgress({
      target: 100_000,
      current: 90_000,
      pace: 2000,
      deadlineKey: dayKey(2026, 6, 30), // +12 日
      now: NOW,
    });
    // remaining 10000, daysToFinish = ceil(10000/2000)=5
    expect(r.daysToFinish).toBe(5);
    expect(r.daysUntilDeadline).toBe(12);
    // requiredPace = ceil(10000/12) = 834
    expect(r.requiredPace).toBe(834);
    expect(r.deltaDays).toBe(5 - 12);
    expect(r.onTrack).toBe(true);
  });

  it("締切あり・遅れる：onTrack=false・deltaDays>0", () => {
    const r = computeFinishLineProgress({
      target: 100_000,
      current: 62_300,
      pace: 1850,
      deadlineKey: dayKey(2026, 6, 30), // +12 日
      now: NOW,
    });
    // daysToFinish 21, daysUntilDeadline 12 → 9 日遅れ
    expect(r.daysToFinish).toBe(21);
    expect(r.daysUntilDeadline).toBe(12);
    expect(r.requiredPace).toBe(Math.ceil(37_700 / 12)); // 3142
    expect(r.deltaDays).toBe(9);
    expect(r.onTrack).toBe(false);
  });

  it("締切が今日/過去：必要ペースは残り全部・間に合わない", () => {
    const r = computeFinishLineProgress({
      target: 100_000,
      current: 80_000,
      pace: 5000,
      deadlineKey: dayKey(2026, 6, 18), // 今日
      now: NOW,
    });
    expect(r.daysUntilDeadline).toBe(0);
    expect(r.requiredPace).toBe(20_000); // 残り全部を即日
    expect(r.onTrack).toBe(false);
  });

  it("ペース0＋締切あり：必要ペースは出すが onTrack=false・deltaDays=null", () => {
    const r = computeFinishLineProgress({
      target: 100_000,
      current: 50_000,
      pace: 0,
      deadlineKey: dayKey(2026, 6, 28), // +10 日
      now: NOW,
    });
    expect(r.requiredPace).toBe(5000); // ceil(50000/10)
    expect(r.daysToFinish).toBeNull();
    expect(r.deltaDays).toBeNull();
    expect(r.onTrack).toBe(false);
  });

  it("負の current/pace は 0 にクランプ", () => {
    const r = computeFinishLineProgress({
      target: 1000,
      current: -50,
      pace: -10,
      deadlineKey: null,
      now: NOW,
    });
    expect(r.current).toBe(0);
    expect(r.pace).toBe(0);
    expect(r.remaining).toBe(1000);
    expect(r.pct).toBe(0);
  });

  it("pct は 100 にクランプ（current>target でも 100 まで）", () => {
    const r = computeFinishLineProgress({
      target: 1000,
      current: 5000,
      pace: 100,
      deadlineKey: null,
      now: NOW,
    });
    expect(r.pct).toBe(100);
    expect(r.reached).toBe(true);
    expect(r.remaining).toBe(0);
  });
});
