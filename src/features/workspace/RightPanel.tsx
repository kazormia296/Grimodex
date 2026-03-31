import { useState } from "react";
import { MessageSquare, BookOpen, Bookmark, BarChart3 } from "lucide-react";
import { ChatPanel } from "@/features/chat/ChatPanel";
import { CodexManagementPanel } from "@/features/codex/CodexManagementPanel";
import { SnippetPanel } from "@/features/snippets/SnippetPanel";
import { AttributionReport } from "@/features/attribution/AttributionReport";

type TabId = "chat" | "codex" | "snippets" | "stats";

interface Tab {
  id: TabId;
  label: string;
  icon: React.ReactNode;
}

const tabs: Tab[] = [
  {
    id: "chat",
    label: "チャット",
    icon: <MessageSquare className="h-3.5 w-3.5" />,
  },
  { id: "codex", label: "Codex", icon: <BookOpen className="h-3.5 w-3.5" /> },
  {
    id: "snippets",
    label: "Snippets",
    icon: <Bookmark className="h-3.5 w-3.5" />,
  },
  {
    id: "stats",
    label: "統計",
    icon: <BarChart3 className="h-3.5 w-3.5" />,
  },
];

export function RightPanel() {
  const [activeTab, setActiveTab] = useState<TabId>("chat");

  return (
    <div className="flex h-full flex-col">
      <div className="flex border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            data-testid={`right-panel-tab-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${
              activeTab === tab.id
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-hidden">
        {activeTab === "chat" && <ChatPanel />}
        {activeTab === "codex" && <CodexManagementPanel />}
        {activeTab === "snippets" && <SnippetPanel />}
        {activeTab === "stats" && <AttributionReport />}
      </div>
    </div>
  );
}
