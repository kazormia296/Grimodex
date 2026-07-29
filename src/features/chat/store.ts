import { create } from "zustand";
import * as api from "./api";
import * as cliApi from "./cliApi";
import * as codexAppApi from "./codexAppApi";
import { resolveModelApiVariant } from "./aiNovelist";
import type {
  AiProvider,
  AiSettings,
  AiModel,
  ConnectionTestResult,
} from "./types";
import {
  DEFAULT_AI_SETTINGS,
  ollamaContextLengthSettingKeys,
  resolveActiveOpenaiCompatibleEndpoint,
} from "./types";

/** API キー不要で接続テストできるプロバイダ。
 * Rust 側 resolve_api_key (commands/ai.rs) のキー省略可否と一致させること。 */
const KEYLESS_TEST_PROVIDERS = new Set<AiProvider>([
  "ollama",
  "openai-compatible",
  "cli",
]);
import {
  activateDynamicProviderScope,
  invalidateDynamicEffectiveContext,
  registerDynamicModelCaps,
  isDynamicCapsStale,
} from "./agent/dynamicModelCaps";

export interface AiSettingsState {
  settings: AiSettings | null;
  hasApiKey: boolean;
  /** CLI バイナリの検出結果。null = 未検出/CLI プロバイダ非選択。 */
  cliBinaryAvailable: boolean | null;
  isTestingConnection: boolean;
  connectionTestResult: ConnectionTestResult | null;
  models: AiModel[];
  isLoadingModels: boolean;
  /** User-visible failure from the last explicit model-list/connection probe. */
  modelLoadError: string | null;
  /** 動的 capability レジストリの更新カウンタ。購読するとキャップ変更で再レンダリングされる。 */
  modelCapsRevision: number;
  /**
   * チャットパネルで一時的に選んだチャットモデル(その場限り)。
   * - 永続化しない(アプリ再起動で null に戻る)。保存される既定チャットモデル
   *   (settings.model)は書き換えない。
   * - チャット送信経路だけがこれを優先して使う。インライン AI / Beat / 校閲などは
   *   従来どおり settings.model(既定)を読むので、チャットでの一時選択が他経路へ
   *   漏れない。
   * - プロバイダ切替時にクリアする(モデル名前空間が変わるため)。
   */
  chatModelOverride: string | null;
  /**
   * チャットパネルで「別プロバイダ」のモデルを一時選択したときの provider override。
   * - null = アクティブプロバイダ(settings.provider)のまま(従来挙動・同一プロバイダ内一時モデル)。
   * - 非null = その 1 送信だけ別プロバイダへ流す(グローバル設定は変えない。別プロバイダの
   *   API キーは keyring に保存済み前提)。chatModelOverride と対で持ち、送信経路が
   *   provider/model/variant を一括で使う(per-role routing より優先)。
   * - chatModelOverride と同時にプロバイダ切替でクリアする。
   */
  chatProviderOverride: AiProvider | null;
  /**
   * 別プロバイダ override 時の解決済み API 経路(variant)。選択時に
   * resolveModelApiVariant で確定して持つ(送信時に active provider の models へ
   * 依存せずこの値を使う — Sakana=responses 等)。null = backend 既定解決。
   */
  chatModelVariantOverride: string | null;
  /**
   * OpenAI 互換で別エンドポイントのモデルを一時選択したときの endpoint id override。
   * provider が同一 "openai-compatible" のままでも、この値で送信先 base_url / API キーを
   * 切り替える。null = 設定の active エンドポイント。chatModelOverride と対でクリアする。
   */
  chatEndpointIdOverride: string | null;

  loadSettings: () => Promise<void>;
  saveSettings: (settings: AiSettings) => Promise<void>;
  saveApiKey: (key: string) => Promise<void>;
  deleteApiKey: () => Promise<void>;
  testConnection: () => Promise<void>;
  loadModels: (options?: { force?: boolean }) => Promise<void>;
  /**
   * チャット用一時モデルを設定する。
   * - `setChatModelOverride(null)` で既定へ戻す(provider/variant override も解除)。
   * - 第2引数 `opts.provider` を渡すと別プロバイダ override(別プロバイダのモデル選択)。
   *   省略時は同一プロバイダ内の一時モデルとして扱い、provider/variant override を解除する。
   */
  setChatModelOverride: (
    model: string | null,
    opts?: {
      provider?: AiProvider | null;
      variant?: string | null;
      /** OpenAI 互換エンドポイント id（別サーバのモデル選択時）。 */
      endpointId?: string | null;
    },
  ) => void;
}

type DynamicCapsProvider = Extract<AiProvider, "openrouter" | "ollama">;

const DYNAMIC_CAPS_PROVIDERS = new Set<AiProvider>(["openrouter", "ollama"]);

// Full catalog と selected-model probe は返す範囲が異なるため、別 key で共有する。
const capsRefreshInFlight = new Map<string, Promise<AiModel[] | null>>();
let modelLoadRequestGeneration = 0;
let settingsLoadGeneration = 0;
let settingsWriteGeneration = 0;
let settingsSaveTail: Promise<void> = Promise.resolve();
let ollamaObservationRequestGeneration = 0;
// Rust 側は cold model の preload を最大 60 秒待ってから runner allocation を
// 再取得する。renderer が先に打ち切って観測結果を捨てないよう、境界側に余裕を持たせる。
const OLLAMA_SELECTED_PROBE_TIMEOUT_MS = 95_000;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        handle = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

interface OllamaObservedModel {
  metadataGeneration: number;
  effectiveGeneration: number;
  model: AiModel | null;
}

interface OllamaObservedScope {
  fullSuccessGeneration: number;
  fullEffectiveGeneration: number;
  rows: Map<string, OllamaObservedModel>;
}

const ollamaObservedScopes = new Map<string, OllamaObservedScope>();
let activeOllamaObservationEndpoint: string | null = null;
let ollamaEndpointActivationEpoch = 0;

function isDynamicCapsProvider(
  provider: AiProvider,
): provider is DynamicCapsProvider {
  return DYNAMIC_CAPS_PROVIDERS.has(provider);
}

function normalizeOllamaEndpoint(endpoint: string | null | undefined): string {
  return endpoint?.trim().replace(/\/+$/u, "") ?? "";
}

function normalizeOllamaModelId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/:latest$/u, "");
}

function activateOllamaObservationEndpoint(endpoint: string): number {
  if (activeOllamaObservationEndpoint !== endpoint) {
    activeOllamaObservationEndpoint = endpoint;
    ollamaEndpointActivationEpoch += 1;
    // Runner allocations are process state. Switching away and back must not
    // resurrect the previous visit's observation for the same URL.
    ollamaObservedScopes.delete(endpoint);
  }
  return ollamaEndpointActivationEpoch;
}

function getOllamaObservedScope(endpoint: string): OllamaObservedScope {
  let scope = ollamaObservedScopes.get(endpoint);
  if (!scope) {
    scope = {
      fullSuccessGeneration: 0,
      fullEffectiveGeneration: 0,
      rows: new Map(),
    };
    ollamaObservedScopes.set(endpoint, scope);
  }
  return scope;
}

function stripEffectiveContext(model: AiModel): AiModel {
  const {
    effectiveContextLength: _effectiveContextLength,
    effectiveContextSource: _effectiveContextSource,
    ...durableModel
  } = model;
  return durableModel;
}

function hasDurableOllamaMetadata(model: AiModel): boolean {
  return (
    model.contextLength !== undefined ||
    model.maxCompletionTokens !== undefined ||
    model.supportedParameters !== undefined ||
    model.pricingPrompt !== undefined ||
    model.pricingCompletion !== undefined
  );
}

function mergeOllamaDurableMetadata(
  primary: AiModel,
  fallback: AiModel | undefined,
): AiModel {
  if (!fallback) return primary;
  return {
    ...fallback,
    ...primary,
    contextLength: primary.contextLength ?? fallback.contextLength,
    maxCompletionTokens:
      primary.maxCompletionTokens ?? fallback.maxCompletionTokens,
    supportedParameters:
      primary.supportedParameters ?? fallback.supportedParameters,
    pricingPrompt: primary.pricingPrompt ?? fallback.pricingPrompt,
    pricingCompletion: primary.pricingCompletion ?? fallback.pricingCompletion,
  };
}

function mergeOllamaObservedModel(input: {
  incoming: AiModel;
  existing: OllamaObservedModel | undefined;
  generation: number;
  fullEffectiveGeneration: number;
}): OllamaObservedModel {
  const existingMetadataGeneration = input.existing?.metadataGeneration ?? 0;
  const existingEffectiveGeneration = input.existing?.effectiveGeneration ?? 0;
  const effectiveAuthorityGeneration = Math.max(
    existingEffectiveGeneration,
    input.fullEffectiveGeneration,
  );
  const incomingDurableMetadataAvailable = hasDurableOllamaMetadata(
    input.incoming,
  );
  if (
    input.existing &&
    existingMetadataGeneration > input.generation &&
    input.existing.model === null
  ) {
    return {
      metadataGeneration: existingMetadataGeneration,
      effectiveGeneration: Math.max(
        effectiveAuthorityGeneration,
        input.generation,
      ),
      model: null,
    };
  }
  const durable =
    input.existing?.model &&
    (!incomingDurableMetadataAvailable ||
      existingMetadataGeneration > input.generation)
      ? stripEffectiveContext(input.existing.model)
      : stripEffectiveContext(input.incoming);
  const effectiveSource =
    effectiveAuthorityGeneration > input.generation
      ? input.existing?.model
      : input.incoming;
  return {
    metadataGeneration: Math.max(
      existingMetadataGeneration,
      incomingDurableMetadataAvailable ? input.generation : 0,
    ),
    effectiveGeneration: Math.max(
      effectiveAuthorityGeneration,
      input.generation,
    ),
    model: {
      ...durable,
      ...(effectiveSource?.effectiveContextLength !== undefined
        ? {
            effectiveContextLength: effectiveSource.effectiveContextLength,
          }
        : {}),
      ...(effectiveSource?.effectiveContextSource !== undefined
        ? {
            effectiveContextSource: effectiveSource.effectiveContextSource,
          }
        : {}),
    },
  };
}

function reconcileOllamaObservation(input: {
  endpoint: string;
  generation: number;
  models: AiModel[];
  selectedModelId: string | null;
  fallbackModels?: AiModel[];
}): { accepted: boolean; models: AiModel[] } {
  const scope = getOllamaObservedScope(input.endpoint);
  if (scope.fullSuccessGeneration > input.generation) {
    return { accepted: false, models: [] };
  }

  if (input.selectedModelId) {
    const key = normalizeOllamaModelId(input.selectedModelId);
    const fallbackModel = input.fallbackModels?.find(
      (model) => normalizeOllamaModelId(model.id) === key,
    );
    const scopedExisting = scope.rows.get(key);
    const existing = scopedExisting
      ? {
          ...scopedExisting,
          model: scopedExisting.model
            ? mergeOllamaDurableMetadata(scopedExisting.model, fallbackModel)
            : null,
        }
      : fallbackModel
        ? {
            metadataGeneration: 0,
            effectiveGeneration: 0,
            model: fallbackModel,
          }
        : undefined;
    const replacement = input.models.find(
      (model) => normalizeOllamaModelId(model.id) === key,
    );
    if (replacement) {
      scope.rows.set(
        key,
        mergeOllamaObservedModel({
          incoming: replacement,
          existing,
          generation: input.generation,
          fullEffectiveGeneration: scope.fullEffectiveGeneration,
        }),
      );
    } else {
      scope.rows.set(key, {
        metadataGeneration: input.generation,
        effectiveGeneration: Math.max(
          existing?.effectiveGeneration ?? 0,
          input.generation,
        ),
        model: null,
      });
    }
    const authoritative = scope.rows.get(key)?.model ?? null;
    return {
      accepted: true,
      models: authoritative ? [authoritative] : [],
    };
  }

  scope.fullSuccessGeneration = input.generation;
  if (scope.fullEffectiveGeneration <= input.generation) {
    scope.fullEffectiveGeneration = input.generation;
  }
  const nextRows = new Map<string, OllamaObservedModel>();
  for (const model of input.models) {
    const key = normalizeOllamaModelId(model.id);
    const existing = scope.rows.get(key);
    nextRows.set(
      key,
      mergeOllamaObservedModel({
        incoming: model,
        existing,
        generation: input.generation,
        fullEffectiveGeneration: scope.fullEffectiveGeneration,
      }),
    );
  }
  for (const [key, existing] of scope.rows) {
    if (existing.metadataGeneration > input.generation && !nextRows.has(key)) {
      nextRows.set(key, existing);
    }
  }
  scope.rows = nextRows;
  return {
    accepted: true,
    models: [...nextRows.values()].flatMap((entry) =>
      entry.model ? [entry.model] : [],
    ),
  };
}

function recordOllamaObservationFailure(input: {
  endpoint: string;
  generation: number;
  selectedModelId: string | null;
}): boolean {
  const scope = getOllamaObservedScope(input.endpoint);
  if (scope.fullEffectiveGeneration > input.generation) return false;

  if (input.selectedModelId) {
    const key = normalizeOllamaModelId(input.selectedModelId);
    const existing = scope.rows.get(key);
    if (existing && existing.effectiveGeneration > input.generation)
      return false;
    scope.rows.set(key, {
      metadataGeneration: existing?.metadataGeneration ?? 0,
      effectiveGeneration: input.generation,
      model: existing?.model ? stripEffectiveContext(existing.model) : null,
    });
    return true;
  }

  scope.fullEffectiveGeneration = input.generation;
  for (const [key, existing] of scope.rows) {
    if (existing.effectiveGeneration > input.generation) continue;
    scope.rows.set(key, {
      metadataGeneration: existing.metadataGeneration,
      effectiveGeneration: input.generation,
      model: existing.model ? stripEffectiveContext(existing.model) : null,
    });
  }
  return true;
}

async function resolveCliBinaryAvailability(
  settings: AiSettings,
): Promise<boolean> {
  if (settings.cli?.binaryPath?.trim()) return true;
  const path = await cliApi.detectCliBinary(settings.cli?.kind ?? "claude");
  return path !== null;
}

/**
 * OpenRouter / Ollama の動的モデル metadata を更新する。
 *
 * 同一 provider の多重呼び出しは同じ backend fetch を共有する。失敗時は既存の
 * capability cache と active models を変更せず null を返すため、送信前の force
 * refresh 呼び出しは「更新成功」と「更新不能」を判別できる。
 */
export async function refreshDynamicCapsForProvider(
  provider: AiProvider,
  options: {
    force?: boolean;
    endpointId?: string | null;
    selectedModelId?: string | null;
    /** Agent/tool routes require an authoritative capability list. */
    requireOllamaCapabilities?: boolean;
    /** In-flight scope only; backend still reads the authoritative settings snapshot. */
    ollamaEndpoint?: string | null;
  } = {},
): Promise<AiModel[] | null> {
  if (!isDynamicCapsProvider(provider)) return null;

  const selectedModelId =
    provider === "ollama" ? options.selectedModelId?.trim() || null : null;
  const ollamaEndpoint =
    provider === "ollama"
      ? normalizeOllamaEndpoint(
          options.ollamaEndpoint ??
            useAiSettingsStore.getState().settings?.ollamaEndpoint,
        )
      : "";
  const ollamaEndpointEpoch =
    provider === "ollama"
      ? activateOllamaObservationEndpoint(ollamaEndpoint)
      : undefined;
  if (provider === "ollama") {
    activateDynamicProviderScope("ollama", ollamaEndpoint);
  }
  const refreshKey = [
    provider,
    provider === "ollama" ? ollamaEndpoint : (options.endpointId?.trim() ?? ""),
    provider === "ollama" ? String(ollamaEndpointEpoch) : "",
    selectedModelId ?? "*",
    options.requireOllamaCapabilities ? "capabilities-required" : "",
  ].join("\u0000");
  const pending = capsRefreshInFlight.get(refreshKey);
  if (pending) return pending;
  if (
    !selectedModelId &&
    !options.force &&
    !isDynamicCapsStale(
      provider,
      undefined,
      provider === "ollama" ? ollamaEndpoint : undefined,
    )
  ) {
    return null;
  }
  const observationGeneration =
    provider === "ollama" ? ++ollamaObservationRequestGeneration : undefined;

  const request = (async (): Promise<AiModel[] | null> => {
    try {
      const listModelsRequest = api.listAiModels(
        provider,
        provider === "ollama" ? undefined : options.endpointId,
        selectedModelId,
        provider === "ollama" ? ollamaEndpoint : undefined,
      );
      const models =
        provider === "ollama" && selectedModelId
          ? await withTimeout(
              listModelsRequest,
              OLLAMA_SELECTED_PROBE_TIMEOUT_MS,
              `Timed out while inspecting Ollama model ${selectedModelId}`,
            )
          : await listModelsRequest;
      if (
        provider === "ollama" &&
        (ollamaEndpointActivationEpoch !== ollamaEndpointEpoch ||
          normalizeOllamaEndpoint(
            useAiSettingsStore.getState().settings?.ollamaEndpoint,
          ) !== ollamaEndpoint)
      ) {
        // The response belongs to a connection the user has already left.
        // Treat it as unusable so catalog callers cannot cache the stale list.
        return null;
      }
      if (provider === "ollama" && selectedModelId) {
        const normalizedSelected = normalizeOllamaModelId(selectedModelId);
        const selectedObservation = models.find(
          (model) => normalizeOllamaModelId(model.id) === normalizedSelected,
        );
        const configuredContextLengths =
          useAiSettingsStore.getState().settings?.ollamaContextLengths ?? {};
        const hasConfiguredEffectiveContext = ollamaContextLengthSettingKeys(
          ollamaEndpoint,
          selectedModelId,
        ).some((key) => {
          const value = configuredContextLengths[key];
          return Number.isSafeInteger(value) && value > 0;
        });
        const hasObservedContext =
          selectedObservation !== undefined &&
          ((Number.isSafeInteger(selectedObservation.contextLength) &&
            (selectedObservation.contextLength ?? 0) > 0) ||
            (Number.isSafeInteger(selectedObservation.effectiveContextLength) &&
              (selectedObservation.effectiveContextLength ?? 0) > 0));
        if (
          selectedObservation &&
          !hasObservedContext &&
          !hasConfiguredEffectiveContext
        ) {
          throw new Error(
            `Ollama context metadata unavailable for selected model ${selectedModelId}`,
          );
        }
        if (
          selectedObservation &&
          options.requireOllamaCapabilities &&
          selectedObservation.supportedParameters === undefined
        ) {
          // A selected probe is a send-time authority check, not a catalog
          // fallback. Agent/tool routes must not revive stale tools=true data
          // when `/api/show` did not establish capabilities. Context maxima and
          // effective allocation are separate: a manual verified allocation may
          // remain valid even when the model maximum is unavailable.
          throw new Error(
            `Ollama metadata unavailable for selected model ${selectedModelId}`,
          );
        }
      }
      const registryAccepted = registerDynamicModelCaps(provider, models, {
        selectedModelId: selectedModelId ?? undefined,
        ollamaEndpoint: provider === "ollama" ? ollamaEndpoint : undefined,
        observationGeneration,
      });
      const observed =
        provider === "ollama" && observationGeneration !== undefined
          ? reconcileOllamaObservation({
              endpoint: ollamaEndpoint,
              generation: observationGeneration,
              models,
              selectedModelId,
              fallbackModels:
                useAiSettingsStore.getState().settings?.provider === "ollama"
                  ? useAiSettingsStore.getState().models
                  : undefined,
            })
          : { accepted: registryAccepted, models };
      if (!registryAccepted || !observed.accepted) return null;
      const authoritativeModels = observed.models;

      // Provider switch 後に旧 provider の応答で active catalog を上書きしない。
      // registry は provider scope なので、非 active provider の成功結果も安全に保持できる。
      useAiSettingsStore.setState((state) =>
        state.settings?.provider === provider &&
        (provider !== "ollama" ||
          !ollamaEndpoint ||
          normalizeOllamaEndpoint(state.settings.ollamaEndpoint) ===
            ollamaEndpoint)
          ? selectedModelId
            ? {
                models: mergeSelectedModelProbe(
                  state.models,
                  selectedModelId,
                  authoritativeModels,
                ),
                modelCapsRevision: state.modelCapsRevision + 1,
              }
            : {
                models: authoritativeModels,
                modelCapsRevision: state.modelCapsRevision + 1,
              }
          : {},
      );
      return authoritativeModels;
    } catch {
      const ollamaScopeStillCurrent =
        ollamaEndpointActivationEpoch === ollamaEndpointEpoch &&
        normalizeOllamaEndpoint(
          useAiSettingsStore.getState().settings?.ollamaEndpoint,
        ) === ollamaEndpoint;
      if (provider === "ollama" && ollamaScopeStillCurrent) {
        invalidateOllamaEffectiveContexts(selectedModelId ?? undefined, {
          ollamaEndpoint,
          notNewerThanGeneration: observationGeneration,
        });
      }
      // Static model metadata is retained after a transient failure. Mutable
      // runner observations are cleared above because reusing them is unsafe.
      return null;
    }
  })();

  capsRefreshInFlight.set(refreshKey, request);
  try {
    return await request;
  } finally {
    if (capsRefreshInFlight.get(refreshKey) === request) {
      capsRefreshInFlight.delete(refreshKey);
    }
  }
}

function mergeSelectedModelProbe(
  current: AiModel[],
  selectedModelId: string,
  probed: AiModel[],
): AiModel[] {
  const normalizeOllamaId = (modelId: string) =>
    modelId
      .trim()
      .toLowerCase()
      .replace(/:latest$/u, "");
  const normalizedSelected = normalizeOllamaId(selectedModelId);
  const replacement = probed.find(
    (model) => normalizeOllamaId(model.id) === normalizedSelected,
  );
  let matched = false;
  const next = current.map((model) => {
    if (normalizeOllamaId(model.id) !== normalizedSelected) return model;
    matched = true;
    if (replacement) {
      return {
        ...replacement,
        // Keep the catalog identity stable when the setting uses a bare alias
        // and `/api/tags` reports the equivalent `:latest` name.
        id: model.id,
        name: model.name,
      };
    }
    const {
      effectiveContextLength: _effectiveContextLength,
      effectiveContextSource: _effectiveContextSource,
      ...durableModel
    } = model;
    return durableModel;
  });
  if (!matched && replacement) next.push(replacement);
  return next;
}

/** Clear mutable Ollama runner observations in both guard and visible catalog. */
export function invalidateOllamaEffectiveContexts(
  modelId?: string,
  options: {
    ollamaEndpoint?: string;
    notNewerThanGeneration?: number;
  } = {},
): void {
  invalidateDynamicEffectiveContext("ollama", modelId, {
    notNewerThanGeneration: options.notNewerThanGeneration,
  });
  const endpoint = normalizeOllamaEndpoint(options.ollamaEndpoint);
  const failureAccepted =
    options.notNewerThanGeneration === undefined
      ? true
      : recordOllamaObservationFailure({
          endpoint,
          generation: options.notNewerThanGeneration,
          selectedModelId: modelId ?? null,
        });
  if (!failureAccepted) return;

  const normalizedModelId = modelId
    ? normalizeOllamaModelId(modelId)
    : undefined;
  useAiSettingsStore.setState((state) => {
    if (
      state.settings?.provider !== "ollama" ||
      (endpoint &&
        normalizeOllamaEndpoint(state.settings.ollamaEndpoint) !== endpoint)
    ) {
      return {};
    }
    let changed = false;
    const models = state.models.map((model) => {
      if (
        normalizedModelId &&
        normalizeOllamaModelId(model.id) !== normalizedModelId
      ) {
        return model;
      }
      const observed = getOllamaObservedScope(endpoint).rows.get(
        normalizeOllamaModelId(model.id),
      );
      if (
        options.notNewerThanGeneration !== undefined &&
        observed &&
        observed.effectiveGeneration > options.notNewerThanGeneration
      ) {
        return model;
      }
      if (
        model.effectiveContextLength === undefined &&
        model.effectiveContextSource === undefined
      ) {
        return model;
      }
      const durableModel = stripEffectiveContext(model);
      changed = true;
      return durableModel;
    });
    return changed
      ? {
          models,
          modelCapsRevision: state.modelCapsRevision + 1,
        }
      : {};
  });
}

export const useAiSettingsStore = create<AiSettingsState>()((set, get) => ({
  settings: null,
  hasApiKey: false,
  cliBinaryAvailable: null,
  isTestingConnection: false,
  connectionTestResult: null,
  models: [],
  isLoadingModels: false,
  modelLoadError: null,
  modelCapsRevision: 0,
  chatModelOverride: null,
  chatProviderOverride: null,
  chatModelVariantOverride: null,
  chatEndpointIdOverride: null,

  loadSettings: async () => {
    // A read invoked while a save is pending must observe the post-save
    // backend snapshot, never commit the pre-save endpoint/model afterward.
    let saveBarrier: Promise<void>;
    do {
      saveBarrier = settingsSaveTail;
      await saveBarrier;
    } while (saveBarrier !== settingsSaveTail);
    const observedWriteGeneration = settingsWriteGeneration;
    const requestGeneration = ++settingsLoadGeneration;
    const settings = await api.getAiSettings();
    const keyPresent = await api.hasApiKey(
      settings.provider,
      settings.activeOpenaiCompatibleEndpointId,
    );
    let cliBinaryAvailable: boolean | null = null;
    if (settings.provider === "cli") {
      cliBinaryAvailable = await resolveCliBinaryAvailability(settings);
    }
    if (
      requestGeneration !== settingsLoadGeneration ||
      observedWriteGeneration !== settingsWriteGeneration
    ) {
      return;
    }
    activateOllamaObservationEndpoint(
      normalizeOllamaEndpoint(settings.ollamaEndpoint),
    );
    const ollamaScopeChanged = activateDynamicProviderScope(
      "ollama",
      settings.ollamaEndpoint,
    );
    set({
      settings,
      hasApiKey: keyPresent,
      cliBinaryAvailable,
      modelLoadError: null,
      ...(ollamaScopeChanged
        ? { modelCapsRevision: get().modelCapsRevision + 1 }
        : {}),
      ...(ollamaScopeChanged && settings.provider === "ollama"
        ? {
            models: [],
            isLoadingModels: false,
          }
        : {}),
    });
    if (
      isDynamicCapsProvider(settings.provider) &&
      isDynamicCapsStale(
        settings.provider,
        undefined,
        settings.provider === "ollama" ? settings.ollamaEndpoint : undefined,
      )
    ) {
      void refreshDynamicCapsForProvider(settings.provider, {
        ollamaEndpoint:
          settings.provider === "ollama" ? settings.ollamaEndpoint : null,
      });
    }
  },

  saveSettings: async (settings: AiSettings) => {
    settingsWriteGeneration += 1;
    const saveTransaction = settingsSaveTail.then(async () => {
      await api.saveAiSettings(settings);
      const prev = get().settings;
      let cliBinaryAvailable: boolean | null = get().cliBinaryAvailable;
      if (settings.provider === "cli") {
        const providerChanged = prev?.provider !== "cli";
        const kindChanged = prev?.cli?.kind !== settings.cli?.kind;
        const binaryPathChanged =
          (prev?.cli?.binaryPath ?? "") !== (settings.cli?.binaryPath ?? "");
        if (providerChanged || kindChanged || binaryPathChanged) {
          cliBinaryAvailable = await resolveCliBinaryAvailability(settings);
        }
      } else {
        cliBinaryAvailable = null;
      }
      // 接続テスト結果は provider / model / API 経路(modelApiVariant)に紐づく。これらが
      // 変わった後も前の結果を表示し続けると「別プロバイダなのに成功と出ている」誤解を生む
      // ので破棄する(例: OpenAI で成功 → Anthropic タブに切替えても OpenAI の成功表示が
      // 残る/Responses トグルを切替えても /chat/completions の成功表示が残る)。
      const providerSwitched = prev?.provider !== settings.provider;
      const ollamaEndpointChanged =
        normalizeOllamaEndpoint(prev?.ollamaEndpoint) !==
        normalizeOllamaEndpoint(settings.ollamaEndpoint);
      if (ollamaEndpointChanged) {
        activateOllamaObservationEndpoint(
          normalizeOllamaEndpoint(settings.ollamaEndpoint),
        );
        activateDynamicProviderScope("ollama", settings.ollamaEndpoint);
        modelLoadRequestGeneration += 1;
      }
      const testInvalidated =
        providerSwitched ||
        ollamaEndpointChanged ||
        prev?.model !== settings.model ||
        prev?.modelApiVariant !== settings.modelApiVariant;
      set({
        settings,
        cliBinaryAvailable,
        ...(testInvalidated ? { connectionTestResult: null } : {}),
        ...(ollamaEndpointChanged
          ? { modelCapsRevision: get().modelCapsRevision + 1 }
          : {}),
        // チャット用一時モデルはプロバイダ依存(モデル名前空間が違う)なので、
        // プロバイダが変わったら破棄して新プロバイダの既定に戻す。別プロバイダ override も
        // 同時にクリアする(切替後のアクティブ設定と矛盾させない)。
        ...(providerSwitched ||
        (ollamaEndpointChanged && settings.provider === "ollama")
          ? {
              models: [],
              isLoadingModels: false,
              modelLoadError: null,
              ...(providerSwitched
                ? {
                    chatModelOverride: null,
                    chatProviderOverride: null,
                    chatModelVariantOverride: null,
                    chatEndpointIdOverride: null,
                  }
                : {}),
            }
          : {}),
      });
    });
    settingsSaveTail = saveTransaction.catch(() => undefined);
    await saveTransaction;
  },

  setChatModelOverride: (model, opts) => {
    set({
      chatModelOverride: model,
      // null(既定へ戻す)時は provider/variant/endpoint override も必ず解除する。
      chatProviderOverride: model == null ? null : (opts?.provider ?? null),
      chatModelVariantOverride: model == null ? null : (opts?.variant ?? null),
      chatEndpointIdOverride: model == null ? null : (opts?.endpointId ?? null),
    });
  },

  saveApiKey: async (key: string) => {
    const { settings } = get();
    if (!settings) return;
    await api.saveApiKey(
      settings.provider,
      key,
      settings.activeOpenaiCompatibleEndpointId,
    );
    set({ hasApiKey: true });
  },

  deleteApiKey: async () => {
    const { settings } = get();
    if (!settings) return;
    await api.deleteApiKey(
      settings.provider,
      settings.activeOpenaiCompatibleEndpointId,
    );
    set({ hasApiKey: false });
  },

  testConnection: async () => {
    const { settings, hasApiKey, models } = get();
    if (!settings || !settings.model) return;
    if (!hasApiKey && !KEYLESS_TEST_PROVIDERS.has(settings.provider)) return;

    set({ isTestingConnection: true, connectionTestResult: null });
    try {
      const apiVariant = resolveModelApiVariant(
        settings.provider,
        settings.model,
        models,
        settings.modelApiVariant,
      );
      const message = await api.testAiConnection(
        settings.provider,
        settings.model,
        apiVariant,
        settings.activeOpenaiCompatibleEndpointId,
      );
      set({
        isTestingConnection: false,
        connectionTestResult: { success: true, message },
      });
    } catch (e) {
      set({
        isTestingConnection: false,
        connectionTestResult: {
          success: false,
          message: e instanceof Error ? e.message : String(e),
        },
      });
    }
  },

  loadModels: async (options) => {
    const { settings } = get();
    if (!settings) return;

    const requestGeneration = ++modelLoadRequestGeneration;
    const requestedProvider = settings.provider;
    const requestedEndpointId = settings.activeOpenaiCompatibleEndpointId;
    const requestedOllamaEndpoint = normalizeOllamaEndpoint(
      settings.ollamaEndpoint,
    );
    const requestedCliKind = settings.cli?.kind ?? "claude";
    const requestedCliTransport = settings.cli?.codexTransport ?? "exec";
    const requestedCliBinaryPath = settings.cli?.binaryPath;
    const isCurrentRequest = () => {
      const current = get().settings;
      return (
        requestGeneration === modelLoadRequestGeneration &&
        current?.provider === requestedProvider &&
        current.activeOpenaiCompatibleEndpointId === requestedEndpointId &&
        (requestedProvider !== "ollama" ||
          normalizeOllamaEndpoint(current.ollamaEndpoint) ===
            requestedOllamaEndpoint) &&
        (requestedProvider !== "cli" ||
          ((current.cli?.kind ?? "claude") === requestedCliKind &&
            (current.cli?.codexTransport ?? "exec") === requestedCliTransport &&
            (current.cli?.binaryPath ?? "") === (requestedCliBinaryPath ?? "")))
      );
    };

    const currentModels = get().models;
    if (
      requestedProvider === "ollama" &&
      !options?.force &&
      currentModels.length > 0 &&
      !isDynamicCapsStale("ollama", undefined, requestedOllamaEndpoint)
    ) {
      // Opening the model menu must not re-run `/api/show` for the complete
      // installed catalog while the endpoint-scoped full observation is still
      // fresh. Empty catalogs are deliberately retried, and send-time selected
      // probes remain independent so mutable runner context is revalidated.
      set({ isLoadingModels: false, modelLoadError: null });
      return;
    }

    set({ isLoadingModels: true, modelLoadError: null });
    try {
      if (settings.provider === "cli") {
        const useCodexAppServer =
          requestedCliKind === "codex" && requestedCliTransport !== "exec";
        const models = useCodexAppServer
          ? await codexAppApi.listCodexAppModels()
          : await cliApi.listCliModels(
              requestedCliKind,
              requestedCliBinaryPath,
            );
        if (!isCurrentRequest()) return;
        set({ models, isLoadingModels: false, modelLoadError: null });
        return;
      }
      // それ以外は Rust 側 fetch_models に委譲する。OpenRouter / Ollama は
      // capability 登録と送信前 refresh と同じ provider-scoped fetch を共有する。
      // (Anthropic / AiNovelist は静的リスト、OpenAI 互換は active endpoint を叩く)
      const models = isDynamicCapsProvider(requestedProvider)
        ? await refreshDynamicCapsForProvider(requestedProvider, {
            force: true,
            endpointId: requestedEndpointId,
            ollamaEndpoint:
              requestedProvider === "ollama" ? requestedOllamaEndpoint : null,
          })
        : await api.listAiModels(requestedProvider, requestedEndpointId);
      if (!isCurrentRequest()) return;
      if (models === null) {
        // Dynamic refresh failure: keep the last usable list and capability cache.
        set({
          isLoadingModels: false,
          modelLoadError: `Failed to refresh ${requestedProvider} models`,
        });
        return;
      }
      set(
        isDynamicCapsProvider(requestedProvider)
          ? { isLoadingModels: false, modelLoadError: null }
          : { models, isLoadingModels: false, modelLoadError: null },
      );
    } catch (error) {
      if (!isCurrentRequest()) return;
      set({
        models: [],
        isLoadingModels: false,
        modelLoadError: error instanceof Error ? error.message : String(error),
      });
    }
  },
}));

// Re-export default settings for use in components
export { DEFAULT_AI_SETTINGS };

export type ProviderReadiness =
  | "pending"
  | "ready"
  | "no-provider"
  | "no-model";

/** AI プロバイダが実際に呼び出せる状態かを返す derived selector。
 * policy 判定とは独立しており、`useAiCapability` 内で組み合わせて使う。 */
export function selectProviderReadiness(s: AiSettingsState): ProviderReadiness {
  const { settings, hasApiKey, cliBinaryAvailable } = s;
  if (!settings) return "pending";
  // CLI は cli.model が空でも CLI 側デフォルトに委譲できるため model 不要
  if (!settings.model && settings.provider !== "cli") return "no-model";
  switch (settings.provider) {
    case "openrouter":
    case "openai":
    case "anthropic":
    case "sakana":
    case "ai-novelist":
      return hasApiKey ? "ready" : "no-provider";
    case "openai-compatible":
      // active（または先頭）エンドポイントに baseUrl があれば ready。
      // ローカル LLM は API キー不要なので baseUrl のみで判定（従来と同基準）。
      return resolveActiveOpenaiCompatibleEndpoint(settings)?.baseUrl
        ? "ready"
        : "no-provider";
    case "ollama":
      return settings.ollamaEndpoint ? "ready" : "no-provider";
    case "cli":
      if (settings.cli?.binaryPath?.trim()) return "ready";
      if (cliBinaryAvailable === null) return "pending";
      return cliBinaryAvailable ? "ready" : "no-provider";
    default: {
      // 新 provider を AI_PROVIDERS に足してこの switch を更新し忘れると、黙って
      // "no-provider"(=AI 全無効)に落ちる回帰が起きる。exhaustiveness で型エラーにして防ぐ。
      const _exhaustive: never = settings.provider;
      void _exhaustive;
      return "no-provider";
    }
  }
}

/** Web 検索 (RAG) に対応するプロバイダか。Phase 1 は OpenRouter (web plugin /
 * server tool) と Anthropic (native web_search) のみ。他はサーバサイド検索を
 * 持たない/未検証のため 🌐 トグルを非活性にする (ollama / openai-compatible /
 * ai-novelist / cli、および直叩き OpenAI は defer)。 */
export function isRagCapableProvider(
  provider: AiSettings["provider"] | null | undefined,
): boolean {
  return provider === "openrouter" || provider === "anthropic";
}
