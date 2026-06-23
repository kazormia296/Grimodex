import { useEffect, useState } from "react";
import { useAiSettingsStore } from "@/features/chat/store";
import { listAiModels } from "@/features/chat/api";
import type { AiModel, AiProvider } from "@/features/chat/types";

/**
 * 指定プロバイダのモデル一覧を取得する (A/B 枠の別プロバイダ選択用)。
 * - アクティブプロバイダはストアの既ロード `models` をそのまま使う (再 fetch しない)。
 *   ただし OpenAI 互換は「どのエンドポイントか」で一覧が変わるため、active エンドポイント
 *   以外を指定したときは別プロバイダ同様オンデマンド取得する。
 * - 別プロバイダ / 別エンドポイントはオンデマンドで `list_ai_models` を叩き、
 *   モジュール内にキャッシュする。OpenAI 互換は endpointId をキャッシュキーに含めて
 *   別エンドポイント同士で衝突/上書きさせない。
 * - キー未設定 / 取得失敗は `error=true` で返す (呼び出し側で手入力にフォールバック)。
 *
 * `cli` プロバイダは送信経路 (send_chat_message) を通らないため A/B では対象外。
 * このフックには渡さない前提だが、渡されても fetch は試みる (空/error で返る)。
 */
const moduleCache = new Map<string, AiModel[]>();

const cacheKeyFor = (provider: AiProvider, endpointId?: string): string =>
  provider === "openai-compatible" ? `oc:${endpointId ?? ""}` : provider;

export interface ProviderModelsState {
  models: AiModel[];
  loading: boolean;
  /** 取得に失敗した (キー未設定など)。手入力フォールバックの合図。 */
  error: boolean;
}

export function useProviderModels(
  provider: AiProvider | undefined,
  endpointId?: string | undefined,
): ProviderModelsState {
  const activeProvider = useAiSettingsStore((s) => s.settings?.provider);
  const activeEndpointId = useAiSettingsStore(
    (s) => s.settings?.activeOpenaiCompatibleEndpointId,
  );
  const activeModels = useAiSettingsStore((s) => s.models);
  const activeLoading = useAiSettingsStore((s) => s.isLoadingModels);

  const isCompat = provider === "openai-compatible";
  // active 判定: 通常はプロバイダ一致。OpenAI 互換はエンドポイントまで一致してはじめて
  // ストアの既ロード一覧を流用できる (別エンドポイントは別 base_url で一覧が異なる)。
  const isActive =
    !!provider &&
    provider === activeProvider &&
    (!isCompat ||
      (endpointId ?? undefined) === (activeEndpointId ?? undefined));

  const cacheKey = provider ? cacheKeyFor(provider, endpointId) : "";

  const [state, setState] = useState<ProviderModelsState>(() => ({
    models:
      cacheKey && moduleCache.has(cacheKey) ? moduleCache.get(cacheKey)! : [],
    loading: false,
    error: false,
  }));

  useEffect(() => {
    // アクティブプロバイダ(+エンドポイント) or provider 未指定はフェッチ不要 (派生で返す)。
    if (!provider || isActive) return;
    if (moduleCache.has(cacheKey)) {
      setState({
        models: moduleCache.get(cacheKey)!,
        loading: false,
        error: false,
      });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: false }));
    listAiModels(provider, isCompat ? endpointId : undefined)
      .then((models) => {
        if (cancelled) return;
        moduleCache.set(cacheKey, models);
        setState({ models, loading: false, error: false });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ models: [], loading: false, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [provider, isActive, cacheKey, endpointId, isCompat]);

  if (isActive) {
    return { models: activeModels, loading: activeLoading, error: false };
  }
  if (!provider) {
    return { models: [], loading: false, error: false };
  }
  return state;
}
