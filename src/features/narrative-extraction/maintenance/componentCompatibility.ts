import type { NarrativeRefreshAvailability } from "./freshness";

export interface NarrativeComponentVersionSet {
  readonly normalizerVersion: string;
  readonly evidenceResolverVersion: string;
  readonly extractorVersions: Readonly<Record<string, string>>;
  readonly promptVersions: Readonly<Record<string, string>>;
  readonly parserVersions: Readonly<Record<string, string>>;
  readonly solverVersions: Readonly<Record<string, string>>;
  readonly compilerVersions: Readonly<Record<string, string>>;
  readonly domainCapabilityDigest: string;
}

export interface NarrativeComponentCompatibility {
  readonly componentId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly impact:
    | "none"
    | "reparse-raw-response"
    | "revalidate-evidence"
    | "rerun-deterministic-stage"
    | "rerun-ai-stage"
    | "rerun-descendants"
    | "recompile"
    | "breaking";
}

export type NarrativeComponentCompatibilityStatus =
  | "compatible"
  | "quality-improvement-available"
  | "incompatible";

/** Compare a single component version pair using a registered compatibility rule. */
export function classifyComponentCompatibility(
  rule: NarrativeComponentCompatibility | null,
  committedVersion: string,
  currentVersion: string,
): NarrativeComponentCompatibilityStatus {
  if (committedVersion === currentVersion) return "compatible";
  if (!rule) return "incompatible";
  if (rule.impact === "none") return "quality-improvement-available";
  if (rule.impact === "breaking") return "incompatible";
  if (
    rule.impact === "reparse-raw-response" ||
    rule.impact === "revalidate-evidence" ||
    rule.impact === "rerun-deterministic-stage" ||
    rule.impact === "recompile"
  ) {
    return "quality-improvement-available";
  }
  return "incompatible";
}

export function refreshAvailabilityForComponentCompatibility(
  status: NarrativeComponentCompatibilityStatus,
): NarrativeRefreshAvailability {
  switch (status) {
    case "compatible":
      return "current";
    case "quality-improvement-available":
      return "quality-refresh-available";
    case "incompatible":
      return "compatibility-refresh-required";
  }
}
