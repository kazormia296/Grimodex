import { lazy, Suspense, useEffect, useCallback, useState } from "react";
import { Toaster, toast } from "sonner";

import { WelcomeScreen } from "@/features/workspace/WelcomeScreen";
import { LauncherScreen } from "@/features/workspace/LauncherScreen";
import { WorkspaceMenu } from "@/features/workspace/WorkspaceMenu";
import { ProjectMenu } from "@/features/project/ProjectMenu";
import { WorkspaceTrustDialog } from "@/features/workspace/WorkspaceTrustDialog";
import { EulaConsentDialog } from "@/features/legal/EulaConsentDialog";
import { ReleaseNotesDialog } from "@/features/release-notes/ReleaseNotesDialog";
import { useReleaseNotesGate } from "@/features/release-notes/useReleaseNotesGate";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useSyncUiScale } from "@/features/workspace/useSyncUiScale";
import type { SettingsCategory } from "@/features/settings/types";
import type { TransferTab } from "@/features/transfer/TransferDialog";
import { PanelToggleDropdown } from "@/features/layout/PanelToggleDropdown";
import { LayoutPresetDropdown } from "@/features/layout/LayoutPresetDropdown";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { LayoutShell } from "@/features/layout/LayoutShell";
import {
  CommandCenterBar,
  useBarStore,
  useResultsPanelStore,
} from "@/features/commandCenter";
import { ReindexProgressToast } from "@/features/semantic-search/ReindexProgressToast";
import { PostEffectProgressToast } from "@/features/post-effect/PostEffectProgressToast";
import { useReindexProgressListener } from "@/features/semantic-search/useReindexProgressListener";
import { ModelDownloadToast } from "@/features/semantic-search/ModelDownloadToast";
import { useModelDownloadListener } from "@/features/semantic-search/useModelDownloadListener";
import { UpdateToast } from "@/features/updater/UpdateToast";
import { useUpdateChecker } from "@/features/updater/useUpdateChecker";
import { UpdateDot } from "@/features/updater/UpdateDot";
import { useUpdatePending } from "@/features/updater/updaterStore";
import { ensureSemanticIndexesOnOpen } from "@/features/semantic-search/autoIndex";
import { useExternalMountListener } from "@/features/external-mount/useExternalMountListener";
import { ReloadConflictDialog } from "@/features/external-mount/components/ReloadConflictDialog";
import { initializeExternalMounts } from "@/features/external-mount/mountManager";
import { useLicenseStore } from "@/features/license/store";
import { useLicenseStateListener } from "@/features/license/useLicenseStateListener";
import { useDebugLogStore } from "@/lib/debugLog";
import {
  isInlineAiPending,
  guardInlineAiPending,
} from "@/features/editor/inlineAi/pendingGuard";
import { DebugLogViewer } from "@/lib/DebugLogViewer";
import { Settings, FileOutput } from "lucide-react";
import type { ExportDialogMode } from "@/features/export/ExportDialog";
import {
  COLOR_THEMES,
  DEFAULT_COLOR_THEME,
  THEME_CSS_VARS,
} from "@/lib/colorThemes";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { GrimodexLogo } from "@/components/GrimodexLogo";
import { HeaderBarLayout } from "@/components/HeaderBarLayout";
import { LiveRegion } from "@/components/a11y/LiveRegion";
import { useAiStreamingAnnouncer } from "@/features/chat/useAiStreamingAnnouncer";
import i18next from "@/lib/i18n";
import { useTranslation } from "react-i18next";
import { WindowControls } from "@/components/WindowControls";
import { TitleBar } from "@/components/TitleBar";
import { useTabStore } from "@/features/editor/tabStore";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { ZenModeController } from "@/features/editor/ZenModeController";
import { BackgroundStudioHost } from "@/features/editor/background/BackgroundStudioHost";
import { useTreeStore } from "@/features/tree/treeStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { HistoryButtons } from "@/features/history/HistoryButtons";
import {
  useProjectStore,
  getCurrentProjectId,
} from "@/features/project/projectStore";
import { getProject } from "@/features/project/api";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { isMac, matchesMod } from "@/lib/platform";
import {
  PANEL_COMMANDS,
  getMergedBindings,
  matchesBinding,
} from "@/features/settings/keybindings";
import { onWindowCloseRequested } from "@/lib/windowControls";
import {
  getScreenshotPanelId,
  isScreenshotCapture,
  bootstrapScreenshotWorkspace,
  applyScreenshotUiState,
  markScreenshotStageReady,
  clearScreenshotStageReady,
} from "@/screenshot-scenes/screenshotBootstrap";
import {
  isPanelWindow,
  getPanelWindowTarget,
} from "@/features/layout/multiwindow/panelWindow";
import { useCodexSelectionSync } from "@/features/codex/multiwindow/codexSelectionRouting";
import { startCodexLockListener } from "@/features/codex/multiwindow/codexEditLockStore";
import { cn } from "@/lib/utils";
import { useImeExportSync } from "@/features/ime/useImeExportSync";
import { AdaptiveWorkspaceShell } from "@/features/layout/adaptive/AdaptiveWorkspaceShell";
import { ConnectedMobileWorkspaceSurface } from "@/features/layout/adaptive/MobileWorkspaceSurfaces";
import { shouldUseAdaptiveWorkspace } from "@/features/layout/adaptive/adaptiveWorkspacePolicy";
import { useRuntimeCapabilities } from "@/runtime/runtimeCapabilitiesContext";
import {
  consumeWebEditorHandoffRequest,
  requestWebEditorHandoffImport,
  subscribeWebEditorHandoffRequests,
} from "@/features/import/webEditorHandoffRequest";

const SettingsDialog = lazy(() =>
  import("@/features/settings/SettingsDialog").then((m) => ({
    default: m.SettingsDialog,
  })),
);
const ZenAmbientBackdrop = lazy(() =>
  import("@/features/editor/ZenAmbientBackdrop").then((module) => ({
    default: module.ZenAmbientBackdrop,
  })),
);
const ProjectSnapshotModal = lazy(() =>
  import("@/features/revision/ProjectSnapshotModal").then((m) => ({
    default: m.ProjectSnapshotModal,
  })),
);
const TransferDialog = lazy(() =>
  import("@/features/transfer/TransferDialog").then((m) => ({
    default: m.TransferDialog,
  })),
);
const ExportDialog = lazy(() =>
  import("@/features/export/ExportDialog").then((m) => ({
    default: m.ExportDialog,
  })),
);
const SampleTour = lazy(() =>
  import("@/features/onboarding/SampleTour").then((m) => ({
    default: m.SampleTour,
  })),
);
const HostedEditorTrialBar = lazy(() =>
  import("@/features/hosted-editor/HostedEditorTrialBar").then((m) => ({
    default: m.HostedEditorTrialBar,
  })),
);
const HostedEditorHandoffDialog = lazy(() =>
  import("@/features/hosted-editor/HostedEditorHandoffDialog").then((m) => ({
    default: m.HostedEditorHandoffDialog,
  })),
);
const WebEditorWorkspaceImportDialog = lazy(() =>
  import("@/features/import/WebEditorWorkspaceImportDialog").then((m) => ({
    default: m.WebEditorWorkspaceImportDialog,
  })),
);

/* ── App root ── */

function applyTheme(theme: string, colorTheme?: string) {
  const html = document.documentElement;

  // Light/dark mode
  if (theme === "dark") {
    html.classList.add("dark");
  } else if (theme === "light") {
    html.classList.remove("dark");
  } else {
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    html.classList.toggle("dark", prefersDark);
  }

  // Named color theme
  const isDark = html.classList.contains("dark");
  const resolvedId = colorTheme ?? DEFAULT_COLOR_THEME;
  const themeObj = COLOR_THEMES.find((t) => t.id === resolvedId);

  if (!themeObj) {
    // Unknown theme — remove overrides, fall back to CSS defaults
    for (const prop of THEME_CSS_VARS) {
      html.style.removeProperty(prop);
    }
    return;
  }

  const palette = isDark ? themeObj.dark : themeObj.light;
  for (const prop of THEME_CSS_VARS) {
    html.style.setProperty(prop, palette[prop]);
  }
}

function App() {
  const runtimeCapabilities = useRuntimeCapabilities();
  const view = useWorkspaceStore((s) => s.view);
  const activeWorkspacePath = useWorkspaceStore((s) => s.activeWorkspacePath);
  const workspaceOpenRevision = useWorkspaceStore(
    (s) => s.workspaceOpenRevision,
  );
  const workspaceSwitchInProgress = useWorkspaceStore(
    (s) => s.workspaceSwitchInProgress,
  );
  const workspaceHydrated = useWorkspaceStore((s) => s.workspaceHydrated);
  const initialize = useWorkspaceStore((s) => s.initialize);
  const theme = useWorkspaceStore((s) => s.globalSettings?.theme ?? "system");
  const colorTheme = useWorkspaceStore((s) => s.globalSettings?.colorTheme);
  const uiLanguage = useWorkspaceStore(
    (s) => s.globalSettings?.uiLanguage ?? "ja",
  );
  const { t } = useTranslation();
  const [showWebEditorImport, setShowWebEditorImport] = useState(false);

  useEffect(
    () =>
      subscribeWebEditorHandoffRequests(() => {
        if (consumeWebEditorHandoffRequest()) {
          setShowWebEditorImport(true);
        }
      }),
    [],
  );

  // semantic_reindex_all の進行状況 event を購読 (App 起動中ずっと 1 度だけ)。
  useReindexProgressListener();
  // オンデマンド埋め込みモデル DL の進行状況 event を購読。完了後に back-index を再実行。
  useModelDownloadListener();
  // アプリ更新: 起動 ~10 秒後にサイレント check() → 更新があればトーストを出す。
  useUpdateChecker();
  useReleaseNotesGate();
  useExternalMountListener();
  useLicenseStateListener();

  // プロジェクトを開いたら codex / events / chat / scene の未 index を自動補完する。
  // status は embedder 不要の軽量チェック → 未 index がある時だけ背景 reindex。
  // workspace path も依存に含め、異なるDBが同じ default-project
  // id を持つ場合も必ず別 scope として起動する。panel 窓は関数内で no-op。
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  useEffect(() => {
    if (
      runtimeCapabilities.localAi &&
      workspaceHydrated &&
      !workspaceSwitchInProgress &&
      currentProjectId &&
      activeWorkspacePath
    ) {
      void ensureSemanticIndexesOnOpen(currentProjectId, activeWorkspacePath);
    }
  }, [
    activeWorkspacePath,
    currentProjectId,
    workspaceHydrated,
    workspaceOpenRevision,
    workspaceSwitchInProgress,
    runtimeCapabilities.localAi,
  ]);

  // Sync uiLanguage setting → i18next
  useEffect(() => {
    if (i18next.language !== uiLanguage) {
      void i18next.changeLanguage(uiLanguage);
    }
  }, [uiLanguage]);

  // 未確定の inline-AI diff があるままアプリを終了させない。Tauri の
  // onCloseRequested は OS / ネイティブタイトルバー / カスタム閉じるボタンの
  // すべての close を捕捉できる唯一の安全網 (Mac は WindowControls 非表示)。
  // veto + toast でユーザーに Accept/Reject を促す。web ビルドは beforeunload。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      try {
        const un = await onWindowCloseRequested((event) => {
          if (guardInlineAiPending()) event.preventDefault();
        });
        if (disposed) un();
        else unlisten = un;
      } catch {
        // 非 Tauri / API 不在: beforeunload に任せる
      }
    })();
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isInlineAiPending()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  // Apply theme reactively — globalSettings is loaded from global-settings.json
  // (no workspace DB needed), so this works before any workspace is opened.
  useEffect(() => {
    applyTheme(theme, colorTheme);
  }, [theme, colorTheme]);

  // Re-apply when OS light/dark preference changes while theme === "system"
  useEffect(() => {
    if (theme !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system", colorTheme);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [theme, colorTheme]);

  // Sync attribution highlight opacity setting → CSS variable
  const attributionOpacity = useSettingsStore((s) =>
    s.getNumber("display.attributionHighlightOpacity", 10),
  );
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--attribution-pct",
      `${attributionOpacity * 2}%`,
    );
  }, [attributionOpacity]);

  // Sync UI font setting → --ui-font CSS variable (アプリ全体の UI 書体)。
  // index.css の --font-sans / body が var(--ui-font, ...) を参照する。
  // cache は DEFAULT_SETTINGS で seed 済みなので workspace 未オープンでも効く。
  const uiFontFamily = useSettingsStore((s) => s.get("display.uiFontFamily"));
  useEffect(() => {
    const html = document.documentElement;
    const v = uiFontFamily.trim();
    if (v) {
      html.style.setProperty("--ui-font", v);
    } else {
      html.style.removeProperty("--ui-font");
    }
  }, [uiFontFamily]);

  useEffect(() => {
    initialize();
  }, [initialize]);

  useSyncUiScale();

  // Ctrl+Shift+D toggles debug log viewer
  const toggleDebugLog = useDebugLogStore((s) => s.toggle);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (matchesMod(e) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        toggleDebugLog();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleDebugLog]);

  return (
    <>
      <Toaster position="bottom-right" richColors />
      <LiveRegion />
      {view === "loading" && (
        <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background text-foreground">
          <TitleBar />
          <GrimodexLogo height={40} className="text-foreground" />
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        </div>
      )}
      {view === "welcome" && <WelcomeScreen />}
      {view === "launcher" && <LauncherScreen />}
      {view === "editor" && <EditorScreen key={activeWorkspacePath ?? ""} />}
      <WorkspaceTrustDialog />
      <EulaConsentDialog />
      <ReleaseNotesDialog />
      {runtimeCapabilities.genericProjectTransfer && (
        <Suspense fallback={null}>
          <WebEditorWorkspaceImportDialog
            open={showWebEditorImport}
            onClose={() => setShowWebEditorImport(false)}
          />
        </Suspense>
      )}
      <DebugLogViewer />
    </>
  );
}

function EditorScreen() {
  const runtimeCapabilities = useRuntimeCapabilities();
  const screenshotPanelId = getScreenshotPanelId();
  const panelWindow = isPanelWindow();
  const zenMode = useCursorSettingsStore((state) => state.zenMode);
  const editorZenMode = zenMode && !panelWindow && !screenshotPanelId;
  const adaptiveWorkspaceEnabled = shouldUseAdaptiveWorkspace({
    featureEnabled: import.meta.env.VITE_ADAPTIVE_WORKSPACE !== "false",
    panelWindow,
    screenshotPanelId,
  });
  const { t } = useTranslation();
  // 更新が保留中か (⚙ ボタンの SR ラベル用。UpdateDot も同じ store を読む)。
  const updatePending = useUpdatePending();
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialCategory, setSettingsInitialCategory] =
    useState<SettingsCategory>("project");
  const [showExport, setShowExport] = useState(false);
  // エクスポートダイアログを特定タブで開く要求。seq（nonce）の変化で
  // ダイアログ既開時の再要求にもタブ切替が効く（undefined なら前回タブ維持）。
  const [exportModeRequest, setExportModeRequest] = useState<
    { mode: ExportDialogMode; seq: number } | undefined
  >(undefined);
  const [showSnapshotModal, setShowSnapshotModal] = useState(false);
  const [showTransferDialog, setShowTransferDialog] = useState(false);
  const [showHostedHandoff, setShowHostedHandoff] = useState(false);
  const [transferTab, setTransferTab] = useState<TransferTab>("import");
  const { setShowSampleTour, seedAndOpenSample } = useWorkspaceStore();
  const showSampleTour = useWorkspaceStore((s) => s.showSampleTour);
  const mac = isMac();

  // IME dictionary snapshot + active-project pointer (Tauri/Electron/browser-safe).
  useImeExportSync();

  // AI 応答ストリームの開始/完了を SR へ読み上げる (a11y)。単一マウント。
  useAiStreamingAnnouncer();

  // 窓間の Codex 選択連動（別窓 Codex 編集。codex:select-entry を購読）。
  useCodexSelectionSync();

  // 窓間の Codex 編集 advisory lock 購読を起動（パネル未表示でも取りこぼさない）。
  useEffect(() => {
    startCodexLockListener();
  }, []);

  useEffect(() => {
    if (!runtimeCapabilities.externalMount) return;
    void initializeExternalMounts().catch(() => {});
  }, [runtimeCapabilities.externalMount]);

  // ライセンス状態の初期化（refresh は内部 catch 済みで reject しない）。
  // 取得まで・失敗時はゲートが fail-open なので執筆は止まらない。
  useEffect(() => {
    if (!runtimeCapabilities.secureSecretStore) return;
    void useLicenseStore.getState().refresh();
  }, [runtimeCapabilities.secureSecretStore]);

  // Re-run SampleTour: open/re-seed sample workspace then start tour
  useEffect(() => {
    function onRestartTutorial() {
      setShowSettings(false);
      const lang =
        useWorkspaceStore.getState().globalSettings?.uiLanguage ?? "ja";
      const policy =
        useWorkspaceStore.getState().globalSettings?.defaultAiPolicy ??
        JSON.stringify({
          preset: "off",
          toggles: { chat: false, bodyWrite: false, analysis: false },
        });
      void seedAndOpenSample(lang, policy).then(() => {
        setShowSampleTour(true);
      });
    }
    window.addEventListener("restart-sample-tour", onRestartTutorial);
    return () =>
      window.removeEventListener("restart-sample-tour", onRestartTutorial);
  }, [seedAndOpenSample, setShowSampleTour]);

  // Project メタデータ（執筆言語・Phase resolution mode）を適用し、
  // screenshot キャプチャ用のステージを初期化する
  useEffect(() => {
    void (async () => {
      clearScreenshotStageReady();
      if (isScreenshotCapture()) {
        // 撮影ステージの Workspace は単一のシード済み Project。loadProject() は
        // reloadProjectData() でタブ・チャット・マップの in-memory 状態を破棄し、
        // それを bootstrap が復元しきれないため、メタデータだけ直接適用する。
        const project = await getProject(getCurrentProjectId());
        if (project?.language) {
          document.documentElement.lang = project.language;
          // 執筆言語の既定（本文フォント Literata・行間・スマートクォート等）を
          // 反映する。loadProject() を通さない撮影ブートでも en の体裁を揃える。
          useSettingsStore.getState().applyProjectLanguage(project.language);
        }
        if (project?.phaseResolutionMode) {
          usePhaseStore
            .getState()
            .setResolutionMode(project.phaseResolutionMode);
        }
        await bootstrapScreenshotWorkspace();
        applyScreenshotUiState();
        markScreenshotStageReady();
        return;
      }
      await useProjectStore.getState().loadProject(getCurrentProjectId());
    })();
  }, []);

  // ワークスペース切替時は前ワークスペースの Undo command を実行できないので clear する
  useEffect(() => {
    useGlobalHistoryStore.getState().clear();
  }, []);
  const { togglePanel, initializeLayout } = useLayoutStore();

  useEffect(() => {
    void initializeLayout();
  }, [initializeLayout]);

  // Open settings dialog when triggered by error handler or other sources
  useEffect(() => {
    function onOpenSettings(e: Event) {
      const detail = (e as CustomEvent<{ category?: SettingsCategory }>).detail;
      setSettingsInitialCategory(detail?.category ?? "project");
      setShowSettings(true);
    }
    window.addEventListener("open-settings", onOpenSettings);
    return () => window.removeEventListener("open-settings", onOpenSettings);
  }, []);

  // Open export dialog via custom event (e.g. from Settings > Data)
  useEffect(() => {
    function onOpenExport() {
      if (!runtimeCapabilities.genericProjectTransfer) return;
      setShowExport(true);
    }
    window.addEventListener("open-export-dialog", onOpenExport);
    return () => window.removeEventListener("open-export-dialog", onOpenExport);
  }, [runtimeCapabilities.genericProjectTransfer]);

  // Open export dialog on the book (Vivliostyle) tab via custom event
  // (command palette)
  useEffect(() => {
    function onOpenVivliostyle() {
      if (!runtimeCapabilities.genericProjectTransfer) return;
      setExportModeRequest((prev) => ({
        mode: "book",
        seq: (prev?.seq ?? 0) + 1,
      }));
      setShowExport(true);
    }
    window.addEventListener("open-vivliostyle-dialog", onOpenVivliostyle);
    return () =>
      window.removeEventListener("open-vivliostyle-dialog", onOpenVivliostyle);
  }, [runtimeCapabilities.genericProjectTransfer]);

  // Keyboard shortcuts (Ctrl+Alt+*)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Ctrl+Shift+E: エクスポートダイアログ開閉
      if (
        runtimeCapabilities.genericProjectTransfer &&
        matchesMod(e) &&
        e.shiftKey &&
        e.key.toLowerCase() === "e"
      ) {
        e.preventDefault();
        setShowExport((v) => !v);
        return;
      }

      // Ctrl+Shift+F: 検索パネル (command-center-results) を開き、パネル内 input にフォーカス。
      // TipTap (features/editor/extensions.ts) が選択あり時に Mod-Shift-f を
      // foreshadow picker に使うため、defaultPrevented を尊重して二重発火を避ける。
      if (matchesMod(e) && e.shiftKey && e.key.toLowerCase() === "f") {
        if (e.defaultPrevented) return;
        e.preventDefault();
        useLayoutStore.getState().showPanel("command-center-results");
        useResultsPanelStore.getState().requestFocus();
        return;
      }

      // Ctrl+Shift+P: VSCode コマンドパレット相当。CommandCenter バーに
      // focus を渡し、`> ` prefix で command mode に切替えて起動する。
      if (matchesMod(e) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        const cc = useBarStore.getState();
        cc.setQuery("> ");
        cc.setOpen(true);
        cc.requestFocus();
        return;
      }

      // Configurable shortcuts (Settings → Keys). Panel focus/toggle, open
      // settings and editor split are matched against the merged bindings so a
      // user rebind takes effect at runtime. matchesBinding reads the physical
      // key via e.code, so macOS ⌥ glyph composition does not break the lookup.
      const merged = getMergedBindings();
      const mac = isMac();

      for (const pc of PANEL_COMMANDS) {
        if (matchesBinding(e, merged[pc.id] ?? "", mac)) {
          e.preventDefault();
          togglePanel(pc.panel);
          if (pc.panel === "codex-quick") {
            requestAnimationFrame(() => {
              useLayoutStore.getState().showPanel("codex-quick");
            });
          }
          return;
        }
      }

      if (matchesBinding(e, merged.openSettings ?? "", mac)) {
        e.preventDefault();
        setSettingsInitialCategory("project");
        setShowSettings(true);
        return;
      }

      const splitDir = matchesBinding(e, merged.splitVertical ?? "", mac)
        ? "right"
        : matchesBinding(e, merged.splitHorizontal ?? "", mac)
          ? "below"
          : null;
      if (splitDir) {
        e.preventDefault();
        const tabs = useTabStore.getState();
        if (tabs.activeTabId) {
          tabs.openInSecondaryGroupDirectional(tabs.activeTabId, splitDir);
        } else {
          tabs.createEmptySecondaryGroup(splitDir);
        }
      }
    },
    [runtimeCapabilities.genericProjectTransfer, togglePanel],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Global Undo/Redo. Focus-based routing: TipTap / native form fields keep their built-in undo.
  useEffect(() => {
    function onUndoRedo(e: KeyboardEvent) {
      if (e.defaultPrevented) return;

      const ae = document.activeElement as HTMLElement | null;
      if (ae) {
        const tag = ae.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (ae.isContentEditable) return;
        if (ae.closest('.ProseMirror, [contenteditable="true"]')) return;
      }

      const isMod = e.ctrlKey || e.metaKey;
      if (!isMod) return;
      const key = e.key.toLowerCase();

      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        void useGlobalHistoryStore
          .getState()
          .undo()
          .catch(() => {
            toast.error(
              i18next.t("history.undoError", "元に戻す操作に失敗しました"),
            );
          });
        return;
      }
      if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        void useGlobalHistoryStore
          .getState()
          .redo()
          .catch(() => {
            toast.error(
              i18next.t("history.redoError", "やり直し操作に失敗しました"),
            );
          });
      }
    }
    window.addEventListener("keydown", onUndoRedo);
    return () => window.removeEventListener("keydown", onUndoRedo);
  }, []);

  // Ctrl+Tab / Ctrl+Shift+Tab: switch tabs in the active editor group
  useEffect(() => {
    function onTabSwitch(e: KeyboardEvent) {
      const merged = getMergedBindings();
      const mac = isMac();
      const isPrev = matchesBinding(e, merged.prevTab ?? "", mac);
      const isNext = matchesBinding(e, merged.nextTab ?? "", mac);
      if (!isPrev && !isNext) return;
      e.preventDefault();

      const {
        activeGroupIndex,
        tabs,
        activeTabId,
        secondaryTabs,
        secondaryActiveTabId,
        setActiveTab,
        setSecondaryActiveTab,
      } = useTabStore.getState();

      const currentTabs = activeGroupIndex === 0 ? tabs : secondaryTabs;
      const currentActiveId =
        activeGroupIndex === 0 ? activeTabId : secondaryActiveTabId;

      if (currentTabs.length < 2) return;

      const currentIdx = currentTabs.findIndex(
        (t) => t.nodeId === currentActiveId,
      );
      if (currentIdx === -1) return;

      const nextIdx = isPrev
        ? (currentIdx - 1 + currentTabs.length) % currentTabs.length
        : (currentIdx + 1) % currentTabs.length;

      const nextTab = currentTabs[nextIdx];
      if (activeGroupIndex === 0) {
        setActiveTab(nextTab.nodeId);
      } else {
        setSecondaryActiveTab(nextTab.nodeId);
      }
      if (nextTab.contentType === "scene") {
        useTreeStore.getState().setActiveScene(nextTab.nodeId);
      }
    }

    window.addEventListener("keydown", onTabSwitch);
    return () => window.removeEventListener("keydown", onTabSwitch);
  }, []);

  return (
    <div
      className="app-shell flex h-screen flex-col"
      data-platform-mac={mac ? "true" : undefined}
      data-zen-mode={editorZenMode ? "true" : undefined}
    >
      {!editorZenMode && (
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {t("a11y.skipToContent")}
        </a>
      )}
      {!editorZenMode &&
        (panelWindow ? (
          // 別フローティング窓: ヘッダはドラッグ領域 + ウィンドウ操作のみに簡素化
          // (ロゴ/エクスポート/設定/プロジェクト切替はメイン窓の領分で、別窓に
          // 出すとややこしいため)。WindowControls は getCurrentWindow() で自窓を
          // 操作する。mac は decorations 側の扱いが別途必要(現状 Windows 前提)。
          <header
            data-header-bar
            className="flex h-9 shrink-0 items-center border-b border-border"
          >
            <div data-tauri-drag-region className="h-full flex-1" />
            {!mac && <WindowControls />}
          </header>
        ) : (
          <HeaderBarLayout
            mac={mac}
            className={cn(getScreenshotPanelId() && "no-screenshot")}
            left={
              <>
                <GrimodexLogo height={24} className="text-foreground" />
                <WorkspaceMenu />
                <ProjectMenu
                  onOpenImport={
                    runtimeCapabilities.localFileImport
                      ? () => {
                          setTransferTab("import");
                          setShowTransferDialog(true);
                        }
                      : undefined
                  }
                  onOpenExport={
                    runtimeCapabilities.genericProjectTransfer
                      ? () => {
                          setTransferTab("zip");
                          setShowTransferDialog(true);
                        }
                      : undefined
                  }
                  onOpenSnapshot={() => setShowSnapshotModal(true)}
                  onOpenWebEditorHandoff={
                    runtimeCapabilities.genericProjectTransfer
                      ? requestWebEditorHandoffImport
                      : undefined
                  }
                />
                <HistoryButtons />
                {runtimeCapabilities.genericProjectTransfer && (
                  <button
                    type="button"
                    aria-label={t("app.exportLabel")}
                    title={t("app.exportTitle")}
                    onClick={() => setShowExport((v) => !v)}
                    className="flex h-8 shrink-0 items-center gap-1.5 rounded px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <FileOutput className="h-4 w-4 shrink-0" />
                    <span className="hidden whitespace-nowrap text-sm xl:inline">
                      {t("app.exportLabel")}
                    </span>
                  </button>
                )}
              </>
            }
            center={<CommandCenterBar />}
            right={
              <>
                <LayoutPresetDropdown />
                <PanelToggleDropdown />
                <button
                  type="button"
                  aria-label={
                    updatePending
                      ? t("app.settingsLabelUpdateAvailable", {
                          defaultValue: "設定（更新があります）",
                        })
                      : t("app.settingsLabel")
                  }
                  title={t("app.settingsTitle")}
                  onClick={() => {
                    setSettingsInitialCategory("project");
                    setShowSettings(true);
                  }}
                  className="relative flex h-8 shrink-0 items-center gap-1.5 rounded px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Settings className="h-4 w-4 shrink-0" />
                  <span className="hidden whitespace-nowrap text-sm xl:inline">
                    {t("app.settingsLabel")}
                  </span>
                  <UpdateDot className="absolute right-1 top-1" />
                </button>
                {!mac && (
                  <>
                    <div className="h-4 w-px bg-border" />
                    <WindowControls />
                  </>
                )}
              </>
            }
          />
        ))}
      <Suspense fallback={null}>
        {showSettings && (
          <SettingsDialog
            open
            onClose={() => setShowSettings(false)}
            initialCategory={settingsInitialCategory}
          />
        )}
        {runtimeCapabilities.genericProjectTransfer && showExport && (
          <ExportDialog
            open
            onClose={() => setShowExport(false)}
            modeRequest={exportModeRequest}
          />
        )}
        {showSnapshotModal && (
          <ProjectSnapshotModal
            open
            onClose={() => setShowSnapshotModal(false)}
          />
        )}
        {runtimeCapabilities.localFileImport && showTransferDialog && (
          <TransferDialog
            open
            tab={transferTab}
            onTabChange={setTransferTab}
            onClose={() => setShowTransferDialog(false)}
          />
        )}
        {showSampleTour && <SampleTour />}
      </Suspense>
      {!runtimeCapabilities.genericProjectTransfer &&
        runtimeCapabilities.browserDirectAi && (
          <Suspense fallback={null}>
            <HostedEditorHandoffDialog
              open={showHostedHandoff}
              onClose={() => setShowHostedHandoff(false)}
              downloadHandoff={async () => {
                const { downloadHostedEditorHandoff } =
                  await import("@/features/hosted-editor/downloadHostedEditorHandoff");
                return downloadHostedEditorHandoff();
              }}
            />
          </Suspense>
        )}
      <ReindexProgressToast />
      <ModelDownloadToast />
      <PostEffectProgressToast />
      <UpdateToast />
      <ReloadConflictDialog />
      {!runtimeCapabilities.genericProjectTransfer &&
        runtimeCapabilities.browserDirectAi && (
          <Suspense fallback={null}>
            <HostedEditorTrialBar
              onContinue={() => setShowHostedHandoff(true)}
            />
          </Suspense>
        )}
      <main
        id="main-content"
        tabIndex={-1}
        className="relative isolate flex min-h-0 flex-1 overflow-hidden outline-none"
      >
        <Suspense fallback={null}>
          <ZenAmbientBackdrop active={editorZenMode} />
        </Suspense>
        {adaptiveWorkspaceEnabled ? (
          <AdaptiveWorkspaceShell
            zenMode={editorZenMode}
            editor={
              <LayoutShell
                hidden={false}
                soloPanelId={null}
                zenMode={editorZenMode}
              />
            }
            sceneTitle={t("app.title")}
            saveState=""
            renderMobileSurface={(surface) => (
              <ConnectedMobileWorkspaceSurface surface={surface} />
            )}
          />
        ) : (
          <LayoutShell
            hidden={Boolean(screenshotPanelId) || panelWindow}
            soloPanelId={screenshotPanelId ?? getPanelWindowTarget()}
            zenMode={editorZenMode}
          />
        )}
      </main>
      <ZenModeController />
      <BackgroundStudioHost zenMode={editorZenMode} />
    </div>
  );
}

export default App;
