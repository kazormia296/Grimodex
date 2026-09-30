import type { ImportDiagnostic } from "./importDiagnostics";
import type { ImportInputManifest } from "./importInputManifest";
import type { ImportSourceDocument } from "./importSourceDocument";
import type { ImportSourceIdentity } from "./importSourceIdentity";
import type { ImportSourceNode } from "./importSourceNode";
import type { ImportSourceRecord } from "./importSourceRecord";
import {
  digestImportPackagePayload,
  packageDigestPayload,
} from "./packageDigest";
import type { Sha256Digest } from "@/features/narrative-extraction/source/types";

export const IMPORT_SOURCE_PACKAGE_SCHEMA_VERSION = 1 as const;

export interface ImportSourcePackageStructure {
  readonly codexEntries: readonly ImportSourceRecord[];
  readonly snippets: readonly ImportSourceRecord[];
}

export interface ImportSourcePackageDraft {
  readonly schemaVersion: typeof IMPORT_SOURCE_PACKAGE_SCHEMA_VERSION;
  readonly identity: ImportSourceIdentity;
  readonly manifest: ImportInputManifest;
  readonly nodes: readonly ImportSourceNode[];
  readonly documents: readonly ImportSourceDocument[];
  readonly structure: ImportSourcePackageStructure;
  readonly diagnostics: readonly ImportDiagnostic[];
  readonly createdAt: string;
}

export interface ImportSourcePackage extends ImportSourcePackageDraft {
  readonly digest: Sha256Digest;
}

export async function sealImportSourcePackage(
  draft: ImportSourcePackageDraft,
): Promise<ImportSourcePackage> {
  const digest = await digestImportSourcePackage(draft);
  return { ...draft, digest };
}

export async function digestImportSourcePackage(
  draft: ImportSourcePackageDraft | ImportSourcePackage,
): Promise<Sha256Digest> {
  const payload = packageDigestPayload(draft);
  return digestImportPackagePayload(payload);
}

export function importSourcePackageWithoutDigest(
  pkg: ImportSourcePackage,
): ImportSourcePackageDraft {
  const { digest: _digest, ...draft } = pkg;
  return draft;
}
