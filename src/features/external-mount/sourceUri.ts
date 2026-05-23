const URI_PREFIX = "external-root://";

/** Build a canonical source URI for a file under an external root. */
export function buildSourceUri(rootId: string, relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return `${URI_PREFIX}${rootId}/${normalized}`;
}

/** URI for the mount root folder node. */
export function buildMountFolderUri(rootId: string): string {
  return `${URI_PREFIX}${rootId}/.mount`;
}

export function parseSourceUri(
  uri: string,
): { rootId: string; relPath: string } | null {
  if (!uri.startsWith(URI_PREFIX)) return null;
  const rest = uri.slice(URI_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  return {
    rootId: rest.slice(0, slash),
    relPath: rest.slice(slash + 1),
  };
}

export function isFileBackedSourceUri(uri: string | null | undefined): boolean {
  if (!uri) return false;
  const parsed = parseSourceUri(uri);
  return parsed != null && parsed.relPath !== ".mount";
}

export function isMountFolderUri(uri: string | null | undefined): boolean {
  return uri != null && uri.endsWith("/.mount");
}

/** Strip numeric ordering prefix and `.md` extension for display title. */
export function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.md$/i, "");
  return base.replace(/^\d+[-_\s]*/, "");
}

export function dirname(relPath: string): string | null {
  const normalized = relPath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return null;
  return normalized.slice(0, idx);
}

export function basename(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}
