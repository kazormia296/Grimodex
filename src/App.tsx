import { useEffect, useRef, useCallback } from "react";
import { Toaster } from "sonner";
import { SceneEditor } from "@/features/tree/SceneEditor";
import { WelcomeScreen } from "@/features/workspace/WelcomeScreen";
import { LauncherScreen } from "@/features/workspace/LauncherScreen";
import { WorkspaceMenu } from "@/features/workspace/WorkspaceMenu";
import { useWorkspaceStore } from "@/features/workspace/store";
import { AiSettingsDialog } from "@/features/chat/AiSettingsDialog";
import { ActivityBar } from "@/features/layout/ActivityBar";
import { LeftDock } from "@/features/layout/LeftDock";
import { BottomDock } from "@/features/layout/BottomDock";
import { RightDock } from "@/features/layout/RightDock";
import { useLayoutStore } from "@/features/layout/layoutStore";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { useState } from "react";

function App() {
  const view = useWorkspaceStore((s) => s.view);
  const initialize = useWorkspaceStore((s) => s.initialize);

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
  const [showAiSettings, setShowAiSettings] = useState(false);
  const { leftActive, rightActive, bottomActive, togglePanel, loadLayout } =
    useLayoutStore();

  const leftPanelRef = useRef<PanelImperativeHandle | null>(null);
  const rightPanelRef = useRef<PanelImperativeHandle | null>(null);
  const bottomPanelRef = useRef<PanelImperativeHandle | null>(null);

  // Load persisted layout on mount
  useEffect(() => {
    loadLayout();
  }, [loadLayout]);

  // Open AI settings dialog when triggered by error handler (D-17)
  useEffect(() => {
    function onOpenSettings() {
      setShowAiSettings(true);
    }
    window.addEventListener("open-ai-settings", onOpenSettings);
    return () => window.removeEventListener("open-ai-settings", onOpenSettings);
  }, []);

  // Sync left dock collapse state
  useEffect(() => {
    if (leftActive === null) {
      leftPanelRef.current?.collapse();
    } else {
      leftPanelRef.current?.expand();
    }
  }, [leftActive]);

  // Sync right dock collapse state
  useEffect(() => {
    if (rightActive === null) {
      rightPanelRef.current?.collapse();
    } else {
      rightPanelRef.current?.expand();
    }
  }, [rightActive]);

  // Sync bottom dock collapse state
  useEffect(() => {
    if (bottomActive === null) {
      bottomPanelRef.current?.collapse();
    } else {
      bottomPanelRef.current?.expand();
    }
  }, [bottomActive]);

  // Keyboard shortcuts (Ctrl+Alt+*)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey) return;
      switch (e.key.toLowerCase()) {
        case "s":
          e.preventDefault();
          togglePanel("scenes");
          break;
        case "x":
          e.preventDefault();
          togglePanel("codex");
          break;
        case "h":
          e.preventDefault();
          togglePanel("chat-history");
          break;
        case "c":
          e.preventDefault();
          togglePanel("chat");
          break;
        case "n":
          e.preventDefault();
          togglePanel("snippets");
          break;
        case "a":
          e.preventDefault();
          togglePanel("attribution");
          break;
        case "b":
          e.preventDefault();
          // Toggle left dock
          if (leftActive !== null) {
            useLayoutStore
              .getState()
              .setLeftActive(leftActive === "scenes" ? "scenes" : leftActive);
            useLayoutStore.setState({ leftActive: null });
          } else {
            useLayoutStore.setState({ leftActive: "scenes" });
          }
          break;
        case "j":
          e.preventDefault();
          // Toggle bottom dock
          if (bottomActive !== null) {
            useLayoutStore.setState({ bottomActive: null });
          } else {
            useLayoutStore.setState({ bottomActive: "snippets" });
          }
          break;
        case "r":
          e.preventDefault();
          // Toggle right dock
          if (rightActive !== null) {
            useLayoutStore.setState({ rightActive: null });
          } else {
            useLayoutStore.setState({ rightActive: "chat" });
          }
          break;
        case ",":
          e.preventDefault();
          setShowAiSettings(true);
          break;
      }
    },
    [leftActive, rightActive, bottomActive, togglePanel],
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
      </header>
      <AiSettingsDialog
        open={showAiSettings}
        onClose={() => setShowAiSettings(false)}
      />
      <div className="flex flex-1 overflow-hidden">
        {/* Activity Bar — fixed 40px */}
        <ActivityBar onSettingsOpen={() => setShowAiSettings(true)} />

        {/* Main resizable layout */}
        <ResizablePanelGroup orientation="horizontal" className="flex-1">
          {/* Left Dock */}
          <ResizablePanel
            panelRef={leftPanelRef}
            collapsible
            defaultSize="18%"
            minSize="12%"
            maxSize="40%"
            collapsedSize="0%"
          >
            <LeftDock />
          </ResizablePanel>
          <ResizableHandle />

          {/* Center + Bottom Dock */}
          <ResizablePanel defaultSize="52%" minSize="30%">
            <ResizablePanelGroup orientation="vertical">
              {/* Editor */}
              <ResizablePanel defaultSize="75%" minSize="40%">
                <SceneEditor />
              </ResizablePanel>

              <ResizableHandle horizontal />

              {/* Bottom Dock */}
              <ResizablePanel
                panelRef={bottomPanelRef}
                collapsible
                defaultSize="25%"
                minSize="15%"
                collapsedSize="0%"
              >
                <BottomDock />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle />

          {/* Right Dock */}
          <ResizablePanel
            panelRef={rightPanelRef}
            collapsible
            defaultSize="30%"
            minSize="18%"
            maxSize="50%"
            collapsedSize="0%"
          >
            <RightDock />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </main>
  );
}

export default App;
