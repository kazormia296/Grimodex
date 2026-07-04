import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, X } from "lucide-react";
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
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
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
import { useVivliostyleBuild } from "./useVivliostyleBuild";
import { useVivliostyleSettings } from "./useVivliostyleSettings";
import { ThemePicker } from "./ThemePicker";
import { FormatPicker } from "./FormatPicker";
import { CliStatusBanner } from "./CliStatusBanner";
import { BuildProgress } from "./BuildProgress";
import { BuildFooter } from "./BuildFooter";

// ────────────────────────────────────────────────────────────────────
// 本の書き出し（Vivliostyle）ダイアログ。
// シーン選択（ExportTree 再利用）＋テーマ/形式選択＋ビルド進捗。
// プレビューは PR3 の領分でここには無い。
// ────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
}

export function VivliostyleDialog({ open, onClose }: Props) {
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
  const { status, logs, start, abort, reset } = useVivliostyleBuild();

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

  // 開いた時に状態を初期化
  useEffect(() => {
    if (!open) return;
    setTreeState(buildInitialTreeState(nodes, expandedIds));
    loadVivliostyleExportSources()
      .then(setSources)
      .catch(() => setSources(null));
    redetect();
    reset();
    // intentionally omit deps: runs only when dialog opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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

  async function handleBuild() {
    if (!canBuild || !sources) return;
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
    await start({
      files: [
        { name: VIVLIOSTYLE_HTML_FILENAME, contents: html },
        {
          name: VIVLIOSTYLE_THEME_FILENAME,
          contents: VIVLIOSTYLE_THEMES[theme].css,
        },
      ],
      format,
      binaryPath: binaryPath.trim() || null,
    });
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
    <AnimatedOverlay
      open={open}
      onClose={onClose}
      testId="vivliostyle-dialog"
      className="flex h-[640px] w-[860px] min-h-[400px] min-w-[560px] max-h-[90vh] max-w-[90vw] resize flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl"
    >
      {/* ヘッダー */}
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <BookOpen className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold text-foreground">
          {t("vivliostyle.title")}
        </h2>
        <div className="flex-1" />
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

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
            onAbort={() => void abort()}
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
      />
    </AnimatedOverlay>
  );
}
