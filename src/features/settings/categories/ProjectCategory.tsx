import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useProjectSettings } from "../hooks/useProjectSettings";
import {
  useSettingControl,
  useSettingBoolean,
  useSettingNumber,
} from "../useSettingControl";
import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { SettingTextarea } from "../components/SettingTextarea";
import { TimelapseSettings } from "./TimelapseSettings";
import { getAllProjectSettings } from "../api";
import { usePhaseStore } from "@/features/codex/phaseStore";
import type { PhaseResolutionMode } from "@/features/codex/phaseResolver";
import { parseAiPolicy, serializeAiPolicy } from "@/features/ai-policy/parse";
import { expandPreset, inferPreset } from "@/features/ai-policy/preset";
import type { AiFeature, AiPolicyPreset } from "@/features/ai-policy/types";
import { useWorkspaceStore } from "@/features/workspace/store";
import { PROJECT_ID } from "@/features/project/constants";
import { GENRE_VALUES } from "@/features/project/genreOptions";

const LANGUAGE_OPTIONS = [
  { value: "ja", label: "日本語" },
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
  { value: "ko", label: "한국어" },
];

export function ProjectCategory() {
  const { t } = useTranslation();
  const { project, isLoading, updateField } = useProjectSettings();
  const folderNaming = useSettingControl("tree.folderNaming", "auto");
  const sceneNaming = useSettingControl(
    "tree.sceneNaming",
    t("tree.defaultScene"),
  );
  const noteNaming = useSettingControl(
    "tree.noteNaming",
    t("tree.defaultNote"),
  );
  const numberingScope = useSettingControl("tree.numberingScope", "project");
  const autoAcceptBody = useSettingBoolean("ai.autoAcceptBodyProposals", false);
  const trashBinEnabled = useSettingBoolean("trashBin.enabled", true);
  const trashBinRetention = useSettingNumber("trashBin.retentionDays", 60);

  const TRASH_RETENTION_OPTIONS = [
    { value: "7", label: t("settings.project.trashRetention7", "7 日") },
    { value: "30", label: t("settings.project.trashRetention30", "30 日") },
    { value: "60", label: t("settings.project.trashRetention60", "60 日") },
    { value: "90", label: t("settings.project.trashRetention90", "90 日") },
    {
      value: "-1",
      label: t("settings.project.trashRetentionUnlimited", "無期限"),
    },
  ];

  const GENRE_OPTIONS = [
    { value: "", label: t("settings.project.unselected") },
    ...GENRE_VALUES.map((value) => ({ value, label: value })),
  ];

  const POV_OPTIONS = [
    { value: "", label: t("settings.project.unselected") },
    { value: "First person", label: t("settings.project.firstPerson") },
    {
      value: "Third person limited",
      label: t("settings.project.thirdLimited"),
    },
    {
      value: "Third person omniscient",
      label: t("settings.project.thirdOmniscient"),
    },
    { value: "Second person", label: t("settings.project.secondPerson") },
  ];

  const TENSE_OPTIONS = [
    { value: "", label: t("settings.project.unselected") },
    { value: "Past tense", label: t("settings.project.pastTense") },
    { value: "Present tense", label: t("settings.project.presentTense") },
  ];

  const PHASE_RESOLUTION_OPTIONS = [
    { value: "reading", label: t("settings.project.phaseResolutionReading") },
    { value: "story", label: t("settings.project.phaseResolutionStory") },
    { value: "auto", label: t("settings.project.phaseResolutionAuto") },
  ];

  const FOLDER_NAMING_OPTIONS = [
    { value: "auto", label: t("settings.project.folderNamingAuto") },
    { value: "none", label: t("settings.project.folderNamingNone") },
  ];

  const NUMBERING_SCOPE_OPTIONS = [
    { value: "project", label: t("settings.project.numberingScopeProject") },
    { value: "folder", label: t("settings.project.numberingScopeFolder") },
  ];

  const updateProjectDefaults = useWorkspaceStore(
    (s) => s.updateProjectDefaults,
  );

  async function handleSaveAsDefaults() {
    const all = await getAllProjectSettings(PROJECT_ID);
    await updateProjectDefaults(all);
    toast.success(t("settings.project.saveAsDefaultsDone"));
  }

  if (isLoading || !project) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  const currentPolicy = parseAiPolicy(project.aiPolicy);

  const handlePresetChange = (preset: AiPolicyPreset) => {
    if (preset === "custom") return;
    const toggles = expandPreset(preset);
    updateField("aiPolicy", serializeAiPolicy({ preset, toggles }));
  };

  const handleToggleChange = (feature: AiFeature, checked: boolean) => {
    const newToggles = { ...currentPolicy.toggles, [feature]: checked };
    const newPreset = inferPreset(newToggles);
    updateField(
      "aiPolicy",
      serializeAiPolicy({ preset: newPreset, toggles: newToggles }),
    );
  };

  return (
    <div className="p-6">
      <SettingSection title={t("settings.project.basic")}>
        <SettingRow label={t("settings.project.title")}>
          <input
            type="text"
            value={project.title}
            onChange={(e) => updateField("title", e.target.value)}
            className="w-48 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          />
        </SettingRow>
        <SettingRow label={t("settings.project.genre")}>
          <select
            value={project.genre ?? ""}
            onChange={(e) => updateField("genre", e.target.value || null)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {GENRE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label={t("settings.project.pov")}>
          <select
            value={project.pov ?? ""}
            onChange={(e) => updateField("pov", e.target.value || null)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {POV_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label={t("settings.project.tense")}>
          <select
            value={project.tense ?? ""}
            onChange={(e) => updateField("tense", e.target.value || null)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {TENSE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label={t("settings.project.language")}>
          <select
            value={project.language}
            onChange={(e) => updateField("language", e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {LANGUAGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow
          label={t("settings.project.phaseResolutionMode")}
          description={t("settings.project.phaseResolutionModeDesc")}
        >
          <select
            value={project.phaseResolutionMode}
            onChange={(e) => {
              const mode = e.target.value as PhaseResolutionMode;
              updateField("phaseResolutionMode", mode);
              usePhaseStore.getState().setResolutionMode(mode);
            }}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {PHASE_RESOLUTION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.project.namingRules")}>
        <SettingRow label={t("settings.project.folderNaming")}>
          <select
            value={folderNaming.value}
            onChange={(e) => folderNaming.setValue(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {FOLDER_NAMING_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow
          label={t("settings.project.sceneNamingPrefix")}
          description={
            sceneNaming.value
              ? t("settings.project.sceneNamingPrefixDesc", {
                  prefix: sceneNaming.value,
                })
              : t("settings.project.sceneNamingPrefixDescNone")
          }
        >
          <input
            type="text"
            value={sceneNaming.value}
            onChange={(e) => sceneNaming.setValue(e.target.value)}
            placeholder={t("settings.project.sceneNamingPlaceholder")}
            className="w-32 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          />
        </SettingRow>
        <SettingRow label={t("settings.project.noteNamingPrefix")}>
          <input
            type="text"
            value={noteNaming.value}
            onChange={(e) => noteNaming.setValue(e.target.value)}
            placeholder={t("settings.project.noteNamingPlaceholder")}
            className="w-32 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          />
        </SettingRow>
        <SettingRow label={t("settings.project.numberingScope")}>
          <select
            value={numberingScope.value}
            onChange={(e) => numberingScope.setValue(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            {NUMBERING_SCOPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.project.trashBin", "ゴミ箱")}>
        <SettingRow
          label={t("trashBin.enableLabel", "ゴミ箱を有効化")}
          description={t(
            "settings.project.trashBinDesc",
            "削除した文字片や構造アイテムをゴミ箱に保持します。",
          )}
        >
          <input
            type="checkbox"
            checked={trashBinEnabled.value}
            onChange={(e) => trashBinEnabled.setValue(e.target.checked)}
            className="h-4 w-4 cursor-pointer rounded border-input"
          />
        </SettingRow>
        <SettingRow
          label={t("settings.project.trashRetention", "保持期間")}
          description={t(
            "settings.project.trashRetentionDesc",
            "保持期間を超えた屑は次回の起動 / 1 時間ごとの掃除で削除されます。",
          )}
        >
          <select
            value={String(trashBinRetention.value)}
            onChange={(e) => trashBinRetention.setValue(Number(e.target.value))}
            disabled={!trashBinEnabled.value}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none disabled:opacity-50"
          >
            {TRASH_RETENTION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingSection>

      <TimelapseSettings />

      <SettingSection title={t("settings.project.aiPolicy", "AI使用ポリシー")}>
        <SettingRow
          label={t("settings.project.aiPolicyPreset", "プリセット")}
          description={t(
            "settings.project.aiPolicyPresetDesc",
            "AI機能の使用範囲を一括設定します。個別トグルを変更するとカスタムになります。",
          )}
        >
          <select
            value={currentPolicy.preset}
            onChange={(e) =>
              handlePresetChange(e.target.value as AiPolicyPreset)
            }
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
          >
            <option value="full">
              {t("settings.project.aiPolicyFull", "Full — すべて有効")}
            </option>
            <option value="assist-off">
              {t(
                "settings.project.aiPolicyAssistOff",
                "Assist-off — 本文書き込みを除外",
              )}
            </option>
            <option value="review-only">
              {t(
                "settings.project.aiPolicyReviewOnly",
                "Review-only — 分析のみ",
              )}
            </option>
            <option value="off">
              {t("settings.project.aiPolicyOff", "Off — すべて無効")}
            </option>
            <option value="custom" disabled>
              {t("settings.project.aiPolicyCustom", "カスタム")}
            </option>
          </select>
        </SettingRow>
        <SettingRow
          label={t("settings.project.aiPolicyChat", "チャット")}
          description={t(
            "settings.project.aiPolicyChatDesc",
            "チャットパネル・Agent・CLI 連携",
          )}
        >
          <input
            type="checkbox"
            checked={currentPolicy.toggles.chat}
            onChange={(e) => handleToggleChange("chat", e.target.checked)}
            className="h-4 w-4 cursor-pointer rounded border-input"
          />
        </SettingRow>
        <SettingRow
          label={t("settings.project.aiPolicyBodyWrite", "本文書き込み")}
          description={t(
            "settings.project.aiPolicyBodyWriteDesc",
            "インライン AI・Beat 生成",
          )}
        >
          <input
            type="checkbox"
            checked={currentPolicy.toggles.bodyWrite}
            onChange={(e) => handleToggleChange("bodyWrite", e.target.checked)}
            className="h-4 w-4 cursor-pointer rounded border-input"
          />
        </SettingRow>
        <SettingRow
          label={t("settings.project.aiPolicyAnalysis", "分析")}
          description={t(
            "settings.project.aiPolicyAnalysisDesc",
            "整合性チェック・伏線 AI",
          )}
        >
          <input
            type="checkbox"
            checked={currentPolicy.toggles.analysis}
            onChange={(e) => handleToggleChange("analysis", e.target.checked)}
            className="h-4 w-4 cursor-pointer rounded border-input"
          />
        </SettingRow>
        <SettingRow
          label={t("settings.project.aiPolicyStructureWrite", "構成編集")}
          description={t(
            "settings.project.aiPolicyStructureWriteDesc",
            "AI による章/シーン構成の生成・再編",
          )}
        >
          <input
            type="checkbox"
            checked={currentPolicy.toggles.structureWrite}
            onChange={(e) =>
              handleToggleChange("structureWrite", e.target.checked)
            }
            className="h-4 w-4 cursor-pointer rounded border-input"
          />
        </SettingRow>
        <SettingRow
          label={t(
            "settings.project.aiAutoAcceptBody",
            "本文提案の自動適用（ヘッドレス）",
          )}
          description={t(
            "settings.project.aiAutoAcceptBodyDesc",
            "MCP/エージェントの本文提案を人間の承認なしで自動適用する（append のみ）。本文書き込みポリシーが ON のときのみ有効。",
          )}
        >
          <input
            type="checkbox"
            checked={autoAcceptBody.value}
            disabled={!currentPolicy.toggles.bodyWrite}
            onChange={(e) => autoAcceptBody.setValue(e.target.checked)}
            className="h-4 w-4 cursor-pointer rounded border-input disabled:cursor-not-allowed disabled:opacity-50"
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.project.aiSettings")}>
        <div className="mb-4">
          <div className="mb-1 text-sm text-foreground">
            {t("settings.project.outline")}
          </div>
          <div className="text-xs text-muted-foreground mb-2">
            {t("settings.project.outlineDesc")}
          </div>
          <SettingTextarea
            value={project.outline ?? ""}
            onChange={(v) => updateField("outline", v || null)}
            placeholder={t("settings.project.outlinePlaceholder")}
            maxLength={8000}
            rows={8}
          />
        </div>
        <div className="mb-4">
          <div className="mb-1 text-sm text-foreground">
            {t("settings.project.targetReaders")}
          </div>
          <div className="text-xs text-muted-foreground mb-2">
            {t("settings.project.targetReadersDesc")}
          </div>
          <SettingTextarea
            value={project.targetReaders ?? ""}
            onChange={(v) => updateField("targetReaders", v || null)}
            placeholder={t("settings.project.targetReadersPlaceholder")}
            maxLength={2000}
            rows={4}
          />
        </div>
        <div className="mb-4">
          <div className="mb-1 text-sm text-foreground">
            {t("settings.project.styleGuide")}
          </div>
          <div className="text-xs text-muted-foreground mb-2">
            {t("settings.project.styleGuideDesc")}
          </div>
          <SettingTextarea
            value={project.styleGuide ?? ""}
            onChange={(v) => updateField("styleGuide", v || null)}
            placeholder={t("settings.project.styleGuidePlaceholder")}
            maxLength={2000}
            rows={4}
          />
        </div>
        <div>
          <div className="mb-1 text-sm text-foreground">
            {t("settings.project.aiInstructions")}
          </div>
          <div className="text-xs text-muted-foreground mb-2">
            {t("settings.project.aiInstructionsDesc")}
          </div>
          <SettingTextarea
            value={project.aiInstructions ?? ""}
            onChange={(v) => updateField("aiInstructions", v || null)}
            placeholder={t("settings.project.aiInstructionsPlaceholder")}
            maxLength={4000}
            rows={5}
          />
        </div>
      </SettingSection>

      <SettingSection title={t("settings.project.defaults", "デフォルト雛形")}>
        <SettingRow
          label={t(
            "settings.project.saveAsDefaults",
            "現在の設定をデフォルト雛形として保存",
          )}
          description={t(
            "settings.project.saveAsDefaultsDesc",
            "ツリー・エクスポート・AI 予算等の作品設定を、今後新規作成するプロジェクトの初期値として保存します。",
          )}
        >
          <button
            type="button"
            onClick={handleSaveAsDefaults}
            className="rounded-md border border-border px-3 py-1 text-sm hover:bg-accent"
          >
            {t("settings.project.saveAsDefaultsButton", "保存")}
          </button>
        </SettingRow>
      </SettingSection>
    </div>
  );
}
