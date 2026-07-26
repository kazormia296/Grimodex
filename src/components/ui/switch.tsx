import * as React from "react";
import { cn } from "@/lib/utils";

const SIZE_STYLES = {
  md: {
    track: "h-5 w-9",
    thumb: "h-4 w-4",
    thumbOn: "translate-x-4",
    thumbOff: "translate-x-0",
  },
  sm: {
    track: "h-[17px] w-[30px] p-[2px]",
    thumb: "h-[13px] w-[13px]",
    thumbOn: "translate-x-[13px]",
    thumbOff: "translate-x-0",
  },
} as const;

export interface SwitchProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "role" | "type" | "aria-checked" | "onChange"
> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  size?: keyof typeof SIZE_STYLES;
}

/**
 * アプリ共通のトグルスイッチ。`--switch-*` トークンと `.ui-switch` ベーススタイル
 * (index.css) で描画し、全画面で同一のコントラストを保証する。
 */
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  function Switch(
    {
      checked,
      onCheckedChange,
      disabled,
      size = "md",
      className,
      onClick,
      ...props
    },
    ref,
  ) {
    const s = SIZE_STYLES[size];
    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={(e) => {
          onClick?.(e);
          if (!e.defaultPrevented) onCheckedChange(!checked);
        }}
        className={cn(
          "ui-switch relative inline-flex flex-shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          s.track,
          className,
        )}
        data-state={checked ? "checked" : "unchecked"}
        {...props}
      >
        <span
          className={cn(
            "ui-switch-thumb pointer-events-none block rounded-full shadow transition-transform",
            s.thumb,
            checked ? s.thumbOn : s.thumbOff,
          )}
        />
      </button>
    );
  },
);
