import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { BadgeTone, CommandCenterItem } from "./providers/types";

interface CommandCenterResultItemProps {
  item: CommandCenterItem;
  selected: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}

const BADGE_CLASSES: Record<BadgeTone, string> = {
  scene:
    "text-[var(--badge-scene-fg,#534AB7)] bg-[var(--badge-scene-bg,#534AB718)] border-[var(--badge-scene-fg,#534AB740)]",
  codex:
    "text-[var(--badge-codex-fg,#059669)] bg-[var(--badge-codex-bg,#05966918)] border-[var(--badge-codex-fg,#05966940)]",
  snippet:
    "text-[var(--badge-snippet-fg,#D97706)] bg-[var(--badge-snippet-bg,#D9770618)] border-[var(--badge-snippet-fg,#D9770640)]",
  score: "text-foreground/80 bg-accent/40 border-border",
  command: "text-primary bg-primary/10 border-primary/30",
};

export function CommandCenterResultItem({
  item,
  selected,
  onMouseEnter,
  onClick,
}: CommandCenterResultItemProps) {
  const { t } = useTranslation();
  const title =
    item.title || t("commandCenter.untitled", { defaultValue: "(無題)" });
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={cn(
        "flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors",
        selected ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      {item.badge && (
        <span
          className={cn(
            "flex-shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            "min-w-[46px] text-center",
            BADGE_CLASSES[item.badge.tone],
          )}
        >
          {item.badge.label}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-foreground">{title}</div>
        {item.subtitle && (
          <div className="truncate text-xs text-muted-foreground">
            {item.subtitle}
          </div>
        )}
      </div>
    </button>
  );
}
