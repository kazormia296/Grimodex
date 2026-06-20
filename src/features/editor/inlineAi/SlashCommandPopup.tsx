import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Eye,
  Languages,
  Maximize2,
  MessageSquare,
  Minimize2,
  PenLine,
  RefreshCw,
  Sparkles,
  SquareStack,
  SlidersHorizontal,
  Wand2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { InlineAiCommand } from "./inlineAiTypes";
import { isAiGenerationCommand } from "./inlineAiCommands";
import { useSlashCommandStore } from "./slashCommandStore";

type IconComponent = React.ComponentType<{ className?: string }>;

// コマンド id → アイコン。未登録は Sparkles にフォールバック。
const COMMAND_ICONS: Record<string, IconComponent> = {
  continue: PenLine,
  rewrite: RefreshCw,
  describe: Eye,
  dialogue: MessageSquare,
  shorten: Minimize2,
  expand: Maximize2,
  tone: SlidersHorizontal,
  translate: Languages,
  custom: Wand2,
  sceneBeat: SquareStack,
};

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
  const query = useSlashCommandStore((s) => s.query);
  const rect = useSlashCommandStore((s) => s.rect);
  const commandFn = useSlashCommandStore((s) => s.commandFn);
  const setKeyHandler = useSlashCommandStore((s) => s.setKeyHandler);
  const close = useSlashCommandStore((s) => s.close);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  // selectedRef はキーハンドラの真実の値。setState は非同期なので、ArrowDown→Enter
  // を連続で受けても確実に進むよう ref を同期更新する (旧実装の index ずれを修正)。
  const selectedRef = useRef(0);
  const itemsRef = useRef(items);
  const commandFnRef = useRef(commandFn);
  itemsRef.current = items;
  commandFnRef.current = commandFn;

  function selectIndex(i: number) {
    selectedRef.current = i;
    setSelectedIndex(i);
  }

  // items が変わるたび選択インデックスを先頭に戻す
  useEffect(() => {
    selectIndex(0);
  }, [items]);

  const handleSelect = (cmd: InlineAiCommand) => {
    commandFnRef.current?.(cmd);
  };

  // Suggestion 経由のキーボード操作を処理する
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent): boolean => {
      const current = itemsRef.current;
      if (current.length === 0) {
        // 候補ゼロ (no-match) のときは Escape のみ受ける。
        if (e.key === "Escape") {
          close();
          return true;
        }
        return false;
      }
      if (e.key === "ArrowDown") {
        selectIndex((selectedRef.current + 1) % current.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        selectIndex(
          (selectedRef.current - 1 + current.length) % current.length,
        );
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

  if (!isOpen || !rect) return null;

  // 候補ゼロ: 何も入力していない (query 空) ときはそもそも出さない。クエリが
  // あって一致なしのときだけ「該当なし」を出し、無反応に見える問題を防ぐ。
  const noResults = items.length === 0;
  if (noResults && query.trim() === "") return null;

  // Portal to <body> so `position: fixed` is viewport-relative.
  // Without this, a transformed ancestor (the editor pane uses transforms
  // for scroll/animation) becomes the containing block for fixed children,
  // and the menu floats far from the caret. Same fix as EditorContextMenu.
  return createPortal(
    <div
      ref={ref}
      role="listbox"
      aria-label={t("inlineAi.slashMenuLabel")}
      aria-activedescendant={
        noResults ? undefined : `slash-opt-${items[selectedIndex]?.id}`
      }
      style={{ top: rect.bottom + 4, left: rect.left }}
      className="fixed z-50 max-h-[60vh] min-w-[240px] overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-lg"
    >
      {noResults ? (
        <div
          data-testid="slash-no-results"
          className="px-3 py-2 text-xs text-muted-foreground"
        >
          {t("inlineAi.noResults")}
        </div>
      ) : (
        items.map((cmd, i) => {
          const Icon = COMMAND_ICONS[cmd.id] ?? Sparkles;
          const selected = i === selectedIndex;
          // AI 生成コマンドと構造挿入 (sceneBeat) の境目に区切りを入れる。
          const prev = items[i - 1];
          const showDivider =
            i > 0 &&
            !!prev &&
            isAiGenerationCommand(prev) &&
            !isAiGenerationCommand(cmd);
          return (
            <div key={cmd.id}>
              {showDivider && <div className="my-1 border-t border-border" />}
              <button
                type="button"
                role="option"
                id={`slash-opt-${cmd.id}`}
                aria-selected={selected}
                className={cn(
                  "flex w-full items-start gap-2 px-3 py-1.5 text-left",
                  selected
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground hover:bg-accent",
                )}
                onMouseEnter={() => selectIndex(i)}
                onClick={() => handleSelect(cmd)}
              >
                <Icon
                  className={cn(
                    "mt-0.5 h-3.5 w-3.5 shrink-0",
                    selected
                      ? "text-primary-foreground/90"
                      : "text-muted-foreground",
                  )}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate text-xs font-medium">
                      {cmd.label}
                    </span>
                    <span
                      className={cn(
                        "ml-auto shrink-0 font-mono text-[10px]",
                        selected
                          ? "text-primary-foreground/70"
                          : "text-muted-foreground/70",
                      )}
                    >
                      /{cmd.id}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "truncate text-xs",
                      selected
                        ? "text-primary-foreground/80"
                        : "text-muted-foreground",
                    )}
                  >
                    {cmd.description}
                  </span>
                </span>
              </button>
            </div>
          );
        })
      )}
    </div>,
    document.body,
  );
}
