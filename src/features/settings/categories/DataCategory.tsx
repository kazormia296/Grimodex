import { useState, useEffect } from "react";
import { toast } from "sonner";
import { invoke } from "@/lib/tauri";
import { useWorkspaceStore } from "@/features/workspace/store";
import { db } from "@/db/client";
import { treeNodes, chatSessions, chatMessages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { SettingToggle } from "../components/SettingToggle";
import { SettingSlider } from "../components/SettingSlider";
import {
  exportAsMarkdown,
  exportAsPlainText,
  exportCodexJson,
} from "../exportUtils";

const PROJECT_ID = "default-project";

interface ProjectStats {
  sceneCount: number;
  totalChars: number;
}

async function getProjectStats(): Promise<ProjectStats> {
  const scenes = await db
    .select({ content: treeNodes.content })
    .from(treeNodes)
    .where(eq(treeNodes.projectId, PROJECT_ID));

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
  const workspacePath = useWorkspaceStore((s) => s.activeWorkspacePath);
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    getProjectStats()
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  async function handleExport(type: "markdown" | "plain" | "codex") {
    setIsExporting(true);
    try {
      if (type === "markdown") {
        const md = await exportAsMarkdown();
        await triggerDownload("export.md", md);
      } else if (type === "plain") {
        const txt = await exportAsPlainText();
        await triggerDownload("export.txt", txt);
      } else {
        const json = await exportCodexJson();
        await triggerDownload("codex.json", json);
      }
      toast.success("エクスポートしました");
    } catch {
      toast.error("エクスポートに失敗しました");
    } finally {
      setIsExporting(false);
    }
  }

  async function handleRebuildFts() {
    try {
      await invoke("fts_optimize");
      toast.success("FTS インデックスを再構築しました");
    } catch {
      toast.error("FTS 再構築に失敗しました");
    }
  }

  async function handleVacuum() {
    try {
      await db.run("VACUUM" as never);
      toast.success("データベースを最適化しました");
    } catch {
      toast.error("VACUUM に失敗しました");
    }
  }

  async function handleClearChatHistory() {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 5000);
      return;
    }
    try {
      const sessions = await db
        .select({ id: chatSessions.id })
        .from(chatSessions)
        .where(eq(chatSessions.projectId, PROJECT_ID));
      for (const s of sessions) {
        await db.delete(chatMessages).where(eq(chatMessages.sessionId, s.id));
      }
      await db
        .delete(chatSessions)
        .where(eq(chatSessions.projectId, PROJECT_ID));
      toast.success("チャット履歴を削除しました");
      setConfirmClear(false);
    } catch {
      toast.error("削除に失敗しました");
    }
  }

  return (
    <div className="p-6">
      {/* Project Info */}
      <SettingSection title="プロジェクト情報">
        <SettingRow label="保存先">
          <span className="max-w-[200px] truncate text-xs text-muted-foreground">
            {workspacePath ?? "—"}
          </span>
        </SettingRow>
        <SettingRow label="シーン数">
          <span className="text-sm">{stats?.sceneCount ?? "…"}</span>
        </SettingRow>
        <SettingRow label="総文字数">
          <span className="text-sm">
            {stats ? stats.totalChars.toLocaleString() : "…"}
          </span>
        </SettingRow>
      </SettingSection>

      {/* Backup */}
      <SettingSection title="バックアップ">
        <SettingRow label="自動バックアップ">
          <SettingToggle settingKey="data.autoBackup" defaultValue={true} />
        </SettingRow>
        <SettingRow label="バックアップ間隔">
          <SettingSlider
            settingKey="data.backupInterval"
            min={15}
            max={360}
            step={15}
            defaultValue={60}
            format={(v) => `${v}分`}
          />
        </SettingRow>
        <SettingRow label="最大保持数">
          <SettingSlider
            settingKey="data.maxBackups"
            min={1}
            max={50}
            step={1}
            defaultValue={10}
            format={(v) => `${v}件`}
          />
        </SettingRow>
      </SettingSection>

      {/* Revision History */}
      <SettingSection title="リビジョン履歴">
        <SettingRow label="自動リビジョン間隔">
          <SettingSlider
            settingKey="revision.autoInterval"
            min={1}
            max={60}
            step={1}
            defaultValue={5}
            format={(v) => `${v}分`}
          />
        </SettingRow>
        <SettingRow label="リビジョン保持上限">
          <SettingSlider
            settingKey="revision.keepCount"
            min={10}
            max={200}
            step={10}
            defaultValue={50}
            format={(v) => `${v}件`}
          />
        </SettingRow>
      </SettingSection>

      {/* Export */}
      <SettingSection title="エクスポート">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => handleExport("markdown")}
            disabled={isExporting}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          >
            Markdown
          </button>
          <button
            type="button"
            onClick={() => handleExport("plain")}
            disabled={isExporting}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          >
            プレーンテキスト
          </button>
          <button
            type="button"
            onClick={() => handleExport("codex")}
            disabled={isExporting}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          >
            Codex JSON
          </button>
        </div>
      </SettingSection>

      {/* Data Management */}
      <SettingSection title="データ管理">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm">FTS インデックス再構築</span>
            <button
              type="button"
              onClick={handleRebuildFts}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
            >
              再構築
            </button>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">データベースを最適化</span>
            <button
              type="button"
              onClick={handleVacuum}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
            >
              VACUUM
            </button>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm">チャット履歴を削除</span>
              <p className="text-xs text-muted-foreground">
                抽出済みの Codex/Snippets は残ります
              </p>
            </div>
            <button
              type="button"
              onClick={handleClearChatHistory}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                confirmClear
                  ? "border-destructive bg-destructive/10 text-destructive"
                  : "border-border hover:bg-accent"
              }`}
            >
              {confirmClear ? "本当に削除する" : "削除"}
            </button>
          </div>
          <div className="flex items-center justify-between pt-2">
            <div>
              <span className="text-sm text-destructive">
                プロジェクトを削除
              </span>
              <p className="text-xs text-muted-foreground">
                この操作は取り消せません
              </p>
            </div>
            <button
              type="button"
              onClick={() => setConfirmDelete(!confirmDelete)}
              className="rounded-md border border-destructive px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
            >
              {confirmDelete ? "未実装（キャンセル）" : "削除…"}
            </button>
          </div>
        </div>
      </SettingSection>
    </div>
  );
}
