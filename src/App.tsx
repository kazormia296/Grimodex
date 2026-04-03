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
import { getSetting } from "@/features/settings/api";
import { PanelToggleDropdown } from "@/features/layout/PanelToggleDropdown";
import { DockviewWatermark } from "@/features/layout/DockviewWatermark";
import {
  useLayoutStore,
  PANEL_TITLES,
  type PanelId,
} from "@/features/layout/layoutStore";
import { Sidebar } from "@/features/tree/Sidebar";
import { CodexQuickPanel } from "@/features/tree/CodexQuickPanel";
import { CodexManagementPanel } from "@/features/codex/CodexManagementPanel";
import { ChatPanel } from "@/features/chat/ChatPanel";
import { ChatHistoryPanel } from "@/features/chat/ChatHistoryPanel";
import { SnippetPanel } from "@/features/snippets/SnippetPanel";
import { AttributionReport } from "@/features/attribution/AttributionReport";
import { useState } from "react";
import { Settings } from "lucide-react";

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

/* ── Default layout builder ── */

function buildDefaultLayout(api: DockviewReadyEvent["api"]) {
  // 1. Scenes (first panel — left)
  api.addPanel({
    id: "scenes",
    component: "scenes",
    title: PANEL_TITLES.scenes,
  });

  // 2. Editor (right of Scenes — establishes left/right split)
  api.addPanel({
    id: "editor",
    component: "editor",
    title: PANEL_TITLES.editor,
    position: { referencePanel: "scenes", direction: "right" },
  });

  // 3. Chat + Chat History (right of Editor)
  api.addPanel({
    id: "chat",
    component: "chat",
    title: PANEL_TITLES.chat,
    position: { referencePanel: "editor", direction: "right" },
  });
  api.addPanel({
    id: "chat-history",
    component: "chat-history",
    title: PANEL_TITLES["chat-history"],
    position: { referencePanel: "chat", direction: "within" },
    inactive: true,
  });

  // 4. Codex Quick (below Scenes — splits left column vertically)
  api.addPanel({
    id: "codex-quick",
    component: "codex-quick",
    title: PANEL_TITLES["codex-quick"],
    position: { referencePanel: "scenes", direction: "below" },
  });

  // Set approximate sizes — left ~18%, center ~52%, right ~30%
  const leftGroup = api.getPanel("scenes")?.group;
  const centerGroup = api.getPanel("editor")?.group;
  const rightGroup = api.getPanel("chat")?.group;
  if (leftGroup && centerGroup && rightGroup) {
    leftGroup.api.setSize({ width: Math.round(api.width * 0.18) });
    rightGroup.api.setSize({ width: Math.round(api.width * 0.3) });
  }

  // Activate scenes tab
  api.getPanel("scenes")?.api.setActive();
}

/* ── App root ── */

function App() {
  const view = useWorkspaceStore((s) => s.view);
  const initialize = useWorkspaceStore((s) => s.initialize);

  // Apply persisted theme on startup
  useEffect(() => {
    getSetting("display.theme").then((theme) => {
      const t = theme ?? "system";
      const html = document.documentElement;
      if (t === "dark") {
        html.classList.add("dark");
      } else if (t === "light") {
        html.classList.remove("dark");
      } else {
        const prefersDark = window.matchMedia(
          "(prefers-color-scheme: dark)",
        ).matches;
        html.classList.toggle("dark", prefersDark);
      }
    });
  }, []);

  useEffect(() => {
    initialize();
  }, [initialize]);

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
    </>
  );
}

function EditorScreen() {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialCategory, setSettingsInitialCategory] =
    useState<SettingsCategory>("project");
  const { togglePanel, loadLayout, setDockviewApi } = useLayoutStore();

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
    },
    [setDockviewApi, loadLayout],
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
        <h1 className="text-xl font-bold text-foreground">Grimodex</h1>
        <div className="flex-1" />
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
