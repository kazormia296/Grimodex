import i18next from "@/lib/i18n";
import { invoke } from "@/lib/tauri";
import {
  beginAiAuditExecution,
  completeAiAuditExecution,
  failAiAuditExecution,
  markAiAuditDispatched,
  skipAiAuditExecution,
} from "@/features/ai-audit/api";
import {
  auditErrorSnapshot,
  auditRequestFromChatArgs,
  beforeIpcDispatchDetails,
  nativeAiAuditContext,
  type AiAuditResolvedRouteSnapshot,
  type AiAuditTransportContext,
} from "@/features/ai-audit/transportContext";
import type { AiAuditJsonObject } from "@/features/ai-audit/types";
import { useAiSettingsStore } from "./store";
import { getOpenaiCompatibleEndpoints } from "./types";
import { isAinoveristV1Model } from "./aiNovelist";
import { readDocumentRuntimeTarget } from "@/runtime/runtimeDocumentTarget";

export const AI_SINGLE_SHOT_CLI_UNSUPPORTED =
  "AI_SINGLE_SHOT_CLI_UNSUPPORTED" as const;

export interface ChatResponsePayload {
  blocks: Array<
    | { type: "text"; content: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | {
        type: "thinking";
        content: string;
        summary?: string;
        signature?: string;
      }
  >;
  stopReason: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * `send_chat_message` is an HTTP-provider command. CLI exec and Codex App
 * Server use their own streaming transports and cannot be sent through it.
 */
export class SingleShotCliUnsupportedError extends Error {
  readonly code = AI_SINGLE_SHOT_CLI_UNSUPPORTED;

  constructor() {
    super(i18next.t("settings.ai.roleModel.cliSingleShotUnsupported"));
    this.name = "SingleShotCliUnsupportedError";
  }
}

/**
 * Fail before IPC with an actionable error instead of letting the Rust HTTP
 * path attempt to use CLI's empty base URL. An explicit role-provider override
 * wins over the active provider, so CLI chat can coexist with an HTTP model for
 * structured/cheap one-shot work.
 */
export function assertSingleShotTransportSupported(
  providerOverride?: string | null,
): void {
  const explicitProvider = providerOverride?.trim();
  const effectiveProvider =
    explicitProvider || useAiSettingsStore.getState().settings?.provider;
  if (effectiveProvider === "cli") {
    throw new SingleShotCliUnsupportedError();
  }
}

function endpointOrigin(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** Snapshot the route using the same override-over-settings precedence as IPC. */
export function resolveChatAuditRoute(
  args: Readonly<Record<string, unknown>>,
): AiAuditResolvedRouteSnapshot {
  const settings = useAiSettingsStore.getState().settings;
  const requestedProvider =
    typeof args.provider === "string" && args.provider.trim()
      ? args.provider
      : null;
  const requestedModel =
    typeof args.model === "string" && args.model.trim() ? args.model : null;
  const provider = requestedProvider ?? settings?.provider ?? null;
  const model = requestedModel ?? settings?.model ?? null;
  const requestedEndpointId =
    typeof args.endpointId === "string" && args.endpointId.trim()
      ? args.endpointId
      : null;
  const endpointId =
    requestedEndpointId !== null
      ? requestedEndpointId
      : provider === "openai-compatible"
        ? (settings?.activeOpenaiCompatibleEndpointId ?? null)
        : null;
  let resolvedEndpointOrigin: string | null = null;
  const compatibleEndpoint =
    provider === "openai-compatible" && settings
      ? getOpenaiCompatibleEndpoints(settings).find(
          (candidate) => candidate.id === endpointId,
        )
      : undefined;
  if (provider === "ollama") {
    resolvedEndpointOrigin = endpointOrigin(settings?.ollamaEndpoint);
  } else if (provider === "openai-compatible" && settings) {
    resolvedEndpointOrigin = endpointOrigin(
      compatibleEndpoint?.baseUrl ?? settings.openaiCompatible.baseUrl,
    );
  }
  const requestedApiVariant =
    typeof args.apiVariant === "string" && args.apiVariant.trim()
      ? args.apiVariant
      : null;
  // Mirrors native apply_provider_override + resolve_api_variant precedence.
  // A provider override clears the settings-level variant before resolution,
  // otherwise a Responses toggle from the active provider can leak into an
  // unrelated Anthropic/Ollama/etc. slot and make this snapshot falsely final.
  let apiVariant: string | null;
  if (model === "openrouter/fusion") {
    apiVariant = null;
  } else if (requestedApiVariant !== null) {
    apiVariant = requestedApiVariant;
  } else if (provider === "openai-compatible") {
    apiVariant = compatibleEndpoint?.apiVariant?.trim() || null;
  } else if (requestedProvider !== null) {
    apiVariant =
      provider === "ai-novelist" && model
        ? isAinoveristV1Model(model)
          ? "v1"
          : "legacy"
        : null;
  } else if (settings?.modelApiVariant?.trim()) {
    apiVariant = settings.modelApiVariant;
  } else if (provider === "ai-novelist" && model) {
    apiVariant = isAinoveristV1Model(model) ? "v1" : "legacy";
  } else {
    apiVariant = null;
  }
  const authority =
    requestedProvider !== null && requestedModel !== null
      ? "turn-snapshot"
      : settings
        ? "renderer-settings-snapshot"
        : "unknown";
  const transportResolutionLimitations: string[] = [];
  if (authority !== "turn-snapshot") {
    transportResolutionLimitations.push(
      authority === "unknown"
        ? "effective-provider-model-unresolved-before-transport"
        : "provider-or-model-derived-from-renderer-settings-before-effective-request-receipt",
    );
  }
  if (!provider || !model) {
    transportResolutionLimitations.push(
      "effective-provider-model-unresolved-before-transport",
    );
  }
  if (provider === "openai-compatible") {
    transportResolutionLimitations.push(
      requestedEndpointId === null
        ? "openai-compatible-default-endpoint-resolved-downstream"
        : "openai-compatible-endpoint-origin-pending-effective-request-receipt",
    );
    if (requestedApiVariant === null) {
      transportResolutionLimitations.push(
        "openai-compatible-api-variant-resolved-downstream-from-endpoint",
      );
    }
  }
  if (provider === "ai-novelist" && requestedApiVariant === null) {
    transportResolutionLimitations.push(
      "ai-novelist-api-variant-inferred-downstream-from-model",
    );
  }
  if (model === "openrouter/fusion") {
    transportResolutionLimitations.push(
      "api-variant-forced-downstream-for-openrouter-fusion",
    );
  }
  if (
    requestedApiVariant === null &&
    requestedProvider === null &&
    provider !== "anthropic" &&
    provider !== "ollama" &&
    provider !== "openai-compatible" &&
    provider !== "ai-novelist"
  ) {
    transportResolutionLimitations.push(
      "api-variant-may-be-resolved-downstream-from-settings",
    );
  }
  if (provider === "ollama") {
    const expectedOllamaEndpoint =
      typeof args.expectedOllamaEndpoint === "string"
        ? args.expectedOllamaEndpoint.trim().replace(/\/+$/u, "")
        : null;
    const configuredOllamaEndpoint = settings?.ollamaEndpoint
      ?.trim()
      .replace(/\/+$/u, "");
    if (
      expectedOllamaEndpoint === null ||
      expectedOllamaEndpoint !== configuredOllamaEndpoint
    ) {
      transportResolutionLimitations.push(
        "ollama-endpoint-not-proven-by-immutable-turn-snapshot",
      );
    }
  }
  if (readDocumentRuntimeTarget() === "web") {
    // BrowserMock parses the same bodyJson string passed to fetch, appends the
    // complete JSON value to this execution, and awaits its durable journal ACK.
    // JSON semantics and downstream route normalization are observed; original
    // serialization whitespace, object-key order, and bytes are not preserved.
    transportResolutionLimitations.length = 0;
  }
  // Electron's instrumented native HTTP observer appends the finalized body
  // and effective route to the same execution before send. This snapshot still
  // describes the earlier renderer boundary, so downstream values remain
  // explicitly pending here instead of being mislabeled as never observable.
  return {
    provider,
    model,
    apiVariant,
    endpointId,
    endpointOrigin: resolvedEndpointOrigin,
    authority,
    transportResolutionLimitations: Array.from(
      new Set(transportResolutionLimitations),
    ),
  };
}

export function chatAuditRouteCoverage(
  route: AiAuditResolvedRouteSnapshot,
): Pick<
  import("@/features/ai-audit/types").BeginAiAuditExecutionInput,
  "captureState" | "limitations"
> {
  const limitations = Array.from(new Set(route.transportResolutionLimitations));
  const complete =
    route.authority !== "unknown" &&
    Boolean(route.provider) &&
    Boolean(route.model) &&
    limitations.length === 0;
  return complete
    ? { captureState: "complete" }
    : {
        captureState: "partial",
        limitations:
          limitations.length > 0
            ? limitations
            : ["effective-route-unresolved-before-transport"],
      };
}

export async function invokeSingleShotChat(
  args: Record<string, unknown>,
  auditContext: AiAuditTransportContext,
): Promise<ChatResponsePayload> {
  const provider = typeof args.provider === "string" ? args.provider : null;
  const route = resolveChatAuditRoute(args);
  const audit = await beginAiAuditExecution({
    ...auditContext,
    request: auditRequestFromChatArgs(args, route),
    ...chatAuditRouteCoverage(route),
  });
  try {
    assertSingleShotTransportSupported(provider);
  } catch (error) {
    if (!(error instanceof SingleShotCliUnsupportedError)) throw error;
    await skipAiAuditExecution(audit, {
      reason: error.code,
      metadata: {
        transport: "single-shot-http",
        unsupportedProvider: "cli",
      },
    });
    throw error;
  }
  args.auditContext = nativeAiAuditContext(audit);
  await markAiAuditDispatched(
    audit,
    beforeIpcDispatchDetails("send_chat_message"),
  );
  let response: ChatResponsePayload;
  try {
    response = await invoke<ChatResponsePayload>("send_chat_message", args);
  } catch (error) {
    await failAiAuditExecution(audit, { error: auditErrorSnapshot(error) });
    throw error;
  }
  await completeAiAuditExecution(audit, {
    response: response as unknown as AiAuditJsonObject,
    usage: {
      inputTokens: response.inputTokens ?? null,
      outputTokens: response.outputTokens ?? null,
      stopReason: response.stopReason,
    },
  });
  return response;
}
