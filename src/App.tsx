import { useEffect, useCallback, useMemo } from "react";
import { Toaster, toast } from "sonner";
import {
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewDidDropEvent,
  type IDockviewPanelProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";

import { SceneEditor } from "@/features/tree/SceneEditor";
import { WelcomeScreen } from "@/features/workspace/WelcomeScreen";
import { LauncherScreen } from "@/features/workspace/LauncherScreen";
import { WorkspaceMenu } from "@/features/workspace/WorkspaceMenu";
import { WorkspaceTrustDialog } from "@/features/workspace/WorkspaceTrustDialog";
import { useWorkspaceStore } from "@/features/workspace/store";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import type { SettingsCategory } from "@/features/settings/types";
import { PanelToggleDropdown } from "@/features/layout/PanelToggleDropdown";
import { LayoutPresetDropdown } from "@/features/layout/LayoutPresetDropdown";
import { DockviewWatermark } from "@/features/layout/DockviewWatermark";
import {
  useLayoutStore,
  clearSavedLayout,
  refreshPanelTitles,
  getPanelTitle,
  PANEL_DRAG_TYPE,
  type PanelId,
} from "@/features/layout/layoutStore";
import {
  validateSerializedLayout,
  validateRuntimeLayout,
} from "@/features/layout/layoutValidation";
import { useDebugLogStore } from "@/lib/debugLog";
import { DebugLogViewer } from "@/lib/DebugLogViewer";
import { getBuiltinPreset, clearLayout } from "@/features/layout/layoutPresets";
import { Sidebar } from "@/features/tree/Sidebar";
import { CodexQuickPanel } from "@/features/tree/CodexQuickPanel";
import { CodexManagementPanel } from "@/features/codex/CodexManagementPanel";
import { ChatPanel } from "@/features/chat/ChatPanel";
import { ChatHistoryPanel } from "@/features/chat/ChatHistoryPanel";
import { SnippetPanel } from "@/features/snippets/SnippetPanel";
import { AttributionReport } from "@/features/attribution/AttributionReport";
import { TimelinePanel } from "@/features/timeline/TimelinePanel";
import { MapPanel } from "@/features/map/MapPanel";
import { LinterPanel } from "@/features/lint/LinterPanel";
import { StatusBarIndicator } from "@/features/lint/StatusBarIndicator";
import { GlobalSearchDialog } from "@/features/search/GlobalSearchDialog";
import { useState } from "react";
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
import { getProject } from "@/features/project/api";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { WelcomeDialog } from "@/features/onboarding/WelcomeDialog";

/* ── Panel content components for dockview ── */

function ScenesContent(_props: IDockviewPanelProps) {
  return <Sidebar />;
}

function CodexContent(_props: IDockviewPanelProps) {
  return <CodexManagementPanel />;
}

function ChatHistoryContent(_props: IDockviewPanelProps) {
  return <ChatHistoryPanel />;
}

function EditorContent(_props: IDockviewPanelProps) {
  return <SceneEditor />;
}

function ChatContent(_props: IDockviewPanelProps) {
  return <ChatPanel />;
}

function SnippetsContent(_props: IDockviewPanelProps) {
  return <SnippetPanel />;
}

function AttributionContent(_props: IDockviewPanelProps) {
  return <AttributionReport />;
}

function CodexQuickContent(_props: IDockviewPanelProps) {
  return <CodexQuickPanel />;
}

function TimelineContent(_props: IDockviewPanelProps) {
  return <TimelinePanel />;
}

function MapContent(_props: IDockviewPanelProps) {
  return <MapPanel />;
}

function LinterContent(_props: IDockviewPanelProps) {
  return <LinterPanel />;
}

/* ── Default layout builder (delegates to builtin preset) ── */

function buildDefaultLayout(api: DockviewReadyEvent["api"]) {
  const preset = getBuiltinPreset("builtin:default");
  preset?.build(api);
}

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
  const view = useWorkspaceStore((s) => s.view);
  const activeWorkspacePath = useWorkspaceStore((s) => s.activeWorkspacePath);
  const initialize = useWorkspaceStore((s) => s.initialize);
  const theme = useWorkspaceStore((s) => s.globalSettings?.theme ?? "system");
  const colorTheme = useWorkspaceStore((s) => s.globalSettings?.colorTheme);
  const uiLanguage = useWorkspaceStore(
    (s) => s.globalSettings?.uiLanguage ?? "ja",
  );
  const { t } = useTranslation();

  // Sync uiLanguage setting → i18next + refresh dockview panel titles
  useEffect(() => {
    if (i18next.language !== uiLanguage) {
      i18next.changeLanguage(uiLanguage).then(() => {
        const api = useLayoutStore.getState().dockviewApi;
        if (api) refreshPanelTitles(api);
      });
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
  const [showSearch, setShowSearch] = useState(false);
  const { globalSettings, updateGlobalSettings } = useWorkspaceStore();
  const [showWelcome, setShowWelcome] = useState(
    () => !globalSettings?.hasSeenWelcome,
  );

  const handleCloseWelcome = useCallback(async () => {
    setShowWelcome(false);
    if (!globalSettings?.hasSeenWelcome) {
      await updateGlobalSettings({ hasSeenWelcome: true });
    }
  }, [globalSettings, updateGlobalSettings]);

  // Allow re-triggering from settings via custom event
  useEffect(() => {
    function onShowTour() {
      setShowSettings(false);
      setShowWelcome(true);
    }
    window.addEventListener("show-welcome-tour", onShowTour);
    return () => window.removeEventListener("show-welcome-tour", onShowTour);
  }, []);

  // 執筆言語を <html lang> に反映、Phase resolution mode を初期化
  useEffect(() => {
    getProject("default-project").then((p) => {
      if (p?.language) document.documentElement.lang = p.language;
      if (p?.phaseResolutionMode) {
        usePhaseStore.getState().setResolutionMode(p.phaseResolutionMode);
      }
    });
  }, []);
  const { togglePanel, loadLayout, loadPresets, setDockviewApi } =
    useLayoutStore();

  // Component map for dockview — stable reference
  const components = useMemo<
    Record<string, React.FunctionComponent<IDockviewPanelProps>>
  >(
    () => ({
      scenes: ScenesContent,
      codex: CodexContent,
      "chat-history": ChatHistoryContent,
      editor: EditorContent,
      chat: ChatContent,
      snippets: SnippetsContent,
      attribution: AttributionContent,
      "codex-quick": CodexQuickContent,
      timeline: TimelineContent,
      map: MapContent,
      linter: LinterContent,
    }),
    [],
  );

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

  // Dockview ready handler — build default layout synchronously, then
  // try to restore persisted layout in the background (avoids blank screen
  // if the DB query is slow or hangs in Tauri).
  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      setDockviewApi(api);

      // Always show something immediately
      buildDefaultLayout(api);

      // Then try to restore saved layout asynchronously
      loadLayout()
        .then(async (saved) => {
          if (!saved) return;

          // 1. Pre-validate before fromJSON — rejects definitively broken structure
          const preCheck = validateSerializedLayout(saved);
          if (!preCheck.valid) {
            toast.warning(
              i18next.t("app.invalidLayout", { reason: preCheck.reason }),
            );
            await clearSavedLayout();
            return;
          }

          // 2. Apply — exceptions here are format-compatibility issues (e.g. old
          //    dockview serialization). Silently rebuild default and let scheduleSave
          //    overwrite the incompatible layout on the next change event.
          try {
            api.fromJSON(saved);
            refreshPanelTitles(api);
          } catch {
            clearLayout(api);
            buildDefaultLayout(api);
            await clearSavedLayout();
            return;
          }

          // 3. Post-validate — catches layouts that loaded but are degenerate
          //    (e.g. single panel taking 100% after resize/drag accident)
          const postCheck = validateRuntimeLayout(api);
          if (!postCheck.valid) {
            toast.warning(
              i18next.t("app.degenLayout", { reason: postCheck.reason }),
            );
            clearLayout(api);
            buildDefaultLayout(api);
            await clearSavedLayout();
          }
        })
        .catch(() => {
          // DB unavailable — keep the default layout
        });

      // Load preset metadata (custom presets list + active ID)
      loadPresets();

      // Accept external drags originating from the panel dropdown
      api.onUnhandledDragOverEvent((e) => {
        if (e.nativeEvent.dataTransfer?.types.includes(PANEL_DRAG_TYPE)) {
          e.accept();
        }
      });
    },
    [setDockviewApi, loadLayout, loadPresets],
  );

  const handlePanelDrop = useCallback((event: DockviewDidDropEvent) => {
    const panelId = event.nativeEvent.dataTransfer?.getData(PANEL_DRAG_TYPE) as
      | PanelId
      | undefined;
    if (!panelId) return;
    if (event.api.getPanel(panelId)) return; // already in layout

    const position = event.group
      ? {
          referencePanel: event.group.activePanel?.id ?? "",
          direction: "within" as const,
        }
      : { direction: "right" as const };

    event.api.addPanel({
      id: panelId,
      component: panelId,
      title: getPanelTitle(panelId),
      position,
      ...(panelId === "editor" ? { minimumWidth: 320 } : {}),
    });
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

      // Ctrl+Shift+F: 全文検索ダイアログ
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setShowSearch((v) => !v);
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
        t: "linter",
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
        // Ensure the panel receives focus after being shown
        if (target === "codex-quick") {
          requestAnimationFrame(() => {
            useLayoutStore
              .getState()
              .dockviewApi?.getPanel("codex-quick")
              ?.api.setActive();
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
    <main className="flex h-screen flex-col">
      <header
        className="flex flex-shrink-0 items-center gap-3 border-b border-border px-4 py-1"
        data-tauri-drag-region
      >
        <GrimodexLogo height={24} className="text-foreground" />
        <WorkspaceMenu />
        <button
          type="button"
          title={t("app.exportTitle")}
          onClick={() => setShowExport((v) => !v)}
          className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <FileOutput className="h-4 w-4" />
        </button>
        <div className="flex-1" />
        <LayoutPresetDropdown />
        <PanelToggleDropdown />
        <button
          type="button"
          title={t("app.settingsTitle")}
          onClick={() => {
            setSettingsInitialCategory("project");
            setShowSettings(true);
          }}
          className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Settings className="h-4 w-4" />
        </button>
        <div className="h-4 w-px bg-border" />
        <WindowControls />
      </header>
      <SettingsDialog
        open={showSettings}
        onClose={() => setShowSettings(false)}
        initialCategory={settingsInitialCategory}
      />
      <ExportDialog open={showExport} onClose={() => setShowExport(false)} />
      {showSearch && (
        <GlobalSearchDialog onClose={() => setShowSearch(false)} />
      )}
      <WelcomeDialog
        open={showWelcome}
        onClose={() => void handleCloseWelcome()}
      />
      <div className="flex flex-1 overflow-hidden">
        {/* Dockview layout */}
        <DockviewReact
          className="dockview-theme-dark flex-1"
          onReady={handleReady}
          onDidDrop={handlePanelDrop}
          components={components}
          watermarkComponent={DockviewWatermark}
        />
      </div>
      <footer className="flex flex-shrink-0 items-center gap-2 border-t border-border bg-muted/40 px-2 py-0.5">
        <StatusBarIndicator />
        <div className="flex-1" />
      </footer>
    </main>
  );
}

export default App;
