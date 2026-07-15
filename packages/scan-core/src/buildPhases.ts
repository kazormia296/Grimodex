import { SCAN_LIMITS, type ScanEntity, type ScanPhase } from "@grimodex/scan-contract";
import { deterministicUuid, normalizeName } from "./mergeUtils.js";
import type { PhaseBuildResult, PhaseExtractionCandidate } from "./types.js";

export function buildPhases(
  candidates: readonly PhaseExtractionCandidate[],
  entities: readonly ScanEntity[],
): PhaseBuildResult {
  if (candidates.length > SCAN_LIMITS.maxMergeCandidates) {
    throw new RangeError("too many phase candidates to merge");
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
  const phases: ScanPhase[] = [];
  const unresolved: PhaseExtractionCandidate[] = [];
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
    const anchors = candidate.anchors.filter(
      (anchor, index, all) =>
        all.findIndex(
          (item) => item.sectionId === anchor.sectionId && item.paragraphId === anchor.paragraphId,
        ) === index,
    ).sort((left, right) =>
      left.sectionId.localeCompare(right.sectionId) ||
      left.paragraphId.localeCompare(right.paragraphId) ||
      (left.sentenceIndex ?? -1) - (right.sentenceIndex ?? -1),
    );
    const stableEntityIds = [...entityIds].sort();
    const key = `${normalizeName(candidate.title)}:${stableEntityIds.join(",")}:${anchors.map((anchor) => `${anchor.sectionId}:${anchor.paragraphId}`).join(",")}`;
    phases.push({
      id: `phase:${deterministicUuid(key)}`,
      title: candidate.title.trim(),
      entityIds: stableEntityIds,
      anchors,
      summary: candidate.summary?.trim(),
      confidence: candidate.confidence,
    });
  }
  phases.sort((left, right) => left.id.localeCompare(right.id));
  return { phases, unresolved };
}
