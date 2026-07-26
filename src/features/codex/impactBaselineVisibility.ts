import { db } from "@/db/client";
import { impactReviewBaselines } from "@/db/schema";
import { and, eq } from "drizzle-orm";

interface ImpactBaselineMetadata {
  phases?: Array<{ phaseId?: unknown }>;
  visibilityProvenanceVersion?: unknown;
  allPhaseIds?: unknown;
  restrictedPhaseIds?: unknown;
  visibleDeletedPhaseIds?: unknown;
  [key: string]: unknown;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (candidate): candidate is string =>
          typeof candidate === "string" && candidate.length > 0,
      )
    : [];
}

async function updateBaselineMetadata(
  entryId: string,
  mutate: (snapshot: ImpactBaselineMetadata) => boolean,
): Promise<void> {
  // Metadata writes can race with a completed review. Retry against the row's
  // content hash so a stale visibility write never overwrites a newer baseline.
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows = await db
      .select({
        snapshotJson: impactReviewBaselines.snapshotJson,
        contentHash: impactReviewBaselines.contentHash,
      })
      .from(impactReviewBaselines)
      .where(eq(impactReviewBaselines.entryId, entryId));
    const row = rows[0];
    if (!row) return;

    let snapshot: ImpactBaselineMetadata;
    try {
      snapshot = JSON.parse(row.snapshotJson) as ImpactBaselineMetadata;
    } catch {
      // An unreadable baseline is already treated as absent by Impact Review.
      return;
    }
    if (!mutate(snapshot)) return;

    const snapshotJson = stableStringify(snapshot);
    const updated = await db
      .update(impactReviewBaselines)
      .set({ snapshotJson, contentHash: stableHash(snapshotJson) })
      .where(
        and(
          eq(impactReviewBaselines.entryId, entryId),
          eq(impactReviewBaselines.contentHash, row.contentHash),
        ),
      )
      .returning({ entryId: impactReviewBaselines.entryId });
    if (updated.length > 0) return;
  }
  throw new Error("Impact baseline visibility metadata changed concurrently");
}

/**
 * A newly hidden/suppressed (or inherited/unknown) phase can affect every
 * later phase. Mark every baseline phase fail-closed before the mutation.
 */
export async function markImpactBaselinePhasesRestricted(
  entryId: string,
): Promise<void> {
  await updateBaselineMetadata(entryId, (snapshot) => {
    const phaseIds = new Set([
      ...stringIds(snapshot.allPhaseIds),
      ...(snapshot.phases ?? []).flatMap((phase) =>
        typeof phase.phaseId === "string" && phase.phaseId.length > 0
          ? [phase.phaseId]
          : [],
      ),
    ]);
    if (phaseIds.size === 0) return false;

    const restricted = new Set(stringIds(snapshot.restrictedPhaseIds));
    const visibleDeleted = new Set(stringIds(snapshot.visibleDeletedPhaseIds));
    let changed = false;
    for (const phaseId of phaseIds) {
      if (!restricted.has(phaseId)) {
        restricted.add(phaseId);
        changed = true;
      }
      if (visibleDeleted.delete(phaseId)) changed = true;
    }
    if (!changed) return false;
    snapshot.restrictedPhaseIds = [...restricted].sort();
    snapshot.visibleDeletedPhaseIds = [...visibleDeleted].sort();
    return true;
  });
}

/** An explicitly visible phase releases its own prior fail-closed marker. */
export async function markImpactBaselinePhaseVisible(
  entryId: string,
  phaseId: string,
): Promise<void> {
  await updateBaselineMetadata(entryId, (snapshot) => {
    const restricted = new Set(stringIds(snapshot.restrictedPhaseIds));
    const visibleDeleted = new Set(stringIds(snapshot.visibleDeletedPhaseIds));
    const removedRestriction = restricted.delete(phaseId);
    const removedDeletion = visibleDeleted.delete(phaseId);
    const changed = removedRestriction || removedDeletion;
    if (!changed) return false;
    snapshot.restrictedPhaseIds = [...restricted].sort();
    snapshot.visibleDeletedPhaseIds = [...visibleDeleted].sort();
    return true;
  });
}

/** Undo/recreate: the phase exists again, so its prior deletion marker is stale. */
export async function clearImpactBaselinePhaseDeletion(
  entryId: string,
  phaseId: string,
): Promise<void> {
  await updateBaselineMetadata(entryId, (snapshot) => {
    const visibleDeleted = new Set(stringIds(snapshot.visibleDeletedPhaseIds));
    if (!visibleDeleted.delete(phaseId)) return false;
    snapshot.visibleDeletedPhaseIds = [...visibleDeleted].sort();
    return true;
  });
}

/**
 * Record a deletion that was observed while the phase was provably visible.
 * A deletion proven globally visible by the writer can override an older
 * conservative marker. Unknown/inherited visibility cannot.
 */
export async function markImpactBaselinePhaseVisibleDeleted(
  entryId: string,
  phaseId: string,
  overrideRestriction: boolean,
): Promise<void> {
  await updateBaselineMetadata(entryId, (snapshot) => {
    // Released baselines may contain Phase bodies captured before visibility
    // was tracked. Never promote those legacy values into a trusted deletion
    // diff, even if the current row happens to be visible at delete time.
    if (
      snapshot.visibilityProvenanceVersion !== 1 ||
      !stringIds(snapshot.allPhaseIds).includes(phaseId)
    ) {
      return false;
    }
    const restricted = new Set(stringIds(snapshot.restrictedPhaseIds));
    const removedRestriction = overrideRestriction
      ? restricted.delete(phaseId)
      : false;
    if (restricted.has(phaseId)) return false;

    const visibleDeleted = new Set(stringIds(snapshot.visibleDeletedPhaseIds));
    const addedDeletion = !visibleDeleted.has(phaseId);
    visibleDeleted.add(phaseId);
    snapshot.restrictedPhaseIds = [...restricted].sort();
    snapshot.visibleDeletedPhaseIds = [...visibleDeleted].sort();
    return removedRestriction || addedDeletion;
  });
}
