import { useState, useEffect } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { invoke } from "@/lib/tauri";
import { useWorkspaceStore } from "@/features/workspace/store";
import { db } from "@/db/client";
import { treeNodes, chatSessions, chatMessages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { SettingToggle } from "../components/SettingToggle";
import { SettingSlider } from "../components/SettingSlider";
import { exportCodexJson } from "../exportUtils";
import { IntegrityCheckSection } from "@/features/workspace/IntegrityCheckDialog";
import { MountListDialog } from "@/features/external-mount/components/MountListDialog";
import {
  enqueueRescan,
  useRescanStore,
} from "@/features/codex/mentionRescanQueue";
import { getCurrentProjectId } from "@/features/project/projectStore";

interface ProjectStats {
  sceneCount: number;
  totalChars: number;
}

async function getProjectStats(): Promise<ProjectStats> {
  const scenes = await db
    .select({ content: treeNodes.content })
    .from(treeNodes)
    .where(eq(treeNodes.projectId, getCurrentProjectId()));

  const sceneCount = scenes.filter(
    (n) =>
      // count only actual scenes (content nodes)
      n.content && n.content !== "{}",
  ).length;

  const totalChars = scenes.reduce((sum, n) => {
    try {
      const doc = JSON.parse(n.content);
      return sum + extractCharCount(doc);
    } catch {
      return sum;
    }
  }, 0);

  return { sceneCount, totalChars };
}

function extractCharCount(node: {
  text?: string;
  content?: unknown[];
}): number {
  if (node.text) return node.text.length;
  if (!node.content) return 0;
  return node.content.reduce(
    (s: number, c) => s + extractCharCount(c as typeof node),
    0,
  );
}

async function triggerDownload(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function DataCategory() {
  const { t } = useTranslation();
  const workspacePath = useWorkspaceStore((s) => s.activeWorkspacePath);
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [isExportingCodex, setIsExportingCodex] = useState(false);
  // FTS 再構築 / VACUUM / チャット履歴削除 の実行中フラグ。連打で重い操作を多重発火
  // させないため、ボタンを disabled にし、ハンドラ先頭でも早期 return する。
  const [isRebuildingFts, setIsRebuildingFts] = useState(false);
  const [isVacuuming, setIsVacuuming] = useState(false);
  const [isClearingChat, setIsClearingChat] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [mountDialogOpen, setMountDialogOpen] = useState(false);
  const rescanRunning = useRescanStore((s) => s.isRunning);
  const rescanProgress = useRescanStore((s) => s.progress);
  const rescanTotal = useRescanStore((s) => s.total);

  function handleRebuildMentionCache() {
    enqueueRescan(null);
  }

  useEffect(() => {
    getProjectStats()
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  async function handleExportCodex() {
    setIsExportingCodex(true);
    try {
      const json = await exportCodexJson();
      await triggerDownload("codex.json", json);
      toast.success(t("settings.data.exportSuccess"));
    } catch {
      toast.error(t("settings.data.exportFail"));
    } finally {
      setIsExportingCodex(false);
    }
  }

  function openExportDialog() {
    window.dispatchEvent(new CustomEvent("open-export-dialog"));
  }

  async function handleRebuildFts() {
    if (isRebuildingFts) return;
    setIsRebuildingFts(true);
    try {
      await invoke("fts_rebuild");
      toast.success(t("settings.data.ftsSuccess"));
    } catch {
      toast.error(t("settings.data.ftsFail"));
    } finally {
      setIsRebuildingFts(false);
    }
  }

  async function handleVacuum() {
    if (isVacuuming) return;
    setIsVacuuming(true);
    try {
      await db.run("VACUUM" as never);
      toast.success(t("settings.data.vacuumSuccess"));
    } catch {
      toast.error(t("settings.data.vacuumFail"));
    } finally {
      setIsVacuuming(false);
    }
  }

  async function handleClearChatHistory() {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 5000);
      return;
    }
    if (isClearingChat) return;
    setIsClearingChat(true);
    try {
      const sessions = await db
        .select({ id: chatSessions.id })
        .from(chatSessions)
        .where(eq(chatSessions.projectId, getCurrentProjectId()));
      for (const s of sessions) {
        await db.delete(chatMessages).where(eq(chatMessages.sessionId, s.id));
      }
      await db
        .delete(chatSessions)
        .where(eq(chatSessions.projectId, getCurrentProjectId()));
      toast.success(t("settings.data.clearChatSuccess"));
      setConfirmClear(false);
    } catch {
      toast.error(t("settings.data.clearChatFail"));
    } finally {
      setIsClearingChat(false);
    }
  }

  return (
    <div className="p-6">
      {/* Project Info */}
      <SettingSection title={t("settings.data.projectInfo")}>
        <SettingRow label={t("settings.data.savePath")}>
          <span className="max-w-[200px] truncate text-xs text-muted-foreground">
            {workspacePath ?? "—"}
          </span>
        </SettingRow>
        <SettingRow label={t("settings.data.sceneCount")}>
          <span className="text-sm">{stats?.sceneCount ?? "…"}</span>
        </SettingRow>
        <SettingRow label={t("settings.data.totalChars")}>
          <span className="text-sm">
            {stats ? stats.totalChars.toLocaleString() : "…"}
          </span>
        </SettingRow>
      </SettingSection>

      {/* Backup */}
      <SettingSection title={t("settings.data.backup")}>
        <SettingRow label={t("settings.data.autoBackup")}>
          <SettingToggle settingKey="data.autoBackup" defaultValue={true} />
        </SettingRow>
        <SettingRow label={t("settings.data.backupInterval")}>
          <SettingSlider
            settingKey="data.backupInterval"
            min={15}
            max={360}
            step={15}
            defaultValue={60}
            format={(v) => t("settings.data.backupIntervalFormat", { v })}
          />
        </SettingRow>
        <SettingRow label={t("settings.data.maxBackups")}>
          <SettingSlider
            settingKey="data.maxBackups"
            min={1}
            max={50}
            step={1}
            defaultValue={10}
            format={(v) => t("settings.data.maxBackupsFormat", { v })}
          />
        </SettingRow>
      </SettingSection>

      {/* Revision History */}
      <SettingSection title={t("settings.data.revision")}>
        <SettingRow label={t("settings.data.revisionInterval")}>
          <SettingSlider
            settingKey="revision.autoInterval"
            min={1}
            max={60}
            step={1}
            defaultValue={5}
            format={(v) => t("settings.data.revisionIntervalFormat", { v })}
          />
        </SettingRow>
        <SettingRow label={t("settings.data.revisionKeep")}>
          <SettingSlider
            settingKey="revision.keepCount"
            min={10}
            max={200}
            step={10}
            defaultValue={50}
            format={(v) => t("settings.data.revisionKeepFormat", { v })}
          />
        </SettingRow>
      </SettingSection>

      {/* Export */}
      <SettingSection title={t("settings.data.export")}>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm">{t("settings.data.exportScenes")}</span>
            <button
              type="button"
              onClick={openExportDialog}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
            >
              {t("common.open")}
            </button>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">{t("settings.data.exportCodex")}</span>
            <button
              type="button"
              onClick={handleExportCodex}
              disabled={isExportingCodex}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
            >
              Codex JSON
            </button>
          </div>
        </div>
      </SettingSection>

      {/* Data Management */}
      <SettingSection title={t("settings.data.management")}>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm">
                {t("settings.data.rebuildMentionCache")}
              </span>
              {rescanRunning && (
                <p className="text-xs text-muted-foreground">
                  {t("settings.data.scanning")} {rescanProgress}/{rescanTotal}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={handleRebuildMentionCache}
              disabled={rescanRunning}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
            >
              {rescanRunning
                ? t("settings.data.running")
                : t("settings.data.rebuild")}
            </button>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">{t("settings.data.ftsRebuild")}</span>
            <button
              type="button"
              onClick={handleRebuildFts}
              disabled={isRebuildingFts}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
            >
              {isRebuildingFts
                ? t("settings.data.running")
                : t("settings.data.rebuild")}
            </button>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">{t("settings.data.vacuum")}</span>
            <button
              type="button"
              onClick={handleVacuum}
              disabled={isVacuuming}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
            >
              {isVacuuming ? t("settings.data.running") : "VACUUM"}
            </button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm">{t("settings.data.clearChat")}</span>
              <p className="text-xs text-muted-foreground">
                {t("settings.data.clearChatDesc")}
              </p>
            </div>
            <button
              type="button"
              onClick={handleClearChatHistory}
              disabled={isClearingChat}
              className={`rounded-md border px-3 py-1.5 text-sm disabled:opacity-50 ${
                confirmClear
                  ? "border-destructive bg-destructive/10 text-destructive"
                  : "border-border hover:bg-accent"
              }`}
            >
              {confirmClear
                ? t("settings.data.clearChatConfirm")
                : t("common.delete")}
            </button>
          </div>
          <div className="flex items-center justify-between pt-2">
            <div>
              <span className="text-sm text-destructive">
                {t("settings.data.deleteProject")}
              </span>
              <p className="text-xs text-muted-foreground">
                {t("settings.data.deleteProjectDesc")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setConfirmDelete(!confirmDelete)}
              className="rounded-md border border-destructive px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
            >
              {confirmDelete
                ? t("settings.data.deleteProjectNotImpl")
                : `${t("common.delete")}…`}
            </button>
          </div>
        </div>
      </SettingSection>

      <SettingSection title={t("externalMount.title")}>
        <SettingRow
          label={t("externalMount.manage")}
          description={t("externalMount.manageDesc")}
        >
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
            onClick={() => setMountDialogOpen(true)}
          >
            {t("externalMount.open")}
          </button>
        </SettingRow>
      </SettingSection>

      {/* Integrity Check */}
      <SettingSection title={t("settings.data.integrityCheck")}>
        <IntegrityCheckSection />
      </SettingSection>

      <MountListDialog
        open={mountDialogOpen}
        onClose={() => setMountDialogOpen(false)}
      />
    </div>
  );
}
