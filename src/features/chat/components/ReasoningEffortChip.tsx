import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Gauge } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAnchoredPopover } from "./useAnchoredPopover";

export type ReasoningEffortValue = "low" | "medium" | "high";

interface ReasoningEffortChipProps {
  /** 現在の上書き値。null = タスク既定 (Auto) */
  value: ReasoningEffortValue | null;
  /** モデルが許可する effort 値（caps.reasoningEffortValues） */
  options: ReasoningEffortValue[];
  /** Thinking が実効 ON か。OFF 中は effort が送られないため操作不可にする */
  thinkingEnabled: boolean;
  onChange: (value: ReasoningEffortValue | null) => void;
}

/**
 * チャット入力欄下段の reasoning effort 切替 chip。
 * 設定ページ（AiCategory）の select と同じ aiSettings.reasoningEffortOverride
 * を読み書きする想定で、表示条件 (caps.supportsReasoning) は親が判定する。
 */
export function ReasoningEffortChip({
  value,
  options,
  thinkingEnabled,
  onChange,
}: ReasoningEffortChipProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // メニューは入力欄上部に開くため上向き。.glass-chat の backdrop-filter が作る
  // stacking context に埋もれないよう document.body へ portal する。
  const { popoverRef, style } = useAnchoredPopover(
    triggerRef,
    open,
    () => setOpen(false),
    "top-start",
  );

  // 許可値が 1 つ以下のモデル（例: gpt-5-pro は high 固定）は切替の意味が無い
  const locked = options.length <= 1;
  const disabled = !thinkingEnabled || locked;

  const title = !thinkingEnabled
    ? t("chat.reasoningEffortNeedsThinking")
    : locked
      ? t("chat.reasoningEffortLocked")
      : t("chat.reasoningEffortTitle");

  const handleSelect = (next: ReasoningEffortValue | null) => {
    setOpen(false);
    onChange(next);
  };

  const items: Array<ReasoningEffortValue | null> = [null, ...options];

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
        className={[
          "flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors",
          disabled
            ? "cursor-not-allowed text-muted-foreground/40"
            : value !== null
              ? "bg-primary/10 text-primary hover:bg-primary/15"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
        ].join(" ")}
      >
        <Gauge className="h-3 w-3 shrink-0" />
        <span>{value ?? t("chat.reasoningEffortAuto")}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>

      {open &&
        style &&
        createPortal(
          <div
            ref={popoverRef}
            role="listbox"
            aria-label={t("chat.reasoningEffortTitle")}
            style={style}
            className="z-[100] min-w-[140px] rounded-md border border-border bg-popover py-1 shadow-md"
          >
            {items.map((item) => (
              <button
                key={item ?? "auto"}
                type="button"
                role="option"
                aria-selected={item === value}
                onClick={() => handleSelect(item)}
                className={[
                  "w-full px-3 py-1.5 text-left text-xs hover:bg-accent",
                  item === value
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                ].join(" ")}
              >
                {item ?? t("chat.reasoningEffortAuto")}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
