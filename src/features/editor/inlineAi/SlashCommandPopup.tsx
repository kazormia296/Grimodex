import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { filterCommands } from "./inlineAiCommands";
import type { InlineAiCommand } from "./inlineAiTypes";

interface SlashCommandPopupProps {
  query: string;
  position: { top: number; left: number };
  onSelect: (command: InlineAiCommand) => void;
  onClose: () => void;
}

/**
 * Autocomplete dropdown rendered when user types "/" at line start.
 * Receives filtered commands from parent; handles keyboard navigation internally.
 */
export function SlashCommandPopup({
  query,
  position,
  onSelect,
  onClose,
}: SlashCommandPopupProps) {
  const items = filterCommands(query);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, items.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (items[selectedIndex]) onSelect(items[selectedIndex]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [items, selectedIndex, onSelect, onClose]);

  // Close on outside click
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [onClose]);

  if (items.length === 0) return null;

  return (
    <div
      ref={ref}
      style={{ top: position.top, left: position.left }}
      className="fixed z-50 min-w-[220px] rounded-md border border-border bg-popover py-1 shadow-lg"
    >
      {items.map((cmd, i) => (
        <button
          key={cmd.id}
          type="button"
          className={cn(
            "flex w-full flex-col px-3 py-1.5 text-left",
            i === selectedIndex
              ? "bg-accent text-foreground"
              : "text-foreground hover:bg-accent/50",
          )}
          onMouseEnter={() => setSelectedIndex(i)}
          onClick={() => onSelect(cmd)}
        >
          <span className="text-xs font-medium">/{cmd.id}</span>
          <span className="text-xs text-muted-foreground">
            {cmd.description}
          </span>
        </button>
      ))}
    </div>
  );
}
