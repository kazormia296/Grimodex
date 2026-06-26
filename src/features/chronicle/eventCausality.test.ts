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

  it("causalIssueEventIds は cause/effect 双方を含む", () => {
    const ids = causalIssueEventIds([
      { causeId: "x", effectId: "y", causeTime: 5, effectTime: 1 },
    ]);
    expect(ids.has("x")).toBe(true);
    expect(ids.has("y")).toBe(true);
  });
});
