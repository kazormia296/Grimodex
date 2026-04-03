import { useState } from "react";
import type { ToolCallRecord } from "../agent/agentTypes";

interface ToolCallBlockProps {
  record: ToolCallRecord;
}

export function ToolCallBlock({ record }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="my-1 rounded border border-border bg-muted/40 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-1.5 px-2 py-1.5 text-left hover:bg-muted/60"
      >
        <span className="mt-px shrink-0">🔧</span>
        <span className="font-mono font-medium text-foreground">
          {record.name}
        </span>
        <span className="text-muted-foreground">
          (
          {Object.entries(record.params)
            .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
            .join(", ")}
          )
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {expanded ? "▲" : "▼"}
        </span>
      </button>
      <div className="border-t border-border px-2 py-1 text-muted-foreground">
        └─ {record.resultSummary}
        {record.tokensUsed > 0 && (
          <span className="ml-2 opacity-60">(~{record.tokensUsed} tokens)</span>
        )}
      </div>
      {expanded && (
        <div className="border-t border-border px-2 py-1.5">
          <div className="mb-1 font-medium text-muted-foreground">Params:</div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-foreground">
            {JSON.stringify(record.params, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
