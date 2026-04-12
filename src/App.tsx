import { useEffect, useCallback, useMemo } from "react";
import { Toaster, toast } from "sonner";
import {
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";

import { SceneEditor } from "@/features/tree/SceneEditor";
import { WelcomeScreen } from "@/features/workspace/WelcomeScreen";
import { LauncherScreen } from "@/features/workspace/LauncherScreen";
import { WorkspaceMenu } from "@/features/workspace/WorkspaceMenu";
import { useWorkspaceStore } from "@/features/workspace/store";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import type { SettingsCategory } from "@/features/settings/types";
import { PanelToggleDropdown } from "@/features/layout/PanelToggleDropdown";
import { LayoutPresetDropdown } from "@/features/layout/LayoutPresetDropdown";
import { DockviewWatermark } from "@/features/layout/DockviewWatermark";
import {
  useLayoutStore,
  clearSavedLayout,
  type PanelId,
} from "@/features/layout/layoutStore";
import {
  validateSerializedLayout,
  validateRuntimeLayout,
} from "@/features/layout/layoutValidation";
import { useDebugLogStore } from "@/lib/debugLog";
import { DebugLogViewer } from "@/lib/DebugLogViewer";
import { getBuiltinPreset } from "@/features/layout/layoutPresets";
import { Sidebar } from "@/features/tree/Sidebar";
import { CodexQuickPanel } from "@/features/tree/CodexQuickPanel";
import { CodexManagementPanel } from "@/features/codex/CodexManagementPanel";
import { ChatPanel } from "@/features/chat/ChatPanel";
import { ChatHistoryPanel } from "@/features/chat/ChatHistoryPanel";
import { SnippetPanel } from "@/features/snippets/SnippetPanel";
import { AttributionReport } from "@/features/attribution/AttributionReport";
import { useState } from "react";
import { Settings } from "lucide-react";
import {
  COLOR_THEMES,
  DEFAULT_COLOR_THEME,
  THEME_CSS_VARS,
} from "@/lib/colorThemes";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { GrimodexLogo } from "@/components/GrimodexLogo";
import { WindowControls } from "@/components/WindowControls";
import { TitleBar } from "@/components/TitleBar";
import { useTabStore } from "@/features/editor/tabStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { getProject } from "@/features/project/api";

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
  const initialize = useWorkspaceStore((s) => s.initialize);
  const theme = useWorkspaceStore((s) => s.globalSettings?.theme ?? "system");
  const colorTheme = useWorkspaceStore((s) => s.globalSettings?.colorTheme);

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
          <p className="text-sm text-muted-foreground">読み込み中…</p>
        </div>
      )}
      {view === "welcome" && <WelcomeScreen />}
      {view === "launcher" && <LauncherScreen />}
      {view === "editor" && <EditorScreen />}
      <DebugLogViewer />
    </>
  );
}

function EditorScreen() {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialCategory, setSettingsInitialCategory] =
    useState<SettingsCategory>("project");

  // 執筆言語を <html lang> に反映（初期ロード時）
  useEffect(() => {
    getProject("default-project").then((p) => {
      if (p?.language) document.documentElement.lang = p.language;
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

  // Dockview ready handler — build default layout synchronously, then
  // try to restore persisted layout in the background (avoids blank screen
  // if the DB query is slow or hangs in Tauri).
  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      setDockviewApi(api);

      // Always show something immediately, then snapshot for fallback
      buildDefaultLayout(api);
      const defaultSnapshot = api.toJSON();

      // Then try to restore saved layout asynchronously
      loadLayout()
        .then(async (saved) => {
          if (!saved) return;

          // 1. Pre-validate before fromJSON
          const preCheck = validateSerializedLayout(saved);
          if (!preCheck.valid) {
            toast.warning(
              `保存済みレイアウトが不正なため、デフォルトに戻しました。（${preCheck.reason}）`,
            );
            await clearSavedLayout();
            return;
          }

          // 2. Apply
          try {
            api.fromJSON(saved);
          } catch {
            toast.warning(
              "レイアウトの復元に失敗しました。デフォルトに戻します。",
            );
            api.fromJSON(defaultSnapshot);
            await clearSavedLayout();
            return;
          }

          // 3. Post-validate after fromJSON
          const postCheck = validateRuntimeLayout(api);
          if (!postCheck.valid) {
            toast.warning(
              `レイアウトが退化しているため、デフォルトに戻しました。（${postCheck.reason}）`,
            );
            api.fromJSON(defaultSnapshot);
            await clearSavedLayout();
          }
        })
        .catch(() => {
          // DB unavailable — keep the default layout
        });

      // Load preset metadata (custom presets list + active ID)
      loadPresets();
    },
    [setDockviewApi, loadLayout, loadPresets],
  );

  // Keyboard shortcuts (Ctrl+Alt+*)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey) return;

      const keyMap: Record<string, PanelId | "settings"> = {
        s: "scenes",
        x: "codex",
        h: "chat-history",
        c: "chat",
        n: "snippets",
        a: "attribution",
        q: "codex-quick",
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
        <div className="flex-1" />
        <LayoutPresetDropdown />
        <PanelToggleDropdown />
        <button
          type="button"
          title="設定 (Ctrl+Alt+,)"
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
      <div className="flex flex-1 overflow-hidden">
        {/* Dockview layout */}
        <DockviewReact
          className="dockview-theme-dark flex-1"
          onReady={handleReady}
          components={components}
          watermarkComponent={DockviewWatermark}
        />
      </div>
    </main>
  );
}

export default App;
