import { describe, expect, it } from "vitest";
import {
  MAX_IMPORT_ARCHIVE_BYTES,
  MAX_IMPORT_FOLDER_BYTES,
  MAX_IMPORT_FOLDER_DEPTH,
  MAX_IMPORT_FOLDER_FILES,
  MAX_IMPORT_TEXT_BYTES,
  hasAllowedImportExtension,
  importFileLimitViolation,
  importFolderLimitViolation,
  importPathDepthViolation,
} from "./importFileLimits";

describe("browser-safe import input limits", () => {
  it("accepts inputs at the limit and rejects files before an oversized read", () => {
    expect(
      importFileLimitViolation({ size: MAX_IMPORT_ARCHIVE_BYTES }, "archive"),
    ).toBeNull();
    expect(
      importFileLimitViolation(
        { size: MAX_IMPORT_ARCHIVE_BYTES + 1 },
        "archive",
      ),
    ).toBe("file-too-large");
    expect(
      importFileLimitViolation({ size: MAX_IMPORT_TEXT_BYTES + 1 }, "text"),
    ).toBe("file-too-large");
    expect(importFileLimitViolation({ size: 0 }, "text")).toBe("empty-file");
  });

  it("bounds browser folder imports by file count and total bytes", () => {
    expect(
      importFolderLimitViolation({ length: MAX_IMPORT_FOLDER_FILES + 1 }),
    ).toBe("too-many-files");
    expect(
      importFolderLimitViolation([
        { size: MAX_IMPORT_FOLDER_BYTES },
        { size: 1 },
      ]),
    ).toBe("folder-too-large");
    expect(
      importFolderLimitViolation([{ size: MAX_IMPORT_FOLDER_BYTES }]),
    ).toBeNull();
    expect(importFolderLimitViolation([])).toBe("empty-folder");
    expect(
      importFolderLimitViolation([
        {
          size: 1,
          webkitRelativePath: `${"chapter/".repeat(MAX_IMPORT_FOLDER_DEPTH)}scene.md`,
        },
      ]),
    ).toBe("path-too-deep");
  });

  it("matches supported extensions case-insensitively without accepting other formats", () => {
    expect(hasAllowedImportExtension("MANUSCRIPT.ZIP", ["zip"])).toBe(true);
    expect(
      hasAllowedImportExtension("chapter.MarkDown", ["md", "markdown"]),
    ).toBe(true);
    expect(hasAllowedImportExtension("scan.json", ["zip"])).toBe(false);
    expect(hasAllowedImportExtension("draft.grimodex-handoff", ["novel"])).toBe(
      false,
    );
  });

  it("rejects paths deeper than the recursive import boundary", () => {
    expect(importPathDepthViolation("chapter/scene.md")).toBeNull();
    expect(
      importPathDepthViolation(
        `${"chapter/".repeat(MAX_IMPORT_FOLDER_DEPTH)}scene.md`,
      ),
    ).toBe("path-too-deep");
  });
});
