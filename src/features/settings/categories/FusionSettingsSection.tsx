import { useTranslation } from "react-i18next";
import { X, AlertTriangle } from "lucide-react";
import { ModelPicker } from "@/features/chat/ModelPicker";
import type { AiModel, FusionSettings } from "@/features/chat/types";

const EMPTY: FusionSettings = {
  enabled: false,
  analysisModels: [],
  judgeModel: null,
};

/** パネルの上限 (OpenRouter Fusion は analysis_models 1〜8 件)。 */
const MAX_PANEL = 8;

const FUSION_MODEL = "openrouter/fusion";

interface FusionSettingsSectionProps {
  /** 現在の Fusion 構成 (未設定なら既定の空構成として扱う)。 */
  value: FusionSettings | undefined;
  /** 現在のアクティブモデル。openrouter/fusion 以外なら適用条件の注意を出す。 */
  activeModel?: string;
  /** OpenRouter のモデル一覧 (パネル / judge の選択肢)。 */
  models: AiModel[];
  isLoadingModels?: boolean;
  /** 構成変更時に呼ぶ (呼び出し側が persist する)。 */
  onChange: (next: FusionSettings) => void;
}

/**
 * OpenRouter Fusion (マルチモデル合議) のカスタム構成エディタ。
 * `openrouter/fusion` モデル選択時に適用されるパネル (analysis_models) と
 * judge (集約モデル) を設定する。OFF なら OpenRouter 既定パネルに委ねる。
 * 設定は AiSettings.fusion に保存され、Rust 側が plugins へ注入する。
 */
export function FusionSettingsSection({
  value,
  activeModel,
  models,
  isLoadingModels,
  onChange,
}: FusionSettingsSectionProps) {
  const { t } = useTranslation();
  const cfg = value ?? EMPTY;
  const panel = cfg.analysisModels;
  // 現在のモデルが openrouter/fusion でないと、この設定は (チャットでは) 適用されない。
  // 黙って無視されると分かりにくいので注意書きを出す (A/B 枠で fusion を選ぶ場合は適用される)。
  const inactive = (activeModel ?? "") !== FUSION_MODEL;

  // パネル / judge の編集 UI は cfg.enabled が true のときだけ描画されるので、ここに
  // 来る時点で必ず有効。万一 value prop の再レンダ遅延で cfg が EMPTY(enabled:false)に
  // 落ちても enabled を巻き戻さないよう、更新時は enabled:true を明示する。
  const addPanelModel = (id: string) => {
    if (!id || panel.includes(id) || panel.length >= MAX_PANEL) return;
    onChange({ ...cfg, enabled: true, analysisModels: [...panel, id] });
  };
  const removePanelModel = (id: string) => {
    onChange({
      ...cfg,
      enabled: true,
      analysisModels: panel.filter((m) => m !== id),
    });
  };

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={cfg.enabled}
          onChange={(e) => onChange({ ...cfg, enabled: e.target.checked })}
        />
        {t("settings.ai.fusionEnable")}
      </label>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("settings.ai.fusionIntro")}
      </p>

      {inactive && (
        <p className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {t("settings.ai.fusionNotActiveModel", {
              model: activeModel?.trim() || t("abTest.defaultModel"),
            })}
          </span>
        </p>
      )}

      {cfg.enabled && (
        <div className="mt-3 space-y-3">
          {/* パネル (analysis_models) */}
          <div>
            <div className="mb-1 text-xs font-semibold text-muted-foreground">
              {t("settings.ai.fusionPanel")}
            </div>
            {panel.length > 0 ? (
              <div className="mb-1.5 flex flex-wrap gap-1.5">
                {panel.map((id) => (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 rounded-full bg-background px-2 py-0.5 text-xs"
                  >
                    {id}
                    <button
                      type="button"
                      onClick={() => removePanelModel(id)}
                      aria-label={t("settings.ai.fusionRemovePanelModel")}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="mb-1.5 text-xs italic text-muted-foreground">
                {t("settings.ai.fusionPanelDefault")}
              </p>
            )}
            {panel.length < MAX_PANEL && (
              <ModelPicker
                models={models}
                value=""
                onChange={addPanelModel}
                isLoading={isLoadingModels}
                placeholder={t("settings.ai.fusionAddPanelModel")}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none"
              />
            )}
          </div>

          {/* judge (集約モデル) */}
          <div>
            <div className="mb-1 text-xs font-semibold text-muted-foreground">
              {t("settings.ai.fusionJudge")}
            </div>
            <ModelPicker
              models={models}
              value={cfg.judgeModel ?? ""}
              onChange={(id) =>
                onChange({ ...cfg, enabled: true, judgeModel: id || null })
              }
              isLoading={isLoadingModels}
              placeholder={t("settings.ai.fusionJudgeDefault")}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none"
            />
          </div>

          <div className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500">
            <AlertTriangle
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden
            />
            <span>{t("settings.ai.fusionCostWarning")}</span>
          </div>
        </div>
      )}
    </div>
  );
}
