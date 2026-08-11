import { describe, expect, it } from "vitest";

import {
  BASE_DETAIL_PRESETS,
  BASE_DETAIL_PRESETS_EN,
  resolvePresetFields,
  type DetailFieldPreset,
} from "./detailPresets";

interface PresetSemanticMetadata {
  readonly facetKey: string;
  readonly projectionKind:
    | "scalar-text"
    | "summary-text"
    | "enum"
    | "entity-reference";
  readonly temporalPolicy:
    | "base-only"
    | "phase-on-durable-change"
    | "base-and-phase"
    | "derived"
    | "manual-only";
}

type SemanticallyBoundPreset = DetailFieldPreset & {
  readonly semantic?: PresetSemanticMetadata;
};

function field(
  fields: readonly DetailFieldPreset[],
  name: string,
): SemanticallyBoundPreset {
  const match = fields.find((candidate) => candidate.name === name);
  expect(match, `missing preset field: ${name}`).toBeDefined();
  return match as SemanticallyBoundPreset;
}

describe("Detail preset semantic metadata", () => {
  it("binds Role / 役割 to one locale-independent enum facet", () => {
    const ja = field(resolvePresetFields("character", null, "ja"), "役割");
    const en = field(resolvePresetFields("character", null, "en"), "Role");

    expect(ja.semantic).toEqual({
      facetKey: "role.current",
      projectionKind: "enum",
      temporalPolicy: "base-and-phase",
    });
    expect(en.semantic).toEqual(ja.semantic);
  });

  it("marks Age / 年齢 as a derived scalar rather than a Phase writer", () => {
    const ja = field(resolvePresetFields("character", null, "ja"), "年齢");
    const en = field(resolvePresetFields("character", null, "en"), "Age");

    expect(ja.semantic).toEqual({
      facetKey: "identity.age",
      projectionKind: "scalar-text",
      temporalPolicy: "derived",
    });
    expect(en.semantic).toEqual(ja.semantic);
  });

  it("binds Motivation & goals / 動機・目的 as a durable summarized state", () => {
    const ja = field(
      resolvePresetFields("character", null, "ja"),
      "動機・目的",
    );
    const en = field(
      resolvePresetFields("character", null, "en"),
      "Motivation & goals",
    );

    expect(ja.semantic).toEqual({
      facetKey: "goal.active",
      projectionKind: "summary-text",
      temporalPolicy: "phase-on-durable-change",
    });
    expect(en.semantic).toEqual(ja.semantic);
  });

  it("keeps ja/en base preset semantic metadata structurally aligned", () => {
    for (const typeSlug of Object.keys(BASE_DETAIL_PRESETS)) {
      const ja = BASE_DETAIL_PRESETS[
        typeSlug
      ] as readonly SemanticallyBoundPreset[];
      const en = BASE_DETAIL_PRESETS_EN[
        typeSlug
      ] as readonly SemanticallyBoundPreset[];

      expect(en).toHaveLength(ja.length);
      expect(en.map((preset) => preset.semantic)).toEqual(
        ja.map((preset) => preset.semantic),
      );
    }
  });
});
