/**
 * impact-review: 「前回のチェック以降に変更がある」を、ボタンを押す前に知らせるための
 * 判定（純ロジック・IO なし・AI なし。DR-INN-1）。
 *
 * Phase の redact・除外集合・門は `impactGate.ts` の純関数で run と共有する。
 * `runImpactReview.ts` は import せず、AI 経路から独立させる（DR-INN-1）。
 *
 * 出さない（`pending` 以外）理由:
 *  - `unchecked`: baseline が無い／値が一度も確認されていない（制限の印だけの）baseline。
 *    初回は run が全フィールドを「変更」と数えるため、そのまま出すと全項目が変更ありになる。
 *  - `gated`: run が `no-candidates` で止める条件（base の contextMode が current-mention を
 *    満たさない・Phase が制限的）。押しても baseline は進まない。
 *
 * 件数は run と同じく、`effectiveRestrictedPhaseIds` の Phase を baseline・現在の両方から
 * 除いてから数える。件数だけを返すので、除いた
 * （非公開だった）Phase の内容は表示に出ない。
 *  - `none`: 差分なし。
 */

import { computeCodexDiff, type CodexSnapshot } from "./diff";
import type { CodexSnapshotResult } from "./snapshot";
import {
  currentHasRestrictedPhases,
  effectiveRestrictedPhaseIds,
  evaluateImpactGate,
  redactRestrictedPhases,
  type ImpactGateReason,
} from "./impactGate";

export type ImpactPendingGateReason = ImpactGateReason;

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
  const { snapshot } = built;
  const gate = evaluateImpactGate({
    contextMode: built.contextMode,
    currentHasRestrictedPhases: currentHasRestrictedPhases(
      snapshot,
      built.hasRestrictedPhases,
    ),
  });
  if (gate.reason !== null) {
    return { state: "gated", reason: gate.reason };
  }
  // run はこの集合の Phase（証明の無い削除・非公開だった Phase など）を baseline・現在の
  // 両方から除いて差分を取り、そのまま候補絞りへ進む。同じ件数を数える。
  const effective = effectiveRestrictedPhaseIds(baseline, snapshot);
  const changes = computeCodexDiff(
    redactRestrictedPhases(baseline, effective),
    redactRestrictedPhases(snapshot, effective),
  );
  return changes.length === 0
    ? IMPACT_PENDING_NONE
    : { state: "pending", changeCount: changes.length };
}
