import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useLayoutStore } from "./layoutStore";
import type { PanelId } from "./panelIds";

/**
 * パネル chrome 操作（折りたたみ / 最大化）のジェスチャ対象かを判定する。
 * 各パネルが自前ヘッダー行に付ける `data-panel-header` 内、かつボタン等の
 * インタラクティブ要素の外のみを対象にする（タブ・トグル・ピッカー・
 * 入力欄上での誤発火防止）。
 */
const INTERACTIVE_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "a",
  "[contenteditable]",
  '[role="combobox"]',
  '[role="menuitem"]',
  '[role="tab"]',
  // エディタのタブ等、button でない独自インタラクティブ要素は draggable で
  // 拾う（タブは dblclick = preview ピン留めを既に持つ）。
  '[draggable="true"]',
].join(", ");

export function isPanelChromeGestureTarget(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) return false;
  if (!target.closest("[data-panel-header]")) return false;
  return target.closest(INTERACTIVE_SELECTOR) === null;
}

interface PanelChromeMenuProps {
  panelId: PanelId;
  /** トリガー要素（asChild で合成。パネル全体のラッパーを渡す）。 */
  children: React.ReactNode;
}

/**
 * パネルラッパーに被せる chrome 操作レイヤー。
 *
 * - ヘッダー帯（`[data-panel-header]`）の右クリック → 折りたたみ / 最大化メニュー
 * - ヘッダー帯のダブルクリック → 最大化トグル（タイトルバー dblclick の慣習）
 *
 * 配線はイベント委譲: パネル本体には `data-panel-header` 属性 1 個を足すだけで
 * よく、パネル側は layout 機構を import しない。ヘッダー帯の外の右クリックは
 * preventDefault で Radix の open を抑止する（native menu は main.tsx で
 * 全域抑止済みなので挙動は変わらない）。パネル内部の既存 ContextMenu
 * （ツリーノード等）は descendant 側が先に defaultPrevented にするため
 * 二重に開かない。
 */
export function PanelChromeMenu({ panelId, children }: PanelChromeMenuProps) {
  const { t } = useTranslation();
  const togglePanel = useLayoutStore((s) => s.togglePanel);
  const toggleMaximizePanel = useLayoutStore((s) => s.toggleMaximizePanel);
  const isMaximized = useLayoutStore((s) => s.maximizedPanelId === panelId);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!isPanelChromeGestureTarget(e.target)) e.preventDefault();
  }, []);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.defaultPrevented) return;
      if (!isPanelChromeGestureTarget(e.target)) return;
      e.preventDefault();
      toggleMaximizePanel(panelId);
    },
    [panelId, toggleMaximizePanel],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        onContextMenu={handleContextMenu}
        onDoubleClick={handleDoubleClick}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          data-testid={`panel-ctx-maximize-${panelId}`}
          onSelect={() => toggleMaximizePanel(panelId)}
        >
          {isMaximized
            ? t("layout.panelMenu.restore")
            : t("layout.panelMenu.maximize")}
        </ContextMenuItem>
        <ContextMenuItem
          data-testid={`panel-ctx-collapse-${panelId}`}
          onSelect={() => togglePanel(panelId)}
        >
          {t("layout.panelMenu.collapse")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
