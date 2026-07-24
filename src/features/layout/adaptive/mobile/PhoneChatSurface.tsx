import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

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
  sendDisabled?: boolean;
  disabledHint?: string | null;
  hideComposer?: boolean;
  onOpenSettings?: () => void;
}

export function PhoneChatSurface({
  messages,
  onSend,
  disabled = false,
  sendDisabled = false,
  disabledHint,
  hideComposer = false,
  onOpenSettings,
}: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const disabledHintId = useId();
  return (
    <section
      aria-label={t("mobileWorkspace.surfaces.ai.label")}
      data-phone-chat-surface
      className="flex min-h-full flex-col"
    >
      <div
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
        aria-live="polite"
      >
        {messages.length === 0 && (
          <p className="mx-auto max-w-xs py-10 text-center text-sm text-muted-foreground">
            {t("mobileWorkspace.surfaces.ai.empty")}
          </p>
        )}
        {messages.map((message) => (
          <article
            key={message.id}
            data-message-role={message.role}
            className="rounded border p-3"
          >
            <p className="m-0 whitespace-pre-wrap">{message.text}</p>
            {message.streaming && (
              <span className="text-xs text-muted-foreground">
                {t("mobileWorkspace.surfaces.ai.streaming")}
              </span>
            )}
          </article>
        ))}
      </div>
      {disabledHint && (
        <div
          id={disabledHintId}
          role="status"
          className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground"
        >
          <span>{disabledHint}</span>
          {onOpenSettings && (
            <button
              type="button"
              className="min-h-11 shrink-0 rounded px-3 font-medium text-foreground underline"
              onClick={onOpenSettings}
            >
              {t("mobileWorkspace.surfaces.ai.openSettings")}
            </button>
          )}
        </div>
      )}
      {!hideComposer && (
        <form
          className="sticky bottom-0 flex gap-2 border-t bg-background p-3 pb-[calc(12px+env(safe-area-inset-bottom))]"
          onSubmit={(event) => {
            event.preventDefault();
            const text = draft.trim();
            if (!text || disabled || sendDisabled) return;
            onSend(text);
            setDraft("");
          }}
        >
          <textarea
            aria-label={t("mobileWorkspace.surfaces.ai.message")}
            aria-describedby={disabledHint ? disabledHintId : undefined}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={disabled}
            rows={2}
            className="min-h-11 min-w-0 flex-1 resize-none rounded border p-2"
          />
          <button
            type="submit"
            className="min-h-11 min-w-11 rounded bg-primary px-3 text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40"
            disabled={disabled || sendDisabled || !draft.trim()}
            aria-describedby={disabledHint ? disabledHintId : undefined}
          >
            {t("mobileWorkspace.surfaces.ai.send")}
          </button>
        </form>
      )}
    </section>
  );
}
