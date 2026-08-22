import i18next from "@/lib/i18n";
import { invoke, isIpcLifecycleCancellation } from "@/lib/tauri";
import {
  beginAiAuditExecution,
  cancelAiAuditExecution,
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
import { stableJsonStringify } from "@/features/narrative-extraction/source/digest";
import {
  assertChronicleStageTerminalReceiptV1,
  assertStageModelExecutionBindingV1,
  digestStageModelExecutionBinding,
} from "@/features/narrative-extraction/reconciler/stageProvenance";
import { useAiSettingsStore } from "./store";
import { getOpenaiCompatibleEndpoints } from "./types";
import { isAinoveristV1Model } from "./aiNovelist";
import { readDocumentRuntimeTarget } from "@/runtime/runtimeDocumentTarget";

export const AI_SINGLE_SHOT_CLI_UNSUPPORTED =
  "AI_SINGLE_SHOT_CLI_UNSUPPORTED" as const;

const SINGLE_SHOT_CANCELLATION_CODES = new Set([
  "ABORT_ERR",
  "CANCELED",
  "CANCELLED",
  "ECANCELED",
  "ERR_ABORTED",
  "ERR_CANCELED",
  "ERR_CANCELLED",
  "IPC_READ_CANCELLED",
  "IPC_DERIVED_CANCELLED",
  "IPC_MUTATION_CANCELLED",
]);

function isSingleShotCancellationError(error: unknown): boolean {
  if (isIpcLifecycleCancellation(error)) return true;
  const seen = new Set<object>();
  let current = error;
  while (current !== null && typeof current === "object") {
    if (seen.has(current)) return false;
    seen.add(current);
    const record = current as {
      readonly name?: unknown;
      readonly code?: unknown;
      readonly cause?: unknown;
    };
    if (
      record.name === "AbortError" ||
      (typeof record.code === "string" &&
        SINGLE_SHOT_CANCELLATION_CODES.has(record.code.toUpperCase()))
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

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

async function sha256ResponseDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
}

function isJsonObject(value: unknown): value is AiAuditJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CHRONICLE_BEGIN_PROTECTED_FIELDS = [
  "kind",
  "version",
  "contextSetVersion",
  "stageExecution",
  "contextSetDigest",
  "componentContractDigest",
  "finalRequestDigest",
  "modelExecutionBinding",
  "modelBindingDigest",
] as const;
const CHRONICLE_TERMINAL_ALLOWED_FIELDS = [
  ...CHRONICLE_BEGIN_PROTECTED_FIELDS,
  "responseDigest",
  "parseStatus",
  "terminalStatus",
  "stageExecutionReceiptDigest",
] as const;

function chronicleStageFromMetadata(
  metadata: AiAuditJsonObject | undefined,
): Record<string, unknown> | undefined {
  const stage = metadata?.chronicleStage;
  return isJsonObject(stage) ? stage : undefined;
}

function hasChronicleBindingSeal(stage: Record<string, unknown>): boolean {
  return stage.kind === "chronicle-stage" && stage.version === 2;
}

async function assertChronicleBindingCoherence(
  stage: Record<string, unknown>,
  label: string,
  shape: "begin" | "terminal" = "begin",
): Promise<void> {
  if (!hasChronicleBindingSeal(stage)) return;
  const allowedFields =
    shape === "terminal"
      ? CHRONICLE_TERMINAL_ALLOWED_FIELDS
      : CHRONICLE_BEGIN_PROTECTED_FIELDS;
  const unknownField = Object.keys(stage).find(
    (field) => !allowedFields.includes(field as never),
  );
  if (unknownField !== undefined) {
    throw new TypeError(`${label} has unknown field '${unknownField}'`);
  }
  for (const field of CHRONICLE_BEGIN_PROTECTED_FIELDS) {
    if (!Object.hasOwn(stage, field)) {
      throw new TypeError(`${label} ${field} is required`);
    }
  }
  if (!isJsonObject(stage.modelExecutionBinding)) {
    throw new TypeError(`${label} modelExecutionBinding is required`);
  }
  assertStageModelExecutionBindingV1(stage.modelExecutionBinding);
  if (typeof stage.modelBindingDigest !== "string") {
    throw new TypeError(`${label} modelBindingDigest is required`);
  }
  const expectedDigest = await digestStageModelExecutionBinding(
    stage.modelExecutionBinding,
  );
  if (stage.modelBindingDigest !== expectedDigest) {
    throw new TypeError(`${label} modelBindingDigest does not match binding`);
  }
}

/** Validate the Chronicle begin/terminal seal before any durable terminal append. */
async function assertChronicleTerminalSeal(
  beginMetadata: AiAuditJsonObject | undefined,
  terminalMetadata: AiAuditJsonObject | undefined,
  expectedResponseDigest?: string | null,
): Promise<void> {
  const beginStage = chronicleStageFromMetadata(beginMetadata);
  if (beginStage === undefined || !hasChronicleBindingSeal(beginStage)) return;
  await assertChronicleBindingCoherence(beginStage, "Chronicle Stage begin");
  const terminalStage = chronicleStageFromMetadata(terminalMetadata);
  if (terminalStage === undefined) {
    throw new TypeError("Chronicle Stage terminal metadata is missing");
  }
  for (const field of CHRONICLE_BEGIN_PROTECTED_FIELDS) {
    if (!Object.hasOwn(beginStage, field)) continue;
    if (
      !Object.hasOwn(terminalStage, field) ||
      stableJsonStringify(terminalStage[field]) !==
        stableJsonStringify(beginStage[field])
    ) {
      throw new TypeError(
        `Chronicle Stage terminal changed protected field '${field}'`,
      );
    }
  }
  await assertChronicleBindingCoherence(
    terminalStage,
    "Chronicle Stage terminal",
    "terminal",
  );
  if (
    expectedResponseDigest !== undefined &&
    (!Object.hasOwn(terminalStage, "responseDigest") ||
      stableJsonStringify(terminalStage.responseDigest) !==
        stableJsonStringify(expectedResponseDigest))
  ) {
    throw new TypeError(
      "Chronicle Stage terminal responseDigest does not match response",
    );
  }
  const fullChronicleStage = hasChronicleBindingSeal(beginStage);
  if (
    fullChronicleStage &&
    (!Object.hasOwn(terminalStage, "parseStatus") ||
      !Object.hasOwn(terminalStage, "terminalStatus") ||
      !Object.hasOwn(terminalStage, "stageExecutionReceiptDigest"))
  ) {
    throw new TypeError(
      "Chronicle Stage terminal receipt fields are incomplete",
    );
  }
  if (fullChronicleStage) {
    await assertChronicleStageTerminalReceiptV1({
      kind: "chronicle-stage-terminal-receipt",
      version: 1,
      stageExecution: terminalStage.stageExecution,
      contextSetVersion: terminalStage.contextSetVersion,
      contextSetDigest: terminalStage.contextSetDigest,
      componentContractDigest: terminalStage.componentContractDigest,
      finalRequestDigest: terminalStage.finalRequestDigest,
      modelExecutionBinding: terminalStage.modelExecutionBinding,
      modelBindingDigest: terminalStage.modelBindingDigest,
      responseDigest: terminalStage.responseDigest,
      parseStatus: terminalStage.parseStatus,
      terminalStatus: terminalStage.terminalStatus,
      stageExecutionReceiptDigest: terminalStage.stageExecutionReceiptDigest,
    });
  }
}

async function buildNoResponseTerminalMetadata(
  auditContext: AiAuditTransportContext,
  terminalStatus: "failed" | "cancelled" | "skipped",
  durableMetadata: AiAuditJsonObject | undefined,
): Promise<AiAuditJsonObject | undefined> {
  const terminalMetadata = await auditContext.onNoResponseTerminalMetadata?.(
    terminalStatus,
    durableMetadata,
  );
  const completionMetadata = mergeAuditMetadata(
    withChronicleTerminalStatus(durableMetadata, terminalStatus),
    terminalMetadata,
  );
  const canonicalStage = chronicleStageFromMetadata(completionMetadata);
  if (
    canonicalStage !== undefined &&
    hasChronicleBindingSeal(canonicalStage) &&
    canonicalStage.terminalStatus !== terminalStatus
  ) {
    throw new TypeError(
      `Chronicle Stage terminalStatus '${String(
        canonicalStage.terminalStatus,
      )}' does not match transport terminalStatus '${terminalStatus}'`,
    );
  }
  await assertChronicleTerminalSeal(durableMetadata, completionMetadata, null);
  return completionMetadata;
}

function withChronicleResponseDigest(
  metadata: AiAuditJsonObject | undefined,
  responseDigest: string,
): AiAuditJsonObject | undefined {
  if (metadata === undefined) return undefined;
  const chronicleStage = metadata.chronicleStage;
  if (!isJsonObject(chronicleStage)) return metadata;
  return {
    ...metadata,
    chronicleStage: {
      ...chronicleStage,
      responseDigest,
    },
  };
}

function mergeAuditMetadata(
  base: AiAuditJsonObject | undefined,
  additional: AiAuditJsonObject | undefined,
): AiAuditJsonObject | undefined {
  if (base === undefined) return additional;
  if (additional === undefined) return base;
  const baseChronicle = base.chronicleStage;
  const additionalChronicle = additional.chronicleStage;
  return {
    ...base,
    ...additional,
    ...(isJsonObject(baseChronicle) && isJsonObject(additionalChronicle)
      ? {
          chronicleStage: {
            ...baseChronicle,
            ...additionalChronicle,
          },
        }
      : {}),
  };
}

/** Remove unsealed Chronicle data before a generic audit terminal fallback. */
function stripChronicleStageMetadata(
  metadata: AiAuditJsonObject | undefined,
): AiAuditJsonObject | undefined {
  if (metadata === undefined) return undefined;
  const { chronicleStage: _chronicleStage, ...safeMetadata } = metadata;
  return safeMetadata;
}

function withChronicleTerminalStatus(
  metadata: AiAuditJsonObject | undefined,
  terminalStatus: "failed" | "succeeded" | "cancelled" | "skipped",
): AiAuditJsonObject | undefined {
  if (metadata === undefined) return undefined;
  const chronicleStage = metadata.chronicleStage;
  if (!isJsonObject(chronicleStage)) return metadata;
  return {
    ...metadata,
    chronicleStage: {
      ...chronicleStage,
      terminalStatus,
      ...(terminalStatus !== "succeeded"
        ? { parseStatus: "not-attempted", responseDigest: null }
        : {}),
    },
  };
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
  // Route metadata is resolved exactly once and sealed into the durable begin
  // event before dispatch. The callback is non-persistent application state;
  // only its returned, allowlisted metadata enters the audit ledger.
  const resolvedRouteMetadata = await auditContext.onResolvedRouteMetadata?.(
    route,
    args,
  );
  const durableMetadata = mergeAuditMetadata(
    auditContext.metadata,
    resolvedRouteMetadata,
  );
  await assertChronicleBindingCoherence(
    chronicleStageFromMetadata(durableMetadata) ?? {},
    "Chronicle Stage begin",
  );
  const audit = await beginAiAuditExecution({
    ...auditContext,
    metadata: durableMetadata,
    request: auditRequestFromChatArgs(args, route),
    ...chatAuditRouteCoverage(route),
  });
  try {
    assertSingleShotTransportSupported(provider);
  } catch (error) {
    if (!(error instanceof SingleShotCliUnsupportedError)) throw error;
    let terminalized = false;
    let terminalMetadataPrepared = false;
    let terminalizationError: unknown;
    try {
      const completionMetadata = await buildNoResponseTerminalMetadata(
        auditContext,
        "skipped",
        durableMetadata,
      );
      terminalMetadataPrepared = true;
      await skipAiAuditExecution(audit, {
        reason: error.code,
        metadata: mergeAuditMetadata(completionMetadata, {
          transport: "single-shot-http",
          unsupportedProvider: "cli",
        }),
      });
      terminalized = true;
      await auditContext.onAuditCompleted?.(completionMetadata);
    } catch (terminalError) {
      terminalizationError = terminalError;
      // Preserve the actionable unsupported-provider error. If the Chronicle
      // hook or terminal append failed, no receipt is published.
      if (!terminalized && !terminalMetadataPrepared) {
        try {
          await skipAiAuditExecution(audit, {
            reason: error.code,
            metadata: mergeAuditMetadata(
              stripChronicleStageMetadata(durableMetadata),
              {
                transport: "single-shot-http",
                unsupportedProvider: "cli",
              },
            ),
          });
          terminalized = true;
        } catch {
          // The audit API already records the persistence failure boundary.
        }
      }
    }
    if (!terminalMetadataPrepared && terminalizationError !== undefined) {
      throw terminalizationError;
    }
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
    const cancellation = isSingleShotCancellationError(error);
    const terminalStatus = cancellation ? "cancelled" : "failed";
    let terminalized = false;
    let terminalMetadataPrepared = false;
    let terminalizationError: unknown;
    try {
      const completionMetadata = await buildNoResponseTerminalMetadata(
        auditContext,
        terminalStatus,
        durableMetadata,
      );
      terminalMetadataPrepared = true;
      if (cancellation) {
        await cancelAiAuditExecution(audit, {
          reason: auditErrorSnapshot(error).message,
          metadata: completionMetadata,
        });
      } else {
        await failAiAuditExecution(audit, {
          error: auditErrorSnapshot(error),
          metadata: completionMetadata,
        });
      }
      terminalized = true;
      await auditContext.onAuditCompleted?.(completionMetadata);
    } catch (terminalError) {
      terminalizationError = terminalError;
      // Preserve the provider error. A failed terminal append never emits a
      // Chronicle receipt and remains visible through the audit failure path.
      if (!terminalized && !terminalMetadataPrepared) {
        try {
          const fallbackMetadata = stripChronicleStageMetadata(durableMetadata);
          if (cancellation) {
            await cancelAiAuditExecution(audit, {
              reason: auditErrorSnapshot(error).message,
              metadata: fallbackMetadata,
            });
          } else {
            await failAiAuditExecution(audit, {
              error: auditErrorSnapshot(error),
              metadata: fallbackMetadata,
            });
          }
          terminalized = true;
        } catch {
          // The audit API already records the persistence failure boundary.
        }
      }
    }
    if (!terminalMetadataPrepared && terminalizationError !== undefined) {
      throw terminalizationError;
    }
    throw error;
  }
  const responseText = response.blocks
    .filter((block) => block.type === "text")
    .map((block) => (block as { type: "text"; content: string }).content)
    .join("\n");
  const responseDigest = await sha256ResponseDigest(responseText);
  let terminalMetadata: AiAuditJsonObject | undefined;
  try {
    terminalMetadata = await auditContext.onTerminalMetadata?.(
      responseText,
      durableMetadata,
    );
  } catch (error) {
    const chronicleStage = durableMetadata?.chronicleStage;
    if (
      isJsonObject(chronicleStage) &&
      chronicleStage.kind === "chronicle-stage"
    ) {
      // Chronicle provenance is part of the stage's acceptance boundary. Close
      // the already-dispatched audit as failed and do not return an output that
      // has no sealed terminal receipt.
      await failAiAuditExecution(audit, {
        error: auditErrorSnapshot(error),
        metadata: stripChronicleStageMetadata(durableMetadata),
      });
      throw error;
    }
    // A provenance helper must not strand the already-dispatched execution
    // without its existing terminal audit events. The response digest below
    // remains durable even when an optional Chronicle status hook fails.
    terminalMetadata = {
      chronicleStageMetadataError: { ...auditErrorSnapshot(error) },
    };
  }
  const completionMetadata = mergeAuditMetadata(
    withChronicleResponseDigest(durableMetadata, responseDigest),
    terminalMetadata,
  );
  try {
    await assertChronicleTerminalSeal(
      durableMetadata,
      completionMetadata,
      responseDigest,
    );
  } catch (error) {
    const chronicleStage = durableMetadata?.chronicleStage;
    if (
      isJsonObject(chronicleStage) &&
      chronicleStage.kind === "chronicle-stage"
    ) {
      await failAiAuditExecution(audit, {
        error: auditErrorSnapshot(error),
        metadata: stripChronicleStageMetadata(durableMetadata),
      });
    }
    throw error;
  }
  await completeAiAuditExecution(audit, {
    response: response as unknown as AiAuditJsonObject,
    usage: {
      inputTokens: response.inputTokens ?? null,
      outputTokens: response.outputTokens ?? null,
      stopReason: response.stopReason,
    },
    metadata: completionMetadata,
  });
  try {
    await auditContext.onAuditCompleted?.(completionMetadata);
  } catch (error) {
    const chronicleStage = completionMetadata?.chronicleStage;
    if (
      isJsonObject(chronicleStage) &&
      chronicleStage.kind === "chronicle-stage"
    ) {
      // The durable audit terminal is closed, but a Chronicle Stage without
      // its required provenance receipt is not an acceptable Stage result.
      throw error;
    }
  }
  return response;
}
