import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnimatedDropdown } from "@/components/ui/animated-dropdown";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { getVisibleInlineAiCommands } from "./inlineAi/inlineAiCommands";
import type { InlineAiCommand } from "./inlineAi/inlineAiTypes";
import { Sep } from "./bubbleMenuPrimitives";

interface BubbleAiMenuProps {
  onCommand: (cmd: InlineAiCommand) => void;
}

/**
 * バブルメニュー内の「AI で編集」サブトリガー。選択テキストに効く AI コマンド
 * (rewrite/shorten/expand/tone/translate = needsSelection:true) を集約する。
 *
 * これらは "/" スラッシュメニューからは起動できない (打鍵が選択を破壊する) ため、
 * 選択を保持したまま起動できるこの導線 (と Ctrl+Shift+Space パレット) を正規経路
 * とする。表示ゲートは bodyWrite ポリシー: OFF のとき getVisibleInlineAiCommands()
 * が AI 生成コマンドを除外して空になり、ボタンごと隠れる (ライセンスは onCommand →
 * generate 内の click 時ゲートが担う。slash/palette と同じ扱い)。
 */
export function BubbleAiMenu({ onCommand }: BubbleAiMenuProps) {
  const { t, i18n } = useTranslation();
  // policy トグルで表示集合を再評価するため presentation を購読 (palette と同型)。
  const gate = useAiGate("bodyWrite");
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  const commands = useMemo(
    () => getVisibleInlineAiCommands().filter((cmd) => cmd.needsSelection),
    // getVisibleInlineAiCommands は i18next.t / policy を同期参照するので、
    // 言語と policy presentation を明示 deps にして再評価する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [i18n.language, gate.presentation],
  );

  // bodyWrite OFF ⇒ 空 ⇒ ボタンごと非表示 (孤児セパレータも残さない)。
  if (commands.length === 0) return null;

  return (
    <>
      <Sep />
      <button
        ref={anchorRef}
        type="button"
        data-testid="bubble-ai"
        aria-label={t("editor.bubbleMenu.ai")}
        title={t("editor.bubbleMenu.ai")}
        aria-pressed={open}
        aria-haspopup="menu"
        aria-expanded={open}
        // 押下でエディタの選択が外れない (= 直後のコマンドが選択へ効く) よう preventDefault。
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-7 min-w-[28px] items-center justify-center rounded px-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          open && "bg-accent text-foreground",
        )}
      >
        <Sparkles className="h-3.5 w-3.5" />
      </button>
      <AnimatedDropdown
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        placement="bottom-start"
        // MUST: 既定 true だと開時にメニューへフォーカス移動 → エディタが blur し、
        // バブルが hasFocus=false で自己 unmount してしまう (このサブメニューごと消える)。
        autoFocusContent={false}
        className="z-[100] min-w-[168px] rounded-md border border-border bg-popover py-1 shadow-lg"
      >
        <ul role="menu" className="m-0 list-none p-0 text-xs">
          {commands.map((cmd) => (
            <li key={cmd.id} role="none">
              <button
                type="button"
                role="menuitem"
                data-testid={`bubble-ai-${cmd.id}`}
                title={cmd.description}
                // 選択保持 (replace 対象範囲 / palette 経路の両方に必要)。
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onCommand(cmd);
                  setOpen(false);
                }}
                className="block w-full px-3 py-1.5 text-left text-foreground transition-colors hover:bg-primary hover:text-primary-foreground"
              >
                {cmd.label}
              </button>
            </li>
          ))}
        </ul>
      </AnimatedDropdown>
    </>
  );
}
