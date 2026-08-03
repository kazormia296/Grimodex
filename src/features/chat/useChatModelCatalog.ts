import { useEffect, useMemo, useState } from "react";
import { refreshDynamicCapsForProvider, useAiSettingsStore } from "./store";
import { hasApiKey, listAiModels } from "./api";
import {
  AI_PROVIDERS,
  getOpenaiCompatibleEndpoints,
  type AiModel,
  type AiProvider,
} from "./types";
import {
  buildModelCatalog,
  type CatalogProviderInput,
  type CatalogSection,
} from "./chatModelCatalog";
import { BROWSER_DIRECT_AI_PROVIDERS } from "./browserProviderPolicy";
import { useRuntimeCapabilities } from "@/runtime/runtimeCapabilitiesContext";
import { isDynamicCapsStale } from "./agent/dynamicModelCaps";

/**
 * チャット入力欄のモデルピッカー(複数プロバイダ横断)用カタログ取得フック。
 *
 * - active プロバイダのモデルはストアの既ロード `models` をそのまま使う(再 fetch しない)。
 * - その他の「設定済み」プロバイダはピッカーを開いたときにオンデマンドで取得し、
 *   モジュール内にキャッシュする。
 * - OpenAI 互換は「エンドポイントごと」に取得する(複数登録対応): 各エンドポイント id で
 *   `listAiModels("openai-compatible", endpoint.id)` を叩き、1 エンドポイント = 1 セクション。
 *   キャッシュキーにも endpointId を含めて別エンドポイント同士で衝突/上書きさせない。
 * - 「設定済み」の定義:
 *   - キー必須プロバイダ(openrouter/openai/anthropic/sakana/ai-novelist)は has_api_key が true。
 *     ※ Anthropic / AI のべりすと は静的リストを返すので、キー無しでモデルを出すと送信時に
 *       必ず失敗する → ここでキーの有無で必ずゲートする。
 *   - キー不要(ollama/openai-compatible)はモデルが 1 件以上取得できたときのみ採用
 *     (= エンドポイント未設定なら空で落ちる)。
 * - cli は別系統(subprocess)で send_chat_message を通らないため、別プロバイダ対象から除外する
 *   (active が cli のときの自セクションは別途 active として出る)。
 */

const REQUIRES_KEY = new Set<AiProvider>([
  "openrouter",
  "openai",
  "anthropic",
  "sakana",
  "ai-novelist",
]);

const DYNAMIC_CAPS_PROVIDERS = new Set<AiProvider>(["openrouter", "ollama"]);

/**
 * 別プロバイダ/別エンドポイントのモデルはピッカー開閉ごとに re-fetch すると無駄なので
 * module で持つ。OpenAI 互換は endpointId 単位でキャッシュキーを分ける(異なる base_url の
 * モデル一覧が互いを上書きしないように)。キーは `provider` または `oc:<endpointId>`。
 */
const moduleCache = new Map<string, AiModel[]>();

const cacheKeyFor = (provider: AiProvider, endpointId?: string): string => {
  if (provider === "openai-compatible") return `oc:${endpointId ?? ""}`;
  if (provider === "ollama") {
    return `ollama:${endpointId?.trim().replace(/\/+$/u, "") ?? ""}`;
  }
  return provider;
};

export function useChatModelCatalog(open: boolean): {
  sections: CatalogSection[];
  loading: boolean;
} {
  const runtimeCapabilities = useRuntimeCapabilities();
  const settings = useAiSettingsStore((s) => s.settings);
  const activeProvider = settings?.provider;
  const activeEndpointId = settings?.activeOpenaiCompatibleEndpointId;
  const activeModels = useAiSettingsStore((s) => s.models);
  // OpenRouter 動的 caps 更新等で active models が差し替わったら再評価する。
  useAiSettingsStore((s) => s.modelCapsRevision);

  const [extra, setExtra] = useState<CatalogProviderInput[]>([]);
  const [loading, setLoading] = useState(false);

  // OpenAI 互換エンドポイント一覧。設定が変わったら再フェッチさせる(依存に id 列を畳む)。
  const compatEndpoints = useMemo(
    () => (settings ? getOpenaiCompatibleEndpoints(settings) : []),
    [settings],
  );
  // baseUrl / apiVariant が変わったら(同一 id でも)再フェッチさせるためキーに含める。
  // id だけだとエンドポイントの URL 差し替え後に旧サーバのモデル一覧が残る。
  const compatKey = compatEndpoints
    .map((e) => `${e.id}:${e.baseUrl}:${e.apiVariant ?? ""}`)
    .join(";");

  useEffect(() => {
    if (!open || !activeProvider) return;
    let cancelled = false;
    setLoading(true);

    // 別「単一」プロバイダ(OpenAI 互換以外)。
    const availableProviders = runtimeCapabilities.browserDirectAi
      ? BROWSER_DIRECT_AI_PROVIDERS
      : AI_PROVIDERS;
    const otherProviders = availableProviders.filter(
      (p) => p !== "cli" && p !== "openai-compatible" && p !== activeProvider,
    );

    const fetchSingle = async (
      p: AiProvider,
    ): Promise<CatalogProviderInput | null> => {
      try {
        if (REQUIRES_KEY.has(p)) {
          const ok = await hasApiKey(p);
          if (!ok) return null;
        }
        const ollamaEndpoint =
          p === "ollama" ? settings?.ollamaEndpoint : undefined;
        const key = cacheKeyFor(p, ollamaEndpoint);
        const cached = moduleCache.get(key);
        let models: AiModel[] | null;
        let refreshedDynamicCaps = false;
        if (DYNAMIC_CAPS_PROVIDERS.has(p)) {
          // stale metadata は更新する。永続 metadata cache だけが fresh で、この
          // picker 用モデル一覧がまだ無い起動直後は force して一覧も取得する。
          const refreshed = await refreshDynamicCapsForProvider(p, {
            force:
              !isDynamicCapsStale(p, undefined, ollamaEndpoint) &&
              cached === undefined,
            ollamaEndpoint: ollamaEndpoint ?? null,
          });
          refreshedDynamicCaps = refreshed !== null;
          models = refreshed ?? cached ?? null;
        } else {
          models = cached ?? (await listAiModels(p));
        }
        if (!models) return null;
        moduleCache.set(key, models);
        if (
          refreshedDynamicCaps &&
          useAiSettingsStore.getState().settings?.provider !== p
        ) {
          // refresh helper は active provider の revision を更新する。横断取得した
          // 非 active provider も、選択直後の解決が新 metadata を参照できるよう通知する。
          useAiSettingsStore.setState((state) => ({
            modelCapsRevision: state.modelCapsRevision + 1,
          }));
        }
        if (models.length === 0) return null;
        return { provider: p, models };
      } catch {
        // キー未設定 / ローカル未起動 / ネットワーク失敗 → そのプロバイダは出さない。
        return null;
      }
    };

    // OpenAI 互換は登録された全エンドポイントをエンドポイント単位で取得する
    // (active プロバイダが互換でも、各エンドポイントを 1 セクションとして並べる)。
    const fetchCompatEndpoint = async (
      endpoint: (typeof compatEndpoints)[number],
    ): Promise<CatalogProviderInput | null> => {
      try {
        // base_url / apiVariant を含めたキー: URL 差し替え後に旧モデル一覧を返さない。
        const key = `oc:${endpoint.id}:${endpoint.baseUrl}:${endpoint.apiVariant ?? ""}`;
        const cached = moduleCache.get(key);
        const models =
          cached ?? (await listAiModels("openai-compatible", endpoint.id));
        moduleCache.set(key, models);
        if (models.length === 0) return null;
        return {
          provider: "openai-compatible",
          endpointId: endpoint.id,
          endpointLabel: endpoint.label || endpoint.baseUrl,
          variant: endpoint.apiVariant ?? null,
          models,
        };
      } catch {
        return null;
      }
    };

    void Promise.all([
      ...otherProviders.map(fetchSingle),
      ...compatEndpoints.map(fetchCompatEndpoint),
    ]).then((results) => {
      if (cancelled) return;
      setExtra(results.filter((r): r is CatalogProviderInput => r !== null));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // compatKey は compatEndpoints の id 列(配列 identity に依存させない)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    activeProvider,
    compatKey,
    settings?.ollamaEndpoint,
    runtimeCapabilities.browserDirectAi,
  ]);

  const sections = useMemo(() => {
    if (!activeProvider) return [];
    // active プロバイダの「自セクション」入力。OpenAI 互換のときは active エンドポイントの
    // モデル(ストア既ロード)を、その endpointId/label/variant 付きで入れる
    // (extra と key が衝突しても buildModelCatalog が冪等に最初の非空を採用)。
    const activeEntry: CatalogProviderInput =
      activeProvider === "openai-compatible"
        ? (() => {
            // active id が未設定 / 不一致(削除済み等)でも先頭にフォールバックして
            // endpointId 未定義のセクション(無言フォールバックの温床)を作らない。
            const ep =
              compatEndpoints.find((e) => e.id === activeEndpointId) ??
              compatEndpoints[0];
            return {
              provider: "openai-compatible",
              endpointId: ep?.id,
              endpointLabel: ep ? ep.label || ep.baseUrl : undefined,
              variant: ep?.apiVariant ?? null,
              models: activeModels,
            };
          })()
        : { provider: activeProvider, models: activeModels };
    return buildModelCatalog({
      activeProvider,
      activeEndpointId,
      providerModels: [activeEntry, ...extra],
    });
  }, [activeProvider, activeEndpointId, activeModels, extra, compatEndpoints]);

  return { sections, loading };
}
