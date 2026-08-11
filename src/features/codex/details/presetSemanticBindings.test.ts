import { describe, expect, it } from "vitest";
import {
  resolvePresetSemanticBindingCandidates,
  type PresetSemanticBindingDefinition,
} from "./presetSemanticBindings";

function definition(
  overrides: Partial<PresetSemanticBindingDefinition> = {},
): PresetSemanticBindingDefinition {
  return {
    id: "definition-role",
    projectId: "project-1",
    typeSlug: "character",
    name: "役割",
    fieldType: "dropdown",
    ...overrides,
  };
}

describe("resolvePresetSemanticBindingCandidates", () => {
  it("matches a Japanese preset by exact type, name, and field type", () => {
    expect(
      resolvePresetSemanticBindingCandidates({
        projectId: "project-1",
        projectLanguage: "ja",
        typeSlug: "character",
        definitions: [definition()],
      }),
    ).toEqual([
      {
        definitionId: "definition-role",
        facetKey: "role.current",
        projectionKind: "enum",
        temporalPolicy: "base-and-phase",
      },
    ]);
  });

  it("selects the English preset registry only for en languages", () => {
    const english = definition({
      id: "definition-role-en",
      name: "Role",
    });

    expect(
      resolvePresetSemanticBindingCandidates({
        projectId: "project-1",
        projectLanguage: "en-US",
        typeSlug: "character",
        definitions: [english],
      }),
    ).toEqual([
      expect.objectContaining({
        definitionId: "definition-role-en",
        facetKey: "role.current",
      }),
    ]);
    expect(
      resolvePresetSemanticBindingCandidates({
        projectId: "project-1",
        projectLanguage: "ja",
        typeSlug: "character",
        definitions: [english],
      }),
    ).toEqual([]);
  });

  it.each(["役割 ", " 役割", "役 割", "Role"])(
    "does not normalize or fuzzy-match the custom name %s",
    (name) => {
      expect(
        resolvePresetSemanticBindingCandidates({
          projectId: "project-1",
          projectLanguage: "ja",
          typeSlug: "character",
          definitions: [definition({ name })],
        }),
      ).toEqual([]);
    },
  );

  it("does not bind an exact name whose field type is incompatible", () => {
    expect(
      resolvePresetSemanticBindingCandidates({
        projectId: "project-1",
        projectLanguage: "ja",
        typeSlug: "character",
        definitions: [definition({ fieldType: "text" })],
      }),
    ).toEqual([]);
  });

  it("does not cross type boundaries", () => {
    expect(
      resolvePresetSemanticBindingCandidates({
        projectId: "project-1",
        projectLanguage: "ja",
        typeSlug: "location",
        definitions: [definition()],
      }),
    ).toEqual([]);
  });

  it("does not auto-bind an exact preset name when multiple Definitions share it", () => {
    expect(
      resolvePresetSemanticBindingCandidates({
        projectId: "project-1",
        projectLanguage: "ja",
        typeSlug: "character",
        definitions: [
          definition({ id: "definition-role-a" }),
          definition({ id: "definition-role-b" }),
        ],
      }),
    ).toEqual([]);
  });

  it("rejects Definitions from another Project authority", () => {
    expect(() =>
      resolvePresetSemanticBindingCandidates({
        projectId: "project-1",
        projectLanguage: "ja",
        typeSlug: "character",
        definitions: [definition({ projectId: "project-2" })],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "project-mismatch",
      }),
    );
  });
});
