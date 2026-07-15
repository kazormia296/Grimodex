import type { AnySchema } from "ajv";

const evidenceSchema = {
  type: "object",
  required: ["sectionId", "paragraphId"],
  properties: {
    sectionId: { type: "string", minLength: 1 },
    paragraphId: { type: "string", minLength: 1 },
    sentenceIndex: { type: "integer", minimum: 0 },
    excerpt: { type: "string" },
  },
  additionalProperties: false,
} as const;

const inferredValueSchema = {
  type: "object",
  required: ["value", "confidence", "evidence"],
  properties: {
    value: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: { type: "array", items: evidenceSchema },
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
        title: { type: "string" },
        language: { enum: ["ja", "en", "other"] },
        fingerprint: { type: "string" },
        characterCount: { type: "integer", minimum: 0 },
        paragraphCount: { type: "integer", minimum: 0 },
        sectionCount: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    sections: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "ordinal", "title", "paragraphIds"],
        properties: {
          id: { type: "string" },
          ordinal: { type: "integer", minimum: 0 },
          title: { type: "string" },
          paragraphIds: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    },
    entities: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "type", "name", "aliases", "evidence", "confidence"],
        properties: {
          id: { type: "string" },
          type: {
            enum: ["character", "place", "organization", "object", "alias", "unknown"],
          },
          name: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
          parentId: { type: "string" },
          evidence: { type: "array", items: evidenceSchema },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        additionalProperties: false,
      },
    },
    relations: {
      type: "array",
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
          id: { type: "string" },
          fromEntityId: { type: "string" },
          toEntityId: { type: "string" },
          type: { type: "string" },
          label: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "array", items: evidenceSchema },
        },
        additionalProperties: false,
      },
    },
    phases: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "entityIds", "anchors", "confidence"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          entityIds: { type: "array", items: { type: "string" } },
          anchors: { type: "array", items: evidenceSchema },
          summary: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        additionalProperties: false,
      },
    },
    events: {
      type: "array",
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
          id: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          sectionId: { type: "string" },
          paragraphIds: { type: "array", items: { type: "string" } },
          entityIds: { type: "array", items: { type: "string" } },
          order: { type: "integer", minimum: 0 },
          evidence: { type: "array", items: evidenceSchema },
        },
        additionalProperties: false,
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "kind", "status", "title", "summary", "evidence"],
        properties: {
          id: { type: "string" },
          kind: { enum: ["continuity", "timeline", "knowledge", "ambiguity", "other"] },
          status: { enum: ["candidate", "confirmed", "rejected", "intentional"] },
          title: { type: "string" },
          summary: { type: "string" },
          evidence: { type: "array", items: evidenceSchema },
          relatedEntityIds: { type: "array", items: { type: "string" } },
          relatedEventIds: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    },
    summary: {
      type: "object",
      required: ["genreCandidates", "themes", "strengths", "risks"],
      properties: {
        premise: { type: "string" },
        genreCandidates: { type: "array", items: inferredValueSchema },
        themes: { type: "array", items: inferredValueSchema },
        strengths: {
          type: "array",
          items: {
            type: "object",
            required: ["title", "summary", "evidence"],
            properties: {
              title: { type: "string" },
              summary: { type: "string" },
              evidence: { type: "array", items: evidenceSchema },
            },
            additionalProperties: false,
          },
        },
        risks: {
          type: "array",
          items: {
            type: "object",
            required: ["title", "summary", "evidence"],
            properties: {
              title: { type: "string" },
              summary: { type: "string" },
              evidence: { type: "array", items: evidenceSchema },
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
        pipelineVersion: { type: "string" },
        promptVersions: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        models: {
          type: "array",
          items: {
            type: "object",
            required: ["provider", "model"],
            properties: {
              provider: { type: "string" },
              model: { type: "string" },
              inputTokens: { type: "integer", minimum: 0 },
              outputTokens: { type: "integer", minimum: 0 },
              estimatedCostUsd: { type: "number", minimum: 0 },
            },
            additionalProperties: false,
          },
        },
        generatedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};
