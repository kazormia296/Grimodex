import { useMemo } from "react";
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
import type { AiModel, AiProvider } from "@/features/chat/types";
import type { CatalogSection } from "@/features/chat/chatModelCatalog";
import { useSettingsStore } from "../settingsStore";

interface RoleModelRowProps {
  role: ModelRole;
  /** アクティブプロバイダの whitelist 済みモデル（「チャットと同じ」選択時に使う）。 */
  activeModels: AiModel[];
  /** プロバイダ横断カタログ（鍵が設定済みのプロバイダ/エンドポイントのみ）。 */
  sections: CatalogSection[];
  isLoadingModels: boolean;
  /** 横断カタログ（sections）の読み込み中フラグ。読み込み中と「失効」を区別する。 */
  catalogLoading: boolean;
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
 *
 * 失効（stale）対応: 横断 override が指すプロバイダ/エンドポイントがカタログから
 * 消えた（鍵削除・エンドポイント削除）場合、active プロバイダのモデルへ流用すると
 * 別 namespace のモデルを foreign override 下で永続化＝誤送信を招く。ロード後に
 * セクションが無ければ「利用不可」を明示し、モデル一覧は空にして、リセット導線を出す。
 */
export function RoleModelRow({
  role,
  activeModels,
  sections,
  isLoadingModels,
  catalogLoading,
}: RoleModelRowProps) {
  const { t } = useTranslation();
  const key = roleSettingKey(role);
  // 必要キーのみのセレクタ購読: 無関係な設定 set で全ロール行が再描画されるのを防ぐ。
  const roleProvidersRaw = useSettingsStore(
    (s) => s.get(ROLE_PROVIDERS_KEY) || "",
  );
  const modelValue = useSettingsStore((s) => s.get(key, ""));
  const setSetting = useSettingsStore((s) => s.set);

  const map = useMemo(
    () => parseRoleProviders(roleProvidersRaw),
    [roleProvidersRaw],
  );
  const override = map[role];
  const overrideProvider = override?.provider;
  const selected = overrideProvider
    ? sectionValue(overrideProvider, override?.endpointId)
    : SAME;

  // 横断割り当て時は選択プロバイダ/エンドポイントのモデル一覧、未指定なら active。
  const section = overrideProvider
    ? sections.find(
        (s) =>
          s.provider === overrideProvider &&
          (s.endpointId ?? "") === (override?.endpointId ?? ""),
      )
    : null;
  // override が指すセクションがカタログに無い = 鍵削除/エンドポイント削除。
  // ただしカタログ読み込み中は判定保留（false positive 防止）。
  const overrideUnavailable = !!overrideProvider && !section && !catalogLoading;
  // 失効時は active プロバイダのモデルへ流用しない（誤送信防止）。
  const sourceModels: AiModel[] = section
    ? section.models
    : overrideProvider
      ? []
      : activeModels;
  const roleModels = sourceModels.filter((m) =>
    isModelCapableForRole(m.id, role),
  );

  // 保存済みモデルが現在の一覧に無い（プロバイダ切替前の遺物・一覧からの消滅など）。
  // controlled <select> は不一致 value を空選択に化けさせ、stale 値が見えないまま
  // 送信だけ壊れるため、合成 option で実際の保存値を可視化しリセット導線を出す。
  // 一覧が空のとき（読み込み失敗等）は判定できないので警告しない。
  const modelListReady = overrideProvider ? !catalogLoading : !isLoadingModels;
  const staleModel =
    modelValue !== "" &&
    modelListReady &&
    roleModels.length > 0 &&
    !roleModels.some((m) => m.id === modelValue);
  const pickerModels = staleModel
    ? [
        ...roleModels,
        {
          id: modelValue,
          name: t("settings.ai.roleModel.staleModelOption", {
            model: modelValue,
            defaultValue: "{{model}}（一覧に無し）",
          }),
        },
      ]
    : roleModels;

  const handleProviderChange = (value: string): void => {
    const next = { ...map };
    if (value === SAME) {
      delete next[role];
    } else {
      const [provider, endpointId] = value.split("|");
      next[role] = endpointId ? { provider, endpointId } : { provider };
    }
    setSetting(ROLE_PROVIDERS_KEY, JSON.stringify(next));
    // プロバイダを変えるとモデル ID の名前空間が変わるため、誤送信防止にモデルを
    // クリアする（ユーザーが新プロバイダのモデルを選び直す）。
    setSetting(key, "");
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
          {/* 失効した override は options に無いため、選択状態が「同じプロバイダ」へ
              無言で化けて見える（controlled select の desync）。合成 option を足して
              実際の保存値を「利用不可」として可視化する。 */}
          {overrideUnavailable && (
            <option value={selected}>
              {t("settings.ai.roleModel.unavailableOption", {
                provider: getProviderLabel(overrideProvider as AiProvider, t),
                defaultValue: "{{provider}}（利用不可）",
              })}
            </option>
          )}
        </select>
        <ModelPicker
          models={pickerModels}
          value={modelValue}
          onChange={(v) => setSetting(key, v)}
          isLoading={overrideProvider ? catalogLoading : isLoadingModels}
          placeholder={t("settings.ai.sameChatModel")}
          className="min-w-[12rem]"
        />
      </div>
      {staleModel && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
          <span>
            {t("settings.ai.roleModel.staleModel", {
              model: modelValue,
              defaultValue:
                "保存済みモデル {{model}} は現在のプロバイダのモデル一覧にありません（プロバイダ切替前の値など）。このままでは送信に失敗する可能性があります。",
            })}
          </span>
          <button
            type="button"
            onClick={() => setSetting(key, "")}
            className="rounded border border-amber-600/40 px-1.5 py-0.5 hover:bg-amber-600/10"
          >
            {t("settings.ai.roleModel.reset", "リセット")}
          </button>
        </div>
      )}
      {overrideUnavailable && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
          <span>
            {t(
              "settings.ai.roleModel.unavailableProvider",
              "選択中のプロバイダ/エンドポイントは利用できません（鍵削除・エンドポイント削除など）。送信は失敗するか別の宛先になります。",
            )}
          </span>
          <button
            type="button"
            onClick={() => handleProviderChange(SAME)}
            className="rounded border border-amber-600/40 px-1.5 py-0.5 hover:bg-amber-600/10"
          >
            {t("settings.ai.roleModel.reset", "リセット")}
          </button>
        </div>
      )}
    </div>
  );
}
