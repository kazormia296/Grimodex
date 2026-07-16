import { Ajv, type AnySchema, type ErrorObject } from "ajv";
import { SCAN_LIMITS } from "./limits.js";
import {
  CHUNK_EXTRACTION_SCHEMA_VERSION,
  type ChunkExtractionV1,
} from "./scanBundleV1.js";

export interface ChunkExtractionValidationError {
  code: string;
  path: string;
  message: string;
}

export type ChunkExtractionValidationResult =
  | { ok: true; value: ChunkExtractionV1 }
  | { ok: false; errors: ChunkExtractionValidationError[] };

export interface ChunkExtractionValidationOptions {
  expectedChunkId?: string;
  expectedSourceFingerprint?: string;
  paragraphIds?: readonly string[];
  sectionIds?: readonly string[];
  paragraphSectionIds?: Readonly<Record<string, string>>;
}

const evidenceSchema = {
  type: "object",
  required: ["sectionId", "paragraphId"],
  properties: {
    sectionId: {
      type: "string",
      minLength: 1,
      maxLength: SCAN_LIMITS.maxIdLength,
    },
    paragraphId: {
      type: "string",
      minLength: 1,
      maxLength: SCAN_LIMITS.maxIdLength,
    },
    sentenceIndex: { type: "integer", minimum: 0 },
    excerpt: { type: "string", maxLength: SCAN_LIMITS.maxExcerptLength },
  },
  additionalProperties: false,
} as const;

const candidateFields = {
  evidence: {
    type: "array",
    minItems: 1,
    maxItems: SCAN_LIMITS.maxEvidencePerItem,
    items: evidenceSchema,
  },
  confidence: { type: "number", minimum: 0, maximum: 1 },
} as const;

export const chunkExtractionV1Schema: AnySchema = {
  type: "object",
  required: [
    "schemaVersion",
    "chunkId",
    "sourceFingerprint",
    "entities",
    "relations",
    "events",
  ],
  properties: {
    schemaVersion: { const: CHUNK_EXTRACTION_SCHEMA_VERSION },
    chunkId: {
      type: "string",
      minLength: 1,
      maxLength: SCAN_LIMITS.maxIdLength,
    },
    sourceFingerprint: {
      type: "string",
      minLength: 1,
      maxLength: SCAN_LIMITS.maxFingerprintLength,
    },
    entities: {
      type: "array",
      maxItems: SCAN_LIMITS.maxEntities,
      items: {
        type: "object",
        required: ["type", "name", "aliases", "evidence", "confidence"],
        properties: {
          type: {
            enum: [
              "character",
              "place",
              "organization",
              "object",
              "alias",
              "unknown",
            ],
          },
          name: {
            type: "string",
            minLength: 1,
            maxLength: SCAN_LIMITS.maxEntityNameLength,
          },
          aliases: {
            type: "array",
            maxItems: SCAN_LIMITS.maxAliasesPerEntity,
            items: {
              type: "string",
              maxLength: SCAN_LIMITS.maxEntityNameLength,
            },
          },
          summary: { type: "string", maxLength: SCAN_LIMITS.maxTextLength },
          ...candidateFields,
        },
        additionalProperties: false,
      },
    },
    relations: {
      type: "array",
      maxItems: SCAN_LIMITS.maxRelations,
      items: {
        type: "object",
        required: ["fromName", "toName", "type", "evidence", "confidence"],
        properties: {
          fromName: {
            type: "string",
            minLength: 1,
            maxLength: SCAN_LIMITS.maxEntityNameLength,
          },
          toName: {
            type: "string",
            minLength: 1,
            maxLength: SCAN_LIMITS.maxEntityNameLength,
          },
          type: {
            type: "string",
            minLength: 1,
            maxLength: SCAN_LIMITS.maxRelationTypeLength,
          },
          label: { type: "string", maxLength: SCAN_LIMITS.maxTextLength },
          ...candidateFields,
        },
        additionalProperties: false,
      },
    },
    events: {
      type: "array",
      maxItems: SCAN_LIMITS.maxEvents,
      items: {
        type: "object",
        required: [
          "title",
          "sectionId",
          "paragraphIds",
          "entityNames",
          "order",
          "evidence",
        ],
        properties: {
          title: {
            type: "string",
            minLength: 1,
            maxLength: SCAN_LIMITS.maxTitleLength,
          },
          summary: { type: "string", maxLength: SCAN_LIMITS.maxTextLength },
          sectionId: {
            type: "string",
            minLength: 1,
            maxLength: SCAN_LIMITS.maxIdLength,
          },
          paragraphIds: {
            type: "array",
            minItems: 1,
            maxItems: SCAN_LIMITS.maxParagraphs,
            items: {
              type: "string",
              minLength: 1,
              maxLength: SCAN_LIMITS.maxIdLength,
            },
          },
          entityNames: {
            type: "array",
            maxItems: SCAN_LIMITS.maxEntities,
            items: {
              type: "string",
              minLength: 1,
              maxLength: SCAN_LIMITS.maxEntityNameLength,
            },
          },
          order: { type: "integer", minimum: 0 },
          evidence: {
            type: "array",
            minItems: 1,
            maxItems: SCAN_LIMITS.maxEvidencePerItem,
            items: evidenceSchema,
          },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validateShape = ajv.compile(chunkExtractionV1Schema);

function error(
  code: string,
  path: string,
  message: string,
): ChunkExtractionValidationError {
  return { code, path, message };
}

function checkReferences(
  value: ChunkExtractionV1,
  options: ChunkExtractionValidationOptions,
): ChunkExtractionValidationError[] {
  const errors: ChunkExtractionValidationError[] = [];
  if (
    options.expectedChunkId !== undefined &&
    value.chunkId !== options.expectedChunkId
  ) {
    errors.push(
      error(
        "chunk-mismatch",
        "/chunkId",
        "chunkId does not match the requested chunk",
      ),
    );
  }
  if (
    options.expectedSourceFingerprint !== undefined &&
    value.sourceFingerprint !== options.expectedSourceFingerprint
  ) {
    errors.push(
      error(
        "fingerprint-mismatch",
        "/sourceFingerprint",
        "source fingerprint does not match the requested source",
      ),
    );
  }

  const knownParagraphs = options.paragraphIds
    ? new Set(options.paragraphIds)
    : null;
  const knownSections = options.sectionIds ? new Set(options.sectionIds) : null;
  const paragraphSectionIds = options.paragraphSectionIds;
  const checkEvidence = (
    evidence: readonly { sectionId: string; paragraphId: string }[],
    path: string,
  ) => {
    evidence.forEach((ref, index) => {
      if (knownSections && !knownSections.has(ref.sectionId)) {
        errors.push(
          error(
            "missing-reference",
            `${path}/${index}/sectionId`,
            "evidence section is outside the chunk",
          ),
        );
      }
      if (knownParagraphs && !knownParagraphs.has(ref.paragraphId)) {
        errors.push(
          error(
            "missing-reference",
            `${path}/${index}/paragraphId`,
            "evidence paragraph is outside the chunk",
          ),
        );
      }
      const expectedSection = paragraphSectionIds?.[ref.paragraphId];
      if (expectedSection !== undefined && expectedSection !== ref.sectionId) {
        errors.push(
          error(
            "reference-ownership",
            `${path}/${index}`,
            "evidence paragraph does not belong to the evidence section",
          ),
        );
      }
    });
  };
  value.entities.forEach((candidate, index) =>
    checkEvidence(candidate.evidence, `/entities/${index}/evidence`),
  );
  value.relations.forEach((candidate, index) =>
    checkEvidence(candidate.evidence, `/relations/${index}/evidence`),
  );
  value.events.forEach((candidate, index) => {
    if (knownSections && !knownSections.has(candidate.sectionId)) {
      errors.push(
        error(
          "missing-reference",
          `/events/${index}/sectionId`,
          "event section is outside the chunk",
        ),
      );
    }
    checkEvidence(candidate.evidence, `/events/${index}/evidence`);
    candidate.paragraphIds.forEach((paragraphId, paragraphIndex) => {
      if (knownParagraphs && !knownParagraphs.has(paragraphId)) {
        errors.push(
          error(
            "missing-reference",
            `/events/${index}/paragraphIds/${paragraphIndex}`,
            "event paragraph is outside the chunk",
          ),
        );
      }
      const expectedSection = paragraphSectionIds?.[paragraphId];
      if (
        expectedSection !== undefined &&
        expectedSection !== candidate.sectionId
      ) {
        errors.push(
          error(
            "reference-ownership",
            `/events/${index}/paragraphIds/${paragraphIndex}`,
            "event paragraph does not belong to the event section",
          ),
        );
      }
    });
  });
  const serializedLength = JSON.stringify(value).length;
  if (serializedLength > SCAN_LIMITS.maxBundleSerializedLength) {
    errors.push(error("limit", "/", "chunk extraction payload is too large"));
  }
  return errors;
}

export function validateChunkExtraction(
  input: unknown,
  options: ChunkExtractionValidationOptions = {},
): ChunkExtractionValidationResult {
  if (!validateShape(input)) {
    return {
      ok: false,
      errors: (validateShape.errors ?? []).map((item: ErrorObject) => ({
        code: `schema:${item.keyword}`,
        path: item.instancePath || "/",
        message: item.message ?? "schema validation failed",
      })),
    };
  }
  const value = input as ChunkExtractionV1;
  const errors = checkReferences(value, options);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}
