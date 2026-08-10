import { candidateKey } from "../codexCandidates";
import type {
  EntityClusterManifestEntry,
  KnowledgeEntityRef,
  KnowledgeTypeRef,
} from "@/features/narrative-extraction/ir/inferences/codexEntityHypothesis";
import type {
  EntityIdentityObservation,
  EntityMentionObservation,
  EntityReference,
} from "@/features/narrative-extraction/ir/observations/entityIdentity";
import {
  matchExistingEntity,
  type ExistingEntityCatalogRecord,
} from "./existingEntityMatcher";

export interface DeterministicEntitySeed {
  readonly seedId: string;
  readonly surface: string;
  readonly normalizedSurface: string;
  /** Source View refs that contain at least one occurrence of this seed. */
  readonly sourceRefs: readonly string[];
}

export interface ClusterEntityMentionsInput {
  readonly seeds: readonly DeterministicEntitySeed[];
  readonly mentions: readonly EntityMentionObservation[];
  readonly identities?: readonly EntityIdentityObservation[];
  readonly existingCatalog?: readonly ExistingEntityCatalogRecord[];
  readonly candidateTypeRefs?: readonly KnowledgeTypeRef[];
}

function referentKey(ref: EntityReference): string {
  return ref.kind === "local"
    ? `local:${ref.localId}`
    : `surface:${candidateKey(ref.surface)}`;
}

function mentionSurfaceKey(mention: EntityMentionObservation): string | null {
  if (mention.payload.surface && mention.payload.surface.trim().length > 0) {
    return candidateKey(mention.payload.surface);
  }
  if (mention.payload.referent.kind === "surface") {
    return candidateKey(mention.payload.referent.surface);
  }
  return null;
}

function mentionWindowKeys(mention: EntityMentionObservation): string[] {
  return [...new Set(mention.evidence.map((item) => item.sourceRef))];
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    const parent = this.parent.get(id);
    if (parent === undefined) {
      this.parent.set(id, id);
      return id;
    }
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    // Stable: prefer lexicographically smaller root.
    if (rootA < rootB) this.parent.set(rootB, rootA);
    else this.parent.set(rootA, rootB);
  }

  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      const bucket = out.get(root) ?? [];
      bucket.push(id);
      out.set(root, bucket);
    }
    return out;
  }
}

/**
 * Deterministic Entity Cluster builder.
 * Blocks by normalized surface / window / existing-entry candidate —
 * not a full O(N²) pairwise pass.
 */
export function clusterEntityMentions(
  input: ClusterEntityMentionsInput,
): readonly EntityClusterManifestEntry[] {
  const uf = new UnionFind();
  const mentionById = new Map<string, EntityMentionObservation>();
  const seedById = new Map<string, DeterministicEntitySeed>();

  // Surface block: same normalized surface → same cluster bucket key.
  const surfaceBlocks = new Map<string, string[]>();
  // Window block: mentions that share a sourceRef.
  const windowBlocks = new Map<string, string[]>();

  for (const seed of input.seeds) {
    seedById.set(seed.seedId, seed);
    const nodeId = `seed:${seed.seedId}`;
    uf.add(nodeId);
    const key = seed.normalizedSurface || candidateKey(seed.surface);
    if (!key) continue;
    const bucket = surfaceBlocks.get(key) ?? [];
    bucket.push(nodeId);
    surfaceBlocks.set(key, bucket);
    for (const sourceRef of seed.sourceRefs) {
      const windowBucket = windowBlocks.get(sourceRef) ?? [];
      windowBucket.push(nodeId);
      windowBlocks.set(sourceRef, windowBucket);
    }
  }

  for (const mention of input.mentions) {
    mentionById.set(mention.localId, mention);
    const nodeId = `mention:${mention.localId}`;
    uf.add(nodeId);
    const surfaceKey = mentionSurfaceKey(mention);
    if (surfaceKey) {
      const bucket = surfaceBlocks.get(surfaceKey) ?? [];
      bucket.push(nodeId);
      surfaceBlocks.set(surfaceKey, bucket);
    }
    for (const sourceRef of mentionWindowKeys(mention)) {
      const windowBucket = windowBlocks.get(sourceRef) ?? [];
      windowBucket.push(nodeId);
      windowBlocks.set(sourceRef, windowBucket);
    }
    // Referent block: same local referent.
    const refKey = referentKey(mention.payload.referent);
    const refBucket = surfaceBlocks.get(`ref:${refKey}`) ?? [];
    refBucket.push(nodeId);
    surfaceBlocks.set(`ref:${refKey}`, refBucket);
  }

  for (const bucket of surfaceBlocks.values()) {
    for (let i = 1; i < bucket.length; i++) {
      uf.union(bucket[0]!, bucket[i]!);
    }
  }

  // Window block only merges pronoun/implicit mentions into nearby named
  // surfaces in the same Source View — still O(mentions per window).
  for (const bucket of windowBlocks.values()) {
    const named = bucket.filter((id) => {
      if (!id.startsWith("mention:")) return true;
      const mention = mentionById.get(id.slice("mention:".length));
      if (!mention) return false;
      return (
        mention.payload.mentionForm !== "pronoun" &&
        mention.payload.mentionForm !== "implicit"
      );
    });
    const pronouns = bucket.filter((id) => {
      if (!id.startsWith("mention:")) return false;
      const mention = mentionById.get(id.slice("mention:".length));
      return (
        mention?.payload.mentionForm === "pronoun" ||
        mention?.payload.mentionForm === "implicit"
      );
    });
    if (named.length === 1) {
      for (const pronoun of pronouns) {
        uf.union(named[0]!, pronoun);
      }
    }
  }

  // Explicit same-as identity merges (bounded by observation count).
  for (const identity of input.identities ?? []) {
    uf.add(`identity:${identity.localId}`);
    const subject = identity.payload.subject;
    if (identity.payload.identity.kind !== "same-as") {
      // alias / renamed-to attach to subject surface/local block.
      if (subject.kind === "local" && mentionById.has(subject.localId)) {
        uf.union(`mention:${subject.localId}`, `identity:${identity.localId}`);
      }
      continue;
    }
    const other = identity.payload.identity.other;
    const left =
      subject.kind === "local" && mentionById.has(subject.localId)
        ? `mention:${subject.localId}`
        : null;
    const right =
      other.kind === "local" && mentionById.has(other.localId)
        ? `mention:${other.localId}`
        : null;
    if (left) uf.union(left, `identity:${identity.localId}`);
    if (right) uf.union(right, `identity:${identity.localId}`);
    if (left && right) uf.union(left, right);
  }

  const groups = uf.groups();
  const clusters: EntityClusterManifestEntry[] = [];
  let index = 0;

  for (const members of groups.values()) {
    const mentionObservationIds = members
      .filter((id) => id.startsWith("mention:"))
      .map((id) => id.slice("mention:".length))
      .sort();
    const identityObservationIds = members
      .filter((id) => id.startsWith("identity:"))
      .map((id) => id.slice("identity:".length))
      .sort();
    const deterministicSeedIds = members
      .filter((id) => id.startsWith("seed:"))
      .map((id) => id.slice("seed:".length))
      .sort();

    // Skip empty / identity-only orphans.
    if (mentionObservationIds.length === 0 && deterministicSeedIds.length === 0) {
      continue;
    }

    const surfaces: string[] = [];
    for (const seedId of deterministicSeedIds) {
      const seed = seedById.get(seedId);
      if (seed) surfaces.push(seed.surface);
    }
    for (const mentionId of mentionObservationIds) {
      const mention = mentionById.get(mentionId);
      if (mention?.payload.surface) surfaces.push(mention.payload.surface);
    }

    let candidateExistingRefs: KnowledgeEntityRef[] = [];
    if (input.existingCatalog && surfaces.length > 0) {
      const match = matchExistingEntity(
        { surfaces },
        input.existingCatalog,
      );
      if (match.status === "resolved") {
        candidateExistingRefs = [match.ref];
      } else if (match.status === "ambiguous") {
        candidateExistingRefs = match.candidates.map((candidate) => candidate.ref);
      }
    }

    clusters.push({
      clusterId: `entity-cluster-${String(++index).padStart(4, "0")}`,
      mentionObservationIds,
      identityObservationIds,
      deterministicSeedIds,
      candidateExistingRefs,
      candidateTypeRefs: input.candidateTypeRefs ?? [],
    });
  }

  return clusters.sort((a, b) => a.clusterId.localeCompare(b.clusterId));
}
