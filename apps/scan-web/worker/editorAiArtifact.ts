import type { R2BucketLike } from "./env";

export interface EditorAiOperationArtifact {
  schemaVersion: "grimodex-scan/editor-ai-operation/1";
  operationId: string;
  requestHash: string;
  status: "completed" | "failed";
  provider: string;
  model: string;
  costWeight: number;
  response?: string;
  httpStatus?: 429 | 503;
  errorCode?: "editor_ai_rate_limited" | "editor_ai_unavailable";
}

export class InvalidEditorAiArtifactError extends Error {}

export function editorAiArtifactKey(
  scanId: string,
  operationId: string,
): string {
  return `artifacts/${scanId}/editor-ai/${operationId.slice("editor-ai:".length)}.json`;
}

export function parseEditorAiArtifact(
  value: unknown,
): EditorAiOperationArtifact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidEditorAiArtifactError(
      "editor AI operation artifact must be an object",
    );
  }
  const record = value as Record<string, unknown>;
  const completed = record.status === "completed";
  const failed = record.status === "failed";
  if (
    record.schemaVersion !== "grimodex-scan/editor-ai-operation/1" ||
    typeof record.operationId !== "string" ||
    !/^editor-ai:[a-f0-9]{64}$/.test(record.operationId) ||
    typeof record.requestHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.requestHash) ||
    (!completed && !failed) ||
    typeof record.provider !== "string" ||
    record.provider.length === 0 ||
    typeof record.model !== "string" ||
    record.model.length === 0 ||
    !Number.isSafeInteger(record.costWeight) ||
    (record.costWeight as number) < 0 ||
    (completed &&
      (typeof record.response !== "string" ||
        record.httpStatus !== undefined ||
        record.errorCode !== undefined)) ||
    (failed &&
      (record.response !== undefined ||
        (record.httpStatus !== undefined &&
          record.httpStatus !== 429 &&
          record.httpStatus !== 503) ||
        (record.errorCode !== "editor_ai_rate_limited" &&
          record.errorCode !== "editor_ai_unavailable")))
  ) {
    throw new InvalidEditorAiArtifactError(
      "editor AI operation artifact failed validation",
    );
  }
  return record as unknown as EditorAiOperationArtifact;
}

export async function readEditorAiArtifact(
  bucket: R2BucketLike,
  objectKey: string,
): Promise<EditorAiOperationArtifact | null> {
  const object = await bucket.get(objectKey);
  if (!object) return null;
  if (!object.body) {
    throw new InvalidEditorAiArtifactError(
      "editor AI operation artifact is empty",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(await new Response(object.body).text()) as unknown;
  } catch {
    throw new InvalidEditorAiArtifactError(
      "editor AI operation artifact is invalid JSON",
    );
  }
  return parseEditorAiArtifact(value);
}
