import { freezeDeep } from "../source/immutability";
import type { Sha256Digest } from "../source/types";

export interface NarrativeEvalVersions {
  readonly prompt: string;
  readonly responseSchema: string;
  readonly extractor: string;
  readonly parser: string;
}

export interface NarrativeEvalReplayArtifact {
  readonly schemaVersion: 1;
  readonly replayId: string;
  readonly caseId: string;
  readonly capturedAt: string;
  readonly corpusDigest: Sha256Digest;
  readonly versions: NarrativeEvalVersions;
  readonly promptDigest: Sha256Digest;
  readonly response: {
    readonly rawText: string;
    readonly digest: Sha256Digest;
  };
  readonly model: {
    readonly provider: string;
    readonly requestedModel: string;
    readonly resolvedModel: string;
    readonly reasoningEffort: string;
  };
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly runtimeMs: number;
    readonly costUsd: number;
  };
}

export interface NarrativeEvalReplayContext {
  readonly caseId: string;
  readonly corpusDigest: string;
  readonly versions: NarrativeEvalVersions;
}

export interface NarrativeEvalReplayDiagnostic {
  readonly code: string;
  readonly path?: string;
  readonly message: string;
}

export type NarrativeEvalReplayValidationResult =
  | { readonly ok: true; readonly value: NarrativeEvalReplayArtifact }
  | {
      readonly ok: false;
      readonly diagnostics: readonly NarrativeEvalReplayDiagnostic[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  "apikey",
  "api_key",
  "authorization",
  "bearertoken",
  "bearer_token",
  "credential",
  "credentials",
  "password",
  "secret",
]);

function containsCredentialField(value: unknown): boolean {
  const seen = new Set<object>();
  const visit = (candidate: unknown): boolean => {
    if (!candidate || typeof candidate !== "object") return false;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.some(visit);
    for (const [key, nested] of Object.entries(candidate)) {
      if (FORBIDDEN_CREDENTIAL_KEYS.has(key.toLowerCase())) return true;
      if (visit(nested)) return true;
    }
    return false;
  };
  return visit(value);
}

function pushMismatch(
  diagnostics: NarrativeEvalReplayDiagnostic[],
  actual: unknown,
  expected: string,
  code: string,
  path: string,
): void {
  if (actual !== expected) {
    diagnostics.push({ code, path, message: `${path} does not match the run` });
  }
}

/** Validate an untrusted replay before invoking a pinned production parser. */
export function validateNarrativeEvalReplayArtifact(
  candidate: unknown,
  context: NarrativeEvalReplayContext,
): NarrativeEvalReplayValidationResult {
  if (containsCredentialField(candidate)) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "REPLAY_CREDENTIAL_PRESENT",
          message: "Replay artifacts must not contain transport credentials",
        },
      ],
    };
  }
  const diagnostics: NarrativeEvalReplayDiagnostic[] = [];
  if (!isRecord(candidate)) {
    return {
      ok: false,
      diagnostics: [
        { code: "REPLAY_INVALID", message: "Replay must be an object" },
      ],
    };
  }
  if (candidate.schemaVersion !== 1) {
    diagnostics.push({
      code: "REPLAY_SCHEMA_VERSION_UNSUPPORTED",
      path: "schemaVersion",
      message: "Replay schemaVersion must be 1",
    });
  }
  for (const field of ["replayId", "caseId", "capturedAt"] as const) {
    if (!isNonEmptyString(candidate[field])) {
      diagnostics.push({
        code: `REPLAY_${field.toUpperCase()}_REQUIRED`,
        path: field,
        message: `${field} is required`,
      });
    }
  }
  if (
    typeof candidate.capturedAt === "string" &&
    !Number.isFinite(Date.parse(candidate.capturedAt))
  ) {
    diagnostics.push({
      code: "REPLAY_CAPTURED_AT_INVALID",
      path: "capturedAt",
      message: "capturedAt must be a timestamp",
    });
  }
  pushMismatch(
    diagnostics,
    candidate.caseId,
    context.caseId,
    "REPLAY_CASE_ID_MISMATCH",
    "caseId",
  );
  if (!isDigest(candidate.corpusDigest)) {
    diagnostics.push({
      code: "REPLAY_CORPUS_DIGEST_INVALID",
      path: "corpusDigest",
      message: "corpusDigest must be SHA-256",
    });
  } else {
    pushMismatch(
      diagnostics,
      candidate.corpusDigest,
      context.corpusDigest,
      "REPLAY_CORPUS_DIGEST_MISMATCH",
      "corpusDigest",
    );
  }
  if (!isDigest(candidate.promptDigest)) {
    diagnostics.push({
      code: "REPLAY_PROMPT_DIGEST_INVALID",
      path: "promptDigest",
      message: "promptDigest must be SHA-256",
    });
  }

  const versionCodes: Record<keyof NarrativeEvalVersions, string> = {
    prompt: "REPLAY_PROMPT_VERSION_MISMATCH",
    responseSchema: "REPLAY_RESPONSE_SCHEMA_VERSION_MISMATCH",
    extractor: "REPLAY_EXTRACTOR_VERSION_MISMATCH",
    parser: "REPLAY_PARSER_VERSION_MISMATCH",
  };
  if (!isRecord(candidate.versions)) {
    diagnostics.push({
      code: "REPLAY_VERSIONS_REQUIRED",
      path: "versions",
      message: "Pinned versions are required",
    });
  } else {
    for (const field of Object.keys(versionCodes) as Array<
      keyof NarrativeEvalVersions
    >) {
      pushMismatch(
        diagnostics,
        candidate.versions[field],
        context.versions[field],
        versionCodes[field],
        `versions.${field}`,
      );
    }
  }

  if (!isRecord(candidate.response)) {
    diagnostics.push({
      code: "REPLAY_RESPONSE_REQUIRED",
      path: "response",
      message: "Raw response is required",
    });
  } else {
    if (typeof candidate.response.rawText !== "string") {
      diagnostics.push({
        code: "REPLAY_RAW_RESPONSE_REQUIRED",
        path: "response.rawText",
        message: "Raw response text is required",
      });
    }
    if (!isDigest(candidate.response.digest)) {
      diagnostics.push({
        code: "REPLAY_RESPONSE_DIGEST_INVALID",
        path: "response.digest",
        message: "Response digest must be SHA-256",
      });
    }
  }

  if (!isRecord(candidate.model)) {
    diagnostics.push({
      code: "REPLAY_MODEL_REQUIRED",
      path: "model",
      message: "Model provenance is required",
    });
  } else {
    if (!isNonEmptyString(candidate.model.provider)) {
      diagnostics.push({
        code: "REPLAY_PROVIDER_REQUIRED",
        path: "model.provider",
        message: "Provider is required",
      });
    }
    if (!isNonEmptyString(candidate.model.requestedModel)) {
      diagnostics.push({
        code: "REPLAY_REQUESTED_MODEL_REQUIRED",
        path: "model.requestedModel",
        message: "Requested model is required",
      });
    }
    if (!isNonEmptyString(candidate.model.resolvedModel)) {
      diagnostics.push({
        code: "REPLAY_RESOLVED_MODEL_REQUIRED",
        path: "model.resolvedModel",
        message: "Provider-resolved model is required",
      });
    }
    if (!isNonEmptyString(candidate.model.reasoningEffort)) {
      diagnostics.push({
        code: "REPLAY_REASONING_EFFORT_REQUIRED",
        path: "model.reasoningEffort",
        message: "Reasoning effort is required",
      });
    }
  }

  if (!isRecord(candidate.usage)) {
    diagnostics.push({
      code: "REPLAY_USAGE_REQUIRED",
      path: "usage",
      message: "Usage metadata is required",
    });
  } else {
    for (const field of [
      "inputTokens",
      "outputTokens",
      "runtimeMs",
      "costUsd",
    ] as const) {
      if (!isNonNegativeNumber(candidate.usage[field])) {
        diagnostics.push({
          code: "REPLAY_USAGE_INVALID",
          path: `usage.${field}`,
          message: `${field} must be a non-negative number`,
        });
      }
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return freezeDeep({
    ok: true,
    value: structuredClone(candidate) as unknown as NarrativeEvalReplayArtifact,
  });
}
