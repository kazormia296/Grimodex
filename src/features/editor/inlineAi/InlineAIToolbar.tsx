import { Check, X } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useInlineAiStore } from "./inlineAiStore";

interface InlineAIToolbarProps {
  onAccept: () => void;
  /**
   * status === "generating" のときはストリーミング中止、
   * status === "diffShown" のときは diff を取り消して元状態に戻す。
   */
  onReject: () => void;
  onRetry: () => void;
}

/**
 * Floating toolbar shown when Inline AI diff is visible.
 * Accept (Tab) / Reject (Esc) / Retry.
 */
export function InlineAIToolbar({
  onAccept,
  onReject,
  onRetry,
}: InlineAIToolbarProps) {
  const { t } = useTranslation();
  const status = useInlineAiStore((s) => s.status);
  const isVisible = status === "diffShown" || status === "generating";

  // Tab = accept, Esc = reject
  useEffect(() => {
    if (!isVisible) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Tab" && status === "diffShown") {
        e.preventDefault();
        onAccept();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onReject();
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [isVisible, status, onAccept, onReject]);

  if (!isVisible) return null;

  const isGenerating = status === "generating";

  return (
    <div className="fixed bottom-8 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-popover px-3 py-1.5 shadow-lg">
      <button
        type="button"
        disabled={isGenerating}
        onClick={onAccept}
        className="flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-green-600 hover:bg-green-50 disabled:opacity-40 dark:hover:bg-green-950"
      >
        <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
        Accept
        {!isGenerating && (
          <kbd className="ml-0.5 rounded border border-border px-1 text-xs text-muted-foreground">
            Tab
          </kbd>
        )}
      </button>
      <div className="h-3 w-px bg-border" />
      <button
        type="button"
        onClick={onReject}
        className="flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
      >
        <X className="h-3 w-3" aria-hidden />
        Reject
        <kbd className="ml-0.5 rounded border border-border px-1 text-xs text-muted-foreground">
          Esc
        </kbd>
      </button>
      {!isGenerating && (
        <>
          <div className="h-3 w-px bg-border" />
          <button
            type="button"
            onClick={onRetry}
            className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            ↺ Retry
          </button>
        </>
      )}
      {isGenerating && (
        <span className="ml-1 text-xs text-muted-foreground animate-pulse">
          {t("aiTree.generating")}
        </span>
      )}
    </div>
  );
}
