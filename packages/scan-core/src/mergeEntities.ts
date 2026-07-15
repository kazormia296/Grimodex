import { SCAN_LIMITS, type ScanEntity } from "@grimodex/scan-contract";
import { deterministicUuid, dedupeEvidence, normalizeName } from "./mergeUtils.js";
import type {
  AmbiguityCluster,
  EntityExtractionCandidate,
  EntityMergeResult,
} from "./types.js";

class DisjointSet {
  private readonly parents: number[];

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index);
  }

  find(value: number): number {
    const parent = this.parents[value];
    if (parent === undefined || parent === value) return value;
    const root = this.find(parent);
    this.parents[value] = root;
    return root;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parents[rightRoot] = leftRoot;
  }
}

function namesFor(candidate: EntityExtractionCandidate): string[] {
  return [candidate.name, ...candidate.aliases].map(normalizeName).filter(Boolean);
}

function hasExplicitAlias(left: EntityExtractionCandidate, right: EntityExtractionCandidate): boolean {
  const leftAliases = new Set(left.aliases.map(normalizeName));
  const rightAliases = new Set(right.aliases.map(normalizeName));
  const leftName = normalizeName(left.name);
  const rightName = normalizeName(right.name);
  return leftAliases.has(rightName) || rightAliases.has(leftName) || [...leftAliases].some((item) => rightAliases.has(item));
}

function mergeGroup(
  candidates: readonly EntityExtractionCandidate[],
  indexes: readonly number[],
): ScanEntity {
  const group = indexes
    .map((index) => candidates[index])
    .filter((candidate): candidate is EntityExtractionCandidate => candidate !== undefined)
    .sort(compareCandidates);
  const first = group[0];
  if (!first) throw new Error("cannot merge an empty entity group");
  const canonicalName = group
    .map((candidate) => candidate.name.trim())
    .sort((left, right) => {
      const lengthOrder = left.length - right.length;
      return lengthOrder !== 0 ? lengthOrder : compareText(left, right);
    })[0] ?? first.name.trim();
  const aliases = [...new Set(group.flatMap((candidate) => [candidate.name.trim(), ...candidate.aliases.map((alias) => alias.trim())]))]
    .filter((alias) => normalizeName(alias) !== normalizeName(canonicalName) && alias.length > 0)
    .sort((left, right) => left.localeCompare(right, "ja"));
  const evidence = dedupeEvidence(group.flatMap((candidate) => candidate.evidence));
  const confidence = Math.max(...group.map((candidate) => candidate.confidence));
  const summaries = group.map((candidate) => candidate.summary?.trim()).filter((summary): summary is string => Boolean(summary));
  return {
    id: `entity:${deterministicUuid(`${first.type}:${normalizeName(canonicalName)}`)}`,
    type: first.type,
    name: canonicalName,
    aliases,
    summary: summaries[0],
    evidence,
    confidence,
  };
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "ja", { numeric: false, sensitivity: "variant" });
}

function compareCandidates(left: EntityExtractionCandidate, right: EntityExtractionCandidate): number {
  const leftKey = [
    normalizeName(left.name),
    left.name.trim(),
    [...left.aliases].map(normalizeName).sort().join(","),
    left.summary?.trim() ?? "",
  ].join("\u0000");
  const rightKey = [
    normalizeName(right.name),
    right.name.trim(),
    [...right.aliases].map(normalizeName).sort().join(","),
    right.summary?.trim() ?? "",
  ].join("\u0000");
  return compareText(leftKey, rightKey);
}

export function mergeEntities(candidates: readonly EntityExtractionCandidate[]): EntityMergeResult {
  if (candidates.length > SCAN_LIMITS.maxMergeCandidates) {
    throw new RangeError("too many entity candidates to merge");
  }
  const disjointSet = new DisjointSet(candidates.length);
  const normalizedNames = candidates.map((candidate) => namesFor(candidate));
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      const leftCandidate = candidates[left];
      const rightCandidate = candidates[right];
      if (!leftCandidate || !rightCandidate || leftCandidate.type !== rightCandidate.type) continue;
      const leftNames = new Set(normalizedNames[left]);
      const sharedName = normalizedNames[right]?.some((name) => leftNames.has(name)) ?? false;
      if (sharedName || hasExplicitAlias(leftCandidate, rightCandidate)) disjointSet.union(left, right);
    }
  }

  const groups = new Map<number, number[]>();
  candidates.forEach((_, index) => {
    const root = disjointSet.find(index);
    const group = groups.get(root) ?? [];
    group.push(index);
    groups.set(root, group);
  });

  const entities = [...groups.values()]
    .map((indexes) => mergeGroup(candidates, indexes))
    .sort((left, right) => left.id.localeCompare(right.id));
  const nameToCandidates = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    const name = normalizeName(candidate.name);
    const indexes = nameToCandidates.get(name) ?? [];
    indexes.push(index);
    nameToCandidates.set(name, indexes);
  });
  const ambiguities: AmbiguityCluster[] = [...nameToCandidates.entries()]
    .map(([name, indexes]) => {
      const roots = new Set(indexes.map((index) => disjointSet.find(index)));
      if (roots.size < 2) return null;
      return {
        id: `ambiguity:${stableAmbiguityId(name)}`,
        names: [name],
        candidateIndexes: indexes,
      } satisfies AmbiguityCluster;
    })
    .filter((cluster): cluster is AmbiguityCluster => cluster !== null);

  return { entities, ambiguities };
}

function stableAmbiguityId(name: string): string {
  return deterministicUuid(`ambiguity:${name}`);
}
