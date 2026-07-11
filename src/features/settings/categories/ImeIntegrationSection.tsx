import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { ControlledToggle } from "../components/SettingToggle";
import { useSettingBoolean, useSettingControl } from "../useSettingControl";
import { useSettingsStore } from "../settingsStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import {
  clearImeExports,
  getImeExportStatus,
  refreshImeExport,
  setActiveImeProject,
  type ImeExportStatus,
  type ImeIntegrationMode,
} from "@/features/ime/api";
import { ImeConsumerList } from "./ImeConsumerList";

export function ImeIntegrationSection() {
  const { t } = useTranslation();
  const mode = useSettingControl("ime.integrationMode", "auto");
  const excludeHidden = useSettingBoolean("ime.excludeHidden", false);
  const includeProfile = useSettingBoolean("ime.includeProfile", true);
  const [status, setStatus] = useState<ImeExportStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadStatus = useCallback(async () => {
    try {
      setStatus(await getImeExportStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void reloadStatus();
  }, [reloadStatus]);

  const applySettingChange = async (
    nextMode?: ImeIntegrationMode,
    clearExistingSnapshots = false,
  ) => {
    setBusy(true);
    try {
      // Native re-resolves these global preferences from disk, so persist
      // before exporting and prevent stale secondary windows from weakening a
      // newer `off` or privacy choice.
      await useSettingsStore.getState().flushPending();
      const effectiveMode = nextMode ?? mode.value;
      if (effectiveMode === "off") {
        await clearImeExports();
        await setActiveImeProject(null);
      } else {
        const projectId = getCurrentProjectId();
        // Privacy options are global. Snapshots for projects other than the
        // one currently open cannot be rebuilt from this renderer, so remove
        // every old plaintext snapshot before regenerating the active one.
        if (clearExistingSnapshots) await clearImeExports();
        await refreshImeExport(projectId);
        await setActiveImeProject(projectId);
      }
      await reloadStatus();
    } catch {
      // updateUserPreference rolls back its optimistic global update on write
      // failure. Rehydrate the effective cache so the UI does not claim a
      // privacy setting that will disappear after restart.
      await useSettingsStore
        .getState()
        .loadAll()
        .catch(() => {});
      await reloadStatus();
      toast.error(t("settings.codex.imeSyncFailed"));
    } finally {
      setBusy(false);
    }
  };

  const changeMode = (value: string) => {
    const next: ImeIntegrationMode =
      value === "on" || value === "off" ? value : "auto";
    mode.setValue(next);
    void applySettingChange(next);
  };

  const clearAll = async () => {
    setBusy(true);
    try {
      await clearImeExports();
      await reloadStatus();
      toast.success(t("settings.codex.imeClearDone"));
    } catch {
      toast.error(t("settings.codex.imeClearFailed"));
    } finally {
      setBusy(false);
    }
  };

  const privacyDisabled = mode.value === "off" || busy;

  return (
    <SettingSection title={t("settings.codex.imeTitle")}>
      <p className="mb-2 text-xs text-muted-foreground">
        {t("settings.codex.imeDescription")}
      </p>
      <SettingRow
        label={t("settings.codex.imeMode")}
        description={t("settings.codex.imeModeDesc")}
      >
        <select
          value={mode.value}
          disabled={busy}
          onChange={(event) => changeMode(event.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
        >
          <option value="auto">{t("settings.codex.imeModeAuto")}</option>
          <option value="on">{t("settings.codex.imeModeOn")}</option>
          <option value="off">{t("settings.codex.imeModeOff")}</option>
        </select>
      </SettingRow>
      <SettingRow
        label={t("settings.codex.imeExcludeHidden")}
        description={t("settings.codex.imeExcludeHiddenDesc")}
        disabled={mode.value === "off"}
      >
        <ControlledToggle
          value={excludeHidden.value}
          disabled={privacyDisabled}
          onChange={(value) => {
            excludeHidden.setValue(value);
            void applySettingChange(undefined, true);
          }}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.codex.imeIncludeProfile")}
        description={t("settings.codex.imeIncludeProfileDesc")}
        disabled={mode.value === "off"}
      >
        <ControlledToggle
          value={includeProfile.value}
          disabled={privacyDisabled}
          onChange={(value) => {
            includeProfile.setValue(value);
            void applySettingChange(undefined, true);
          }}
        />
      </SettingRow>

      <div className="mt-3 rounded-md border border-border bg-muted/20 p-3 text-xs">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${
              status?.effectiveEnabled
                ? "bg-emerald-500"
                : "bg-muted-foreground/40"
            }`}
          />
          <span className="font-medium">
            {status?.effectiveEnabled
              ? t("settings.codex.imeEnabled")
              : t("settings.codex.imeDisabled")}
          </span>
          {status && (
            <span className="ml-auto text-muted-foreground">
              {t("settings.codex.imeConsumerCount", {
                count: status.consumers.length,
              })}
            </span>
          )}
        </div>
        {status?.rootPath && (
          <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
            {status.rootPath}
          </p>
        )}
        {status && status.consumers.length > 0 && (
          <ImeConsumerList consumers={status.consumers} />
        )}
      </div>

      <button
        type="button"
        onClick={() => void clearAll()}
        disabled={busy || (status?.exportedProjectCount ?? 0) === 0}
        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Trash2 className="h-3 w-3" />
        {t("settings.codex.imeClear")}
      </button>
    </SettingSection>
  );
}
