import {
  useEffect,
  useRef,
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";

/**
 * 上下キー・Home／End の移動先。パネルの中の有効なボタンのうち、非表示と
 * 行末の「削除」（`data-menu-secondary`）を除く。削除は hover や行の focus で
 * 出たり消えたりして、含めると ↓ と ↑ で順序が変わるため、Tab で届かせる。
 */
function menuItems(panel: HTMLElement | null): HTMLButtonElement[] {
  if (!panel) return [];
  return Array.from(
    panel.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled):not([data-menu-secondary])",
    ),
  ).filter((button) => getComputedStyle(button).display !== "none");
}

interface WorkspaceMenuKeyboardOptions {
  isOpen: boolean;
  setIsOpen: Dispatch<SetStateAction<boolean>>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
}

/**
 * 統合メニューのキーボード操作。Esc で閉じてトリガーへ戻し、上下キーと
 * Home／End でパネル内の項目を移動する。トリガーで ↓ を押すと開いて
 * 最初の項目へ。
 */
export function useWorkspaceMenuKeyboard({
  isOpen,
  setIsOpen,
  triggerRef,
  panelRef,
}: WorkspaceMenuKeyboardOptions) {
  const focusFirstOnOpenRef = useRef(false);

  useEffect(() => {
    if (!isOpen || !focusFirstOnOpenRef.current) return;
    focusFirstOnOpenRef.current = false;
    menuItems(panelRef.current)[0]?.focus();
  }, [isOpen, panelRef]);

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    if (isOpen) {
      menuItems(panelRef.current)[0]?.focus();
      return;
    }
    focusFirstOnOpenRef.current = true;
    setIsOpen(true);
  }

  // Esc はメニューの root で受けて伝播を止める。document で Esc を拾う「戻る」
  // （useWorkLayerNavigationController は defaultPrevented を見る）と二重に動かさない。
  function onRootKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!isOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setIsOpen(false);
      triggerRef.current?.focus();
      return;
    }
    const panel = panelRef.current;
    if (!panel || !panel.contains(event.target as Node)) return;
    const items = menuItems(panel);
    if (items.length === 0) return;
    const active = document.activeElement;
    const index = items.indexOf(active as HTMLButtonElement);
    // 移動先に入らない要素（行末の削除など）に focus があるときは、DOM の順で
    // その直後／直前の項目へ動く。
    const following = (item: HTMLElement) =>
      active != null &&
      Boolean(
        active.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    let next: number;
    switch (event.key) {
      case "ArrowDown": {
        const after =
          index >= 0 ? index + 1 : items.findIndex((item) => following(item));
        next = after < 0 || after >= items.length ? 0 : after;
        break;
      }
      case "ArrowUp": {
        // 直後の項目の 1 つ前（直後が無ければ末尾）。
        const firstAfter = items.findIndex((item) => following(item));
        const before =
          index >= 0
            ? index - 1
            : (firstAfter < 0 ? items.length : firstAfter) - 1;
        next = before < 0 ? items.length - 1 : before;
        break;
      }
      case "Home":
        next = 0;
        break;
      case "End":
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    items[next].focus();
  }

  return { onTriggerKeyDown, onRootKeyDown };
}
