import { isContractTrimmedNonEmptyString } from "@/features/narrative-semantic-core/contracts/contractString";
import { digestStableJson, hasLoneSurrogate } from "./digest";
import { freezeDeep } from "./immutability";
import type { Sha256Digest } from "./types";

export const NARRATIVE_SCOPE_AUTHORITY_BASIS_V2_CONTRACT_ID =
  "narrative-scope-authority-basis/2" as const;
export const NARRATIVE_SCOPE_AUTHORITY_BASIS_V2_SCHEMA_VERSION = 2 as const;
export const NARRATIVE_SCOPE_AUTHORITY_BASIS_V2_KIND =
  "historical-run-snapshot" as const;
export const NARRATIVE_SCOPE_AUTHORITY_SOURCE_KIND =
  "snapshot-document" as const;
export const NARRATIVE_SCOPE_REGISTRY_VERSION = "narrative-scope/2" as const;
export const NARRATIVE_SCOPE_AUTHORITY_RESERVED_AUDIENCE_REFS = [
  "reader",
] as const;

export const NARRATIVE_SCOPE_REGISTRY_REVISION_CONTRACT_ID =
  "narrative-scope-registry-revision/1" as const;
export const NARRATIVE_READING_ORDER_REVISION_CONTRACT_ID =
  "narrative-reading-order-revision/1" as const;
export const NARRATIVE_STORY_TIME_ORDER_REVISION_CONTRACT_ID =
  "narrative-story-time-order-revision/1" as const;
export const NARRATIVE_SCOPE_AUTHORITY_REVISION_CONTRACT_ID =
  "narrative-scope-authority/2" as const;
export const NARRATIVE_SOURCE_SNAPSHOT_REVISION_CONTRACT_ID =
  "narrative-source-snapshot-revision/2" as const;

export interface NarrativeScopeAuthoritySourceV2 {
  readonly sourceKind: typeof NARRATIVE_SCOPE_AUTHORITY_SOURCE_KIND;
  readonly sourceKey: `snapshot:${string}`;
}

export interface NarrativeScopeRegistryV2 {
  readonly registryVersion: typeof NARRATIVE_SCOPE_REGISTRY_VERSION;
  readonly reservedAudienceRefs: readonly ["reader"];
}

export type NarrativeScopeAuthorityStoryTimeOrderV2 =
  | {
      readonly status: "resolved";
      readonly rawStoryKey: string;
      readonly storyRank: number;
    }
  | {
      readonly status: "unresolved";
      readonly reason: "not-provided";
      readonly rawStoryKey: null;
    }
  | {
      readonly status: "unresolved";
      readonly reason: "ambiguous";
      readonly rawStoryKey: string;
    };

export interface NarrativeScopeAuthorityMappingV2 {
  readonly documentRef: string;
  readonly sourceKey: `project:scene:${string}`;
  readonly sceneRef: `scene:${string}`;
  readonly readingOrderRef: `reading:${string}`;
  readonly storyTimeRef: `story:${string}`;
  readonly readingRank: number;
  readonly storyTimeOrder: NarrativeScopeAuthorityStoryTimeOrderV2;
}

export interface NarrativeScopeAuthorityDigestsV2 {
  readonly corpusDigest: Sha256Digest;
  readonly scopeRegistryRevision: Sha256Digest;
  readonly readingOrderRevision: Sha256Digest;
  readonly storyTimeOrderRevision: Sha256Digest;
  readonly authorityDigest: Sha256Digest;
  readonly compositeDigest: Sha256Digest;
}

export interface NarrativeScopeAuthorityBasisContentV2 {
  readonly schemaVersion: typeof NARRATIVE_SCOPE_AUTHORITY_BASIS_V2_SCHEMA_VERSION;
  readonly contractId: typeof NARRATIVE_SCOPE_AUTHORITY_BASIS_V2_CONTRACT_ID;
  readonly basisKind: typeof NARRATIVE_SCOPE_AUTHORITY_BASIS_V2_KIND;
  readonly projectId: string;
  readonly source: NarrativeScopeAuthoritySourceV2;
  readonly scopeRegistry: NarrativeScopeRegistryV2;
  readonly mappings: readonly NarrativeScopeAuthorityMappingV2[];
}

export interface NarrativeScopeAuthorityBasisV2 extends NarrativeScopeAuthorityBasisContentV2 {
  readonly digests: NarrativeScopeAuthorityDigestsV2;
}

export interface NarrativeScopeAuthorityDocumentInputV2 {
  readonly documentRef: string;
  readonly sourceKey: `project:scene:${string}`;
  /** Persisted value exactly as stored; this contract never trims or normalizes it. */
  readonly rawStoryKey: string | null;
}

export interface BuildNarrativeScopeAuthorityBasisV2Input {
  readonly projectId: string;
  readonly runId: string;
  readonly corpusDigest: Sha256Digest;
  /** Snapshot document order is the authoritative reading order. */
  readonly documents: readonly NarrativeScopeAuthorityDocumentInputV2[];
}

export type NarrativeScopeRegistryRevisionInput = {
  readonly contractId: typeof NARRATIVE_SCOPE_REGISTRY_REVISION_CONTRACT_ID;
  readonly projectId: string;
  readonly scopeRegistry: NarrativeScopeRegistryV2;
  readonly mappings: readonly {
    readonly documentRef: string;
    readonly sceneRef: string;
    readonly sourceKey: string;
  }[];
};

export type NarrativeReadingOrderRevisionInput = {
  readonly contractId: typeof NARRATIVE_READING_ORDER_REVISION_CONTRACT_ID;
  readonly projectId: string;
  readonly registryVersion: string;
  readonly mappings: readonly {
    readonly readingOrderRef: string;
    readonly sceneRef: string;
    readonly readingRank: number;
  }[];
};

export type NarrativeStoryTimeOrderRevisionInput = {
  readonly contractId: typeof NARRATIVE_STORY_TIME_ORDER_REVISION_CONTRACT_ID;
  readonly projectId: string;
  readonly registryVersion: string;
  readonly mappings: readonly {
    readonly storyTimeRef: string;
    readonly sceneRef: string;
    readonly storyTimeOrder: NarrativeScopeAuthorityStoryTimeOrderV2;
  }[];
};

export type NarrativeScopeAuthorityDigestInput = {
  readonly contractId: typeof NARRATIVE_SCOPE_AUTHORITY_REVISION_CONTRACT_ID;
  readonly basisKind: typeof NARRATIVE_SCOPE_AUTHORITY_BASIS_V2_KIND;
  readonly projectId: string;
  readonly source: NarrativeScopeAuthoritySourceV2;
  readonly scopeRegistryRevision: Sha256Digest;
  readonly readingOrderRevision: Sha256Digest;
  readonly storyTimeOrderRevision: Sha256Digest;
};

export type NarrativeSourceSnapshotRevisionInput = {
  readonly contractId: typeof NARRATIVE_SOURCE_SNAPSHOT_REVISION_CONTRACT_ID;
  readonly basisKind: typeof NARRATIVE_SCOPE_AUTHORITY_BASIS_V2_KIND;
  readonly projectId: string;
  readonly source: NarrativeScopeAuthoritySourceV2;
  readonly corpusDigest: Sha256Digest;
  readonly authorityDigest: Sha256Digest;
};

export function canonicalScopeRegistryRevisionInput(
  basis: NarrativeScopeAuthorityBasisContentV2,
): NarrativeScopeRegistryRevisionInput {
  return {
    contractId: NARRATIVE_SCOPE_REGISTRY_REVISION_CONTRACT_ID,
    projectId: basis.projectId,
    scopeRegistry: basis.scopeRegistry,
    mappings: [...basis.mappings]
      .sort((left, right) => compareUtf16(left.sceneRef, right.sceneRef))
      .map(({ documentRef, sceneRef, sourceKey }) => ({
        documentRef,
        sceneRef,
        sourceKey,
      })),
  };
}

export function canonicalReadingOrderRevisionInput(
  basis: NarrativeScopeAuthorityBasisContentV2,
): NarrativeReadingOrderRevisionInput {
  return {
    contractId: NARRATIVE_READING_ORDER_REVISION_CONTRACT_ID,
    projectId: basis.projectId,
    registryVersion: basis.scopeRegistry.registryVersion,
    mappings: [...basis.mappings]
      .sort(
        (left, right) =>
          left.readingRank - right.readingRank ||
          compareUtf16(left.sceneRef, right.sceneRef),
      )
      .map(({ readingOrderRef, sceneRef, readingRank }) => ({
        readingOrderRef,
        sceneRef,
        readingRank,
      })),
  };
}

export function canonicalStoryTimeOrderRevisionInput(
  basis: NarrativeScopeAuthorityBasisContentV2,
): NarrativeStoryTimeOrderRevisionInput {
  return {
    contractId: NARRATIVE_STORY_TIME_ORDER_REVISION_CONTRACT_ID,
    projectId: basis.projectId,
    registryVersion: basis.scopeRegistry.registryVersion,
    mappings: [...basis.mappings]
      .sort((left, right) =>
        compareUtf16(left.storyTimeRef, right.storyTimeRef),
      )
      .map(({ storyTimeRef, sceneRef, storyTimeOrder }) => ({
        storyTimeRef,
        sceneRef,
        storyTimeOrder,
      })),
  };
}

export function canonicalScopeAuthorityDigestInput(
  content: NarrativeScopeAuthorityBasisContentV2,
  revisions: Pick<
    NarrativeScopeAuthorityDigestsV2,
    "scopeRegistryRevision" | "readingOrderRevision" | "storyTimeOrderRevision"
  >,
): NarrativeScopeAuthorityDigestInput {
  return {
    contractId: NARRATIVE_SCOPE_AUTHORITY_REVISION_CONTRACT_ID,
    basisKind: content.basisKind,
    projectId: content.projectId,
    source: content.source,
    scopeRegistryRevision: revisions.scopeRegistryRevision,
    readingOrderRevision: revisions.readingOrderRevision,
    storyTimeOrderRevision: revisions.storyTimeOrderRevision,
  };
}

export function canonicalNarrativeSourceSnapshotRevisionInput(
  content: NarrativeScopeAuthorityBasisContentV2,
  digests: Pick<
    NarrativeScopeAuthorityDigestsV2,
    "corpusDigest" | "authorityDigest"
  >,
): NarrativeSourceSnapshotRevisionInput {
  return {
    contractId: NARRATIVE_SOURCE_SNAPSHOT_REVISION_CONTRACT_ID,
    basisKind: content.basisKind,
    projectId: content.projectId,
    source: content.source,
    corpusDigest: digests.corpusDigest,
    authorityDigest: digests.authorityDigest,
  };
}

function compareUtf16(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function snapshotBasisContent(
  basis: NarrativeScopeAuthorityBasisContentV2,
): NarrativeScopeAuthorityBasisContentV2 {
  return {
    schemaVersion: basis.schemaVersion,
    contractId: basis.contractId,
    basisKind: basis.basisKind,
    projectId: basis.projectId,
    source: { ...basis.source },
    scopeRegistry: {
      registryVersion: basis.scopeRegistry.registryVersion,
      reservedAudienceRefs: [basis.scopeRegistry.reservedAudienceRefs[0]],
    },
    mappings: basis.mappings.map((mapping) => ({
      documentRef: mapping.documentRef,
      sourceKey: mapping.sourceKey,
      sceneRef: mapping.sceneRef,
      readingOrderRef: mapping.readingOrderRef,
      storyTimeRef: mapping.storyTimeRef,
      readingRank: mapping.readingRank,
      storyTimeOrder: { ...mapping.storyTimeOrder },
    })),
  };
}

async function computeNarrativeScopeAuthorityBasisDigestsFromContent(
  content: NarrativeScopeAuthorityBasisContentV2,
  corpusDigest: Sha256Digest,
): Promise<NarrativeScopeAuthorityDigestsV2> {
  const scopeRegistryRevision = await digestStableJson(
    canonicalScopeRegistryRevisionInput(content),
  );
  const readingOrderRevision = await digestStableJson(
    canonicalReadingOrderRevisionInput(content),
  );
  const storyTimeOrderRevision = await digestStableJson(
    canonicalStoryTimeOrderRevisionInput(content),
  );
  const authorityDigest = await digestStableJson(
    canonicalScopeAuthorityDigestInput(content, {
      scopeRegistryRevision,
      readingOrderRevision,
      storyTimeOrderRevision,
    }),
  );
  const compositeDigest = await digestStableJson(
    canonicalNarrativeSourceSnapshotRevisionInput(content, {
      corpusDigest,
      authorityDigest,
    }),
  );
  return {
    corpusDigest,
    scopeRegistryRevision,
    readingOrderRevision,
    storyTimeOrderRevision,
    authorityDigest,
    compositeDigest,
  };
}

const SOURCE_KEY_PREFIX = "project:scene:" as const;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function assertContractString(label: string, value: string): void {
  if (!isContractTrimmedNonEmptyString(value) || hasLoneSurrogate(value)) {
    throw new TypeError(`${label} must be a contract string`);
  }
}

/**
 * Build the historical scope/order authority captured by one sealed corpus.
 *
 * This is intentionally a small typed constructor, not a generic JSON
 * validator. The JSON Schema and Native reader remain the untrusted-boundary
 * validators; this function only derives the closed production shape.
 */
export async function buildNarrativeScopeAuthorityBasisV2(
  input: BuildNarrativeScopeAuthorityBasisV2Input,
): Promise<NarrativeScopeAuthorityBasisV2> {
  assertContractString("projectId", input.projectId);
  assertContractString("runId", input.runId);
  if (!SHA256_DIGEST_PATTERN.test(input.corpusDigest)) {
    throw new TypeError("corpusDigest must be a canonical SHA-256 digest");
  }
  if (input.documents.length < 1 || input.documents.length > 999_999) {
    throw new RangeError(
      "scope authority basis requires between 1 and 999999 documents",
    );
  }

  const sourceKeys = new Set<string>();
  const rawStoryKeyCounts = new Map<string, number>();
  const prepared = input.documents.map((document, readingRank) => {
    const expectedDocumentRef = `D${String(readingRank + 1).padStart(6, "0")}`;
    if (document.documentRef !== expectedDocumentRef) {
      throw new TypeError(
        `documentRef at reading rank ${readingRank} must be ${expectedDocumentRef}`,
      );
    }
    if (!document.sourceKey.startsWith(SOURCE_KEY_PREFIX)) {
      throw new TypeError("sourceKey must use the project:scene: namespace");
    }
    const sceneId = document.sourceKey.slice(SOURCE_KEY_PREFIX.length);
    assertContractString("sourceKey scene id", sceneId);
    if (sourceKeys.has(document.sourceKey)) {
      throw new TypeError(`duplicate sourceKey: ${document.sourceKey}`);
    }
    sourceKeys.add(document.sourceKey);

    if (document.rawStoryKey !== null) {
      assertContractString("rawStoryKey", document.rawStoryKey);
      rawStoryKeyCounts.set(
        document.rawStoryKey,
        (rawStoryKeyCounts.get(document.rawStoryKey) ?? 0) + 1,
      );
    }

    return {
      documentRef: document.documentRef,
      sourceKey: document.sourceKey,
      sceneId,
      readingRank,
      rawStoryKey: document.rawStoryKey,
    };
  });

  const uniqueStoryRanks = new Map(
    [...rawStoryKeyCounts]
      .filter(([, count]) => count === 1)
      .map(([rawStoryKey]) => rawStoryKey)
      .sort(compareUtf16)
      .map((rawStoryKey, storyRank) => [rawStoryKey, storyRank] as const),
  );
  const requireUniqueStoryRank = (rawStoryKey: string): number => {
    const storyRank = uniqueStoryRanks.get(rawStoryKey);
    if (storyRank === undefined) {
      throw new Error(`missing unique Story rank: ${rawStoryKey}`);
    }
    return storyRank;
  };
  const content = freezeDeep<NarrativeScopeAuthorityBasisContentV2>({
    schemaVersion: NARRATIVE_SCOPE_AUTHORITY_BASIS_V2_SCHEMA_VERSION,
    contractId: NARRATIVE_SCOPE_AUTHORITY_BASIS_V2_CONTRACT_ID,
    basisKind: NARRATIVE_SCOPE_AUTHORITY_BASIS_V2_KIND,
    projectId: input.projectId,
    source: {
      sourceKind: NARRATIVE_SCOPE_AUTHORITY_SOURCE_KIND,
      sourceKey: `snapshot:${input.runId}`,
    },
    scopeRegistry: {
      registryVersion: NARRATIVE_SCOPE_REGISTRY_VERSION,
      reservedAudienceRefs: [
        NARRATIVE_SCOPE_AUTHORITY_RESERVED_AUDIENCE_REFS[0],
      ],
    },
    mappings: prepared.map((document) => ({
      documentRef: document.documentRef,
      sourceKey: document.sourceKey,
      sceneRef: `scene:${document.sceneId}`,
      readingOrderRef: `reading:${document.sceneId}`,
      storyTimeRef: `story:${document.sceneId}`,
      readingRank: document.readingRank,
      storyTimeOrder:
        document.rawStoryKey === null
          ? {
              status: "unresolved",
              reason: "not-provided",
              rawStoryKey: null,
            }
          : rawStoryKeyCounts.get(document.rawStoryKey) !== 1
            ? {
                status: "unresolved",
                reason: "ambiguous",
                rawStoryKey: document.rawStoryKey,
              }
            : {
                status: "resolved",
                rawStoryKey: document.rawStoryKey,
                storyRank: requireUniqueStoryRank(document.rawStoryKey),
              },
    })),
  });
  const digests = await computeNarrativeScopeAuthorityBasisDigestsFromContent(
    content,
    input.corpusDigest,
  );
  return freezeDeep({ ...content, digests });
}

export async function computeNarrativeScopeAuthorityBasisDigests(
  basis: NarrativeScopeAuthorityBasisV2,
): Promise<NarrativeScopeAuthorityDigestsV2> {
  // Capture one synchronous JSON view before the first digest await. Callers
  // cannot produce a torn seal by mutating source/mappings between domains.
  const content = snapshotBasisContent(basis);
  const corpusDigest = basis.digests.corpusDigest;
  return computeNarrativeScopeAuthorityBasisDigestsFromContent(
    content,
    corpusDigest,
  );
}

export const digestNarrativeScopeAuthorityBasisV2 =
  computeNarrativeScopeAuthorityBasisDigests;
