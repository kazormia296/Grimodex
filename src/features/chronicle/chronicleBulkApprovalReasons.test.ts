import { describe, expect, it } from "vitest";
import {
  describeBulkApprovalOutcomeReason,
  describeBulkApprovalReasons,
  hasReviewReason,
  orderProposalsForReview,
} from "./chronicleBulkApprovalReasons";

const identity = (_key: string, fallback: string) => fallback;

describe("describeBulkApprovalReasons", () => {
  it("gives the author-facing sentence for each review reason (RR/1)", () => {
    const sentence = (code: string) =>
      describeBulkApprovalReasons(
        { eligible: false, reasons: [code as never] },
        identity,
      );
    expect(sentence("r1-narrative-frame")).toEqual([
      "回想・伝聞など、地の文の出来事ではありません",
    ]);
    expect(sentence("r2-attribution")).toEqual([
      "登場人物の発言や心の声の中の出来事です",
    ]);
    expect(sentence("r3-significance")).toEqual(["物語の大きな出来事です"]);
    expect(sentence("r4-actuality")).toEqual([
      "試みたが成らなかった／阻まれた出来事です",
    ]);
    expect(sentence("r0-material-unavailable")).toEqual([
      "確かめられませんでした",
    ]);
  });

  it("explains edited, evidence and child-revision reasons", () => {
    const sentence = (code: string) =>
      describeBulkApprovalReasons(
        { eligible: false, reasons: [code as never] },
        identity,
      );
    expect(sentence("edited")).toEqual(["編集した提案です"]);
    expect(sentence("evidence-unverified")).toEqual([
      "根拠の引用を本文で確かめられませんでした",
    ]);
    expect(sentence("reveal-scene-unresolved")).toEqual([
      "開示の場面を決められません",
    ]);
    expect(sentence("scope-authority-unavailable")).toEqual([
      "場面の Scope を確かめられません",
    ]);
    expect(sentence("semantic-epoch-missing")).toHaveLength(1);
    expect(sentence("parent-seal-missing")).toHaveLength(1);
    expect(sentence("already-nonsecret")).toHaveLength(1);
    expect(sentence("plan-unavailable")).toHaveLength(1);
  });

  it("says nothing about review/apply state (the card already shows it)", () => {
    for (const code of [
      "approved",
      "rejected",
      "held",
      "deferred",
      "status-other",
      "applied",
      "set-applied",
    ]) {
      expect(
        describeBulkApprovalReasons(
          { eligible: false, reasons: [code as never] },
          identity,
        ),
      ).toEqual([]);
    }
  });

  it("puts reasons to show first, in R1..R4,R0 order, ignoring the input order", () => {
    expect(
      describeBulkApprovalReasons(
        {
          eligible: false,
          reasons: [
            "edited",
            "r0-material-unavailable",
            "r4-actuality",
            "r1-narrative-frame",
          ],
        },
        identity,
      ),
    ).toEqual([
      "回想・伝聞など、地の文の出来事ではありません",
      "試みたが成らなかった／阻まれた出来事です",
      "確かめられませんでした",
      "編集した提案です",
    ]);
  });

  it("gives no line once a state is reported, so an approved bulk-approved child is not 'edited'", () => {
    expect(
      describeBulkApprovalReasons(
        {
          eligible: false,
          reasons: ["approved", "edited", "already-nonsecret"],
        },
        identity,
      ),
    ).toEqual([]);
    expect(
      describeBulkApprovalReasons(
        { eligible: false, reasons: ["held", "r3-significance"] },
        identity,
      ),
    ).toEqual([]);
  });

  it("omits probable-duplicate only when the card has its own duplicate display", () => {
    const judgement = {
      eligible: false,
      reasons: ["probable-duplicate"],
    } as const;
    expect(describeBulkApprovalReasons(judgement, identity)).toHaveLength(1);
    expect(
      describeBulkApprovalReasons(judgement, identity, { omitDuplicate: true }),
    ).toEqual([]);
  });

  it("gives one generic sentence for an unknown code, none when known ones exist", () => {
    expect(
      describeBulkApprovalReasons(
        { eligible: false, reasons: ["from-the-future" as never] },
        identity,
      ),
    ).toEqual(["まとめて承認の対象ではありません"]);
    expect(
      describeBulkApprovalReasons(
        { eligible: false, reasons: ["from-the-future" as never, "edited"] },
        identity,
      ),
    ).toEqual(["編集した提案です"]);
  });

  it("returns nothing for a target and for an unknown judgement", () => {
    expect(
      describeBulkApprovalReasons({ eligible: true, reasons: [] }, identity),
    ).toEqual([]);
    expect(describeBulkApprovalReasons(null, identity)).toEqual([]);
    expect(describeBulkApprovalReasons(undefined, identity)).toEqual([]);
  });

  it("goes through the translator (keys carry the default text)", () => {
    const seen: string[] = [];
    describeBulkApprovalReasons(
      { eligible: false, reasons: ["r3-significance"] },
      (key, fallback) => {
        seen.push(key);
        return `<${fallback}>`;
      },
    );
    expect(seen).toEqual(["chronicle.extract.bulkReason.r3"]);
  });
});

describe("describeBulkApprovalOutcomeReason", () => {
  it("gives words for state codes and command-only codes too", () => {
    expect(describeBulkApprovalOutcomeReason("approved", identity)).toBe(
      "すでに判断済みか、取り込み済みでした",
    );
    expect(
      describeBulkApprovalOutcomeReason("revision-changed", identity),
    ).toBe("承認の前に提案が変わりました");
    expect(
      describeBulkApprovalOutcomeReason("proposal-not-found", identity),
    ).toBe("提案が見つかりませんでした");
    expect(describeBulkApprovalOutcomeReason("r3-significance", identity)).toBe(
      "物語の大きな出来事です",
    );
    expect(describeBulkApprovalOutcomeReason("nope", identity)).toBe(
      "まとめて承認の対象ではありません",
    );
  });
});

describe("hasReviewReason / orderProposalsForReview", () => {
  it("detects reasons to show only (R0..R4)", () => {
    expect(hasReviewReason({ eligible: false, reasons: ["edited"] })).toBe(
      false,
    );
    expect(
      hasReviewReason({
        eligible: false,
        reasons: ["edited", "r2-attribution"],
      }),
    ).toBe(true);
    expect(hasReviewReason(null)).toBe(false);
  });

  const row = (
    id: string,
    reasons: string[],
    extra: Partial<{
      status: string;
      application: unknown;
      applicability: string;
    }> = {},
  ) => ({
    id,
    applicability: "applicable",
    application: null,
    status: "unreviewed",
    bulkApproval: { eligible: reasons.length === 0, reasons: reasons as never },
    ...extra,
  });

  it("keeps the relative order inside each group and does not mutate the input", () => {
    const input = [
      row("a", []),
      row("b", ["r3-significance"]),
      row("c", ["edited"]),
      row("d", ["r1-narrative-frame"]),
      row("e", ["r3-significance"], { status: "approved" }),
      row("f", ["r3-significance"], { application: { commitId: "x" } }),
    ];
    const ids = input.map((item) => item.id);
    const ordered = orderProposalsForReview(input).map((item) => item.id);
    expect(ordered).toEqual(["b", "d", "a", "c", "e", "f"]);
    expect(input.map((item) => item.id)).toEqual(ids);
  });

  it("returns the same array when nothing moves", () => {
    const input = [row("a", []), row("b", ["edited"])];
    expect(orderProposalsForReview(input)).toBe(input);
  });
});
