import type { DomainObjectKey } from "./domainObjectKey";
import type { Sha256Digest } from "./changeEvent";
import type { NarrativeFreshnessState } from "./freshness";
import type { NarrativeApplicationHealth } from "./applicationHealth";

export type NarrativeMaintenanceOwnership =
  | "maintained"
  | "user-owned"
  | "detached";

/**
 * Field / Association 単位の Application Contribution。
 * Event 全体を一状態に潰さず、人間編集と AI 由来を分離する。
 */
export interface NarrativeApplicationContribution {
  readonly schemaVersion: 1;
  readonly contributionId: string;
  readonly applicationId: string;
  readonly proposalId: string;
  readonly revisionId: string | null;
  readonly target: DomainObjectKey;
  readonly targetPath: string;
  readonly role:
    | "field"
    | "association"
    | "anchor"
    | "relation"
    | "projection"
    | "binding";
  readonly committedValueDigest: Sha256Digest | null;
  readonly dependencyDigest: Sha256Digest;
  readonly baselineSequence: number;
  readonly maintenanceOwnership: NarrativeMaintenanceOwnership;
  readonly health: NarrativeApplicationHealth;
}

export interface EvaluateContributionHealthInput {
  readonly evidenceStatuses: readonly NarrativeFreshnessState[];
  readonly targetDigestMatchesCommitted: boolean;
  readonly ownership: NarrativeMaintenanceOwnership;
  readonly contradicted?: boolean;
  readonly sourceMissing?: boolean;
  readonly superseded?: boolean;
  readonly undone?: boolean;
}

/**
 * Field 単位の健康状態。人間編集は上書き対象外（target-modified / user-owned）。
 * Evidence 消失だけでは Domain 構造を削除しない — unsupported を返すだけ。
 */
export function evaluateContributionHealth(
  input: EvaluateContributionHealthInput,
): NarrativeApplicationHealth {
  if (input.undone) return "undone";
  if (input.superseded) return "superseded";
  if (input.ownership === "detached") return "unknown";
  if (!input.targetDigestMatchesCommitted || input.ownership === "user-owned") {
    return "target-modified";
  }
  if (input.sourceMissing) return "source-missing";
  if (input.contradicted) return "contradicted";
  if (input.evidenceStatuses.length === 0) return "unsupported";

  const hasContentStale = input.evidenceStatuses.some(
    (status) => status === "content-stale",
  );
  const hasSourceMissing = input.evidenceStatuses.some(
    (status) => status === "source-missing",
  );
  const hasReanchorable = input.evidenceStatuses.some(
    (status) => status === "reanchorable",
  );
  const hasSupportedEvidence = input.evidenceStatuses.some(
    (status) =>
      status === "fresh" ||
      status === "reanchorable" ||
      status === "context-stale",
  );

  if ((hasContentStale || hasSourceMissing) && hasSupportedEvidence) {
    return "partially-supported";
  }
  if (hasContentStale || hasSourceMissing) return "unsupported";
  if (hasReanchorable) return "supported-after-reanchor";
  return "supported";
}
