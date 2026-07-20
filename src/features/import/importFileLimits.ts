const MEBIBYTE = 1024 * 1024;

/** Bound the browser read before ZIP parsing allocates the source buffer. */
export const MAX_IMPORT_ARCHIVE_BYTES = 64 * MEBIBYTE;
export const MAX_IMPORT_TEXT_BYTES = 32 * MEBIBYTE;
export const MAX_IMPORT_FOLDER_BYTES = 64 * MEBIBYTE;
export const MAX_IMPORT_FOLDER_FILES = 10_000;
export const MAX_IMPORT_FOLDER_DEPTH = 64;

export type ImportFileKind = "archive" | "text";
export type ImportLimitContext = ImportFileKind | "folder";
export type ImportLimitViolation =
  | "empty-file"
  | "file-too-large"
  | "empty-folder"
  | "too-many-files"
  | "folder-too-large"
  | "path-too-deep";

interface ImportFileMetadata {
  size: number;
  webkitRelativePath?: string;
}

export function importFileLimitViolation(
  file: Pick<ImportFileMetadata, "size">,
  kind: ImportFileKind,
): ImportLimitViolation | null {
  if (!Number.isFinite(file.size) || file.size <= 0) return "empty-file";
  const maxBytes =
    kind === "archive" ? MAX_IMPORT_ARCHIVE_BYTES : MAX_IMPORT_TEXT_BYTES;
  return file.size > maxBytes ? "file-too-large" : null;
}

function relativePathDepth(path: string | undefined): number {
  if (!path) return 1;
  return path.split(/[\\/]+/u).filter(Boolean).length;
}

export function importPathDepthViolation(
  path: string | undefined,
): ImportLimitViolation | null {
  return relativePathDepth(path) > MAX_IMPORT_FOLDER_DEPTH
    ? "path-too-deep"
    : null;
}

export function importFolderLimitViolation(
  files: ArrayLike<ImportFileMetadata>,
): ImportLimitViolation | null {
  if (files.length === 0) return "empty-folder";
  if (files.length > MAX_IMPORT_FOLDER_FILES) return "too-many-files";

  let totalBytes = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file || !Number.isFinite(file.size) || file.size < 0) {
      return "folder-too-large";
    }
    const pathViolation = importPathDepthViolation(file.webkitRelativePath);
    if (pathViolation) return pathViolation;
    totalBytes += file.size;
    if (totalBytes > MAX_IMPORT_FOLDER_BYTES) return "folder-too-large";
  }
  return null;
}

export function hasAllowedImportExtension(
  fileName: string,
  extensions: readonly string[],
): boolean {
  const normalizedName = fileName.toLocaleLowerCase("en-US");
  return extensions.some((extension) => {
    const normalizedExtension = extension
      .replace(/^\.+/u, "")
      .toLocaleLowerCase("en-US");
    return (
      normalizedExtension.length > 0 &&
      normalizedName.endsWith(`.${normalizedExtension}`)
    );
  });
}

export function importLimitMegabytes(kind: ImportFileKind): number {
  const bytes =
    kind === "archive" ? MAX_IMPORT_ARCHIVE_BYTES : MAX_IMPORT_TEXT_BYTES;
  return bytes / MEBIBYTE;
}

export const MAX_IMPORT_FOLDER_MEBIBYTES = MAX_IMPORT_FOLDER_BYTES / MEBIBYTE;

export function importLimitMessageValues(
  violation: ImportLimitViolation,
  context: ImportLimitContext,
): Record<string, number> {
  if (violation === "file-too-large") {
    return {
      maxMiB:
        context === "archive"
          ? importLimitMegabytes("archive")
          : importLimitMegabytes("text"),
    };
  }
  if (violation === "too-many-files") {
    return { maxFiles: MAX_IMPORT_FOLDER_FILES };
  }
  if (violation === "folder-too-large") {
    return { maxMiB: MAX_IMPORT_FOLDER_MEBIBYTES };
  }
  if (violation === "path-too-deep") {
    return { maxDepth: MAX_IMPORT_FOLDER_DEPTH };
  }
  return {};
}
