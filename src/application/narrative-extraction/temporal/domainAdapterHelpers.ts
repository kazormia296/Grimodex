import type { EventGranularity, EventPrecision } from "@/db/schema";
import type {
  AbsoluteWindowConstraint,
  TemporalConstraintAuthority,
} from "@/features/narrative-extraction/temporal/constraints";
import type {
  SemanticFingerprint,
  TemporalNode,
  TemporalNodeId,
} from "@/features/narrative-extraction/temporal/nodes";
import type { CalendarResolution } from "@/features/narrative-extraction/temporal/resolution";
import { digestStableJson } from "@/features/narrative-extraction/source/digest";
import type { AdapterCalendarIdentity } from "./adapterTypes";

const GRANULARITIES = new Set<EventGranularity>([
  "none",
  "season",
  "year",
  "month",
  "day",
  "time",
]);
const PRECISIONS = new Set<EventPrecision>(["exact", "approx", "unknown"]);

export interface DomainTemporalEndpoint {
  readonly day: number | null;
  readonly minute: number | null;
  readonly granularity: string;
}

export function validateDomainEndpoint(
  endpoint: DomainTemporalEndpoint,
): string | null {
  if (!GRANULARITIES.has(endpoint.granularity as EventGranularity)) {
    return `unknown granularity '${endpoint.granularity}'`;
  }
  if (endpoint.granularity === "none") {
    return endpoint.day === null && endpoint.minute === null
      ? null
      : "none granularity must not carry a day or minute";
  }
  if (!Number.isSafeInteger(endpoint.day)) {
    return "dated granularity requires an integer day";
  }
  if (endpoint.granularity === "time") {
    return Number.isSafeInteger(endpoint.minute) &&
      endpoint.minute !== null &&
      endpoint.minute >= 0 &&
      endpoint.minute <= 1439
      ? null
      : "time granularity requires a minute from 0 through 1439";
  }
  return endpoint.minute === null
    ? null
    : "non-time granularity must not carry a minute";
}

export function validatePrecision(
  precision: unknown,
): precision is EventPrecision {
  return PRECISIONS.has(precision as EventPrecision);
}

export function endpointPrecedes(
  left: DomainTemporalEndpoint,
  right: DomainTemporalEndpoint,
): boolean {
  if (left.day === null || right.day === null) return false;
  if (left.day !== right.day) return left.day < right.day;
  return (left.minute ?? 0) < (right.minute ?? 0);
}

export async function semanticFingerprint(
  value: unknown,
): Promise<SemanticFingerprint> {
  return digestStableJson(value);
}

export async function makeNode(
  value: Omit<TemporalNode, "fingerprint">,
): Promise<TemporalNode> {
  return {
    ...value,
    fingerprint: await semanticFingerprint({
      timeline: value.timeline,
      subject: value.subject,
    }),
  };
}

function resolution(
  endpoint: DomainTemporalEndpoint,
  precision: EventPrecision,
  calendar: AdapterCalendarIdentity,
): CalendarResolution {
  return {
    calendarRef: calendar.calendarRef,
    calendarDigest: calendar.calendarDigest,
    startDay: endpoint.day as number,
    endDay: endpoint.day as number,
    startMinute: endpoint.minute,
    endMinute: endpoint.minute,
    granularity: endpoint.granularity as Exclude<EventGranularity, "none">,
    precision,
  };
}

export async function makeAbsoluteConstraint(input: {
  readonly id: string;
  readonly nodeId: TemporalNodeId;
  readonly endpoint: "start" | "end" | "point";
  readonly value: DomainTemporalEndpoint;
  readonly precision: EventPrecision;
  readonly calendar: AdapterCalendarIdentity;
  readonly authority: TemporalConstraintAuthority;
}): Promise<AbsoluteWindowConstraint> {
  const withoutFingerprint: Omit<AbsoluteWindowConstraint, "fingerprint"> = {
    id: input.id,
    kind: "absolute-window",
    nodeId: input.nodeId,
    endpoint: input.endpoint,
    literal: null,
    resolved: resolution(input.value, input.precision, input.calendar),
    authority: input.authority,
    strictness: "hard",
    sourceIds: [],
  };
  return {
    ...withoutFingerprint,
    fingerprint: await semanticFingerprint(withoutFingerprint),
  };
}
