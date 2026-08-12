import {
  MAX_IMPORT_ARCHIVE_BYTES,
  MAX_IMPORT_FOLDER_BYTES,
  MAX_IMPORT_FOLDER_DEPTH,
  MAX_IMPORT_FOLDER_FILES,
  MAX_IMPORT_TEXT_BYTES,
  importFileLimitViolation,
  importFolderLimitViolation,
  importPathDepthViolation,
  type ImportFileKind,
  type ImportLimitViolation,
} from "../importFileLimits";
import type { ImportCaptureBudget } from "./captureTypes";

/** Browser-standard budget aligned with importFileLimits.ts hard caps. */
export function defaultImportCaptureBudget(): ImportCaptureBudget {
  return {
    maxArchiveBytes: MAX_IMPORT_ARCHIVE_BYTES,
    maxTextBytes: MAX_IMPORT_TEXT_BYTES,
    maxFolderBytes: MAX_IMPORT_FOLDER_BYTES,
    maxFolderFiles: MAX_IMPORT_FOLDER_FILES,
    maxFolderDepth: MAX_IMPORT_FOLDER_DEPTH,
  };
}

export interface CaptureBudgetFileInput {
  readonly size: number;
  readonly webkitRelativePath?: string;
}

export function captureBudgetFileViolation(
  file: CaptureBudgetFileInput,
  kind: ImportFileKind,
  budget: ImportCaptureBudget = defaultImportCaptureBudget(),
): ImportLimitViolation | null {
  if (!Number.isFinite(file.size) || file.size <= 0) return "empty-file";
  const maxBytes =
    kind === "archive" ? budget.maxArchiveBytes : budget.maxTextBytes;
  if (file.size > maxBytes) return "file-too-large";
  const depthViolation = importPathDepthViolation(file.webkitRelativePath);
  if (depthViolation && file.webkitRelativePath) {
    const depth = file.webkitRelativePath
      .split(/[\\/]+/u)
      .filter(Boolean).length;
    if (depth > budget.maxFolderDepth) return "path-too-deep";
  }
  return importFileLimitViolation(file, kind);
}

export function captureBudgetFolderViolation(
  files: readonly CaptureBudgetFileInput[],
  budget: ImportCaptureBudget = defaultImportCaptureBudget(),
): ImportLimitViolation | null {
  if (files.length === 0) return "empty-folder";
  if (files.length > budget.maxFolderFiles) return "too-many-files";

  let totalBytes = 0;
  for (const file of files) {
    if (!Number.isFinite(file.size) || file.size < 0) return "folder-too-large";
    const path = file.webkitRelativePath;
    if (path) {
      const depth = path.split(/[\\/]+/u).filter(Boolean).length;
      if (depth > budget.maxFolderDepth) return "path-too-deep";
    }
    totalBytes += file.size;
    if (totalBytes > budget.maxFolderBytes) return "folder-too-large";
  }
  return importFolderLimitViolation(files);
}

export function isWithinCaptureBudget(
  files: readonly CaptureBudgetFileInput[],
  budget: ImportCaptureBudget = defaultImportCaptureBudget(),
): boolean {
  return captureBudgetFolderViolation(files, budget) === null;
}
