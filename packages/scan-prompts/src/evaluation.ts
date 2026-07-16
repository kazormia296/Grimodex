import type { EvidenceRef, ScanEntity } from "@grimodex/scan-contract";

export interface ScanGoldCase {
  id: string;
  expectedEntities: Array<{ name: string; aliases: string[] }>;
  expectedEvidence: EvidenceRef[];
}

export interface ScanEvaluationScore {
  entityRecall: number;
  aliasPrecision: number;
  evidenceValidity: number;
  jsonValidity: number;
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

export function scoreScanCase(
  gold: ScanGoldCase,
  predicted: readonly ScanEntity[],
  predictedEvidence: readonly EvidenceRef[],
  jsonValid: boolean,
): ScanEvaluationScore {
  const predictedNames = new Set(
    predicted.map((entity) => normalized(entity.name)),
  );
  const entityHits = gold.expectedEntities.filter((entity) =>
    predictedNames.has(normalized(entity.name)),
  ).length;
  const entityRecall =
    gold.expectedEntities.length === 0
      ? 1
      : entityHits / gold.expectedEntities.length;
  const expectedAliases = new Set(
    gold.expectedEntities.flatMap((entity) => entity.aliases.map(normalized)),
  );
  const predictedAliases = predicted.flatMap((entity) =>
    entity.aliases.map(normalized),
  );
  const aliasHits = predictedAliases.filter((alias) =>
    expectedAliases.has(alias),
  ).length;
  const aliasPrecision =
    predictedAliases.length === 0
      ? expectedAliases.size === 0
        ? 1
        : 0
      : aliasHits / predictedAliases.length;
  const validEvidence = predictedEvidence.filter((evidence) =>
    gold.expectedEvidence.some(
      (expected) =>
        expected.sectionId === evidence.sectionId &&
        expected.paragraphId === evidence.paragraphId,
    ),
  ).length;
  const evidenceValidity =
    predictedEvidence.length === 0
      ? 0
      : validEvidence / predictedEvidence.length;
  return {
    entityRecall,
    aliasPrecision,
    evidenceValidity,
    jsonValidity: jsonValid ? 1 : 0,
  };
}

export function averageEvaluation(
  scores: readonly ScanEvaluationScore[],
): ScanEvaluationScore {
  if (scores.length === 0)
    return {
      entityRecall: 0,
      aliasPrecision: 0,
      evidenceValidity: 0,
      jsonValidity: 0,
    };
  return {
    entityRecall:
      scores.reduce((sum, score) => sum + score.entityRecall, 0) /
      scores.length,
    aliasPrecision:
      scores.reduce((sum, score) => sum + score.aliasPrecision, 0) /
      scores.length,
    evidenceValidity:
      scores.reduce((sum, score) => sum + score.evidenceValidity, 0) /
      scores.length,
    jsonValidity:
      scores.reduce((sum, score) => sum + score.jsonValidity, 0) /
      scores.length,
  };
}
