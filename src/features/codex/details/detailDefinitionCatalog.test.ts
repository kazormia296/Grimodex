import { describe, expect, it } from "vitest";
import {
  buildDetailDefinitionCatalog,
  type DetailDefinitionCatalogError,
  type DetailDefinitionCatalogInput,
} from "./detailDefinitionCatalog";

function definition(
  overrides: Partial<DetailDefinitionCatalogInput> = {},
): DetailDefinitionCatalogInput {
  return {
    id: "definition-role",
    projectId: "project-secret-id",
    typeSlug: "character",
    name: "役割",
    fieldType: "dropdown",
    fieldConfig: JSON.stringify({ options: ["主人公", "主要人物"] }),
    sortOrder: 1,
    ...overrides,
  };
}

function expectCatalogError(
  run: () => unknown,
  code: DetailDefinitionCatalogError["code"],
): void {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({
      name: "DetailDefinitionCatalogError",
      code,
    });
    return;
  }
  throw new Error(`Expected DetailDefinitionCatalogError(${code})`);
}

describe("buildDetailDefinitionCatalog", () => {
  it("assigns deterministic opaque refs after sortOrder + id ordering", () => {
    const inputs = [
      definition({ id: "definition-z", name: "Z", sortOrder: 2 }),
      definition({ id: "definition-b", name: "B", sortOrder: 1 }),
      definition({ id: "definition-a", name: "A", sortOrder: 1 }),
    ];

    const first = buildDetailDefinitionCatalog(inputs);
    const second = buildDetailDefinitionCatalog([...inputs].reverse());

    expect(first.records.map((record) => record.definitionRef)).toEqual([
      "D001",
      "D002",
      "D003",
    ]);
    expect(first.records).toEqual(second.records);
    expect(first.definitionRefForId("definition-a")).toBe("D001");
    expect(first.definitionRefForId("definition-b")).toBe("D002");
    expect(first.definitionRefForId("definition-z")).toBe("D003");
    expect(first.definitionIdForRef("D001")).toBe("definition-a");
  });

  it("keeps real database ids out of the model-safe records", () => {
    const catalog = buildDetailDefinitionCatalog([definition()]);
    const serialized = JSON.stringify(catalog);

    expect(serialized).not.toContain("definition-role");
    expect(serialized).not.toContain("project-secret-id");
    expect(catalog.records[0]).not.toHaveProperty("definitionId");
    expect(catalog.records[0]).not.toHaveProperty("projectId");
    expect(catalog.definitionIdForRef("D001")).toBe("definition-role");
  });

  it("maps dropdown labels to refs without exposing labels as identifiers", () => {
    const catalog = buildDetailDefinitionCatalog([definition()]);
    const record = catalog.recordByRef("D001");

    expect(record).toMatchObject({
      definitionRef: "D001",
      name: "役割",
      fieldType: "dropdown",
      options: [
        { optionRef: "O001", label: "主人公" },
        { optionRef: "O002", label: "主要人物" },
      ],
    });
    expect(catalog.optionByRef("D001", "O002")).toEqual({
      optionRef: "O002",
      label: "主要人物",
    });
    expect(catalog.optionByRef("D001", "主人公")).toBeUndefined();
  });

  it("deep-freezes the catalog records used across async task boundaries", () => {
    const catalog = buildDetailDefinitionCatalog([definition()]);
    const record = catalog.records[0];

    expect(Object.isFrozen(catalog.records)).toBe(true);
    expect(Object.isFrozen(record)).toBe(true);
    expect(record.fieldType).toBe("dropdown");
    if (record.fieldType !== "dropdown") throw new Error("unreachable");
    expect(Object.isFrozen(record.options)).toBe(true);
    expect(Object.isFrozen(record.options[0])).toBe(true);
  });

  it("rejects unknown field types instead of weakening them to text", () => {
    expectCatalogError(
      () =>
        buildDetailDefinitionCatalog([
          definition({ fieldType: "made-up-field-type" }),
        ]),
      "unsupported-field-type",
    );
  });

  it.each([
    ["invalid JSON", "{broken", "invalid-field-config"],
    ["missing options", JSON.stringify({}), "invalid-dropdown-options"],
    [
      "empty options",
      JSON.stringify({ options: [] }),
      "invalid-dropdown-options",
    ],
    [
      "non-string option",
      JSON.stringify({ options: ["主人公", 42] }),
      "invalid-dropdown-options",
    ],
    [
      "duplicate option",
      JSON.stringify({ options: ["主人公", "主人公"] }),
      "duplicate-dropdown-option",
    ],
  ] as const)("rejects %s dropdown config", (_label, fieldConfig, code) => {
    expectCatalogError(
      () => buildDetailDefinitionCatalog([definition({ fieldConfig })]),
      code,
    );
  });

  it("returns undefined for unknown opaque refs", () => {
    const catalog = buildDetailDefinitionCatalog([definition()]);

    expect(catalog.recordByRef("D999")).toBeUndefined();
    expect(catalog.definitionIdForRef("D999")).toBeUndefined();
    expect(catalog.definitionRefForId("unknown-definition")).toBeUndefined();
    expect(catalog.optionByRef("D001", "O999")).toBeUndefined();
  });

  it("rejects a catalog that mixes Project authorities", () => {
    expectCatalogError(
      () =>
        buildDetailDefinitionCatalog([
          definition(),
          definition({ id: "definition-foreign", projectId: "project-2" }),
        ]),
      "mixed-project",
    );
  });

  it("rejects a catalog that mixes Codex types", () => {
    expectCatalogError(
      () =>
        buildDetailDefinitionCatalog([
          definition(),
          definition({ id: "definition-location", typeSlug: "location" }),
        ]),
      "mixed-type",
    );
  });
});
