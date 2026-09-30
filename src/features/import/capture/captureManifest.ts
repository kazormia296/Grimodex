import { digestStableJson } from "@/features/narrative-extraction/source/digest";
import type { Sha256Digest } from "@/features/narrative-extraction/source/types";
import type { ImportCaptureManifest } from "./captureTypes";

/** Fields excluded from capture manifest identity digest. */
export const CAPTURE_DIGEST_EXCLUDED_FIELDS = [
  "createdAt",
  "updatedAt",
  "sealedDigest",
] as const;

export type CaptureDigestExcludedField =
  (typeof CAPTURE_DIGEST_EXCLUDED_FIELDS)[number];

export function captureManifestDigestPayload(
  manifest: ImportCaptureManifest,
): Omit<ImportCaptureManifest, CaptureDigestExcludedField> {
  const {
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    sealedDigest: _sealedDigest,
    ...rest
  } = manifest;
  return rest;
}

export async function digestImportCaptureManifest(
  manifest: ImportCaptureManifest,
): Promise<Sha256Digest> {
  return digestStableJson(captureManifestDigestPayload(manifest));
}
