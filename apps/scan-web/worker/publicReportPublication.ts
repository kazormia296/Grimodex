/** A new publish operation must never overwrite an object being unpublished. */
export function publicReportArtifactKey(
  scanId: string,
  publicationId: string,
): string {
  if (!scanId || !publicationId) {
    throw new Error("scan and publication IDs are required");
  }
  return `public/${encodeURIComponent(scanId)}/${encodeURIComponent(publicationId)}.json`;
}
