import { useEffect, useState } from "react";
import { BookOpen, Bookmark } from "lucide-react";
import { listCodexEntriesByMessageId } from "@/features/codex/api";
import { listSnippetsByMessageId } from "@/features/snippets/api";

interface MessageBadgeProps {
  messageId: string;
}

interface BadgeData {
  codexCount: number;
  snippetCount: number;
}

export function MessageBadge({ messageId }: MessageBadgeProps) {
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

  if (!data) return null;

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {data.codexCount > 0 && (
        <span
          data-testid={`badge-codex-${messageId}`}
          className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] text-blue-700 dark:bg-blue-900 dark:text-blue-300"
        >
          <BookOpen className="h-2.5 w-2.5" />
          Codex抽出済 ({data.codexCount})
        </span>
      )}
      {data.snippetCount > 0 && (
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
