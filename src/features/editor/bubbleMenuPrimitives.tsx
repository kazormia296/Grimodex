import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function BubbleButton({
  testId,
  label,
  active,
  onClick,
  children,
  phone = false,
  disabled = false,
}: {
  testId: string;
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  phone?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      data-testid={testId}
      aria-label={label}
      title={label}
      {...(active !== undefined ? { "aria-pressed": active } : {})}
      // 押下でエディタの選択が外れない (= 直後のコマンドが選択へ効く) よう preventDefault。
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex items-center justify-center rounded text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        phone ? "min-h-11 min-w-11 px-2" : "h-6 min-w-[24px] px-1",
        active && "bg-accent text-foreground",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {children}
    </button>
  );
}

export function Sep() {
  return <div aria-hidden className="mx-0.5 h-4 w-px bg-border" />;
}
