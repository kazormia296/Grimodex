import { extractJsonObject } from "@/prompts/shared/jsonContract";
import {
  parseRawChronicleEventObservation,
  parseRawChronicleEventObservationList,
  parseRawEventSynthesisResult,
} from "@/features/chronicle/extraction/schemas";
import { normalizeEventSynthesis } from "@/features/chronicle/extraction/eventSynthesis";
import { normalizeWindowObservations } from "@/features/chronicle/extraction/windowExtractor";

export type ChronicleResponseJsonStatus =
  | "empty"
  | "object-not-found"
  | "root-not-object"
  | "unbalanced-object"
  | "syntax-error"
  | "object-found";

export type ChronicleResponseRootType =
  | "empty"
  | "unknown"
  | "object"
  | "array"
  | "string"
  | "number"
  | "boolean"
  | "null";

export type ChronicleSchemaErrorCode =
  | "SCHEMA_INVALID"
  | "SCHEMA_REQUIRED"
  | "SCHEMA_TYPE"
  | "SCHEMA_NO_VALID_REFS"
  | "SCHEMA_UNKNOWN";

export type ChronicleRefErrorCode =
  | "UNKNOWN_SOURCE_REF"
  | "UNKNOWN_OBSERVATION_REF"
  | "CLUSTER_REF_MISMATCH";

export interface ChronicleSchemaDiagnosticError {
  readonly code: ChronicleSchemaErrorCode;
  readonly path: string;
}

export interface ChronicleRefDiagnosticError {
  readonly code: ChronicleRefErrorCode;
  readonly path: string;
}

interface ChronicleJsonDiagnostic {
  readonly status: ChronicleResponseJsonStatus;
  readonly rootType: ChronicleResponseRootType;
}

interface ChronicleSchemaDiagnostic {
  readonly status: "valid" | "invalid" | "not-evaluated";
  readonly errors: readonly ChronicleSchemaDiagnosticError[];
}

interface ChronicleRefDiagnostic {
  readonly status: "valid" | "invalid" | "not-evaluated";
  readonly checkedCount: number;
  readonly rejectedCount: number;
  readonly errors: readonly ChronicleRefDiagnosticError[];
}

interface ChronicleOutputDiagnostic {
  readonly candidateCount: number;
  /** Rows accepted by the canonical per-row schema parser. */
  readonly schemaAcceptedCount: number;
  /** Rows rejected by the canonical per-row schema parser. */
  readonly schemaRejectedCount: number;
  /** Schema-valid rows dropped by the production normalizer. */
  readonly normalizerDroppedCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  /** Final rows retained while the canonical stage status was invalid. */
  readonly salvagedCount: number;
}

export interface ChronicleObservationResponseDiagnostic {
  readonly stageId: "narrative_observation_extract";
  readonly invocationIndex: number;
  readonly json: ChronicleJsonDiagnostic;
  readonly schema: ChronicleSchemaDiagnostic;
  readonly refs: ChronicleRefDiagnostic;
  readonly output: ChronicleOutputDiagnostic;
}

export interface ChronicleSynthesisResponseDiagnostic {
  readonly stageId: "narrative_event_synthesize";
  readonly invocationIndex: number;
  readonly json: ChronicleJsonDiagnostic;
  readonly schema: ChronicleSchemaDiagnostic;
  readonly refs: ChronicleRefDiagnostic;
  readonly output: ChronicleOutputDiagnostic;
}

export type ChronicleResponseDiagnostic =
  | ChronicleObservationResponseDiagnostic
  | ChronicleSynthesisResponseDiagnostic;

export type ChronicleTaskParseStatus = "parsed" | "invalid";

export interface DiagnoseObservationResponseOptions {
  readonly invocationIndex: number;
  readonly allowedSourceRefs: ReadonlySet<string>;
}

export interface DiagnoseSynthesisResponseOptions {
  readonly invocationIndex: number;
  readonly clusterRef: string;
  readonly allowedObservationRefs: ReadonlySet<string>;
}

/**
 * Mirror the production observation task's `onParseStatus` rule. Reference
 * filtering is deliberately excluded: the task reports schema validity even
 * when the normalizer later drops unknown source refs.
 */
export function canonicalObservationParseStatus(
  diagnostic: ChronicleObservationResponseDiagnostic,
): ChronicleTaskParseStatus {
  return diagnostic.schema.status === "valid" ? "parsed" : "invalid";
}

/**
 * Mirror the production synthesis task's `onParseStatus` rule. Unlike the
 * observation task, synthesis treats a wrong clusterRef as invalid; unknown
 * observation refs remain a normalizer filtering concern.
 */
export function canonicalSynthesisParseStatus(
  diagnostic: ChronicleSynthesisResponseDiagnostic,
): ChronicleTaskParseStatus {
  return diagnostic.schema.status === "valid" &&
    !diagnostic.refs.errors.some(
      (error) => error.code === "CLUSTER_REF_MISMATCH",
    )
    ? "parsed"
    : "invalid";
}

interface ParsedResponse {
  readonly json: ChronicleJsonDiagnostic;
  readonly value: unknown | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rootType(value: unknown): ChronicleResponseRootType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "object":
      return "object";
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "unknown";
  }
}

function inspectResponse(responseText: string): ParsedResponse {
  const trimmed = responseText.trim();
  if (trimmed.length === 0) {
    return {
      json: { status: "empty", rootType: "empty" },
      value: null,
    };
  }

  const jsonText = extractJsonObject(trimmed);
  if (jsonText === null) {
    if (trimmed.includes("{")) {
      return {
        json: { status: "unbalanced-object", rootType: "unknown" },
        value: null,
      };
    }
    try {
      const value: unknown = JSON.parse(trimmed);
      return {
        json: { status: "root-not-object", rootType: rootType(value) },
        value: null,
      };
    } catch {
      return {
        json: { status: "object-not-found", rootType: "unknown" },
        value: null,
      };
    }
  }

  try {
    const value: unknown = JSON.parse(jsonText);
    return {
      json: { status: "object-found", rootType: rootType(value) },
      value,
    };
  } catch {
    return {
      json: { status: "syntax-error", rootType: "unknown" },
      value: null,
    };
  }
}

function isAllowedSchemaPath(candidate: string): boolean {
  if (candidate === "root") return true;
  if (/^(?:localId|evidence|assertion|payload)$/.test(candidate)) return true;
  if (
    /^(?:evidence|payload\.participants)\[\d+\](?:\.(?:sourceRef|quote|surface|role))?$/.test(
      candidate,
    )
  ) {
    return true;
  }
  if (
    /^(?:assertion\.(?:attribution|narrativeFrame)|payload\.(?:predicate|actuality|durationKind|participants|temporalExpressions))$/.test(
      candidate,
    )
  ) {
    return true;
  }
  if (candidate === "observations" || candidate === "events") return true;
  if (
    /^observations\[\d+\]\.(?:localId|evidence|assertion|payload)$/.test(
      candidate,
    )
  ) {
    return true;
  }
  if (/^observations\[\d+\]\.root$/.test(candidate)) return true;
  if (
    /^observations\[\d+\]\.(?:evidence|payload\.participants)\[\d+\](?:\.(?:sourceRef|quote|surface|role))?$/.test(
      candidate,
    )
  ) {
    return true;
  }
  if (
    /^observations\[\d+\]\.(?:assertion\.(?:attribution|narrativeFrame)|payload\.(?:predicate|actuality|durationKind|participants|temporalExpressions))$/.test(
      candidate,
    )
  ) {
    return true;
  }
  if (
    /^events\[\d+\](?:\.observationRefs|\.titleSuggestion|\.summary|\.actuality|\.significance)?$/.test(
      candidate,
    )
  ) {
    return true;
  }
  if (/^(?:clusterRef|resolution)$/.test(candidate)) return true;
  return false;
}

function safePath(error: string): string {
  const separator = error.indexOf(": ");
  const candidate = separator >= 0 ? error.slice(0, separator) : error;
  // Keep this tied to the production parser's fixed schema paths. A generic
  // identifier/index grammar would allow a future parser error to echo an
  // arbitrary key or value into the report.
  return isAllowedSchemaPath(candidate) ? candidate : "<redacted>";
}

function schemaErrorCode(error: string): ChronicleSchemaErrorCode {
  if (error.includes("invalid")) return "SCHEMA_INVALID";
  if (error.includes("expected object") || error.includes("array required")) {
    return "SCHEMA_TYPE";
  }
  if (error.includes("no valid refs")) return "SCHEMA_NO_VALID_REFS";
  if (error.includes("required")) return "SCHEMA_REQUIRED";
  return "SCHEMA_UNKNOWN";
}

function schemaErrors(
  errors: readonly string[],
): readonly ChronicleSchemaDiagnosticError[] {
  return errors.map((error) => ({
    code: schemaErrorCode(error),
    path: safePath(error),
  }));
}

function notEvaluatedSchema(): ChronicleSchemaDiagnostic {
  return { status: "not-evaluated", errors: [] };
}

function notEvaluatedRefs(): ChronicleRefDiagnostic {
  return {
    status: "not-evaluated",
    checkedCount: 0,
    rejectedCount: 0,
    errors: [],
  };
}

function outputDiagnostic(
  candidateCount: number,
  schemaAcceptedCount: number,
  normalizerDroppedCount: number,
  acceptedCount: number,
  salvagedCount: number,
): ChronicleOutputDiagnostic {
  return {
    candidateCount,
    schemaAcceptedCount,
    schemaRejectedCount: Math.max(0, candidateCount - schemaAcceptedCount),
    normalizerDroppedCount,
    acceptedCount,
    rejectedCount: Math.max(0, candidateCount - acceptedCount),
    salvagedCount,
  };
}

function observationSchemaAcceptedCount(rows: readonly unknown[]): number {
  return rows.reduce<number>(
    (count, row) => count + (parseRawChronicleEventObservation(row).ok ? 1 : 0),
    0,
  );
}

function synthesisSchemaAcceptedCount(
  value: unknown,
  events: readonly unknown[],
): number {
  if (!isRecord(value)) return 0;
  return events.reduce<number>((count, event) => {
    const singleEvent = parseRawEventSynthesisResult({
      clusterRef: value.clusterRef,
      resolution: value.resolution,
      events: [event],
    });
    return count + (singleEvent.ok ? 1 : 0);
  }, 0);
}

function observationRows(value: unknown): readonly unknown[] | null {
  return isRecord(value) && Array.isArray(value.observations)
    ? value.observations
    : null;
}

function observationRefsDiagnostic(
  rows: readonly unknown[],
  allowedSourceRefs: ReadonlySet<string>,
): ChronicleRefDiagnostic {
  const errors: ChronicleRefDiagnosticError[] = [];
  let checkedCount = 0;
  let inspected = rows.length === 0;

  for (const [rowIndex, row] of rows.entries()) {
    if (!isRecord(row) || !Array.isArray(row.evidence)) continue;
    inspected = true;
    for (const [evidenceIndex, evidence] of row.evidence.entries()) {
      if (!isRecord(evidence) || typeof evidence.sourceRef !== "string") {
        continue;
      }
      if (evidence.sourceRef.length === 0) continue;
      checkedCount += 1;
      if (!allowedSourceRefs.has(evidence.sourceRef)) {
        errors.push({
          code: "UNKNOWN_SOURCE_REF",
          path: `observations[${rowIndex}].evidence[${evidenceIndex}].sourceRef`,
        });
      }
    }
  }

  if (!inspected) return notEvaluatedRefs();
  return {
    status: errors.length > 0 ? "invalid" : "valid",
    checkedCount,
    rejectedCount: errors.length,
    errors,
  };
}

function synthesisEvents(value: unknown): readonly unknown[] | null {
  return isRecord(value) && Array.isArray(value.events) ? value.events : null;
}

function synthesisRefsDiagnostic(
  value: unknown,
  events: readonly unknown[],
  expectedClusterRef: string,
  allowedObservationRefs: ReadonlySet<string>,
): ChronicleRefDiagnostic {
  const errors: ChronicleRefDiagnosticError[] = [];
  let checkedCount = 0;
  let inspected = events.length === 0;

  if (
    isRecord(value) &&
    typeof value.clusterRef === "string" &&
    value.clusterRef !== expectedClusterRef
  ) {
    errors.push({ code: "CLUSTER_REF_MISMATCH", path: "clusterRef" });
  }

  for (const [eventIndex, event] of events.entries()) {
    if (!isRecord(event) || !Array.isArray(event.observationRefs)) continue;
    inspected = true;
    for (const [refIndex, ref] of event.observationRefs.entries()) {
      if (typeof ref !== "string" || ref.length === 0) continue;
      checkedCount += 1;
      if (!allowedObservationRefs.has(ref)) {
        errors.push({
          code: "UNKNOWN_OBSERVATION_REF",
          path: `events[${eventIndex}].observationRefs[${refIndex}]`,
        });
      }
    }
  }

  if (!inspected && errors.length === 0) return notEvaluatedRefs();
  return {
    status: errors.length > 0 ? "invalid" : "valid",
    checkedCount,
    rejectedCount: errors.filter(
      (error) => error.code !== "CLUSTER_REF_MISMATCH",
    ).length,
    errors,
  };
}

export function diagnoseObservationResponse(
  responseText: string,
  options: DiagnoseObservationResponseOptions,
): ChronicleObservationResponseDiagnostic {
  const inspected = inspectResponse(responseText);
  const rows = observationRows(inspected.value);
  if (inspected.value === null) {
    return {
      stageId: "narrative_observation_extract",
      invocationIndex: options.invocationIndex,
      json: inspected.json,
      schema: notEvaluatedSchema(),
      refs: notEvaluatedRefs(),
      output: outputDiagnostic(0, 0, 0, 0, 0),
    };
  }

  const result = parseRawChronicleEventObservationList(inspected.value);
  if (rows === null) {
    return {
      stageId: "narrative_observation_extract",
      invocationIndex: options.invocationIndex,
      json: inspected.json,
      schema: result.ok
        ? { status: "valid", errors: [] }
        : { status: "invalid", errors: schemaErrors(result.errors) },
      refs: notEvaluatedRefs(),
      output: outputDiagnostic(0, 0, 0, 0, 0),
    };
  }
  const schemaAcceptedCount = observationSchemaAcceptedCount(rows);
  const normalized = normalizeWindowObservations(inspected.value, {
    allowedSourceRefs: options.allowedSourceRefs,
    createId: () => "diagnostic-observation-id",
  });
  return {
    stageId: "narrative_observation_extract",
    invocationIndex: options.invocationIndex,
    json: inspected.json,
    schema: result.ok
      ? { status: "valid", errors: [] }
      : { status: "invalid", errors: schemaErrors(result.errors) },
    refs: observationRefsDiagnostic(rows, options.allowedSourceRefs),
    output: outputDiagnostic(
      rows.length,
      schemaAcceptedCount,
      Math.max(0, schemaAcceptedCount - normalized.length),
      normalized.length,
      result.ok ? 0 : normalized.length,
    ),
  };
}

export function diagnoseSynthesisResponse(
  responseText: string,
  options: DiagnoseSynthesisResponseOptions,
): ChronicleSynthesisResponseDiagnostic {
  const inspected = inspectResponse(responseText);
  const events = synthesisEvents(inspected.value);
  if (inspected.value === null) {
    return {
      stageId: "narrative_event_synthesize",
      invocationIndex: options.invocationIndex,
      json: inspected.json,
      schema: notEvaluatedSchema(),
      refs: notEvaluatedRefs(),
      output: outputDiagnostic(0, 0, 0, 0, 0),
    };
  }

  const result = parseRawEventSynthesisResult(inspected.value);
  if (events === null) {
    return {
      stageId: "narrative_event_synthesize",
      invocationIndex: options.invocationIndex,
      json: inspected.json,
      schema: result.ok
        ? { status: "valid", errors: [] }
        : { status: "invalid", errors: schemaErrors(result.errors) },
      refs: notEvaluatedRefs(),
      output: outputDiagnostic(0, 0, 0, 0, 0),
    };
  }
  const schemaAcceptedCount = synthesisSchemaAcceptedCount(
    inspected.value,
    events,
  );
  const normalized = normalizeEventSynthesis(inspected.value, {
    clusterRef: options.clusterRef,
    allowedObservationRefs: options.allowedObservationRefs,
    createId: () => "diagnostic-hypothesis-id",
  });
  return {
    stageId: "narrative_event_synthesize",
    invocationIndex: options.invocationIndex,
    json: inspected.json,
    schema: result.ok
      ? { status: "valid", errors: [] }
      : { status: "invalid", errors: schemaErrors(result.errors) },
    refs: synthesisRefsDiagnostic(
      inspected.value,
      events,
      options.clusterRef,
      options.allowedObservationRefs,
    ),
    output: outputDiagnostic(
      events.length,
      schemaAcceptedCount,
      result.ok ? Math.max(0, schemaAcceptedCount - normalized.length) : 0,
      normalized.length,
      result.ok ? 0 : normalized.length,
    ),
  };
}
