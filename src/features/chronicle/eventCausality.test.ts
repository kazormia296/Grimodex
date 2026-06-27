import { describe, it, expect } from "vitest";
import { findCausalityConflicts, causalIssueEventIds } from "./eventCausality";

describe("findCausalityConflicts", () => {
  it("効果が原因より前(effectTime < causeTime)を矛盾として検出", () => {
    const conflicts = findCausalityConflicts({
      events: [
        { id: "cause", startTime: 100 },
        { id: "effect", startTime: 50 }, // 原因より前 → 矛盾
      ],
      relations: [{ causeId: "cause", effectId: "effect" }],
    });
    expect(conflicts).toEqual([
      { causeId: "cause", effectId: "effect", causeTime: 100, effectTime: 50 },
    ]);
  });

  it("効果が原因より後なら矛盾なし", () => {
    const conflicts = findCausalityConflicts({
      events: [
        { id: "c", startTime: 50 },
        { id: "e", startTime: 100 },
      ],
      relations: [{ causeId: "c", effectId: "e" }],
    });
    expect(conflicts).toHaveLength(0);
  });

  it("同時刻は矛盾としない（< のみ）", () => {
    const conflicts = findCausalityConflicts({
      events: [
        { id: "c", startTime: 50 },
        { id: "e", startTime: 50 },
      ],
      relations: [{ causeId: "c", effectId: "e" }],
    });
    expect(conflicts).toHaveLength(0);
  });

  it("どちらかの startTime が無ければスキップ", () => {
    const conflicts = findCausalityConflicts({
      events: [
        { id: "c", startTime: null },
        { id: "e", startTime: 10 },
      ],
      relations: [{ causeId: "c", effectId: "e" }],
    });
    expect(conflicts).toHaveLength(0);
  });

  it("決定的順序(causeId,effectId 昇順)", () => {
    const conflicts = findCausalityConflicts({
      events: [
        { id: "a", startTime: 100 },
        { id: "b", startTime: 10 },
        { id: "c", startTime: 100 },
        { id: "d", startTime: 10 },
      ],
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
        { id: "c", startTime: 0 },
        { id: "e", startTime: -1 }, // 原因(0)より前 → 矛盾
      ],
      relations: [{ causeId: "c", effectId: "e" }],
    });
    expect(conflicts).toEqual([
      { causeId: "c", effectId: "e", causeTime: 0, effectTime: -1 },
    ]);
  });

  it("原因0/結果0 は同時刻なので矛盾なし（< のみ・0 境界）", () => {
    const conflicts = findCausalityConflicts({
      events: [
        { id: "c", startTime: 0 },
        { id: "e", startTime: 0 },
      ],
      relations: [{ causeId: "c", effectId: "e" }],
    });
    expect(conflicts).toHaveLength(0);
  });

  it("causalIssueEventIds は cause/effect 双方を含む", () => {
    const ids = causalIssueEventIds([
      { causeId: "x", effectId: "y", causeTime: 5, effectTime: 1 },
    ]);
    expect(ids.has("x")).toBe(true);
    expect(ids.has("y")).toBe(true);
  });
});
