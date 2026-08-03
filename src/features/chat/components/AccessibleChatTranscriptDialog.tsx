import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ChatMessage } from "../chatTypes";
import { stripToolProtocol } from "../toolProtocol";
import { isQuiescenceLeaseActive } from "@/application/lifecycle/quiescenceLease";
import { useQuiescenceLeaseActive } from "@/application/lifecycle/useQuiescenceLeaseActive";

interface AccessibleChatTranscriptDialogProps {
  messages: readonly ChatMessage[];
}

function roleLabelKey(role: ChatMessage["role"]) {
  switch (role) {
    case "assistant":
      return "chat.transcript.assistant";
    case "user":
      return "chat.transcript.user";
    case "system":
      return "chat.transcript.system";
  }
}

/**
 * Non-virtualized, static projection of the loaded conversation for screen
 * readers and browser find. It deliberately avoids ChatMessage/TipTap/markdown
 * mounts so the accessibility escape hatch remains cheap and deterministic.
 */
export function AccessibleChatTranscriptDialog({
  messages,
}: AccessibleChatTranscriptDialogProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const lifecycleLocked = useQuiescenceLeaseActive();

  useEffect(() => {
    if (lifecycleLocked) setOpen(false);
  }, [lifecycleLocked]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen && isQuiescenceLeaseActive()) return;
    setOpen(nextOpen);
  }, []);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <div className="flex shrink-0 justify-end border-b border-border/50 px-4 py-1.5">
        <DialogTrigger asChild>
          <button
            type="button"
            disabled={lifecycleLocked}
            aria-disabled={lifecycleLocked || undefined}
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {t("chat.transcript.open")}
          </button>
        </DialogTrigger>
      </div>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t("chat.transcript.title")}</DialogTitle>
          <DialogDescription>
            {t("chat.transcript.description", { count: messages.length })}
          </DialogDescription>
        </DialogHeader>
        <ol
          className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-2"
          aria-label={t("chat.transcript.listLabel")}
        >
          {messages.map((message) => (
            <li
              key={message.id}
              className="rounded-md border border-border p-3"
            >
              <h3 className="mb-1 text-xs font-medium text-muted-foreground">
                {t(roleLabelKey(message.role))}
              </h3>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {message.role === "assistant"
                  ? stripToolProtocol(message.content)
                  : message.content}
              </p>
            </li>
          ))}
        </ol>
      </DialogContent>
    </Dialog>
  );
}
