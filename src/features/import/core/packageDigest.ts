import {
  digestStableJson,
  stableJsonStringify,
} from "@/features/narrative-extraction/source/digest";
import type { Sha256Digest } from "@/features/narrative-extraction/source/types";
import type {
  ImportSourcePackage,
  ImportSourcePackageDraft,
} from "./importSourcePackage";

export { stableJsonStringify };

/** Fields excluded from package identity digest (runtime metadata). */
export const PACKAGE_DIGEST_EXCLUDED_FIELDS = ["createdAt", "digest"] as const;

export type PackageDigestExcludedField =
  (typeof PACKAGE_DIGEST_EXCLUDED_FIELDS)[number];

/** Strip runtime-only fields before hashing. */
export function packageDigestPayload(
  value: ImportSourcePackageDraft | ImportSourcePackage,
): Omit<ImportSourcePackageDraft, PackageDigestExcludedField> {
  const {
    createdAt: _createdAt,
    digest: _digest,
    ...rest
  } = value as ImportSourcePackageDraft &
    Partial<Pick<ImportSourcePackage, "digest">>;
  return rest;
}

export async function digestImportPackagePayload(
  payload: unknown,
): Promise<Sha256Digest> {
  return digestStableJson(payload);
}

export function stablePackageJsonStringify(payload: unknown): string {
  return stableJsonStringify(payload);
}
