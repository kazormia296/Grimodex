import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isDetailValueEmpty,
  detailValueToPlainText,
  listEmptyDetailFields,
  deleteEmptyDetailFields,
} from "./detailCleanup";
import type { CodexDetailDefinition } from "./detailApi";

vi.mock("./detailApi", () => ({
  listDefinitionsByType: vi.fn(),
  listValuesByDefinitionIds: vi.fn(),
  deleteDefinition: vi.fn(),
}));

import {
  listDefinitionsByType,
  listValuesByDefinitionIds,
  deleteDefinition,
} from "./detailApi";

const mockListDefs = vi.mocked(listDefinitionsByType);
const mockListValues = vi.mocked(listValuesByDefinitionIds);
const mockDelete = vi.mocked(deleteDefinition);

const makeDefinition = (
  id: string,
  name: string,
  fieldType = "text",
): CodexDetailDefinition => ({
  id,
  projectId: "proj-1",
  typeSlug: "character",
  name,
  fieldType,
  fieldConfig: null,
  sortOrder: 1.0,
  includeInContext: 1,
  createdAt: "2026-01-01T00:00:00Z",
});

const EMPTY_DOC = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph" }],
});
const FILLED_DOC = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "180cm" }] }],
});

describe("isDetailValueEmpty", () => {
  it("treats null and blank strings as empty", () => {
    expect(isDetailValueEmpty(null)).toBe(true);
    expect(isDetailValueEmpty("")).toBe(true);
    expect(isDetailValueEmpty("   ")).toBe(true);
  });

  it("treats ProseMirror docs without text as empty", () => {
    expect(isDetailValueEmpty("{}")).toBe(true);
    expect(isDetailValueEmpty(EMPTY_DOC)).toBe(true);
  });

  it("treats ProseMirror docs with text as non-empty", () => {
    expect(isDetailValueEmpty(FILLED_DOC)).toBe(false);
  });

  it("treats raw strings (dropdown values, reference ids) as non-empty", () => {
    expect(isDetailValueEmpty("主人公")).toBe(false);
    expect(isDetailValueEmpty("entry-abc-123")).toBe(false);
  });

  it("treats JSON-parsable scalars as non-empty raw values", () => {
    expect(isDetailValueEmpty("123")).toBe(false);
    expect(isDetailValueEmpty("true")).toBe(false);
  });
});

describe("detailValueToPlainText", () => {
  it("returns empty string for null and empty input", () => {
    expect(detailValueToPlainText(null)).toBe("");
    expect(detailValueToPlainText("")).toBe("");
  });

  it("extracts plain text from ProseMirror doc JSON", () => {
    expect(detailValueToPlainText(FILLED_DOC)).toBe("180cm");
    expect(detailValueToPlainText(EMPTY_DOC)).toBe("");
    expect(detailValueToPlainText("{}")).toBe("");
  });

  it("passes raw strings (dropdown values, reference ids) through unchanged", () => {
    expect(detailValueToPlainText("主人公")).toBe("主人公");
    expect(detailValueToPlainText("entry-abc-123")).toBe("entry-abc-123");
  });

  it("passes JSON-parsable scalars through unchanged", () => {
    expect(detailValueToPlainText("123")).toBe("123");
    expect(detailValueToPlainText("true")).toBe("true");
  });
});

describe("listEmptyDetailFields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns definitions that have no row or only empty values", async () => {
    const defA = makeDefinition("def-a", "外見");
    const defB = makeDefinition("def-b", "性格");
    const defC = makeDefinition("def-c", "年齢");
    mockListDefs.mockResolvedValue([defA, defB, defC]);
    mockListValues.mockResolvedValue([
      { definitionId: "def-a", value: FILLED_DOC },
      { definitionId: "def-b", value: EMPTY_DOC },
      // def-c は行なし（未入力）
    ]);

    const result = await listEmptyDetailFields("proj-1", "character");

    expect(result.map((d) => d.id)).toEqual(["def-b", "def-c"]);
    expect(mockListValues).toHaveBeenCalledWith(["def-a", "def-b", "def-c"]);
  });

  it("keeps a definition used by any entry even if another entry is empty", async () => {
    const defA = makeDefinition("def-a", "役割", "dropdown");
    mockListDefs.mockResolvedValue([defA]);
    mockListValues.mockResolvedValue([
      { definitionId: "def-a", value: "" },
      { definitionId: "def-a", value: "主人公" },
    ]);

    const result = await listEmptyDetailFields("proj-1", "character");

    expect(result).toEqual([]);
  });

  it("returns empty without querying values when there are no definitions", async () => {
    mockListDefs.mockResolvedValue([]);

    const result = await listEmptyDetailFields("proj-1", "character");

    expect(result).toEqual([]);
    expect(mockListValues).not.toHaveBeenCalled();
  });
});

describe("deleteEmptyDetailFields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDelete.mockResolvedValue(undefined);
  });

  it("deletes only the empty definitions and reports kept count", async () => {
    const defA = makeDefinition("def-a", "外見");
    const defB = makeDefinition("def-b", "性格");
    const defC = makeDefinition("def-c", "年齢");
    mockListDefs.mockResolvedValue([defA, defB, defC]);
    mockListValues.mockResolvedValue([
      { definitionId: "def-a", value: FILLED_DOC },
    ]);

    const result = await deleteEmptyDetailFields("proj-1", "character");

    expect(mockDelete).toHaveBeenCalledTimes(2);
    expect(mockDelete).toHaveBeenCalledWith("def-b");
    expect(mockDelete).toHaveBeenCalledWith("def-c");
    expect(result.deleted.map((d) => d.id)).toEqual(["def-b", "def-c"]);
    expect(result.kept).toBe(1);
  });

  it("deletes nothing when every definition has a value", async () => {
    const defA = makeDefinition("def-a", "役割", "dropdown");
    mockListDefs.mockResolvedValue([defA]);
    mockListValues.mockResolvedValue([
      { definitionId: "def-a", value: "主人公" },
    ]);

    const result = await deleteEmptyDetailFields("proj-1", "character");

    expect(mockDelete).not.toHaveBeenCalled();
    expect(result.deleted).toEqual([]);
    expect(result.kept).toBe(1);
  });
});
