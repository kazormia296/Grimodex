import { useState } from "react";

export interface PhoneChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
}

interface Props {
  messages: readonly PhoneChatMessage[];
  onSend: (text: string) => void;
  disabled?: boolean;
}

export function PhoneChatSurface({
  messages,
  onSend,
  disabled = false,
}: Props) {
  const [draft, setDraft] = useState("");
  return (
    <section
      aria-label="AI chat"
      data-phone-chat-surface
      className="flex min-h-full flex-col"
    >
      <div
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
        aria-live="polite"
      >
        {messages.map((message) => (
          <article
            key={message.id}
            data-message-role={message.role}
            className="rounded border p-3"
          >
            <p className="m-0 whitespace-pre-wrap">{message.text}</p>
            {message.streaming && (
              <span className="text-xs text-muted-foreground">Streaming…</span>
            )}
          </article>
        ))}
      </div>
      <form
        className="sticky bottom-0 flex gap-2 border-t bg-background p-3 pb-[calc(12px+env(safe-area-inset-bottom)+var(--keyboard-inset,0px))]"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (!text || disabled) return;
          onSend(text);
          setDraft("");
        }}
      >
        <textarea
          aria-label="Message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={disabled}
          rows={2}
          className="min-h-11 min-w-0 flex-1 resize-none rounded border p-2"
        />
        <button
          type="submit"
          className="min-h-11 min-w-11 rounded bg-primary px-3 text-primary-foreground"
          disabled={disabled || !draft.trim()}
        >
          Send
        </button>
      </form>
    </section>
  );
}
