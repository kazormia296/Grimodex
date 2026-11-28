import { describe, it, expect } from "vitest";
import { findCausalityConflicts, causalIssueEventIds } from "./eventCausality";

type CheckEvent = Parameters<
  typeof findCausalityConflicts
>[0]["events"][number];

function ev(
  id: string,
  startTime: number | null,
  precision: CheckEvent["precision"] = "exact",
  startGranularity: CheckEvent["startGranularity"] = "day",
): CheckEvent {
  return { id, startTime, precision, startGranularity };
}

describe("findCausalityConflicts", () => {
  it("効果が原因より前(effectTime < causeTime)を矛盾として検出", () => {
    const conflicts = findCausalityConflicts({
      events: [
        ev("cause", 100),
        ev("effect", 50), // 原因より前 → 矛盾
      ],
      relations: [{ causeId: "cause", effectId: "effect" }],
    });
    expect(conflicts).toEqual([
      { causeId: "cause", effectId: "effect", causeTime: 100, effectTime: 50 },
    ]);
  });

  it("効果が原因より後なら矛盾なし", () => {
    const conflicts = findCausalityConflicts({
      events: [ev("c", 50), ev("e", 100)],
      relations: [{ causeId: "c", effectId: "e" }],
    });
    expect(conflicts).toHaveLength(0);
  });

  it("同時刻は矛盾としない（< のみ）", () => {
    const conflicts = findCausalityConflicts({
      events: [ev("c", 50), ev("e", 50)],
      relations: [{ causeId: "c", effectId: "e" }],
    });
    expect(conflicts).toHaveLength(0);
  });

  it("どちらかの startTime が無ければスキップ", () => {
    const conflicts = findCausalityConflicts({
      events: [ev("c", null), ev("e", 10)],
      relations: [{ causeId: "c", effectId: "e" }],
    });
    expect(conflicts).toHaveLength(0);
  });

  it("決定的順序(causeId,effectId 昇順)", () => {
    const conflicts = findCausalityConflicts({
      events: [ev("a", 100), ev("b", 10), ev("c", 100), ev("d", 10)],
      relations: [
        { causeId: "c", effectId: "d" },
        { causeId: "a", effectId: "b" },
      ],
    });
    expect(conflicts.map((x) => x.causeId)).toEqual(["a", "c"]);
  });

  it("startTime 0 は有効な値: 原因0/結果-1 は矛盾（falsy チェックへの退行を防ぐ）", () => {
    // day 0 は正当な時刻。`if (startTime)` のような falsy 判定だと 0 が欠損扱いになり
    // この矛盾を取りこぼす → != null 判定であることをロックする。
    const conflicts = findCausalityConflicts({
      events: [
        ev("c", 0),
        ev("e", -1), // 原因(0)より前 → 矛盾
      ],
      relations: [{ causeId: "c", effectId: "e" }],
    });
    expect(conflicts).toEqual([
      { causeId: "c", effectId: "e", causeTime: 0, effectTime: -1 },
    ]);
  });

  it("原因0/結果0 は同時刻なので矛盾なし（< のみ・0 境界）", () => {
    const conflicts = findCausalityConflicts({
      events: [ev("c", 0), ev("e", 0)],
      relations: [{ causeId: "c", effectId: "e" }],
    });
    expect(conflicts).toHaveLength(0);
  });

  it("unknown と日時なしを除外し、approx と exact は検査する", () => {
    const conflicts = findCausalityConflicts({
      events: [
        ev("exact-cause", 100),
        ev("approx-cause", 100, "approx"),
        ev("unknown-cause", 100, "unknown"),
        ev("undated-cause", 100, "exact", "none"),
        ev("effect", 50),
      ],
      relations: [
        { causeId: "exact-cause", effectId: "effect" },
        { causeId: "approx-cause", effectId: "effect" },
        { causeId: "unknown-cause", effectId: "effect" },
        { causeId: "undated-cause", effectId: "effect" },
      ],
    });

    expect(conflicts.map((conflict) => conflict.causeId)).toEqual([
      "approx-cause",
      "exact-cause",
    ]);
  });

  it("causalIssueEventIds は cause/effect 双方を含む", () => {
    const ids = causalIssueEventIds([
      { causeId: "x", effectId: "y", causeTime: 5, effectTime: 1 },
    ]);
    expect(ids.has("x")).toBe(true);
    expect(ids.has("y")).toBe(true);
  });
});
