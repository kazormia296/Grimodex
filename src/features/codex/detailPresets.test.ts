import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BASE_DETAIL_PRESETS,
  GENRE_DETAIL_PRESETS,
  PRESET_GENRES,
  resolvePresetFields,
  applyDetailPreset,
  type DetailFieldPreset,
} from "./detailPresets";
import { GENRE_VALUES } from "@/features/project/genreOptions";
import type { CodexDetailDefinition } from "./detailApi";

vi.mock("./detailApi", () => ({
  listDefinitionsByType: vi.fn(),
  createDefinition: vi.fn(),
}));

import { listDefinitionsByType, createDefinition } from "./detailApi";

const mockList = vi.mocked(listDefinitionsByType);
const mockCreate = vi.mocked(createDefinition);

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
  createdAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

function allPresetLists(): ReadonlyArray<readonly DetailFieldPreset[]> {
  const genreLists = Object.values(GENRE_DETAIL_PRESETS)
    .filter((byType): byType is NonNullable<typeof byType> => byType != null)
    .flatMap((byType) => Object.values(byType));
  return [...Object.values(BASE_DETAIL_PRESETS), ...genreLists];
}

describe("detailPresets registry", () => {
  it("has a non-empty base set for every builtin type", () => {
    for (const slug of BUILTIN_SLUGS) {
      expect(BASE_DETAIL_PRESETS[slug]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("uses only valid project genre values as genre keys", () => {
    for (const key of Object.keys(GENRE_DETAIL_PRESETS)) {
      expect(GENRE_VALUES).toContain(key);
    }
  });

  it("uses only builtin type slugs in genre additions", () => {
    for (const byType of Object.values(GENRE_DETAIL_PRESETS)) {
      if (!byType) continue;
      for (const slug of Object.keys(byType)) {
        expect(BUILTIN_SLUGS).toContain(slug);
      }
    }
  });

  it("lists exactly the genres that have additions in PRESET_GENRES", () => {
    expect([...PRESET_GENRES]).toEqual(Object.keys(GENRE_DETAIL_PRESETS));
    expect(PRESET_GENRES.length).toBeGreaterThan(0);
  });

  it("gives every dropdown preset non-empty options and no options otherwise", () => {
    for (const list of allPresetLists()) {
      for (const field of list) {
        if (field.fieldType === "dropdown") {
          expect(field.options?.length ?? 0).toBeGreaterThan(1);
        } else {
          expect(field.options).toBeUndefined();
        }
      }
    }
  });

  it("has trimmed non-empty field names everywhere", () => {
    for (const list of allPresetLists()) {
      for (const field of list) {
        expect(field.name.length).toBeGreaterThan(0);
        expect(field.name).toBe(field.name.trim());
      }
    }
  });

  it("never produces duplicate field names in any genre × type combination", () => {
    for (const genre of [null, ...GENRE_VALUES]) {
      for (const slug of BUILTIN_SLUGS) {
        const names = resolvePresetFields(slug, genre).map((f) => f.name);
        expect(new Set(names).size).toBe(names.length);
      }
    }
  });
});

describe("resolvePresetFields", () => {
  it("returns only the base set when genre is null", () => {
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

describe("applyDetailPreset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockImplementation(async (data) => ({
      id: data.id,
      projectId: data.projectId,
      typeSlug: data.typeSlug,
      name: data.name,
      fieldType: data.fieldType ?? "text",
      fieldConfig: data.fieldConfig ?? null,
      sortOrder: data.sortOrder ?? 0,
      includeInContext: data.includeInContext ?? 0,
      createdAt: "2026-01-01T00:00:00Z",
    }));
  });

  it("inserts every resolved field when none exist yet", async () => {
    mockList.mockResolvedValue([]);
    const expected = resolvePresetFields("character", "Fantasy");

    const result = await applyDetailPreset("proj-1", "character", "Fantasy");

    expect(mockCreate).toHaveBeenCalledTimes(expected.length);
    expect(result.added.map((d) => d.name)).toEqual(
      expected.map((f) => f.name),
    );
    expect(result.skipped).toBe(0);
  });

  it("numbers sortOrder sequentially after the existing maximum", async () => {
    mockList.mockResolvedValue([makeDefinition("既存欄", 5.0)]);

    await applyDetailPreset("proj-1", "character", null);

    const sortOrders = mockCreate.mock.calls.map(([data]) => data.sortOrder);
    expect(sortOrders).toEqual(sortOrders.map((_, i) => 6.0 + i));
  });

  it("maps preset flags onto definition columns", async () => {
    mockList.mockResolvedValue([]);
    const expected = resolvePresetFields("character", null);

    await applyDetailPreset("proj-1", "character", null);

    for (const [i, field] of expected.entries()) {
      const [data] = mockCreate.mock.calls[i];
      expect(data.name).toBe(field.name);
      expect(data.fieldType).toBe(field.fieldType);
      expect(data.includeInContext).toBe(field.includeInContext ? 1 : 0);
      expect(data.projectId).toBe("proj-1");
      expect(data.typeSlug).toBe("character");
      expect(data.id).toBeTruthy();
    }
  });

  it("serializes dropdown options into fieldConfig JSON", async () => {
    mockList.mockResolvedValue([]);

    await applyDetailPreset("proj-1", "character", null);

    const call = mockCreate.mock.calls.find(([data]) => data.name === "役割");
    expect(call).toBeDefined();
    const config = JSON.parse(call![0].fieldConfig as string) as {
      options: string[];
    };
    expect(config.options).toContain("主人公");
  });

  it("skips fields whose names already exist", async () => {
    mockList.mockResolvedValue([makeDefinition("年齢", 3.0)]);

    const result = await applyDetailPreset("proj-1", "character", null);

    const createdNames = mockCreate.mock.calls.map(([data]) => data.name);
    expect(createdNames).not.toContain("年齢");
    expect(result.skipped).toBe(1);
    expect(result.added.length).toBe(
      resolvePresetFields("character", null).length - 1,
    );
  });

  it("adds nothing when every preset field already exists", async () => {
    const existing = resolvePresetFields("character", null).map((f, i) =>
      makeDefinition(f.name, i + 1.0),
    );
    mockList.mockResolvedValue(existing);

    const result = await applyDetailPreset("proj-1", "character", null);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.added).toEqual([]);
    expect(result.skipped).toBe(existing.length);
  });
});
