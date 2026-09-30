import { digestStableJson, hasLoneSurrogate } from "./digest";
import { isFileBackedSourceUri } from "@/features/external-mount/sourceUri";
import { freezeDeep } from "./immutability";
import { serializeProseMirrorDocument } from "./proseMirrorSerializer";
import {
  CANONICAL_TEXT_NORMALIZER_VERSION,
  type CanonicalTextDiagnostic,
  type NarrativeCorpusDocument,
  type NarrativeCorpusSnapshot,
  type NarrativeDocumentOrigin,
  type NarrativeSnapshotBuildInput,
  type NarrativeSnapshotBuildResult,
  type NarrativeSnapshotDiagnostic,
  type NarrativeSnapshotDocumentInput,
  type NarrativeSnapshotOmission,
} from "./types";

interface PreparedDocument {
  readonly input: NarrativeSnapshotDocumentInput;
  readonly ref: string;
  readonly parentRef: string | null;
  readonly canonical: NarrativeCorpusDocument["canonical"];
}

function documentRef(index: number): string {
  return `D${String(index + 1).padStart(6, "0")}`;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareDocuments(
  left: NarrativeSnapshotDocumentInput,
  right: NarrativeSnapshotDocumentInput,
): number {
  return (
    left.orderIndex - right.orderIndex ||
    compareStrings(left.sourceKey, right.sourceKey)
  );
}

function compareOmissions(
  left: NarrativeSnapshotOmission,
  right: NarrativeSnapshotOmission,
): number {
  return (
    compareStrings(left.sourceKey, right.sourceKey) ||
    compareStrings(left.reason, right.reason)
  );
}

function cloneOrigin(origin: NarrativeDocumentOrigin): NarrativeDocumentOrigin {
  return {
    kind: "project-node",
    projectId: origin.projectId,
    nodeId: origin.nodeId,
    sourceVersion: origin.sourceVersion,
    sourceUpdatedAt: origin.sourceUpdatedAt,
    sourceUri: origin.sourceUri,
  };
}

function copyBuildInput(
  input: NarrativeSnapshotBuildInput,
): NarrativeSnapshotBuildInput {
  return freezeDeep({
    snapshotId: input.snapshotId,
    language: input.language,
    origin: {
      kind: "grimodex-project",
      projectId: input.origin.projectId,
    },
    documents: input.documents.map((document) => ({
      sourceKey: document.sourceKey,
      parentSourceKey: document.parentSourceKey,
      title: document.title,
      orderIndex: document.orderIndex,
      proseMirrorJson: document.proseMirrorJson,
      origin: cloneOrigin(document.origin),
    })),
    omissions: input.omissions.map((omission) => ({ ...omission })),
    createdAt: input.createdAt,
  });
}

function snapshotCodeForCanonical(code: string): string {
  switch (code) {
    case "CANONICAL_INVALID_PM_JSON":
      return "SNAPSHOT_INVALID_PM_JSON";
    case "CANONICAL_UNKNOWN_PM_NODE":
      return "SNAPSHOT_UNKNOWN_PM_NODE";
    case "CANONICAL_INVALID_UNICODE":
      return "SNAPSHOT_INVALID_UNICODE";
    default:
      return "SNAPSHOT_INVALID_PM_DOCUMENT";
  }
}

function canonicalDiagnostic(
  sourceKey: string,
  source: CanonicalTextDiagnostic,
): NarrativeSnapshotDiagnostic {
  return {
    code: snapshotCodeForCanonical(source.code),
    message: source.message,
    documentSourceKey: sourceKey,
    causeCode: source.code,
    ...(source.path ? { path: source.path } : {}),
  };
}

function validateMetadata(
  input: NarrativeSnapshotBuildInput,
): NarrativeSnapshotDiagnostic[] {
  const diagnostics: NarrativeSnapshotDiagnostic[] = [];
  const corpusStrings: Array<[string, string]> = [
    ["snapshotId", input.snapshotId],
    ["language", input.language],
    ["createdAt", input.createdAt],
    ["origin.projectId", input.origin.projectId],
  ];
  for (const [path, value] of corpusStrings) {
    if (hasLoneSurrogate(value)) {
      diagnostics.push({
        code: "SNAPSHOT_INVALID_UNICODE",
        message: `Snapshot metadata contains invalid UTF-16 at ${path}`,
        path,
      });
    }
  }

  for (const document of input.documents) {
    const strings: Array<[string, string | null]> = [
      ["sourceKey", document.sourceKey],
      ["parentSourceKey", document.parentSourceKey],
      ["title", document.title],
      ["origin.projectId", document.origin.projectId],
      ["origin.nodeId", document.origin.nodeId],
      ["origin.sourceUpdatedAt", document.origin.sourceUpdatedAt],
      ["origin.sourceUri", document.origin.sourceUri],
    ];
    for (const [path, value] of strings) {
      if (value !== null && hasLoneSurrogate(value)) {
        diagnostics.push({
          code: "SNAPSHOT_INVALID_UNICODE",
          message: `Document metadata contains invalid UTF-16 at ${path}`,
          documentSourceKey: document.sourceKey,
          path,
        });
      }
    }
    if (!Number.isInteger(document.orderIndex) || document.orderIndex < 0) {
      diagnostics.push({
        code: "SNAPSHOT_INVALID_DOCUMENT_ORDER",
        message: "Document orderIndex must be a non-negative integer",
        documentSourceKey: document.sourceKey,
        path: "orderIndex",
      });
    }
    if (
      !Number.isInteger(document.origin.sourceVersion) ||
      document.origin.sourceVersion < 0
    ) {
      diagnostics.push({
        code: "SNAPSHOT_INVALID_SOURCE_VERSION",
        message: "Document sourceVersion must be a non-negative integer",
        documentSourceKey: document.sourceKey,
        path: "origin.sourceVersion",
      });
    }
    if (document.origin.projectId !== input.origin.projectId) {
      diagnostics.push({
        code: "SNAPSHOT_DOCUMENT_ORIGIN_MISMATCH",
        message: "Document origin must belong to the snapshot Project",
        documentSourceKey: document.sourceKey,
        path: "origin.projectId",
      });
    }
  }

  for (const omission of input.omissions) {
    if (
      hasLoneSurrogate(omission.sourceKey) ||
      hasLoneSurrogate(omission.reason)
    ) {
      diagnostics.push({
        code: "SNAPSHOT_INVALID_UNICODE",
        message: "Snapshot omission contains invalid UTF-16",
        documentSourceKey: omission.sourceKey,
      });
    }
  }
  return diagnostics;
}

function validateDocumentKeys(
  documents: readonly NarrativeSnapshotDocumentInput[],
): NarrativeSnapshotDiagnostic[] {
  const diagnostics: NarrativeSnapshotDiagnostic[] = [];
  const sourceKeys = new Set<string>();
  for (const document of documents) {
    if (sourceKeys.has(document.sourceKey)) {
      diagnostics.push({
        code: "SNAPSHOT_DUPLICATE_SOURCE_KEY",
        message: `Duplicate narrative source key: ${document.sourceKey}`,
        documentSourceKey: document.sourceKey,
      });
    }
    sourceKeys.add(document.sourceKey);
  }
  for (const document of documents) {
    if (
      document.parentSourceKey !== null &&
      !sourceKeys.has(document.parentSourceKey)
    ) {
      diagnostics.push({
        code: "SNAPSHOT_PARENT_SOURCE_MISSING",
        message: `Parent source is not part of the snapshot: ${document.parentSourceKey}`,
        documentSourceKey: document.sourceKey,
      });
    }
  }
  return diagnostics;
}

async function sealDocument(
  prepared: PreparedDocument,
): Promise<NarrativeCorpusDocument> {
  const contentDigest = await digestStableJson({
    normalizerVersion: CANONICAL_TEXT_NORMALIZER_VERSION,
    text: prepared.canonical.text,
  });
  const origin = cloneOrigin(prepared.input.origin);
  const documentDigest = await digestStableJson({
    normalizerVersion: CANONICAL_TEXT_NORMALIZER_VERSION,
    parentSourceKey: prepared.input.parentSourceKey,
    title: prepared.input.title,
    orderIndex: prepared.input.orderIndex,
    canonical: {
      text: prepared.canonical.text,
      blocks: prepared.canonical.blocks,
    },
  });
  const artifactDigest = await digestStableJson({
    schemaVersion: 1,
    normalizerVersion: CANONICAL_TEXT_NORMALIZER_VERSION,
    sourceKey: prepared.input.sourceKey,
    parentSourceKey: prepared.input.parentSourceKey,
    semanticDigest: documentDigest,
    contentDigest,
    projection: prepared.canonical.projection,
    origin,
  });

  return freezeDeep({
    ref: prepared.ref,
    sourceKey: prepared.input.sourceKey,
    parentRef: prepared.parentRef,
    title: prepared.input.title,
    orderIndex: prepared.input.orderIndex,
    canonical: prepared.canonical,
    contentDigest,
    documentDigest,
    artifactDigest,
    origin,
  });
}

async function sealSnapshot(
  input: NarrativeSnapshotBuildInput,
  documents: readonly NarrativeCorpusDocument[],
  omissions: readonly NarrativeSnapshotOmission[],
): Promise<NarrativeCorpusSnapshot> {
  const origin = {
    kind: "grimodex-project" as const,
    projectId: input.origin.projectId,
  };
  const digest = await digestStableJson({
    schemaVersion: 1,
    language: input.language,
    normalizerVersion: CANONICAL_TEXT_NORMALIZER_VERSION,
    documentDigests: documents.map((document) => document.documentDigest),
    omissions,
  });
  const artifactDigest = await digestStableJson({
    schemaVersion: 1,
    normalizerVersion: CANONICAL_TEXT_NORMALIZER_VERSION,
    semanticDigest: digest,
    originProjectId: input.origin.projectId,
    documents: documents.map((document) => ({
      sourceKey: document.sourceKey,
      artifactDigest: document.artifactDigest,
    })),
    omissions,
  });

  return freezeDeep({
    schemaVersion: 1,
    id: input.snapshotId,
    snapshotId: input.snapshotId,
    createdAt: input.createdAt,
    language: input.language,
    normalizerVersion: CANONICAL_TEXT_NORMALIZER_VERSION,
    origin,
    documents,
    omissions,
    digest,
    artifactDigest,
  });
}

/** Validate, canonicalize, and cryptographically seal a narrative corpus. */
export async function buildNarrativeCorpusSnapshot(
  input: NarrativeSnapshotBuildInput,
): Promise<NarrativeSnapshotBuildResult> {
  const stableInput = copyBuildInput(input);
  const inputDiagnostics = [
    ...validateMetadata(stableInput),
    ...validateDocumentKeys(stableInput.documents),
  ];
  if (inputDiagnostics.length > 0) {
    return { ok: false, diagnostics: inputDiagnostics };
  }

  const orderedInputs = [...stableInput.documents].sort(compareDocuments);
  const refsBySourceKey = new Map(
    orderedInputs.map((document, index) => [
      document.sourceKey,
      documentRef(index),
    ]),
  );
  const preparedDocuments: PreparedDocument[] = [];
  const serializationDiagnostics: NarrativeSnapshotDiagnostic[] = [];

  for (const [index, document] of orderedInputs.entries()) {
    const serialized = serializeProseMirrorDocument(
      document.proseMirrorJson,
      isFileBackedSourceUri(document.origin.sourceUri)
        ? "file-backed"
        : "database",
    );
    if (!serialized.ok) {
      serializationDiagnostics.push(
        ...serialized.diagnostics.map((item) =>
          canonicalDiagnostic(document.sourceKey, item),
        ),
      );
      continue;
    }
    preparedDocuments.push({
      input: document,
      ref: documentRef(index),
      parentRef:
        document.parentSourceKey === null
          ? null
          : (refsBySourceKey.get(document.parentSourceKey) ?? null),
      canonical: serialized.canonical,
    });
  }
  if (serializationDiagnostics.length > 0) {
    return { ok: false, diagnostics: serializationDiagnostics };
  }

  const documents = await Promise.all(preparedDocuments.map(sealDocument));
  const omissions = [...stableInput.omissions]
    .sort(compareOmissions)
    .map((omission) => ({ ...omission }));
  return {
    ok: true,
    snapshot: await sealSnapshot(stableInput, documents, omissions),
  };
}
