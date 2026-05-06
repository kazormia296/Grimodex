import { MessageSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CodexEntry } from "../api";
import { ReferencesSection } from "./ReferencesSection";

interface MentionsTabProps {
  entry: CodexEntry;
  sourceSessionTitle: string | null;
}

export function MentionsTab({ entry, sourceSessionTitle }: MentionsTabProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <ReferencesSection entry={entry} />

      {entry.sourceChatMessageId && (
        <div
          data-testid="codex-source-chat-link"
          className="flex items-center gap-1.5 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
        >
          <MessageSquare className="h-3.5 w-3.5" />
          <span>
            {t("codex.mentions.sourceChat", {
              title: sourceSessionTitle ?? entry.sourceChatMessageId,
            })}
          </span>
        </div>
      )}
    </div>
  );
}
