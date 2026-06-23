import { useTranslation } from "react-i18next";
import { ModelPicker } from "@/features/chat/ModelPicker";
import { getProviderLabel } from "@/features/chat/providerLabels";
import {
  type ModelRole,
  roleSettingKey,
  ROLE_PROVIDERS_KEY,
  parseRoleProviders,
  isModelCapableForRole,
} from "@/features/chat/modelRouting";
import type { AiModel } from "@/features/chat/types";
import type { CatalogSection } from "@/features/chat/chatModelCatalog";
import { useSettingsStore } from "../settingsStore";

interface RoleModelRowProps {
  role: ModelRole;
  /** アクティブプロバイダの whitelist 済みモデル（「チャットと同じ」選択時に使う）。 */
  activeModels: AiModel[];
  /** プロバイダ横断カタログ（鍵が設定済みのプロバイダ/エンドポイントのみ）。 */
  sections: CatalogSection[];
  isLoadingModels: boolean;
}

/** 「チャットと同じプロバイダ」を表すセンチネル（roleProviders から role を消す）。 */
const SAME = "";

/** `provider|endpointId` でセクション選択値をエンコードする（endpointId は互換のみ）。 */
function sectionValue(provider: string, endpointId?: string): string {
  return `${provider}|${endpointId ?? ""}`;
}

/**
 * 機能別モデル（ロール単位）の 1 行。プロバイダ横断に対応し、ロールごとに
 * 「チャットと同じプロバイダ」か、鍵が設定済みの別プロバイダ/エンドポイントを選び、
 * そのプロバイダのモデル一覧から 1 つ選べる。
 *
 * 保存:
 *   - モデル ID → `aiModel.role.{role}`（既存キー）
 *   - 別プロバイダ/エンドポイント → `aiModel.roleProviders` の JSON マップ
 * 「チャットと同じ」を選ぶと roleProviders から当該ロールを除去し従来挙動へ戻す。
 */
export function RoleModelRow({
  role,
  activeModels,
  sections,
  isLoadingModels,
}: RoleModelRowProps) {
  const { t } = useTranslation();
  // whole-store 購読: set で再描画される（既存のロール ModelPicker と同契約）。
  const settingsStore = useSettingsStore();

  const key = roleSettingKey(role);
  const map = parseRoleProviders(settingsStore.get(ROLE_PROVIDERS_KEY) || "");
  const override = map[role];
  const selected = override?.provider
    ? sectionValue(override.provider, override.endpointId)
    : SAME;

  // 横断割り当て時は選択プロバイダ/エンドポイントのモデル一覧、未指定なら active。
  const section = override?.provider
    ? sections.find(
        (s) =>
          s.provider === override.provider &&
          (s.endpointId ?? "") === (override.endpointId ?? ""),
      )
    : null;
  const sourceModels: AiModel[] = section ? section.models : activeModels;
  const roleModels = sourceModels.filter((m) =>
    isModelCapableForRole(m.id, role),
  );

  const handleProviderChange = (value: string): void => {
    const next = { ...map };
    if (value === SAME) {
      delete next[role];
    } else {
      const [provider, endpointId] = value.split("|");
      next[role] = endpointId ? { provider, endpointId } : { provider };
    }
    settingsStore.set(ROLE_PROVIDERS_KEY, JSON.stringify(next));
    // プロバイダを変えるとモデル ID の名前空間が変わるため、誤送信防止にモデルを
    // クリアする（ユーザーが新プロバイダのモデルを選び直す）。
    settingsStore.set(key, "");
  };

  return (
    <div>
      <div className="mb-1 text-sm">
        {t(`settings.ai.roleModel.${role}.label`)}
      </div>
      <div className="mb-1 text-xs text-muted-foreground">
        {t(`settings.ai.roleModel.${role}.description`)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={selected}
          onChange={(e) => handleProviderChange(e.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1 text-sm"
          aria-label={t("settings.ai.roleModel.providerLabel", "プロバイダ")}
        >
          <option value={SAME}>
            {t(
              "settings.ai.roleModel.sameProvider",
              "チャットと同じプロバイダ",
            )}
          </option>
          {sections.map((s) => {
            const v = sectionValue(s.provider, s.endpointId);
            const label =
              s.provider === "openai-compatible" && s.endpointLabel
                ? `${getProviderLabel(s.provider, t)}: ${s.endpointLabel}`
                : getProviderLabel(s.provider, t);
            return (
              <option key={v} value={v}>
                {label}
              </option>
            );
          })}
        </select>
        <ModelPicker
          models={roleModels}
          value={settingsStore.get(key, "")}
          onChange={(v) => settingsStore.set(key, v)}
          isLoading={isLoadingModels && !override?.provider}
          placeholder={t("settings.ai.sameChatModel")}
          className="min-w-[12rem]"
        />
      </div>
    </div>
  );
}
