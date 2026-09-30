import { resolvePresetFields } from "../detailPresets";
import type {
  DetailProjectionKind,
  DetailTemporalPolicy,
  StateFacet,
} from "./semanticBindingTypes";

export interface PresetSemanticBindingDefinition {
  readonly id: string;
  readonly projectId: string;
  readonly typeSlug: string;
  readonly name: string;
  readonly fieldType: string;
}

export interface PresetSemanticBindingCandidate {
  readonly definitionId: string;
  readonly facetKey: StateFacet;
  readonly projectionKind: DetailProjectionKind;
  readonly temporalPolicy: DetailTemporalPolicy;
}

export interface ResolvePresetSemanticBindingCandidatesInput {
  readonly projectId: string;
  readonly projectLanguage?: string | null;
  readonly projectGenre?: string | null;
  readonly typeSlug: string;
  readonly definitions: readonly PresetSemanticBindingDefinition[];
}

export type PresetSemanticBindingResolutionErrorCode = "project-mismatch";

export class PresetSemanticBindingResolutionError extends Error {
  readonly code: PresetSemanticBindingResolutionErrorCode;

  constructor(code: PresetSemanticBindingResolutionErrorCode, message: string) {
    super(message);
    this.name = "PresetSemanticBindingResolutionError";
    this.code = code;
  }
}

function compareDefinitionId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Finds safe preset candidates for existing Definitions. Matching is exact and
 * locale scoped: no trimming, case folding, translation, or fuzzy similarity.
 */
export function resolvePresetSemanticBindingCandidates({
  projectId,
  projectLanguage,
  projectGenre = null,
  typeSlug,
  definitions,
}: ResolvePresetSemanticBindingCandidatesInput): readonly PresetSemanticBindingCandidate[] {
  if (definitions.some((definition) => definition.projectId !== projectId)) {
    throw new PresetSemanticBindingResolutionError(
      "project-mismatch",
      "Preset semantic binding Definitions belong to another Project",
    );
  }
  const presets = resolvePresetFields(typeSlug, projectGenre, projectLanguage);
  const presetByName = new Map(
    presets
      .filter((preset) => preset.semantic !== undefined)
      .map((preset) => [preset.name, preset] as const),
  );
  const scopedDefinitions = definitions.filter(
    (definition) => definition.typeSlug === typeSlug,
  );
  const definitionsByName = new Map<string, number>();
  for (const definition of scopedDefinitions) {
    definitionsByName.set(
      definition.name,
      (definitionsByName.get(definition.name) ?? 0) + 1,
    );
  }

  const candidates: PresetSemanticBindingCandidate[] = [];
  for (const definition of [...scopedDefinitions].sort((left, right) =>
    compareDefinitionId(left.id, right.id),
  )) {
    const preset = presetByName.get(definition.name);
    if (
      definitionsByName.get(definition.name) !== 1 ||
      !preset?.semantic ||
      preset.fieldType !== definition.fieldType
    ) {
      continue;
    }
    candidates.push(
      Object.freeze({
        definitionId: definition.id,
        facetKey: preset.semantic.facetKey,
        projectionKind: preset.semantic.projectionKind,
        temporalPolicy: preset.semantic.temporalPolicy,
      }),
    );
  }
  return Object.freeze(candidates);
}
