import { sha256Hex } from "@grimodex/scan-contract";
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
import type { Sha256Digest } from "@/features/narrative-extraction/source/types";
import { useAiSettingsStore } from "./store";
import {
  getOpenaiCompatibleEndpoints,
  resolveActiveOpenaiCompatibleEndpoint,
} from "./types";
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

function normalizeSingleShotResponse(value: unknown): ChatResponsePayload {
  if (!isJsonObject(value)) {
    throw new TypeError("Single-shot response must be an object");
  }
  const rawBlocks = value.blocks;
  if (!Array.isArray(rawBlocks)) {
    throw new TypeError("Single-shot response blocks must be an array");
  }
  const blocks = rawBlocks.map((rawBlock, index) => {
    if (!isJsonObject(rawBlock) || typeof rawBlock.type !== "string") {
      throw new TypeError(`Single-shot response block ${index} is invalid`);
    }
    if (rawBlock.type === "text") {
      if (typeof rawBlock.content !== "string") {
        throw new TypeError(
          `Single-shot response text block ${index} is invalid`,
        );
      }
      return { type: "text" as const, content: rawBlock.content };
    }
    if (rawBlock.type === "tool_use") {
      if (
        typeof rawBlock.id !== "string" ||
        typeof rawBlock.name !== "string" ||
        !Object.hasOwn(rawBlock, "input")
      ) {
        throw new TypeError(
          `Single-shot response tool_use block ${index} is invalid`,
        );
      }
      return {
        type: "tool_use" as const,
        id: rawBlock.id,
        name: rawBlock.name,
        input: rawBlock.input,
      };
    }
    if (rawBlock.type === "thinking") {
      if (typeof rawBlock.content !== "string") {
        throw new TypeError(
          `Single-shot response thinking block ${index} is invalid`,
        );
      }
      const thinking: {
        type: "thinking";
        content: string;
        summary?: string;
        signature?: string;
      } = { type: "thinking", content: rawBlock.content };
      if (Object.hasOwn(rawBlock, "summary")) {
        if (typeof rawBlock.summary !== "string") {
          throw new TypeError(
            `Single-shot response thinking summary ${index} is invalid`,
          );
        }
        thinking.summary = rawBlock.summary;
      }
      if (Object.hasOwn(rawBlock, "signature")) {
        if (typeof rawBlock.signature !== "string") {
          throw new TypeError(
            `Single-shot response thinking signature ${index} is invalid`,
          );
        }
        thinking.signature = rawBlock.signature;
      }
      return thinking;
    }
    throw new TypeError(`Single-shot response block ${index} has unknown type`);
  });
  if (typeof value.stopReason !== "string") {
    throw new TypeError("Single-shot response stopReason is invalid");
  }
  const optionalToken = (key: "inputTokens" | "outputTokens") => {
    const raw = value[key];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      throw new TypeError(`Single-shot response ${key} is invalid`);
    }
    return raw;
  };
  const inputTokens = optionalToken("inputTokens");
  const outputTokens = optionalToken("outputTokens");
  return {
    blocks,
    stopReason: value.stopReason,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
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
  const effectiveProvider =
    providerOverride === undefined
      ? useAiSettingsStore.getState().settings?.provider
      : providerOverride?.trim() || null;
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

async function sha256ResponseDigest(value: string): Promise<Sha256Digest> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${hex}`;
}

/**
 * The received payload still needs a canonical digest when Web Crypto rejects
 * response preprocessing. The dependency-free contract hash is the same
 * SHA-256 domain and does not expose the failure diagnostic or payload text.
 */
async function digestReceivedResponse(value: string): Promise<Sha256Digest> {
  try {
    return await sha256ResponseDigest(value);
  } catch {
    return `sha256:${sha256Hex(value)}`;
  }
}

function isJsonObject(value: unknown): value is AiAuditJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keep a deterministic, in-memory representation of the provider value even
 * when the value is not a valid single-shot response. Provider values normally
 * cross an IPC JSON boundary; the fixed fallback avoids putting serialization
 * errors or their (potentially sensitive) messages into any audit metadata.
 */
function stableReceivedResponseText(value: unknown): string {
  try {
    return stableJsonStringify(value);
  } catch {
    return stableJsonStringify({
      kind: "unserializable-single-shot-response",
      valueType: typeof value,
    });
  }
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
  "rawObservationsDigest",
  "parsedOutputDigest",
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
      rawObservationsDigest: terminalStage.rawObservationsDigest ?? null,
      parsedOutputDigest: terminalStage.parsedOutputDigest ?? null,
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
  const configuredCompatibleEndpoints = settings
    ? getOpenaiCompatibleEndpoints(settings)
    : [];
  if (requestedEndpointId !== null && provider !== "openai-compatible") {
    throw new TypeError(
      "OpenAI-compatible endpoint override does not match the selected provider",
    );
  }
  if (
    provider === "openai-compatible" &&
    requestedEndpointId !== null &&
    !configuredCompatibleEndpoints.some(
      (candidate) => candidate.id === requestedEndpointId,
    )
  ) {
    throw new TypeError("OpenAI-compatible endpoint is not configured");
  }
  const endpointId =
    provider === "openai-compatible"
      ? (requestedEndpointId ??
        (settings
          ? (resolveActiveOpenaiCompatibleEndpoint(settings)?.id ?? null)
          : null))
      : null;
  let resolvedEndpointOrigin: string | null = null;
  const compatibleEndpoint =
    provider === "openai-compatible"
      ? configuredCompatibleEndpoints.find(
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
  const route = resolveChatAuditRoute(args);
  // Materialize every route field before the first await.  The settings store
  // is mutable, so passing the caller's nullable overrides through to IPC
  // would let native route resolution observe a different provider/model than
  // the binding sealed by the begin event.
  const dispatchArgs: Record<string, unknown> = {
    ...args,
    provider: route.provider,
    model: route.model,
    apiVariant: route.apiVariant,
    endpointId: route.endpointId,
  };
  const provider = route.provider;
  // Route metadata is resolved exactly once and sealed into the durable begin
  // event before dispatch. The callback is non-persistent application state;
  // only its returned, allowlisted metadata enters the audit ledger.
  const resolvedRouteMetadata = await auditContext.onResolvedRouteMetadata?.(
    route,
    dispatchArgs,
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
  dispatchArgs.auditContext = nativeAiAuditContext(audit);
  await markAiAuditDispatched(
    audit,
    beforeIpcDispatchDetails("send_chat_message"),
  );
  let response: unknown;
  try {
    response = await invoke<unknown>("send_chat_message", dispatchArgs);
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
  // Everything after provider dispatch belongs to the same terminal boundary.
  // Response normalization and digesting are part of that boundary too: a
  // malformed provider payload must never leave a dispatched execution
  // pending merely because it failed before the old terminal try/catch.
  let responseTerminalAttempted = false;
  let responsePreprocessingComplete = false;
  const receivedResponseText = stableReceivedResponseText(response);
  let receivedResponseDigest: Sha256Digest | undefined;
  const failPostResponseAudit = async (error: unknown): Promise<void> => {
    if (responseTerminalAttempted) return;

    const beginStage = chronicleStageFromMetadata(durableMetadata);
    if (
      !responsePreprocessingComplete &&
      beginStage !== undefined &&
      hasChronicleBindingSeal(beginStage)
    ) {
      let completionMetadata: AiAuditJsonObject | undefined;
      try {
        receivedResponseDigest ??=
          await digestReceivedResponse(receivedResponseText);
        const terminalMetadata = await auditContext.onTerminalMetadata?.(
          receivedResponseText,
          durableMetadata,
          receivedResponseDigest,
        );
        completionMetadata = mergeAuditMetadata(
          withChronicleResponseDigest(durableMetadata, receivedResponseDigest),
          terminalMetadata,
        );
        const malformedResponseStage =
          chronicleStageFromMetadata(completionMetadata);
        if (
          malformedResponseStage !== undefined &&
          hasChronicleBindingSeal(malformedResponseStage) &&
          (malformedResponseStage.parseStatus !== "invalid" ||
            malformedResponseStage.terminalStatus !== "failed")
        ) {
          throw new TypeError(
            "Chronicle Stage malformed response terminal must be failed/invalid",
          );
        }
        await assertChronicleTerminalSeal(
          durableMetadata,
          completionMetadata,
          receivedResponseDigest,
        );
      } catch {
        // A malformed response hook or seal failure cannot publish an
        // incomplete Chronicle v2 object. Close the generic audit exactly once
        // instead. The no-response hook is reserved for dispatch failures.
        responseTerminalAttempted = true;
        try {
          await failAiAuditExecution(audit, {
            error: auditErrorSnapshot(error),
            metadata: stripChronicleStageMetadata(durableMetadata),
          });
        } catch {
          // The audit API owns persistence-failure recording.
        }
        return;
      }

      // Mark the durable terminal boundary before the append. If persistence
      // rejects, the audit API records that failure and no second fallback may
      // create an orphan or duplicate terminal.
      responseTerminalAttempted = true;
      try {
        await failAiAuditExecution(audit, {
          error: auditErrorSnapshot(error),
          metadata: completionMetadata,
        });
      } catch {
        return;
      }
      try {
        await auditContext.onAuditCompleted?.(completionMetadata);
      } catch {
        // Preserve the original response/preprocessing error. The durable
        // terminal is already closed and cannot be retried here.
      }
      return;
    }

    responseTerminalAttempted = true;
    try {
      await failAiAuditExecution(audit, {
        error: auditErrorSnapshot(error),
        metadata: stripChronicleStageMetadata(durableMetadata),
      });
    } catch {
      // The audit API owns persistence-failure recording. Preserve the
      // original response/provenance error for the caller.
    }
  };
  try {
    const normalizedResponse = normalizeSingleShotResponse(response);
    const responseText = normalizedResponse.blocks
      .filter((block) => block.type === "text")
      .map((block) => block.content)
      .join("\n");
    const responseDigest = await sha256ResponseDigest(responseText);
    receivedResponseDigest = responseDigest;
    responsePreprocessingComplete = true;
    let terminalMetadata: AiAuditJsonObject | undefined;
    try {
      terminalMetadata = await auditContext.onTerminalMetadata?.(
        responseText,
        durableMetadata,
        responseDigest,
      );
    } catch (error) {
      const chronicleStage = durableMetadata?.chronicleStage;
      if (
        isJsonObject(chronicleStage) &&
        chronicleStage.kind === "chronicle-stage"
      ) {
        // Chronicle provenance is part of the acceptance boundary. Let the
        // outer catch close this execution with a generic failed terminal.
        throw error;
      }
      // Optional provenance metadata must not strand a generic audit. The
      // response digest remains durable even when this helper fails.
      terminalMetadata = {
        chronicleStageMetadataError: { ...auditErrorSnapshot(error) },
      };
    }
    const completionMetadata = mergeAuditMetadata(
      withChronicleResponseDigest(durableMetadata, responseDigest),
      terminalMetadata,
    );
    await assertChronicleTerminalSeal(
      durableMetadata,
      completionMetadata,
      responseDigest,
    );
    // Once complete is called, the audit API has the single durable terminal
    // authority. A later receipt callback error must not trigger a second one.
    responseTerminalAttempted = true;
    await completeAiAuditExecution(audit, {
      response: normalizedResponse as unknown as AiAuditJsonObject,
      usage: {
        inputTokens: normalizedResponse.inputTokens ?? null,
        outputTokens: normalizedResponse.outputTokens ?? null,
        stopReason: normalizedResponse.stopReason,
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
        // The durable audit terminal is already closed, but a Chronicle Stage
        // without its required receipt is not an acceptable Stage result.
        throw error;
      }
    }
    return normalizedResponse;
  } catch (error) {
    await failPostResponseAudit(error);
    throw error;
  }
}
