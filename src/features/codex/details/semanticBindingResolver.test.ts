import { describe, expect, it } from "vitest";
import {
  buildDetailDefinitionCatalog,
  type DetailDefinitionCatalogInput,
} from "./detailDefinitionCatalog";
import {
  resolveDetailSemanticBinding,
  type SemanticBindingResolutionError,
} from "./semanticBindingResolver";
import type { DetailSemanticBinding } from "./semanticBindingTypes";
import type { PresetSemanticBindingCandidate } from "./presetSemanticBindings";

function definition(
  id: string,
  name: string,
  overrides: Partial<DetailDefinitionCatalogInput> = {},
): DetailDefinitionCatalogInput {
  return {
    id,
    projectId: "project-1",
    typeSlug: "character",
    name,
    fieldType: "dropdown",
    fieldConfig: JSON.stringify({ options: ["主人公", "主要人物"] }),
    sortOrder: 1,
    ...overrides,
  };
}

function binding(
  definitionId: string,
  overrides: Partial<DetailSemanticBinding> = {},
): DetailSemanticBinding {
  return {
    id: `binding-${definitionId}`,
    projectId: "project-1",
    definitionId,
    facetKey: "role.current",
    projectionKind: "enum",
    temporalPolicy: "base-and-phase",
    source: "user",
    confirmed: true,
    version: 3,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

function preset(
  definitionId: string,
  overrides: Partial<PresetSemanticBindingCandidate> = {},
): PresetSemanticBindingCandidate {
  return {
    definitionId,
    facetKey: "role.current",
    projectionKind: "enum",
    temporalPolicy: "base-and-phase",
    ...overrides,
  };
}

function expectResolutionError(
  run: () => unknown,
  code: SemanticBindingResolutionError["code"],
): void {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({
      name: "SemanticBindingResolutionError",
      code,
    });
    return;
  }
  throw new Error(`Expected SemanticBindingResolutionError(${code})`);
}

describe("resolveDetailSemanticBinding", () => {
  it("resolves one deterministic preset candidate", () => {
    const catalog = buildDetailDefinitionCatalog([
      definition("definition-role", "役割"),
    ]);

    expect(
      resolveDetailSemanticBinding({
        projectId: "project-1",
        typeSlug: "character",
        facetKey: "role.current",
        destination: "phase",
        catalog,
        bindings: [],
        presetCandidates: [preset("definition-role")],
      }),
    ).toMatchObject({
      status: "resolved",
      definitionRef: "D001",
      basis: "preset-binding",
    });
  });

  it("gives a confirmed user binding priority over a preset candidate", () => {
    const catalog = buildDetailDefinitionCatalog([
      definition("definition-preset", "役割", { sortOrder: 1 }),
      definition("definition-user", "現在の立場", { sortOrder: 2 }),
    ]);

    expect(
      resolveDetailSemanticBinding({
        projectId: "project-1",
        typeSlug: "character",
        facetKey: "role.current",
        destination: "phase",
        catalog,
        bindings: [binding("definition-user")],
        presetCandidates: [preset("definition-preset")],
      }),
    ).toMatchObject({
      status: "resolved",
      definitionRef: catalog.definitionRefForId("definition-user"),
      basis: "confirmed-binding",
      bindingStamp: { bindingId: "binding-definition-user", version: 3 },
    });
  });

  it("keeps resolving a confirmed binding after the Definition is renamed", () => {
    const catalog = buildDetailDefinitionCatalog([
      definition("definition-role", "ユーザーが改名した欄"),
    ]);

    expect(
      resolveDetailSemanticBinding({
        projectId: "project-1",
        typeSlug: "character",
        facetKey: "role.current",
        destination: "base",
        catalog,
        bindings: [binding("definition-role", { version: 8 })],
        presetCandidates: [],
      }),
    ).toMatchObject({
      status: "resolved",
      definitionRef: "D001",
      basis: "confirmed-binding",
      bindingStamp: { bindingId: "binding-definition-role", version: 8 },
    });
  });

  it("returns ambiguous when multiple confirmed bindings have equal priority", () => {
    const catalog = buildDetailDefinitionCatalog([
      definition("definition-a", "役割 A", { sortOrder: 1 }),
      definition("definition-b", "役割 B", { sortOrder: 2 }),
    ]);

    const resolution = resolveDetailSemanticBinding({
      projectId: "project-1",
      typeSlug: "character",
      facetKey: "role.current",
      destination: "base",
      catalog,
      bindings: [binding("definition-a"), binding("definition-b")],
      presetCandidates: [],
    });

    expect(resolution).toMatchObject({ status: "ambiguous" });
    if (resolution.status !== "ambiguous") throw new Error("unreachable");
    expect(
      resolution.candidates.map((candidate) => candidate.definitionRef),
    ).toEqual([
      catalog.definitionRefForId("definition-a"),
      catalog.definitionRefForId("definition-b"),
    ]);
  });

  it("does not promote an unconfirmed AI binding", () => {
    const catalog = buildDetailDefinitionCatalog([
      definition("definition-role", "役割"),
    ]);

    expect(
      resolveDetailSemanticBinding({
        projectId: "project-1",
        typeSlug: "character",
        facetKey: "role.current",
        destination: "base",
        catalog,
        bindings: [
          binding("definition-role", {
            source: "reviewed-ai",
            confirmed: false,
          }),
        ],
        presetCandidates: [],
      }),
    ).toMatchObject({ status: "unmapped", reason: "no-confirmed-binding" });
  });

  it("reports a binding whose temporal policy forbids the destination", () => {
    const catalog = buildDetailDefinitionCatalog([
      definition("definition-role", "役割"),
    ]);

    expect(
      resolveDetailSemanticBinding({
        projectId: "project-1",
        typeSlug: "character",
        facetKey: "role.current",
        destination: "phase",
        catalog,
        bindings: [
          binding("definition-role", {
            temporalPolicy: "base-only",
          }),
        ],
        presetCandidates: [],
      }),
    ).toMatchObject({ status: "unmapped", reason: "temporal-policy" });
  });

  it("rejects bindings to unknown Definition IDs", () => {
    const catalog = buildDetailDefinitionCatalog([
      definition("definition-role", "役割"),
    ]);

    expectResolutionError(
      () =>
        resolveDetailSemanticBinding({
          projectId: "project-1",
          typeSlug: "character",
          facetKey: "role.current",
          destination: "base",
          catalog,
          bindings: [binding("definition-missing")],
          presetCandidates: [],
        }),
      "unknown-definition",
    );
  });

  it("rejects a catalog owned by another Project", () => {
    const catalog = buildDetailDefinitionCatalog([
      definition("definition-role", "役割", { projectId: "project-2" }),
    ]);

    expectResolutionError(
      () =>
        resolveDetailSemanticBinding({
          projectId: "project-1",
          typeSlug: "character",
          facetKey: "role.current",
          destination: "base",
          catalog,
          bindings: [],
          presetCandidates: [],
        }),
      "project-mismatch",
    );
  });

  it("rejects a projection kind incompatible with the field type", () => {
    const catalog = buildDetailDefinitionCatalog([
      definition("definition-text", "役割", {
        fieldType: "text",
        fieldConfig: null,
      }),
    ]);

    expectResolutionError(
      () =>
        resolveDetailSemanticBinding({
          projectId: "project-1",
          typeSlug: "character",
          facetKey: "role.current",
          destination: "base",
          catalog,
          bindings: [binding("definition-text")],
          presetCandidates: [],
        }),
      "projection-kind-mismatch",
    );
  });

  it("rejects a catalog owned by another Codex type", () => {
    const catalog = buildDetailDefinitionCatalog([
      definition("definition-role", "Role", { typeSlug: "location" }),
    ]);

    expectResolutionError(
      () =>
        resolveDetailSemanticBinding({
          projectId: "project-1",
          typeSlug: "character",
          facetKey: "role.current",
          destination: "base",
          catalog,
          bindings: [],
          presetCandidates: [],
        }),
      "type-mismatch",
    );
  });
});
