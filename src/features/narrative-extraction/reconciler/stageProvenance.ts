import {
  assertStageExecutionContext,
  NARRATIVE_STAGE_IDS,
  type NarrativeStageExecutionContext,
} from "./stageExecution";
import { digestStableJson, stableJsonStringify } from "../source/digest";
import type { Sha256Digest } from "../source/types";

/** Domain-separated digest domains owned by the NIR-0 stage provenance lane. */
export const CHRONICLE_STAGE_MODEL_BINDING_DIGEST_DOMAIN =
  "chronicle-stage-model-binding/1" as const;
export const CHRONICLE_STAGE_TERMINAL_RECEIPT_DIGEST_DOMAIN =
  "chronicle-stage-terminal-receipt/1" as const;
export const CHRONICLE_STAGE_PROVENANCE_CLOSURE_DIGEST_DOMAIN =
  "chronicle-stage-provenance-closure/1" as const;

export const STAGE_MODEL_EXECUTION_BINDING_KIND =
  "chronicle-stage-model-binding" as const;
export const STAGE_MODEL_EXECUTION_BINDING_VERSION = 1 as const;
export const CHRONICLE_STAGE_TERMINAL_RECEIPT_KIND =
  "chronicle-stage-terminal-receipt" as const;
export const CHRONICLE_STAGE_TERMINAL_RECEIPT_VERSION = 1 as const;
export const CHRONICLE_STAGE_PROVENANCE_CLOSURE_KIND =
  "chronicle-stage-provenance-closure" as const;
export const CHRONICLE_STAGE_PROVENANCE_CLOSURE_VERSION = 1 as const;
export const CHRONICLE_STAGE_PROVENANCE_BINDING_KIND =
  "chronicle-stage-provenance-binding" as const;
export const CHRONICLE_STAGE_PROVENANCE_BINDING_VERSION = 1 as const;

export type StageModelGenerationMode = "provider-default" | "explicit";
export type StageModelResolutionStatus =
  | "fingerprinted"
  | "provider-reported"
  | "requested-only"
  | "unresolved";

export interface StageModelExecutionBindingV1 {
  readonly kind: typeof STAGE_MODEL_EXECUTION_BINDING_KIND;
  readonly version: typeof STAGE_MODEL_EXECUTION_BINDING_VERSION;
  readonly provider: string | null;
  /** Stable endpoint ID or a SHA-256 digest; never a URL or origin. */
  readonly endpointBindingId: string | null;
  readonly requestedModel: string | null;
  readonly effectiveModel: string | null;
  readonly modelFingerprint: string | null;
  readonly apiVariant: string | null;
  readonly reasoningMode: string | null;
  readonly generationMode: StageModelGenerationMode;
  readonly resolutionStatus: StageModelResolutionStatus;
}

export interface StageModelExecutionBindingV1Input extends Partial<
  Omit<StageModelExecutionBindingV1, "kind" | "version">
> {
  readonly kind?: typeof STAGE_MODEL_EXECUTION_BINDING_KIND;
  readonly version?: typeof STAGE_MODEL_EXECUTION_BINDING_VERSION;
}

export type ChronicleStageParseStatus = "parsed" | "invalid" | "not-attempted";
export type ChronicleStageTerminalStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SAFE_STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown !== undefined) {
    throw new TypeError(`${label} has unknown field '${unknown}'`);
  }
}

function assertNonEmpty(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertSafeString(
  value: unknown,
  label: string,
  options: { readonly digestAllowed?: boolean } = {},
): asserts value is string {
  assertNonEmpty(value, label);
  if (CREDENTIAL_SHAPED_TOKEN_PATTERN.test(value)) {
    throw new TypeError(`${label} must not contain a credential-shaped value`);
  }
  if (
    value.includes("://") ||
    value.includes("@") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new TypeError(
      `${label} must not contain a URL, origin, or credential`,
    );
  }
  if (options.digestAllowed === true && SHA256_DIGEST_PATTERN.test(value)) {
    return;
  }
  if (!SAFE_STABLE_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a stable identifier or digest`);
  }
}

function assertNullableSafeString(
  value: unknown,
  label: string,
  options: { readonly digestAllowed?: boolean } = {},
): asserts value is string | null {
  if (value === null) return;
  assertSafeString(value, label, options);
}

/** Provider/model identifiers may contain namespace slashes (for example
 * `anthropic/claude-*`); only endpoint bindings use the stricter ID grammar. */
function assertTokenString(
  value: unknown,
  label: string,
): asserts value is string {
  assertNonEmpty(value, label);
  if (
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.includes("://") ||
    CREDENTIAL_SHAPED_TOKEN_PATTERN.test(value)
  ) {
    throw new TypeError(`${label} must be a safe non-empty token`);
  }
}

/**
 * Model/provider metadata is an identity input, not a diagnostic string.  A
 * credential-looking value is rejected at this boundary instead of being
 * redacted, because redaction would silently change the binding digest.  The
 * patterns intentionally do not reject ordinary namespaced/revision model
 * identifiers such as `openai/gpt@2026-08-01`.
 */
const CREDENTIAL_SHAPED_TOKEN_PATTERN =
  /(?:\bbearer\s+[A-Za-z0-9._~+/=-]+|\bsk-[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])|\bghp_[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])|\bgithub_pat_[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])|\bglpat-[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])|\bhf_[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])|\bxox[a-z]*-[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])|\bAKIA[0-9A-Z]{12,}(?![0-9A-Z])|\bAIza[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])|(?:^|[^A-Za-z0-9])(?:x[_-])?(?:api[_-]?key|api[_-]?secret|authorization|access[_-]?token|auth[_-]?token|token|credential|secret|password|passwd|private[_-]?key|client[_-]?secret)\s*[:=])/iu;

function assertNullableTokenString(
  value: unknown,
  label: string,
): asserts value is string | null {
  if (value === null) return;
  assertTokenString(value, label);
}

function assertDigest(
  value: unknown,
  label: string,
): asserts value is Sha256Digest {
  if (typeof value !== "string" || !SHA256_DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a sha256 digest`);
  }
}

function assertVersion(value: unknown, expected: number, label: string): void {
  if (value !== expected) throw new TypeError(`${label} must be ${expected}`);
}

function compareCodeUnitStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareReceiptRefs(
  left: ChronicleStageProvenanceReceiptRefV1,
  right: ChronicleStageProvenanceReceiptRefV1,
): number {
  const executionOrder = compareCodeUnitStrings(
    left.stageExecutionId,
    right.stageExecutionId,
  );
  if (executionOrder !== 0) return executionOrder;
  return compareCodeUnitStrings(
    left.stageExecutionReceiptDigest,
    right.stageExecutionReceiptDigest,
  );
}

function nullableValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Build and validate a model binding. Defaults are intentionally conservative:
 * a route that cannot prove provider/model is represented as unresolved, and a
 * route that can only prove the requested pair is represented as requested-only.
 */
export function createStageModelExecutionBindingV1(
  input: StageModelExecutionBindingV1Input,
): StageModelExecutionBindingV1 {
  const provider = input.provider === undefined ? null : input.provider;
  const endpointBindingId =
    input.endpointBindingId === undefined ? null : input.endpointBindingId;
  const requestedModel =
    input.requestedModel === undefined ? null : input.requestedModel;
  const effectiveModel =
    input.effectiveModel === undefined ? null : input.effectiveModel;
  const modelFingerprint =
    input.modelFingerprint === undefined ? null : input.modelFingerprint;
  const apiVariant = input.apiVariant === undefined ? null : input.apiVariant;
  const reasoningMode =
    input.reasoningMode === undefined ? null : input.reasoningMode;
  const generationMode = input.generationMode ?? "provider-default";
  const resolutionStatus =
    input.resolutionStatus ??
    (provider !== null && requestedModel !== null
      ? "requested-only"
      : "unresolved");
  const binding: StageModelExecutionBindingV1 = Object.freeze({
    kind: STAGE_MODEL_EXECUTION_BINDING_KIND,
    version: STAGE_MODEL_EXECUTION_BINDING_VERSION,
    provider,
    endpointBindingId,
    requestedModel,
    effectiveModel,
    modelFingerprint,
    apiVariant,
    reasoningMode,
    generationMode,
    resolutionStatus,
  });
  assertStageModelExecutionBindingV1(binding);
  return binding;
}

/** Fail-closed structural and status invariants for a Stage Model Binding. */
export function assertStageModelExecutionBindingV1(
  value: unknown,
): asserts value is StageModelExecutionBindingV1 {
  if (!isRecord(value))
    throw new TypeError("Stage model binding must be an object");
  assertExactKeys(
    value,
    [
      "kind",
      "version",
      "provider",
      "endpointBindingId",
      "requestedModel",
      "effectiveModel",
      "modelFingerprint",
      "apiVariant",
      "reasoningMode",
      "generationMode",
      "resolutionStatus",
    ],
    "Stage model binding",
  );
  if (value.kind !== STAGE_MODEL_EXECUTION_BINDING_KIND) {
    throw new TypeError("Stage model binding kind is unsupported");
  }
  assertVersion(
    value.version,
    STAGE_MODEL_EXECUTION_BINDING_VERSION,
    "Stage model binding version",
  );
  assertNullableTokenString(value.provider, "Stage model binding provider");
  assertNullableSafeString(
    value.endpointBindingId,
    "Stage model binding endpointBindingId",
    {
      digestAllowed: true,
    },
  );
  assertNullableTokenString(
    value.requestedModel,
    "Stage model binding requestedModel",
  );
  assertNullableTokenString(
    value.effectiveModel,
    "Stage model binding effectiveModel",
  );
  assertNullableTokenString(
    value.modelFingerprint,
    "Stage model binding modelFingerprint",
  );
  assertNullableTokenString(value.apiVariant, "Stage model binding apiVariant");
  assertNullableTokenString(
    value.reasoningMode,
    "Stage model binding reasoningMode",
  );
  if (
    value.generationMode !== "provider-default" &&
    value.generationMode !== "explicit"
  ) {
    throw new TypeError("Stage model binding generationMode is unsupported");
  }
  if (
    value.resolutionStatus !== "fingerprinted" &&
    value.resolutionStatus !== "provider-reported" &&
    value.resolutionStatus !== "requested-only" &&
    value.resolutionStatus !== "unresolved"
  ) {
    throw new TypeError("Stage model binding resolutionStatus is unsupported");
  }

  switch (value.resolutionStatus) {
    case "fingerprinted":
      if (
        value.provider === null ||
        value.modelFingerprint === null ||
        (value.requestedModel === null && value.effectiveModel === null)
      ) {
        throw new TypeError(
          "fingerprinted Stage model binding requires provider, model, and modelFingerprint",
        );
      }
      break;
    case "provider-reported":
      if (value.provider === null || value.effectiveModel === null) {
        throw new TypeError(
          "provider-reported Stage model binding requires provider and effectiveModel",
        );
      }
      if (value.modelFingerprint !== null) {
        throw new TypeError(
          "provider-reported Stage model binding must not carry a fingerprint",
        );
      }
      break;
    case "requested-only":
      if (value.provider === null || value.requestedModel === null) {
        throw new TypeError(
          "requested-only Stage model binding requires provider and requestedModel",
        );
      }
      if (value.effectiveModel !== null || value.modelFingerprint !== null) {
        throw new TypeError(
          "requested-only Stage model binding must not infer effectiveModel or fingerprint",
        );
      }
      break;
    case "unresolved":
      if (
        value.provider !== null ||
        value.endpointBindingId !== null ||
        value.requestedModel !== null ||
        value.effectiveModel !== null ||
        value.modelFingerprint !== null ||
        value.apiVariant !== null ||
        value.reasoningMode !== null
      ) {
        throw new TypeError(
          "unresolved Stage model binding must use explicit null route/model fields",
        );
      }
      if (value.generationMode !== "provider-default") {
        throw new TypeError(
          "unresolved Stage model binding must use provider-default generationMode",
        );
      }
      break;
  }
}

export function isStageModelExecutionBindingV1(
  value: unknown,
): value is StageModelExecutionBindingV1 {
  try {
    assertStageModelExecutionBindingV1(value);
    return true;
  } catch {
    return false;
  }
}

/** Canonical model-binding digest; request digests deliberately do not call this. */
export async function digestStageModelExecutionBinding(
  binding: StageModelExecutionBindingV1,
): Promise<Sha256Digest> {
  assertStageModelExecutionBindingV1(binding);
  return digestStableJson({
    domain: CHRONICLE_STAGE_MODEL_BINDING_DIGEST_DOMAIN,
    binding,
  });
}

export interface StageModelRouteMetadataLike {
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly apiVariant?: string | null;
  readonly endpointId?: string | null;
  readonly endpointBindingId?: string | null;
}

/**
 * Convert non-persistent route metadata into a conservative binding. Route
 * origins are intentionally ignored; only an ID supplied by the transport is
 * eligible for the durable sidecar.
 */
export function createStageModelExecutionBindingFromRoute(
  route: StageModelRouteMetadataLike | null | undefined,
  args: Readonly<Record<string, unknown>> = {},
): StageModelExecutionBindingV1 {
  const routeProvider = nullableValue(route?.provider);
  const routeModel = nullableValue(route?.model);
  const requestedProvider = nullableValue(args.provider);
  const requestedModel = nullableValue(args.model);
  const provider = routeProvider ?? requestedProvider;
  const model = routeModel ?? requestedModel;
  const endpointBindingId =
    nullableValue(route?.endpointBindingId) ?? nullableValue(route?.endpointId);
  const apiVariant = nullableValue(route?.apiVariant);
  const explicitGeneration = [
    "reasoningMode",
    "thinking",
    "effort",
    "reasoningEnabled",
    "reasoningEffort",
    "requestMaxOutputTokens",
  ].some((key) => args[key] !== undefined && args[key] !== null);
  const reasoningMode =
    typeof args.reasoningMode === "string"
      ? args.reasoningMode
      : typeof args.reasoningEffort === "string"
        ? `reasoning-effort:${args.reasoningEffort}`
        : typeof args.effort === "string"
          ? `effort:${args.effort}`
          : typeof args.reasoningEnabled === "boolean"
            ? args.reasoningEnabled
              ? "enabled"
              : "disabled"
            : args.thinking === null || args.thinking === undefined
              ? null
              : "thinking-configured";
  const requestedRouteIsComplete = provider !== null && model !== null;
  return createStageModelExecutionBindingV1({
    provider: requestedRouteIsComplete ? provider : null,
    endpointBindingId: requestedRouteIsComplete ? endpointBindingId : null,
    requestedModel: requestedRouteIsComplete ? model : null,
    apiVariant: requestedRouteIsComplete ? apiVariant : null,
    reasoningMode: requestedRouteIsComplete ? reasoningMode : null,
    generationMode:
      requestedRouteIsComplete && explicitGeneration
        ? "explicit"
        : "provider-default",
    resolutionStatus: requestedRouteIsComplete
      ? "requested-only"
      : "unresolved",
  });
}

export const stageModelExecutionBindingFromResolvedRoute =
  createStageModelExecutionBindingFromRoute;

export interface ChronicleStageTerminalReceiptV1 {
  readonly kind: typeof CHRONICLE_STAGE_TERMINAL_RECEIPT_KIND;
  readonly version: typeof CHRONICLE_STAGE_TERMINAL_RECEIPT_VERSION;
  readonly stageExecution: NarrativeStageExecutionContext;
  readonly contextSetVersion: string;
  readonly contextSetDigest: Sha256Digest;
  readonly componentContractDigest: Sha256Digest;
  readonly finalRequestDigest: Sha256Digest;
  readonly modelExecutionBinding: StageModelExecutionBindingV1;
  readonly modelBindingDigest: Sha256Digest;
  /** Null means no response was received (skip, cancellation, or pre-response failure). */
  readonly responseDigest: Sha256Digest | null;
  readonly parseStatus: ChronicleStageParseStatus;
  readonly terminalStatus: ChronicleStageTerminalStatus;
  readonly stageExecutionReceiptDigest: Sha256Digest;
}

export interface BuildChronicleStageTerminalReceiptV1Input {
  readonly stageExecution: NarrativeStageExecutionContext;
  readonly contextSetVersion: string;
  readonly contextSetDigest: Sha256Digest;
  readonly componentContractDigest: Sha256Digest;
  readonly finalRequestDigest: Sha256Digest;
  readonly modelExecutionBinding: StageModelExecutionBindingV1;
  readonly modelBindingDigest?: Sha256Digest;
  readonly responseDigest: Sha256Digest | null;
  readonly parseStatus: ChronicleStageParseStatus;
  readonly terminalStatus: ChronicleStageTerminalStatus;
}

function receiptDigestPayload(
  input: Omit<ChronicleStageTerminalReceiptV1, "stageExecutionReceiptDigest">,
): Record<string, unknown> {
  return {
    domain: CHRONICLE_STAGE_TERMINAL_RECEIPT_DIGEST_DOMAIN,
    stageExecution: input.stageExecution,
    contextSetVersion: input.contextSetVersion,
    contextSetDigest: input.contextSetDigest,
    componentContractDigest: input.componentContractDigest,
    finalRequestDigest: input.finalRequestDigest,
    modelBindingDigest: input.modelBindingDigest,
    responseDigest: input.responseDigest,
    parseStatus: input.parseStatus,
    terminalStatus: input.terminalStatus,
  };
}

function assertStageReceiptFields(
  input: Omit<ChronicleStageTerminalReceiptV1, "stageExecutionReceiptDigest">,
): void {
  if (!isRecord(input.stageExecution)) {
    throw new TypeError("Stage terminal stage execution must be an object");
  }
  assertExactKeys(
    input.stageExecution,
    [
      "projectId",
      "runId",
      "taskId",
      "attemptId",
      "stageId",
      "stageExecutionId",
      "parentStageExecutionId",
    ],
    "Stage terminal stage execution",
  );
  assertStageExecutionContext(input.stageExecution);
  if (
    !Object.values(NARRATIVE_STAGE_IDS).some(
      (stageId) => stageId === input.stageExecution.stageId,
    )
  ) {
    throw new TypeError(
      `Stage terminal stageId '${input.stageExecution.stageId}' is unsupported`,
    );
  }
  const hasParent = input.stageExecution.parentStageExecutionId !== undefined;
  const isStructuredRepair =
    input.stageExecution.stageId === NARRATIVE_STAGE_IDS.structuredRepair;
  if (isStructuredRepair !== hasParent) {
    throw new TypeError(
      isStructuredRepair
        ? "Structured repair terminal stage requires parentStageExecutionId"
        : "Non-repair terminal stage must not declare parentStageExecutionId",
    );
  }
  assertNonEmpty(input.contextSetVersion, "Stage terminal contextSetVersion");
  assertDigest(input.contextSetDigest, "Stage terminal contextSetDigest");
  assertDigest(
    input.componentContractDigest,
    "Stage terminal componentContractDigest",
  );
  assertDigest(input.finalRequestDigest, "Stage terminal finalRequestDigest");
  assertStageModelExecutionBindingV1(input.modelExecutionBinding);
  assertDigest(input.modelBindingDigest, "Stage terminal modelBindingDigest");
  if (input.responseDigest !== null) {
    assertDigest(input.responseDigest, "Stage terminal responseDigest");
  }
  if (!["parsed", "invalid", "not-attempted"].includes(input.parseStatus)) {
    throw new TypeError("Stage terminal parseStatus is unsupported");
  }
  if (
    !["succeeded", "failed", "cancelled", "skipped"].includes(
      input.terminalStatus,
    )
  ) {
    throw new TypeError("Stage terminal terminalStatus is unsupported");
  }
  const responseRequired =
    input.parseStatus === "parsed" || input.parseStatus === "invalid";
  const responseAbsent = input.parseStatus === "not-attempted";
  if (
    (input.terminalStatus === "succeeded" &&
      (input.parseStatus !== "parsed" || input.responseDigest === null)) ||
    (input.terminalStatus === "failed" &&
      (input.parseStatus === "parsed" ||
        (input.parseStatus === "invalid" && input.responseDigest === null) ||
        (input.parseStatus === "not-attempted" &&
          input.responseDigest !== null))) ||
    ((input.terminalStatus === "cancelled" ||
      input.terminalStatus === "skipped") &&
      (input.parseStatus !== "not-attempted" ||
        input.responseDigest !== null)) ||
    (responseRequired && input.responseDigest === null) ||
    (responseAbsent && input.responseDigest !== null)
  ) {
    throw new TypeError(
      "Stage terminal parseStatus and terminalStatus are inconsistent",
    );
  }
}

export async function buildChronicleStageTerminalReceiptV1(
  input: BuildChronicleStageTerminalReceiptV1Input,
): Promise<ChronicleStageTerminalReceiptV1> {
  assertStageExecutionContext(input.stageExecution);
  assertStageModelExecutionBindingV1(input.modelExecutionBinding);
  const computedModelBindingDigest = await digestStageModelExecutionBinding(
    input.modelExecutionBinding,
  );
  if (
    input.modelBindingDigest !== undefined &&
    input.modelBindingDigest !== computedModelBindingDigest
  ) {
    throw new TypeError(
      "Stage terminal modelBindingDigest does not match binding",
    );
  }
  const withoutDigest = {
    kind: CHRONICLE_STAGE_TERMINAL_RECEIPT_KIND,
    version: CHRONICLE_STAGE_TERMINAL_RECEIPT_VERSION,
    stageExecution: input.stageExecution,
    contextSetVersion: input.contextSetVersion,
    contextSetDigest: input.contextSetDigest,
    componentContractDigest: input.componentContractDigest,
    finalRequestDigest: input.finalRequestDigest,
    modelExecutionBinding: input.modelExecutionBinding,
    modelBindingDigest: computedModelBindingDigest,
    responseDigest: input.responseDigest,
    parseStatus: input.parseStatus,
    terminalStatus: input.terminalStatus,
  } satisfies Omit<
    ChronicleStageTerminalReceiptV1,
    "stageExecutionReceiptDigest"
  >;
  assertStageReceiptFields(withoutDigest);
  const stageExecutionReceiptDigest = await digestStableJson(
    receiptDigestPayload(withoutDigest),
  );
  return Object.freeze({ ...withoutDigest, stageExecutionReceiptDigest });
}

export async function assertChronicleStageTerminalReceiptV1(
  value: unknown,
): Promise<void> {
  if (!isRecord(value))
    throw new TypeError("Stage terminal receipt must be an object");
  assertExactKeys(
    value,
    [
      "kind",
      "version",
      "stageExecution",
      "contextSetVersion",
      "contextSetDigest",
      "componentContractDigest",
      "finalRequestDigest",
      "modelExecutionBinding",
      "modelBindingDigest",
      "responseDigest",
      "parseStatus",
      "terminalStatus",
      "stageExecutionReceiptDigest",
    ],
    "Stage terminal receipt",
  );
  if (value.kind !== CHRONICLE_STAGE_TERMINAL_RECEIPT_KIND) {
    throw new TypeError("Stage terminal receipt kind is unsupported");
  }
  assertVersion(
    value.version,
    CHRONICLE_STAGE_TERMINAL_RECEIPT_VERSION,
    "Stage terminal receipt version",
  );
  assertDigest(
    value.stageExecutionReceiptDigest,
    "Stage terminal stageExecutionReceiptDigest",
  );
  if (
    !isRecord(value.stageExecution) ||
    value.stageExecution.parentStageExecutionId === ""
  ) {
    throw new TypeError("Stage terminal receipt has invalid stage execution");
  }
  const receipt = value as unknown as ChronicleStageTerminalReceiptV1;
  assertStageReceiptFields({
    kind: receipt.kind,
    version: receipt.version,
    stageExecution: receipt.stageExecution,
    contextSetVersion: receipt.contextSetVersion,
    contextSetDigest: receipt.contextSetDigest,
    componentContractDigest: receipt.componentContractDigest,
    finalRequestDigest: receipt.finalRequestDigest,
    modelExecutionBinding: receipt.modelExecutionBinding,
    modelBindingDigest: receipt.modelBindingDigest,
    responseDigest: receipt.responseDigest,
    parseStatus: receipt.parseStatus,
    terminalStatus: receipt.terminalStatus,
  });
  const expectedModelBindingDigest = await digestStageModelExecutionBinding(
    receipt.modelExecutionBinding,
  );
  if (expectedModelBindingDigest !== receipt.modelBindingDigest) {
    throw new TypeError("Stage terminal modelBindingDigest mismatch");
  }
  const expectedReceiptDigest = await digestStableJson(
    receiptDigestPayload(
      receipt as Omit<
        ChronicleStageTerminalReceiptV1,
        "stageExecutionReceiptDigest"
      >,
    ),
  );
  if (expectedReceiptDigest !== receipt.stageExecutionReceiptDigest) {
    throw new TypeError("Stage terminal receipt digest mismatch");
  }
}

export const validateChronicleStageTerminalReceiptV1 =
  assertChronicleStageTerminalReceiptV1;

export interface ChronicleStageProvenanceReceiptRefV1 {
  readonly stageExecutionId: string;
  readonly stageExecutionReceiptDigest: Sha256Digest;
}

export interface ChronicleStageProvenanceClosureV1 {
  readonly kind: typeof CHRONICLE_STAGE_PROVENANCE_CLOSURE_KIND;
  readonly version: typeof CHRONICLE_STAGE_PROVENANCE_CLOSURE_VERSION;
  readonly projectId: string;
  readonly runId: string;
  readonly ownerTaskId: string;
  readonly ownerAttemptId: string;
  /** Full terminal receipts are retained so the sidecar is independently verifiable. */
  readonly receipts: readonly ChronicleStageTerminalReceiptV1[];
  /** Sorted refs are an explicit canonical index over the full receipt set. */
  readonly receiptRefs: readonly ChronicleStageProvenanceReceiptRefV1[];
  readonly stageProvenanceClosureDigest: Sha256Digest;
}

export interface BuildChronicleStageProvenanceClosureV1Input {
  readonly projectId: string;
  readonly runId: string;
  readonly ownerTaskId: string;
  readonly ownerAttemptId: string;
  readonly receipts: readonly ChronicleStageTerminalReceiptV1[];
}

function closureDigestPayload(
  input: Omit<
    ChronicleStageProvenanceClosureV1,
    "stageProvenanceClosureDigest"
  >,
): Record<string, unknown> {
  return {
    domain: CHRONICLE_STAGE_PROVENANCE_CLOSURE_DIGEST_DOMAIN,
    projectId: input.projectId,
    runId: input.runId,
    ownerTaskId: input.ownerTaskId,
    ownerAttemptId: input.ownerAttemptId,
    receiptRefs: input.receiptRefs,
    receipts: input.receipts,
  };
}

function receiptRefFor(
  receipt: ChronicleStageTerminalReceiptV1,
): ChronicleStageProvenanceReceiptRefV1 {
  return {
    stageExecutionId: receipt.stageExecution.stageExecutionId,
    stageExecutionReceiptDigest: receipt.stageExecutionReceiptDigest,
  };
}

function assertClosureIdentity(input: {
  readonly projectId: unknown;
  readonly runId: unknown;
  readonly ownerTaskId: unknown;
  readonly ownerAttemptId: unknown;
}): void {
  assertNonEmpty(input.projectId, "Stage provenance closure projectId");
  assertNonEmpty(input.runId, "Stage provenance closure runId");
  assertNonEmpty(input.ownerTaskId, "Stage provenance closure ownerTaskId");
  assertNonEmpty(
    input.ownerAttemptId,
    "Stage provenance closure ownerAttemptId",
  );
}

async function assertClosureReceipts(
  closure: Omit<
    ChronicleStageProvenanceClosureV1,
    "stageProvenanceClosureDigest"
  >,
): Promise<void> {
  if (closure.receipts.length === 0) {
    throw new TypeError("Stage provenance closure requires terminal receipts");
  }
  const seenExecutionIds = new Set<string>();
  const seenReceiptDigests = new Set<string>();
  const sortedReceipts = closure.receipts.every(
    (receipt, index, receipts) =>
      index === 0 ||
      compareCodeUnitStrings(
        receipts[index - 1]!.stageExecution.stageExecutionId,
        receipt.stageExecution.stageExecutionId,
      ) <= 0,
  );
  if (!sortedReceipts) {
    throw new TypeError("Stage provenance closure receipts are noncanonical");
  }
  const sortedRefs = closure.receiptRefs.every(
    (ref, index, refs) =>
      index === 0 || compareReceiptRefs(refs[index - 1]!, ref) <= 0,
  );
  if (!sortedRefs)
    throw new TypeError(
      "Stage provenance closure receipt refs are noncanonical",
    );
  for (const receipt of closure.receipts) {
    await assertChronicleStageTerminalReceiptV1(receipt);
    const execution = receipt.stageExecution;
    if (seenExecutionIds.has(execution.stageExecutionId)) {
      throw new TypeError(
        "Stage provenance closure has duplicate stage execution IDs",
      );
    }
    if (seenReceiptDigests.has(receipt.stageExecutionReceiptDigest)) {
      throw new TypeError(
        "Stage provenance closure has duplicate receipt digests",
      );
    }
    seenExecutionIds.add(execution.stageExecutionId);
    seenReceiptDigests.add(receipt.stageExecutionReceiptDigest);
    if (
      execution.projectId !== closure.projectId ||
      execution.runId !== closure.runId
    ) {
      throw new TypeError(
        "Stage provenance closure receipt project/run mismatch",
      );
    }
    if (
      execution.stageId !== NARRATIVE_STAGE_IDS.observationExtraction &&
      execution.stageId !== NARRATIVE_STAGE_IDS.eventSynthesis &&
      execution.stageId !== NARRATIVE_STAGE_IDS.structuredRepair
    ) {
      throw new TypeError(
        "Stage provenance closure contains an unsupported stage ID",
      );
    }
  }
  const expectedRefs = [...closure.receipts]
    .map(receiptRefFor)
    .sort(compareReceiptRefs);
  if (
    stableJsonStringify(expectedRefs) !==
    stableJsonStringify(closure.receiptRefs)
  ) {
    throw new TypeError("Stage provenance closure receipt refs mismatch");
  }
  for (const receipt of closure.receipts) {
    const parentId = receipt.stageExecution.parentStageExecutionId;
    const isRepair =
      receipt.stageExecution.stageId === NARRATIVE_STAGE_IDS.structuredRepair;
    if (isRepair && parentId === undefined) {
      throw new TypeError(
        "Structured repair receipt requires a parent receipt",
      );
    }
    if (!isRepair && parentId !== undefined) {
      throw new TypeError(
        "Only structured repair receipts may declare a parent receipt",
      );
    }
    if (parentId !== undefined) {
      if (parentId === receipt.stageExecution.stageExecutionId) {
        throw new TypeError(
          "Stage provenance closure receipt cannot parent itself",
        );
      }
      if (!seenExecutionIds.has(parentId)) {
        throw new TypeError(
          "Stage provenance closure is missing a parent receipt",
        );
      }
      const parent = closure.receipts.find(
        (candidate) => candidate.stageExecution.stageExecutionId === parentId,
      );
      if (
        parent === undefined ||
        parent.stageExecution.taskId !== receipt.stageExecution.taskId ||
        parent.stageExecution.attemptId !== receipt.stageExecution.attemptId ||
        (parent.stageExecution.stageId !==
          NARRATIVE_STAGE_IDS.observationExtraction &&
          parent.stageExecution.stageId !==
            NARRATIVE_STAGE_IDS.eventSynthesis) ||
        parent.terminalStatus !== "failed" ||
        parent.parseStatus !== "invalid"
      ) {
        throw new TypeError(
          "Stage provenance repair parent must be failed invalid observation or synthesis",
        );
      }
      if (
        receipt.terminalStatus === "succeeded" &&
        receipt.parseStatus !== "parsed"
      ) {
        throw new TypeError(
          "Succeeded structured repair receipt must be parsed",
        );
      }
    }
  }
  // The parent pointer is an immutable receipt field. Verify the graph has no cycle.
  const parentById = new Map(
    closure.receipts.map((receipt) => [
      receipt.stageExecution.stageExecutionId,
      receipt.stageExecution.parentStageExecutionId,
    ]),
  );
  for (const startId of parentById.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = startId;
    while (current !== undefined) {
      if (seen.has(current))
        throw new TypeError("Stage provenance closure parent cycle");
      seen.add(current);
      current = parentById.get(current);
    }
  }
}

export async function buildChronicleStageProvenanceClosureV1(
  input: BuildChronicleStageProvenanceClosureV1Input,
): Promise<ChronicleStageProvenanceClosureV1> {
  assertClosureIdentity(input);
  if (!Array.isArray(input.receipts)) {
    throw new TypeError("Stage provenance closure receipts must be an array");
  }
  const receipts = [...input.receipts].sort((left, right) =>
    compareCodeUnitStrings(
      left.stageExecution.stageExecutionId,
      right.stageExecution.stageExecutionId,
    ),
  );
  const receiptRefs = receipts.map(receiptRefFor).sort(compareReceiptRefs);
  const withoutDigest = {
    kind: CHRONICLE_STAGE_PROVENANCE_CLOSURE_KIND,
    version: CHRONICLE_STAGE_PROVENANCE_CLOSURE_VERSION,
    projectId: input.projectId,
    runId: input.runId,
    ownerTaskId: input.ownerTaskId,
    ownerAttemptId: input.ownerAttemptId,
    receipts,
    receiptRefs,
  } satisfies Omit<
    ChronicleStageProvenanceClosureV1,
    "stageProvenanceClosureDigest"
  >;
  await assertClosureReceipts(withoutDigest);
  const stageProvenanceClosureDigest = await digestStableJson(
    closureDigestPayload(withoutDigest),
  );
  return Object.freeze({ ...withoutDigest, stageProvenanceClosureDigest });
}

export async function assertChronicleStageProvenanceClosureV1(
  value: unknown,
): Promise<void> {
  if (!isRecord(value)) {
    throw new TypeError("Stage provenance closure must be an object");
  }
  assertExactKeys(
    value,
    [
      "kind",
      "version",
      "projectId",
      "runId",
      "ownerTaskId",
      "ownerAttemptId",
      "receipts",
      "receiptRefs",
      "stageProvenanceClosureDigest",
    ],
    "Stage provenance closure",
  );
  if (value.kind !== CHRONICLE_STAGE_PROVENANCE_CLOSURE_KIND) {
    throw new TypeError("Stage provenance closure kind is unsupported");
  }
  assertVersion(
    value.version,
    CHRONICLE_STAGE_PROVENANCE_CLOSURE_VERSION,
    "Stage provenance closure version",
  );
  assertClosureIdentity({
    projectId: value.projectId,
    runId: value.runId,
    ownerTaskId: value.ownerTaskId,
    ownerAttemptId: value.ownerAttemptId,
  });
  assertDigest(
    value.stageProvenanceClosureDigest,
    "Stage provenance closure digest",
  );
  if (!Array.isArray(value.receipts) || !Array.isArray(value.receiptRefs)) {
    throw new TypeError(
      "Stage provenance closure receipts and refs are required",
    );
  }
  const closure = value as unknown as ChronicleStageProvenanceClosureV1;
  await assertClosureReceipts({
    kind: closure.kind,
    version: closure.version,
    projectId: closure.projectId,
    runId: closure.runId,
    ownerTaskId: closure.ownerTaskId,
    ownerAttemptId: closure.ownerAttemptId,
    receipts: closure.receipts,
    receiptRefs: closure.receiptRefs,
  });
  const expectedDigest = await digestStableJson(
    closureDigestPayload(
      closure as Omit<
        ChronicleStageProvenanceClosureV1,
        "stageProvenanceClosureDigest"
      >,
    ),
  );
  if (expectedDigest !== closure.stageProvenanceClosureDigest) {
    throw new TypeError("Stage provenance closure digest mismatch");
  }
}

export const validateChronicleStageProvenanceClosureV1 =
  assertChronicleStageProvenanceClosureV1;

/** C1 requires the closure to cover observation and event-synthesis stages. */
export interface ChronicleStageC1ExecutionBinding {
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly contextSetDigest: Sha256Digest;
  readonly componentContractDigest: Sha256Digest;
  readonly finalRequestDigest: Sha256Digest;
}

function hasSuccessfulStagePath(
  receipts: readonly ChronicleStageTerminalReceiptV1[],
  stageId: string,
  roots: readonly ChronicleStageTerminalReceiptV1[] = receipts,
): boolean {
  const stageRoots = roots.filter(
    (receipt) =>
      receipt.stageExecution.stageId === stageId &&
      receipt.stageExecution.parentStageExecutionId === undefined,
  );
  return stageRoots.some((root) => {
    if (root.parseStatus === "parsed" && root.terminalStatus === "succeeded") {
      return true;
    }
    if (root.parseStatus !== "invalid" || root.terminalStatus !== "failed") {
      return false;
    }
    return receipts.some(
      (receipt) =>
        receipt.stageExecution.stageId ===
          NARRATIVE_STAGE_IDS.structuredRepair &&
        receipt.stageExecution.parentStageExecutionId ===
          root.stageExecution.stageExecutionId &&
        receipt.parseStatus === "parsed" &&
        receipt.terminalStatus === "succeeded",
    );
  });
}

export async function assertChronicleStageC1ClosureCompleteness(
  closure: ChronicleStageProvenanceClosureV1,
  execution: ChronicleStageC1ExecutionBinding,
): Promise<void> {
  await assertChronicleStageProvenanceClosureV1(closure);
  assertNonEmpty(execution.projectId, "C1 projectId");
  assertNonEmpty(execution.runId, "C1 runId");
  assertNonEmpty(execution.taskId, "C1 taskId");
  assertNonEmpty(execution.attemptId, "C1 attemptId");
  assertDigest(execution.contextSetDigest, "C1 contextSetDigest");
  assertDigest(execution.componentContractDigest, "C1 componentContractDigest");
  assertDigest(execution.finalRequestDigest, "C1 finalRequestDigest");
  if (
    closure.projectId !== execution.projectId ||
    closure.runId !== execution.runId ||
    closure.ownerTaskId !== execution.taskId ||
    closure.ownerAttemptId !== execution.attemptId
  ) {
    throw new TypeError("C1 closure owner does not match stage execution");
  }
  const ownerSynthesisRoots = closure.receipts.filter(
    (receipt) =>
      receipt.stageExecution.stageId === NARRATIVE_STAGE_IDS.eventSynthesis &&
      receipt.stageExecution.parentStageExecutionId === undefined &&
      receipt.stageExecution.taskId === execution.taskId &&
      receipt.stageExecution.attemptId === execution.attemptId,
  );
  if (ownerSynthesisRoots.length === 0) {
    throw new TypeError("C1 closure is missing the owner synthesis receipt");
  }
  const ownerSynthesisMatches = ownerSynthesisRoots.some(
    (receipt) =>
      receipt.contextSetDigest === execution.contextSetDigest &&
      receipt.componentContractDigest === execution.componentContractDigest &&
      receipt.finalRequestDigest === execution.finalRequestDigest &&
      hasSuccessfulStagePath(closure.receipts, receipt.stageExecution.stageId, [
        receipt,
      ]),
  );
  if (!ownerSynthesisMatches) {
    throw new TypeError(
      "C1 owner synthesis receipt digests or terminal path do not match stage execution",
    );
  }
  for (const stageId of [
    NARRATIVE_STAGE_IDS.observationExtraction,
    NARRATIVE_STAGE_IDS.eventSynthesis,
  ] as const) {
    if (!hasSuccessfulStagePath(closure.receipts, stageId)) {
      throw new TypeError(
        `C1 stage provenance closure requires a successful ${stageId} root or a parsed successful repair child`,
      );
    }
  }
}

export interface ChronicleStageProvenanceBindingV1 {
  readonly kind: typeof CHRONICLE_STAGE_PROVENANCE_BINDING_KIND;
  readonly version: typeof CHRONICLE_STAGE_PROVENANCE_BINDING_VERSION;
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly stageProvenanceClosureDigest: Sha256Digest;
}

export interface BuildChronicleStageProvenanceBindingV1Input {
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly closure: ChronicleStageProvenanceClosureV1;
}

export function buildChronicleStageProvenanceBindingV1(
  input: BuildChronicleStageProvenanceBindingV1Input,
): ChronicleStageProvenanceBindingV1 {
  assertNonEmpty(input.projectId, "Stage provenance binding projectId");
  assertNonEmpty(input.runId, "Stage provenance binding runId");
  assertNonEmpty(input.taskId, "Stage provenance binding taskId");
  if (
    input.projectId !== input.closure.projectId ||
    input.runId !== input.closure.runId ||
    input.taskId !== input.closure.ownerTaskId
  ) {
    throw new TypeError("Stage provenance binding owner mismatch");
  }
  assertDigest(
    input.closure.stageProvenanceClosureDigest,
    "Stage provenance binding closure digest",
  );
  return Object.freeze({
    kind: CHRONICLE_STAGE_PROVENANCE_BINDING_KIND,
    version: CHRONICLE_STAGE_PROVENANCE_BINDING_VERSION,
    projectId: input.projectId,
    runId: input.runId,
    taskId: input.taskId,
    stageProvenanceClosureDigest: input.closure.stageProvenanceClosureDigest,
  });
}

export function assertChronicleStageProvenanceBindingV1(
  value: unknown,
): asserts value is ChronicleStageProvenanceBindingV1 {
  if (!isRecord(value)) {
    throw new TypeError("Stage provenance binding must be an object");
  }
  assertExactKeys(
    value,
    [
      "kind",
      "version",
      "projectId",
      "runId",
      "taskId",
      "stageProvenanceClosureDigest",
    ],
    "Stage provenance binding",
  );
  if (value.kind !== CHRONICLE_STAGE_PROVENANCE_BINDING_KIND) {
    throw new TypeError("Stage provenance binding kind is unsupported");
  }
  assertVersion(
    value.version,
    CHRONICLE_STAGE_PROVENANCE_BINDING_VERSION,
    "Stage provenance binding version",
  );
  assertNonEmpty(value.projectId, "Stage provenance binding projectId");
  assertNonEmpty(value.runId, "Stage provenance binding runId");
  assertNonEmpty(value.taskId, "Stage provenance binding taskId");
  assertDigest(
    value.stageProvenanceClosureDigest,
    "Stage provenance binding closure digest",
  );
}

export interface ChronicleStageProvenanceReachabilityInput {
  readonly execution: Pick<
    NarrativeStageExecutionContext,
    "projectId" | "runId" | "taskId" | "attemptId"
  >;
  readonly closure: ChronicleStageProvenanceClosureV1;
  readonly provenanceBinding: ChronicleStageProvenanceBindingV1;
  readonly envelope?: {
    readonly revisionBasis?: unknown;
  };
}

/** Prove that the frozen Interpretation Revision coordinate reaches the sidecar. */
export async function assertChronicleStageProvenanceReachability(
  input: ChronicleStageProvenanceReachabilityInput,
): Promise<void> {
  assertNonEmpty(
    input.execution.projectId,
    "Stage provenance execution projectId",
  );
  assertNonEmpty(input.execution.runId, "Stage provenance execution runId");
  assertNonEmpty(input.execution.taskId, "Stage provenance execution taskId");
  assertNonEmpty(
    input.execution.attemptId,
    "Stage provenance execution attemptId",
  );
  await assertChronicleStageProvenanceClosureV1(input.closure);
  assertChronicleStageProvenanceBindingV1(input.provenanceBinding);
  if (
    input.provenanceBinding.stageProvenanceClosureDigest !==
    input.closure.stageProvenanceClosureDigest
  ) {
    throw new TypeError("Stage provenance binding closure digest mismatch");
  }
  if (
    input.execution.projectId !== input.closure.projectId ||
    input.execution.runId !== input.closure.runId ||
    input.execution.taskId !== input.closure.ownerTaskId ||
    input.execution.attemptId !== input.closure.ownerAttemptId
  ) {
    throw new TypeError(
      "Stage provenance closure does not reach stage execution owner",
    );
  }
  if (
    input.provenanceBinding.projectId !== input.execution.projectId ||
    input.provenanceBinding.runId !== input.execution.runId ||
    input.provenanceBinding.taskId !== input.execution.taskId
  ) {
    throw new TypeError(
      "Stage provenance sidecar does not reach stage execution",
    );
  }
  const revisionBasis = input.envelope?.revisionBasis;
  if (revisionBasis !== undefined) {
    if (!isRecord(revisionBasis)) {
      throw new TypeError("Stage provenance Envelope revisionBasis is invalid");
    }
    if (revisionBasis.runId !== input.execution.runId) {
      throw new TypeError("Stage provenance Envelope runId mismatch");
    }
    if (revisionBasis.taskId !== input.execution.taskId) {
      throw new TypeError("Stage provenance Envelope taskId mismatch");
    }
  }
}

export const assertChronicleStageEnvelopeProvenanceReachability =
  assertChronicleStageProvenanceReachability;
