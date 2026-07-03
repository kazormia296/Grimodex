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
import { TimelapseSettings } from "./TimelapseSettings";
import { getAllProjectSettings } from "../api";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { notifyLanguageChangedReindex } from "@/features/semantic-search/reindexActions";
import { usePhaseStore } from "@/features/codex/phaseStore";
import type { PhaseResolutionMode } from "@/features/codex/phaseResolver";
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
    try {
      const all = await getAllProjectSettings(PROJECT_ID);
      const ok = await updateProjectDefaults(all);
      // updateProjectDefaults は失敗を内部で握りつぶしてリバートするため、成功トースト
      // を無条件で出すと「保存できていないのに成功表示」になる。戻り値で分岐する。
      if (ok) toast.success(t("settings.project.saveAsDefaultsDone"));
      else toast.error(t("common.saveFailed"));
    } catch {
      toast.error(t("common.saveFailed"));
    }
  }

  if (isLoading || !project) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

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
            // 言語変更で embedding spec (model_id/dim/chunker) が変わり既存チャンクが
            // 全 stale になる。永続化後（onPersist）にハイブリッド導線を起動:
            // オートインデックスのガードを解除し、ワンクリックの再構築トーストを出す
            // （重い処理はトグル時には走らせない）。stale 表示と手動再構築は Data タブ。
            onChange={(e) =>
              updateField("language", e.target.value, () =>
                notifyLanguageChangedReindex(getCurrentProjectId()),
              )
            }
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
