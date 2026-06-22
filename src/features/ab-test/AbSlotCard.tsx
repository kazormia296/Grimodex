import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { ModelPicker } from "@/features/chat/ModelPicker";
import { useAiSettingsStore } from "@/features/chat/store";
import type { AiProvider } from "@/features/chat/types";
import type { AbConfig } from "./abHarness";
import { AB_PROVIDERS, AB_PROVIDER_LABELS } from "./abConfig";
import { useProviderModels } from "./useProviderModels";

interface AbSlotCardProps {
  /** 表示番号 (基準を 1 とした連番。最初の変種枠は 2)。 */
  index: number;
  config: AbConfig;
  onChange: (next: AbConfig) => void;
  onRemove: () => void;
  /** provider 上書きを許可するか (chat=true / inline=false)。 */
  allowProviderOverride: boolean;
  disabled?: boolean;
}

/**
 * A/B の 1 変種枠の構成エディタ。
 * - provider セレクト (chat のみ・「既定と同じ」= 上書きなし)
 * - モデルピッカー (枠の実効プロバイダのモデル一覧。取得失敗時は手入力へフォールバック)
 * - プロンプト追記テキストエリア
 */
export function AbSlotCard({
  index,
  config,
  onChange,
  onRemove,
  allowProviderOverride,
  disabled = false,
}: AbSlotCardProps) {
  const { t } = useTranslation();
  const activeProvider = useAiSettingsStore((s) => s.settings?.provider);

  // 枠の実効プロバイダ: override があればそれ、なければ既定プロバイダ。
  const overrideProvider = (config.provider?.trim() || undefined) as
    | AiProvider
    | undefined;
  const effectiveProvider = overrideProvider ?? activeProvider;
  const { models, loading, error } = useProviderModels(effectiveProvider);

  // モデル一覧が取れない (キー未設定 / ローカル動的 / 取得失敗) → 手入力へ。
  const useManualModel = !loading && models.length === 0;

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("abTest.slotLabel", { n: index })}
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={t("abTest.removeSlot")}
          title={t("abTest.removeSlot")}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      <div className="space-y-2">
        {allowProviderOverride && (
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              {t("abTest.provider")}
            </span>
            <select
              value={config.provider ?? ""}
              disabled={disabled}
              onChange={(e) => {
                const provider = e.target.value || undefined;
                // provider を変えるとモデル一覧が変わる → モデルは選び直し (リセット)。
                onChange({ ...config, provider, model: undefined });
              }}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none disabled:opacity-40"
            >
              <option value="">{t("abTest.providerDefault")}</option>
              {AB_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {AB_PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            {t("abTest.model")}
          </span>
          {useManualModel ? (
            <input
              type="text"
              value={config.model ?? ""}
              disabled={disabled}
              onChange={(e) =>
                onChange({ ...config, model: e.target.value || undefined })
              }
              placeholder={t("abTest.modelManualPlaceholder")}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none disabled:opacity-40"
            />
          ) : (
            <ModelPicker
              models={models}
              value={config.model ?? ""}
              onChange={(model) =>
                onChange({ ...config, model: model || undefined })
              }
              isLoading={loading}
              disabled={disabled}
              placeholder={t("abTest.defaultModel")}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none"
            />
          )}
          {error && (
            <span className="mt-1 block text-xs text-amber-600 dark:text-amber-500">
              {t("abTest.providerNoKey")}
            </span>
          )}
        </label>

        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">
            {t("abTest.promptVariantLabel")}
          </span>
          <textarea
            value={config.promptVariant ?? ""}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...config,
                promptVariant: e.target.value || undefined,
              })
            }
            rows={2}
            placeholder={t("abTest.promptVariantPlaceholder")}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none disabled:opacity-40"
          />
        </label>
      </div>
    </div>
  );
}
