import {
  Files,
  BookOpen,
  MessageSquare,
  History,
  Scissors,
  BarChart2,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DockviewApi } from "dockview-react";
import { useLayoutStore, type PanelId } from "./layoutStore";
import type { SettingsCategory } from "@/features/settings/types";

interface PanelDef {
  id: PanelId;
  label: string;
  icon: React.ReactNode;
}

const MAIN_PANELS: PanelDef[] = [
  { id: "scenes", label: "シーン", icon: <Files className="h-5 w-5" /> },
  { id: "codex", label: "Codex", icon: <BookOpen className="h-5 w-5" /> },
  {
    id: "chat-history",
    label: "チャット履歴",
    icon: <History className="h-5 w-5" />,
  },
  {
    id: "chat",
    label: "チャット",
    icon: <MessageSquare className="h-5 w-5" />,
  },
  { id: "snippets", label: "Snippets", icon: <Scissors className="h-5 w-5" /> },
  { id: "attribution", label: "帰属", icon: <BarChart2 className="h-5 w-5" /> },
];

function getDotState(
  panelId: PanelId,
  api: DockviewApi | null,
): "active" | "inactive" | "none" {
  if (!api) return "none";
  const panel = api.getPanel(panelId);
  if (!panel) return "none";
  // Panel is active tab in its group
  if (panel.group?.activePanel === panel) return "active";
  // Panel exists but not active tab
  return "inactive";
}

interface ActivityButtonProps {
  panel: PanelDef;
  dotState: "active" | "inactive" | "none";
  onClick: () => void;
}

function ActivityButton({ panel, dotState, onClick }: ActivityButtonProps) {
  return (
    <button
      type="button"
      title={panel.label}
      onClick={onClick}
      className={cn(
        "relative flex h-10 w-10 items-center justify-center rounded transition-colors",
        dotState === "active"
          ? "text-foreground bg-accent"
          : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
      )}
    >
      {panel.icon}
      {/* Indicator dot on the left edge */}
      {dotState !== "none" && (
        <span
          className={cn(
            "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r",
            dotState === "active" ? "bg-primary" : "bg-primary/40",
          )}
        />
      )}
    </button>
  );
}

interface ActivityBarProps {
  onSettingsOpen?: (category?: SettingsCategory) => void;
}

export function ActivityBar({ onSettingsOpen }: ActivityBarProps) {
  const { dockviewApi, togglePanel } = useLayoutStore();

  return (
    <aside className="flex w-10 flex-shrink-0 flex-col items-center border-r border-border bg-sidebar-background py-1">
      {/* Main panel icons */}
      <div className="flex flex-col items-center gap-0.5">
        {MAIN_PANELS.map((panel) => (
          <ActivityButton
            key={panel.id}
            panel={panel}
            dotState={getDotState(panel.id, dockviewApi)}
            onClick={() => togglePanel(panel.id)}
          />
        ))}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Separator */}
      <div className="my-1 h-px w-6 bg-border" />

      {/* Settings */}
      <button
        type="button"
        title="設定"
        onClick={() => onSettingsOpen?.()}
        className="flex h-10 w-10 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      >
        <Settings className="h-5 w-5" />
      </button>
    </aside>
  );
}
