import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import { formatShortcut } from "@/lib/platform";
import { getVisibleInlineAiCommands } from "./inlineAiCommands";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import type { InlineAiCommand } from "./inlineAiTypes";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";

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
  const { t, i18n } = useTranslation();
  const bodyWriteGate = useAiGate("bodyWrite");
  // Re-translate when locale changes. getVisibleInlineAiCommands() reads from
  // i18next.t directly so eslint can't see the dependency — depend on language
  // explicitly. bodyWrite ポリシーが OFF のときは AI 生成コマンドが除外されるため
  // presentation を deps に含めて再評価する。
  const commands = useMemo(
    () => getVisibleInlineAiCommands(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [i18n.language, bodyWriteGate.presentation],
  );
  const [prompt, setPrompt] = useState("");
  const [selectedCommand, setSelectedCommand] = useState<InlineAiCommand>(
    preselectedCommand ?? commands[0],
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (open) {
      setPrompt("");
      setSelectedCommand(preselectedCommand ?? commands[0]);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, preselectedCommand, commands]);

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

  function handleSubmit() {
    onSubmit(selectedCommand, prompt);
    onClose();
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center pt-32"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : DURATIONS.fast }}
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-background/50 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            className="relative w-full max-w-md rounded-lg border border-border bg-popover p-3 shadow-xl"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={reduced ? { duration: 0 } : { ...EASINGS.spring }}
          >
            <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Inline AI</span>
              <span className="ml-auto opacity-60">
                {formatShortcut("Ctrl+Shift+Space")}
              </span>
            </div>

            {/* Command selector */}
            <div className="mb-2 flex flex-wrap gap-1">
              {commands.map((cmd) => (
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
                  {cmd.label}
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
                  selectedCommand.needsArg && selectedCommand.argPlaceholder
                    ? selectedCommand.argPlaceholder
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
              {selectedCommand.description}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
