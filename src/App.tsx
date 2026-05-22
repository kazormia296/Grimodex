import { useEffect, useCallback, useState } from "react";
import { Toaster, toast } from "sonner";

import { WelcomeScreen } from "@/features/workspace/WelcomeScreen";
import { LauncherScreen } from "@/features/workspace/LauncherScreen";
import { WorkspaceMenu } from "@/features/workspace/WorkspaceMenu";
import { ProjectMenu } from "@/features/project/ProjectMenu";
import { WorkspaceTrustDialog } from "@/features/workspace/WorkspaceTrustDialog";
import { EulaConsentDialog } from "@/features/legal/EulaConsentDialog";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useSyncUiScale } from "@/features/workspace/useSyncUiScale";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import type { SettingsCategory } from "@/features/settings/types";
import { ProjectSnapshotModal } from "@/features/revision/ProjectSnapshotModal";
import { NovelcrafterImportDialog } from "@/features/import/NovelcrafterImportDialog";
import { PanelToggleDropdown } from "@/features/layout/PanelToggleDropdown";
import { LayoutPresetDropdown } from "@/features/layout/LayoutPresetDropdown";
import { useLayoutStore, type PanelId } from "@/features/layout/layoutStore";
import { LayoutShell } from "@/features/layout/LayoutShell";
import {
  CommandCenterBar,
  useCommandCenterStore,
} from "@/features/commandCenter";
import { ReindexProgressToast } from "@/features/semantic-search/ReindexProgressToast";
import { useReindexProgressListener } from "@/features/semantic-search/useReindexProgressListener";
import { CommandPalette } from "@/features/commandPalette/CommandPalette";
import { useDebugLogStore } from "@/lib/debugLog";
import { DebugLogViewer } from "@/lib/DebugLogViewer";
import { Settings, FileOutput } from "lucide-react";
import { ExportDialog } from "@/features/export/ExportDialog";
import {
  COLOR_THEMES,
  DEFAULT_COLOR_THEME,
  THEME_CSS_VARS,
} from "@/lib/colorThemes";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { GrimodexLogo } from "@/components/GrimodexLogo";
import i18next from "@/lib/i18n";
import { useTranslation } from "react-i18next";
import { WindowControls } from "@/components/WindowControls";
import { TitleBar } from "@/components/TitleBar";
import { useTabStore } from "@/features/editor/tabStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { HistoryButtons } from "@/features/history/HistoryButtons";
import {
  useProjectStore,
  getCurrentProjectId,
} from "@/features/project/projectStore";
import { getProject } from "@/features/project/api";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { invoke } from "@/lib/tauri";
import { SampleTour } from "@/features/onboarding/SampleTour";
import {
  getScreenshotPanelId,
  isScreenshotCapture,
  bootstrapScreenshotWorkspace,
  applyScreenshotUiState,
  markScreenshotStageReady,
  clearScreenshotStageReady,
} from "@/screenshot-scenes/screenshotBootstrap";
import { cn } from "@/lib/utils";

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

function isMacPlatform() {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const data = nav.userAgentData;
  const platform = data?.platform ?? navigator.platform ?? "";
  return /mac/i.test(platform);
}

function App() {
  const view = useWorkspaceStore((s) => s.view);
  const activeWorkspacePath = useWorkspaceStore((s) => s.activeWorkspacePath);
  const initialize = useWorkspaceStore((s) => s.initialize);
  const theme = useWorkspaceStore((s) => s.globalSettings?.theme ?? "system");
  const colorTheme = useWorkspaceStore((s) => s.globalSettings?.colorTheme);
  const uiLanguage = useWorkspaceStore(
    (s) => s.globalSettings?.uiLanguage ?? "ja",
  );
  const { t } = useTranslation();

  // semantic_reindex_all の進行状況 event を購読 (App 起動中ずっと 1 度だけ)。
  useReindexProgressListener();

  // Sync uiLanguage setting → i18next
  useEffect(() => {
    if (i18next.language !== uiLanguage) {
      void i18next.changeLanguage(uiLanguage);
    }
  }, [uiLanguage]);

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

  useEffect(() => {
    initialize();
  }, [initialize]);

  useSyncUiScale();

  // Ctrl+Shift+D toggles debug log viewer
  const toggleDebugLog = useDebugLogStore((s) => s.toggle);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "d") {
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
      <DebugLogViewer />
    </>
  );
}

function EditorScreen() {
  const { t } = useTranslation();
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialCategory, setSettingsInitialCategory] =
    useState<SettingsCategory>("project");
  const [showExport, setShowExport] = useState(false);
  const [showSnapshotModal, setShowSnapshotModal] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const { setShowSampleTour, seedAndOpenSample } = useWorkspaceStore();
  const showSampleTour = useWorkspaceStore((s) => s.showSampleTour);
  const glassEnabled = useSettingsStore((s) =>
    s.getBoolean("display.glassEffectEnabled", false),
  );
  const cardLayout = useSettingsStore((s) =>
    s.getBoolean("display.cardLayout", true),
  );
  const glassTransparency = useSettingsStore((s) =>
    s.getNumber("display.glassTransparency", 30),
  );
  const glassBackdropGradient = useSettingsStore((s) =>
    s.getBoolean("display.glassBackdropGradient", true),
  );
  const glassNativeVibrancy = useSettingsStore((s) =>
    s.getBoolean("display.glassNativeVibrancy", true),
  );
  const glassSurfaceShell = useSettingsStore((s) =>
    s.getBoolean("display.glassSurfaceShell", true),
  );
  const glassSurfaceDock = useSettingsStore((s) =>
    s.getBoolean("display.glassSurfaceDock", true),
  );
  const glassSurfacePanels = useSettingsStore((s) =>
    s.getBoolean("display.glassSurfacePanels", true),
  );
  const glassSurfaceChat = useSettingsStore((s) =>
    s.getBoolean("display.glassSurfaceChat", true),
  );
  const glassSurfacePopovers = useSettingsStore((s) =>
    s.getBoolean("display.glassSurfacePopovers", true),
  );
  const glassSurfaceEditorChrome = useSettingsStore((s) =>
    s.getBoolean("display.glassSurfaceEditorChrome", true),
  );
  const isMac = isMacPlatform();

  useEffect(() => {
    const html = document.documentElement;
    if (glassEnabled) {
      html.dataset.glassEnabled = "true";
    } else {
      delete html.dataset.glassEnabled;
    }
    html.dataset.glassPopovers =
      glassEnabled && glassSurfacePopovers ? "true" : "false";
    const clamped = Math.max(0, Math.min(90, glassTransparency));
    html.style.setProperty("--glass-transparency-pct", `${clamped}%`);

    return () => {
      delete html.dataset.glassEnabled;
      delete html.dataset.glassPopovers;
      html.style.removeProperty("--glass-transparency-pct");
    };
  }, [glassEnabled, glassSurfacePopovers, glassTransparency]);

  useEffect(() => {
    invoke("set_window_vibrancy", {
      enabled: glassEnabled && glassNativeVibrancy,
    }).catch(() => {});
    return () => {
      invoke("set_window_vibrancy", { enabled: false }).catch(() => {});
    };
  }, [glassEnabled, glassNativeVibrancy]);

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
      setShowExport(true);
    }
    window.addEventListener("open-export-dialog", onOpenExport);
    return () => window.removeEventListener("open-export-dialog", onOpenExport);
  }, []);

  // Keyboard shortcuts (Ctrl+Alt+*)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Ctrl+Shift+E: エクスポートダイアログ開閉
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setShowExport((v) => !v);
        return;
      }

      // Ctrl+Shift+F: CommandCenter バーをフォーカス。
      // TipTap (features/editor/extensions.ts:135) が選択あり時に Mod-Shift-f を
      // foreshadow picker に使うため、defaultPrevented を尊重して二重発火を避ける。
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "f") {
        if (e.defaultPrevented) return;
        e.preventDefault();
        const cc = useCommandCenterStore.getState();
        if (cc.open) {
          cc.setOpen(false);
        } else {
          cc.setOpen(true);
          cc.requestFocus();
        }
        return;
      }

      // Ctrl+Shift+P: コマンドパレット
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setShowCommandPalette((v) => !v);
        return;
      }

      if (!e.ctrlKey || !e.altKey) return;

      const keyMap: Record<string, PanelId | "settings"> = {
        s: "scenes",
        x: "codex",
        h: "chat-history",
        c: "chat",
        n: "snippets",
        a: "attribution",
        q: "codex-quick",
        l: "timeline",
        m: "map",
        t: "kouetsu",
        f: "foreshadow",
        b: "trash-bin",
        k: "command-center-results",
        ",": "settings",
      };

      const target = keyMap[e.key.toLowerCase()];
      if (!target) return;

      e.preventDefault();
      if (target === "settings") {
        setSettingsInitialCategory("project");
        setShowSettings(true);
      } else {
        togglePanel(target);
        if (target === "codex-quick") {
          requestAnimationFrame(() => {
            useLayoutStore.getState().showPanel("codex-quick");
          });
        }
      }
    },
    [togglePanel],
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
      if (!e.ctrlKey || e.key !== "Tab") return;
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

      const nextIdx = e.shiftKey
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
    <main
      className="app-shell flex h-screen flex-col"
      data-card={cardLayout ? "true" : undefined}
      data-glass-enabled={glassEnabled ? "true" : undefined}
      data-glass-shell={glassSurfaceShell ? "true" : undefined}
      data-glass-dock={glassSurfaceDock ? "true" : undefined}
      data-glass-panels={glassSurfacePanels ? "true" : undefined}
      data-glass-chat={glassSurfaceChat ? "true" : undefined}
      data-glass-popovers={glassSurfacePopovers ? "true" : undefined}
      data-glass-editor-chrome={glassSurfaceEditorChrome ? "true" : undefined}
      data-glass-gradient={glassBackdropGradient ? "true" : undefined}
      data-platform-mac={isMac ? "true" : undefined}
    >
      <header
        className={cn(
          "glass-shell flex flex-shrink-0 items-center gap-3 border-b border-border px-4 py-1",
          isMac && "pl-20",
          getScreenshotPanelId() && "no-screenshot",
        )}
        data-tauri-drag-region
      >
        <GrimodexLogo height={24} className="text-foreground" />
        <WorkspaceMenu
          onOpenSnapshot={() => setShowSnapshotModal(true)}
          onOpenImport={() => setShowImportDialog(true)}
        />
        <ProjectMenu />
        <HistoryButtons />
        <button
          type="button"
          title={t("app.exportTitle")}
          onClick={() => setShowExport((v) => !v)}
          className="flex h-8 items-center gap-1.5 rounded px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <FileOutput className="h-4 w-4" />
          <span className="text-sm">{t("app.exportLabel")}</span>
        </button>
        <div className="flex min-w-0 flex-1 justify-center px-4">
          <CommandCenterBar />
        </div>
        <LayoutPresetDropdown />
        <PanelToggleDropdown />
        <button
          type="button"
          title={t("app.settingsTitle")}
          onClick={() => {
            setSettingsInitialCategory("project");
            setShowSettings(true);
          }}
          className="flex h-8 items-center gap-1.5 rounded px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Settings className="h-4 w-4" />
          <span className="text-sm">{t("app.settingsLabel")}</span>
        </button>
        {!isMac && (
          <>
            <div className="h-4 w-px bg-border" />
            <WindowControls />
          </>
        )}
      </header>
      <SettingsDialog
        open={showSettings}
        onClose={() => setShowSettings(false)}
        initialCategory={settingsInitialCategory}
      />
      <ExportDialog open={showExport} onClose={() => setShowExport(false)} />
      <ProjectSnapshotModal
        open={showSnapshotModal}
        onClose={() => setShowSnapshotModal(false)}
      />
      <NovelcrafterImportDialog
        open={showImportDialog}
        onClose={() => setShowImportDialog(false)}
      />
      {showCommandPalette && (
        <CommandPalette onClose={() => setShowCommandPalette(false)} />
      )}
      {showSampleTour && <SampleTour />}
      <ReindexProgressToast />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <LayoutShell
          hidden={!!getScreenshotPanelId()}
          screenshotPanelId={getScreenshotPanelId()}
        />
      </div>
    </main>
  );
}

export default App;
