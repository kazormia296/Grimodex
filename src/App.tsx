import { Sidebar } from "@/features/scene/Sidebar";
import { SceneEditor } from "@/features/scene/SceneEditor";

function App() {
  return (
    <main className="flex h-screen flex-col">
      <header className="border-b border-border px-4 py-2">
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
