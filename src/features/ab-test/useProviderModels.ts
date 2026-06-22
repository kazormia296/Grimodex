import { useEffect, useState } from "react";
import { useAiSettingsStore } from "@/features/chat/store";
import { listAiModels } from "@/features/chat/api";
import type { AiModel, AiProvider } from "@/features/chat/types";

/**
 * 指定プロバイダのモデル一覧を取得する (A/B 枠の別プロバイダ選択用)。
 * - アクティブプロバイダはストアの既ロード `models` をそのまま使う (再 fetch しない)。
 * - 別プロバイダはオンデマンドで `list_ai_models` を叩き、モジュール内にキャッシュする。
 * - キー未設定 / 取得失敗は `error=true` で返す (呼び出し側で手入力にフォールバック)。
 *
 * `cli` プロバイダは送信経路 (send_chat_message) を通らないため A/B では対象外。
 * このフックには渡さない前提だが、渡されても fetch は試みる (空/error で返る)。
 */
const moduleCache = new Map<string, AiModel[]>();

export interface ProviderModelsState {
  models: AiModel[];
  loading: boolean;
  /** 取得に失敗した (キー未設定など)。手入力フォールバックの合図。 */
  error: boolean;
}

export function useProviderModels(
  provider: AiProvider | undefined,
): ProviderModelsState {
  const activeProvider = useAiSettingsStore((s) => s.settings?.provider);
  const activeModels = useAiSettingsStore((s) => s.models);
  const activeLoading = useAiSettingsStore((s) => s.isLoadingModels);

  const isActive = !!provider && provider === activeProvider;

  const [state, setState] = useState<ProviderModelsState>(() => ({
    models:
      provider && moduleCache.has(provider) ? moduleCache.get(provider)! : [],
    loading: false,
    error: false,
  }));

  useEffect(() => {
    // アクティブプロバイダ or provider 未指定はフェッチ不要 (派生で返す)。
    if (!provider || isActive) return;
    if (moduleCache.has(provider)) {
      setState({
        models: moduleCache.get(provider)!,
        loading: false,
        error: false,
      });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: false }));
    listAiModels(provider)
      .then((models) => {
        if (cancelled) return;
        moduleCache.set(provider, models);
        setState({ models, loading: false, error: false });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ models: [], loading: false, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [provider, isActive]);

  if (isActive) {
    return { models: activeModels, loading: activeLoading, error: false };
  }
  if (!provider) {
    return { models: [], loading: false, error: false };
  }
  return state;
}
