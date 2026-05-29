import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useCurrentProjectId } from "@/features/project/projectStore";
import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { ControlledToggle } from "../components/SettingToggle";
import { useConfirmDialog } from "@/features/trash-bin/ConfirmDialog";
import {
  isTimelapseEnabled,
  setTimelapseEnabled,
  purgeTimelapseHistory,
  countTimelapseEvents,
} from "@/features/timelapse/toggle";

/**
 * 執筆タイムラプスの per-project 記録トグル + 履歴パージ (§15.3 / §15.10)。
 *
 * 固定 PROJECT_ID の settings store は使わず、currentProjectId で直接読み書き
 * する (recorder が currentProjectId で change_events を書くため整合させる)。
 * トグルは必ずオーケストレーター setTimelapseEnabled を唯一の writer として
 * 経由する (auto-persist する SettingToggle は wipe/baseline をスキップする)。
 */
export function TimelapseSettings() {
  const { t } = useTranslation();
  const projectId = useCurrentProjectId();
  const { confirm, dialog } = useConfirmDialog();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void isTimelapseEnabled(projectId).then((v) => {
      if (!cancelled) setEnabled(v);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      if (busy) return;
      // OFF -> ON wipes the existing (now-gapped) history; warn only if there
      // is something to discard.
      if (next) {
        const count = await countTimelapseEvents(projectId);
        if (count > 0) {
          const ok = await confirm({
            title: t("settings.project.timelapseReenableTitle"),
            description: t("settings.project.timelapseReenableBody", { count }),
            confirmLabel: t("settings.project.timelapseReenableConfirm"),
          });
          if (!ok) return;
        }
      }
      setBusy(true);
      setEnabled(next); // optimistic
      try {
        await setTimelapseEnabled(projectId, next);
        toast.success(
          next
            ? t("settings.project.timelapseEnabledToast")
            : t("settings.project.timelapseDisabledToast"),
        );
      } catch {
        setEnabled(!next); // revert
        toast.error(t("settings.project.timelapseToggleFailed"));
      } finally {
        setBusy(false);
      }
    },
    [busy, confirm, projectId, t],
  );

  const handlePurge = useCallback(async () => {
    if (busy) return;
    const count = await countTimelapseEvents(projectId);
    const ok = await confirm({
      title: t("settings.project.timelapsePurgeTitle"),
      description: t("settings.project.timelapsePurgeBody", { count }),
      confirmLabel: t("settings.project.timelapsePurgeConfirm"),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await purgeTimelapseHistory(projectId);
      toast.success(t("settings.project.timelapsePurgeDone"));
    } catch {
      toast.error(t("settings.project.timelapsePurgeFailed"));
    } finally {
      setBusy(false);
    }
  }, [busy, confirm, projectId, t]);

  return (
    <SettingSection title={t("settings.project.timelapseSection")}>
      <SettingRow
        label={t("settings.project.timelapseEnabledLabel")}
        description={t("settings.project.timelapseEnabledDesc")}
      >
        <ControlledToggle
          value={enabled ?? false}
          onChange={(v) => void handleToggle(v)}
          disabled={enabled === null || busy}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.project.timelapsePurgeLabel")}
        description={t("settings.project.timelapsePurgeDesc")}
      >
        <button
          type="button"
          data-testid="timelapse-purge-button"
          onClick={() => void handlePurge()}
          disabled={busy}
          className="rounded-md border border-input px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
        >
          {t("settings.project.timelapsePurgeButton")}
        </button>
      </SettingRow>
      {dialog}
    </SettingSection>
  );
}
