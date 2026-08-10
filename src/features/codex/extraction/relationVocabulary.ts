export type CodexRelationDirectionalityStored = "directed" | "symmetric";

export interface CodexRelationVocabularyRecord {
  readonly ref: string;
  readonly relationType: string;
  readonly forwardLabel: string;
  readonly inverseLabel: string | null;
  readonly directionality: CodexRelationDirectionalityStored;
}

export const BUILTIN_CODEX_RELATION_VOCABULARY: readonly CodexRelationVocabularyRecord[] =
  [
    {
      ref: "builtin:friend",
      relationType: "friend",
      forwardLabel: "友人",
      inverseLabel: "友人",
      directionality: "symmetric",
    },
    {
      ref: "builtin:family",
      relationType: "family",
      forwardLabel: "家族",
      inverseLabel: "家族",
      directionality: "symmetric",
    },
    {
      ref: "builtin:lover",
      relationType: "lover",
      forwardLabel: "恋人",
      inverseLabel: "恋人",
      directionality: "symmetric",
    },
    {
      ref: "builtin:enemy",
      relationType: "enemy",
      forwardLabel: "敵",
      inverseLabel: "敵",
      directionality: "symmetric",
    },
    {
      ref: "builtin:rival",
      relationType: "rival",
      forwardLabel: "ライバル",
      inverseLabel: "ライバル",
      directionality: "symmetric",
    },
    {
      ref: "builtin:mentor",
      relationType: "mentor",
      forwardLabel: "師匠",
      inverseLabel: "弟子",
      directionality: "directed",
    },
    {
      ref: "builtin:servant",
      relationType: "servant",
      forwardLabel: "従者",
      inverseLabel: "主人",
      directionality: "directed",
    },
    {
      ref: "builtin:parent",
      relationType: "parent",
      forwardLabel: "父",
      inverseLabel: "子",
      directionality: "directed",
    },
  ];

export function normalizeRelationLabel(label: string): string {
  return label.normalize("NFC").trim().replace(/\s+/gu, " ");
}

export interface BuildCodexRelationSemanticKeyInput {
  readonly projectId: string;
  readonly fromCodexId: string;
  readonly toCodexId: string;
  readonly relationType: string;
  readonly directionality: CodexRelationDirectionalityStored;
  readonly forwardLabel: string;
  readonly inverseLabel: string | null;
}

/**
 * Logical uniqueness key for Codex relations.
 * Directed keeps endpoint order; symmetric sorts endpoints.
 * Wire format is stable tab-separated fields (Rust migrate backfill mirrors this).
 */
export function buildCodexRelationSemanticKey(
  input: BuildCodexRelationSemanticKeyInput,
): string {
  const relationType = normalizeRelationLabel(input.relationType);
  const forward = normalizeRelationLabel(input.forwardLabel);
  const inverse = normalizeRelationLabel(input.inverseLabel ?? "");

  if (input.directionality === "symmetric") {
    const [left, right] =
      input.fromCodexId <= input.toCodexId
        ? [input.fromCodexId, input.toCodexId]
        : [input.toCodexId, input.fromCodexId];
    const label = forward || inverse;
    return ["s", input.projectId, left, right, relationType, label].join("\t");
  }

  return [
    "d",
    input.projectId,
    input.fromCodexId,
    input.toCodexId,
    relationType,
    forward,
    inverse,
  ].join("\t");
}

export type ResolvedCodexRelationVocabulary = {
  readonly relationType: string;
  readonly forwardLabel: string;
  readonly inverseLabel: string | null;
  readonly directionality: CodexRelationDirectionalityStored;
  readonly source: "existing" | "builtin" | "custom";
  readonly ref: string;
};

export interface ResolveCodexRelationVocabularyInput {
  readonly predicate: string;
  readonly existingTypes: readonly string[];
  readonly existingLabels: readonly string[];
  readonly builtins?: readonly CodexRelationVocabularyRecord[];
  readonly suggestedDirectionality?: CodexRelationDirectionalityStored;
  readonly suggestedInverseLabel?: string | null;
}

/**
 * Resolve AI predicate text against project labels/types then builtin vocab.
 * Unmatched predicates become custom and require user confirmation later.
 */
export function resolveCodexRelationVocabulary(
  input: ResolveCodexRelationVocabularyInput,
): ResolvedCodexRelationVocabulary {
  const predicate = normalizeRelationLabel(input.predicate);
  const builtins = input.builtins ?? BUILTIN_CODEX_RELATION_VOCABULARY;

  const existingLabel = input.existingLabels.find(
    (label) => normalizeRelationLabel(label) === predicate,
  );
  if (existingLabel) {
    const type =
      input.existingTypes.find(
        (value) => normalizeRelationLabel(value) === predicate,
      ) ??
      input.existingTypes[0] ??
      "custom";
    return {
      relationType: type,
      forwardLabel: existingLabel,
      inverseLabel: input.suggestedInverseLabel ?? null,
      directionality: input.suggestedDirectionality ?? "directed",
      source: "existing",
      ref: `existing:${type}:${existingLabel}`,
    };
  }

  const builtin = builtins.find(
    (record) =>
      normalizeRelationLabel(record.forwardLabel) === predicate ||
      normalizeRelationLabel(record.inverseLabel ?? "") === predicate ||
      normalizeRelationLabel(record.relationType) === predicate,
  );
  if (builtin) {
    return {
      relationType: builtin.relationType,
      forwardLabel: builtin.forwardLabel,
      inverseLabel: builtin.inverseLabel,
      directionality: builtin.directionality,
      source: "builtin",
      ref: builtin.ref,
    };
  }

  return {
    relationType: "custom",
    forwardLabel: predicate,
    inverseLabel: input.suggestedInverseLabel ?? null,
    directionality: input.suggestedDirectionality ?? "directed",
    source: "custom",
    ref: `custom:${predicate}`,
  };
}
