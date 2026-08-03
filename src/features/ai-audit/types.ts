export type AiAuditJsonPrimitive = string | number | boolean | null;
export type AiAuditJsonValue =
  | AiAuditJsonPrimitive
  | AiAuditJsonObject
  | readonly AiAuditJsonValue[];
export interface AiAuditJsonObject {
  readonly [key: string]: AiAuditJsonValue;
}

/** Transport credentials are not model-visible request-body data. */
interface TransportSecretExclusions {
  readonly headers?: never;
  readonly authorization?: never;
  readonly apiKey?: never;
  readonly api_key?: never;
  readonly cookie?: never;
  readonly env?: never;
}

export interface AiAuditMessage extends AiAuditJsonObject {
  readonly role: string;
  readonly content: AiAuditJsonValue;
}

interface AiAuditRequestCommon extends TransportSecretExclusions {
  readonly provider?: string;
  readonly model?: string;
  readonly options?: AiAuditJsonObject;
  readonly tools?: readonly AiAuditJsonValue[];
  /** Exact additional context that is actually placed in the model input. */
  readonly modelVisibleContext?: AiAuditJsonObject;
  /** Route/correlation/runtime evidence that is not sent to the model. */
  readonly auditMetadata?: AiAuditJsonObject;
}

/**
 * Exact normalized model-visible request at the declared Grimodex audit
 * boundary. On renderer transports this is the typed request before native
 * code assembles a provider-specific HTTP envelope; it is not a claim that
 * raw provider JSON or headers were captured. Transport headers, auth,
 * cookies and process environment are excluded. Identically named keys
 * inside messages, tool schemas, bodies and modelVisibleContext remain exact
 * content. auditMetadata is validated as non-model transport evidence.
 */
export type AiAuditRequestSnapshot = AiAuditRequestCommon &
  (
    | {
        readonly messages: readonly AiAuditMessage[];
        readonly body?: AiAuditJsonObject;
      }
    | {
        readonly body: AiAuditJsonObject;
        readonly messages?: readonly AiAuditMessage[];
      }
  );

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

export interface AiAuditExecutionHandle {
  readonly projectId: string | null;
  readonly expectedWorkspacePath: string;
  readonly operationId: string;
  readonly executionId: string;
  readonly parentExecutionId: string | null;
  readonly pathId: string;
  readonly startedAt: number;
}

export interface BeginAiAuditExecutionInput {
  /** null selects the workspace-scoped chain for pre-project AI executions. */
  readonly projectId: string | null;
  /**
   * Optional caller-owned workspace authority captured before orchestration.
   * When present, begin fails closed if the active workspace has changed.
   */
  readonly expectedWorkspacePath?: string;
  readonly pathId: string;
  readonly operationId?: string;
  readonly executionId?: string;
  readonly parentExecutionId?: string | null;
  readonly request: AiAuditRequestSnapshot;
  readonly metadata?: AiAuditJsonObject;
  readonly captureState?: AiAuditCaptureState;
  readonly limitations?: readonly string[];
  readonly timestamp?: number;
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

export interface AiAuditAppendResult {
  readonly insertedCount: number;
  readonly tailSequence: number;
  readonly tailHash: string;
}

export interface AiAuditStoredEvent {
  readonly sequence: number;
  readonly eventId: string;
  readonly scopeId: string;
  readonly projectId: string | null;
  readonly executionId: string;
  readonly operationId: string;
  readonly parentExecutionId: string | null;
  readonly pathId: string;
  readonly eventType: AiAuditEventType;
  readonly timestamp: number;
  readonly recordedAt: number;
  readonly payload: AiAuditJsonObject;
  readonly payloadSha256: string;
  readonly prevHash: string;
  readonly hash: string;
}

export interface AiAuditSnapshot {
  readonly scopeId: string;
  readonly projectId: string | null;
  readonly afterSequence: number;
  readonly highWaterSequence: number;
  readonly highWaterHash: string;
  readonly nextAfterSequence: number | null;
  readonly events: readonly AiAuditStoredEvent[];
}

export interface AiAuditVerifyResult {
  readonly ok: boolean;
  readonly verifiedThroughSequence: number;
  readonly brokenAtSequence: number | null;
  readonly reason: string | null;
  readonly tailHash: string;
}
