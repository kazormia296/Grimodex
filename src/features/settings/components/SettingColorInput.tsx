import { useEffect, useId, useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useSettingControl } from "../useSettingControl";
import { useSettingRowA11y } from "./SettingRow";

const COLOR_SWATCHES = [
  "#111827",
  "#475569",
  "#9CA3AF",
  "#FFFFFF",
  "#EF4444",
  "#F97316",
  "#EAB308",
  "#84CC16",
  "#22C55E",
  "#14B8A6",
  "#06B6D4",
  "#3B82F6",
  "#6366F1",
  "#8B5CF6",
  "#D946EF",
  "#F43F5E",
] as const;

function normalizeHexColor(value: string) {
  const candidate = value.trim().replace(/^#?/, "#");
  return /^#[\da-f]{6}$/i.test(candidate) ? candidate.toUpperCase() : null;
}

interface SettingColorInputProps {
  settingKey: string;
  defaultValue: string;
}

/**
 * A portal-backed picker keeps color controls inside the viewport even when a
 * settings pane clips its own contents. The HEX field still permits arbitrary
 * colors without relying on the browser's unpositioned native picker.
 */
export function SettingColorInput({
  settingKey,
  defaultValue,
}: SettingColorInputProps) {
  const { value, setValue } = useSettingControl(settingKey, defaultValue);
  const rowA11y = useSettingRowA11y();
  const currentColor =
    normalizeHexColor(value) ?? normalizeHexColor(defaultValue) ?? "#000000";
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(currentColor);
  const hexInputId = useId();

  useEffect(() => {
    setDraft(currentColor);
  }, [currentColor]);

  const commit = (next: string) => {
    const color = normalizeHexColor(next);
    if (!color) return false;
    setValue(color);
    setDraft(color);
    return true;
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setDraft(currentColor);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="setting-color-input-trigger"
          aria-labelledby={rowA11y?.labelId}
          aria-describedby={rowA11y?.descriptionId}
          className="flex h-7 w-28 items-center gap-2 rounded border border-input bg-background px-1.5 text-left font-mono text-xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span
            aria-hidden
            className="size-4 shrink-0 rounded-sm border border-black/15 shadow-sm"
            style={{ backgroundColor: currentColor }}
          />
          <span className="truncate">{currentColor}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-testid="setting-color-input-palette"
        aria-label="Color palette"
        side="left"
        align="center"
        sideOffset={8}
        collisionPadding={12}
        className="z-[100] w-60 p-3"
      >
        <div
          className="grid grid-cols-4 gap-2"
          role="group"
          aria-label="Colors"
        >
          {COLOR_SWATCHES.map((color) => (
            <button
              key={color}
              type="button"
              data-color-swatch={color}
              aria-label={color}
              aria-pressed={color === currentColor}
              className={`size-8 rounded-md border shadow-sm transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${color === currentColor ? "border-primary ring-1 ring-primary" : "border-black/15"}`}
              style={{ backgroundColor: color }}
              onClick={() => {
                commit(color);
                setOpen(false);
              }}
            />
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
          <label
            htmlFor={hexInputId}
            className="text-xs font-medium text-muted-foreground"
          >
            HEX
          </label>
          <input
            id={hexInputId}
            type="text"
            inputMode="text"
            spellCheck={false}
            value={draft}
            maxLength={7}
            onChange={(event) => {
              const next = event.target.value;
              setDraft(next);
              commit(next);
            }}
            onBlur={() => {
              if (!commit(draft)) setDraft(currentColor);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (commit(draft)) setOpen(false);
            }}
            className="h-8 min-w-0 flex-1 rounded border border-input bg-background px-2 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
