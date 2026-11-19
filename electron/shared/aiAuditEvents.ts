/**
 * The pure part of the AI audit writer: the event shapes, the diagnostic
 * redaction and the builders of each execution's event batches.
 *
 * Two writers share it (MP-3b, DR-MP3-23): the renderer's
 * `src/features/ai-audit/api.ts` and Electron main's agent audit sink. It was
 * moved here from `api.ts` unchanged; `api.ts` re-exports it, so the bytes of
 * what the renderer writes do not change. The two writers differ only in who
 * appends the batches and in where `appVersion` comes from (the renderer reads
 * `package.json`, main passes `app.getVersion()`), so `appVersion` is an
 * argument and never read here.
 *
 * This file has no import: the renderer and `electron/tsconfig.json` both
 * compile it.
 */

export type AiAuditJsonPrimitive = string | number | boolean | null;
export type AiAuditJsonValue =
  | AiAuditJsonPrimitive
  | AiAuditJsonObject
  | readonly AiAuditJsonValue[];
export interface AiAuditJsonObject {
  readonly [key: string]: AiAuditJsonValue;
}

export const AI_AUDIT_EVENT_TYPES = [
  "execution.started",
  "request.prepared",
  "request.dispatched",
  "transport.attempt.started",
  "transport.attempt.finished",
  "response.partial",
  "response.completed",
  "execution.succeeded",
  "execution.failed",
  "execution.cancelled",
  "execution.skipped",
  "execution.cache_hit",
  "execution.retrying",
  "execution.fallback",
] as const;

export type AiAuditEventType = (typeof AI_AUDIT_EVENT_TYPES)[number];
/** Completeness is evaluated at the event's declared Grimodex boundary. */
export type AiAuditCaptureState =
  | "complete"
  | "partial"
  | "redacted"
  | "truncated"
  | "legacy_missing"
  | "unobservable_provider";

export interface AiAuditEventInput {
  readonly eventId: string;
  readonly executionId: string;
  readonly operationId: string;
  readonly parentExecutionId: string | null;
  readonly pathId: string;
  readonly eventType: AiAuditEventType;
  readonly timestamp: number;
  readonly payload: AiAuditJsonObject & {
    readonly captureState: AiAuditCaptureState;
  };
}

export interface AiAuditRedactionRecord extends AiAuditJsonObject {
  readonly path: string;
  readonly category: "credential";
  readonly ruleId: string;
  readonly originalSha256: string;
  readonly originalByteLength: number;
  readonly placeholder: "[REDACTED:credential]";
  readonly reversible: false;
}

export interface AiAuditErrorSnapshot {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

/** What names one execution's events, plus the app version they carry. */
export interface AiAuditEventContext {
  readonly executionId: string;
  readonly operationId: string;
  readonly parentExecutionId: string | null;
  readonly pathId: string;
  readonly appVersion: string;
}

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

export async function sanitizedErrorSnapshot(error: unknown): Promise<{
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

export function createAiAuditEvent(
  context: AiAuditEventContext,
  eventType: AiAuditEventInput["eventType"],
  payload: AiAuditEventInput["payload"],
  timestamp: number,
): AiAuditEventInput {
  return {
    eventId: crypto.randomUUID(),
    executionId: context.executionId,
    operationId: context.operationId,
    parentExecutionId: context.parentExecutionId,
    pathId: context.pathId,
    eventType,
    timestamp,
    payload: { ...payload, appVersion: context.appVersion },
  };
}

export const TERMINAL_AI_AUDIT_EVENT_TYPES = new Set<
  AiAuditEventInput["eventType"]
>([
  "execution.succeeded",
  "execution.failed",
  "execution.cancelled",
  "execution.skipped",
  "execution.cache_hit",
]);

export function withOptionalMetadata(
  payload: AiAuditJsonObject,
  metadata: AiAuditJsonObject | undefined,
): AiAuditJsonObject {
  return metadata === undefined ? payload : { ...payload, metadata };
}

/** `execution.started` and `request.prepared`: the first batch of a begin. */
export function buildAiAuditBeginEvents(
  context: AiAuditEventContext,
  input: {
    readonly captureState?: AiAuditCaptureState;
    readonly limitations?: readonly string[];
    readonly metadata?: AiAuditJsonObject;
    readonly request: AiAuditJsonObject;
  },
  startedAt: number,
): AiAuditEventInput[] {
  const captureState = input.captureState ?? "complete";
  const limitations = input.limitations;
  return [
    createAiAuditEvent(
      context,
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
    createAiAuditEvent(
      context,
      "request.prepared",
      withOptionalMetadata(
        {
          captureState,
          credentialsExcluded: true,
          request: input.request,
          ...(limitations === undefined ? {} : { limitations }),
        },
        input.metadata,
      ) as AiAuditEventInput["payload"],
      startedAt,
    ),
  ];
}

export function buildAiAuditDispatchedEvent(
  context: AiAuditEventContext,
  details: AiAuditJsonObject,
  timestamp: number,
): AiAuditEventInput {
  return createAiAuditEvent(
    context,
    "request.dispatched",
    { captureState: "complete", ...details },
    timestamp,
  );
}

export function buildAiAuditCompletedEvents(
  context: AiAuditEventContext,
  input: {
    readonly response: AiAuditJsonValue;
    readonly usage?: AiAuditJsonObject;
    readonly metadata?: AiAuditJsonObject;
  },
  completedAt: number,
): AiAuditEventInput[] {
  return [
    createAiAuditEvent(
      context,
      "response.completed",
      withOptionalMetadata(
        { captureState: "complete", response: input.response },
        input.metadata,
      ) as AiAuditEventInput["payload"],
      completedAt,
    ),
    createAiAuditEvent(
      context,
      "execution.succeeded",
      withOptionalMetadata(
        input.usage === undefined
          ? { captureState: "complete" }
          : { captureState: "complete", usage: input.usage },
        input.metadata,
      ) as AiAuditEventInput["payload"],
      completedAt,
    ),
  ];
}

/** The events of a failure, from an already sanitized error snapshot. */
export function buildAiAuditFailedEvents(
  context: AiAuditEventContext,
  sanitized: {
    readonly error: AiAuditErrorSnapshot;
    readonly redactions: readonly AiAuditRedactionRecord[];
  },
  input: {
    readonly partialResponse?: AiAuditJsonValue;
    readonly metadata?: AiAuditJsonObject;
  },
  failedAt: number,
): AiAuditEventInput[] {
  const events: AiAuditEventInput[] = [];
  if (input.partialResponse !== undefined) {
    events.push(
      createAiAuditEvent(
        context,
        "response.partial",
        { captureState: "partial", response: input.partialResponse },
        failedAt,
      ),
    );
  }
  events.push(
    createAiAuditEvent(
      context,
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
  return events;
}

/** The events of a cancellation, from an already sanitized reason. */
export function buildAiAuditCancelledEvents(
  context: AiAuditEventContext,
  sanitizedReason: {
    readonly value: string;
    readonly redactions: readonly AiAuditRedactionRecord[];
  },
  input: {
    readonly partialResponse?: AiAuditJsonValue;
    readonly metadata?: AiAuditJsonObject;
  },
  cancelledAt: number,
): AiAuditEventInput[] {
  const events: AiAuditEventInput[] = [];
  if (input.partialResponse !== undefined) {
    events.push(
      createAiAuditEvent(
        context,
        "response.partial",
        { captureState: "partial", response: input.partialResponse },
        cancelledAt,
      ),
    );
  }
  events.push(
    createAiAuditEvent(
      context,
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
  return events;
}
