import { useEffect, useMemo, useState } from "react";
import { useAiSettingsStore } from "./store";
import { hasApiKey, listAiModels } from "./api";
import { AI_PROVIDERS, type AiModel, type AiProvider } from "./types";
import { buildModelCatalog, type CatalogSection } from "./chatModelCatalog";

/**
 * チャット入力欄のモデルピッカー(複数プロバイダ横断)用カタログ取得フック。
 *
 * - active プロバイダのモデルはストアの既ロード `models` をそのまま使う(再 fetch しない)。
 * - その他の「設定済み」プロバイダはピッカーを開いたときにオンデマンドで取得し、
 *   モジュール内にキャッシュする。
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

// 別プロバイダのモデルはピッカー開閉ごとに re-fetch すると無駄なので module で持つ。
const moduleCache = new Map<AiProvider, AiModel[]>();

export function useChatModelCatalog(open: boolean): {
  sections: CatalogSection[];
  loading: boolean;
} {
  const activeProvider = useAiSettingsStore((s) => s.settings?.provider);
  const activeModels = useAiSettingsStore((s) => s.models);
  // OpenRouter 動的 caps 更新等で active models が差し替わったら再評価する。
  useAiSettingsStore((s) => s.modelCapsRevision);

  const [extra, setExtra] = useState<
    { provider: AiProvider; models: AiModel[] }[]
  >([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !activeProvider) return;
    let cancelled = false;
    setLoading(true);
    const others = AI_PROVIDERS.filter(
      (p) => p !== "cli" && p !== activeProvider,
    );
    void Promise.all(
      others.map(async (p) => {
        try {
          if (REQUIRES_KEY.has(p)) {
            const ok = await hasApiKey(p);
            if (!ok) return null;
          }
          const cached = moduleCache.get(p);
          const models = cached ?? (await listAiModels(p));
          moduleCache.set(p, models);
          if (models.length === 0) return null;
          return { provider: p, models };
        } catch {
          // キー未設定 / ローカル未起動 / ネットワーク失敗 → そのプロバイダは出さない。
          return null;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      setExtra(results.filter((r): r is NonNullable<typeof r> => r !== null));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, activeProvider]);

  const sections = useMemo(() => {
    if (!activeProvider) return [];
    return buildModelCatalog({
      activeProvider,
      providerModels: [
        { provider: activeProvider, models: activeModels },
        ...extra,
      ],
    });
  }, [activeProvider, activeModels, extra]);

  return { sections, loading };
}
