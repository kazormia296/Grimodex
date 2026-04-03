import { useLayoutStore, type LeftTab } from "./layoutStore";
import { Sidebar } from "@/features/tree/Sidebar";
import { CodexManagementPanel } from "@/features/codex/CodexManagementPanel";

function ChatHistoryPlaceholder() {
  return (
    <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
      チャット履歴パネルは近日実装予定です
    </div>
  );
}

const TAB_LABELS: Record<LeftTab, string> = {
  scenes: "シーン",
  codex: "Codex",
  "chat-history": "履歴",
};

export function LeftDock() {
  const leftActive = useLayoutStore((s) => s.leftActive);
  const setLeftActive = useLayoutStore((s) => s.setLeftActive);

  const tabs: LeftTab[] = ["scenes", "codex", "chat-history"];

  return (
    <div className="flex h-full flex-col overflow-hidden border-r border-border bg-sidebar-background">
      {/* Tab bar */}
      <div className="flex flex-shrink-0 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setLeftActive(tab)}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              leftActive === tab
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </div>

      {/* Panel content */}
      <div className="flex-1 overflow-hidden">
        {leftActive === "scenes" && <Sidebar />}
        {leftActive === "codex" && <CodexManagementPanel />}
        {leftActive === "chat-history" && <ChatHistoryPlaceholder />}
      </div>
    </div>
  );
}
