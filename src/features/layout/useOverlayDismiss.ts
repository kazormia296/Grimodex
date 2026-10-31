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

/** 左右の層が持つ「開く前の要素」。切り替えのとき、開く側が閉じる側の分を引き継ぐ。 */
const openerBySide: Record<OverlayId, HTMLElement | null> = {
  left: null,
  right: null,
};
/** 直近の openOverlay の遷移が、一方から他方への切り替えだったときの「切り替え元」。 */
let switchedFrom: OverlayId | null = null;
useLayoutStore.subscribe((state, prev) => {
  if (state.openOverlay === prev.openOverlay) return;
  switchedFrom =
    prev.openOverlay !== null && state.openOverlay !== null
      ? prev.openOverlay
      : null;
});

/** overlay の層とつまみ。層は閉じると inert になり、つまみは押すと focus を得る。 */
const OVERLAY_SURFACE_SELECTOR = "[data-overlay-layer],[data-overlay-knob]";

/**
 * オーバーレイを閉じる条件とフォーカスの出し入れ。
 *
 * - 外での pointerdown で閉じる。中か外かは DOM ではなく React の木で決める。
 *   Radix の menu／dialog は portal に描かれるので、DOM の包含で見ると「外」になる。
 *   層の `onPointerDownCapture` が native event に印を付け、document の listener
 *   （React の root より後に走る）がその印を見る。つまみは自身が開閉するので対象外。
 * - Tab キーの直後に focus が層の外へ出たときだけ閉じる。プログラムの `focus()` でも
 *   focusout は起きるので、relatedTarget だけでは区別できない（計画 §1 の d）。
 *   focus の移り先が portal 内の React 子（focus trap 等）のこともあるので、
 *   続く focusin にも同じ印を見て、外だと確定してから閉じる。
 * - Esc は 1 回につき「一番内側のもの」だけを閉じる。overlay の中の独自メニュー等は
 *   document／window の listener で Esc を受け、登録順は overlay の後になりうる。
 *   そこで overlay は window で受けても閉じるのを次の task まで遅らせ、その event の
 *   同期的な dispatch が全部終わってから defaultPrevented を見る（内側が処理して
 *   preventDefault していれば閉じない）。zoom／Zen の Esc は overlay が開いている間は
 *   何もしない（overlay が先に閉じる）。IME 変換中の Esc は奪わない。
 * - 開いたらパネルの先頭の操作できる要素へ focus を移し、閉じたら開く前の要素へ戻す
 *   （消えていたらエディタ）。左右を切り替えた間は、最初に開いたときの要素を引き継ぐ。
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
      if (switchedFrom !== null && switchedFrom !== side) {
        // 左右の切り替え。active は閉じる側の層の中（inert になる要素）か、押したつまみ
        // なので使わず、最初に開いたときの要素（無ければ null = エディタ）を引き継ぐ。
        openerRef.current = openerBySide[switchedFrom];
      } else {
        openerRef.current =
          active instanceof HTMLElement &&
          active !== document.body &&
          !layer?.contains(active) &&
          !active.closest("[data-overlay-layer]")
            ? active
            : null;
      }
      openerBySide[side] = openerRef.current;
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
      // つまみは、クリックで focus を得ても「戻す対象の外」として扱う
      // （Chromium では button のクリックで focus が移る）。
      const focusLost =
        active === null ||
        active === document.body ||
        (layer?.contains(active) ?? false) ||
        (active instanceof Element &&
          active.closest(OVERLAY_SURFACE_SELECTOR) !== null);
      // 別の overlay へ切り替えたときは、開く側が focus を持つ。
      const noneOpen = useLayoutStore.getState().openOverlay === null;
      // 切り替えのときの引き継ぎのため、openerBySide は切り替えの間は消さない。
      if (noneOpen) {
        openerBySide.left = null;
        openerBySide.right = null;
      }
      if (!skipRestoreRef.current && noneOpen && focusLost) {
        if (opener?.isConnected && !opener.closest("[inert]")) {
          opener.focus({ preventScroll: true });
        } else useLayoutStore.getState().requestEditorFocus();
      }
    }
    wasOpenRef.current = open;
  }, [open, side, layerRef]);

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

    let escTimer: number | null = null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229
      ) {
        return;
      }
      // 閉じるのは、この event を受ける listener が全部終わった後。
      if (escTimer !== null) window.clearTimeout(escTimer);
      escTimer = window.setTimeout(() => {
        escTimer = null;
        if (event.defaultPrevented) return;
        if (useLayoutStore.getState().openOverlay !== side) return;
        dismiss(true);
      }, 0);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDownCapture, true);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      if (escTimer !== null) window.clearTimeout(escTimer);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDownCapture, true);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, side, insideEvents, layerRef]);

  return {
    onPointerDownCapture: markInside,
    onFocusCapture: markInside,
    onBlurCapture: markInside,
  };
}
