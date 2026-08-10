import type { Sha256Digest } from "../source/types";
import type { TemporalConflict } from "./conflict";
import type { TemporalNodeId } from "./nodes";

export type TemporalGranularity = "season" | "year" | "month" | "day" | "time";

export type TemporalPrecision = "exact" | "approx" | "unknown";

/** A canonical Chronicle window sealed to one Calendar Snapshot. */
export interface CalendarResolution {
  readonly calendarRef: string;
  readonly calendarDigest: Sha256Digest;
  readonly startDay: number;
  readonly endDay: number;
  readonly startMinute: number | null;
  readonly endMinute: number | null;
  readonly granularity: TemporalGranularity;
  readonly precision: TemporalPrecision;
}

/** Domain over canonical epoch minutes (nullable = unbounded). */
export interface TemporalVariableDomain {
  readonly earliest: number | null;
  readonly latest: number | null;
}

export type TemporalNodeResolutionKind =
  | "exact"
  | "bounded"
  | "ordered-only"
  | "symbolic"
  | "ambiguous"
  | "contradictory";

export interface ResolvedTemporalNode {
  readonly nodeId: TemporalNodeId;
  readonly resolution: TemporalNodeResolutionKind;
  readonly actualStart: TemporalVariableDomain;
  readonly actualEnd: TemporalVariableDomain | null;
  readonly duration: TemporalVariableDomain | null;
  readonly uncertaintyReason: readonly string[];
  readonly derivationConstraintIds: readonly string[];
}

export interface TemporalSolverResult {
  readonly hardResolution: readonly ResolvedTemporalNode[];
  readonly suggestedResolution: readonly ResolvedTemporalNode[];
  readonly violatedSoftConstraintIds: readonly string[];
  readonly conflicts: readonly TemporalConflict[];
}

export const MINUTES_PER_DAY = 24 * 60;

export function dayToEpochMinute(day: number, minuteOfDay = 0): number {
  return day * MINUTES_PER_DAY + minuteOfDay;
}

export function epochMinuteToDay(minute: number): number {
  return Math.floor(minute / MINUTES_PER_DAY);
}

export function isExactDomain(domain: TemporalVariableDomain): boolean {
  return (
    domain.earliest !== null &&
    domain.latest !== null &&
    domain.earliest === domain.latest
  );
}

export function intersectDomains(
  a: TemporalVariableDomain,
  b: TemporalVariableDomain,
): TemporalVariableDomain | null {
  const earliest =
    a.earliest === null
      ? b.earliest
      : b.earliest === null
        ? a.earliest
        : Math.max(a.earliest, b.earliest);
  const latest =
    a.latest === null
      ? b.latest
      : b.latest === null
        ? a.latest
        : Math.min(a.latest, b.latest);
  if (earliest !== null && latest !== null && earliest > latest) return null;
  return { earliest, latest };
}
