import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BASE_DETAIL_PRESETS,
  BASE_DETAIL_PRESETS_EN,
  GENRE_DETAIL_PRESETS,
  GENRE_DETAIL_PRESETS_EN,
  PRESET_GENRES,
  resolvePresetFields,
  applyDetailPreset,
  type DetailFieldPreset,
} from "./detailPresets";
import { GENRE_VALUES } from "@/features/project/genreOptions";
import type { CodexDetailDefinition } from "./detailApi";

const invokeMock = vi.fn();

vi.mock("./detailApi", () => ({
  listDefinitionsByType: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/db/client", () => {
  const toSQL = () => ({ sql: "insert", params: [] });
  return {
    db: {
      insert: () => ({
        values: () => ({ toSQL }),
      }),
    },
  };
});

import { listDefinitionsByType } from "./detailApi";

const mockList = vi.mocked(listDefinitionsByType);

const BUILTIN_SLUGS = ["character", "location", "item", "lore"];

const makeDefinition = (
  name: string,
  sortOrder: number,
  overrides?: Partial<CodexDetailDefinition>,
): CodexDetailDefinition => ({
  id: `def-${name}`,
  projectId: "proj-1",
  typeSlug: "character",
  name,
  fieldType: "text",
  fieldConfig: null,
  sortOrder,
  includeInContext: 1,
  version: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

describe("resolvePresetFields", () => {
  it("returns the base set when genre is null", () => {
    expect(resolvePresetFields("character", null)).toEqual(
      BASE_DETAIL_PRESETS.character,
    );
  });

  it("appends genre additions after the base set", () => {
    const resolved = resolvePresetFields("character", "Fantasy");
    const baseNames = BASE_DETAIL_PRESETS.character.map((f) => f.name);
    expect(resolved.slice(0, baseNames.length).map((f) => f.name)).toEqual(
      baseNames,
    );
    expect(resolved.length).toBeGreaterThan(baseNames.length);
    expect(resolved.map((f) => f.name)).toContain("種族");
  });

  it("falls back to the base set for an unknown genre", () => {
    expect(resolvePresetFields("character", "Cyberpunk")).toEqual(
      BASE_DETAIL_PRESETS.character,
    );
  });

  it("returns an empty list for a non-builtin type slug", () => {
    expect(resolvePresetFields("my-custom-type", null)).toEqual([]);
    expect(resolvePresetFields("my-custom-type", "Fantasy")).toEqual([]);
  });
});

describe("preset catalogs", () => {
  it("covers every builtin type in both languages", () => {
    for (const slug of BUILTIN_SLUGS) {
      expect(BASE_DETAIL_PRESETS[slug]?.length).toBeGreaterThan(0);
      expect(BASE_DETAIL_PRESETS_EN[slug]?.length).toBeGreaterThan(0);
    }
  });

  it("keeps PRESET_GENRES aligned with genre catalog keys", () => {
    for (const genre of PRESET_GENRES) {
      expect(GENRE_VALUES).toContain(genre);
      expect(GENRE_DETAIL_PRESETS[genre]).toBeDefined();
      expect(GENRE_DETAIL_PRESETS_EN[genre]).toBeDefined();
    }
  });

  it("attaches semantic metadata only to designated character fields", () => {
    const fields = BASE_DETAIL_PRESETS.character as readonly DetailFieldPreset[];
    expect(fields.find((f) => f.name === "役割")?.semantic?.facetKey).toBe(
      "role.current",
    );
    expect(fields.find((f) => f.name === "年齢")?.semantic?.facetKey).toBe(
      "identity.age",
    );
    expect(fields.find((f) => f.name === "外見")?.semantic).toBeUndefined();
  });
});

describe("applyDetailPreset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeMock.mockResolvedValue([]);
  });

  it("inserts every resolved field when none exist yet", async () => {
    mockList.mockResolvedValue([]);
    const expected = resolvePresetFields("character", "Fantasy");

    const result = await applyDetailPreset("proj-1", "character", "Fantasy");

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const statements = invokeMock.mock.calls[0]?.[1]?.statements as unknown[];
    // Each field inserts a definition; semantic fields also insert a binding.
    const semanticCount = expected.filter((f) => f.semantic).length;
    expect(statements).toHaveLength(expected.length + semanticCount);
    expect(result.added.map((d) => d.name)).toEqual(
      expected.map((f) => f.name),
    );
    expect(result.skipped).toBe(0);
  });

  it("numbers sortOrder sequentially after the existing maximum", async () => {
    mockList.mockResolvedValue([makeDefinition("既存欄", 5.0)]);

    const result = await applyDetailPreset("proj-1", "character", null);

    expect(result.added.map((d) => d.sortOrder)).toEqual(
      result.added.map((_, i) => 6.0 + i),
    );
  });

  it("writes DetailSemanticBinding rows for semantic presets in the same batch", async () => {
    mockList.mockResolvedValue([]);
    await applyDetailPreset("proj-1", "character", null);
    const statements = invokeMock.mock.calls[0]?.[1]?.statements as Array<{
      sql: string;
    }>;
    // At least one binding insert accompanies the definition inserts.
    expect(statements.length).toBeGreaterThan(
      resolvePresetFields("character", null).length,
    );
  });

  it("skips fields whose names already exist", async () => {
    mockList.mockResolvedValue([
      makeDefinition("役割", 1),
      makeDefinition("年齢", 2),
    ]);
    const expected = resolvePresetFields("character", null);
    const result = await applyDetailPreset("proj-1", "character", null);
    expect(result.skipped).toBe(2);
    expect(result.added.length).toBe(expected.length - 2);
  });

  it("returns empty added when every field already exists", async () => {
    const expected = resolvePresetFields("character", null);
    mockList.mockResolvedValue(
      expected.map((f, i) => makeDefinition(f.name, i + 1)),
    );
    const result = await applyDetailPreset("proj-1", "character", null);
    expect(result.added).toEqual([]);
    expect(result.skipped).toBe(expected.length);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
