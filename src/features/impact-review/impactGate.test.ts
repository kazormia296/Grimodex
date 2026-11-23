import { describe, expect, it } from "vitest";
import type { CodexSnapshot } from "./diff";
import {
  currentHasRestrictedPhases,
  effectiveRestrictedPhaseIds,
  evaluateImpactGate,
  phaseIds,
  redactRestrictedPhases,
} from "./impactGate";

const base: CodexSnapshot = {
  name: "アリス",
  aliases: [],
  summary: "",
  contentPlain: "",
  details: [],
};

const phase = (phaseId: string) => ({
  phaseId,
  label: phaseId,
  summary: `${phaseId} の本文`,
  contentPlain: null,
  details: [],
});

describe("共有する影響確認の純関数", () => {
  it("Phase ID は allPhaseIds を優先し、無ければ phases の ID を使う", () => {
    expect(
      phaseIds({ ...base, allPhaseIds: ["p2"], phases: [phase("p1")] }),
    ).toEqual(new Set(["p2"]));
    expect(phaseIds({ ...base, phases: [phase("p1")] })).toEqual(
      new Set(["p1"]),
    );
    expect(phaseIds(base)).toEqual(new Set());
  });

  it("現在の制限、baseline の tombstone、証明の無い削除だけを除外集合にする", () => {
    const current: CodexSnapshot = {
      ...base,
      allPhaseIds: ["p-live", "p-current"],
      restrictedPhaseIds: ["p-current"],
    };
    const baseline: CodexSnapshot = {
      ...base,
      allPhaseIds: ["p-live", "p-restricted", "p-unproven", "p-proven"],
      phases: [phase("p-unproven"), phase("p-proven"), phase("p-restricted")],
      restrictedPhaseIds: ["p-restricted", "p-restricted-tombstone", "p-live"],
      visibleDeletedPhaseIds: ["p-proven"],
    };

    expect(effectiveRestrictedPhaseIds(baseline, current)).toEqual(
      new Set([
        "p-current",
        "p-restricted",
        "p-restricted-tombstone",
        "p-unproven",
      ]),
    );
  });

  it("baseline が null なら現在の制限 ID だけを返す", () => {
    expect(
      effectiveRestrictedPhaseIds(null, {
        ...base,
        restrictedPhaseIds: ["p-current"],
      }),
    ).toEqual(new Set(["p-current"]));
  });

  it("tombstone と来歴の無い legacy baseline の削除を fail-closed にする", () => {
    const tombstone: CodexSnapshot = {
      ...base,
      allPhaseIds: ["p-tombstone"],
      restrictedPhaseIds: ["p-tombstone"],
    };
    expect(effectiveRestrictedPhaseIds(tombstone, base)).toEqual(
      new Set(["p-tombstone"]),
    );

    const legacy: CodexSnapshot = { ...base, phases: [phase("p-legacy")] };
    expect(effectiveRestrictedPhaseIds(legacy, base)).toEqual(
      new Set(["p-legacy"]),
    );
  });

  it("redact は制限 Phase だけを除き、null と除外なしはそのまま返す", () => {
    const snapshot: CodexSnapshot = {
      ...base,
      phases: [phase("p1"), phase("p2")],
    };
    expect(redactRestrictedPhases(null, new Set(["p1"]))).toBeNull();
    expect(redactRestrictedPhases(snapshot, new Set())).toBe(snapshot);
    expect(redactRestrictedPhases(snapshot, new Set(["p1"]))).toEqual({
      ...snapshot,
      phases: [phase("p2")],
    });
  });

  it.each([
    ["欠落", undefined, "context-mode"],
    ["空文字", "", "context-mode"],
    ["不明", "unknown", "context-mode"],
    ["hidden", "hidden", "context-mode"],
    ["suppress", "suppress", "context-mode"],
    ["mentioned", "mentioned", null],
    ["always", "always", null],
  ] as const)("contextMode=%s の門", (_label, contextMode, reason) => {
    expect(
      evaluateImpactGate({
        contextMode,
        currentHasRestrictedPhases: currentHasRestrictedPhases(
          { restrictedPhaseIds: [] },
          false,
        ),
      }),
    ).toEqual({ currentHasRestrictedPhases: false, reason });
  });

  it("hasRestrictedPhases の欠落・true・false と restriction ID を判定する", () => {
    expect(currentHasRestrictedPhases({ restrictedPhaseIds: [] })).toBe(false);
    expect(currentHasRestrictedPhases({ restrictedPhaseIds: [] }, true)).toBe(
      true,
    );
    expect(
      currentHasRestrictedPhases({ restrictedPhaseIds: ["p1"] }, false),
    ).toBe(true);
    expect(currentHasRestrictedPhases({ restrictedPhaseIds: [] }, false)).toBe(
      false,
    );

    expect(
      evaluateImpactGate({
        contextMode: "mentioned",
        currentHasRestrictedPhases: currentHasRestrictedPhases({
          restrictedPhaseIds: [],
        }),
      }),
    ).toEqual({ currentHasRestrictedPhases: false, reason: null });
    expect(
      evaluateImpactGate({
        contextMode: "mentioned",
        currentHasRestrictedPhases: currentHasRestrictedPhases(
          { restrictedPhaseIds: [] },
          true,
        ),
      }),
    ).toEqual({ currentHasRestrictedPhases: true, reason: "restricted-phase" });
    expect(
      evaluateImpactGate({
        contextMode: "mentioned",
        currentHasRestrictedPhases: currentHasRestrictedPhases(
          { restrictedPhaseIds: ["p1"] },
          false,
        ),
      }),
    ).toEqual({ currentHasRestrictedPhases: true, reason: "restricted-phase" });
    expect(
      evaluateImpactGate({
        contextMode: "mentioned",
        currentHasRestrictedPhases: currentHasRestrictedPhases(
          { restrictedPhaseIds: [] },
          false,
        ),
      }),
    ).toEqual({ currentHasRestrictedPhases: false, reason: null });
  });

  it("restriction があると contextMode より先に停止理由を返す", () => {
    expect(
      evaluateImpactGate({
        contextMode: "hidden",
        currentHasRestrictedPhases: currentHasRestrictedPhases(
          { restrictedPhaseIds: ["p1"] },
          true,
        ),
      }),
    ).toEqual({ currentHasRestrictedPhases: true, reason: "restricted-phase" });
  });
});
