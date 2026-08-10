import { describe, expect, it } from "vitest";
import {
  MAX_IMPORT_ARCHIVE_BYTES,
  MAX_IMPORT_FOLDER_BYTES,
  MAX_IMPORT_FOLDER_DEPTH,
  MAX_IMPORT_FOLDER_FILES,
  MAX_IMPORT_TEXT_BYTES,
} from "../importFileLimits";
import {
  captureBudgetFileViolation,
  captureBudgetFolderViolation,
  defaultImportCaptureBudget,
  isWithinCaptureBudget,
} from "./captureBudget";

describe("captureBudget", () => {
  it("aligns default budget with importFileLimits constants", () => {
    const budget = defaultImportCaptureBudget();
    expect(budget.maxArchiveBytes).toBe(MAX_IMPORT_ARCHIVE_BYTES);
    expect(budget.maxTextBytes).toBe(MAX_IMPORT_TEXT_BYTES);
    expect(budget.maxFolderBytes).toBe(MAX_IMPORT_FOLDER_BYTES);
    expect(budget.maxFolderFiles).toBe(MAX_IMPORT_FOLDER_FILES);
    expect(budget.maxFolderDepth).toBe(MAX_IMPORT_FOLDER_DEPTH);
  });

  it("rejects oversized text files", () => {
    expect(
      captureBudgetFileViolation(
        { size: MAX_IMPORT_TEXT_BYTES + 1 },
        "text",
      ),
    ).toBe("file-too-large");
  });

  it("rejects folders exceeding file count", () => {
    const files = Array.from({ length: MAX_IMPORT_FOLDER_FILES + 1 }, (_, i) => ({
      size: 1,
      webkitRelativePath: `a/${i}.txt`,
    }));
    expect(captureBudgetFolderViolation(files)).toBe("too-many-files");
  });

  it("accepts a small folder within budget", () => {
    const files = [{ size: 100, webkitRelativePath: "chapter/01.txt" }];
    expect(isWithinCaptureBudget(files)).toBe(true);
    expect(captureBudgetFolderViolation(files)).toBeNull();
  });
});
