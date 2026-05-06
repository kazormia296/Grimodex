import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

export interface EdgeContextMenuState {
  edgeId: string;
  screenPosition: { x: number; y: number };
  style: "solid" | "dashed" | "dotted";
  color: string;
}

interface EdgeContextMenuProps extends EdgeContextMenuState {
  onClose: () => void;
  onStyleChange: (style: "solid" | "dashed" | "dotted") => void;
  onColorChange: (color: string) => void;
  onDelete: () => void;
}

const COLOR_PRESETS = [
  { value: "#555555", label: "グレー" },
  { value: "#ef4444", label: "赤" },
  { value: "#f97316", label: "オレンジ" },
  { value: "#eab308", label: "黄" },
  { value: "#22c55e", label: "緑" },
  { value: "#3b82f6", label: "青" },
  { value: "#a855f7", label: "紫" },
] as const;

const STYLE_ITEMS = [
  { value: "solid", label: "実線", glyph: "──" },
  { value: "dashed", label: "破線", glyph: "╌╌" },
  { value: "dotted", label: "点線", glyph: "···" },
] as const;

export function EdgeContextMenu({
  screenPosition,
  style,
  color,
  onClose,
  onStyleChange,
  onColorChange,
  onDelete,
}: EdgeContextMenuProps) {
  return (
    <DropdownMenu
      open
      modal={false}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          style={{
            position: "fixed",
            left: screenPosition.x,
            top: screenPosition.y,
            width: 0,
            height: 0,
            pointerEvents: "none",
          }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        <DropdownMenuLabel>線種</DropdownMenuLabel>
        {STYLE_ITEMS.map(({ value, label, glyph }) => (
          <DropdownMenuItem
            key={value}
            onSelect={() => onStyleChange(value)}
            className={style === value ? "font-semibold" : undefined}
          >
            <span className="inline-block w-8">{glyph}</span>
            {label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>色変更</DropdownMenuLabel>
        <div className="flex flex-wrap gap-2 px-2 py-2">
          {COLOR_PRESETS.map((c) => (
            <button
              key={c.value}
              type="button"
              title={c.label}
              aria-label={c.label}
              className="rounded-full border-2 transition-transform hover:scale-110"
              style={{
                width: 20,
                height: 20,
                background: c.value,
                borderColor:
                  color === c.value ? "var(--foreground)" : "transparent",
              }}
              onClick={() => {
                onColorChange(c.value);
                onClose();
              }}
            />
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onDelete}
          className="text-[color:var(--destructive)] focus:text-[color:var(--destructive)]"
        >
          削除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
