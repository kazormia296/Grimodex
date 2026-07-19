import { Ajv, type AnySchema, type ErrorObject } from "ajv";
import {
  CLOUD_CONTENT_POLICY_ACK_HEADER,
  CLOUD_CONTENT_POLICY_VERSION,
} from "./cloudContentPolicy.js";

export const AI_DATA_DISCLOSURE_SCHEMA_VERSION =
  "grimodex/ai-data-disclosure/1" as const;

export type AiDataDisclosureRoute = "scan" | "hosted-editor";
export type AiTrainingUseStatus = "not-used" | "used" | "depends";

export interface AiDataDisclosureV1 {
  schemaVersion: typeof AI_DATA_DISCLOSURE_SCHEMA_VERSION;
  policyVersion: string;
  contentPolicy: {
    version: typeof CLOUD_CONTENT_POLICY_VERSION;
    acknowledgementHeader: typeof CLOUD_CONTENT_POLICY_ACK_HEADER;
  };
  route: AiDataDisclosureRoute;
  provider: string;
  consentId: string;
  usagePolicy: {
    summary: string;
    policyUrl: string;
  };
  sentData: Array<{
    category: string;
    description: string;
  }>;
  processingDestinations: Array<{
    processor: string;
    purpose: string;
    location: string;
    privacyPolicyUrl: string;
  }>;
  storage: {
    application: {
      storesPrompt: boolean;
      storesResponse: boolean;
      location: string;
    };
    provider: {
      summary: string;
      policyUrl: string;
    };
  };
  retention: {
    application: {
      uploadMinutes: number;
      sourceDays: number;
      artifactDays: number;
    };
    provider: {
      summary: string;
      policyUrl: string;
    };
  };
  trainingUse: {
    status: AiTrainingUseStatus;
    summary: string;
    policyUrl: string;
  };
}

export interface AiDataDisclosureValidationError {
  code: string;
  path: string;
  message: string;
}

export type AiDataDisclosureValidationResult =
  | { ok: true; value: AiDataDisclosureV1 }
  | { ok: false; errors: AiDataDisclosureValidationError[] };

const nonEmptyString = {
  type: "string",
  minLength: 1,
  maxLength: 2_000,
  pattern: "\\S",
} as const;

const httpsUrl = {
  type: "string",
  minLength: 9,
  maxLength: 2_048,
  pattern: "^https://[^\\s]+$",
} as const;

const policyReference = {
  type: "object",
  required: ["summary", "policyUrl"],
  properties: {
    summary: nonEmptyString,
    policyUrl: httpsUrl,
  },
  additionalProperties: false,
} as const;

export const aiDataDisclosureV1Schema: AnySchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: [
    "schemaVersion",
    "policyVersion",
    "contentPolicy",
    "route",
    "provider",
    "consentId",
    "usagePolicy",
    "sentData",
    "processingDestinations",
    "storage",
    "retention",
    "trainingUse",
  ],
  properties: {
    schemaVersion: { const: AI_DATA_DISCLOSURE_SCHEMA_VERSION },
    policyVersion: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "\\S",
    },
    contentPolicy: {
      type: "object",
      required: ["version", "acknowledgementHeader"],
      properties: {
        version: { const: CLOUD_CONTENT_POLICY_VERSION },
        acknowledgementHeader: { const: CLOUD_CONTENT_POLICY_ACK_HEADER },
      },
      additionalProperties: false,
    },
    route: { enum: ["scan", "hosted-editor"] },
    provider: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9._:+-]+$",
    },
    consentId: {
      type: "string",
      pattern: "^consent_[A-Za-z0-9_-]{16,248}$",
    },
    usagePolicy: policyReference,
    sentData: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: {
        type: "object",
        required: ["category", "description"],
        properties: {
          category: {
            type: "string",
            minLength: 1,
            maxLength: 128,
            pattern: "^[A-Za-z0-9._:-]+$",
          },
          description: nonEmptyString,
        },
        additionalProperties: false,
      },
    },
    processingDestinations: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: {
        type: "object",
        required: ["processor", "purpose", "location", "privacyPolicyUrl"],
        properties: {
          processor: nonEmptyString,
          purpose: nonEmptyString,
          location: nonEmptyString,
          privacyPolicyUrl: httpsUrl,
        },
        additionalProperties: false,
      },
    },
    storage: {
      type: "object",
      required: ["application", "provider"],
      properties: {
        application: {
          type: "object",
          required: ["storesPrompt", "storesResponse", "location"],
          properties: {
            storesPrompt: { type: "boolean" },
            storesResponse: { type: "boolean" },
            location: nonEmptyString,
          },
          additionalProperties: false,
        },
        provider: policyReference,
      },
      additionalProperties: false,
    },
    retention: {
      type: "object",
      required: ["application", "provider"],
      properties: {
        application: {
          type: "object",
          required: ["uploadMinutes", "sourceDays", "artifactDays"],
          properties: {
            uploadMinutes: {
              type: "integer",
              minimum: 1,
              maximum: Number.MAX_SAFE_INTEGER,
            },
            sourceDays: {
              type: "integer",
              minimum: 1,
              maximum: Number.MAX_SAFE_INTEGER,
            },
            artifactDays: {
              type: "integer",
              minimum: 1,
              maximum: Number.MAX_SAFE_INTEGER,
            },
          },
          additionalProperties: false,
        },
        provider: policyReference,
      },
      additionalProperties: false,
    },
    trainingUse: {
      type: "object",
      required: ["status", "summary", "policyUrl"],
      properties: {
        status: { enum: ["not-used", "used", "depends"] },
        summary: nonEmptyString,
        policyUrl: httpsUrl,
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validateShape = ajv.compile(aiDataDisclosureV1Schema);

function validationErrors(
  errors: ErrorObject[] | null | undefined,
): AiDataDisclosureValidationError[] {
  return (errors ?? []).map((error) => ({
    code: `schema:${error.keyword}`,
    path: error.instancePath || "/",
    message: error.message ?? "AI data disclosure validation failed",
  }));
}

export function parseAiDataDisclosure(
  value: unknown,
): AiDataDisclosureValidationResult {
  if (!validateShape(value)) {
    return { ok: false, errors: validationErrors(validateShape.errors) };
  }
  return { ok: true, value: value as AiDataDisclosureV1 };
}
