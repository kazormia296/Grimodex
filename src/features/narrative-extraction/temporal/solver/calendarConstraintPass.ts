import type { TemporalConstraint } from "../constraints";
import type { ExtractionCalendarSnapshot } from "@/features/chronicle/calendar/extractionCalendarSnapshot";

export interface CalendarConstraintPassResult {
  readonly expanded: readonly TemporalConstraint[];
  readonly diagnostics: readonly { code: string; message: string }[];
}

/**
 * Expand calendar-arithmetic relative offsets once anchors are resolved.
 * v1 never silently clips invalid month/day targets.
 */
export function calendarConstraintPass(
  constraints: readonly TemporalConstraint[],
  _calendar: ExtractionCalendarSnapshot | null,
  _resolvedEpochByNode: ReadonlyMap<string, number>,
): CalendarConstraintPassResult {
  const diagnostics: { code: string; message: string }[] = [];
  const expanded: TemporalConstraint[] = [];

  for (const constraint of [...constraints].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (
      constraint.kind === "relative-offset" &&
      (constraint.offset.unit === "month" ||
        constraint.offset.unit === "year" ||
        constraint.offset.arithmetic === "calendar")
    ) {
      diagnostics.push({
        code: "calendar-arithmetic-invalid-target",
        message: `Calendar arithmetic for ${constraint.id} requires an anchored review; refusing silent month/day clip`,
      });
      continue;
    }
    expanded.push(constraint);
  }

  return { expanded, diagnostics };
}
