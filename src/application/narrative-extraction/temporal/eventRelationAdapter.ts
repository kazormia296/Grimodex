import type { IntervalRelationConstraint } from "@/features/narrative-extraction/temporal/constraints";
import {
  eventNodeId,
  invalidAdapterInputDiagnostic,
  invalidRowDiagnostic,
  isNonEmpty,
  isValidVersion,
  projectMismatchDiagnostic,
  sealAdapterResult,
  snapshotAdapterInput,
  type TemporalDomainAdapterResult,
} from "./adapterTypes";
import { semanticFingerprint } from "./domainAdapterHelpers";

export interface EventRelationDomainRow {
  readonly projectId: string;
  readonly causeEventId: string;
  readonly effectEventId: string;
  readonly causeVersion: number;
  readonly causeUpdatedAt: string;
  readonly effectVersion: number;
  readonly effectUpdatedAt: string;
}

export interface EventRelationAdapterInput {
  readonly projectId: string;
  readonly rows: readonly EventRelationDomainRow[];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function relationId(row: EventRelationDomainRow): string {
  return `event-relation:${encodeURIComponent(row.causeEventId)}:${encodeURIComponent(row.effectEventId)}`;
}

function diagnosticRelationId(row: EventRelationDomainRow): string {
  return `${row.causeEventId} -> ${row.effectEventId}`;
}

function validateRow(row: EventRelationDomainRow): string | null {
  if (!isNonEmpty(row.causeEventId) || !isNonEmpty(row.effectEventId)) {
    return "event id is empty";
  }
  if (row.causeEventId === row.effectEventId) return "self relation is invalid";
  if (!isValidVersion(row.causeVersion) || !isValidVersion(row.effectVersion)) {
    return "endpoint version is invalid";
  }
  if (!isNonEmpty(row.causeUpdatedAt) || !isNonEmpty(row.effectUpdatedAt)) {
    return "endpoint updatedAt is empty";
  }
  return null;
}

async function makeRelation(
  row: EventRelationDomainRow,
): Promise<IntervalRelationConstraint> {
  const withoutFingerprint: Omit<IntervalRelationConstraint, "fingerprint"> = {
    id: `domain:event-relation:${encodeURIComponent(row.causeEventId)}:before-or-equal:${encodeURIComponent(row.effectEventId)}`,
    kind: "interval-relation",
    leftNodeId: eventNodeId(row.causeEventId),
    relation: "before-or-equal",
    rightNodeId: eventNodeId(row.effectEventId),
    authority: "existing-domain-relation",
    strictness: "hard",
    sourceIds: [],
  };
  return {
    ...withoutFingerprint,
    fingerprint: await semanticFingerprint(withoutFingerprint),
  };
}

/** Reads persisted cause/effect links without mutating either domain object. */
export async function adaptEventRelationRows(
  input: EventRelationAdapterInput,
): Promise<TemporalDomainAdapterResult<IntervalRelationConstraint>> {
  const snapshot = snapshotAdapterInput(input);
  if (snapshot === null) {
    return sealAdapterResult({
      nodes: [],
      constraints: [],
      freshness: [],
      diagnostics: [invalidAdapterInputDiagnostic()],
    });
  }
  const diagnostics: TemporalDomainAdapterResult["diagnostics"][number][] = [];
  const validRows: EventRelationDomainRow[] = [];
  const seen = new Set<string>();

  for (const row of snapshot.rows) {
    const diagnosticId = diagnosticRelationId(row);
    if (row.projectId !== snapshot.projectId) {
      diagnostics.push(
        projectMismatchDiagnostic("Event relation", diagnosticId),
      );
      continue;
    }
    const invalidReason = validateRow(row);
    if (invalidReason !== null) {
      diagnostics.push(
        invalidRowDiagnostic("Event relation", diagnosticId, invalidReason),
      );
      continue;
    }
    const id = relationId(row);
    if (seen.has(id)) {
      diagnostics.push(
        invalidRowDiagnostic("Event relation", id, "duplicate relation"),
      );
      continue;
    }
    seen.add(id);
    validRows.push(row);
  }

  validRows.sort(
    (left, right) =>
      compareStrings(left.causeEventId, right.causeEventId) ||
      compareStrings(left.effectEventId, right.effectEventId),
  );

  const constraints: IntervalRelationConstraint[] = [];
  const freshness: TemporalDomainAdapterResult["freshness"][number][] = [];
  for (const row of validRows) {
    constraints.push(await makeRelation(row));
    freshness.push({
      kind: "event-relation",
      id: relationId(row),
      endpointVersions: [
        {
          eventId: row.causeEventId,
          version: row.causeVersion,
          updatedAt: row.causeUpdatedAt,
        },
        {
          eventId: row.effectEventId,
          version: row.effectVersion,
          updatedAt: row.effectUpdatedAt,
        },
      ],
    });
  }

  return sealAdapterResult({
    nodes: [],
    constraints,
    freshness,
    diagnostics,
  });
}
