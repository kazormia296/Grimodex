import type { ImportSourcePackage } from "@/features/import/core/importSourcePackage";
import type {
  NarrativeCorpusSnapshot,
  NarrativeSnapshotDocumentInput,
  Sha256Digest,
} from "@/features/narrative-extraction/source/types";
import { CANONICAL_TEXT_NORMALIZER_VERSION } from "@/features/narrative-extraction/source/types";
import { digestStableJson } from "@/features/narrative-extraction/source/digest";

/** Minimal snapshot-shaped view built from an import package (stub for extraction). */
export interface ImportCorpusSnapshot {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly createdAt: string;
  readonly language: string;
  readonly normalizerVersion: typeof CANONICAL_TEXT_NORMALIZER_VERSION;
  readonly origin: {
    readonly kind: "import-source-package";
    readonly sourceSetId: string;
    readonly packageDigest: Sha256Digest;
  };
  readonly documentInputs: readonly NarrativeSnapshotDocumentInput[];
  readonly digest: Sha256Digest;
}

export function buildImportCorpusSnapshotStub(
  pkg: ImportSourcePackage,
): Omit<ImportCorpusSnapshot, "digest"> {
  const snapshotId = `import:${pkg.identity.sourceSetId}`;
  const documentInputs: NarrativeSnapshotDocumentInput[] = pkg.documents.map(
    (doc, index) => ({
      sourceKey: doc.key,
      parentSourceKey: pkg.nodes.find((n) => n.key === doc.nodeKey)?.parentKey ?? null,
      title: doc.title,
      orderIndex: doc.orderIndex ?? index,
      proseMirrorJson: doc.proseMirrorJson,
      origin: {
        kind: "project-node",
        projectId: "import-stub",
        nodeId: doc.nodeKey,
        sourceVersion: 1,
        sourceUpdatedAt: pkg.createdAt,
        sourceUri: null,
      },
    }),
  );

  return {
    schemaVersion: 1 as const,
    snapshotId,
    createdAt: pkg.createdAt,
    language: pkg.identity.hints.languageHint ?? "ja",
    normalizerVersion: CANONICAL_TEXT_NORMALIZER_VERSION,
    origin: {
      kind: "import-source-package" as const,
      sourceSetId: pkg.identity.sourceSetId,
      packageDigest: pkg.digest,
    },
    documentInputs,
  };
}

export async function buildImportCorpusSnapshotDigest(
  stub: Omit<ImportCorpusSnapshot, "digest">,
): Promise<ImportCorpusSnapshot> {
  const digest = await digestStableJson({
    snapshotId: stub.snapshotId,
    origin: stub.origin,
    documentInputs: stub.documentInputs,
  });
  return { ...stub, digest };
}

export function toNarrativeCorpusSnapshotPlaceholder(
  stub: ImportCorpusSnapshot,
): Pick<NarrativeCorpusSnapshot, "snapshotId" | "digest" | "language" | "origin"> {
  return {
    snapshotId: stub.snapshotId,
    digest: stub.digest,
    language: stub.language,
    origin: {
      kind: "grimodex-project",
      projectId: "import-stub",
    },
  };
}
