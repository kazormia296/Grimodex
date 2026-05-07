import { useTranslation } from "react-i18next";
import { useProjectSettings } from "../hooks/useProjectSettings";
import { useSettingControl, useSettingBoolean } from "../useSettingControl";
import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { SettingTextarea } from "../components/SettingTextarea";
import { usePhaseStore } from "@/features/codex/phaseStore";
import type { PhaseResolutionMode } from "@/features/codex/phaseResolver";

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

  const GENRE_OPTIONS = [
    { value: "", label: t("settings.project.unselected") },
    { value: "Fantasy", label: "Fantasy" },
    { value: "Sci-Fi", label: "Sci-Fi" },
    { value: "Mystery", label: "Mystery" },
    { value: "Horror", label: "Horror" },
    { value: "Romance", label: "Romance" },
    { value: "Thriller", label: "Thriller" },
    { value: "Literary", label: "Literary" },
    { value: "Historical", label: "Historical" },
    { value: "Other", label: "Other" },
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
            "削除した文字片や構造アイテムをゴミ箱に保持します (60 日)。",
          )}
        >
          <input
            type="checkbox"
            checked={trashBinEnabled.value}
            onChange={(e) => trashBinEnabled.setValue(e.target.checked)}
            className="h-4 w-4 cursor-pointer rounded border-input"
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.project.aiSettings")}>
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
    </div>
  );
}
