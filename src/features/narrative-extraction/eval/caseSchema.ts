import { freezeDeep } from "../source/immutability";
import {
  NARRATIVE_EVAL_CASE_SCHEMA_VERSION,
  NARRATIVE_EVAL_DIMENSIONS,
  type NarrativeEvalCaseV1,
  type NarrativeEvalDimension,
  type NarrativeEvalExpectedObservation,
} from "./types";

export interface NarrativeEvalCaseDiagnostic {
  readonly code: string;
  readonly path?: string;
  readonly message: string;
}

export type NarrativeEvalCaseValidationResult =
  | { readonly ok: true; readonly value: NarrativeEvalCaseV1 }
  | {
      readonly ok: false;
      readonly diagnostics: readonly NarrativeEvalCaseDiagnostic[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasValidLocale(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    new Intl.Locale(value);
    return true;
  } catch {
    return false;
  }
}

function hasValidTimezone(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function hasValidFrozenTime(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function findMatches(text: string, quote: string): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  while (cursor <= text.length - quote.length) {
    const offset = text.indexOf(quote, cursor);
    if (offset < 0) break;
    offsets.push(offset);
    cursor = offset + 1;
  }
  return offsets;
}

function matchesContext(
  text: string,
  offset: number,
  quote: string,
  prefix?: string,
  suffix?: string,
): boolean {
  if (prefix && text.slice(offset - prefix.length, offset) !== prefix) {
    return false;
  }
  if (
    suffix &&
    text.slice(offset + quote.length, offset + quote.length + suffix.length) !==
      suffix
  ) {
    return false;
  }
  return true;
}

function validateExpectedObservation(
  value: unknown,
  path: string,
  documents: ReadonlyMap<string, string>,
  diagnostics: NarrativeEvalCaseDiagnostic[],
): value is NarrativeEvalExpectedObservation {
  if (!isRecord(value)) {
    diagnostics.push({
      code: "CASE_EXPECTATION_INVALID",
      path,
      message: "Observation expectation must be an object",
    });
    return false;
  }
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.semanticKey)) {
    diagnostics.push({
      code: "CASE_EXPECTATION_INVALID",
      path,
      message: "Observation expectation requires id and semanticKey",
    });
    return false;
  }
  if (!isRecord(value.dimensions)) {
    diagnostics.push({
      code: "CASE_EXPECTATION_DIMENSIONS_INVALID",
      path: `${path}.dimensions`,
      message: "Observation dimensions must be an object",
    });
    return false;
  }
  const evidence = value.dimensions.evidence;
  if (evidence !== undefined) {
    if (!Array.isArray(evidence)) {
      diagnostics.push({
        code: "CASE_EVIDENCE_INVALID",
        path: `${path}.dimensions.evidence`,
        message: "Evidence must be an array",
      });
    } else {
      for (const [index, item] of evidence.entries()) {
        const evidencePath = `${path}.dimensions.evidence[${index}]`;
        if (
          !isRecord(item) ||
          !isNonEmptyString(item.documentId) ||
          !isNonEmptyString(item.quote)
        ) {
          diagnostics.push({
            code: "CASE_EVIDENCE_INVALID",
            path: evidencePath,
            message: "Evidence requires documentId and a non-empty quote",
          });
          continue;
        }
        const text = documents.get(item.documentId);
        if (text === undefined) {
          diagnostics.push({
            code: "CASE_EVIDENCE_DOCUMENT_UNKNOWN",
            path: evidencePath,
            message: `Unknown evidence document: ${item.documentId}`,
          });
          continue;
        }
        const matches = findMatches(text, item.quote).filter((offset) =>
          matchesContext(
            text,
            offset,
            item.quote as string,
            typeof item.prefix === "string" ? item.prefix : undefined,
            typeof item.suffix === "string" ? item.suffix : undefined,
          ),
        );
        if (matches.length === 0) {
          diagnostics.push({
            code: "CASE_EVIDENCE_QUOTE_NOT_EXACT",
            path: evidencePath,
            message: "Evidence quote is not an exact substring of its document",
          });
        } else if (matches.length > 1) {
          diagnostics.push({
            code: "CASE_EVIDENCE_QUOTE_AMBIGUOUS",
            path: evidencePath,
            message: "Evidence quote does not resolve to one exact occurrence",
          });
        }
      }
    }
  }
  return true;
}

/** Validate and detach untrusted fixture data before an evaluation run. */
export function validateNarrativeEvalCase(
  candidate: unknown,
): NarrativeEvalCaseValidationResult {
  const diagnostics: NarrativeEvalCaseDiagnostic[] = [];
  if (!isRecord(candidate)) {
    return {
      ok: false,
      diagnostics: [
        { code: "CASE_INVALID", message: "Narrative case must be an object" },
      ],
    };
  }
  if (candidate.schemaVersion !== NARRATIVE_EVAL_CASE_SCHEMA_VERSION) {
    diagnostics.push({
      code: "CASE_SCHEMA_VERSION_UNSUPPORTED",
      path: "schemaVersion",
      message: "Narrative case schemaVersion must be 1",
    });
  }
  if (!isNonEmptyString(candidate.id)) {
    diagnostics.push({
      code: "CASE_ID_INVALID",
      path: "id",
      message: "Narrative case id is required",
    });
  }
  if (
    !isRecord(candidate.scope) ||
    !isNonEmptyString(candidate.scope.slice) ||
    !["micro", "chapter", "work", "mutation"].includes(
      String(candidate.scope.tier),
    )
  ) {
    diagnostics.push({
      code: "CASE_SCOPE_INVALID",
      path: "scope",
      message: "Narrative case scope is invalid",
    });
  }
  if (!hasValidLocale(candidate.locale)) {
    diagnostics.push({
      code: "CASE_LOCALE_INVALID",
      path: "locale",
      message: "Narrative case locale is invalid",
    });
  }
  if (!hasValidTimezone(candidate.timezone)) {
    diagnostics.push({
      code: "CASE_TIMEZONE_INVALID",
      path: "timezone",
      message: "Narrative case timezone is invalid",
    });
  }
  if (!hasValidFrozenTime(candidate.frozenTime)) {
    diagnostics.push({
      code: "CASE_FROZEN_TIME_INVALID",
      path: "frozenTime",
      message: "Narrative case frozenTime must be an ISO UTC timestamp",
    });
  }

  const documents = new Map<string, string>();
  if (!Array.isArray(candidate.documents) || candidate.documents.length === 0) {
    diagnostics.push({
      code: "CASE_DOCUMENTS_INVALID",
      path: "documents",
      message: "Narrative case requires at least one document",
    });
  } else {
    for (const [index, document] of candidate.documents.entries()) {
      const path = `documents[${index}]`;
      if (
        !isRecord(document) ||
        !isNonEmptyString(document.id) ||
        !isNonEmptyString(document.title) ||
        typeof document.text !== "string"
      ) {
        diagnostics.push({
          code: "CASE_DOCUMENT_INVALID",
          path,
          message: "Document requires id, title, and text",
        });
        continue;
      }
      if (documents.has(document.id)) {
        diagnostics.push({
          code: "CASE_DOCUMENT_ID_DUPLICATE",
          path: `${path}.id`,
          message: `Duplicate document id: ${document.id}`,
        });
      }
      documents.set(document.id, document.text);
    }
  }

  if (!isRecord(candidate.coverage)) {
    diagnostics.push({
      code: "CASE_COVERAGE_INVALID",
      path: "coverage",
      message: "Coverage contract is required",
    });
  } else {
    if (!["complete", "partial"].includes(String(candidate.coverage.mode))) {
      diagnostics.push({
        code: "CASE_COVERAGE_INVALID",
        path: "coverage.mode",
        message: "Coverage mode must be complete or partial",
      });
    }
    for (const field of [
      "includedDocumentIds",
      "omittedDocumentIds",
    ] as const) {
      const ids = candidate.coverage[field];
      if (!Array.isArray(ids)) {
        diagnostics.push({
          code: "CASE_COVERAGE_INVALID",
          path: `coverage.${field}`,
          message: `${field} must be an array`,
        });
        continue;
      }
      for (const [index, id] of ids.entries()) {
        if (!isNonEmptyString(id) || !documents.has(id)) {
          diagnostics.push({
            code: "CASE_COVERAGE_DOCUMENT_UNKNOWN",
            path: `coverage.${field}[${index}]`,
            message: `Coverage references an unknown document: ${String(id)}`,
          });
        }
      }
    }
  }

  const expectationIds = new Set<string>();
  const observations = isRecord(candidate.expected)
    ? candidate.expected.observations
    : undefined;
  if (!isRecord(observations)) {
    diagnostics.push({
      code: "CASE_OBSERVATIONS_INVALID",
      path: "expected.observations",
      message: "Expected observations are required",
    });
  } else {
    for (const field of ["required", "forbidden"] as const) {
      const values = observations[field];
      if (!Array.isArray(values)) {
        diagnostics.push({
          code:
            field === "forbidden"
              ? "CASE_FORBIDDEN_OBSERVATIONS_REQUIRED"
              : "CASE_REQUIRED_OBSERVATIONS_REQUIRED",
          path: `expected.observations.${field}`,
          message: `${field} observations must be an array`,
        });
        continue;
      }
      for (const [index, value] of values.entries()) {
        const path = `expected.observations.${field}[${index}]`;
        if (validateExpectedObservation(value, path, documents, diagnostics)) {
          if (expectationIds.has(value.id)) {
            diagnostics.push({
              code: "CASE_EXPECTATION_ID_DUPLICATE",
              path: `${path}.id`,
              message: `Duplicate expectation id: ${value.id}`,
            });
          }
          expectationIds.add(value.id);
        }
      }
    }
  }

  if (!Array.isArray(candidate.criticalViolationClasses)) {
    diagnostics.push({
      code: "CASE_CRITICAL_VIOLATIONS_INVALID",
      path: "criticalViolationClasses",
      message: "criticalViolationClasses must be an array",
    });
  } else {
    for (const [
      index,
      violation,
    ] of candidate.criticalViolationClasses.entries()) {
      const path = `criticalViolationClasses[${index}]`;
      if (
        !isRecord(violation) ||
        !isNonEmptyString(violation.id) ||
        !isNonEmptyString(violation.description) ||
        !isRecord(violation.match) ||
        !isNonEmptyString(violation.match.semanticKey) ||
        !NARRATIVE_EVAL_DIMENSIONS.includes(
          violation.match.dimension as NarrativeEvalDimension,
        ) ||
        violation.match.value === undefined
      ) {
        diagnostics.push({
          code: "CASE_CRITICAL_VIOLATION_MATCH_INVALID",
          path,
          message: "Critical violation requires a deterministic matcher",
        });
      }
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return freezeDeep({
    ok: true,
    value: structuredClone(candidate) as unknown as NarrativeEvalCaseV1,
  });
}
