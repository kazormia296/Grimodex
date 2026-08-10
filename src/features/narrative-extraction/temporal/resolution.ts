import type { Sha256Digest } from "../source/types";

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
