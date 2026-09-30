import type { EventPrecision } from "@/db/schema";
import { digestStableJson } from "@/features/narrative-extraction/source/digest";
import type {
  AbsoluteWindowConstraint,
  DurationConstraint,
  TemporalConstraintAuthority,
} from "@/features/narrative-extraction/temporal/constraints";
import type {
  NarrativeEventId,
  TemporalNode,
} from "@/features/narrative-extraction/temporal/nodes";
import type {
  AdapterCalendarIdentity,
  TemporalDomainAdapterResult,
} from "./adapterTypes";
import {
  eventNodeId,
  invalidAdapterInputDiagnostic,
  invalidRowDiagnostic,
  isNonEmpty,
  isValidAdapterCalendarIdentity,
  isValidVersion,
  projectMismatchDiagnostic,
  sealAdapterResult,
  snapshotAdapterInput,
} from "./adapterTypes";
import {
  endpointPrecedes,
  makeAbsoluteConstraint,
  makeNode,
  semanticFingerprint,
  type DomainTemporalEndpoint,
  validateDomainEndpoint,
  validatePrecision,
} from "./domainAdapterHelpers";
import {
  classifyTemporalProjection,
  findTemporalProjectionRecord,
  type TemporalProjectionRecord,
} from "./projectionAdapter";

export interface EventTemporalDomainRow {
  readonly projectId: string;
  readonly eventId: string;
  readonly narrativeEventId: NarrativeEventId;
  /** Chronicle display order only. Deliberately excluded from adapter output. */
  readonly ordinal: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly startTime: number | null;
  readonly startMinute: number | null;
  readonly startGranularity: string;
  readonly endTime: number | null;
  readonly endMinute: number | null;
  readonly endGranularity: string;
  readonly precision: string;
}

export interface EventTemporalProjectionContext {
  readonly records: readonly TemporalProjectionRecord[];
  readonly constraintSetDigest: `sha256:${string}`;
  readonly solverVersion: string;
}

export interface AdaptEventTemporalRowsInput {
  readonly projectId: string;
  readonly calendar: AdapterCalendarIdentity | null;
  readonly rows: readonly EventTemporalDomainRow[];
  readonly projection?: EventTemporalProjectionContext;
}

type EventDomainConstraint = AbsoluteWindowConstraint | DurationConstraint;

function endpoints(row: EventTemporalDomainRow): {
  start: DomainTemporalEndpoint;
  end: DomainTemporalEndpoint;
} {
  return {
    start: {
      day: row.startTime,
      minute: row.startMinute,
      granularity: row.startGranularity,
    },
    end: {
      day: row.endTime,
      minute: row.endMinute,
      granularity: row.endGranularity,
    },
  };
}

function invalidEventReason(
  row: EventTemporalDomainRow,
  start: DomainTemporalEndpoint,
  end: DomainTemporalEndpoint,
  calendar: AdapterCalendarIdentity | null,
): string | null {
  if (
    !isNonEmpty(row.eventId) ||
    !isNonEmpty(row.narrativeEventId) ||
    !isValidVersion(row.version) ||
    !isNonEmpty(row.updatedAt)
  ) {
    return "identity or freshness metadata is missing";
  }
  const startError = validateDomainEndpoint(start);
  if (startError !== null) return `invalid start: ${startError}`;
  const endError = validateDomainEndpoint(end);
  if (endError !== null) return `invalid end: ${endError}`;
  if (!validatePrecision(row.precision)) return "invalid precision";
  if (end.granularity !== "none" && start.granularity === "none") {
    return "an interval end requires a start";
  }
  if (
    end.granularity !== "none" &&
    !endpointPrecedes(start, end) &&
    (start.day !== end.day || start.minute !== end.minute)
  ) {
    return "interval end precedes start";
  }
  if (
    start.granularity !== "none" &&
    !isValidAdapterCalendarIdentity(calendar)
  ) {
    return "dated metadata requires a sealed Calendar snapshot";
  }
  return null;
}

function durationFor(
  start: DomainTemporalEndpoint,
  end: DomainTemporalEndpoint,
): DurationConstraint["duration"] {
  const dayDelta = (end.day as number) - (start.day as number);
  if (start.granularity === "time" && end.granularity === "time") {
    const minuteDelta =
      dayDelta * 1440 + (end.minute as number) - (start.minute as number);
    return { min: minuteDelta, max: minuteDelta, unit: "minute" };
  }
  return { min: dayDelta, max: dayDelta, unit: "day" };
}

async function makeDurationConstraint(input: {
  readonly eventId: string;
  readonly nodeId: `tn:${string}`;
  readonly start: DomainTemporalEndpoint;
  readonly end: DomainTemporalEndpoint;
}): Promise<DurationConstraint> {
  const withoutFingerprint: Omit<DurationConstraint, "fingerprint"> = {
    id: `virtual:event:${encodeURIComponent(input.eventId)}:duration`,
    kind: "duration",
    nodeId: input.nodeId,
    duration: durationFor(input.start, input.end),
    authority: "deterministic-derived",
    strictness: "hard",
    sourceIds: [],
  };
  return {
    ...withoutFingerprint,
    fingerprint: await semanticFingerprint(withoutFingerprint),
  };
}

async function projectionAuthority(input: {
  readonly projectId: string;
  readonly row: EventTemporalDomainRow;
  readonly start: DomainTemporalEndpoint;
  readonly end: DomainTemporalEndpoint;
  readonly calendar: AdapterCalendarIdentity | null;
  readonly projection?: EventTemporalProjectionContext;
}): Promise<{
  authority: Extract<
    TemporalConstraintAuthority,
    "user-metadata" | "projection-derived"
  >;
  folded: boolean;
  diagnostic: ReturnType<typeof classifyTemporalProjection>["diagnostic"];
}> {
  if (!input.projection) {
    return { authority: "user-metadata", folded: false, diagnostic: null };
  }
  const target = { kind: "event-time" as const, eventId: input.row.eventId };
  return classifyTemporalProjection({
    current: {
      projectId: input.projectId,
      target,
      resultVersion: input.row.version,
      valueDigest: await digestStableJson({
        start: input.start,
        end: input.end,
        precision: input.row.precision,
      }),
      constraintSetDigest: input.projection.constraintSetDigest,
      solverVersion: input.projection.solverVersion,
      calendarDigest: input.calendar?.calendarDigest ?? null,
    },
    record: findTemporalProjectionRecord(input.projection.records, target),
  });
}

export async function adaptEventTemporalRows(
  input: AdaptEventTemporalRowsInput,
): Promise<TemporalDomainAdapterResult<EventDomainConstraint>> {
  const snapshot = snapshotAdapterInput(input);
  if (snapshot === null) {
    return sealAdapterResult({
      nodes: [],
      constraints: [],
      freshness: [],
      diagnostics: [invalidAdapterInputDiagnostic()],
    });
  }
  const nodes: TemporalNode[] = [];
  const constraints: EventDomainConstraint[] = [];
  const freshness: TemporalDomainAdapterResult["freshness"][number][] = [];
  const diagnostics: TemporalDomainAdapterResult["diagnostics"][number][] = [];

  for (const row of snapshot.rows) {
    if (row.projectId !== snapshot.projectId) {
      diagnostics.push(projectMismatchDiagnostic("Event", row.eventId));
      continue;
    }
    const { start, end } = endpoints(row);
    const invalidReason = invalidEventReason(
      row,
      start,
      end,
      snapshot.calendar,
    );
    if (invalidReason !== null) {
      diagnostics.push(
        invalidRowDiagnostic("Event", row.eventId, invalidReason),
      );
      continue;
    }

    const nodeId = eventNodeId(row.eventId);
    const hasStart = start.granularity !== "none";
    const hasEnd = end.granularity !== "none";
    nodes.push(
      await makeNode({
        id: nodeId,
        timeline: { kind: "primary" },
        subject: { kind: "event", eventId: row.narrativeEventId },
        shape: hasEnd ? "interval" : hasStart ? "point" : "unknown",
        discoursePositions: [],
      }),
    );
    freshness.push({
      kind: "event",
      id: row.eventId,
      version: row.version,
      updatedAt: row.updatedAt,
    });
    if (!hasStart) continue;

    const projection = await projectionAuthority({
      projectId: snapshot.projectId,
      row,
      start,
      end,
      calendar: snapshot.calendar,
      projection: snapshot.projection,
    });
    if (projection.diagnostic) diagnostics.push(projection.diagnostic);
    if (projection.folded) continue;

    const precision = row.precision as EventPrecision;
    constraints.push(
      await makeAbsoluteConstraint({
        id: `virtual:event:${encodeURIComponent(row.eventId)}:start`,
        nodeId,
        endpoint: hasEnd ? "start" : "point",
        value: start,
        precision,
        calendar: snapshot.calendar as AdapterCalendarIdentity,
        authority: projection.authority,
      }),
    );
    if (hasEnd) {
      constraints.push(
        await makeAbsoluteConstraint({
          id: `virtual:event:${encodeURIComponent(row.eventId)}:end`,
          nodeId,
          endpoint: "end",
          value: end,
          precision,
          calendar: snapshot.calendar as AdapterCalendarIdentity,
          authority: projection.authority,
        }),
      );
      if (
        row.precision === "exact" &&
        start.granularity === end.granularity &&
        (start.granularity === "day" || start.granularity === "time")
      ) {
        constraints.push(
          await makeDurationConstraint({
            eventId: row.eventId,
            nodeId,
            start,
            end,
          }),
        );
      }
    }
  }

  return sealAdapterResult({ nodes, constraints, freshness, diagnostics });
}
