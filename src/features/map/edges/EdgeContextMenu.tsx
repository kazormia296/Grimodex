import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

export type EdgeDirection = "none" | "forward" | "bidirectional";

export interface EdgeContextMenuState {
  edgeId: string;
  screenPosition: { x: number; y: number };
  style: "solid" | "dashed" | "dotted";
  color: string;
  direction: EdgeDirection;
  canPromoteToRelation?: boolean;
}

interface EdgeContextMenuProps extends EdgeContextMenuState {
  onClose: () => void;
  onStyleChange: (style: "solid" | "dashed" | "dotted") => void;
  onColorChange: (color: string) => void;
  onDirectionChange: (direction: EdgeDirection) => void;
  onDelete: () => void;
  onPromoteToRelation?: () => void;
  onEditLabel?: (field: "forwardLabel" | "backwardLabel") => void;
}

const COLOR_PRESETS = [
  { value: "#555555", labelKey: "map.color.gray" },
  { value: "#ef4444", labelKey: "map.color.red" },
  { value: "#f97316", labelKey: "map.color.orange" },
  { value: "#eab308", labelKey: "map.color.yellow" },
  { value: "#22c55e", labelKey: "map.color.green" },
  { value: "#3b82f6", labelKey: "map.color.blue" },
  { value: "#a855f7", labelKey: "map.color.purple" },
] as const;

const STYLE_ITEMS = [
  { value: "solid", labelKey: "map.edge.style.solid", glyph: "──" },
  { value: "dashed", labelKey: "map.edge.style.dashed", glyph: "╌╌" },
  { value: "dotted", labelKey: "map.edge.style.dotted", glyph: "···" },
] as const;

const DIRECTION_ITEMS = [
  { value: "none", labelKey: "common.none", glyph: "──" },
  { value: "forward", labelKey: "map.edge.direction.forward", glyph: "→" },
  {
    value: "bidirectional",
    labelKey: "map.edge.direction.bidirectional",
    glyph: "↔",
  },
] as const;

export function EdgeContextMenu({
  screenPosition,
  style,
  color,
  direction,
  onClose,
  onStyleChange,
  onColorChange,
  onDirectionChange,
  onDelete,
  onPromoteToRelation,
  canPromoteToRelation,
  onEditLabel,
}: EdgeContextMenuProps) {
  const { t } = useTranslation();
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
        {onEditLabel && (
          <>
            <DropdownMenuLabel>{t("map.edge.labelEdit")}</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => onEditLabel("forwardLabel")}>
              {t("map.edge.forwardLabel")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onEditLabel("backwardLabel")}>
              {t("map.edge.backwardLabel")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel>{t("map.edge.arrowDirection")}</DropdownMenuLabel>
        {DIRECTION_ITEMS.map(({ value, labelKey, glyph }) => (
          <DropdownMenuItem
            key={value}
            onSelect={() => onDirectionChange(value)}
            className={direction === value ? "font-semibold" : undefined}
          >
            <span className="inline-block w-8">{glyph}</span>
            {t(labelKey)}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("map.edge.lineStyle")}</DropdownMenuLabel>
        {STYLE_ITEMS.map(({ value, labelKey, glyph }) => (
          <DropdownMenuItem
            key={value}
            onSelect={() => onStyleChange(value)}
            className={style === value ? "font-semibold" : undefined}
          >
            <span className="inline-block w-8">{glyph}</span>
            {t(labelKey)}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("map.edge.colorChange")}</DropdownMenuLabel>
        <div className="flex flex-wrap gap-2 px-2 py-2">
          {COLOR_PRESETS.map((c) => (
            <button
              key={c.value}
              type="button"
              title={t(c.labelKey)}
              aria-label={t(c.labelKey)}
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
        {canPromoteToRelation && onPromoteToRelation && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onPromoteToRelation}>
              {t("map.edge.promoteToRelation")}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onDelete}
          className="text-[color:var(--destructive)] focus:text-[color:var(--destructive)]"
        >
          {t("common.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
