/**
 * `deriveImpactPending`（知らせ）と実物の `runImpactReview`（押下）の parity。
 * 規則を 2 か所に持つ（run は変えない。DR-INN-1）ので、一致をここで固定する。
 *
 *  - pending(n) ⇒ run は no-change でなく、changeCount === n、候補絞りまで進む。
 *  - none      ⇒ run は no-change。
 *  - gated（現在の制限・contextMode）⇒ run は候補絞りを呼ばない（押しても止まる）。
 *  - gated（unresolved-phase-restriction）⇒ run の差分は素の差分と食い違い得る。
 *    知らせない（偽陽性を避ける。偽陰性は許容）。
 *  - unchecked は逆向きの主張をしない（run は初回を全フィールド「変更」と数える）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeCodexDiff, type CodexSnapshot } from "./diff";

vi.mock("./snapshot", () => ({ buildCodexSnapshot: vi.fn() }));
vi.mock("./baseline", () => ({ getBaseline: vi.fn(), saveBaseline: vi.fn() }));
vi.mock("./narrowing", () => ({ narrowCandidateScenes: vi.fn() }));
vi.mock("@/features/post-effect/api", () => ({ runPostEffectMulti: vi.fn() }));
vi.mock("@/features/post-effect/consistencyPayloadBuilder", () => ({
  IMPACT_REVIEW_PROMPT_VERSION: "impact_review_v1.1",
}));
vi.mock("@/prompts/index", () => ({
  getPromptCatalog: () => ({ postEffect: { impactReviewSystem: "SYS" } }),
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectLanguage: () => "ja",
}));
vi.mock("@/features/chat/store", () => ({
  useAiSettingsStore: { getState: () => ({ settings: { model: "m1" } }) },
}));
vi.mock("@/lib/prosemirror", () => ({ prosemirrorToText: () => "body" }));
vi.mock("@/db/client", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  },
}));

import { runImpactReview } from "./runImpactReview";
import { deriveImpactPending, type ImpactPending } from "./impactPending";
import { buildCodexSnapshot } from "./snapshot";
import { getBaseline, saveBaseline } from "./baseline";
import { narrowCandidateScenes } from "./narrowing";
import { runPostEffectMulti } from "@/features/post-effect/api";

const sourceRevision = {
  kind: "sqlite_write_clock_v1" as const,
  expected_lineage: "5c469be051e34f31a95e0bf457806c56",
  expected_seq: "10",
};

const base: CodexSnapshot = {
  name: "アリス",
  aliases: ["アリー"],
  summary: "15歳。",
  contentPlain: "町に住む。",
  details: [{ name: "年齢", value: "15" }],
  phases: [],
  visibilityProvenanceVersion: 1,
  allPhaseIds: [],
  restrictedPhaseIds: [],
};
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
const aged = (s: CodexSnapshot): CodexSnapshot => ({
  ...s,
  details: [{ name: "年齢", value: "17" }],
});
const legacyWithPhase = (() => {
  const s: CodexSnapshot = { ...base, phases: [phase] };
  delete (s as Partial<CodexSnapshot>).allPhaseIds;
  delete (s as Partial<CodexSnapshot>).visibilityProvenanceVersion;
  delete (s as Partial<CodexSnapshot>).restrictedPhaseIds;
  return s;
})();

interface Case {
  name: string;
  baseline: CodexSnapshot | null;
  snapshot: CodexSnapshot;
  contextMode?: string;
  hasRestrictedPhases?: boolean;
  expected: ImpactPending["state"];
  changeCount?: number;
  /** gated（unresolved）のとき、run が実際に数える件数。 */
  runChangeCount?: number;
}

const cases: Case[] = [
  { name: "差分なし", baseline: base, snapshot: { ...base }, expected: "none" },
  {
    name: "空白・全半角・別名の順だけの違い",
    baseline: base,
    snapshot: {
      ...base,
      name: "ア リ ス",
      summary: "１５歳。",
      aliases: ["アリー"],
    },
    expected: "none",
  },
  {
    name: "detail の値の変更",
    baseline: base,
    snapshot: aged(base),
    expected: "pending",
    changeCount: 1,
  },
  {
    name: "name・summary・content の変更",
    baseline: base,
    snapshot: {
      ...base,
      name: "アリシア",
      summary: "17歳。",
      contentPlain: "都に。",
    },
    expected: "pending",
    changeCount: 3,
  },
  {
    name: "公開 Phase の override の変更",
    baseline: withPhase,
    snapshot: { ...withPhase, phases: [{ ...phase, summary: "さらに成長。" }] },
    expected: "pending",
    changeCount: 1,
  },
  {
    name: "contextMode=hidden（差分あり）",
    baseline: base,
    snapshot: aged(base),
    contextMode: "hidden",
    expected: "gated",
  },
  {
    name: "contextMode=suppress（差分あり）",
    baseline: base,
    snapshot: aged(base),
    contextMode: "suppress",
    expected: "gated",
  },
  {
    name: "contextMode=不明な値（差分あり）",
    baseline: base,
    snapshot: aged(base),
    contextMode: "weird",
    expected: "gated",
  },
  {
    name: "Phase が 1 つ制限的（flag）",
    baseline: base,
    snapshot: aged(base),
    hasRestrictedPhases: true,
    expected: "gated",
  },
  {
    name: "Phase が 1 つ制限的（snapshot.restrictedPhaseIds）",
    baseline: base,
    snapshot: { ...aged(base), restrictedPhaseIds: ["p9"] },
    expected: "gated",
  },
  {
    name: "証明の無い Phase の削除",
    baseline: withPhase,
    snapshot: aged({ ...base, phases: [], allPhaseIds: [] }),
    expected: "gated",
    runChangeCount: 1,
  },
  {
    name: "公開中の削除と証明済みの Phase の削除",
    baseline: { ...withPhase, visibleDeletedPhaseIds: ["p1"] },
    snapshot: aged({ ...base, phases: [], allPhaseIds: [] }),
    expected: "pending",
    changeCount: 2,
  },
  {
    name: "legacy の baseline（来歴無し）の Phase 削除",
    baseline: legacyWithPhase,
    snapshot: aged({ ...base, phases: [], allPhaseIds: [] }),
    expected: "gated",
    runChangeCount: 1,
  },
  {
    name: "baseline の restrictedPhaseIds の Phase が現存・公開（解除）",
    baseline: { ...withPhase, restrictedPhaseIds: ["p1"] },
    snapshot: aged(withPhase),
    expected: "pending",
    changeCount: 1,
  },
  {
    name: "baseline の restrictedPhaseIds の Phase が現在無い",
    baseline: {
      ...base,
      allPhaseIds: ["p1"],
      restrictedPhaseIds: ["p1"],
    },
    snapshot: aged(base),
    expected: "gated",
    runChangeCount: 1,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(saveBaseline).mockResolvedValue("hash");
  vi.mocked(narrowCandidateScenes).mockResolvedValue([]);
});

function arrange(c: Case) {
  const built = {
    snapshot: c.snapshot,
    projectId: "p1",
    entryType: "character",
    entryName: "アリス",
    sourceRevision,
    ...(c.contextMode !== undefined ? { contextMode: c.contextMode } : {}),
    ...(c.hasRestrictedPhases ? { hasRestrictedPhases: true } : {}),
  };
  vi.mocked(buildCodexSnapshot).mockResolvedValue(built);
  vi.mocked(getBaseline).mockResolvedValue(c.baseline);
  return built;
}

describe("deriveImpactPending は実物の runImpactReview と一致する", () => {
  it.each(cases)("$name", async (c) => {
    const built = arrange(c);
    const pending = deriveImpactPending({ baseline: c.baseline, built });
    expect(pending.state).toBe(c.expected);
    if (c.changeCount !== undefined) {
      expect(pending).toEqual({ state: "pending", changeCount: c.changeCount });
    }

    const res = await runImpactReview("e1");
    // 知らせの段は AI を呼ばないが、run でも runPostEffectMulti は候補 0 で呼ばれない。
    expect(runPostEffectMulti).not.toHaveBeenCalled();

    switch (pending.state) {
      case "pending":
        expect(res.status).not.toBe("no-change");
        expect(res.changeCount).toBe(pending.changeCount);
        expect(narrowCandidateScenes).toHaveBeenCalled();
        break;
      case "none":
        expect(res.status).toBe("no-change");
        break;
      case "gated":
        if (
          c.name.includes("証明の無い") ||
          c.name.includes("legacy") ||
          c.name.includes("現在無い")
        ) {
          // run の redact は Phase を除外して差分を取る＝素の差分と食い違い得る。
          // 知らせは出さない（偽陰性は許容）。run 側の件数は素の差分以下で、
          // 少なくとも 1 つは素の差分より少ない（下の「食い違いの実例」）。
          expect(res.changeCount).toBeLessThanOrEqual(
            computeCodexDiff(c.baseline, c.snapshot).length,
          );
          expect(res.changeCount).toBe(c.runChangeCount);
        } else {
          // 現在の制限・contextMode は、差分があっても候補絞りの前で止まる。
          expect(res.status).toBe("no-candidates");
          expect(narrowCandidateScenes).not.toHaveBeenCalled();
        }
        break;
      default:
        throw new Error(`unexpected state ${pending.state}`);
    }
  });

  it("証明の無い Phase 削除: 素の差分は 2 件だが run は Phase を除いて 1 件（食い違いの実例）", async () => {
    const c = cases.find((x) => x.name === "証明の無い Phase の削除")!;
    arrange(c);
    const res = await runImpactReview("e1");
    expect(res.changeCount).toBe(1);
  });

  it("baseline が無い／tombstone のみは unchecked（run は全フィールドを変更と数える）", async () => {
    for (const baseline of [
      null,
      {
        name: "",
        aliases: [],
        summary: "",
        contentPlain: "",
        details: [],
        phases: [],
        allPhaseIds: ["p1"],
        restrictedPhaseIds: ["p1"],
      } as CodexSnapshot,
    ]) {
      const c: Case = {
        name: "x",
        baseline,
        snapshot: base,
        expected: "unchecked",
      };
      const built = arrange(c);
      expect(deriveImpactPending({ baseline, built }).state).toBe("unchecked");
      const res = await runImpactReview("e1");
      expect(res.status).not.toBe("no-change");
    }
  });
});
