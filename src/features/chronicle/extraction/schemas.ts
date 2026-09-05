import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import type { RawEventSynthesisResult } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";

/**
 * Model-visible v2 observation output. Evidence coordinates are opaque,
 * request-bound IDs; code resolves them before constructing the existing raw
 * observation shape.
 */
export interface RawChronicleEventObservationEvidenceRefs {
  readonly localId: string;
  readonly evidenceRefs: readonly string[];
  readonly assertion: RawChronicleEventObservation["assertion"];
  readonly payload: RawChronicleEventObservation["payload"];
}

const OBSERVATION_ACTUALITIES = [
  "actual",
  "planned",
  "intended",
  "attempted",
  "prevented",
  "hypothetical",
  "counterfactual",
  "dreamed",
  "unknown",
] as const;

const DURATION_KINDS = [
  "instant",
  "bounded-interval",
  "ongoing-process",
  "unknown",
] as const;

const HYPOTHESIS_ACTUALITIES = ["actual", "attempted", "prevented"] as const;

const SIGNIFICANCES = ["major", "scene-level", "minor", "incidental"] as const;

const SYNTHESIS_RESOLUTIONS = [
  "single-event",
  "multiple-events",
  "reference-to-event",
  "unresolved",
] as const;

const NARRATIVE_FRAMES = [
  "story-world",
  "flashback",
  "dream",
  "reported",
  "hypothetical",
  "unknown",
] as const;

export type SchemaValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return (
    typeof value === "string" && (allowed as readonly string[]).includes(value)
  );
}

function parseEvidence(
  value: unknown,
  path: string,
  errors: string[],
): RawChronicleEventObservation["evidence"][number] | null {
  if (!isRecord(value)) {
    errors.push(`${path}: expected object`);
    return null;
  }
  if (typeof value.sourceRef !== "string" || value.sourceRef.length === 0) {
    errors.push(`${path}.sourceRef: non-empty string required`);
    return null;
  }
  if (typeof value.quote !== "string" || value.quote.length === 0) {
    errors.push(`${path}.quote: non-empty string required`);
    return null;
  }
  return {
    sourceRef: value.sourceRef,
    quote: value.quote,
    ...(typeof value.prefix === "string" ? { prefix: value.prefix } : {}),
    ...(typeof value.suffix === "string" ? { suffix: value.suffix } : {}),
  };
}

function parseParticipant(
  value: unknown,
  path: string,
  errors: string[],
): RawChronicleEventObservation["payload"]["participants"][number] | null {
  if (!isRecord(value)) {
    errors.push(`${path}: expected object`);
    return null;
  }
  if (typeof value.surface !== "string" || value.surface.trim().length === 0) {
    errors.push(`${path}.surface: non-empty string required`);
    return null;
  }
  if (typeof value.role !== "string" || value.role.trim().length === 0) {
    errors.push(`${path}.role: non-empty string required`);
    return null;
  }
  return { surface: value.surface.trim(), role: value.role.trim() };
}

function parseAssertion(
  value: unknown,
  path: string,
  errors: string[],
): RawChronicleEventObservation["assertion"] | null {
  if (!isRecord(value)) {
    errors.push(`${path}: expected object`);
    return null;
  }
  const attribution = value.attribution;
  if (
    attribution !== "narrator" &&
    attribution !== "unknown" &&
    !(typeof attribution === "string" && attribution.startsWith("character:"))
  ) {
    errors.push(`${path}.attribution: invalid`);
    return null;
  }
  if (!isOneOf(value.narrativeFrame, NARRATIVE_FRAMES)) {
    errors.push(`${path}.narrativeFrame: invalid`);
    return null;
  }
  return {
    attribution:
      attribution as RawChronicleEventObservation["assertion"]["attribution"],
    narrativeFrame: value.narrativeFrame,
  };
}

const ID_OBSERVATION_KEYS = new Set([
  "localId",
  "evidenceRefs",
  "assertion",
  "payload",
]);

/** Validate one evidenceRefs-only model observation. */
export function parseRawChronicleEventObservationEvidenceRefs(
  value: unknown,
): SchemaValidationResult<RawChronicleEventObservationEvidenceRefs> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["root: expected object"] };
  }
  for (const key of Object.keys(value)) {
    if (!ID_OBSERVATION_KEYS.has(key)) {
      errors.push(`root.${key}: field is not allowed in citation-ID mode`);
    }
  }
  if (typeof value.localId !== "string" || value.localId.length === 0) {
    errors.push("localId: non-empty string required");
  }
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0) {
    errors.push("evidenceRefs: non-empty array required");
  }
  const evidenceRefs: string[] = [];
  const seenRefs = new Set<string>();
  if (Array.isArray(value.evidenceRefs)) {
    for (const [index, ref] of value.evidenceRefs.entries()) {
      if (typeof ref !== "string" || ref.trim().length === 0) {
        errors.push(`evidenceRefs[${index}]: non-empty string required`);
        continue;
      }
      if (seenRefs.has(ref)) {
        errors.push(`evidenceRefs[${index}]: duplicate reference`);
        continue;
      }
      seenRefs.add(ref);
      evidenceRefs.push(ref);
    }
  }

  // Reuse the canonical claim parser so v1 and v2 agree on all non-evidence
  // fields. The placeholder never escapes this function.
  const parsed = parseRawChronicleEventObservation({
    ...value,
    evidence: [{ sourceRef: "citation-id-placeholder", quote: "placeholder" }],
  });
  if (!parsed.ok) errors.push(...parsed.errors);
  if (errors.length > 0 || !parsed.ok) return { ok: false, errors };
  return {
    ok: true,
    value: {
      localId: parsed.value.localId,
      evidenceRefs,
      assertion: parsed.value.assertion,
      payload: parsed.value.payload,
    },
  };
}

/** Validate a complete evidenceRefs-only model response. */
export function parseRawChronicleEventObservationIdList(
  value: unknown,
): SchemaValidationResult<readonly RawChronicleEventObservationEvidenceRefs[]> {
  if (!isRecord(value) || !Array.isArray(value.observations)) {
    return { ok: false, errors: ["observations: array required"] };
  }
  const rootKeys = Object.keys(value);
  if (rootKeys.some((key) => key !== "observations")) {
    return {
      ok: false,
      errors: rootKeys
        .filter((key) => key !== "observations")
        .map((key) => `root.${key}: field is not allowed in citation-ID mode`),
    };
  }
  const observations: RawChronicleEventObservationEvidenceRefs[] = [];
  const errors: string[] = [];
  for (const [index, item] of value.observations.entries()) {
    const parsed = parseRawChronicleEventObservationEvidenceRefs(item);
    if (!parsed.ok) {
      errors.push(
        ...parsed.errors.map((error) => `observations[${index}].${error}`),
      );
      continue;
    }
    observations.push(parsed.value);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: observations };
}

/** Validate one raw observation object from AI JSON. */
export function parseRawChronicleEventObservation(
  value: unknown,
): SchemaValidationResult<RawChronicleEventObservation> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["root: expected object"] };
  }
  if (typeof value.localId !== "string" || value.localId.length === 0) {
    errors.push("localId: non-empty string required");
  }
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
    errors.push("evidence: non-empty array required");
  }
  const evidence = Array.isArray(value.evidence)
    ? value.evidence
        .map((item, index) => parseEvidence(item, `evidence[${index}]`, errors))
        .filter(
          (item): item is RawChronicleEventObservation["evidence"][number] =>
            item !== null,
        )
    : [];
  const assertion = parseAssertion(value.assertion, "assertion", errors);
  if (!isRecord(value.payload)) {
    errors.push("payload: expected object");
    return { ok: false, errors };
  }
  const payload = value.payload;
  if (
    typeof payload.predicate !== "string" ||
    payload.predicate.trim().length === 0
  ) {
    errors.push("payload.predicate: non-empty string required");
  }
  if (!isOneOf(payload.actuality, OBSERVATION_ACTUALITIES)) {
    errors.push("payload.actuality: invalid");
  }
  if (!isOneOf(payload.durationKind, DURATION_KINDS)) {
    errors.push("payload.durationKind: invalid");
  }
  if (!Array.isArray(payload.participants)) {
    errors.push("payload.participants: array required");
  }
  if (!Array.isArray(payload.temporalExpressions)) {
    errors.push("payload.temporalExpressions: array required");
  }
  const participants = Array.isArray(payload.participants)
    ? payload.participants
        .map((item, index) =>
          parseParticipant(item, `payload.participants[${index}]`, errors),
        )
        .filter(
          (
            item,
          ): item is RawChronicleEventObservation["payload"]["participants"][number] =>
            item !== null,
        )
    : [];
  const temporalExpressions = Array.isArray(payload.temporalExpressions)
    ? payload.temporalExpressions.filter(
        (item): item is string => typeof item === "string",
      )
    : [];

  if (errors.length > 0 || !assertion || evidence.length === 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      localId: value.localId as string,
      evidence,
      assertion,
      payload: {
        predicate: (payload.predicate as string).trim(),
        ...(typeof payload.semanticType === "string"
          ? { semanticType: payload.semanticType.trim() }
          : {}),
        actuality:
          payload.actuality as RawChronicleEventObservation["payload"]["actuality"],
        participants,
        ...(typeof payload.locationSurface === "string"
          ? { locationSurface: payload.locationSurface.trim() }
          : {}),
        temporalExpressions,
        durationKind:
          payload.durationKind as RawChronicleEventObservation["payload"]["durationKind"],
      },
    },
  };
}

export function parseRawChronicleEventObservationList(
  value: unknown,
): SchemaValidationResult<readonly RawChronicleEventObservation[]> {
  if (!isRecord(value) || !Array.isArray(value.observations)) {
    return { ok: false, errors: ["observations: array required"] };
  }
  const observations: RawChronicleEventObservation[] = [];
  const errors: string[] = [];
  for (const [index, item] of value.observations.entries()) {
    const parsed = parseRawChronicleEventObservation(item);
    if (!parsed.ok) {
      errors.push(
        ...parsed.errors.map((error) => `observations[${index}].${error}`),
      );
      continue;
    }
    observations.push(parsed.value);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: observations };
}

/** Validate one synthesis result object from AI JSON. */
export function parseRawEventSynthesisResult(
  value: unknown,
): SchemaValidationResult<RawEventSynthesisResult> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["root: expected object"] };
  }
  if (typeof value.clusterRef !== "string" || value.clusterRef.length === 0) {
    errors.push("clusterRef: non-empty string required");
  }
  if (!isOneOf(value.resolution, SYNTHESIS_RESOLUTIONS)) {
    errors.push("resolution: invalid");
  }
  if (!Array.isArray(value.events)) {
    errors.push("events: array required");
  }
  const events: RawEventSynthesisResult["events"][number][] = [];
  if (Array.isArray(value.events)) {
    for (const [index, raw] of value.events.entries()) {
      if (!isRecord(raw)) {
        errors.push(`events[${index}]: expected object`);
        continue;
      }
      if (
        !Array.isArray(raw.observationRefs) ||
        raw.observationRefs.length === 0
      ) {
        errors.push(
          `events[${index}].observationRefs: non-empty array required`,
        );
        continue;
      }
      const observationRefs = raw.observationRefs.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      );
      if (observationRefs.length === 0) {
        errors.push(`events[${index}].observationRefs: no valid refs`);
        continue;
      }
      if (
        typeof raw.titleSuggestion !== "string" ||
        raw.titleSuggestion.trim().length === 0
      ) {
        errors.push(`events[${index}].titleSuggestion: required`);
        continue;
      }
      if (typeof raw.summary !== "string" || raw.summary.trim().length === 0) {
        errors.push(`events[${index}].summary: required`);
        continue;
      }
      if (!isOneOf(raw.actuality, HYPOTHESIS_ACTUALITIES)) {
        errors.push(`events[${index}].actuality: invalid`);
        continue;
      }
      if (!isOneOf(raw.significance, SIGNIFICANCES)) {
        errors.push(`events[${index}].significance: invalid`);
        continue;
      }
      events.push({
        observationRefs,
        titleSuggestion: raw.titleSuggestion.trim(),
        summary: raw.summary.trim(),
        actuality: raw.actuality,
        significance: raw.significance,
        ...(typeof raw.semanticType === "string"
          ? { semanticType: raw.semanticType.trim() }
          : {}),
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      clusterRef: value.clusterRef as string,
      resolution: value.resolution as RawEventSynthesisResult["resolution"],
      events,
    },
  };
}
