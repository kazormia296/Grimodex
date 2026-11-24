import type { TFunction } from "i18next";

export const BLOCKED_REASON_EVIDENCE_UNRESOLVED =
  "根拠が未解決です。再抽出して根拠を確認してください";
export const BLOCKED_REASON_RELATION_EXISTS =
  "既に同じ関係が登録されています（適用不要）";
export const BLOCKED_REASON_ENTRY_AMBIGUOUS =
  "既存 Entry 候補が複数あり、Binding が未解決です";
export const BLOCKED_REASON_DETAIL_UNMAPPED = "Detail 定義が未割当です";
export const BLOCKED_REASON_PHASE_AMBIGUOUS = "既存 Phase 候補が複数あります";

const BLOCKED_REASON_KEYS = {
  [BLOCKED_REASON_EVIDENCE_UNRESOLVED]: "evidenceUnresolved",
  [BLOCKED_REASON_RELATION_EXISTS]: "relationExists",
  [BLOCKED_REASON_ENTRY_AMBIGUOUS]: "entryAmbiguous",
  [BLOCKED_REASON_DETAIL_UNMAPPED]: "detailUnmapped",
  [BLOCKED_REASON_PHASE_AMBIGUOUS]: "phaseAmbiguous",
} as const;

export function localizeBlockedReason(
  reason: string | undefined,
  t: TFunction,
): string | undefined {
  if (reason === undefined) return undefined;
  const key = BLOCKED_REASON_KEYS[reason as keyof typeof BLOCKED_REASON_KEYS];
  return key ? t(`codex.structureReview.blockedReason.${key}`) : reason;
}
