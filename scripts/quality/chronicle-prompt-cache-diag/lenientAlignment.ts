/**
 * 診断（diagnostic only）専用。本番の採点（`evaluateProductionChronicleArtifacts`）は evidence の
 * quote が Gold と完全一致した観測だけを Gold に対応づける。model によっては句読点の違いなどで
 * 完全一致せず、TP が 0 に張り付いて「変わったか」を測れない。そこで quote が（同じ document 内で）
 * 包含関係にあれば対応づける緩い対応づけで、意味 field（actuality・採否）の一致を数える。
 * 本番の採点・certification の判定には使わない。件数だけを返し、本文は返さない。
 */
import type { NarrativeEvalCaseV1 } from "@/features/narrative-extraction/eval/types";

export interface LenientObservation {
  readonly localId: string;
  readonly evidence: readonly {
    readonly sourceRef: string;
    readonly quote: string;
  }[];
  readonly payload: { readonly actuality: string };
}

export interface LenientAlignmentCounts {
  /** Gold の required のうち、包含で対応づく観測が 1 つ以上あるもの。 */
  readonly requiredCovered: number;
  /** そのうち、対応づく観測の actuality が Gold と一致するもの。 */
  readonly actualityMatch: number;
  /** そのうち、対応づく観測が属する仮説の significance が Gold と一致するもの。 */
  readonly significanceMatch: number;
  /** そのうち、対応づく観測が属する仮説の提案の有無が Gold の proposalGate と一致するもの。 */
  readonly proposalGateMatch: number;
  /** forbidden（同じ semanticKey の required の evidence に対応づく観測が、forbidden の定める field をすべて満たす）の数。 */
  readonly forbiddenClaimed: number;
}

function overlaps(left: string, right: string): boolean {
  return (
    left.length > 0 &&
    right.length > 0 &&
    (left.includes(right) || right.includes(left))
  );
}

export function lenientAlignmentCounts(input: {
  readonly evalCase: NarrativeEvalCaseV1;
  readonly observations: readonly LenientObservation[];
  readonly hypotheses: readonly {
    readonly hypothesisId: string;
    readonly significance: string;
    readonly observationRefs: readonly string[];
  }[];
  readonly proposedHypothesisIds: ReadonlySet<string>;
  readonly documentIdBySourceRef: ReadonlyMap<string, string>;
}): LenientAlignmentCounts {
  const proposedObservationIds = new Set(
    input.hypotheses
      .filter((hypothesis) =>
        input.proposedHypothesisIds.has(hypothesis.hypothesisId),
      )
      .flatMap((hypothesis) => hypothesis.observationRefs),
  );
  const matching = (expected: {
    dimensions: { evidence?: readonly { documentId: string; quote: string }[] };
  }) =>
    input.observations.filter((observation) =>
      observation.evidence.some((evidence) => {
        const documentId = input.documentIdBySourceRef.get(evidence.sourceRef);
        return (expected.dimensions.evidence ?? []).some(
          (gold) =>
            gold.documentId === documentId &&
            overlaps(gold.quote, evidence.quote),
        );
      }),
    );
  let requiredCovered = 0;
  let actualityMatch = 0;
  let proposalGateMatch = 0;
  let significanceMatch = 0;
  const bySemanticKey = new Map<string, readonly LenientObservation[]>();
  for (const expected of input.evalCase.expected.observations.required) {
    const observations = matching(expected);
    bySemanticKey.set(expected.semanticKey, observations);
    if (observations.length === 0) continue;
    requiredCovered += 1;
    const wantedActuality = expected.dimensions.actuality;
    if (
      wantedActuality === undefined ||
      observations.some(
        (observation) => observation.payload.actuality === wantedActuality,
      )
    ) {
      actualityMatch += 1;
    }
    const wantedSignificance = expected.dimensions.significance;
    if (
      wantedSignificance === undefined ||
      observations.some((observation) =>
        input.hypotheses.some(
          (hypothesis) =>
            hypothesis.observationRefs.includes(observation.localId) &&
            hypothesis.significance === wantedSignificance,
        ),
      )
    ) {
      significanceMatch += 1;
    }
    const wantedGate = expected.dimensions.proposalGate;
    if (
      wantedGate === undefined ||
      observations.some(
        (observation) =>
          (proposedObservationIds.has(observation.localId)
            ? "propose"
            : "suppress") === wantedGate,
      )
    ) {
      proposalGateMatch += 1;
    }
  }
  let forbiddenClaimed = 0;
  for (const forbidden of input.evalCase.expected.observations.forbidden) {
    const observations = bySemanticKey.get(forbidden.semanticKey) ?? [];
    const { actuality, proposalGate, significance } = forbidden.dimensions;
    // forbidden が定める field（actuality・proposalGate・significance）をすべて満たす観測があれば主張とみなす。
    if (
      observations.some(
        (observation) =>
          (actuality === undefined ||
            observation.payload.actuality === actuality) &&
          (proposalGate === undefined ||
            (proposedObservationIds.has(observation.localId)
              ? "propose"
              : "suppress") === proposalGate) &&
          (significance === undefined ||
            input.hypotheses.some(
              (hypothesis) =>
                hypothesis.observationRefs.includes(observation.localId) &&
                hypothesis.significance === significance,
            )),
      )
    ) {
      forbiddenClaimed += 1;
    }
  }
  return {
    requiredCovered,
    actualityMatch,
    significanceMatch,
    proposalGateMatch,
    forbiddenClaimed,
  };
}
