import type { EventPrecision } from "@/db/schema";
import { digestStableJson } from "@/features/narrative-extraction/source/digest";
import type {
  AbsoluteWindowConstraint,
  TemporalConstraintAuthority,
} from "@/features/narrative-extraction/temporal/constraints";
import type {
  DocumentRef,
  TemporalNode,
} from "@/features/narrative-extraction/temporal/nodes";
import type {
  AdapterCalendarIdentity,
  TemporalDomainAdapterResult,
} from "./adapterTypes";
import {
  invalidRowDiagnostic,
  invalidAdapterInputDiagnostic,
  isNonEmpty,
  isValidAdapterCalendarIdentity,
  isValidVersion,
  projectMismatchDiagnostic,
  sealAdapterResult,
  sceneNodeId,
  snapshotAdapterInput,
} from "./adapterTypes";
import {
  endpointPrecedes,
  makeAbsoluteConstraint,
  makeNode,
  type DomainTemporalEndpoint,
  validateDomainEndpoint,
  validatePrecision,
} from "./domainAdapterHelpers";
import {
  classifyTemporalProjection,
  findTemporalProjectionRecord,
  type TemporalProjectionRecord,
} from "./projectionAdapter";

export interface SceneTemporalDomainRow {
  readonly projectId: string;
  readonly sceneId: string;
  readonly documentRef: DocumentRef;
  readonly version: number;
  readonly updatedAt: string;
  readonly chronicleStartTime: number | null;
  readonly chronicleStartMinute: number | null;
  readonly chronicleStartGranularity: string;
  readonly chronicleEndTime: number | null;
  readonly chronicleEndMinute: number | null;
  readonly chronicleEndGranularity: string;
  readonly chroniclePrecision: string;
}

export interface SceneTemporalProjectionContext {
  readonly records: readonly TemporalProjectionRecord[];
  readonly constraintSetDigest: `sha256:${string}`;
  readonly solverVersion: string;
}

export interface AdaptSceneTemporalRowsInput {
  readonly projectId: string;
  readonly calendar: AdapterCalendarIdentity | null;
  readonly rows: readonly SceneTemporalDomainRow[];
  readonly projection?: SceneTemporalProjectionContext;
}

function endpoints(row: SceneTemporalDomainRow): {
  start: DomainTemporalEndpoint;
  end: DomainTemporalEndpoint;
} {
  return {
    start: {
      day: row.chronicleStartTime,
      minute: row.chronicleStartMinute,
      granularity: row.chronicleStartGranularity,
    },
    end: {
      day: row.chronicleEndTime,
      minute: row.chronicleEndMinute,
      granularity: row.chronicleEndGranularity,
    },
  };
}

function invalidSceneReason(
  row: SceneTemporalDomainRow,
  start: DomainTemporalEndpoint,
  end: DomainTemporalEndpoint,
  calendar: AdapterCalendarIdentity | null,
): string | null {
  if (
    !isNonEmpty(row.sceneId) ||
    !isNonEmpty(row.documentRef) ||
    !isValidVersion(row.version) ||
    !isNonEmpty(row.updatedAt)
  ) {
    return "identity or freshness metadata is missing";
  }
  const startError = validateDomainEndpoint(start);
  if (startError !== null) return `invalid start: ${startError}`;
  const endError = validateDomainEndpoint(end);
  if (endError !== null) return `invalid end: ${endError}`;
  if (!validatePrecision(row.chroniclePrecision)) return "invalid precision";
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

async function projectionAuthority(input: {
  readonly projectId: string;
  readonly row: SceneTemporalDomainRow;
  readonly start: DomainTemporalEndpoint;
  readonly end: DomainTemporalEndpoint;
  readonly calendar: AdapterCalendarIdentity | null;
  readonly projection?: SceneTemporalProjectionContext;
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
  const target = { kind: "scene-time" as const, sceneId: input.row.sceneId };
  return classifyTemporalProjection({
    current: {
      projectId: input.projectId,
      target,
      resultVersion: input.row.version,
      valueDigest: await digestStableJson({
        start: input.start,
        end: input.end,
        precision: input.row.chroniclePrecision,
      }),
      constraintSetDigest: input.projection.constraintSetDigest,
      solverVersion: input.projection.solverVersion,
      calendarDigest: input.calendar?.calendarDigest ?? null,
    },
    record: findTemporalProjectionRecord(input.projection.records, target),
  });
}

export async function adaptSceneTemporalRows(
  input: AdaptSceneTemporalRowsInput,
): Promise<TemporalDomainAdapterResult<AbsoluteWindowConstraint>> {
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
  const constraints: AbsoluteWindowConstraint[] = [];
  const freshness: TemporalDomainAdapterResult["freshness"][number][] = [];
  const diagnostics: TemporalDomainAdapterResult["diagnostics"][number][] = [];

  for (const row of snapshot.rows) {
    if (row.projectId !== snapshot.projectId) {
      diagnostics.push(projectMismatchDiagnostic("Scene", row.sceneId));
      continue;
    }
    const { start, end } = endpoints(row);
    const invalidReason = invalidSceneReason(
      row,
      start,
      end,
      snapshot.calendar,
    );
    if (invalidReason !== null) {
      diagnostics.push(
        invalidRowDiagnostic("Scene", row.sceneId, invalidReason),
      );
      continue;
    }

    const nodeId = sceneNodeId(row.sceneId);
    const hasStart = start.granularity !== "none";
    const hasEnd = end.granularity !== "none";
    nodes.push(
      await makeNode({
        id: nodeId,
        timeline: { kind: "primary" },
        subject: { kind: "scene", documentRef: row.documentRef },
        shape: hasEnd ? "interval" : hasStart ? "point" : "unknown",
        discoursePositions: [],
      }),
    );
    freshness.push({
      kind: "scene",
      id: row.sceneId,
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

    const precision = row.chroniclePrecision as EventPrecision;
    constraints.push(
      await makeAbsoluteConstraint({
        id: `virtual:scene:${encodeURIComponent(row.sceneId)}:start`,
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
          id: `virtual:scene:${encodeURIComponent(row.sceneId)}:end`,
          nodeId,
          endpoint: "end",
          value: end,
          precision,
          calendar: snapshot.calendar as AdapterCalendarIdentity,
          authority: projection.authority,
        }),
      );
    }
  }

  return sealAdapterResult({ nodes, constraints, freshness, diagnostics });
}
