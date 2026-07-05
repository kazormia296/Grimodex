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
import { saveTextFile } from "@/lib/exportFile";
import {
  ExportTree,
  buildInitialTreeState,
  calcExportStats,
} from "./ExportTree";
import type { ExportTreeState } from "./ExportTree";
import { ExportSettingsPanel } from "./ExportSettingsPanel";
import { generateExport } from "./exportEngine";
import type { TateChuYokoPolicy } from "@/features/editor/tateChuYokoPolicy";
import { currentCodexMentionResolver } from "@/features/codex/mentionNameResolver";
import type { ExportSettings, ExportPresetId } from "./types";
import { DEFAULT_EXPORT_SETTINGS, EXPORT_SETTING_KEYS } from "./types";
import { resolveStoredTateChuYoko } from "./exportPresets";
import {
  parseUserPresets,
  serializeUserPresets,
  type UserExportPreset,
} from "./exportUserPresets";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import { TimelapseExportSection } from "@/features/timelapse/TimelapseExportSection";
import { VivliostyleExportSection } from "@/features/vivliostyle/VivliostyleExportSection";
import {
  buildProvenanceBreakdown,
  type ProvenanceDisclosureReport,
} from "@/features/attribution/provenance";
import {
  loadProvenanceAnalytics,
  type ProvenanceAnalyticsReport,
} from "@/features/attribution/provenanceAnalytics";
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
  const exportPresetId = (s.get(EXPORT_SETTING_KEYS.exportPresetId) ||
    DEFAULT_EXPORT_SETTINGS.exportPresetId) as ExportPresetId;
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
    // 旧ストア互換: tateChuYoko キー未保存なら選択中プリセットから導出する
    // （単純な "none" 既定だと保存済み caita/青空文庫の preset 検出が壊れる）。
    tateChuYoko: resolveStoredTateChuYoko(
      s.get(EXPORT_SETTING_KEYS.tateChuYoko),
      exportPresetId,
    ),
    exportPresetId,
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
  // 保存ダイアログは Rust 側で開かれ、renderer はパスを渡さない (security audit
  // PIO-2)。非 Tauri は browser ダウンロードにフォールバック。
  return saveTextFile(
    filename,
    FORMAT_FILTER[format],
    content,
    FORMAT_MIME[format],
  );
}

// ────────────────────────────────────────────────────────────────────
// ExportDialog 本体
// ────────────────────────────────────────────────────────────────────

/** ダイアログのタブ（テキスト出力 / AI 使用開示 / タイムラプス動画 / 本の書き出し）。 */
export type ExportDialogMode = "text" | "authorship" | "timelapse" | "book";

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * タブ指定つきで開く要求（コマンドパレットの「本の書き出し」など）。
   * ダイアログが既に開いている間の再要求でもタブを切り替えられるよう、
   * seq（nonce）の変化で適用する。未指定なら前回のタブを維持する。
   */
  modeRequest?: { mode: ExportDialogMode; seq: number };
}

export function ExportDialog({ open, onClose, modeRequest }: Props) {
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
  // テキスト出力 / AI 使用開示 / タイムラプス動画 / 本の書き出し の切り替え。
  const [mode, setMode] = useState<ExportDialogMode>("text");
  const [includePassageExcerpts, setIncludePassageExcerpts] = useState(false);
  // 制作過程開示: 各AI使用箇所に「入力(発話/指示)＋出力」を、さらにサブトグルで
  // 送信プロンプト全文を同梱する。
  const [includePrompts, setIncludePrompts] = useState(false);
  const [includeFullSystemPrompt, setIncludeFullSystemPrompt] = useState(false);
  const [authorshipReport, setAuthorshipReport] =
    useState<ProvenanceDisclosureReport | null>(null);
  const [analyticsReport, setAnalyticsReport] =
    useState<ProvenanceAnalyticsReport | null>(null);
  const [isLoadingAuthorship, setIsLoadingAuthorship] = useState(false);

  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // タブ指定つきの open 要求を適用する。seq の変化で発火するため、
  // ダイアログが既に開いているときの再要求（コマンドパレット再実行）でも
  // タブが切り替わる。
  useEffect(() => {
    if (modeRequest) setMode(modeRequest.mode);
    // intentionally keyed on seq: same-mode re-requests must re-apply
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeRequest?.seq]);

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
      settingsStore.set(EXPORT_SETTING_KEYS.tateChuYoko, next.tateChuYoko);
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
    const projectId = getCurrentProjectId();
    Promise.all([
      buildProvenanceBreakdown(projectId, {
        includePassageExcerpts,
        includePrompts,
        includeFullSystemPrompt,
      }),
      // Analytics is its own roll-up (model contribution / kind / approx cost),
      // loaded best-effort; its absence must not block the disclosure export.
      loadProvenanceAnalytics(projectId).catch((err: unknown) => {
        console.warn("provenance analytics failed", err);
        return null;
      }),
    ])
      .then(([report, analytics]) => {
        if (cancelled) return;
        setAuthorshipReport(report);
        setAnalyticsReport(analytics);
      })
      .catch((err: unknown) => {
        console.warn("authorship disclosure report failed", err);
        if (!cancelled) {
          setAuthorshipReport(null);
          setAnalyticsReport(null);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingAuthorship(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    open,
    mode,
    includePassageExcerpts,
    includePrompts,
    includeFullSystemPrompt,
  ]);

  // エクスポートコンテンツを生成
  function buildContent(): string {
    if (mode === "authorship") {
      if (!authorshipReport) return "";
      switch (exportSettings.format) {
        case "markdown":
          return exportProvenanceDisclosureMarkdown(
            authorshipReport,
            analyticsReport ?? undefined,
          );
        case "html":
          return exportProvenanceDisclosureHtml(
            authorshipReport,
            analyticsReport ?? undefined,
          );
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
      // 縦中横の対象 run は執筆側の editor.tateChuYoko 設定に合わせる。
      tateChuYokoPolicy: settingsStore.get(
        "editor.tateChuYoko",
        "2",
      ) as TateChuYokoPolicy,
      resolveMentionName: currentCodexMentionResolver(),
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
        {/* モード切替: テキスト / 開示 / タイムラプス動画 / 本の書き出し */}
        <div
          role="tablist"
          className="inline-flex rounded-md border border-border p-0.5"
        >
          {(["text", "authorship", "timelapse", "book"] as const).map((m) => (
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
                    : m === "timelapse"
                      ? "timelapse.tabVideoExport"
                      : "vivliostyle.tab",
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
          includePrompts={includePrompts}
          onIncludePromptsChange={setIncludePrompts}
          includeFullSystemPrompt={includeFullSystemPrompt}
          onIncludeFullSystemPromptChange={setIncludeFullSystemPrompt}
        />
      ) : mode === "timelapse" ? (
        <div className="flex-1 overflow-auto">
          <TimelapseExportSection projectTitle={projectTitle} />
        </div>
      ) : (
        // 本の書き出し（Vivliostyle）。body + 専用フッター（プレビュー/書き出し）を
        // セクション側が描画する。タブ表示中のみマウントされ、マウント時に初期化。
        <VivliostyleExportSection />
      )}

      {/* フッター (動画/本の書き出しは各セクションが自前のフッターを持つ) */}
      {mode !== "timelapse" && mode !== "book" && (
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
              {t("export.disclosure.remainingAi", {
                count: (authorshipReport?.totals.ai ?? 0).toLocaleString(),
              })}
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
  includePrompts,
  onIncludePromptsChange,
  includeFullSystemPrompt,
  onIncludeFullSystemPromptChange,
}: {
  report: ProvenanceDisclosureReport | null;
  loading: boolean;
  includePassageExcerpts: boolean;
  onIncludePassageExcerptsChange: (value: boolean) => void;
  includePrompts: boolean;
  onIncludePromptsChange: (value: boolean) => void;
  includeFullSystemPrompt: boolean;
  onIncludeFullSystemPromptChange: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  const total = report?.totals.total ?? 0;
  const ai = report?.totals.ai ?? 0;
  const aiPct = total > 0 ? Math.round((ai / total) * 100) : 0;
  const breakdown = report?.breakdown;

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">
              {t("export.disclosure.title")}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t("export.disclosure.subtitle")}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1.5 text-xs text-muted-foreground">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={includePassageExcerpts}
                onChange={(e) =>
                  onIncludePassageExcerptsChange(e.currentTarget.checked)
                }
              />
              {t("export.disclosure.includeExcerpts")}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={includePrompts}
                onChange={(e) =>
                  onIncludePromptsChange(e.currentTarget.checked)
                }
              />
              {t("export.disclosure.includeProcess")}
            </label>
            {includePrompts && (
              <label className="flex items-center gap-2 pl-4">
                <input
                  type="checkbox"
                  checked={includeFullSystemPrompt}
                  onChange={(e) =>
                    onIncludeFullSystemPromptChange(e.currentTarget.checked)
                  }
                />
                {t("export.disclosure.includeFullPrompt")}
              </label>
            )}
          </div>
        </div>

        {(includePassageExcerpts || includePrompts) && (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {includeFullSystemPrompt
              ? t("export.disclosure.warnFullPrompt")
              : t("export.disclosure.warnExcerpts")}
          </div>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : !report || !breakdown ? (
          <p className="text-sm text-muted-foreground">
            {t("export.disclosure.reportFailed")}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Metric
                label={t("export.disclosure.metricTotal")}
                value={total.toLocaleString()}
              />
              <Metric
                label={t("export.disclosure.metricAi")}
                value={ai.toLocaleString()}
              />
              <Metric
                label={t("export.disclosure.metricRatio")}
                value={`${aiPct}%`}
              />
            </div>

            <div className="rounded border border-border">
              {[
                [t("export.disclosure.breakdownChat"), breakdown.chat],
                ["slash", breakdown.inlineAi],
                ["Beat", breakdown.beat],
                [t("export.disclosure.breakdownOrphan"), breakdown.orphanChat],
                [t("export.disclosure.breakdownUnknown"), breakdown.unknownAi],
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
                    {passage.disclosure ? (
                      <div className="mt-1 flex flex-col gap-1">
                        <div>
                          <span className="font-semibold">
                            {t("export.disclosure.inputLabel")}
                          </span>{" "}
                          {passage.disclosure.userPrompt ||
                            t("export.disclosure.noRecord")}
                        </div>
                        <div>
                          <span className="font-semibold">
                            {t("export.disclosure.outputLabel")}
                          </span>{" "}
                          {passage.disclosure.output ||
                            t("export.disclosure.empty")}
                        </div>
                        {includeFullSystemPrompt && (
                          <div className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-muted-foreground">
                            <span className="font-semibold">
                              {t("export.disclosure.sentPromptLabel")}
                            </span>{" "}
                            {passage.disclosure.sentSystemPrompt ||
                              t("export.disclosure.notRecorded")}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="mt-1">{passage.excerpt}</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {report.map && report.map.stickyCount > 0 && (
              <div>
                <h4 className="text-xs font-semibold">
                  {t("export.disclosure.mapAiTitle")}
                </h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("export.disclosure.mapAiSummary", {
                    stickyCount: report.map.stickyCount.toLocaleString(),
                    aiChars: report.map.totalAiChars.toLocaleString(),
                  })}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t("export.disclosure.mapAiNote")}
                </p>
                <div className="mt-2 rounded border border-border">
                  {report.map.stickies.map((s) => (
                    <div
                      key={s.stickyId}
                      className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs last:border-b-0"
                    >
                      <span className="truncate">
                        {s.boardTitle} / {s.stickyTitle}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {s.charCount.toLocaleString()} chars
                      </span>
                    </div>
                  ))}
                </div>
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
