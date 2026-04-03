import { useState } from "react";

interface ThinkingBlockProps {
  /** thinking ブロックの要約テキスト（display: "summarized" 時）または全文 */
  content: string;
  summary?: string;
}

export function ThinkingBlock({ content, summary }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const displayText = summary || content;

  return (
    <div className="my-1 rounded border border-border/60 bg-muted/30 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-muted/50"
      >
        <span className="shrink-0">💭</span>
        <span className="font-medium text-muted-foreground">Thinking...</span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {expanded ? "▲" : "▼"}
        </span>
      </button>
      {expanded && displayText && (
        <div className="border-t border-border/60 px-2 py-1.5">
          <p className="whitespace-pre-wrap text-muted-foreground">
            {displayText}
          </p>
        </div>
      )}
    </div>
  );
}
