import {
  HOSTED_EDITOR_AI_LIMITS,
  parseHostedEditorAiToolCalls,
  type HostedEditorAiToolCall,
} from "@grimodex/scan-contract";
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
  toolCalls?: HostedEditorAiToolCall[];
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
  allowedToolNames?: ReadonlySet<string>,
): EditorAiOperationArtifact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidEditorAiArtifactError(
      "editor AI operation artifact must be an object",
    );
  }
  const record = value as Record<string, unknown>;
  const completed = record.status === "completed";
  const failed = record.status === "failed";
  const parsedToolCalls =
    record.toolCalls === undefined
      ? null
      : parseHostedEditorAiToolCalls(record.toolCalls, allowedToolNames);
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
        (parsedToolCalls !== null &&
          (!parsedToolCalls.ok || parsedToolCalls.value.length === 0)) ||
        (record.response.length === 0 && parsedToolCalls === null) ||
        record.httpStatus !== undefined ||
        record.errorCode !== undefined)) ||
    (failed &&
      (record.response !== undefined ||
        record.toolCalls !== undefined ||
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

async function readBoundedArtifactBody(
  body: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > HOSTED_EDITOR_AI_LIMITS.maxArtifactBytes) {
      await reader.cancel("editor AI operation artifact is too large");
      throw new InvalidEditorAiArtifactError(
        "editor AI operation artifact is too large",
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function readEditorAiArtifact(
  bucket: R2BucketLike,
  objectKey: string,
  allowedToolNames?: ReadonlySet<string>,
): Promise<EditorAiOperationArtifact | null> {
  const object = await bucket.get(objectKey);
  if (!object) return null;
  if (!object.body) {
    throw new InvalidEditorAiArtifactError(
      "editor AI operation artifact is empty",
    );
  }
  if (
    typeof object.size === "number" &&
    object.size > HOSTED_EDITOR_AI_LIMITS.maxArtifactBytes
  ) {
    throw new InvalidEditorAiArtifactError(
      "editor AI operation artifact is too large",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(await readBoundedArtifactBody(object.body)) as unknown;
  } catch (cause) {
    if (cause instanceof InvalidEditorAiArtifactError) throw cause;
    throw new InvalidEditorAiArtifactError(
      "editor AI operation artifact is invalid JSON",
    );
  }
  return parseEditorAiArtifact(value, allowedToolNames);
}
