import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BookMarked } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAnchoredPopover } from "@/components/ui/useAnchoredPopover";
import { usePromptLibraryStore } from "./promptLibraryStore";
import type { PromptTemplate } from "./api";

interface PromptTemplatePickerProps {
  /** テンプレ選択時に呼ばれる。挿入は呼び出し側（ChatInput）が行う。 */
  onSelect: (template: PromptTemplate) => void;
  disabled?: boolean;
}

/**
 * チャット入力欄の下段ツール列に置くプロンプトテンプレートピッカー。
 * 保存済みテンプレを選んで入力エディタへ挿入する導線。
 * `.glass-chat` の backdrop-filter stacking context を避けるため
 * useAnchoredPopover で document.body へ portal する。
 */
export function PromptTemplatePicker({
  onSelect,
  disabled,
}: PromptTemplatePickerProps) {
  const { t } = useTranslation();
  const templates = usePromptLibraryStore((s) => s.templates);
  const ensureLoaded = usePromptLibraryStore((s) => s.ensureLoaded);

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popover = useAnchoredPopover(
    triggerRef,
    open,
    () => setOpen(false),
    "top-start",
  );

  // open 時に最新のテンプレを読む（Settings での追加を取りこぼさない）。
  useEffect(() => {
    if (open) void ensureLoaded();
  }, [open, ensureLoaded]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("promptLibrary.picker.title")}
        className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        <BookMarked className="h-3 w-3 shrink-0" aria-hidden />
        <span>{t("promptLibrary.picker.label")}</span>
      </button>

      {open &&
        popover.style &&
        createPortal(
          <div
            ref={popover.popoverRef}
            style={popover.style}
            role="menu"
            className="z-[100] max-h-64 min-w-[240px] max-w-[320px] overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md"
          >
            {templates.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {t("promptLibrary.picker.empty")}
              </p>
            ) : (
              templates.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSelect(tpl);
                    setOpen(false);
                  }}
                  className="block w-full px-3 py-1.5 text-left hover:bg-accent"
                >
                  <span className="block truncate text-xs font-medium text-foreground">
                    {tpl.title}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {tpl.content}
                  </span>
                </button>
              ))
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
