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
import { getCurrentProjectId } from "@/features/project/projectStore";
import {
  ExportTree,
  buildInitialTreeState,
  calcExportStats,
} from "./ExportTree";
import type { ExportTreeState } from "./ExportTree";
import { ExportSettingsPanel } from "./ExportSettingsPanel";
import { generateExport } from "./exportEngine";
import type { ExportSettings, ExportPresetId } from "./types";
import { DEFAULT_EXPORT_SETTINGS, EXPORT_SETTING_KEYS } from "./types";
import {
  parseUserPresets,
  serializeUserPresets,
  type UserExportPreset,
} from "./exportUserPresets";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import { TimelapseExportSection } from "@/features/timelapse/TimelapseExportSection";
import {
  buildProvenanceBreakdown,
  type ProvenanceDisclosureReport,
} from "@/features/attribution/provenance";
import {
  exportProvenanceDisclosureHtml,
  exportProvenanceDisclosureJson,
  exportProvenanceDisclosureMarkdown,
} from "@/features/attribution/exportReport";

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
    includeTrashBin: s.getBoolean(
      EXPORT_SETTING_KEYS.includeTrashBin,
      DEFAULT_EXPORT_SETTINGS.includeTrashBin,
    ),
    folderHeadingFormat: (s.get(EXPORT_SETTING_KEYS.folderHeadingFormat) ||
      DEFAULT_EXPORT_SETTINGS.folderHeadingFormat) as ExportSettings["folderHeadingFormat"],
    pixivChapterNewpage: s.getBoolean(
      EXPORT_SETTING_KEYS.pixivChapterNewpage,
      DEFAULT_EXPORT_SETTINGS.pixivChapterNewpage,
    ),
    narouEmphasisMode: (s.get(EXPORT_SETTING_KEYS.narouEmphasisMode) ||
      DEFAULT_EXPORT_SETTINGS.narouEmphasisMode) as ExportSettings["narouEmphasisMode"],
    exportPresetId: (s.get(EXPORT_SETTING_KEYS.exportPresetId) ||
      DEFAULT_EXPORT_SETTINGS.exportPresetId) as ExportPresetId,
  };
}

// ────────────────────────────────────────────────────────────────────
// コンテンツ取得（DB + liveContent オーバーレイ）
// ────────────────────────────────────────────────────────────────────

async function loadContentMap(): Promise<Record<string, string>> {
  const rows = await db
    .select({ id: treeNodes.id, content: treeNodes.content })
    .from(treeNodes)
    .where(eq(treeNodes.projectId, getCurrentProjectId()));

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

const FORMAT_FILTER: Record<
  ExportSettings["format"],
  { name: string; extensions: string[] }
> = {
  markdown: { name: "Markdown", extensions: ["md"] },
  plaintext: { name: "Plain Text", extensions: ["txt"] },
  html: { name: "HTML", extensions: ["html"] },
};

async function saveFile(
  content: string,
  format: ExportSettings["format"],
  defaultName: string,
): Promise<string | null> {
  const ext = FORMAT_EXT[format];
  const filename = `${defaultName}.${ext}`;

  // Tauri 環境: OS ネイティブの保存ダイアログを開き、ユーザーが選んだパスへ書き込む。
  // キャンセル時は path が null になるのでそのまま return。
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      defaultPath: filename,
      filters: [FORMAT_FILTER[format]],
    });
    if (!path) return null;
    await writeTextFile(path, content);
    return path;
  }

  // ブラウザフォールバック (dev サーバー / vitest)。
  const mime = FORMAT_MIME[format];
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
  const [userPresets, setUserPresets] = useState<UserExportPreset[]>([]);
  const [isCopied, setIsCopied] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [projectTitle, setProjectTitle] = useState("Untitled Project");
  const [projectLanguage, setProjectLanguage] = useState("ja");
  // テキスト出力 / AI 使用開示 / タイムラプス動画 の切り替え。
  const [mode, setMode] = useState<"text" | "authorship" | "timelapse">("text");
  const [includePassageExcerpts, setIncludePassageExcerpts] = useState(false);
  const [authorshipReport, setAuthorshipReport] =
    useState<ProvenanceDisclosureReport | null>(null);
  const [isLoadingAuthorship, setIsLoadingAuthorship] = useState(false);

  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ダイアログが開いた時に状態を初期化
  useEffect(() => {
    if (!open) return;

    // ツリー初期化
    setTreeState(buildInitialTreeState(nodes, expandedIds));

    // 設定をロード
    const loaded = loadSettingsFromStore(settingsStore);
    setExportSettings(loaded);

    // ユーザープリセットをロード
    const userPresetsJson = settingsStore.get(EXPORT_SETTING_KEYS.userPresets);
    setUserPresets(parseUserPresets(userPresetsJson));

    // コンテンツをロード
    loadContentMap()
      .then(setContentMap)
      .catch(() => setContentMap({}));

    // プロジェクト情報をロード
    getProject(getCurrentProjectId()).then((p) => {
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
      settingsStore.set(
        EXPORT_SETTING_KEYS.includeTrashBin,
        String(next.includeTrashBin),
      );
      settingsStore.set(
        EXPORT_SETTING_KEYS.folderHeadingFormat,
        next.folderHeadingFormat,
      );
      settingsStore.set(
        EXPORT_SETTING_KEYS.pixivChapterNewpage,
        String(next.pixivChapterNewpage),
      );
      settingsStore.set(
        EXPORT_SETTING_KEYS.narouEmphasisMode,
        next.narouEmphasisMode,
      );
      settingsStore.set(
        EXPORT_SETTING_KEYS.exportPresetId,
        next.exportPresetId,
      );
    },
    [settingsStore],
  );

  // ユーザープリセット変更を永続化
  const handleUserPresetsChange = useCallback(
    (next: UserExportPreset[]) => {
      setUserPresets(next);
      settingsStore.set(
        EXPORT_SETTING_KEYS.userPresets,
        serializeUserPresets(next),
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

  useEffect(() => {
    if (!open || mode !== "authorship") return;
    let cancelled = false;
    setIsLoadingAuthorship(true);
    buildProvenanceBreakdown(getCurrentProjectId(), {
      includePassageExcerpts,
    })
      .then((report) => {
        if (!cancelled) setAuthorshipReport(report);
      })
      .catch((err: unknown) => {
        console.warn("authorship disclosure report failed", err);
        if (!cancelled) setAuthorshipReport(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingAuthorship(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, mode, includePassageExcerpts]);

  // エクスポートコンテンツを生成
  function buildContent(): string {
    if (mode === "authorship") {
      if (!authorshipReport) return "";
      switch (exportSettings.format) {
        case "markdown":
          return exportProvenanceDisclosureMarkdown(authorshipReport);
        case "html":
          return exportProvenanceDisclosureHtml(authorshipReport);
        case "plaintext":
          return exportProvenanceDisclosureJson(authorshipReport);
      }
    }
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
    if (mode === "text" && sceneCount === 0) return;
    if (mode === "authorship" && !authorshipReport) return;
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
    if (mode === "text" && sceneCount === 0) return;
    if (mode === "authorship" && !authorshipReport) return;
    if (isExporting) return;
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
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <h2 className="text-sm font-semibold text-foreground">
          {t("export.dialog.title")}
        </h2>
        {/* モード切替: テキスト / タイムラプス動画 (#8) */}
        <div
          role="tablist"
          className="inline-flex rounded-md border border-border p-0.5"
        >
          {(["text", "authorship", "timelapse"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`rounded px-2.5 py-1 text-xs transition-colors ${
                mode === m
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent"
              }`}
            >
              {t(
                m === "text"
                  ? "timelapse.tabTextExport"
                  : m === "authorship"
                    ? "attribution.report"
                    : "timelapse.tabVideoExport",
              )}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* ボディ: テキスト出力 / AI 使用開示 / 動画 */}
      {mode === "text" ? (
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
              userPresets={userPresets}
              onUserPresetsChange={handleUserPresetsChange}
            />
          </div>
        </div>
      ) : mode === "authorship" ? (
        <AuthorshipDisclosureSection
          report={authorshipReport}
          loading={isLoadingAuthorship}
          includePassageExcerpts={includePassageExcerpts}
          onIncludePassageExcerptsChange={setIncludePassageExcerpts}
        />
      ) : (
        <div className="flex-1 overflow-auto">
          <TimelapseExportSection projectTitle={projectTitle} />
        </div>
      )}

      {/* フッター (動画は TimelapseExportSection が自前の書き出しボタンを持つ) */}
      {mode !== "timelapse" && (
        <div className="flex flex-shrink-0 items-center gap-3 border-t border-border px-4 py-2">
          {mode === "text" ? (
            <>
              <span className="text-xs text-muted-foreground">
                {t("export.dialog.selectedScenes", {
                  sceneCount,
                  totalScenes,
                })}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("export.dialog.approxChars", {
                  count: charCount.toLocaleString(),
                })}
              </span>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              残存 AI: {(authorshipReport?.totals.ai ?? 0).toLocaleString()}{" "}
              文字
            </span>
          )}
          <div className="flex-1" />
          {/* コピーボタン */}
          <button
            type="button"
            onClick={handleCopy}
            disabled={
              mode === "text"
                ? sceneCount === 0
                : !authorshipReport || isLoadingAuthorship
            }
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
            disabled={
              mode === "text"
                ? sceneCount === 0 || isExporting
                : !authorshipReport || isLoadingAuthorship || isExporting
            }
            className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            {isExporting
              ? t("export.dialog.saving")
              : t("export.dialog.export")}
          </button>
        </div>
      )}
    </AnimatedOverlay>
  );
}

function AuthorshipDisclosureSection({
  report,
  loading,
  includePassageExcerpts,
  onIncludePassageExcerptsChange,
}: {
  report: ProvenanceDisclosureReport | null;
  loading: boolean;
  includePassageExcerpts: boolean;
  onIncludePassageExcerptsChange: (value: boolean) => void;
}) {
  const total = report?.totals.total ?? 0;
  const ai = report?.totals.ai ?? 0;
  const aiPct = total > 0 ? Math.round((ai / total) * 100) : 0;
  const breakdown = report?.breakdown;

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">AI 使用開示</h3>
            <p className="text-xs text-muted-foreground">
              残存している authorship metadata に基づく出自レポートです。
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includePassageExcerpts}
              onChange={(e) =>
                onIncludePassageExcerptsChange(e.currentTarget.checked)
              }
            />
            抜粋を含める
          </label>
        </div>

        {includePassageExcerpts && (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            per-passage 抜粋には未公開本文が含まれます。共有先に合わせて
            出力前に確認してください。
          </div>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground">読み込み中...</p>
        ) : !report || !breakdown ? (
          <p className="text-sm text-muted-foreground">
            レポートを作成できませんでした。
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Metric label="総文字数" value={total.toLocaleString()} />
              <Metric label="AI 文字数" value={ai.toLocaleString()} />
              <Metric label="AI 比率" value={`${aiPct}%`} />
            </div>

            <div className="rounded border border-border">
              {[
                ["チャット", breakdown.chat],
                ["slash", breakdown.inlineAi],
                ["Beat", breakdown.beat],
                ["消失", breakdown.orphanChat],
                ["出自記録なし", breakdown.unknownAi],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-center justify-between border-b border-border px-3 py-2 text-sm last:border-b-0"
                >
                  <span>{label}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {(value as number).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>

            {report.passages && report.passages.length > 0 && (
              <div className="rounded border border-border">
                {report.passages.map((passage) => (
                  <div
                    key={passage.id}
                    className="border-b border-border px-3 py-2 text-xs last:border-b-0"
                  >
                    <div className="text-muted-foreground">
                      {passage.provenance.kind} /{" "}
                      {passage.charCount.toLocaleString()} chars
                    </div>
                    <div className="mt-1">{passage.excerpt}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
