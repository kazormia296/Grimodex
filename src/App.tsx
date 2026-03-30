import { useEffect, useState } from "react";
import { Sidebar } from "@/features/scene/Sidebar";
import { SceneEditor } from "@/features/scene/SceneEditor";
import { WelcomeScreen } from "@/features/workspace/WelcomeScreen";
import { LauncherScreen } from "@/features/workspace/LauncherScreen";
import { WorkspaceMenu } from "@/features/workspace/WorkspaceMenu";
import { useWorkspaceStore } from "@/features/workspace/store";
import { AiSettingsDialog } from "@/features/chat/AiSettingsDialog";

function App() {
  const view = useWorkspaceStore((s) => s.view);
  const initialize = useWorkspaceStore((s) => s.initialize);

  useEffect(() => {
    initialize();
  }, [initialize]);

  switch (view) {
    case "loading":
      return (
        <div className="flex h-screen items-center justify-center bg-background text-foreground">
          <p className="text-sm text-muted-foreground">読み込み中…</p>
        </div>
      );
    case "welcome":
      return <WelcomeScreen />;
    case "launcher":
      return <LauncherScreen />;
    case "editor":
      return <EditorScreen />;
  }
}

function EditorScreen() {
  const [showAiSettings, setShowAiSettings] = useState(false);

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2">
        <WorkspaceMenu />
        <h1 className="text-xl font-bold text-foreground">NoveLoom</h1>
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => setShowAiSettings(true)}
            className="rounded px-3 py-1 text-sm hover:bg-accent hover:text-accent-foreground"
          >
            AI設定
          </button>
        </div>
      </header>
      <AiSettingsDialog
        open={showAiSettings}
        onClose={() => setShowAiSettings(false)}
      />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <div className="flex-1 overflow-hidden">
          <SceneEditor />
        </div>
      </div>
    </main>
  );
}

export default App;
