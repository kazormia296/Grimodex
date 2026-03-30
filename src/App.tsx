import { useEffect } from "react";
import { Sidebar } from "@/features/scene/Sidebar";
import { SceneEditor } from "@/features/scene/SceneEditor";
import { WelcomeScreen } from "@/features/workspace/WelcomeScreen";
import { LauncherScreen } from "@/features/workspace/LauncherScreen";
import { WorkspaceMenu } from "@/features/workspace/WorkspaceMenu";
import { useWorkspaceStore } from "@/features/workspace/store";

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
  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2">
        <WorkspaceMenu />
        <h1 className="text-xl font-bold text-foreground">NoveLoom</h1>
      </header>
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
