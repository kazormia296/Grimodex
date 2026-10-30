import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useLayoutStore } from "./layoutStore";
import type { OverlayId } from "./layoutTypes";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** オーバーレイの React 木に紐づくハンドラ。層の root 要素にそのまま展開する。 */
export interface OverlayDismissHandlers {
  onPointerDownCapture: (event: React.PointerEvent) => void;
  onFocusCapture: (event: React.FocusEvent) => void;
  onBlurCapture: (event: React.FocusEvent) => void;
}

/**
 * オーバーレイを閉じる条件とフォーカスの出し入れ。
 *
 * - 外での pointerdown で閉じる。中か外かは DOM ではなく React の木で決める。
 *   Radix の menu／dialog は portal に描かれるので、DOM の包含で見ると「外」になる。
 *   層の `onPointerDownCapture` が native event に印を付け、document の listener
 *   （React の root より後に走る）がその印を見る。rail のつまみは自身が開閉するので対象外。
 * - Tab キーの直後に focus が層の外へ出たときだけ閉じる。プログラムの `focus()` でも
 *   focusout は起きるので、relatedTarget だけでは区別できない（計画 §1 の d）。
 *   focus の移り先が portal 内の React 子（focus trap 等）のこともあるので、
 *   続く focusin にも同じ印を見て、外だと確定してから閉じる。
 * - Esc は document の bubble で受け、閉じたら preventDefault する。zoom／Zen の Esc は
 *   window の listener なので、それより先に効き、二重には反応しない。
 *   IME 変換中と、Radix 等が先に消費した（defaultPrevented）Esc は奪わない。
 * - 開いたらパネルの先頭の操作できる要素へ focus を移し、閉じたら開く前の要素へ戻す
 *   （消えていたらエディタ）。
 */
export function useOverlayDismiss(
  side: OverlayId,
  layerRef: RefObject<HTMLElement | null>,
): OverlayDismissHandlers {
  const open = useLayoutStore((s) => s.openOverlay === side);
  // React の木の中で起きた native event。WeakSet なので掃除は要らない。
  const insideEvents = useRef(new WeakSet<Event>()).current;
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  /** pointer／Tab で外に出て閉じたときは、利用者が選んだ focus を奪わない。 */
  const skipRestoreRef = useRef(false);

  const markInside = useCallback(
    (event: { nativeEvent: Event }) => {
      insideEvents.add(event.nativeEvent);
    },
    [insideEvents],
  );

  // 開閉に合わせた focus の出し入れ。
  useEffect(() => {
    const layer = layerRef.current;
    if (open && !wasOpenRef.current) {
      const active = document.activeElement;
      openerRef.current =
        active instanceof HTMLElement && !layer?.contains(active)
          ? active
          : null;
      skipRestoreRef.current = false;
      const panel = layer?.querySelector<HTMLElement>("[data-overlay-panel]");
      // lazy パネルの import 前は操作できる要素がないので、パネル自身に置く。
      (panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? panel)?.focus({
        preventScroll: true,
      });
    } else if (!open && wasOpenRef.current) {
      const opener = openerRef.current;
      openerRef.current = null;
      const active = document.activeElement;
      const focusLost =
        active === null ||
        active === document.body ||
        (layer?.contains(active) ?? false);
      // 別の overlay へ切り替えたときは、開く側が focus を持つ。
      const noneOpen = useLayoutStore.getState().openOverlay === null;
      if (!skipRestoreRef.current && noneOpen && focusLost) {
        if (opener?.isConnected) opener.focus({ preventScroll: true });
        else useLayoutStore.getState().requestEditorFocus();
      }
    }
    wasOpenRef.current = open;
  }, [open, layerRef]);

  // 閉じる条件。開いている間だけ listener を持つ。
  useEffect(() => {
    if (!open) return undefined;

    const dismiss = (restoreFocus: boolean) => {
      if (!restoreFocus) skipRestoreRef.current = true;
      useLayoutStore.getState().closeOverlay();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (insideEvents.has(event)) return;
      const target = event.target;
      if (target instanceof Element && target.closest("[data-overlay-knob]")) {
        return;
      }
      dismiss(false);
    };

    let tabHeld = false;
    let pendingTarget: EventTarget | null = null;
    const onKeyDownCapture = (event: KeyboardEvent) => {
      tabHeld = event.key === "Tab";
    };
    const onKeyUp = () => {
      tabHeld = false;
    };
    const onFocusOut = (event: FocusEvent) => {
      pendingTarget = null;
      if (!tabHeld || !insideEvents.has(event)) return;
      const next = event.relatedTarget;
      if (!(next instanceof Node) || layerRef.current?.contains(next)) return;
      pendingTarget = next;
    };
    const onFocusIn = (event: FocusEvent) => {
      const pending = pendingTarget;
      pendingTarget = null;
      if (pending === null || event.target !== pending) return;
      // 移り先が portal 内の React 子なら、まだ層の中。
      if (insideEvents.has(event)) return;
      dismiss(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229
      ) {
        return;
      }
      event.preventDefault();
      dismiss(true);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDownCapture, true);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDownCapture, true);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, insideEvents, layerRef]);

  return {
    onPointerDownCapture: markInside,
    onFocusCapture: markInside,
    onBlurCapture: markInside,
  };
}
