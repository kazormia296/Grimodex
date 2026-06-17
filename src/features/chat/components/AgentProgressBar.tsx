import { Wrench, CornerDownRight } from "lucide-react";
import { useTranslation } from "react-i18next";

/** run_research サブエージェントの進捗（親の下にネスト表示する分のみ）。 */
export interface SubAgentProgress {
  calls: number;
  maxCalls: number;
  currentToolName?: string;
}

interface AgentProgressBarProps {
  calls: number;
  maxCalls: number;
  tokensUsed: number;
  tokenBudget: number;
  currentToolName?: string;
  /** リサーチ・サブエージェント実行中のみ非 null。親の下にネスト表示する。 */
  subProgress?: SubAgentProgress | null;
}

export function AgentProgressBar({
  calls,
  maxCalls,
  tokensUsed,
  tokenBudget,
  currentToolName,
  subProgress,
}: AgentProgressBarProps) {
  const { t } = useTranslation();
  const tokenPct =
    tokenBudget > 0 ? Math.min(100, (tokensUsed / tokenBudget) * 100) : 0;

  return (
    <div className="border-t border-border bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground">
      <div className="flex items-center gap-3">
        <span className="inline-flex shrink-0 items-center gap-1">
          <Wrench className="h-3 w-3 shrink-0" aria-hidden />
          {calls}/{maxCalls} calls
        </span>
        <div className="flex flex-1 items-center gap-1.5">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full bg-primary/60 transition-all"
              style={{ width: `${tokenPct}%` }}
            />
          </div>
          <span className="shrink-0">
            ~{tokensUsed.toLocaleString()} / {tokenBudget.toLocaleString()}{" "}
            tokens
          </span>
        </div>
      </div>
      {subProgress && (
        <div className="mt-0.5 flex items-center gap-1 truncate opacity-80">
          <CornerDownRight className="h-3 w-3 shrink-0" aria-hidden />
          <span className="shrink-0">
            {t("chat.context.subagentRunning", {
              calls: subProgress.calls,
              maxCalls: subProgress.maxCalls,
            })}
          </span>
          {subProgress.currentToolName && (
            <span className="truncate opacity-70">
              · {subProgress.currentToolName}
            </span>
          )}
        </div>
      )}
      {!subProgress && currentToolName && (
        <div className="mt-0.5 truncate opacity-70">
          {t("chat.context.running", { name: currentToolName })}
        </div>
      )}
    </div>
  );
}
