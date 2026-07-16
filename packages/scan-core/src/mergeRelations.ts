import { SCAN_LIMITS, type ScanEntity, type ScanRelation } from "@grimodex/scan-contract";
import { deterministicUuid, dedupeEvidence, normalizeName } from "./mergeUtils.js";
import type {
  RelationExtractionCandidate,
  RelationMergeResult,
} from "./types.js";

export function mergeRelations(
  candidates: readonly RelationExtractionCandidate[],
  entities: readonly ScanEntity[],
): RelationMergeResult {
  if (candidates.length > SCAN_LIMITS.maxMergeCandidates) {
    throw new RangeError("too many relation candidates to merge");
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
  const relationsByKey = new Map<string, ScanRelation>();
  const unresolved: RelationExtractionCandidate[] = [];
  for (const candidate of candidates) {
    const fromMatches = byName.get(normalizeName(candidate.fromName)) ?? [];
    const toMatches = byName.get(normalizeName(candidate.toName)) ?? [];
    if (fromMatches.length !== 1 || toMatches.length !== 1) {
      unresolved.push(candidate);
      continue;
    }
    const from = fromMatches[0];
    const to = toMatches[0];
    if (!from || !to) {
      unresolved.push(candidate);
      continue;
    }
    const type = normalizeName(candidate.type);
    const key = `${from.id}:${to.id}:${type}`;
    const existing = relationsByKey.get(key);
    if (existing) {
      existing.evidence = dedupeEvidence([...existing.evidence, ...candidate.evidence]);
      existing.confidence = Math.max(existing.confidence, candidate.confidence);
      if (!existing.label && candidate.label) existing.label = candidate.label;
      continue;
    }
    relationsByKey.set(key, {
      id: `relation:${deterministicUuid(key)}`,
      fromEntityId: from.id,
      toEntityId: to.id,
      type: candidate.type,
      label: candidate.label,
      confidence: candidate.confidence,
      evidence: dedupeEvidence(candidate.evidence),
    });
  }
  return { relations: [...relationsByKey.values()], unresolved };
}
