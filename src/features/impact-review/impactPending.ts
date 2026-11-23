/**
 * impact-review: 「前回のチェック以降に変更がある」を、ボタンを押す前に知らせるための
 * 判定（純ロジック・IO なし・AI なし。DR-INN-1）。
 *
 * 規則は `runImpactReview`（`runImpactReview.ts`）の実行時の判定を字面どおり写す
 * （押しても止まる項目を知らせないため）。`runImpactReview.ts` は import しない
 * （AI 経路への依存と循環を避ける。規則が 2 か所になる点は parity 試験
 * `impactPending.parity.test.ts` で固定する）。
 *
 * 出さない（`pending` 以外）理由:
 *  - `unchecked`: baseline が無い／値が一度も確認されていない（制限の印だけの）baseline。
 *    初回は run が全フィールドを「変更」と数えるため、そのまま出すと全項目が変更ありになる。
 *  - `gated`: run が `no-candidates` で止める条件（base の contextMode が current-mention を
 *    満たさない・Phase が制限的）。押しても baseline は進まない。
 *  - `none`: 差分なし。
 */

import { canIncludeResolvedCodexContext } from "@/features/codex/context/codexVisibilityPolicy";
import { computeCodexDiff, type CodexSnapshot } from "./diff";
import type { CodexSnapshotResult } from "./snapshot";

export type ImpactPendingGateReason =
  | "restricted-phase" // 現在 Phase が 1 つでも制限的（run の currentHasRestrictedPhases）
  | "context-mode" // base の contextMode が current-mention を満たさない
  | "unresolved-phase-restriction"; // run の redact が Phase を除外する（素の差分と食い違う）

export type ImpactPending =
  | { state: "unchecked" }
  | { state: "gated"; reason: ImpactPendingGateReason }
  | { state: "none" }
  | { state: "pending"; changeCount: number };

export const IMPACT_PENDING_NONE: ImpactPending = { state: "none" };

/**
 * 値が一度も確認されていない baseline か。run が制限の印だけを書く tombstone
 * （`emptyBaselineWithRestrictionMetadata`）は、値がすべて空。
 */
function hasNoReviewedValues(baseline: CodexSnapshot): boolean {
  return (
    baseline.name === "" &&
    baseline.aliases.length === 0 &&
    baseline.summary === "" &&
    baseline.contentPlain === "" &&
    baseline.details.length === 0 &&
    (baseline.phases ?? []).length === 0
  );
}

function phaseIdSet(snapshot: CodexSnapshot): Set<string> {
  return new Set(
    snapshot.allPhaseIds ??
      snapshot.phases?.map((phase) => phase.phaseId) ??
      [],
  );
}

/**
 * run の `effectiveRestrictedPhaseIds` と同じ規則（現在制限中の Phase ∪ baseline の
 * restrictedPhaseIds のうち現在無いもの ∪ baseline の phases のうち現在無く、
 * 公開中の削除と証明されていないもの）。
 */
function effectiveRestrictedPhaseIds(
  baseline: CodexSnapshot,
  snapshot: CodexSnapshot,
): Set<string> {
  const current = new Set(snapshot.restrictedPhaseIds ?? []);
  const currentPhaseIds = phaseIdSet(snapshot);
  const visibleDeleted = new Set(baseline.visibleDeletedPhaseIds ?? []);
  const effective = new Set(current);
  for (const phaseId of baseline.restrictedPhaseIds ?? []) {
    if (!currentPhaseIds.has(phaseId)) effective.add(phaseId);
  }
  for (const phase of baseline.phases ?? []) {
    if (
      !currentPhaseIds.has(phase.phaseId) &&
      !visibleDeleted.has(phase.phaseId)
    ) {
      effective.add(phase.phaseId);
    }
  }
  return effective;
}

export function deriveImpactPending(input: {
  baseline: CodexSnapshot | null;
  built: Pick<
    CodexSnapshotResult,
    "snapshot" | "contextMode" | "hasRestrictedPhases"
  >;
}): ImpactPending {
  const { baseline, built } = input;
  if (baseline === null || hasNoReviewedValues(baseline)) {
    return { state: "unchecked" };
  }
  const {
    snapshot,
    contextMode = "mentioned",
    hasRestrictedPhases = false,
  } = built;

  const currentHasRestrictedPhases =
    hasRestrictedPhases || (snapshot.restrictedPhaseIds ?? []).length > 0;
  if (currentHasRestrictedPhases) {
    return { state: "gated", reason: "restricted-phase" };
  }
  if (!canIncludeResolvedCodexContext(contextMode, "current-mention")) {
    return { state: "gated", reason: "context-mode" };
  }
  // run はこの集合の Phase を baseline・現在の両方から除いて差分を取る。空でなければ
  // 素の差分は run の差分と食い違うので、知らせない（偽陽性を避ける。偽陰性は許容）。
  if (effectiveRestrictedPhaseIds(baseline, snapshot).size > 0) {
    return { state: "gated", reason: "unresolved-phase-restriction" };
  }

  const changes = computeCodexDiff(baseline, snapshot);
  return changes.length === 0
    ? IMPACT_PENDING_NONE
    : { state: "pending", changeCount: changes.length };
}
