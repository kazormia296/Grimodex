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
  /** OpenRouter 動的 capability レジストリの更新カウンタ。購読するとキャップ変更で再レンダリングされる。 */
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
  loadModels: () => Promise<void>;
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

// in-flight ガード（多重発火防止）
let capsRefreshInFlight = false;
let modelLoadRequestGeneration = 0;

async function resolveCliBinaryAvailability(
  settings: AiSettings,
): Promise<boolean> {
  if (settings.cli?.binaryPath?.trim()) return true;
  const path = await cliApi.detectCliBinary(settings.cli?.kind ?? "claude");
  return path !== null;
}

async function maybeRefreshDynamicCaps(): Promise<void> {
  if (capsRefreshInFlight) return;
  if (!isDynamicCapsStale()) return;
  capsRefreshInFlight = true;
  try {
    const { settings } = useAiSettingsStore.getState();
    if (settings?.provider !== "openrouter") return;
    const models = await api.listAiModels("openrouter");
    registerDynamicModelCaps(models);
    useAiSettingsStore.setState((s) => ({
      models,
      modelCapsRevision: s.modelCapsRevision + 1,
    }));
  } catch {
    // network error — silent fail, use stale/hardcoded caps
  } finally {
    capsRefreshInFlight = false;
  }
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
    const settings = await api.getAiSettings();
    const keyPresent = await api.hasApiKey(
      settings.provider,
      settings.activeOpenaiCompatibleEndpointId,
    );
    let cliBinaryAvailable: boolean | null = null;
    if (settings.provider === "cli") {
      cliBinaryAvailable = await resolveCliBinaryAvailability(settings);
    }
    set({
      settings,
      hasApiKey: keyPresent,
      cliBinaryAvailable,
      modelLoadError: null,
    });
    void maybeRefreshDynamicCaps();
  },

  saveSettings: async (settings: AiSettings) => {
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
    const testInvalidated =
      providerSwitched ||
      prev?.model !== settings.model ||
      prev?.modelApiVariant !== settings.modelApiVariant ||
      prev?.browserAiMode !== settings.browserAiMode;
    set({
      settings,
      cliBinaryAvailable,
      ...(testInvalidated ? { connectionTestResult: null } : {}),
      // チャット用一時モデルはプロバイダ依存(モデル名前空間が違う)なので、
      // プロバイダが変わったら破棄して新プロバイダの既定に戻す。別プロバイダ override も
      // 同時にクリアする(切替後のアクティブ設定と矛盾させない)。
      ...(providerSwitched
        ? {
            models: [],
            isLoadingModels: false,
            modelLoadError: null,
            chatModelOverride: null,
            chatProviderOverride: null,
            chatModelVariantOverride: null,
            chatEndpointIdOverride: null,
          }
        : {}),
    });
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

  loadModels: async () => {
    const { settings } = get();
    if (!settings) return;

    const requestGeneration = ++modelLoadRequestGeneration;
    const requestedProvider = settings.provider;
    const requestedEndpointId = settings.activeOpenaiCompatibleEndpointId;
    const requestedCliKind = settings.cli?.kind ?? "claude";
    const requestedCliTransport = settings.cli?.codexTransport ?? "exec";
    const requestedCliBinaryPath = settings.cli?.binaryPath;
    const requestedBrowserAiMode = settings.browserAiMode ?? "http";
    const isCurrentRequest = () => {
      const current = get().settings;
      return (
        requestGeneration === modelLoadRequestGeneration &&
        current?.provider === requestedProvider &&
        current.activeOpenaiCompatibleEndpointId === requestedEndpointId &&
        (current?.browserAiMode ?? "http") === requestedBrowserAiMode &&
        (requestedProvider !== "cli" ||
          ((current.cli?.kind ?? "claude") === requestedCliKind &&
            (current.cli?.codexTransport ?? "exec") === requestedCliTransport &&
            (current.cli?.binaryPath ?? "") === (requestedCliBinaryPath ?? "")))
      );
    };

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
      // それ以外は Rust 側 fetch_models に委譲
      // (Anthropic / AiNovelist は静的リストを返す、OpenAI 互換は active エンドポイントを叩く)
      const models = await api.listAiModels(
        requestedProvider,
        requestedEndpointId,
      );
      if (!isCurrentRequest()) return;
      if (requestedProvider === "openrouter") {
        registerDynamicModelCaps(models);
        set({
          models,
          isLoadingModels: false,
          modelLoadError: null,
          modelCapsRevision: get().modelCapsRevision + 1,
        });
      } else {
        set({ models, isLoadingModels: false, modelLoadError: null });
      }
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
