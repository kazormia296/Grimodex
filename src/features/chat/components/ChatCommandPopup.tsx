import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { ChatCommand } from "../extensions/chatCommands";

/** 入力欄側の aria-controls / aria-activedescendant から参照する listbox id。 */
export const CHAT_COMMAND_LISTBOX_ID = "chat-command-popup-listbox";

/** aria-activedescendant で指す option id（selectedIndex と同期）。 */
export function chatCommandOptionId(index: number): string {
  return `${CHAT_COMMAND_LISTBOX_ID}-option-${index}`;
}

interface ChatCommandPopupProps {
  items: ChatCommand[];
  selectedIndex: number;
  onSelect: (cmd: ChatCommand) => void;
  onChangeIndex: (index: number) => void;
  clientRect: (() => DOMRect | null) | null | undefined;
}

export function ChatCommandPopup({
  items,
  selectedIndex,
  onSelect,
  onChangeIndex,
  clientRect,
}: ChatCommandPopupProps) {
  const { t } = useTranslation();
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        onChangeIndex((selectedIndex + 1) % Math.max(items.length, 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        onChangeIndex(
          (selectedIndex - 1 + Math.max(items.length, 1)) %
            Math.max(items.length, 1),
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = items[selectedIndex];
        if (item) onSelect(item);
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [items, selectedIndex, onSelect, onChangeIndex]);

  if (items.length === 0) return null;

  const rect = clientRect?.();
  const style = rect
    ? {
        position: "fixed" as const,
        left: `${rect.left}px`,
        bottom: `${window.innerHeight - rect.top + 4}px`,
        zIndex: 50,
      }
    : { position: "fixed" as const, left: 0, bottom: 0, zIndex: 50 };

  return (
    <ul
      id={CHAT_COMMAND_LISTBOX_ID}
      role="listbox"
      aria-label={t("chat.context.commandSuggestions")}
      style={style}
      className="max-h-48 min-w-[220px] overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md"
    >
      {items.map((cmd, i) => (
        <li
          key={cmd.id}
          id={chatCommandOptionId(i)}
          role="option"
          aria-selected={i === selectedIndex}
          onClick={() => onSelect(cmd)}
          className={[
            "flex cursor-pointer flex-col px-3 py-1.5 text-xs",
            i === selectedIndex
              ? "bg-primary text-primary-foreground"
              : "hover:bg-accent",
          ].join(" ")}
        >
          <span className="font-medium">{cmd.label}</span>
          <span
            className={
              i === selectedIndex
                ? "text-primary-foreground/80"
                : "text-muted-foreground"
            }
          >
            {cmd.description}
          </span>
        </li>
      ))}
    </ul>
  );
}
