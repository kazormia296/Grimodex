import type { AiModel, AiProvider } from "../types";

const STORAGE_KEY = "grimodex.modelCaps.v2";
const LEGACY_OPENROUTER_STORAGE_KEY = "grimodex.openrouterModelCaps.v1";
const CURRENT_VERSION = 2;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000; // 24h

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
    models.set(id, durableStoredMeta(meta as StoredMeta));
  }
  registry.set(provider, models);
  fetchedAtByProvider.set(provider, stored.fetchedAt);
  if (typeof stored.scope === "string") {
    scopeByProvider.set(provider, stored.scope);
  }
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  if (typeof localStorage === "undefined") return;

  let loadedV2 = false;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StorageFormatV2>;
      if (parsed.version === CURRENT_VERSION && isRecord(parsed.providers)) {
        for (const [provider, value] of Object.entries(parsed.providers)) {
          if (
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
        loadedV2 = true;
      }
    }
  } catch {
    // Corrupt v2 JSON — try the legacy OpenRouter cache before falling back empty.
  }

  if (loadedV2 && registry.has("openrouter")) return;

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
    const inPerM = parsePricingPerMillion(model.pricingPrompt);
    const outPerM = parsePricingPerMillion(model.pricingCompletion);
    const hasDurableMetadata =
      contextLength !== undefined ||
      maxCompletionTokens !== undefined ||
      flags.tools !== undefined ||
      flags.reasoning !== undefined ||
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
  if (
    (raw.metadataGeneration !== undefined ||
      raw.observationGeneration !== undefined) &&
    raw.ctx === undefined &&
    raw.out === undefined &&
    raw.effectiveCtx === undefined &&
    raw.effectiveSource === undefined &&
    raw.tools === undefined &&
    raw.reasoning === undefined &&
    raw.inPerM === undefined &&
    raw.outPerM === undefined
  ) {
    return null;
  }

  return {
    ctx: raw.ctx,
    out: raw.out,
    effectiveCtx: raw.effectiveCtx,
    effectiveSource: raw.effectiveSource,
    tools: raw.tools === undefined ? undefined : raw.tools === 1,
    reasoning: raw.reasoning === undefined ? undefined : raw.reasoning === 1,
    inPerM: raw.inPerM,
    outPerM: raw.outPerM,
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
  hydrated = false;
}
