import { useEffect, useCallback, useMemo } from "react";
import { Toaster } from "sonner";
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
import { useLayoutStore, type PanelId } from "@/features/layout/layoutStore";
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
        <div className="flex h-screen items-center justify-center bg-background text-foreground">
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

      // Always show something immediately
      buildDefaultLayout(api);

      // Then try to restore saved layout asynchronously
      loadLayout()
        .then((saved) => {
          if (saved) {
            try {
              api.fromJSON(saved);
            } catch {
              // Corrupted layout — keep the default already showing
            }
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
      }
    },
    [togglePanel],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <main className="flex h-screen flex-col">
      <header className="flex flex-shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <WorkspaceMenu />
        <GrimodexLogo height={24} className="text-foreground" />
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
