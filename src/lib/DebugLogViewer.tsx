import { useRef, useEffect } from "react";
import { X, Trash2, Copy, ClipboardCopy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useDebugLogStore, type LogEntry, type LogLevel } from "./debugLog";

const LEVEL_STYLES: Record<LogLevel, string> = {
  debug: "text-muted-foreground",
  info: "text-blue-400",
  warn: "text-yellow-400",
  error: "text-red-400",
};

export function DebugLogViewer() {
  const { entries, isOpen, setOpen, clear } = useDebugLogStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [entries.length, isOpen]);

  if (!isOpen) return null;

  function formatEntry(e: LogEntry): string {
    const parts = [e.timestamp, e.level.toUpperCase(), `[${e.tag}]`, e.message];
    if (e.detail) parts.push(e.detail);
    return parts.join(" ");
  }

  function copyAll() {
    const text = entries.map(formatEntry).join("\n");
    navigator.clipboard.writeText(text);
    toast.success("ログをコピーしました");
  }

  function copyLine(entry: LogEntry) {
    navigator.clipboard.writeText(formatEntry(entry));
    toast.success("行をコピーしました");
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-[9999] flex h-72 flex-col border-t border-border bg-background/95 backdrop-blur">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-xs font-semibold text-foreground">Debug Log</span>
        <span className="text-[10px] text-muted-foreground">
          ({entries.length} entries)
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={copyAll}
          className="rounded p-1 text-muted-foreground hover:text-foreground"
          title="Copy all"
        >
          <ClipboardCopy className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={clear}
          className="rounded p-1 text-muted-foreground hover:text-foreground"
          title="Clear"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded p-1 text-muted-foreground hover:text-foreground"
          title="Close (Ctrl+Shift+D)"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Log entries */}
      <div className="flex-1 overflow-auto font-mono text-[11px] leading-relaxed">
        {entries.length === 0 && (
          <p className="p-3 text-muted-foreground">No log entries.</p>
        )}
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="group border-b border-border/30 px-3 py-0.5 hover:bg-accent/30"
          >
            <div className="flex gap-2">
              <span className="shrink-0 text-muted-foreground/60">
                {entry.timestamp.slice(11, 23)}
              </span>
              <span
                className={cn(
                  "w-10 shrink-0 text-right uppercase",
                  LEVEL_STYLES[entry.level],
                )}
              >
                {entry.level}
              </span>
              <span className="shrink-0 text-muted-foreground">
                [{entry.tag}]
              </span>
              <span className="text-foreground">{entry.message}</span>
              <button
                type="button"
                onClick={() => copyLine(entry)}
                className="ml-auto hidden shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground group-hover:block"
                title="Copy line"
              >
                <Copy className="h-3 w-3" />
              </button>
            </div>
            {entry.detail && (
              <pre className="mt-0.5 whitespace-pre-wrap break-all pl-[5.5rem] text-muted-foreground/70">
                {entry.detail}
              </pre>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
