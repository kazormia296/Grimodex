import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { X, ClipboardCopy, Check, Download } from "lucide-react";
import { toast } from "sonner";
import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { useTreeStore } from "@/features/tree/treeStore";
import { useSceneContentStore } from "@/features/editor/sceneContentStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { getProject } from "@/features/project/api";
import {
  ExportTree,
  buildInitialTreeState,
  calcExportStats,
} from "./ExportTree";
import type { ExportTreeState } from "./ExportTree";
import { ExportSettingsPanel } from "./ExportSettingsPanel";
import { generateExport } from "./exportEngine";
import type { ExportSettings } from "./types";
import { DEFAULT_EXPORT_SETTINGS, EXPORT_SETTING_KEYS } from "./types";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";

const PROJECT_ID = "default-project";

// ────────────────────────────────────────────────────────────────────
// 設定のロード/セーブ
// ────────────────────────────────────────────────────────────────────

function loadSettingsFromStore(
  store: ReturnType<typeof useSettingsStore.getState>,
): ExportSettings {
  const s = store;
  return {
    format: (s.get(EXPORT_SETTING_KEYS.format) ||
      DEFAULT_EXPORT_SETTINGS.format) as ExportSettings["format"],
    folderHeading: s.getBoolean(
      EXPORT_SETTING_KEYS.folderHeading,
      DEFAULT_EXPORT_SETTINGS.folderHeading,
    ),
    folderHeadingStyle: (s.get(EXPORT_SETTING_KEYS.folderHeadingStyle) ||
      DEFAULT_EXPORT_SETTINGS.folderHeadingStyle) as ExportSettings["folderHeadingStyle"],
    sceneDivider: (s.get(EXPORT_SETTING_KEYS.sceneDivider) ||
      DEFAULT_EXPORT_SETTINGS.sceneDivider) as ExportSettings["sceneDivider"],
    sceneDividerCustom: s.get(EXPORT_SETTING_KEYS.sceneDividerCustom, ""),
    sceneTitle: (s.get(EXPORT_SETTING_KEYS.sceneTitle) ||
      DEFAULT_EXPORT_SETTINGS.sceneTitle) as ExportSettings["sceneTitle"],
    rubyStyle: s.get(EXPORT_SETTING_KEYS.rubyStyle)
      ? (s.get(EXPORT_SETTING_KEYS.rubyStyle) as ExportSettings["rubyStyle"])
      : null,
    emphasisDotsStyle: s.get(EXPORT_SETTING_KEYS.emphasisDotsStyle)
      ? (s.get(
          EXPORT_SETTING_KEYS.emphasisDotsStyle,
        ) as ExportSettings["emphasisDotsStyle"])
      : null,
    sceneBreakStyle: (s.get(EXPORT_SETTING_KEYS.sceneBreakStyle) ||
      DEFAULT_EXPORT_SETTINGS.sceneBreakStyle) as ExportSettings["sceneBreakStyle"],
    sceneBreakCustom: s.get(EXPORT_SETTING_KEYS.sceneBreakCustom, ""),
  };
}

// ────────────────────────────────────────────────────────────────────
// コンテンツ取得（DB + liveContent オーバーレイ）
// ────────────────────────────────────────────────────────────────────

async function loadContentMap(): Promise<Record<string, string>> {
  const rows = await db
    .select({ id: treeNodes.id, content: treeNodes.content })
    .from(treeNodes)
    .where(eq(treeNodes.projectId, PROJECT_ID));

  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.id] = row.content;
  }

  // liveContent でオーバーレイ（現在編集中のシーンの最新状態）
  const live = useSceneContentStore.getState().liveContent;
  for (const [id, content] of Object.entries(live)) {
    if (content) {
      map[id] = JSON.stringify(content);
    }
  }

  return map;
}

// ────────────────────────────────────────────────────────────────────
// Tauri ファイル保存ダイアログ
// ────────────────────────────────────────────────────────────────────

const FORMAT_EXT: Record<ExportSettings["format"], string> = {
  markdown: "md",
  plaintext: "txt",
  html: "html",
};

const FORMAT_MIME: Record<ExportSettings["format"], string> = {
  markdown: "text/markdown;charset=utf-8",
  plaintext: "text/plain;charset=utf-8",
  html: "text/html;charset=utf-8",
};

async function saveFile(
  content: string,
  format: ExportSettings["format"],
  defaultName: string,
): Promise<string | null> {
  const ext = FORMAT_EXT[format];
  const mime = FORMAT_MIME[format];
  const filename = `${defaultName}.${ext}`;

  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return filename;
}

// ────────────────────────────────────────────────────────────────────
// ExportDialog 本体
// ────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ExportDialog({ open, onClose }: Props) {
  const { t } = useTranslation();
  const nodes = useTreeStore((s) => s.nodes);
  const expandedIds = useTreeStore((s) => s.expandedIds);
  const settingsStore = useSettingsStore();

  const [treeState, setTreeState] = useState<ExportTreeState>(() =>
    buildInitialTreeState(nodes, expandedIds),
  );
  const [exportSettings, setExportSettings] = useState<ExportSettings>(
    DEFAULT_EXPORT_SETTINGS,
  );
  const [contentMap, setContentMap] = useState<Record<string, string>>({});
  const [isCopied, setIsCopied] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [projectTitle, setProjectTitle] = useState("Untitled Project");
  const [projectLanguage, setProjectLanguage] = useState("ja");

  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ダイアログが開いた時に状態を初期化
  useEffect(() => {
    if (!open) return;

    // ツリー初期化
    setTreeState(buildInitialTreeState(nodes, expandedIds));

    // 設定をロード
    const loaded = loadSettingsFromStore(settingsStore);
    setExportSettings(loaded);

    // コンテンツをロード
    loadContentMap()
      .then(setContentMap)
      .catch(() => setContentMap({}));

    // プロジェクト情報をロード
    getProject(PROJECT_ID).then((p) => {
      if (p) {
        setProjectTitle(p.title || "Untitled Project");
        setProjectLanguage(p.language || "ja");
      }
    });
    // intentionally omit deps: runs only when dialog opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 設定変更を永続化
  const handleSettingsChange = useCallback(
    (next: ExportSettings) => {
      setExportSettings(next);
      // 各設定キーを settingsStore に書き込む
      settingsStore.set(EXPORT_SETTING_KEYS.format, next.format);
      settingsStore.set(
        EXPORT_SETTING_KEYS.folderHeading,
        String(next.folderHeading),
      );
      settingsStore.set(
        EXPORT_SETTING_KEYS.folderHeadingStyle,
        next.folderHeadingStyle,
      );
      settingsStore.set(EXPORT_SETTING_KEYS.sceneDivider, next.sceneDivider);
      settingsStore.set(
        EXPORT_SETTING_KEYS.sceneDividerCustom,
        next.sceneDividerCustom,
      );
      settingsStore.set(EXPORT_SETTING_KEYS.sceneTitle, next.sceneTitle);
      settingsStore.set(EXPORT_SETTING_KEYS.rubyStyle, next.rubyStyle ?? "");
      settingsStore.set(
        EXPORT_SETTING_KEYS.emphasisDotsStyle,
        next.emphasisDotsStyle ?? "",
      );
      settingsStore.set(
        EXPORT_SETTING_KEYS.sceneBreakStyle,
        next.sceneBreakStyle,
      );
      settingsStore.set(
        EXPORT_SETTING_KEYS.sceneBreakCustom,
        next.sceneBreakCustom,
      );
    },
    [settingsStore],
  );

  // クリーンアップ
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  // 統計情報
  const { sceneCount, charCount, totalScenes } = calcExportStats(
    nodes,
    contentMap,
    treeState.checkedIds,
  );

  // エクスポートコンテンツを生成
  function buildContent(): string {
    return generateExport({
      nodes,
      contentMap,
      checkedIds: treeState.checkedIds,
      settings: exportSettings,
      projectTitle,
      projectLanguage,
    });
  }

  // コピーボタン
  async function handleCopy() {
    if (sceneCount === 0) return;
    try {
      const text = buildContent();
      await navigator.clipboard.writeText(text);
      setIsCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setIsCopied(false), 1500);
    } catch {
      toast.error(t("export.dialog.clipboardFailed"));
    }
  }

  // エクスポートボタン
  async function handleExport() {
    if (sceneCount === 0 || isExporting) return;
    setIsExporting(true);
    try {
      const content = buildContent();
      const savedPath = await saveFile(
        content,
        exportSettings.format,
        projectTitle,
      );
      if (savedPath) {
        toast.success(t("export.dialog.exportComplete", { path: savedPath }));
      }
    } catch (err) {
      toast.error(t("export.dialog.exportFailed", { error: String(err) }));
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <AnimatedOverlay
      open={open}
      onClose={onClose}
      className="flex h-[780px] w-[1000px] min-h-[400px] min-w-[560px] max-h-[90vh] max-w-[90vw] resize flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl"
    >
      {/* ヘッダー */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <h2 className="text-sm font-semibold text-foreground">
          {t("export.dialog.title")}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* ボディ: 左ペイン + 右ペイン */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左: シーン選択ツリー */}
        <div className="w-1/2 min-w-[240px] overflow-hidden border-r border-border">
          <ExportTree nodes={nodes} state={treeState} onChange={setTreeState} />
        </div>

        {/* 右: エクスポート設定 */}
        <div className="min-w-[280px] flex-1 overflow-hidden">
          <ExportSettingsPanel
            settings={exportSettings}
            onChange={handleSettingsChange}
            nodes={nodes}
            contentMap={contentMap}
            checkedIds={treeState.checkedIds}
          />
        </div>
      </div>

      {/* フッター */}
      <div className="flex flex-shrink-0 items-center gap-3 border-t border-border px-4 py-2">
        <span className="text-xs text-muted-foreground">
          {t("export.dialog.selectedScenes", { sceneCount, totalScenes })}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("export.dialog.approxChars", {
            count: charCount.toLocaleString(),
          })}
        </span>
        <div className="flex-1" />
        {/* コピーボタン */}
        <button
          type="button"
          onClick={handleCopy}
          disabled={sceneCount === 0}
          className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isCopied ? (
            <>
              <Check className="h-3.5 w-3.5 text-green-500" />
              {t("export.dialog.copied")}
            </>
          ) : (
            <>
              <ClipboardCopy className="h-3.5 w-3.5" />
              {t("export.dialog.copy")}
            </>
          )}
        </button>
        {/* エクスポートボタン */}
        <button
          type="button"
          onClick={handleExport}
          disabled={sceneCount === 0 || isExporting}
          className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
          {isExporting ? t("export.dialog.saving") : t("export.dialog.export")}
        </button>
      </div>
    </AnimatedOverlay>
  );
}
