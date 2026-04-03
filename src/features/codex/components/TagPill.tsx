const TYPE_COLOR_DEFAULTS: Record<string, string> = {
  character: "#534AB7",
  location: "#0F6E56",
  item: "#BA7517",
  lore: "#993C1D",
};

interface TagPillProps {
  name: string;
  color?: string | null;
  onRemove?: () => void;
  onClick?: () => void;
  size?: "sm" | "md";
}

export function TagPill({
  name,
  color,
  onRemove,
  onClick,
  size = "md",
}: TagPillProps) {
  const bg = color ?? TYPE_COLOR_DEFAULTS[name] ?? "#888888";
  const sizeClasses =
    size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs";

  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full font-medium text-white ${sizeClasses}`}
      style={{ backgroundColor: bg }}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") onClick();
            }
          : undefined
      }
    >
      {name}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="ml-0.5 leading-none opacity-70 hover:opacity-100"
          aria-label={`${name}を削除`}
        >
          ×
        </button>
      )}
    </span>
  );
}
