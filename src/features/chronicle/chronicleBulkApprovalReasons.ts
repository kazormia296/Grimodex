import type { ChronicleBulkApproval } from "@/application/narrative-extraction/nativeApi";

/**
 * Native's "bulk approve" judgement (BAO/1) as author-facing text. The only
 * place where a reason code is mapped to a sentence. The screen never decides
 * eligibility: it shows Native's `eligible` and these sentences.
 */

export type BulkApprovalTranslate = (
  key: string,
  defaultValue: string,
) => string;

type ReasonKind =
  /** RR/1 "show the author" reasons. Listed first. */
  | "review"
  /** Other reasons that mean something to the author. */
  | "info"
  /** Review/apply state: the card already shows it. */
  | "state"
  /** Reported only by the command (`skipped`). */
  | "command";

interface ReasonEntry {
  readonly kind: ReasonKind;
  readonly key: string;
  readonly text: string;
}

const REASONS: Readonly<Record<string, ReasonEntry>> = {
  "r1-narrative-frame": {
    kind: "review",
    key: "chronicle.extract.bulkReason.r1",
    text: "回想・伝聞など、地の文の出来事ではありません",
  },
  "r2-attribution": {
    kind: "review",
    key: "chronicle.extract.bulkReason.r2",
    text: "登場人物の発言や心の声の中の出来事です",
  },
  "r3-significance": {
    kind: "review",
    key: "chronicle.extract.bulkReason.r3",
    text: "物語の大きな出来事です",
  },
  "r4-actuality": {
    kind: "review",
    key: "chronicle.extract.bulkReason.r4",
    text: "試みたが成らなかった／阻まれた出来事です",
  },
  "r0-material-unavailable": {
    kind: "review",
    key: "chronicle.extract.bulkReason.r0",
    text: "確かめられませんでした",
  },
  edited: {
    kind: "info",
    key: "chronicle.extract.bulkReason.edited",
    text: "編集した提案です",
  },
  "probable-duplicate": {
    kind: "info",
    key: "chronicle.extract.bulkReason.probableDuplicate",
    text: "既存の出来事と同じ可能性があります",
  },
  "plan-unavailable": {
    kind: "info",
    key: "chronicle.extract.bulkReason.planUnavailable",
    text: "既存の出来事との重複を確かめられませんでした",
  },
  "evidence-unverified": {
    kind: "info",
    key: "chronicle.extract.bulkReason.evidenceUnverified",
    text: "根拠の引用を本文で確かめられませんでした",
  },
  "already-nonsecret": {
    kind: "info",
    key: "chronicle.extract.bulkReason.alreadyNonsecret",
    text: "すでに秘密の印が外れています",
  },
  "reveal-scene-unresolved": {
    kind: "info",
    key: "chronicle.extract.bulkReason.revealSceneUnresolved",
    text: "開示の場面を決められません",
  },
  "scope-authority-unavailable": {
    kind: "info",
    key: "chronicle.extract.bulkReason.scopeAuthorityUnavailable",
    text: "場面の Scope を確かめられません",
  },
  "semantic-epoch-missing": {
    kind: "info",
    key: "chronicle.extract.bulkReason.semanticEpochMissing",
    text: "プロジェクトの意味の世代の記録がありません",
  },
  "parent-seal-missing": {
    kind: "info",
    key: "chronicle.extract.bulkReason.parentSealMissing",
    text: "元の版の封印の記録がありません",
  },
  approved: { kind: "state", key: "", text: "" },
  rejected: { kind: "state", key: "", text: "" },
  held: { kind: "state", key: "", text: "" },
  deferred: { kind: "state", key: "", text: "" },
  "status-other": { kind: "state", key: "", text: "" },
  applied: { kind: "state", key: "", text: "" },
  "set-applied": { kind: "state", key: "", text: "" },
  "proposal-not-found": {
    kind: "command",
    key: "chronicle.extract.bulkReason.proposalNotFound",
    text: "提案が見つかりませんでした",
  },
  "revision-changed": {
    kind: "command",
    key: "chronicle.extract.bulkReason.revisionChanged",
    text: "承認の前に提案が変わりました",
  },
};

const STATE_OUTCOME = {
  key: "chronicle.extract.bulkReason.stateChanged",
  text: "すでに判断済みか、取り込み済みでした",
} as const;

const UNKNOWN_REASON = {
  key: "chronicle.extract.bulkReason.unknown",
  text: "まとめて承認の対象ではありません",
} as const;

/** Shown reasons first (R1..R4, R0), then the other author-meaningful ones. */
const REVIEW_ORDER = [
  "r1-narrative-frame",
  "r2-attribution",
  "r3-significance",
  "r4-actuality",
  "r0-material-unavailable",
] as const;

export function isReviewReason(code: string): boolean {
  return REASONS[code]?.kind === "review";
}

/** True if any RR/1 "show the author" reason (R0..R4) is present. */
export function hasReviewReason(
  judgement: ChronicleBulkApproval | null | undefined,
): boolean {
  return judgement?.reasons.some((code) => isReviewReason(code)) ?? false;
}

/**
 * Sentences for the card of a proposal that is not a target. If Native reports
 * any review/apply state (approved, rejected, held, deferred, applied, ...) the
 * proposal is already decided: the card shows that state, and the other codes
 * would describe the decided revision (an approved bulk-approved child is
 * "edited"), so no line is given. An unknown code gets one generic sentence. `omitDuplicate`: the card already has its own duplicate
 * display, so `probable-duplicate` adds nothing.
 */
export function describeBulkApprovalReasons(
  judgement: ChronicleBulkApproval | null | undefined,
  t: BulkApprovalTranslate,
  options: { readonly omitDuplicate?: boolean } = {},
): string[] {
  if (!judgement || judgement.eligible) return [];
  const codes = [...new Set(judgement.reasons)];
  if (codes.some((code) => REASONS[code]?.kind === "state")) return [];
  const sentences: string[] = [];
  const push = (entry: { key: string; text: string }) => {
    const sentence = t(entry.key, entry.text);
    if (!sentences.includes(sentence)) sentences.push(sentence);
  };
  for (const code of REVIEW_ORDER) {
    if (codes.includes(code)) push(REASONS[code]);
  }
  let unknown = false;
  for (const code of codes) {
    const entry = REASONS[code];
    if (!entry) {
      unknown = true;
      continue;
    }
    if (entry.kind === "review" || entry.kind === "state") continue;
    if (code === "probable-duplicate" && options.omitDuplicate) continue;
    push(entry);
  }
  if (unknown && sentences.length === 0) push(UNKNOWN_REASON);
  return sentences;
}

/**
 * One sentence for a code in the result of a bulk approval (`skipped`), where
 * state codes also need words.
 */
export function describeBulkApprovalOutcomeReason(
  code: string,
  t: BulkApprovalTranslate,
): string {
  const entry = REASONS[code];
  if (!entry) return t(UNKNOWN_REASON.key, UNKNOWN_REASON.text);
  if (entry.kind === "state") return t(STATE_OUTCOME.key, STATE_OUTCOME.text);
  return t(entry.key, entry.text);
}

/**
 * Display order only: unreviewed proposals that carry a "show the author"
 * reason go first; the relative order inside each group is kept. The store's
 * order is never changed (DR-BAO-9).
 */
export function orderProposalsForReview<
  T extends {
    readonly applicability: string;
    readonly application: unknown;
    readonly status: string;
    readonly bulkApproval?: ChronicleBulkApproval | null;
  },
>(proposals: readonly T[]): readonly T[] {
  const shown: T[] = [];
  const rest: T[] = [];
  for (const proposal of proposals) {
    if (
      proposal.applicability === "applicable" &&
      proposal.application === null &&
      proposal.status === "unreviewed" &&
      hasReviewReason(proposal.bulkApproval)
    ) {
      shown.push(proposal);
    } else {
      rest.push(proposal);
    }
  }
  return shown.length === 0 ? proposals : [...shown, ...rest];
}
