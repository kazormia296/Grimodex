import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { INLINE_AI_COMMANDS } from "./inlineAiCommands";
import type { InlineAiCommand } from "./inlineAiTypes";

interface InlineAIPaletteProps {
  editor: Editor;
  open: boolean;
  /** Pre-selected command (from slash command trigger) */
  preselectedCommand?: InlineAiCommand | null;
  onClose: () => void;
  onSubmit: (command: InlineAiCommand, prompt: string) => void;
}

/**
 * Floating free-form AI palette triggered by Ctrl+Shift+Space.
 * Allows selecting a command and optionally providing a custom prompt.
 */
export function InlineAIPalette({
  open,
  preselectedCommand,
  onClose,
  onSubmit,
}: InlineAIPaletteProps) {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState("");
  const [selectedCommand, setSelectedCommand] = useState<InlineAiCommand>(
    preselectedCommand ?? INLINE_AI_COMMANDS[0],
  );
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setPrompt("");
      setSelectedCommand(preselectedCommand ?? INLINE_AI_COMMANDS[0]);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, preselectedCommand]);

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [open, onClose]);

  if (!open) return null;

  function handleSubmit() {
    onSubmit(selectedCommand, prompt);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-32">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-background/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full max-w-md rounded-lg border border-border bg-popover p-3 shadow-xl">
        <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Inline AI</span>
          <span className="ml-auto opacity-60">Ctrl+Shift+Space</span>
        </div>

        {/* Command selector */}
        <div className="mb-2 flex flex-wrap gap-1">
          {INLINE_AI_COMMANDS.map((cmd) => (
            <button
              key={cmd.id}
              type="button"
              onClick={() => setSelectedCommand(cmd)}
              className={cn(
                "rounded px-1.5 py-0.5 text-xs",
                selectedCommand.id === cmd.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {t(`inlineAi.commands.${cmd.id}.label`)}
            </button>
          ))}
        </div>

        {/* Prompt input */}
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder={
              selectedCommand.needsArg
                ? t(`inlineAi.commands.${selectedCommand.id}.placeholder`)
                : t("inlineAi.additionalPrompt")
            }
            className="flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="button"
            onClick={handleSubmit}
            className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            ▶
          </button>
        </div>

        <div className="mt-1.5 text-xs text-muted-foreground opacity-60">
          {t(`inlineAi.commands.${selectedCommand.id}.desc`)}
        </div>
      </div>
    </div>
  );
}
