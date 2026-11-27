import type {
  RedecideStatus,
  ReapproveAppliedProposalSkipReasonCode,
} from "@/application/narrative-extraction/nativeApi";

/** `t(key, defaultValue, values)` from react-i18next. */
export type ReapprovalTranslate = (
  key: string,
  defaultValue: string,
  values?: Readonly<Record<string, string>>,
) => string;

/**
 * SRD/1 RA7: Native's reapproval judgement (RD2) and removal record (RD1) as
 * author-facing text. The only place where these codes become sentences. The
 * screen never decides whether a proposal can be re-approved.
 */

const REASONS: Readonly<
  Record<ReapproveAppliedProposalSkipReasonCode, readonly [string, string]>
> = {
  "proposal-not-found": [
    "chronicle.extract.reapproveReason.proposalNotFound",
    "提案が見つかりません",
  ],
  "no-application": [
    "chronicle.extract.reapproveReason.noApplication",
    "取り込みの記録がありません",
  ],
  "revision-changed": [
    "chronicle.extract.reapproveReason.revisionChanged",
    "取り込んだ後に提案が変わりました",
  ],
  "already-approved": [
    "chronicle.extract.reapproveReason.alreadyApproved",
    "既に承認されています",
  ],
  "not-removal-rejection": [
    "chronicle.extract.reapproveReason.notRemovalRejection",
    "出来事を消して外れた承認ではありません",
  ],
  "event-missing": [
    "chronicle.extract.reapproveReason.eventMissing",
    "取り込んだ出来事が年表にありません",
  ],
};

const REMOVED_VIA: Readonly<
  Record<NonNullable<RedecideStatus["removedVia"]>, readonly [string, string]>
> = {
  "screen-delete": [
    "chronicle.extract.removedVia.screenDelete",
    "年表での削除",
  ],
  "undo-redo": ["chronicle.extract.removedVia.undoRedo", "元に戻す／やり直す"],
  "snapshot-restore": [
    "chronicle.extract.removedVia.snapshotRestore",
    "スナップショットの復元",
  ],
  "commit-undo": [
    "chronicle.extract.removedVia.commitUndo",
    "取り込みの取り消し",
  ],
  "mcp-delete": ["chronicle.extract.removedVia.mcpDelete", "MCP からの削除"],
  "agent-delete": [
    "chronicle.extract.removedVia.agentDelete",
    "AI の操作による削除",
  ],
};

/** Why "承認し直す" cannot be pressed, or `null` when the code is unknown. */
export function describeReapprovalReason(
  reason: string | null | undefined,
  t: ReapprovalTranslate,
): string | null {
  if (!reason) return null;
  const entry = REASONS[reason as ReapproveAppliedProposalSkipReasonCode];
  return entry ? t(entry[0], entry[1]) : null;
}

/** What removed the event, or `null` when Native did not say. */
export function describeRemovedVia(
  via: RedecideStatus["removedVia"] | undefined,
  t: ReapprovalTranslate,
): string | null {
  if (!via) return null;
  const entry = REMOVED_VIA[via];
  return entry ? t(entry[0], entry[1]) : null;
}

/** "2026/11/26 19:10" in the author's locale; the raw value when unparsable. */
export function formatRejectedAt(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** One line for the card: "年表での削除で外れました（2026/11/26 19:10）". */
export function describeRemoval(
  status: Pick<RedecideStatus, "removedVia" | "rejectedAt">,
  t: ReapprovalTranslate,
): string {
  const via = describeRemovedVia(status.removedVia, t);
  const at = formatRejectedAt(status.rejectedAt);
  const head = via
    ? t("chronicle.extract.removedBy", "{{via}}で外れました", { via })
    : t("chronicle.extract.removedUnknown", "出来事が消えて外れました");
  return at ? `${head}（${at}）` : head;
}
