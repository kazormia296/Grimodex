import { SCAN_LIMITS, type ScanEntity, type ScanEvent } from "@grimodex/scan-contract";
import { deterministicUuid, dedupeEvidence, normalizeName } from "./mergeUtils.js";
import type { EventExtractionCandidate, EventMergeResult } from "./types.js";

export function mergeEvents(
  candidates: readonly EventExtractionCandidate[],
  entities: readonly ScanEntity[],
): EventMergeResult {
  if (candidates.length > SCAN_LIMITS.maxMergeCandidates) {
    throw new RangeError("too many event candidates to merge");
  }
  const byName = new Map<string, ScanEntity[]>();
  entities.forEach((entity) => {
    for (const name of [entity.name, ...entity.aliases]) {
      const key = normalizeName(name);
      const matches = byName.get(key) ?? [];
      matches.push(entity);
      byName.set(key, matches);
    }
  });
  const eventsByKey = new Map<string, ScanEvent>();
  const unresolved: EventExtractionCandidate[] = [];
  for (const candidate of candidates) {
    const entityIds: string[] = [];
    let failed = false;
    for (const entityName of candidate.entityNames) {
      const matches = byName.get(normalizeName(entityName)) ?? [];
      if (matches.length !== 1 || !matches[0]) {
        failed = true;
        break;
      }
      if (!entityIds.includes(matches[0].id)) entityIds.push(matches[0].id);
    }
    if (failed) {
      unresolved.push(candidate);
      continue;
    }
    const paragraphIds = [...new Set(candidate.paragraphIds)].sort((left, right) => left.localeCompare(right));
    const key = `${candidate.sectionId}:${paragraphIds.join(",")}:${normalizeName(candidate.title)}`;
    const existing = eventsByKey.get(key);
    if (existing) {
      existing.evidence = dedupeEvidence([...existing.evidence, ...candidate.evidence]);
      existing.entityIds = [...new Set([...existing.entityIds, ...entityIds])].sort();
      existing.order = Math.min(existing.order, candidate.order);
      if (!existing.summary && candidate.summary) existing.summary = candidate.summary.trim();
      continue;
    }
    eventsByKey.set(key, {
      id: `event:${deterministicUuid(key)}`,
      title: candidate.title.trim(),
      summary: candidate.summary?.trim(),
      sectionId: candidate.sectionId,
      paragraphIds,
      entityIds: [...entityIds].sort(),
      order: candidate.order,
      evidence: dedupeEvidence(candidate.evidence),
    });
  }
  return {
    events: [...eventsByKey.values()].sort(
      (left, right) => left.order - right.order || left.id.localeCompare(right.id),
    ),
    unresolved,
  };
}
