/**
 * Canonical JSON Pointer-like vocabulary for Narrative Change Feed paths.
 *
 * Paths are intentionally kept as pointers rather than writer-specific field
 * names so downstream dependency indexing can compare events from every
 * Native writer without a translation table.
 */
export function isCanonicalChangedPath(path: string): boolean {
  if (path.length === 0 || path.trim() !== path || !path.startsWith("/")) {
    return false;
  }
  if (path === "/") return true;

  const segments = path.slice(1).split("/");
  return segments.every((segment) => {
    for (let index = 0; index < segment.length; index += 1) {
      if (segment[index] !== "~") continue;
      const escape = segment[index + 1];
      if (escape !== "0" && escape !== "1") return false;
      index += 1;
    }
    return true;
  });
}

export function assertCanonicalChangedPath(
  path: string,
  field = "changedPath",
): void {
  if (!isCanonicalChangedPath(path)) {
    throw new TypeError(
      `${field} must be a canonical JSON Pointer path beginning with '/'`,
    );
  }
}

export function canonicalChangedPaths(paths: readonly string[]): string[] {
  if (paths.length === 0) {
    throw new TypeError("changedPaths must contain at least one path");
  }
  const unique = new Set<string>();
  for (const path of paths) {
    assertCanonicalChangedPath(path, "changedPath");
    if (unique.has(path)) {
      throw new TypeError("changedPaths must not contain duplicates");
    }
    unique.add(path);
  }
  return [...unique].sort(compareUtf8);
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

export function jsonPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
