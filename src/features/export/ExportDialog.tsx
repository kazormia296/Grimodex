import { useState, useEffect, useCallback, useRef } from "react";
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

  const mouseDownOnBackdrop = useRef(false);
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
  }, [open]); // intentionally omit deps: runs only when dialog opens

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

  // Escape キーで閉じる
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // クリーンアップ
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  if (!open) return null;

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
      toast.error("クリップボードへのコピーに失敗しました");
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
        toast.success(`エクスポート完了: ${savedPath}`);
      }
    } catch (err) {
      toast.error(`エクスポートに失敗しました: ${String(err)}`);
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => {
        mouseDownOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && mouseDownOnBackdrop.current) {
          onClose();
        }
      }}
    >
      <div
        className="flex h-[780px] w-[1000px] min-h-[400px] min-w-[560px] max-h-[90vh] max-w-[90vw] resize flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-4 py-2">
          <h2 className="text-sm font-semibold text-foreground">
            エクスポート
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
            <ExportTree
              nodes={nodes}
              state={treeState}
              onChange={setTreeState}
            />
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
            選択中: {sceneCount}/{totalScenes} シーン
          </span>
          <span className="text-xs text-muted-foreground">
            約{charCount.toLocaleString()}文字
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
                コピー済み
              </>
            ) : (
              <>
                <ClipboardCopy className="h-3.5 w-3.5" />
                コピー
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
            {isExporting ? "保存中…" : "エクスポート"}
          </button>
        </div>
      </div>
    </div>
  );
}
