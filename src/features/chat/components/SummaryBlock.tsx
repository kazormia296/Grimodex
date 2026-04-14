import { useState } from "react";
import { useTranslation } from "react-i18next";

interface SummaryBlockProps {
  summary: string;
}

export function SummaryBlock({ summary }: SummaryBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();

  return (
    <div className="my-1 rounded border border-amber-500/40 bg-amber-50/20 text-xs dark:bg-amber-900/10">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-amber-100/20 dark:hover:bg-amber-800/20"
      >
        <span className="shrink-0 text-amber-600 dark:text-amber-400">📋</span>
        <span className="font-medium text-amber-700 dark:text-amber-300">
          {t("chat.conversationSummary")}
        </span>
        <span className="ml-auto shrink-0 text-amber-600/70 dark:text-amber-400/70">
          {expanded ? "▲" : "▼"}
        </span>
      </button>
      {expanded && summary && (
        <div className="border-t border-amber-500/30 px-2 py-1.5">
          <p className="whitespace-pre-wrap text-amber-800 dark:text-amber-200">
            {summary}
          </p>
        </div>
      )}
    </div>
  );
}
