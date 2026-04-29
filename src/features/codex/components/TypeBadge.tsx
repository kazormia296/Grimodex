import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import type { CodexEntryType } from "../api";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";

const TYPE_COLOR_DEFAULTS: Record<CodexEntryType, string> = {
  character: "#6B7ADB",
  location: "#5BAD8F",
  item: "#C27D3C",
  lore: "#9B6BB5",
};

const TYPE_ORDER: CodexEntryType[] = ["character", "location", "item", "lore"];

interface TypeBadgeProps {
  type: CodexEntryType;
  onChange: (type: CodexEntryType) => void;
  testId?: string;
}

export function TypeBadge({
  type,
  onChange,
  testId = "codex-detail-type",
}: TypeBadgeProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const typeColorMap = useCodexHighlightStore((s) => s.typeColorMap);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const colorOf = (k: CodexEntryType) =>
    typeColorMap[k]?.fg ?? TYPE_COLOR_DEFAULTS[k];

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        data-testid={testId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-full border border-border bg-transparent py-1 pl-2 pr-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent"
      >
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: colorOf(type) }}
        />
        <span>{t(`codex.${type}`)}</span>
        <ChevronDown className="h-3 w-3 text-muted-foreground/70" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full z-30 mt-1.5 min-w-[220px] rounded-lg border border-border bg-popover p-1 shadow-lg"
        >
          {TYPE_ORDER.map((k) => {
            const selected = k === type;
            return (
              <button
                key={k}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(k);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-left text-sm transition-colors ${
                  selected ? "bg-accent" : "hover:bg-accent/60"
                }`}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: colorOf(k) }}
                />
                <span className="text-foreground">{t(`codex.${k}`)}</span>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {k.charAt(0).toUpperCase() + k.slice(1)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
