import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  ExportTree,
  buildInitialTreeState,
  calcExportStats,
} from "@/features/export/ExportTree";
import type { ExportTreeState } from "@/features/export/ExportTree";
import type { TateChuYokoPolicy } from "@/features/editor/tateChuYokoPolicy";
import { currentCodexMentionResolver } from "@/features/codex/mentionNameResolver";
import { getCurrentProjectId } from "@/features/project/projectStore";
import {
  buildVivliostyleHtml,
  VIVLIOSTYLE_HTML_FILENAME,
  VIVLIOSTYLE_THEME_FILENAME,
} from "./buildVivliostyleHtml";
import { VIVLIOSTYLE_THEMES } from "./themes";
import { detectVivliostyle, saveVivliostyleOutput } from "./api";
import type { VivliostyleDetectResult } from "./types";
import { loadVivliostyleExportSources } from "./loadExportSources";
import type { VivliostyleExportSources } from "./loadExportSources";
import { useVivliostyleRunStore } from "./runStore";
import { useVivliostyleSettings } from "./useVivliostyleSettings";
import { ThemePicker } from "./ThemePicker";
import { FormatPicker } from "./FormatPicker";
import { CliStatusBanner } from "./CliStatusBanner";
import { BuildProgress } from "./BuildProgress";
import { BuildFooter } from "./BuildFooter";

// ────────────────────────────────────────────────────────────────────
// 本の書き出し（Vivliostyle）セクション。ExportDialog の「本の書き出し」
// タブとして body + フッターを描画する（タブ表示中のみマウントされ、
// マウント時に CLI 検出と素材ロードを行う）。
// シーン選択（ExportTree 再利用）＋テーマ/形式選択＋ビルド進捗＋プレビュー。
// ビルド/プレビューの実行状態は runStore がタブ切替を跨いで保持し、
// プレビューはタブやダイアログを閉じても止めない（Rust 側 singleton が管理）。
// ────────────────────────────────────────────────────────────────────

export function VivliostyleExportSection() {
  const { t } = useTranslation();
  const nodes = useTreeStore((s) => s.nodes);
  const expandedIds = useTreeStore((s) => s.expandedIds);

  const [treeState, setTreeState] = useState<ExportTreeState>(() =>
    buildInitialTreeState(nodes, expandedIds),
  );
  const [sources, setSources] = useState<VivliostyleExportSources | null>(null);
  // undefined = 検出中
  const [detected, setDetected] = useState<
    VivliostyleDetectResult | null | undefined
  >(undefined);
  const [isSaving, setIsSaving] = useState(false);
  // ビルド/プレビューの実行状態はグローバル store（タブ切替 = unmount を
  // 跨いで進捗・中止・停止手段を維持する）。
  const status = useVivliostyleRunStore((s) => s.build);
  const logs = useVivliostyleRunStore((s) => s.logs);
  const startBuild = useVivliostyleRunStore((s) => s.startBuild);
  const abortBuild = useVivliostyleRunStore((s) => s.abortBuild);
  const previewRunning = useVivliostyleRunStore((s) => s.previewRunning);
  const startPreview = useVivliostyleRunStore((s) => s.startPreview);
  const stopPreview = useVivliostyleRunStore((s) => s.stopPreview);

  // 設定（settingsStore 経由で永続化）
  const {
    theme,
    format,
    binaryPath,
    setTheme,
    setFormat,
    setBinaryPath,
    tateChuYokoPolicy,
  } = useVivliostyleSettings();

  const redetect = useCallback(() => {
    setDetected(undefined);
    detectVivliostyle()
      .then(setDetected)
      .catch(() => setDetected(null));
  }, []);

  // マウント時（タブ表示時）に素材と CLI 検出を初期化する。ビルド/プレビューの
  // 実行状態は runStore がタブ切替を跨いで保持するためここでは触らないが、
  // 別プロジェクトのビルド状態（stale done の保存ボタン等）だけは破棄する。
  useEffect(() => {
    loadVivliostyleExportSources()
      .then(setSources)
      .catch(() => setSources(null));
    redetect();
    const run = useVivliostyleRunStore.getState();
    if (
      run.buildProjectId !== null &&
      run.buildProjectId !== getCurrentProjectId()
    ) {
      run.resetBuild();
    }
    // intentionally omit deps: runs only when the section mounts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { sceneCount, charCount, totalScenes } = calcExportStats(
    nodes,
    sources?.contentMap ?? {},
    treeState.checkedIds,
  );

  const cliAvailable = !!detected || binaryPath.trim() !== "";
  const canBuild =
    sceneCount > 0 &&
    cliAvailable &&
    sources !== null &&
    status.phase !== "running";
  // プレビューはビルド実行中でも押せる（files は押下時点のスナップショット）。
  const canPreview = sceneCount > 0 && cliAvailable && sources !== null;

  /** build / preview 共通の入力ファイル組み立て（呼出し時点のスナップショット）。 */
  function assembleFiles() {
    if (!sources) return null;
    const html = buildVivliostyleHtml({
      nodes,
      contentMap: sources.contentMap,
      checkedIds: treeState.checkedIds,
      projectTitle: sources.projectTitle,
      projectLanguage: sources.projectLanguage,
      // 縦中横の対象 run は執筆側の editor.tateChuYoko 設定に合わせる。
      tateChuYokoPolicy: tateChuYokoPolicy as TateChuYokoPolicy,
      resolveMentionName: currentCodexMentionResolver(),
    });
    return [
      { name: VIVLIOSTYLE_HTML_FILENAME, contents: html },
      {
        name: VIVLIOSTYLE_THEME_FILENAME,
        contents: VIVLIOSTYLE_THEMES[theme].css,
      },
    ];
  }

  async function handleBuild() {
    if (!canBuild) return;
    const files = assembleFiles();
    if (!files) return;
    await startBuild({
      files,
      format,
      binaryPath: binaryPath.trim() || null,
    });
  }

  async function handlePreview() {
    if (previewRunning) {
      await stopPreview();
      return;
    }
    if (!canPreview) return;
    const files = assembleFiles();
    if (!files) return;
    try {
      await startPreview({ files, binaryPath: binaryPath.trim() || null });
    } catch (err) {
      toast.error(t("vivliostyle.preview.failed", { error: String(err) }));
    }
  }

  async function handleSave() {
    if (status.phase !== "done" || isSaving) return;
    setIsSaving(true);
    try {
      const path = await saveVivliostyleOutput(status.outputToken);
      // null = ユーザーキャンセル（トーストは出さない）
      if (path) toast.success(t("vivliostyle.build.saved", { path }));
    } catch (err) {
      toast.error(t("vivliostyle.build.saveFailed", { error: String(err) }));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <>
      {/* ボディ: 左=シーン選択 / 右=CLI 状態・テーマ・形式・進捗 */}
      <div className="flex flex-1 overflow-hidden">
        <div className="w-1/2 min-w-[240px] overflow-hidden border-r border-border">
          <ExportTree nodes={nodes} state={treeState} onChange={setTreeState} />
        </div>
        <div className="flex min-w-[280px] flex-1 flex-col gap-4 overflow-y-auto p-4">
          <CliStatusBanner
            detected={detected}
            binaryPath={binaryPath}
            onBinaryPathChange={setBinaryPath}
            onRedetect={redetect}
          />
          <ThemePicker
            value={theme}
            onChange={setTheme}
            disabled={status.phase === "running"}
          />
          <FormatPicker
            value={format}
            onChange={setFormat}
            disabled={status.phase === "running"}
          />
          <BuildProgress
            status={status}
            logs={logs}
            onAbort={() => void abortBuild()}
            onSave={() => void handleSave()}
            isSaving={isSaving}
          />
        </div>
      </div>

      {/* フッター */}
      <BuildFooter
        sceneCount={sceneCount}
        totalScenes={totalScenes}
        charCount={charCount}
        isRunning={status.phase === "running"}
        canBuild={canBuild}
        onBuild={() => void handleBuild()}
        previewRunning={previewRunning}
        canPreview={canPreview}
        onPreview={() => void handlePreview()}
      />
    </>
  );
}
