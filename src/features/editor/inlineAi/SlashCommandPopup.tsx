import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { InlineAiCommand } from "./inlineAiTypes";
import { useSlashCommandStore } from "./slashCommandStore";

/**
 * `/` 入力時に表示されるインライン AI コマンドのオートコンプリート。
 * 位置・items・選択確定コールバックは `useSlashCommandStore` から取得し、
 * Extension からの状態更新に追従する。キーボード操作は Suggestion プラグインの
 * `onKeyDown` → store.keyHandler 経由でエディタから転送される。
 */
export function SlashCommandPopup() {
  const { t } = useTranslation();
  const isOpen = useSlashCommandStore((s) => s.isOpen);
  const items = useSlashCommandStore((s) => s.items);
  const rect = useSlashCommandStore((s) => s.rect);
  const commandFn = useSlashCommandStore((s) => s.commandFn);
  const setKeyHandler = useSlashCommandStore((s) => s.setKeyHandler);
  const close = useSlashCommandStore((s) => s.close);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const selectedRef = useRef(selectedIndex);
  const itemsRef = useRef(items);
  const commandFnRef = useRef(commandFn);
  selectedRef.current = selectedIndex;
  itemsRef.current = items;
  commandFnRef.current = commandFn;

  // items が変わるたび選択インデックスを先頭に戻す
  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  const handleSelect = (cmd: InlineAiCommand) => {
    commandFnRef.current?.(cmd);
  };

  // Suggestion 経由のキーボード操作を処理する
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent): boolean => {
      const current = itemsRef.current;
      if (current.length === 0) return false;
      if (e.key === "ArrowDown") {
        setSelectedIndex((i) => (i + 1) % current.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        setSelectedIndex((i) => (i - 1 + current.length) % current.length);
        return true;
      }
      if (e.key === "Enter") {
        const item = current[selectedRef.current];
        if (item) handleSelect(item);
        return true;
      }
      if (e.key === "Escape") {
        close();
        return true;
      }
      return false;
    };
    setKeyHandler(handler);
    return () => setKeyHandler(null);
  }, [isOpen, setKeyHandler, close]);

  // ポップアップ外クリックで閉じる
  useEffect(() => {
    if (!isOpen) return;
    function handleMouseDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) close();
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isOpen, close]);

  if (!isOpen || items.length === 0 || !rect) return null;

  return (
    <div
      ref={ref}
      style={{ top: rect.bottom + 4, left: rect.left }}
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
          onClick={() => handleSelect(cmd)}
        >
          <span className="text-xs font-medium">/{cmd.id}</span>
          <span className="text-xs text-muted-foreground">
            {t(`inlineAi.commands.${cmd.id}.desc`)}
          </span>
        </button>
      ))}
    </div>
  );
}
