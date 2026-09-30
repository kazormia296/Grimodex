import { describe, expect, it } from "vitest";
import {
  filterKnownTypeRefs,
  resolveEntityType,
  type KnowledgeTypeCatalogRecord,
} from "./entityResolver";
import type { ExistingEntityCatalogRecord } from "./existingEntityMatcher";

function typeEntry(
  overrides: Partial<KnowledgeTypeCatalogRecord> &
    Pick<KnowledgeTypeCatalogRecord, "ref" | "slug" | "label">,
): KnowledgeTypeCatalogRecord {
  return {
    sourceKey: `type:${overrides.slug}`,
    coarseClassHints: ["person"],
    expectedVersion: 1,
    ...overrides,
  };
}

function existing(
  overrides: Partial<ExistingEntityCatalogRecord> &
    Pick<ExistingEntityCatalogRecord, "ref" | "name" | "typeRef">,
): ExistingEntityCatalogRecord {
  return {
    sourceKey: `db:${overrides.ref}`,
    aliases: [],
    expectedVersion: 1,
    ...overrides,
  };
}

describe("resolveEntityType", () => {
  const catalog = [
    typeEntry({
      ref: "T0001",
      slug: "character",
      label: "登場人物",
      coarseClassHints: ["person"],
    }),
    typeEntry({
      ref: "T0002",
      slug: "location",
      label: "場所",
      coarseClassHints: ["place"],
    }),
    typeEntry({
      ref: "T0003",
      slug: "knight",
      label: "騎士",
      coarseClassHints: ["person"],
    }),
  ];

  it("keeps the existing entry type when binding existing", () => {
    const result = resolveEntityType({
      existingResolution: {
        status: "resolved",
        ref: "K0001",
        method: "exact-name",
      },
      existingCatalog: [
        existing({ ref: "K0001", name: "ライカ", typeRef: "T0003" }),
      ],
      typeCatalog: catalog,
      suggestedTypeRefs: ["T0001"],
    });
    expect(result).toEqual({ status: "resolved", typeRef: "T0003" });
  });

  it("rejects unknown type refs", () => {
    expect(filterKnownTypeRefs(["T0001", "T9999"], catalog)).toEqual(["T0001"]);
    const result = resolveEntityType({
      existingResolution: { status: "none" },
      typeCatalog: catalog,
      suggestedTypeRefs: ["T9999"],
    });
    expect(result).toEqual({ status: "unresolved" });
  });

  it("marks multiple valid type suggestions as ambiguous", () => {
    const result = resolveEntityType({
      existingResolution: { status: "none" },
      typeCatalog: catalog,
      suggestedTypeRefs: ["T0001", "T0003"],
    });
    expect(result).toEqual({
      status: "ambiguous",
      candidates: ["T0001", "T0003"],
    });
  });

  it("does not auto-create a type when nothing fits", () => {
    const result = resolveEntityType({
      existingResolution: { status: "none" },
      typeCatalog: catalog,
      suggestedTypeRefs: [],
      coarseClass: "item",
    });
    expect(result).toEqual({ status: "unresolved" });
  });

  it("resolves a unique coarse-class type when no suggestion is given", () => {
    const result = resolveEntityType({
      existingResolution: { status: "none" },
      typeCatalog: catalog,
      coarseClass: "place",
    });
    expect(result).toEqual({ status: "resolved", typeRef: "T0002" });
  });
});
