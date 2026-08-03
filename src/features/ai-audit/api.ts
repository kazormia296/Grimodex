import packageJson from "../../../package.json";
import { useWorkspaceStore } from "@/features/workspace/store";
import { invoke } from "@/lib/tauri";
import type {
  AiAuditAppendResult,
  AiAuditCaptureState,
  AiAuditErrorSnapshot,
  AiAuditEventInput,
  AiAuditExecutionHandle,
  AiAuditJsonObject,
  AiAuditJsonValue,
  AiAuditRequestSnapshot,
  AiAuditRedactionRecord,
  AiAuditSnapshot,
  AiAuditVerifyResult,
  BeginAiAuditExecutionInput,
} from "./types";

const REDACTED_CREDENTIAL = "[REDACTED:credential]" as const;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

interface PendingRedaction {
  readonly original: string;
  readonly path: string;
  readonly ruleId: string;
}

const CREDENTIAL_KEY_SUFFIXES = [
  "authorization",
  "authentication",
  "auth",
  "api_key",
  "access_token",
  "token",
  "bearer",
  "access_key_id",
  "secret_access_key",
  "private_key",
  "secret",
  "password",
  "passwd",
  "cookie",
] as const;

/**
 * Diagnostics often spell credentials with a provider prefix
 * (`OPENAI_API_KEY`, `ANTHROPIC_TOKEN`, `azureOpenAiAccessToken`). Normalize
 * separators/camelCase and classify by the credential suffix so adding a new
 * provider cannot silently bypass the diagnostic-only sanitizer.
 */
function isCredentialDiagnosticKey(key: string): boolean {
  const normalized = key
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
  return (
    normalized.split("_").includes("auth") ||
    CREDENTIAL_KEY_SUFFIXES.some(
      (suffix) => normalized === suffix || normalized.endsWith(`_${suffix}`),
    )
  );
}

export async function sanitizeAiAuditDiagnostic(
  diagnostic: string,
  path: string,
): Promise<{
  readonly value: string;
  readonly redactions: readonly AiAuditRedactionRecord[];
}> {
  const pending: PendingRedaction[] = [];
  const remember = (original: string, ruleId: string): string => {
    pending.push({ original, path, ruleId });
    return REDACTED_CREDENTIAL;
  };

  let value = diagnostic.replace(/https?:\/\/[^\s"'<>]+/giu, (candidate) => {
    try {
      const url = new URL(candidate);
      if (!url.username && !url.password && !url.search && !url.hash) {
        return candidate;
      }
      const userInfo =
        url.username || url.password ? `${REDACTED_CREDENTIAL}@` : "";
      const queryKeys = Array.from(url.searchParams.keys());
      const query =
        queryKeys.length === 0
          ? ""
          : `?${queryKeys
              .map((key) => `${encodeURIComponent(key)}=${REDACTED_CREDENTIAL}`)
              .join("&")}`;
      const fragment = url.hash ? `#${REDACTED_CREDENTIAL}` : "";
      pending.push({
        original: candidate,
        path,
        ruleId: "transport-url-credentials-v1",
      });
      return `${url.protocol}//${userInfo}${url.host}${url.pathname}${query}${fragment}`;
    } catch {
      return candidate;
    }
  });

  // Serialized JSON has a closing quote between the sensitive property name
  // and `:` (for example `{"api_key":"secret"}`), so it cannot be covered by
  // the assignment/header rule below without a dedicated shape.
  value = value.replace(
    /(["'])([^"'\\\r\n]{1,128})\1\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gu,
    (match, keyQuote: string, key: string, secret: string) => {
      if (!isCredentialDiagnosticKey(key)) return match;
      const valueQuote = secret[0] ?? '"';
      return `${keyQuote}${key}${keyQuote}:${valueQuote}${remember(
        secret,
        "transport-diagnostic-json-property-v1",
      )}${valueQuote}`;
    },
  );

  value = value.replace(
    /(^|\r?\n)([A-Za-z][A-Za-z0-9_. -]{0,127})\s*:\s*([^\r\n]*)/gu,
    (match, lineStart: string, key: string, secret: string) => {
      if (!isCredentialDiagnosticKey(key)) return match;
      return `${lineStart}${key}: ${remember(
        secret,
        "transport-diagnostic-header-v1",
      )}`;
    },
  );

  value = value.replace(
    /\b([A-Za-z][A-Za-z0-9_.-]{0,127})\b\s*([:=])\s*("[^"]*"|'[^']*'|(?:Bearer\s+)?[^\s,;]+)/giu,
    (match, key: string, separator: string, secret: string) => {
      if (!isCredentialDiagnosticKey(key)) return match;
      if (secret.includes(REDACTED_CREDENTIAL)) return match;
      return `${key}${separator} ${remember(
        secret,
        "transport-diagnostic-assignment-v1",
      )}`;
    },
  );
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, (secret) =>
    remember(secret, "transport-bearer-v1"),
  );
  value = value.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, (secret) =>
    remember(secret, "transport-api-key-token-v1"),
  );

  const redactions = await Promise.all(
    pending.map(async ({ original, path: redactionPath, ruleId }) => ({
      path: redactionPath,
      category: "credential" as const,
      ruleId,
      originalSha256: await sha256Hex(original),
      originalByteLength: new TextEncoder().encode(original).byteLength,
      placeholder: REDACTED_CREDENTIAL,
      reversible: false as const,
    })),
  );
  return { value, redactions };
}

function errorSnapshot(error: unknown): AiAuditErrorSnapshot {
  if (error instanceof Error) {
    const code = (error as Error & { readonly code?: unknown }).code;
    return {
      name: error.name || "Error",
      message: error.message,
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return {
      name: typeof record.name === "string" ? record.name : "Error",
      message:
        typeof record.message === "string"
          ? record.message
          : "Non-Error transport failure",
      ...(typeof record.code === "string" ? { code: record.code } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

async function sanitizedErrorSnapshot(error: unknown): Promise<{
  readonly error: AiAuditErrorSnapshot;
  readonly redactions: readonly AiAuditRedactionRecord[];
}> {
  const snapshot = errorSnapshot(error);
  const [name, message, code] = await Promise.all([
    sanitizeAiAuditDiagnostic(snapshot.name, "error.name"),
    sanitizeAiAuditDiagnostic(snapshot.message, "error.message"),
    snapshot.code === undefined
      ? Promise.resolve({ value: undefined, redactions: [] as const })
      : sanitizeAiAuditDiagnostic(snapshot.code, "error.code"),
  ]);
  return {
    error: {
      name: name.value,
      message: message.value,
      ...(code.value === undefined ? {} : { code: code.value }),
    },
    redactions: [...name.redactions, ...message.redactions, ...code.redactions],
  };
}

export function snapshotAiAuditWorkspacePath(): string {
  const state = useWorkspaceStore.getState();
  if (!state.activeWorkspacePath || state.workspaceSwitchInProgress) {
    throw new Error(
      "AI audit requires a stable active workspace before AI dispatch",
    );
  }
  return state.activeWorkspacePath;
}

export function assertAiAuditWorkspacePath(
  expectedWorkspacePath: string,
): void {
  const activeWorkspacePath = snapshotAiAuditWorkspacePath();
  if (activeWorkspacePath !== expectedWorkspacePath) {
    throw new Error(
      `AI_AUDIT_WORKSPACE_CHANGED: expected ${expectedWorkspacePath}, active ${activeWorkspacePath}`,
    );
  }
}

function event(
  handle: AiAuditExecutionHandle,
  eventType: AiAuditEventInput["eventType"],
  payload: AiAuditEventInput["payload"],
  timestamp = Date.now(),
): AiAuditEventInput {
  return {
    eventId: crypto.randomUUID(),
    executionId: handle.executionId,
    operationId: handle.operationId,
    parentExecutionId: handle.parentExecutionId,
    pathId: handle.pathId,
    eventType,
    timestamp,
    payload: { ...payload, appVersion: packageJson.version },
  };
}

async function append(
  handle: AiAuditExecutionHandle,
  events: readonly AiAuditEventInput[],
): Promise<AiAuditAppendResult> {
  const args = {
    projectId: handle.projectId,
    expectedWorkspacePath: handle.expectedWorkspacePath,
    events,
  };
  try {
    return await invoke<AiAuditAppendResult>("ai_audit_append_batch", args);
  } catch {
    // The first call may have committed durably and only lost its reply. Reuse
    // the exact eventIds so the native idempotency key makes this retry safe.
    return invoke<AiAuditAppendResult>("ai_audit_append_batch", args);
  }
}

function withOptionalMetadata(
  payload: AiAuditJsonObject,
  metadata: AiAuditJsonObject | undefined,
): AiAuditJsonObject {
  return metadata === undefined ? payload : { ...payload, metadata };
}

async function beginInWorkspace(
  input: BeginAiAuditExecutionInput,
  expectedWorkspacePath: string,
): Promise<AiAuditExecutionHandle> {
  const startedAt = input.timestamp ?? Date.now();
  const captureState = input.captureState ?? "complete";
  const limitations = input.limitations;
  const handle: AiAuditExecutionHandle = {
    projectId: input.projectId,
    expectedWorkspacePath,
    operationId: input.operationId ?? crypto.randomUUID(),
    executionId: input.executionId ?? crypto.randomUUID(),
    parentExecutionId: input.parentExecutionId ?? null,
    pathId: input.pathId,
    startedAt,
  };
  await append(handle, [
    event(
      handle,
      "execution.started",
      withOptionalMetadata(
        {
          captureState,
          ...(limitations === undefined ? {} : { limitations }),
        },
        input.metadata,
      ) as AiAuditEventInput["payload"],
      startedAt,
    ),
    event(
      handle,
      "request.prepared",
      withOptionalMetadata(
        {
          captureState,
          credentialsExcluded: true,
          request: input.request as unknown as AiAuditJsonObject,
          ...(limitations === undefined ? {} : { limitations }),
        },
        input.metadata,
      ) as AiAuditEventInput["payload"],
      startedAt,
    ),
  ]);
  return handle;
}

/** Resolve only after the exact request snapshot is durably committed. */
export async function beginAiAuditExecution(
  input: BeginAiAuditExecutionInput,
): Promise<AiAuditExecutionHandle> {
  if (input.expectedWorkspacePath !== undefined) {
    return beginAiAuditExecutionInWorkspace(input, input.expectedWorkspacePath);
  }
  return beginInWorkspace(input, snapshotAiAuditWorkspacePath());
}

/**
 * Begin under a caller-owned immutable workspace authority. Both this
 * renderer check and the native append compare the same path, so an in-flight
 * workspace switch cannot redirect the audit record to the newly active DB.
 */
export async function beginAiAuditExecutionInWorkspace(
  input: BeginAiAuditExecutionInput,
  expectedWorkspacePath: string,
): Promise<AiAuditExecutionHandle> {
  if (!expectedWorkspacePath.trim()) {
    throw new Error("AI audit requires a non-empty expected workspace path");
  }
  assertAiAuditWorkspacePath(expectedWorkspacePath);
  return beginInWorkspace(input, expectedWorkspacePath);
}

export async function markAiAuditDispatched(
  handle: AiAuditExecutionHandle,
  details: AiAuditJsonObject = {},
): Promise<void> {
  await append(handle, [
    event(handle, "request.dispatched", {
      captureState: "complete",
      ...details,
    }),
  ]);
}

export const AI_AUDIT_PARTIAL_BATCH_MAX_ITEMS = 64;

export interface AiAuditPartialInput {
  readonly response: AiAuditJsonValue;
  /** Timestamp captured when the application received this exact fragment. */
  readonly receivedAt: number;
  /** Completeness of this observed fragment, not of the eventual response. */
  readonly captureState?: AiAuditCaptureState;
  /** Diagnostic-only redaction evidence belongs at the event payload level. */
  readonly redactions?: readonly AiAuditRedactionRecord[];
}

export type AiAuditOrderedObservationInput =
  | ({
      readonly kind: "response.partial";
    } & AiAuditPartialInput)
  | {
      readonly kind: "request.effective";
      readonly request: AiAuditRequestSnapshot;
      readonly receivedAt: number;
      readonly captureState: AiAuditCaptureState;
      readonly limitations?: readonly string[];
      readonly metadata?: AiAuditJsonObject;
    };

/**
 * Append heterogeneous observations in one ordered native batch. This is used
 * when an external runtime confirms its effective model-visible request on
 * the same event stream as response fragments.
 */
export async function recordAiAuditOrderedObservations(
  handle: AiAuditExecutionHandle,
  observations: readonly AiAuditOrderedObservationInput[],
): Promise<void> {
  if (observations.length === 0) return;
  if (observations.length > AI_AUDIT_PARTIAL_BATCH_MAX_ITEMS) {
    throw new RangeError(
      `AI audit observation batches are limited to ${AI_AUDIT_PARTIAL_BATCH_MAX_ITEMS} events`,
    );
  }
  await append(
    handle,
    observations.map((observation) => {
      if (observation.kind === "request.effective") {
        return event(
          handle,
          "request.prepared",
          withOptionalMetadata(
            {
              captureState: observation.captureState,
              credentialsExcluded: true,
              effectiveRequestReceipt: true,
              request: observation.request as unknown as AiAuditJsonObject,
              ...(observation.limitations === undefined
                ? {}
                : { limitations: observation.limitations }),
            },
            observation.metadata,
          ) as AiAuditEventInput["payload"],
          observation.receivedAt,
        );
      }
      return event(
        handle,
        "response.partial",
        {
          captureState: observation.captureState ?? "complete",
          response: observation.response,
          ...(observation.redactions === undefined ||
          observation.redactions.length === 0
            ? {}
            : { redactions: observation.redactions }),
        },
        observation.receivedAt,
      );
    }),
  );
}

/**
 * Persist several independently timestamped partial rows with one native IPC.
 * Each input remains its own response.partial event; only the transport append
 * is batched. The cap matches the ordered stream microbatch queue.
 */
export async function recordAiAuditPartials(
  handle: AiAuditExecutionHandle,
  partials: readonly AiAuditPartialInput[],
): Promise<void> {
  await recordAiAuditOrderedObservations(
    handle,
    partials.map((partial) => ({
      kind: "response.partial" as const,
      ...partial,
    })),
  );
}

/**
 * Queue persistence can fail after execution.started/request.prepared already
 * committed. Try one direct terminal append on the same execution, bypassing
 * the failed queue. A storage outage can still make this impossible; callers
 * deliberately swallow that second failure after emitting a local diagnostic
 * so this recovery path cannot recurse forever.
 */
export async function attemptAiAuditPersistenceFailureTerminal(
  handle: AiAuditExecutionHandle,
  input: {
    readonly persistenceError: unknown;
    readonly partialResponse?: AiAuditJsonValue;
    readonly metadata?: AiAuditJsonObject;
  },
): Promise<boolean> {
  try {
    await failAiAuditExecution(handle, {
      error: input.persistenceError,
      partialResponse: input.partialResponse,
      metadata: {
        auditQueuePersistenceFailed: true,
        directTerminalRecoveryAttempted: true,
        auditStorageFailureMayPreventTerminal: true,
        ...input.metadata,
      },
    });
    return true;
  } catch (terminalError) {
    console.error(
      "AI audit direct failure terminal could not be persisted",
      terminalError,
    );
    return false;
  }
}

export async function recordAiAuditPartial(
  handle: AiAuditExecutionHandle,
  response: AiAuditJsonValue,
  options: {
    /** Completeness of this observed fragment, not of the eventual response. */
    readonly captureState?: AiAuditCaptureState;
    /** Diagnostic-only redaction evidence belongs at the event payload level. */
    readonly redactions?: readonly AiAuditRedactionRecord[];
    /** Optional receive timestamp for compatibility callers that already have it. */
    readonly receivedAt?: number;
  } = {},
): Promise<void> {
  await recordAiAuditPartials(handle, [
    {
      response,
      receivedAt: options.receivedAt ?? Date.now(),
      captureState: options.captureState,
      redactions: options.redactions,
    },
  ]);
}

export async function completeAiAuditExecution(
  handle: AiAuditExecutionHandle,
  input: {
    readonly response: AiAuditJsonValue;
    readonly usage?: AiAuditJsonObject;
    readonly metadata?: AiAuditJsonObject;
  },
): Promise<void> {
  const completedAt = Date.now();
  await append(handle, [
    event(
      handle,
      "response.completed",
      withOptionalMetadata(
        { captureState: "complete", response: input.response },
        input.metadata,
      ) as AiAuditEventInput["payload"],
      completedAt,
    ),
    event(
      handle,
      "execution.succeeded",
      withOptionalMetadata(
        input.usage === undefined
          ? { captureState: "complete" }
          : { captureState: "complete", usage: input.usage },
        input.metadata,
      ) as AiAuditEventInput["payload"],
      completedAt,
    ),
  ]);
}

export async function cacheHitAiAuditExecution(
  handle: AiAuditExecutionHandle,
  input: {
    readonly response?: AiAuditJsonValue;
    readonly metadata?: AiAuditJsonObject;
  } = {},
): Promise<void> {
  const completedAt = Date.now();
  await append(handle, [
    event(
      handle,
      "execution.cache_hit",
      withOptionalMetadata(
        {
          captureState: "complete",
          modelDispatched: false,
          ...(input.response === undefined ? {} : { response: input.response }),
        },
        input.metadata,
      ) as AiAuditEventInput["payload"],
      completedAt,
    ),
  ]);
}

export async function skipAiAuditExecution(
  handle: AiAuditExecutionHandle,
  input: {
    readonly reason: string;
    readonly metadata?: AiAuditJsonObject;
  },
): Promise<void> {
  const skippedAt = Date.now();
  const sanitizedReason = await sanitizeAiAuditDiagnostic(
    input.reason,
    "reason",
  );
  await append(handle, [
    event(
      handle,
      "execution.skipped",
      withOptionalMetadata(
        {
          captureState:
            sanitizedReason.redactions.length === 0 ? "complete" : "redacted",
          modelDispatched: false,
          reason: sanitizedReason.value,
          ...(sanitizedReason.redactions.length === 0
            ? {}
            : { redactions: sanitizedReason.redactions }),
        },
        input.metadata,
      ) as AiAuditEventInput["payload"],
      skippedAt,
    ),
  ]);
}

export async function failAiAuditExecution(
  handle: AiAuditExecutionHandle,
  input: {
    readonly error: unknown;
    readonly partialResponse?: AiAuditJsonValue;
    readonly metadata?: AiAuditJsonObject;
  },
): Promise<void> {
  const failedAt = Date.now();
  const sanitized = await sanitizedErrorSnapshot(input.error);
  const events: AiAuditEventInput[] = [];
  if (input.partialResponse !== undefined) {
    events.push(
      event(
        handle,
        "response.partial",
        { captureState: "partial", response: input.partialResponse },
        failedAt,
      ),
    );
  }
  events.push(
    event(
      handle,
      "execution.failed",
      withOptionalMetadata(
        {
          captureState:
            sanitized.redactions.length > 0
              ? "redacted"
              : input.partialResponse === undefined
                ? "complete"
                : "partial",
          error: sanitized.error as unknown as AiAuditJsonObject,
          ...(sanitized.redactions.length === 0
            ? {}
            : { redactions: sanitized.redactions }),
        },
        input.metadata,
      ) as AiAuditEventInput["payload"],
      failedAt,
    ),
  );
  await append(handle, events);
}

export async function cancelAiAuditExecution(
  handle: AiAuditExecutionHandle,
  input: {
    readonly reason: string;
    readonly partialResponse?: AiAuditJsonValue;
    readonly metadata?: AiAuditJsonObject;
  },
): Promise<void> {
  const cancelledAt = Date.now();
  const sanitizedReason = await sanitizeAiAuditDiagnostic(
    input.reason,
    "reason",
  );
  const events: AiAuditEventInput[] = [];
  if (input.partialResponse !== undefined) {
    events.push(
      event(
        handle,
        "response.partial",
        { captureState: "partial", response: input.partialResponse },
        cancelledAt,
      ),
    );
  }
  events.push(
    event(
      handle,
      "execution.cancelled",
      withOptionalMetadata(
        {
          captureState:
            sanitizedReason.redactions.length > 0
              ? "redacted"
              : input.partialResponse === undefined
                ? "complete"
                : "partial",
          reason: sanitizedReason.value,
          ...(sanitizedReason.redactions.length === 0
            ? {}
            : { redactions: sanitizedReason.redactions }),
        },
        input.metadata,
      ) as AiAuditEventInput["payload"],
      cancelledAt,
    ),
  );
  await append(handle, events);
}

export interface NextAttemptInput {
  readonly request: AiAuditRequestSnapshot;
  readonly reason: string;
  readonly executionId?: string;
  readonly pathId?: string;
  readonly metadata?: AiAuditJsonObject;
  readonly captureState?: BeginAiAuditExecutionInput["captureState"];
  readonly limitations?: BeginAiAuditExecutionInput["limitations"];
}

async function nextAttempt(
  handle: AiAuditExecutionHandle,
  input: NextAttemptInput,
  relationType: "execution.retrying" | "execution.fallback",
): Promise<AiAuditExecutionHandle> {
  const timestamp = Date.now();
  const sanitizedReason = await sanitizeAiAuditDiagnostic(
    input.reason,
    "reason",
  );
  const relationPayload = {
    captureState:
      sanitizedReason.redactions.length === 0 ? "complete" : "redacted",
    reason: sanitizedReason.value,
    ...(sanitizedReason.redactions.length === 0
      ? {}
      : { redactions: sanitizedReason.redactions }),
  } as AiAuditEventInput["payload"];
  await append(handle, [
    event(handle, relationType, relationPayload, timestamp),
    event(
      handle,
      "execution.failed",
      {
        ...relationPayload,
        nextAttempt: relationType,
      },
      timestamp,
    ),
  ]);
  return beginInWorkspace(
    {
      projectId: handle.projectId,
      pathId: input.pathId ?? handle.pathId,
      operationId: handle.operationId,
      executionId: input.executionId,
      parentExecutionId: handle.executionId,
      request: input.request,
      metadata: input.metadata,
      captureState: input.captureState,
      limitations: input.limitations,
      timestamp,
    },
    handle.expectedWorkspacePath,
  );
}

export async function retryAiAuditExecution(
  handle: AiAuditExecutionHandle,
  input: NextAttemptInput,
): Promise<AiAuditExecutionHandle> {
  return nextAttempt(handle, input, "execution.retrying");
}

export async function fallbackAiAuditExecution(
  handle: AiAuditExecutionHandle,
  input: NextAttemptInput & { readonly pathId: string },
): Promise<AiAuditExecutionHandle> {
  return nextAttempt(handle, input, "execution.fallback");
}

export async function readAiAuditSnapshot(
  projectId: string | null,
  options: {
    readonly afterSequence?: number;
    readonly highWaterSequence?: number;
    readonly limit?: number;
    readonly expectedWorkspacePath?: string;
  } = {},
): Promise<AiAuditSnapshot> {
  return invoke<AiAuditSnapshot>("ai_audit_read_snapshot", {
    projectId,
    expectedWorkspacePath:
      options.expectedWorkspacePath ?? snapshotAiAuditWorkspacePath(),
    afterSequence: options.afterSequence,
    highWaterSequence: options.highWaterSequence,
    limit: options.limit,
  });
}

export async function verifyAiAuditChain(
  projectId: string | null,
  options: {
    readonly highWaterSequence?: number;
    readonly expectedWorkspacePath?: string;
  } = {},
): Promise<AiAuditVerifyResult> {
  return invoke<AiAuditVerifyResult>("ai_audit_verify", {
    projectId,
    expectedWorkspacePath:
      options.expectedWorkspacePath ?? snapshotAiAuditWorkspacePath(),
    highWaterSequence: options.highWaterSequence,
  });
}
