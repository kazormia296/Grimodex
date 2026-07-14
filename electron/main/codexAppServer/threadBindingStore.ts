import type {
  CodexRuntimeThreadBinding,
  JsonRpcId,
} from "../../shared/codexAppProtocol.js";
import type { NapiBackendLike } from "../../shared/ipcContract.js";

export interface RuntimeThreadBindingStore {
  get(
    projectId: string,
    sessionId: string,
    runtime: string,
  ): Promise<CodexRuntimeThreadBinding | null>;
  upsert(binding: CodexRuntimeThreadBinding): Promise<void>;
  delete(projectId: string, sessionId: string, runtime: string): Promise<void>;
}

function parseBinding(value: unknown): CodexRuntimeThreadBinding | null {
  if (value === null) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid runtime thread binding response");
  }
  const record = value as Record<string, unknown>;
  const required = [
    "sessionId",
    "runtime",
    "externalThreadId",
    "projectId",
    "createdAt",
    "updatedAt",
  ] as const;
  for (const key of required) {
    if (typeof record[key] !== "string" || record[key].length === 0) {
      throw new Error(`Invalid runtime thread binding field: ${key}`);
    }
  }
  const optionalString = (key: string): string | null =>
    typeof record[key] === "string" ? record[key] : null;
  return {
    sessionId: record.sessionId as string,
    runtime: record.runtime as string,
    externalThreadId: record.externalThreadId as string,
    projectId: record.projectId as string,
    historyRevision: optionalString("historyRevision"),
    lastTurnId: optionalString("lastTurnId"),
    createdAt: record.createdAt as string,
    updatedAt: record.updatedAt as string,
  };
}

function unavailable(): Error {
  return new Error("Codex runtime thread binding backend is unavailable");
}

export function createRuntimeThreadBindingStore(
  backend: NapiBackendLike | null,
): RuntimeThreadBindingStore {
  return {
    async get(projectId, sessionId, runtime) {
      if (!backend?.getChatRuntimeThreadBinding) throw unavailable();
      return parseBinding(
        JSON.parse(
          await backend.getChatRuntimeThreadBinding(
            projectId,
            sessionId,
            runtime,
          ),
        ) as unknown,
      );
    },
    async upsert(binding) {
      if (!backend?.upsertChatRuntimeThreadBinding) throw unavailable();
      await backend.upsertChatRuntimeThreadBinding(binding);
    },
    async delete(projectId, sessionId, runtime) {
      if (!backend?.deleteChatRuntimeThreadBinding) throw unavailable();
      await backend.deleteChatRuntimeThreadBinding(
        projectId,
        sessionId,
        runtime,
      );
    },
  };
}

export function parseServerRequestId(value: unknown): JsonRpcId {
  if (
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  ) {
    return value;
  }
  throw new Error("Invalid Codex server request id");
}
