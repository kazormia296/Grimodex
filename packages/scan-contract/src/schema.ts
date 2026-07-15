import type { AnySchema } from "ajv";
import { SCAN_LIMITS } from "./limits.js";

const evidenceSchema = {
  type: "object",
  required: ["sectionId", "paragraphId"],
  properties: {
    sectionId: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxIdLength },
    paragraphId: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxIdLength },
    sentenceIndex: { type: "integer", minimum: 0 },
    excerpt: { type: "string", maxLength: SCAN_LIMITS.maxExcerptLength },
  },
  additionalProperties: false,
} as const;

const inferredValueSchema = {
  type: "object",
  required: ["value", "confidence", "evidence"],
  properties: {
    value: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxTextLength },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: { type: "array", maxItems: SCAN_LIMITS.maxEvidencePerItem, items: evidenceSchema },
  },
  additionalProperties: false,
} as const;

export const scanBundleV1Schema: AnySchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: [
    "schemaVersion",
    "source",
    "sections",
    "entities",
    "relations",
    "phases",
    "events",
    "findings",
    "summary",
    "provenance",
  ],
  properties: {
    schemaVersion: { const: "grimodex-scan/1" },
    source: {
      type: "object",
      required: [
        "title",
        "language",
        "fingerprint",
        "characterCount",
        "paragraphCount",
        "sectionCount",
      ],
      properties: {
        title: { type: "string", maxLength: SCAN_LIMITS.maxTitleLength },
        language: { enum: ["ja", "en", "other"] },
        fingerprint: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxFingerprintLength },
        characterCount: { type: "integer", minimum: 0 },
        paragraphCount: { type: "integer", minimum: 0 },
        sectionCount: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    sections: {
      type: "array",
      maxItems: SCAN_LIMITS.maxSections,
      items: {
        type: "object",
        required: ["id", "ordinal", "title", "paragraphIds"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxIdLength },
          ordinal: { type: "integer", minimum: 0 },
          title: { type: "string", maxLength: SCAN_LIMITS.maxTitleLength },
          paragraphIds: {
            type: "array",
            maxItems: SCAN_LIMITS.maxParagraphs,
            items: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxIdLength },
          },
        },
        additionalProperties: false,
      },
    },
    entities: {
      type: "array",
      maxItems: SCAN_LIMITS.maxEntities,
      items: {
        type: "object",
        required: ["id", "type", "name", "aliases", "evidence", "confidence"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxIdLength },
          type: {
            enum: ["character", "place", "organization", "object", "alias", "unknown"],
          },
          name: { type: "string", maxLength: SCAN_LIMITS.maxEntityNameLength },
          aliases: { type: "array", maxItems: SCAN_LIMITS.maxAliasesPerEntity, items: { type: "string", maxLength: SCAN_LIMITS.maxTextLength } },
          summary: { type: "string", maxLength: SCAN_LIMITS.maxTextLength },
          parentId: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxIdLength },
          evidence: { type: "array", maxItems: SCAN_LIMITS.maxEvidencePerItem, items: evidenceSchema },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        additionalProperties: false,
      },
    },
    relations: {
      type: "array",
      maxItems: SCAN_LIMITS.maxRelations,
      items: {
        type: "object",
        required: [
          "id",
          "fromEntityId",
          "toEntityId",
          "type",
          "confidence",
          "evidence",
        ],
        properties: {
          id: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxIdLength },
          fromEntityId: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxIdLength },
          toEntityId: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxIdLength },
          type: { type: "string", maxLength: SCAN_LIMITS.maxRelationTypeLength },
          label: { type: "string", maxLength: SCAN_LIMITS.maxTextLength },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "array", maxItems: SCAN_LIMITS.maxEvidencePerItem, items: evidenceSchema },
        },
        additionalProperties: false,
      },
    },
    phases: {
      type: "array",
      maxItems: SCAN_LIMITS.maxPhases,
      items: {
        type: "object",
        required: ["id", "title", "entityIds", "anchors", "confidence"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxIdLength },
          title: { type: "string", maxLength: SCAN_LIMITS.maxTitleLength },
          entityIds: { type: "array", maxItems: SCAN_LIMITS.maxEntities, items: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxIdLength } },
          anchors: { type: "array", maxItems: SCAN_LIMITS.maxEvidencePerItem, items: evidenceSchema },
          summary: { type: "string", maxLength: SCAN_LIMITS.maxTextLength },
          confidence: { type: "number", minimum: 0, maximum: 1 },
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
          "id",
          "title",
          "sectionId",
          "paragraphIds",
          "entityIds",
          "order",
          "evidence",
        ],
        properties: {
          id: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxIdLength },
          title: { type: "string", maxLength: SCAN_LIMITS.maxTitleLength },
          summary: { type: "string", maxLength: SCAN_LIMITS.maxTextLength },
          sectionId: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxIdLength },
          paragraphIds: { type: "array", maxItems: SCAN_LIMITS.maxParagraphs, items: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxIdLength } },
          entityIds: { type: "array", maxItems: SCAN_LIMITS.maxEntities, items: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxIdLength } },
          order: { type: "integer", minimum: 0 },
          evidence: { type: "array", maxItems: SCAN_LIMITS.maxEvidencePerItem, items: evidenceSchema },
        },
        additionalProperties: false,
      },
    },
    findings: {
      type: "array",
      maxItems: SCAN_LIMITS.maxFindings,
      items: {
        type: "object",
        required: ["id", "kind", "status", "title", "summary", "evidence"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxIdLength },
          kind: { enum: ["continuity", "timeline", "knowledge", "ambiguity", "other"] },
          status: { enum: ["candidate", "confirmed", "rejected", "intentional"] },
          title: { type: "string", maxLength: SCAN_LIMITS.maxTitleLength },
          summary: { type: "string", maxLength: SCAN_LIMITS.maxTextLength },
          evidence: { type: "array", maxItems: SCAN_LIMITS.maxEvidencePerItem, items: evidenceSchema },
          relatedEntityIds: { type: "array", maxItems: SCAN_LIMITS.maxEntities, items: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxIdLength } },
          relatedEventIds: { type: "array", maxItems: SCAN_LIMITS.maxEvents, items: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxIdLength } },
        },
        additionalProperties: false,
      },
    },
    summary: {
      type: "object",
      required: ["genreCandidates", "themes", "strengths", "risks"],
      properties: {
        premise: { type: "string", maxLength: SCAN_LIMITS.maxTextLength },
        genreCandidates: { type: "array", maxItems: 64, items: inferredValueSchema },
        themes: { type: "array", maxItems: 64, items: inferredValueSchema },
        strengths: {
          type: "array",
          maxItems: 64,
          items: {
            type: "object",
            required: ["title", "summary", "evidence"],
            properties: {
              title: { type: "string", maxLength: SCAN_LIMITS.maxTitleLength },
              summary: { type: "string", maxLength: SCAN_LIMITS.maxTextLength },
              evidence: { type: "array", maxItems: SCAN_LIMITS.maxEvidencePerItem, items: evidenceSchema },
            },
            additionalProperties: false,
          },
        },
        risks: {
          type: "array",
          maxItems: 64,
          items: {
            type: "object",
            required: ["title", "summary", "evidence"],
            properties: {
              title: { type: "string", maxLength: SCAN_LIMITS.maxTitleLength },
              summary: { type: "string", maxLength: SCAN_LIMITS.maxTextLength },
              evidence: { type: "array", maxItems: SCAN_LIMITS.maxEvidencePerItem, items: evidenceSchema },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    provenance: {
      type: "object",
      required: ["pipelineVersion", "promptVersions", "models", "generatedAt"],
      properties: {
        pipelineVersion: { type: "string", maxLength: SCAN_LIMITS.maxPipelineVersionLength },
        promptVersions: {
          type: "object",
          maxProperties: SCAN_LIMITS.maxPromptVersions,
          additionalProperties: { type: "string", maxLength: SCAN_LIMITS.maxPipelineVersionLength },
        },
        models: {
          type: "array",
          maxItems: 64,
          items: {
            type: "object",
            required: ["provider", "model"],
            properties: {
              provider: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxPipelineVersionLength },
              model: { type: "string", minLength: 1, maxLength: SCAN_LIMITS.maxPipelineVersionLength },
              inputTokens: { type: "integer", minimum: 0 },
              outputTokens: { type: "integer", minimum: 0 },
              estimatedCostUsd: { type: "number", minimum: 0 },
            },
            additionalProperties: false,
          },
        },
        generatedAt: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};
