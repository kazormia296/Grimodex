import { AI_PROVIDERS, type AiModel, type AiProvider } from "../types";
import { debugLog } from "@/lib/debugLog";
import { parseAnthropicLiveCaps } from "./anthropicLiveCaps";

/**
 * 保存形式の版。v3 は Anthropic の一覧（context／最大出力）を provider 名つきで保存する。
 * v4 は Anthropic の thinking の方式と effort の段階（anthropicThinking）を足す。
 * v2（公開済みの版）は Anthropic 以外の provider だけを引き継ぐ。形式は field を足しただけで、
 * v2 には Anthropic の行が無いはず。あっても読まない（旧版は provider 名に依らず復元するので、
 * Anthropic の行は v2 の key に書かない）。v3 は未公開の開発中の版なので捨てる。
 */
const STORAGE_KEY = "grimodex.modelCaps.v4";
const V2_STORAGE_KEY = "grimodex.modelCaps.v2";
const PREVIOUS_STORAGE_KEYS = [
  V2_STORAGE_KEY,
  "grimodex.modelCaps.v3",
] as const;
const LEGACY_OPENROUTER_STORAGE_KEY = "grimodex.openrouterModelCaps.v1";
const CURRENT_VERSION = 4;
const KNOWN_PROVIDERS: ReadonlySet<string> = new Set(AI_PROVIDERS);
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000; // 24h

/** Anthropic の `capabilities` から取り出した、thinking の方式と effort の段階（製品が使う分だけ）。 */
export type AnthropicEffortStep = "low" | "medium" | "high" | "max";

export interface AnthropicThinkingMeta {
  /** thinking の方式 adaptive が使えるか。 */
  adaptive: boolean;
  /** thinking の方式 enabled（budget_tokens）が使えるか。 */
  enabled: boolean;
  /**
   * effort の段階（xhigh は製品の EffortLevel に無いので含めない）。三つの状態を区別する：
   * - undefined：不明（応答に effort が無い、または段階の形が読めない）。今の推定のまま。
   * - 空配列：effort 非対応、または対応でも製品の段階が 1 つも無い（xhigh だけ等）。adaptive を送らない。
   * - 非空：許された段階。adaptive で送る effort は、この中へ丸める。
   */
  effortSteps?: AnthropicEffortStep[];
}

interface StoredMeta {
  /** Provider-advertised model maximum. */
  ctx?: number;
  /** Provider-advertised maximum completion tokens. */
  out?: number;
  /** Runtime/configured context actually available to the request. */
  effectiveCtx?: number;
  effectiveSource?: string;
  tools?: 0 | 1;
  reasoning?: 0 | 1;
  inPerM?: number;
  outPerM?: number;
  /** Anthropic の一覧の thinking／effort。Anthropic の namespace だけが持つ。 */
  anthropicThinking?: AnthropicThinkingMeta;
  /**
   * Last successful provider metadata observation. Kept separate from the
   * effective generation because a transient runner probe failure must not
   * discard model maximums or capability flags learned by an older success.
   */
  metadataGeneration?: number;
  /** Last success/failure that authoritatively observed effective context. */
  observationGeneration?: number;
}

interface StoredProvider {
  fetchedAt: number;
  /** Ollama endpoint owning this namespace. Undefined for other providers. */
  scope?: string;
  models: Record<string, StoredMeta>;
}

interface StorageFormatV2 {
  version: typeof CURRENT_VERSION;
  providers: Partial<Record<AiProvider, StoredProvider>>;
}

interface LegacyStorageFormatV1 {
  version: 1;
  fetchedAt: number;
  models: Record<string, StoredMeta>;
}

type RuntimeAiModel = AiModel & {
  /** Ollama runner / model-parameter context discovered by the backend. */
  effectiveContextLength?: number;
  effectiveContextSource?: string;
  /** Provider-native capabilities, for example Ollama /api/show.capabilities. */
  capabilities?: string[];
};

export interface DynamicModelMeta {
  /** Provider-advertised model maximum. */
  ctx?: number;
  /** Provider-advertised maximum completion tokens. */
  out?: number;
  /** Runtime/configured context actually available to the request. */
  effectiveCtx?: number;
  effectiveSource?: string;
  tools?: boolean;
  reasoning?: boolean;
  inPerM?: number;
  outPerM?: number;
  /** Anthropic の一覧の thinking／effort（無ければ「分からない」＝今の推定のまま）。 */
  anthropicThinking?: AnthropicThinkingMeta;
}

export interface RegisterDynamicModelCapsOptions {
  /**
   * Update only one selected model while preserving the rest of the provider
   * namespace. Used by the Ollama Agent preflight so it does not `/api/show`
   * every installed model.
   */
  selectedModelId?: string;
  /** Ollama endpoint that owns the returned metadata. */
  ollamaEndpoint?: string;
  /**
   * Renderer-process request generation used to reject an older Ollama
   * observation that completes after a newer one.
   */
  observationGeneration?: number;
}

// Module-level provider → model id → meta registry.
let registry = new Map<AiProvider, Map<string, StoredMeta>>();
let fetchedAtByProvider = new Map<AiProvider, number>();
let scopeByProvider = new Map<AiProvider, string>();
let fullSuccessGenerationByProvider = new Map<AiProvider, number>();
let fullEffectiveGenerationByProvider = new Map<AiProvider, number>();
let hydrated = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const EFFORT_STEPS: readonly AnthropicEffortStep[] = [
  "low",
  "medium",
  "high",
  "max",
];

const warnedNoUsableEffort = new Set<string>();

function warnNoUsableEffortOnce(
  modelId: string,
  levels: readonly string[],
): void {
  if (warnedNoUsableEffort.has(modelId)) return;
  warnedNoUsableEffort.add(modelId);
  debugLog.warn(
    "ModelCaps",
    "製品が使える effort の段階が無いため thinking を送りません",
    {
      sensitivity: "safe",
      fields: { modelId, liveEffortLevels: [...levels] },
    },
  );
}

/**
 * Anthropic の model の `capabilities` から thinking の方式と effort の段階を取り出す。
 * 方式が分からない（`types` が無い）ときは undefined にして、今の推定に任せる。
 * `thinking.supported: false` は「thinking を送らない」（adaptive・enabled とも false）。
 */
function deriveAnthropicThinking(
  model: AiModel,
): AnthropicThinkingMeta | undefined {
  if (!isRecord(model.anthropicCapabilities)) return undefined;
  const live = parseAnthropicLiveCaps({
    id: model.id,
    capabilities: model.anthropicCapabilities,
  })?.thinking;
  if (!live) return undefined;
  const effortSteps = live.effortLevels
    ? EFFORT_STEPS.filter((step) => live.effortLevels?.includes(step))
    : undefined;
  if (
    live.effortLevels &&
    live.effortLevels.length > 0 &&
    effortSteps?.length === 0
  ) {
    // 対応だが製品の段階（low／medium／high／max）が 1 つも無い（例：xhigh だけ）。
    // 製品は xhigh を持たないので、送れる effort が無い。adaptive は effort を伴うので
    // thinking を送らない。黙って止めず、モデルごとに一度だけ記録する。
    warnNoUsableEffortOnce(model.id, live.effortLevels);
    return {
      adaptive: false,
      enabled: live.types?.includes("enabled") ?? false,
      effortSteps: [],
    };
  }
  if (live.supported === false) {
    return { adaptive: false, enabled: false, effortSteps };
  }
  if (live.types === undefined) {
    // 方式が分からない。effort だけは分かっていても、方式と一緒にしか使わない。
    return undefined;
  }
  return {
    adaptive: live.types.includes("adaptive"),
    enabled: live.types.includes("enabled"),
    effortSteps,
  };
}

function sanitizeStoredThinking(
  value: unknown,
): AnthropicThinkingMeta | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.adaptive !== "boolean" ||
    typeof value.enabled !== "boolean"
  ) {
    return undefined;
  }
  const stored: unknown = value.effortSteps;
  const effortSteps = Array.isArray(stored)
    ? EFFORT_STEPS.filter((step) => stored.includes(step))
    : undefined;
  return { adaptive: value.adaptive, enabled: value.enabled, effortSteps };
}

/**
 * 保存された ctx／out は localStorage 由来で信頼できない。正の安全な整数でなければ捨てる
 * （そのままだと outputBudget の requirePositiveSafeInteger が RangeError を出す）。
 */
function positiveSafeIntegerOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function durableStoredMeta(meta: StoredMeta): StoredMeta {
  const {
    effectiveCtx: _effectiveCtx,
    effectiveSource: _effectiveSource,
    metadataGeneration: _metadataGeneration,
    observationGeneration: _observationGeneration,
    ...durableMeta
  } = meta;
  return durableMeta;
}

function loadProvider(provider: AiProvider, stored: StoredProvider): void {
  const models = new Map<string, StoredMeta>();
  for (const [id, meta] of Object.entries(stored.models)) {
    if (!isRecord(meta)) continue;
    // A runner allocation is process state, not durable model metadata. Older
    // v2 caches did persist it, so explicitly discard it while hydrating.
    const durable = durableStoredMeta(meta as StoredMeta);
    models.set(id, {
      ...durable,
      ctx: positiveSafeIntegerOrUndefined(durable.ctx),
      out: positiveSafeIntegerOrUndefined(durable.out),
    });
  }
  registry.set(provider, models);
  fetchedAtByProvider.set(provider, stored.fetchedAt);
  if (typeof stored.scope === "string") {
    scopeByProvider.set(provider, stored.scope);
  }
}

/**
 * 保存された provider ごとの一覧を registry に読む。読めた（版が合った）かを返す。
 * `includeAnthropic` が false なら Anthropic の行は読まない。
 */
function readStoredProviders(
  key: string,
  version: number,
  includeAnthropic: boolean,
): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      providers?: unknown;
    };
    if (parsed.version !== version || !isRecord(parsed.providers)) return false;
    for (const [provider, value] of Object.entries(parsed.providers)) {
      if (
        !KNOWN_PROVIDERS.has(provider) ||
        (!includeAnthropic && provider === "anthropic") ||
        !isRecord(value) ||
        !Number.isFinite(value.fetchedAt) ||
        !isRecord(value.models)
      ) {
        continue;
      }
      loadProvider(provider as AiProvider, {
        fetchedAt: value.fetchedAt as number,
        scope: typeof value.scope === "string" ? value.scope : undefined,
        models: value.models as Record<string, StoredMeta>,
      });
    }
    return true;
  } catch {
    // Corrupt JSON — try the next source before falling back empty.
    return false;
  }
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  if (typeof localStorage === "undefined") return;

  let loadedCurrent = readStoredProviders(STORAGE_KEY, CURRENT_VERSION, true);
  if (!loadedCurrent && readStoredProviders(V2_STORAGE_KEY, 2, false)) {
    // v2 から引き継いだ分を今の版で書き直す（Anthropic の行は読んでいない）。
    loadedCurrent = true;
    persist();
  }
  // 古い版の key は残さない（v2 は上で引き継いだ後）。
  for (const key of PREVIOUS_STORAGE_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // storage が使えなくても registry はそのまま動く。
    }
  }

  if (loadedCurrent && registry.has("openrouter")) return;

  try {
    const raw = localStorage.getItem(LEGACY_OPENROUTER_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<LegacyStorageFormatV1>;
    if (
      parsed.version !== 1 ||
      !Number.isFinite(parsed.fetchedAt) ||
      !isRecord(parsed.models)
    ) {
      return;
    }
    loadProvider("openrouter", {
      fetchedAt: parsed.fetchedAt as number,
      models: parsed.models as Record<string, StoredMeta>,
    });
    // Complete the migration lazily without deleting the recoverable v1 cache.
    persist();
  } catch {
    // Corrupt legacy JSON — silent fail, keeps registry empty.
  }
}

function persist(): void {
  if (typeof localStorage === "undefined") return;
  const providers: StorageFormatV2["providers"] = {};
  for (const [provider, modelsById] of registry) {
    const models: Record<string, StoredMeta> = {};
    for (const [id, meta] of modelsById) {
      // `/api/ps` reflects only the current Ollama process. Persisting it made a
      // previous runner's allocation look authoritative after restart.
      models[id] = durableStoredMeta(meta);
    }
    providers[provider] = {
      // A selected-model probe must not make an incomplete provider catalog
      // fresh. Zero remains intentionally stale after the next hydration.
      fetchedAt: fetchedAtByProvider.get(provider) ?? 0,
      ...(scopeByProvider.has(provider)
        ? { scope: scopeByProvider.get(provider) }
        : {}),
      models,
    };
  }
  const storage: StorageFormatV2 = {
    version: CURRENT_VERSION,
    providers,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
  } catch {
    // Storage quota — in-memory registry remains usable.
  }
}

function parsePricingPerMillion(
  priceStr: string | undefined,
): number | undefined {
  if (!priceStr) return undefined;
  // OpenRouter pricing is USD per token; multiply by 1M for per-million rate.
  const perToken = parseFloat(priceStr);
  if (!isFinite(perToken) || perToken <= 0) return undefined;
  return perToken * 1_000_000;
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function normalizeOllamaModelId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/:latest$/u, "");
}

function normalizeOllamaEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/u, "");
}

/**
 * Make one endpoint the active owner of the Ollama capability namespace.
 * Legacy/unscoped metadata is discarded instead of being attributed to the
 * currently selected server.
 */
export function activateDynamicProviderScope(
  provider: AiProvider,
  scope: string,
): boolean {
  hydrate();
  if (provider !== "ollama") return false;
  const normalizedScope = normalizeOllamaEndpoint(scope);
  if (scopeByProvider.get(provider) === normalizedScope) return false;

  const changed =
    registry.has(provider) ||
    fetchedAtByProvider.has(provider) ||
    scopeByProvider.has(provider);
  registry.set(provider, new Map());
  fetchedAtByProvider.delete(provider);
  fullSuccessGenerationByProvider.delete(provider);
  fullEffectiveGenerationByProvider.delete(provider);
  scopeByProvider.set(provider, normalizedScope);
  persist();
  return changed;
}

function normalizedCapabilityFlags(model: RuntimeAiModel): {
  tools?: 0 | 1;
  reasoning?: 0 | 1;
} {
  const parameterCaps = model.supportedParameters;
  const providerCaps = model.capabilities;
  if (!parameterCaps && !providerCaps) return {};

  const normalized = new Set(
    [...(parameterCaps ?? []), ...(providerCaps ?? [])].map((value) =>
      value.toLowerCase(),
    ),
  );
  return {
    tools: normalized.has("tools") ? 1 : 0,
    reasoning:
      normalized.has("reasoning") || normalized.has("thinking") ? 1 : 0,
  };
}

/**
 * Register provider model metadata in an isolated namespace.
 *
 * Provider scope makes bare Ollama ids safe: an Ollama `qwen3:latest` can never
 * overwrite a model with the same id from another provider.
 */
export function registerDynamicModelCaps(
  provider: AiProvider,
  models: AiModel[],
  options: RegisterDynamicModelCapsOptions = {},
): boolean {
  hydrate();
  if (provider === "ollama" && options.ollamaEndpoint !== undefined) {
    activateDynamicProviderScope(provider, options.ollamaEndpoint);
  }
  const selectedModelId = options.selectedModelId?.trim() || undefined;
  const observationGeneration = positiveSafeInteger(
    options.observationGeneration,
  );
  const fullSuccessGeneration =
    fullSuccessGenerationByProvider.get(provider) ?? 0;
  const fullEffectiveGeneration =
    fullEffectiveGenerationByProvider.get(provider) ?? 0;
  if (
    observationGeneration !== undefined &&
    fullSuccessGeneration > observationGeneration
  ) {
    // A newer successful full catalog is authoritative for membership.
    return false;
  }
  if (observationGeneration !== undefined && !selectedModelId) {
    fullSuccessGenerationByProvider.set(provider, observationGeneration);
    if (fullEffectiveGeneration <= observationGeneration) {
      fullEffectiveGenerationByProvider.set(provider, observationGeneration);
    }
  }
  const existingRegistry = registry.get(provider) ?? new Map();
  const selectedDurableSnapshot = selectedModelId
    ? JSON.stringify(
        [...existingRegistry]
          .filter(([id]) =>
            provider === "ollama"
              ? normalizeOllamaModelId(id) ===
                normalizeOllamaModelId(selectedModelId)
              : id === selectedModelId,
          )
          .map(([id, meta]) => [id, durableStoredMeta(meta)])
          .sort(([left], [right]) => String(left).localeCompare(String(right))),
      )
    : null;
  // Full catalog refreshes replace the namespace. A selected-model probe
  // replaces only that row so unrelated model metadata remains available.
  const providerRegistry = selectedModelId
    ? new Map(existingRegistry)
    : new Map<string, StoredMeta>();

  const findExistingMeta = (modelId: string): StoredMeta | undefined => {
    const normalizedModelId =
      provider === "ollama" ? normalizeOllamaModelId(modelId) : modelId;
    return [...existingRegistry]
      .filter(([id]) =>
        provider === "ollama"
          ? normalizeOllamaModelId(id) === normalizedModelId
          : id === modelId,
      )
      .map(([, meta]) => meta)
      .sort(
        (left, right) =>
          Math.max(
            right.metadataGeneration ?? 0,
            right.observationGeneration ?? 0,
          ) -
          Math.max(
            left.metadataGeneration ?? 0,
            left.observationGeneration ?? 0,
          ),
      )[0];
  };
  const stripEffectiveMeta = (meta: StoredMeta): StoredMeta => {
    const {
      effectiveCtx: _effectiveCtx,
      effectiveSource: _effectiveSource,
      ...withoutEffective
    } = meta;
    return withoutEffective;
  };
  const mergeObservedMeta = (
    incoming: StoredMeta,
    existing: StoredMeta | undefined,
    durableMetadataAvailable: boolean,
  ): StoredMeta => {
    if (observationGeneration === undefined) return incoming;

    const existingMetadataGeneration = existing?.metadataGeneration ?? 0;
    const existingEffectiveGeneration = existing?.observationGeneration ?? 0;
    const effectiveAuthorityGeneration = Math.max(
      existingEffectiveGeneration,
      fullEffectiveGeneration,
    );
    const durable =
      existing && !durableMetadataAvailable
        ? stripEffectiveMeta(existing)
        : existing && existingMetadataGeneration > observationGeneration
          ? stripEffectiveMeta(existing)
          : stripEffectiveMeta(incoming);
    const effective =
      effectiveAuthorityGeneration > observationGeneration
        ? {
            effectiveCtx: existing?.effectiveCtx,
            effectiveSource: existing?.effectiveSource,
          }
        : {
            effectiveCtx: incoming.effectiveCtx,
            effectiveSource: incoming.effectiveSource,
          };
    return {
      ...durable,
      ...(effective.effectiveCtx !== undefined
        ? { effectiveCtx: effective.effectiveCtx }
        : {}),
      ...(effective.effectiveSource !== undefined
        ? { effectiveSource: effective.effectiveSource }
        : {}),
      metadataGeneration: Math.max(
        existingMetadataGeneration,
        durableMetadataAvailable ? observationGeneration : 0,
      ),
      observationGeneration: Math.max(
        effectiveAuthorityGeneration,
        observationGeneration,
      ),
    };
  };

  if (selectedModelId) {
    const normalizedSelected = normalizeOllamaModelId(selectedModelId);
    for (const id of providerRegistry.keys()) {
      if (
        (provider === "ollama" &&
          normalizeOllamaModelId(id) === normalizedSelected) ||
        id === selectedModelId
      ) {
        providerRegistry.delete(id);
      }
    }
  }

  for (const rawModel of models) {
    const model = rawModel as RuntimeAiModel;
    const existing = findExistingMeta(model.id);
    const contextLength = positiveSafeInteger(model.contextLength);
    const maxCompletionTokens = positiveSafeInteger(model.maxCompletionTokens);
    const effectiveContextLength = positiveSafeInteger(
      model.effectiveContextLength,
    );
    const flags = normalizedCapabilityFlags(model);
    const anthropicThinking =
      provider === "anthropic" ? deriveAnthropicThinking(model) : undefined;
    const inPerM = parsePricingPerMillion(model.pricingPrompt);
    const outPerM = parsePricingPerMillion(model.pricingCompletion);
    const hasDurableMetadata =
      contextLength !== undefined ||
      maxCompletionTokens !== undefined ||
      flags.tools !== undefined ||
      flags.reasoning !== undefined ||
      anthropicThinking !== undefined ||
      inPerM !== undefined ||
      outPerM !== undefined;
    const hasMetadata =
      hasDurableMetadata || effectiveContextLength !== undefined;
    // Ollama rows are retained even when /api/show failed so this authoritative
    // refresh explicitly clears any previous runner allocation. Other providers
    // keep the legacy behavior of omitting metadata-free rows.
    if (!hasMetadata && provider !== "ollama") continue;

    const meta: StoredMeta = { ...flags };
    if (contextLength !== undefined) meta.ctx = contextLength;
    if (maxCompletionTokens !== undefined) meta.out = maxCompletionTokens;
    if (anthropicThinking !== undefined) {
      meta.anthropicThinking = anthropicThinking;
    }
    if (effectiveContextLength !== undefined) {
      meta.effectiveCtx = effectiveContextLength;
      if (model.effectiveContextSource) {
        meta.effectiveSource = model.effectiveContextSource;
      }
    }
    if (inPerM !== undefined) meta.inPerM = inPerM;
    if (outPerM !== undefined) meta.outPerM = outPerM;
    providerRegistry.set(
      model.id,
      mergeObservedMeta(meta, existing, hasDurableMetadata),
    );
  }

  if (
    selectedModelId &&
    observationGeneration !== undefined &&
    !models.some((model) =>
      provider === "ollama"
        ? normalizeOllamaModelId(model.id) ===
          normalizeOllamaModelId(selectedModelId)
        : model.id === selectedModelId,
    )
  ) {
    // A successful selected lookup with no row means the tag no longer exists.
    // Keep a runtime tombstone so an older full response cannot resurrect it.
    providerRegistry.set(selectedModelId, {
      metadataGeneration: observationGeneration,
      observationGeneration: Math.max(
        fullEffectiveGeneration,
        observationGeneration,
      ),
    });
  }

  if (!selectedModelId && observationGeneration !== undefined) {
    // A stale full-catalog response may omit a model that a newer selected
    // probe observed. Retain every newer row, not just ids present in the old
    // response.
    for (const [id, meta] of existingRegistry) {
      if ((meta.metadataGeneration ?? 0) > observationGeneration) {
        providerRegistry.set(id, meta);
      }
    }
  }

  registry.set(provider, providerRegistry);
  if (!selectedModelId) fetchedAtByProvider.set(provider, Date.now());
  // Persist fetchedAt even when the provider returned no capability-bearing rows,
  // otherwise an empty-but-successful catalog would be refetched on every render.
  const selectedDurableChanged =
    selectedModelId !== undefined &&
    selectedDurableSnapshot !==
      JSON.stringify(
        [...providerRegistry]
          .filter(([id]) =>
            provider === "ollama"
              ? normalizeOllamaModelId(id) ===
                normalizeOllamaModelId(selectedModelId)
              : id === selectedModelId,
          )
          .map(([id, meta]) => [id, durableStoredMeta(meta)])
          .sort(([left], [right]) => String(left).localeCompare(String(right))),
      );
  if (!selectedModelId || selectedDurableChanged) persist();
  return true;
}

/**
 * Anthropic `GET /v1/models` の一覧を、provider 名つきで登録する（context・最大出力と、
 * `capabilities` から取った thinking の方式・effort の段階）。使うのは能力表に無い id だけ
 * （modelLimits.ts の mergeAnthropicLive）。
 * キー未登録・取得失敗のときの固定の予備は limit も capabilities も持たないので、その一覧では
 * 登録せず、前に取得した live を残す。登録したら true。
 */
export function registerAnthropicModelCaps(models: AiModel[]): boolean {
  const hasLimits = models.some(
    (model) =>
      positiveSafeInteger(model.contextLength) !== undefined ||
      positiveSafeInteger(model.maxCompletionTokens) !== undefined ||
      deriveAnthropicThinking(model) !== undefined,
  );
  if (!hasLimits) return false;
  return registerDynamicModelCaps("anthropic", models);
}

/**
 * Drop runtime/config-derived effective context observations while preserving
 * model maximums and capability flags. Call this before/after a failed Ollama
 * force refresh so a previous runner allocation is never trusted as current.
 */
export function invalidateDynamicEffectiveContext(
  provider: AiProvider,
  modelId?: string,
  options: { notNewerThanGeneration?: number } = {},
): void {
  hydrate();
  const failureGeneration = positiveSafeInteger(options.notNewerThanGeneration);
  const fullEffectiveGeneration =
    fullEffectiveGenerationByProvider.get(provider) ?? 0;
  if (
    failureGeneration !== undefined &&
    fullEffectiveGeneration > failureGeneration
  ) {
    return;
  }
  if (failureGeneration !== undefined && modelId === undefined) {
    fullEffectiveGenerationByProvider.set(provider, failureGeneration);
  }
  const providerRegistry =
    registry.get(provider) ?? new Map<string, StoredMeta>();
  if (!registry.has(provider)) registry.set(provider, providerRegistry);

  const invalidate = (id: string, meta: StoredMeta): void => {
    if (
      options.notNewerThanGeneration !== undefined &&
      (meta.observationGeneration ?? 0) > options.notNewerThanGeneration
    ) {
      return;
    }
    if (
      meta.effectiveCtx === undefined &&
      meta.effectiveSource === undefined &&
      (failureGeneration === undefined ||
        meta.observationGeneration === failureGeneration)
    ) {
      return;
    }
    providerRegistry.set(id, {
      ...meta,
      effectiveCtx: undefined,
      effectiveSource: undefined,
      ...(failureGeneration !== undefined
        ? { observationGeneration: failureGeneration }
        : {}),
    });
  };

  if (modelId !== undefined) {
    const normalizedModelId = normalizeOllamaModelId(modelId);
    let matched = false;
    for (const [id, meta] of providerRegistry) {
      if (
        id === modelId ||
        (provider === "ollama" &&
          normalizeOllamaModelId(id) === normalizedModelId)
      ) {
        matched = true;
        invalidate(id, meta);
      }
    }
    if (!matched && failureGeneration !== undefined) {
      // Negative selected observation: block an older full/selected success
      // that is still in flight from resurrecting this row.
      providerRegistry.set(modelId, {
        observationGeneration: failureGeneration,
      });
    }
  } else {
    for (const [id, meta] of providerRegistry) invalidate(id, meta);
  }

  // Effective observations and their generations are runtime-only, so this
  // invalidation never changes the durable storage payload.
}

/**
 * Resolve dynamic metadata by provider and model id.
 *
 * The legacy `openrouter/<id>` prefix is stripped only inside the OpenRouter
 * namespace. Bare ids are otherwise first-class and collision-free.
 */
export function getDynamicModelMeta(
  provider: AiProvider,
  modelId: string,
  ollamaEndpoint?: string,
): DynamicModelMeta | null {
  hydrate();
  if (
    provider === "ollama" &&
    ollamaEndpoint !== undefined &&
    scopeByProvider.get(provider) !== normalizeOllamaEndpoint(ollamaEndpoint)
  ) {
    return null;
  }
  const providerRegistry = registry.get(provider);
  if (!providerRegistry) return null;

  let raw = providerRegistry.get(modelId);
  if (!raw && provider === "ollama") {
    const normalizedModelId = normalizeOllamaModelId(modelId);
    raw = [...providerRegistry].find(
      ([id]) => normalizeOllamaModelId(id) === normalizedModelId,
    )?.[1];
  }
  if (!raw && provider === "openrouter" && modelId.startsWith("openrouter/")) {
    raw = providerRegistry.get(modelId.slice("openrouter/".length));
  }
  if (!raw) return null;
  const ctx = positiveSafeIntegerOrUndefined(raw.ctx);
  const out = positiveSafeIntegerOrUndefined(raw.out);
  if (
    (raw.metadataGeneration !== undefined ||
      raw.observationGeneration !== undefined) &&
    ctx === undefined &&
    out === undefined &&
    raw.effectiveCtx === undefined &&
    raw.effectiveSource === undefined &&
    raw.tools === undefined &&
    raw.reasoning === undefined &&
    raw.inPerM === undefined &&
    raw.outPerM === undefined &&
    raw.anthropicThinking === undefined
  ) {
    return null;
  }

  return {
    ctx,
    out,
    effectiveCtx: raw.effectiveCtx,
    effectiveSource: raw.effectiveSource,
    tools: raw.tools === undefined ? undefined : raw.tools === 1,
    reasoning: raw.reasoning === undefined ? undefined : raw.reasoning === 1,
    inPerM: raw.inPerM,
    outPerM: raw.outPerM,
    anthropicThinking: sanitizeStoredThinking(raw.anthropicThinking),
  };
}

/**
 * Return whether one provider's capability cache is absent or past its TTL.
 */
export function isDynamicCapsStale(
  provider: AiProvider,
  ttlMs = DEFAULT_TTL_MS,
  ollamaEndpoint?: string,
): boolean {
  hydrate();
  if (
    provider === "ollama" &&
    ollamaEndpoint !== undefined &&
    scopeByProvider.get(provider) !== normalizeOllamaEndpoint(ollamaEndpoint)
  ) {
    return true;
  }
  const fetchedAt = fetchedAtByProvider.get(provider);
  return fetchedAt === undefined || Date.now() - fetchedAt > ttlMs;
}

/** Test-only reset of the in-memory registry and hydration state. */
export function __resetDynamicModelCapsForTests(): void {
  registry = new Map();
  fetchedAtByProvider = new Map();
  scopeByProvider = new Map();
  fullSuccessGenerationByProvider = new Map();
  fullEffectiveGenerationByProvider = new Map();
  warnedNoUsableEffort.clear();
  hydrated = false;
}
