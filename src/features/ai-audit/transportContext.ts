import type {
  AiAuditCaptureState,
  AiAuditErrorSnapshot,
  AiAuditExecutionHandle,
  AiAuditJsonObject,
  AiAuditMessage,
  AiAuditRequestSnapshot,
} from "./types";
import { readDocumentRuntimeTarget } from "@/runtime/runtimeDocumentTarget";
export { requireAuditProjectId } from "./projectScope";

/**
 * Stable identity supplied by the orchestration layer for one observable AI
 * dispatch. A logical user action keeps one operationId while retries,
 * fallbacks and Agent child calls receive their own executionId.
 */
export interface AiAuditTransportContext {
  /** null intentionally records the execution in the workspace audit chain. */
  readonly projectId: string | null;
  /**
   * Immutable authority for multi-dispatch orchestration. A later workspace
   * switch must fail before a child request can enter a different ledger.
   */
  readonly expectedWorkspacePath?: string;
  readonly pathId: string;
  readonly operationId?: string;
  readonly executionId?: string;
  readonly parentExecutionId?: string | null;
  /** Persisted assistant message identity for the main chat-agent turn. */
  readonly chatMessageId?: string;
  readonly metadata?: AiAuditJsonObject;
  /**
   * Non-persistent application seam used to add terminal provenance after a
   * response is parsed. The response text is passed in memory only; transport
   * code never serializes this callback into native audit context.
   */
  readonly onTerminalMetadata?: (
    responseText: string,
    /** Durable route metadata selected before dispatch, when available. */
    metadata?: AiAuditJsonObject,
  ) => AiAuditJsonObject | Promise<AiAuditJsonObject>;
  /**
   * Non-persistent Chronicle seam for a durable terminal that received no
   * provider response (dispatch failure, unsupported/skip, or cancellation).
   * The callback must return terminal metadata with a null responseDigest.
   */
  readonly onNoResponseTerminalMetadata?: (
    terminalStatus: "failed" | "cancelled" | "skipped",
    /** Durable route metadata selected before dispatch, when available. */
    metadata?: AiAuditJsonObject,
  ) => AiAuditJsonObject | Promise<AiAuditJsonObject>;
  /**
   * Runs only after the durable audit completion succeeds. Chronicle uses this
   * seam to publish its receipt to a shadow/C1 collector without leaving an
   * orphan receipt when terminal persistence fails.
   */
  readonly onAuditCompleted?: (
    metadata?: AiAuditJsonObject,
  ) => void | Promise<void>;
  /**
   * Non-persistent route-resolution seam. The callback runs after the route
   * has been resolved and before the durable audit begin event; its returned
   * metadata is merged into that begin event and is never sent to the model.
   */
  readonly onResolvedRouteMetadata?: (
    route: AiAuditResolvedRouteSnapshot,
    args: Readonly<Record<string, unknown>>,
  ) => AiAuditJsonObject | Promise<AiAuditJsonObject>;
}

export interface AiAuditResolvedRouteSnapshot {
  readonly provider: string | null;
  readonly model: string | null;
  readonly apiVariant: string | null;
  readonly endpointId: string | null;
  /** Scheme + host only. URL path/query/userinfo are intentionally excluded. */
  readonly endpointOrigin: string | null;
  readonly authority:
    | "turn-snapshot"
    | "renderer-settings-snapshot"
    | "unknown";
  /** Downstream transport resolution that prevents a renderer snapshot being final. */
  readonly transportResolutionLimitations: readonly string[];
}

export interface NativeAiAuditContext {
  readonly expectedWorkspacePath: string;
  readonly projectId: string | null;
  readonly operationId: string;
  readonly executionId: string;
  readonly parentExecutionId: string | null;
  readonly pathId: string;
}

export function nativeAiAuditContext(
  handle: AiAuditExecutionHandle,
): NativeAiAuditContext {
  return {
    expectedWorkspacePath: handle.expectedWorkspacePath,
    projectId: handle.projectId,
    operationId: handle.operationId,
    executionId: handle.executionId,
    parentExecutionId: handle.parentExecutionId,
    pathId: handle.pathId,
  };
}

export function auditErrorSnapshot(error: unknown): AiAuditErrorSnapshot {
  if (error instanceof Error) {
    const record = error as Error & { code?: unknown };
    return {
      name: error.name || "Error",
      message: error.message,
      ...(typeof record.code === "string" ? { code: record.code } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

const OPTION_KEYS = [
  "thinking",
  "effort",
  "reasoningEnabled",
  "reasoningEffort",
  "apiVariant",
  "endpointId",
  "requestMaxOutputTokens",
  "resolvedToolProtocol",
  "webSearch",
] as const;

const MODEL_VISIBLE_CONTEXT_KEYS = [
  "systemCacheSegments",
  "systemVolatileTail",
] as const;

/**
 * Build the model-visible, normalized request snapshot from the exact payload
 * about to cross the transport boundary. Deliberately allowlists fields so
 * credentials and future transport-only options cannot enter the audit log by
 * accident.
 */
export function auditRequestFromChatArgs(
  args: Readonly<Record<string, unknown>>,
  effectiveRoute?: AiAuditResolvedRouteSnapshot,
): AiAuditRequestSnapshot {
  const options: Record<string, import("./types").AiAuditJsonValue> = {};
  for (const key of OPTION_KEYS) {
    const value = args[key];
    if (value !== undefined) {
      options[key] = value as import("./types").AiAuditJsonValue;
    }
  }
  const modelVisibleContext: Record<
    string,
    import("./types").AiAuditJsonValue
  > = {};
  for (const key of MODEL_VISIBLE_CONTEXT_KEYS) {
    const value = args[key];
    if (value !== undefined) {
      modelVisibleContext[key] = value as import("./types").AiAuditJsonValue;
    }
  }

  const messages = Array.isArray(args.messages)
    ? (args.messages as readonly AiAuditMessage[])
    : ([] as const);
  const tools = Array.isArray(args.tools)
    ? (args.tools as AiAuditRequestSnapshot["tools"])
    : undefined;
  const requestedProvider =
    typeof args.provider === "string" ? args.provider : null;
  const requestedModel = typeof args.model === "string" ? args.model : null;
  const route = effectiveRoute ?? {
    provider: requestedProvider,
    model: requestedModel,
    apiVariant: typeof args.apiVariant === "string" ? args.apiVariant : null,
    endpointId: typeof args.endpointId === "string" ? args.endpointId : null,
    endpointOrigin: null,
    authority: "unknown" as const,
    transportResolutionLimitations: [
      "effective-route-unresolved-before-transport",
    ],
  };
  const routeComplete =
    route.authority !== "unknown" &&
    route.provider !== null &&
    route.model !== null &&
    route.transportResolutionLimitations.length === 0;
  const routeCaptureState: AiAuditCaptureState = routeComplete
    ? "complete"
    : "partial";
  return {
    messages,
    ...(requestedProvider !== null ? { provider: requestedProvider } : {}),
    ...(requestedModel !== null ? { model: requestedModel } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(Object.keys(modelVisibleContext).length > 0
      ? { modelVisibleContext }
      : {}),
    ...(tools !== undefined ? { tools } : {}),
    auditMetadata: {
      routeObservation: {
        captureState: routeCaptureState,
        requestedProvider,
        requestedModel,
        rendererProviderSnapshot: route.provider,
        rendererModelSnapshot: route.model,
        rendererApiVariantSnapshot: route.apiVariant,
        rendererEndpointIdSnapshot: route.endpointId,
        rendererEndpointOriginSnapshot: route.endpointOrigin,
        rendererRouteProvenImmutable: routeComplete,
        authority: route.authority,
        transportEffectiveRouteObserved: false,
        transportResolutionLimitations: route.transportResolutionLimitations,
        resolutionBoundary: "renderer_before_transport",
      },
    },
  };
}

/**
 * Renderer-side dispatch only proves that the durable audit precondition
 * passed and the selected application transport is about to be invoked. It is
 * not evidence of an HTTP send, provider receipt, or model acceptance.
 */
export function beforeIpcDispatchDetails(command: string): AiAuditJsonObject {
  const runtimeTarget = readDocumentRuntimeTarget();
  const transport =
    runtimeTarget === "web"
      ? {
          runtimeTarget: "web",
          dispatchBoundary: "before_browser_mock_invoke",
          transportTarget: "browser-mock",
        }
      : runtimeTarget === "mobile-native"
        ? {
            runtimeTarget: "mobile-native",
            dispatchBoundary: "before_mobile_native_bridge_invoke",
            transportTarget: "mobile-native-bridge",
          }
        : {
            runtimeTarget: "electron",
            dispatchBoundary: "before_electron_native_ipc_invoke",
            transportTarget: "electron-native-ipc",
          };
  return {
    command,
    ...transport,
    providerReceiptObserved: false,
    modelDispatched: null,
  };
}
