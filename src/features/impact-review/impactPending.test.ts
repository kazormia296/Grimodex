import { describe, it, expect } from "vitest";
import type { CodexSnapshot } from "./diff";
import { canIncludeResolvedCodexContext } from "@/features/codex/context/codexVisibilityPolicy";
import { deriveImpactPending } from "./impactPending";
import { effectiveRestrictedPhaseIds } from "./impactGate";

const base: CodexSnapshot = {
  name: "アリス",
  aliases: ["アリー", "ありす"],
  summary: "15歳の少女。",
  contentPlain: "町に住む。",
  details: [{ name: "年齢", value: "15" }],
  phases: [],
  visibilityProvenanceVersion: 1,
  allPhaseIds: [],
  restrictedPhaseIds: [],
};

// CodexSnapshotResult は contextMode・hasRestrictedPhases が必須（#1048）。既定は公開・制限なし。
function built(
  snapshot: CodexSnapshot,
  extra: { contextMode?: string; hasRestrictedPhases?: boolean } = {},
) {
  return {
    snapshot,
    contextMode: "mentioned",
    hasRestrictedPhases: false,
    ...extra,
  };
}

describe("deriveImpactPending: baseline の有無", () => {
  it("baseline が無い項目は unchecked（初回に全項目が変更ありになるのを避ける）", () => {
    expect(deriveImpactPending({ baseline: null, built: built(base) })).toEqual(
      { state: "unchecked" },
    );
  });

  it("制限の印だけの baseline（値がすべて空の tombstone）も unchecked", () => {
    const tombstone: CodexSnapshot = {
      name: "",
      aliases: [],
      summary: "",
      contentPlain: "",
      details: [],
      phases: [],
      visibilityProvenanceVersion: 1,
      allPhaseIds: ["p1"],
      restrictedPhaseIds: ["p1"],
    };
    expect(
      deriveImpactPending({ baseline: tombstone, built: built(base) }),
    ).toEqual({ state: "unchecked" });
  });
});

describe("deriveImpactPending: 差分の件数", () => {
  it("差分なしは none", () => {
    expect(
      deriveImpactPending({ baseline: { ...base }, built: built(base) }),
    ).toEqual({ state: "none" });
  });

  it("空白だけ・全半角だけ・別名の並びだけの違いは none（cmp が無視する）", () => {
    const current: CodexSnapshot = {
      ...base,
      name: "ア リ ス",
      summary: "１５歳の少女。",
      aliases: ["ありす", "アリー"],
    };
    expect(
      deriveImpactPending({ baseline: base, built: built(current) }),
    ).toEqual({ state: "none" });
  });

  it("detail の値の変更は 1 件、name＋summary＋content で 3 件", () => {
    expect(
      deriveImpactPending({
        baseline: base,
        built: built({ ...base, details: [{ name: "年齢", value: "17" }] }),
      }),
    ).toEqual({ state: "pending", changeCount: 1 });
    expect(
      deriveImpactPending({
        baseline: base,
        built: built({
          ...base,
          name: "アリシア",
          summary: "17歳。",
          contentPlain: "都に住む。",
        }),
      }),
    ).toEqual({ state: "pending", changeCount: 3 });
  });

  it("aliases の変更も数える", () => {
    expect(
      deriveImpactPending({
        baseline: base,
        built: built({ ...base, aliases: ["アリー"] }),
      }),
    ).toEqual({ state: "pending", changeCount: 1 });
  });

  it("公開 Phase の override の変更を数える", () => {
    const phase = {
      phaseId: "p1",
      label: "第2部",
      summary: "成長した。",
      contentPlain: null,
      details: [],
    };
    const baseline: CodexSnapshot = {
      ...base,
      phases: [phase],
      allPhaseIds: ["p1"],
    };
    const current: CodexSnapshot = {
      ...baseline,
      phases: [{ ...phase, summary: "さらに成長した。" }],
    };
    expect(deriveImpactPending({ baseline, built: built(current) })).toEqual({
      state: "pending",
      changeCount: 1,
    });
  });
});

describe("deriveImpactPending: 門（run が no-candidates で止める条件）", () => {
  const changed: CodexSnapshot = {
    ...base,
    details: [{ name: "年齢", value: "17" }],
  };

  it.each(["hidden", "suppress", "unknown-mode", ""])(
    "base の contextMode が %j は gated（押しても止まる）",
    (contextMode) => {
      expect(
        deriveImpactPending({
          baseline: base,
          built: built(changed, { contextMode }),
        }),
      ).toEqual({ state: "gated", reason: "context-mode" });
    },
  );

  it.each(["mentioned", "always", "manual", "never"])(
    "contextMode %j は正本の門（canIncludeResolvedCodexContext）と同じ結果",
    (contextMode) => {
      const r = deriveImpactPending({
        baseline: base,
        built: built(changed, { contextMode }),
      });
      expect(r.state).toBe(
        canIncludeResolvedCodexContext(contextMode, "current-mention")
          ? "pending"
          : "gated",
      );
    },
  );

  it("contextMode が欠落（型を越えた runtime の値）は公開として補わず gated（run と同じ fail-closed。DR-MP4-44）", () => {
    const missing = built(changed) as Partial<ReturnType<typeof built>>;
    delete missing.contextMode;
    expect(
      deriveImpactPending({
        baseline: base,
        built: missing as ReturnType<typeof built>,
      }),
    ).toEqual({ state: "gated", reason: "context-mode" });
  });

  it("hasRestrictedPhases は gated", () => {
    expect(
      deriveImpactPending({
        baseline: base,
        built: built(changed, { hasRestrictedPhases: true }),
      }),
    ).toEqual({ state: "gated", reason: "restricted-phase" });
  });

  it("snapshot.restrictedPhaseIds が空でなければ（flag が無くても）gated", () => {
    expect(
      deriveImpactPending({
        baseline: base,
        built: built({ ...changed, restrictedPhaseIds: ["p9"] }),
      }),
    ).toEqual({ state: "gated", reason: "restricted-phase" });
  });
});

describe("知らせと run が共有する Phase の除外集合", () => {
  it("現在の restrictedPhaseIds を必ず含める", () => {
    expect(
      effectiveRestrictedPhaseIds(base, {
        ...base,
        restrictedPhaseIds: ["p1"],
      }),
    ).toEqual(new Set(["p1"]));
  });

  it("現在無い baseline の restrictedPhaseIds も tombstone として残す", () => {
    const baseline = {
      ...base,
      allPhaseIds: ["p1"],
      restrictedPhaseIds: ["p1"],
    };
    const current = {
      ...base,
      details: [{ name: "年齢", value: "17" }],
      allPhaseIds: [],
      phases: [],
    };
    expect(deriveImpactPending({ baseline, built: built(current) })).toEqual({
      state: "pending",
      changeCount: 1,
    });
    expect(effectiveRestrictedPhaseIds(baseline, current)).toEqual(
      new Set(["p1"]),
    );
  });
});

describe("deriveImpactPending: Phase の削除・制限の解除（run の redact と同じ規則）", () => {
  const phase = {
    phaseId: "p1",
    label: "第2部",
    summary: "成長した。",
    contentPlain: null,
    details: [],
  };
  const withPhase: CodexSnapshot = {
    ...base,
    phases: [phase],
    allPhaseIds: ["p1"],
  };
  const noPhase: CodexSnapshot = { ...base, phases: [], allPhaseIds: [] };
  const aged = (s: CodexSnapshot): CodexSnapshot => ({
    ...s,
    details: [{ name: "年齢", value: "17" }],
  });

  it("証明の無い Phase の削除（visibleDeletedPhaseIds に無い）は、その Phase を除いた件数を数える（run と同じ）", () => {
    expect(
      deriveImpactPending({
        baseline: withPhase,
        built: built(aged(noPhase)),
      }),
    ).toEqual({ state: "pending", changeCount: 1 });
  });

  it("証明の無い Phase の削除だけなら、その Phase を除くと差分なしで none（非公開 Phase の内容は数えない）", () => {
    expect(
      deriveImpactPending({ baseline: withPhase, built: built(noPhase) }),
    ).toEqual({ state: "none" });
  });

  it("公開中の削除と証明済み（visibleDeletedPhaseIds にある）なら数える（Phase 分も含む）", () => {
    const baseline: CodexSnapshot = {
      ...withPhase,
      visibleDeletedPhaseIds: ["p1"],
    };
    expect(
      deriveImpactPending({ baseline, built: built(aged(noPhase)) }),
    ).toEqual({ state: "pending", changeCount: 2 });
  });

  it("legacy の baseline（allPhaseIds・来歴無し）の Phase 削除も、その Phase を除いた件数を数える", () => {
    const legacy: CodexSnapshot = {
      ...base,
      phases: [phase],
    };
    delete (legacy as Partial<CodexSnapshot>).allPhaseIds;
    delete (legacy as Partial<CodexSnapshot>).visibilityProvenanceVersion;
    expect(
      deriveImpactPending({
        baseline: legacy,
        built: built({ ...aged(base), phases: [] }),
      }),
    ).toEqual({ state: "pending", changeCount: 1 });
  });

  it("baseline の restrictedPhaseIds の Phase が現在も存在・公開なら制限は解除され、数える", () => {
    const baseline: CodexSnapshot = {
      ...withPhase,
      restrictedPhaseIds: ["p1"],
    };
    expect(
      deriveImpactPending({ baseline, built: built(aged(withPhase)) }),
    ).toEqual({ state: "pending", changeCount: 1 });
  });

  it("baseline の restrictedPhaseIds の Phase が現在無ければ、その Phase を除いて数える", () => {
    const baseline: CodexSnapshot = {
      ...base,
      phases: [],
      allPhaseIds: ["p1"],
      restrictedPhaseIds: ["p1"],
    };
    expect(
      deriveImpactPending({ baseline, built: built(aged(noPhase)) }),
    ).toEqual({ state: "pending", changeCount: 1 });
  });

  it("undo で baseline と同じ状態に戻れば none", () => {
    expect(
      deriveImpactPending({ baseline: withPhase, built: built(withPhase) }),
    ).toEqual({ state: "none" });
  });
});
