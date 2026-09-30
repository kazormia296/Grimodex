import type { IntervalRelationConstraint } from "@/features/narrative-extraction/temporal/constraints";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import {
  invalidRowDiagnostic,
  invalidAdapterInputDiagnostic,
  isNonEmpty,
  isValidVersion,
  projectMismatchDiagnostic,
  sealAdapterResult,
  sceneNodeId,
  snapshotAdapterInput,
  type TemporalDomainAdapterResult,
} from "./adapterTypes";
import { semanticFingerprint } from "./domainAdapterHelpers";

export interface StoryOrderDomainRow {
  readonly projectId: string;
  readonly sceneId: string;
  readonly storyTimeOrder: string | null;
  readonly version: number;
  readonly updatedAt: string;
}

export interface StoryOrderAdapterInput {
  readonly projectId: string;
  readonly rows: readonly StoryOrderDomainRow[];
}

interface OrderedStoryRow extends StoryOrderDomainRow {
  readonly storyTimeOrder: string;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateRow(row: StoryOrderDomainRow): string | null {
  if (!isNonEmpty(row.sceneId)) return "scene id is empty";
  if (!isValidVersion(row.version)) return "version is invalid";
  if (!isNonEmpty(row.updatedAt)) return "updatedAt is empty";
  if (
    row.storyTimeOrder !== null &&
    row.storyTimeOrder.trim().length > 0 &&
    !isNonEmpty(row.storyTimeOrder)
  ) {
    return "story-time order is invalid";
  }
  return null;
}

function partitionBuckets(
  rows: readonly OrderedStoryRow[],
): OrderedStoryRow[][] {
  const buckets: OrderedStoryRow[][] = [];
  for (const row of rows) {
    const bucket = buckets.at(-1);
    if (
      bucket === undefined ||
      cmpKeys(bucket[0].storyTimeOrder, row.storyTimeOrder) !== 0
    ) {
      buckets.push([row]);
    } else {
      bucket.push(row);
    }
  }
  return buckets;
}

async function makeRelation(
  leftSceneId: string,
  rightSceneId: string,
): Promise<IntervalRelationConstraint> {
  const withoutFingerprint: Omit<IntervalRelationConstraint, "fingerprint"> = {
    id: `domain:story-order:${encodeURIComponent(leftSceneId)}:before:${encodeURIComponent(rightSceneId)}`,
    kind: "interval-relation",
    leftNodeId: sceneNodeId(leftSceneId),
    relation: "before",
    rightNodeId: sceneNodeId(rightSceneId),
    authority: "user-metadata",
    strictness: "hard",
    sourceIds: [],
  };
  return {
    ...withoutFingerprint,
    fingerprint: await semanticFingerprint(withoutFingerprint),
  };
}

/**
 * Converts persisted story-order buckets into only the constraints that are
 * explicitly recoverable from those buckets. Equal keys remain incomparable;
 * transitivity is left to the solver instead of materialising O(n²) edges.
 */
export async function adaptStoryOrderRows(
  input: StoryOrderAdapterInput,
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
  const freshness: TemporalDomainAdapterResult["freshness"][number][] = [];
  const orderedRows: OrderedStoryRow[] = [];
  const sceneIds = new Set<string>();

  for (const row of snapshot.rows) {
    if (row.projectId !== snapshot.projectId) {
      diagnostics.push(projectMismatchDiagnostic("Scene", row.sceneId));
      continue;
    }
    const invalidReason = validateRow(row);
    if (invalidReason !== null) {
      diagnostics.push(
        invalidRowDiagnostic("Scene", row.sceneId, invalidReason),
      );
      continue;
    }
    if (sceneIds.has(row.sceneId)) {
      diagnostics.push(
        invalidRowDiagnostic("Scene", row.sceneId, "duplicate story-order row"),
      );
      continue;
    }
    sceneIds.add(row.sceneId);
    freshness.push({
      kind: "scene-story-order",
      id: row.sceneId,
      version: row.version,
      updatedAt: row.updatedAt,
    });
    if (row.storyTimeOrder !== null && isNonEmpty(row.storyTimeOrder)) {
      orderedRows.push({ ...row, storyTimeOrder: row.storyTimeOrder.trim() });
    }
  }

  orderedRows.sort(
    (left, right) =>
      cmpKeys(left.storyTimeOrder, right.storyTimeOrder) ||
      compareStrings(left.sceneId, right.sceneId),
  );
  freshness.sort((left, right) => compareStrings(left.id, right.id));

  const constraints: IntervalRelationConstraint[] = [];
  const buckets = partitionBuckets(orderedRows);
  for (let index = 0; index + 1 < buckets.length; index += 1) {
    const leftBucket = buckets[index];
    const rightBucket = buckets[index + 1];
    // The v1 IR has only binary relations, so the complete adjacent-bucket
    // Cartesian product is required to preserve meaning. Do not truncate it;
    // a future grouped-relation IR can replace this expansion atomically.
    for (const left of leftBucket) {
      for (const right of rightBucket) {
        constraints.push(await makeRelation(left.sceneId, right.sceneId));
      }
    }
  }

  return sealAdapterResult({
    nodes: [],
    constraints,
    freshness,
    diagnostics,
  });
}
