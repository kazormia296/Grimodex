import {
  formatContextWindow,
  getModelCapabilities,
} from "../agent/modelLimits";
import { StorySoFarCoverage } from "./StorySoFarCoverage";

interface ChatPanelHeaderProps {
  sessionsPanelOpen: boolean;
  setSessionsPanelOpen: (open: boolean) => void;
  contextTokenCount: number;
  agentMode: boolean;
  setAgentMode: (on: boolean) => void;
  modelSupportsTools: boolean;
  currentModel: string;
  thinkingEnabled: boolean;
}

export function ChatPanelHeader({
  sessionsPanelOpen,
  setSessionsPanelOpen,
  contextTokenCount,
  agentMode,
  setAgentMode,
  modelSupportsTools,
  currentModel,
  thinkingEnabled,
}: ChatPanelHeaderProps) {
  const caps = getModelCapabilities(currentModel);
  const ctxLabel = currentModel
    ? formatContextWindow(caps.contextWindow)
    : null;
  const hasThinking = caps.supportsAdaptiveThinking || caps.supportsThinking;

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
                ? "このモデルはAgent modeに対応していません（Claude / GPT-4 系を選択してください）"
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

        {/* モデル能力バッジ */}
        <div className="flex items-center gap-1.5">
          {ctxLabel && (
            <span
              title={`コンテキスト窓: ${caps.contextWindow.toLocaleString()} トークン`}
              className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
            >
              {ctxLabel}
            </span>
          )}
          {!modelSupportsTools && currentModel && (
            <span
              title="ツール呼び出し非対応"
              className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground line-through"
            >
              Tools
            </span>
          )}
          {hasThinking && (
            <span
              title={
                thinkingEnabled
                  ? caps.supportsAdaptiveThinking
                    ? "Adaptive Thinking ON"
                    : "Extended Thinking ON (budget_tokens)"
                  : "Thinking OFF"
              }
              className={`rounded px-1.5 py-0.5 text-xs ${
                thinkingEnabled
                  ? "bg-muted text-muted-foreground"
                  : "bg-muted text-muted-foreground/40 line-through"
              }`}
            >
              💭
            </span>
          )}
          {contextTokenCount > 0 && (
            <span
              data-testid="context-token-count"
              className="text-xs text-muted-foreground"
            >
              ctx: {contextTokenCount.toLocaleString()} tokens
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 px-4 pb-1.5">
        <StorySoFarCoverage />
      </div>
    </div>
  );
}
