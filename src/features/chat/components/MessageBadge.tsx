import { useEffect, useState } from "react";
import { BookOpen, Bookmark, StopCircle } from "lucide-react";
import { listCodexEntriesByMessageId } from "@/features/codex/api";
import { listSnippetsByMessageId } from "@/features/snippets/api";

interface MessageBadgeProps {
  messageId: string;
  stopped?: boolean;
}

interface BadgeData {
  codexCount: number;
  snippetCount: number;
}

export function MessageBadge({ messageId, stopped }: MessageBadgeProps) {
  const [data, setData] = useState<BadgeData | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [codexEntries, snippetEntries] = await Promise.all([
        listCodexEntriesByMessageId(messageId),
        listSnippetsByMessageId(messageId),
      ]);
      if (!cancelled) {
        const codexCount = codexEntries.length;
        const snippetCount = snippetEntries.length;
        if (codexCount > 0 || snippetCount > 0) {
          setData({ codexCount, snippetCount });
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  if (!data && !stopped) return null;

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {stopped && (
        <span
          data-testid={`badge-stopped-${messageId}`}
          className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900 dark:text-amber-300"
        >
          <StopCircle className="h-2.5 w-2.5" /> Stopped
        </span>
      )}
      {data && data.codexCount > 0 && (
        <span
          data-testid={`badge-codex-${messageId}`}
          className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] text-blue-700 dark:bg-blue-900 dark:text-blue-300"
        >
          <BookOpen className="h-2.5 w-2.5" />
          Codex抽出済 ({data.codexCount})
        </span>
      )}
      {data && data.snippetCount > 0 && (
        <span
          data-testid={`badge-snippet-${messageId}`}
          className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] text-green-700 dark:bg-green-900 dark:text-green-300"
        >
          <Bookmark className="h-2.5 w-2.5" />
          Snippet保存済 ({data.snippetCount})
        </span>
      )}
    </div>
  );
}
