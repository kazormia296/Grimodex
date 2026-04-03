import { StorySoFarCoverage } from "./StorySoFarCoverage";

interface ChatPanelHeaderProps {
  sessionsPanelOpen: boolean;
  setSessionsPanelOpen: (open: boolean) => void;
  contextTokenCount: number;
  agentMode: boolean;
  setAgentMode: (on: boolean) => void;
  modelSupportsTools: boolean;
}

export function ChatPanelHeader({
  sessionsPanelOpen,
  setSessionsPanelOpen,
  contextTokenCount,
  agentMode,
  setAgentMode,
  modelSupportsTools,
}: ChatPanelHeaderProps) {
  return (
    <div className="flex flex-col border-b border-border">
      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">AIチャット</h2>
          <button
            type="button"
            onClick={() => setSessionsPanelOpen(!sessionsPanelOpen)}
            className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Sessions
          </button>
          <button
            type="button"
            onClick={() => setAgentMode(!agentMode)}
            disabled={!modelSupportsTools}
            title={
              !modelSupportsTools
                ? "このモデルはAgent modeに対応していません"
                : agentMode
                  ? "Agent mode ON — クリックでOFF"
                  : "Agent mode OFF — クリックでON"
            }
            className={[
              "rounded px-1.5 py-0.5 text-xs transition-colors",
              agentMode
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
              !modelSupportsTools ? "cursor-not-allowed opacity-40" : "",
            ].join(" ")}
          >
            🔧
          </button>
          {agentMode && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              Agent mode
            </span>
          )}
        </div>
        {contextTokenCount > 0 && (
          <span
            data-testid="context-token-count"
            className="text-xs text-muted-foreground"
          >
            ctx: {contextTokenCount.toLocaleString()} tokens
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 px-4 pb-1.5">
        <StorySoFarCoverage />
      </div>
    </div>
  );
}
