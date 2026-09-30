import type {
  EventHypothesis,
  RawEventSynthesisResult,
} from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import { parseRawEventSynthesisResult } from "./schemas";

export interface NormalizeSynthesisOptions {
  readonly clusterRef: string;
  readonly allowedObservationRefs: ReadonlySet<string>;
  readonly createId?: () => string;
}

/**
 * Normalize a synthesis AI payload into EventHypothesis rows. Unknown
 * observation refs / wrong cluster refs are rejected. Parser-accepted `rumored`
 * actuality remains a hypothesis and is filtered at the proposal gate.
 */
export function normalizeEventSynthesis(
  raw: unknown,
  options: NormalizeSynthesisOptions,
): readonly EventHypothesis[] {
  const parsed = parseRawEventSynthesisResult(raw);
  if (!parsed.ok) return [];
  if (parsed.value.clusterRef !== options.clusterRef) return [];

  const createId = options.createId ?? (() => crypto.randomUUID());
  const hypotheses: EventHypothesis[] = [];

  for (const event of parsed.value.events) {
    const observationRefs = event.observationRefs.filter((ref) =>
      options.allowedObservationRefs.has(ref),
    );
    if (observationRefs.length === 0) continue;
    hypotheses.push({
      hypothesisId: createId(),
      clusterRef: options.clusterRef,
      observationRefs,
      titleSuggestion: event.titleSuggestion,
      summary: event.summary,
      actuality: event.actuality,
      significance: event.significance,
      ...(event.semanticType ? { semanticType: event.semanticType } : {}),
    });
  }

  return hypotheses;
}

export type { RawEventSynthesisResult };
