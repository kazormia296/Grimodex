import {
  SCAN_LIMITS,
  type ScanEntity,
  type ScanPhase,
} from "@grimodex/scan-contract";
import { deterministicUuid, normalizeName } from "./mergeUtils.js";
import type { PhaseBuildResult, PhaseExtractionCandidate } from "./types.js";

function ordinalFromId(value: string, position: number): number {
  const match = /^(?:section|paragraph):(\d+)(?::(\d+))?:/.exec(value);
  if (!match) return Number.POSITIVE_INFINITY;
  const sectionOrdinal = Number(match[1]);
  const paragraphOrdinal = match[2] === undefined ? 0 : Number(match[2]);
  return sectionOrdinal * 1_000_000 + paragraphOrdinal + position / 1_000_000;
}

function compareAnchors(
  left: { sectionId: string; paragraphId: string; sentenceIndex?: number },
  right: { sectionId: string; paragraphId: string; sentenceIndex?: number },
): number {
  const sectionOrder =
    ordinalFromId(left.sectionId, 0) - ordinalFromId(right.sectionId, 0);
  if (sectionOrder !== 0 && Number.isFinite(sectionOrder)) return sectionOrder;
  const paragraphOrder =
    ordinalFromId(left.paragraphId, 0) - ordinalFromId(right.paragraphId, 0);
  if (paragraphOrder !== 0 && Number.isFinite(paragraphOrder))
    return paragraphOrder;
  return (
    (left.sentenceIndex ?? -1) - (right.sentenceIndex ?? -1) ||
    left.sectionId.localeCompare(right.sectionId) ||
    left.paragraphId.localeCompare(right.paragraphId)
  );
}

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
    const anchors = candidate.anchors
      .filter(
        (anchor, index, all) =>
          all.findIndex(
            (item) =>
              item.sectionId === anchor.sectionId &&
              item.paragraphId === anchor.paragraphId &&
              item.sentenceIndex === anchor.sentenceIndex,
          ) === index,
      )
      .sort(compareAnchors);
    const stableEntityIds = [...entityIds].sort();
    const key = `${normalizeName(candidate.title)}:${stableEntityIds.join(",")}:${anchors.map((anchor) => `${anchor.sectionId}:${anchor.paragraphId}:${anchor.sentenceIndex ?? ""}`).join(",")}`;
    phases.push({
      id: `phase:${deterministicUuid(key)}`,
      title: candidate.title.trim(),
      entityIds: stableEntityIds,
      anchors,
      summary: candidate.summary?.trim(),
      confidence: candidate.confidence,
    });
  }
  phases.sort((left, right) => {
    const leftAnchor = left.anchors[0];
    const rightAnchor = right.anchors[0];
    if (leftAnchor && rightAnchor) {
      const anchorOrder = compareAnchors(leftAnchor, rightAnchor);
      if (anchorOrder !== 0) return anchorOrder;
    } else if (leftAnchor) {
      return -1;
    } else if (rightAnchor) {
      return 1;
    }
    return left.id.localeCompare(right.id);
  });
  return { phases, unresolved };
}
