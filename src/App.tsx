import { EditorPanel } from "@/features/editor/EditorPanel";

function App() {
  return (
    <main className="flex h-screen flex-col">
      <header className="border-b border-border px-4 py-2">
        <h1 className="text-xl font-bold text-foreground">NoveLoom</h1>
      </header>
      <div className="flex-1 overflow-hidden">
        <EditorPanel />
      </div>
    </main>
  );
}

export default App;
