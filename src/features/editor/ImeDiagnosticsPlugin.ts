import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  buildImeLogEntry,
  formatImeLogEntry,
  isImeLogEnabled,
  recordImeEvent,
  type ImeEventSnapshot,
  type ImeEventType,
  type ImeLogEntry,
  type RectLike,
} from "@/lib/imeLog";
import { resolveCoords, resolveCoordsVertical } from "./cursorCoords";
import { getLogicalScrollOffset } from "./editorLayout";

export const imeDiagnosticsKey = new PluginKey("imeDiagnostics");

/**
 * IME composition 診断プラグイン (enableImeLog() で opt-in)。
 *
 * composition{start,update,end} で「エンジンが OS IME に伝えているはずの
 * DOM selection 矩形」と「アプリ認識のキャレット矩形」を記録し、画面上に
 * 半透明オーバーレイで描く。実機スクリーンショットの候補ウィンドウ位置と
 * 突き合わせるための読み取り専用診断 — doc/selection には一切触れず、
 * 全ハンドラが false を返して ProseMirror 自身の composition 処理に
 * そのまま流す。OFF 時は boolean チェックだけで即 return する。
 *
 * smoothCaret (CursorOverlayPlugin) とは独立して動く: あちらは設定で
 * 無効化されうるが、診断は素の native caret 構成でも記録できる必要がある。
 */
export function createImeDiagnosticsPlugin(): Plugin {
  return new Plugin({
    key: imeDiagnosticsKey,
    props: {
      handleDOMEvents: {
        compositionstart: makeHandler("compositionstart"),
        compositionupdate: makeHandler("compositionupdate"),
        compositionend: makeHandler("compositionend"),
      },
    },
  });
}

function makeHandler(type: ImeEventType) {
  return (view: EditorView, event: Event): boolean => {
    if (!isImeLogEnabled()) {
      // 無効化後に残った前回 QA のオーバーレイは次の変換開始で消す
      hideImeOverlay();
      return false;
    }
    try {
      const snapshot = captureImeSnapshot(
        view,
        type,
        (event as CompositionEvent).data ?? null,
      );
      const entry = recordImeEvent(buildImeLogEntry(snapshot));
      if (entry) renderImeOverlay(entry);
    } catch {
      // 診断が入力処理を壊してはならない — 採取失敗は黙って捨てる
    }
    return false;
  };
}

function captureImeSnapshot(
  view: EditorView,
  type: ImeEventType,
  data: string | null,
): ImeEventSnapshot {
  const { from, to } = view.state.selection;
  const vertical = view.dom.closest(".editor-vertical") !== null;

  // composition 中の DOM selection — Chromium はこの range の矩形を基に
  // 候補ウィンドウ位置をプラットフォームへ伝える。初期フレームでは
  // 全ゼロ rect が返ることがあり、それは null (取得不能) として記録する。
  let domSelectionRect: RectLike | null = null;
  let domSelectionRects: RectLike[] = [];
  const sel = view.dom.ownerDocument.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (
      rect.width > 0 ||
      rect.height > 0 ||
      rect.left !== 0 ||
      rect.top !== 0
    ) {
      domSelectionRect = rect;
    }
    if (typeof range.getClientRects === "function") {
      domSelectionRects = Array.from(range.getClientRects());
    }
  }

  const appCaretRect = vertical
    ? (resolveCoordsVertical(view, from, 1) ?? resolveCoords(view, from, 1))
    : resolveCoords(view, from, 1);

  // flattenV を通った座標も並記して、縦書きでの乖離 (= PM 経由の座標を
  // 使っている箇所が候補窓ズレの原因か) を切り分けられるようにする
  let pmCaretRect: RectLike | null;
  try {
    pmCaretRect = view.coordsAtPos(from, 1);
  } catch {
    pmCaretRect = null;
  }

  const container = findScrollContainer(view.dom, vertical);
  return {
    type,
    at: performance.now(),
    data,
    selectionFrom: from,
    selectionTo: to,
    pmComposing: view.composing,
    vertical,
    domSelectionRect,
    domSelectionRects,
    appCaretRect,
    pmCaretRect,
    logicalScrollOffset: container
      ? getLogicalScrollOffset(container, vertical)
      : null,
    rawScrollLeft: container ? container.scrollLeft : null,
    rawScrollTop: container ? container.scrollTop : null,
    containerRect: container ? container.getBoundingClientRect() : null,
    devicePixelRatio: window.devicePixelRatio,
    screenX: window.screenX,
    screenY: window.screenY,
  };
}

/** 読み進み方向に overflow している最近接祖先 (= スクロールコンテナ)。 */
function findScrollContainer(
  start: HTMLElement,
  vertical: boolean,
): HTMLElement | null {
  let el: HTMLElement | null = start;
  while (el) {
    const overflowing = vertical
      ? el.scrollWidth > el.clientWidth
      : el.scrollHeight > el.clientHeight;
    if (overflowing) return el;
    el = el.parentElement;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 画面オーバーレイ (モジュールレベル共有)
//
// plugin はタブエディタ + Linear の scene block ごとにインスタンス化される
// ため、overlay をインスタンスに持たせると増殖する。viewport 座標の fixed
// 1 枚をシングルトンで使い回す。compositionend 後も次の compositionstart
// まで残す — 確定後に落ち着いてスクリーンショットを撮るため。
// ---------------------------------------------------------------------------

let overlayRoot: HTMLDivElement | null = null;
let domBox: HTMLDivElement | null = null;
let appBox: HTMLDivElement | null = null;
let labelEl: HTMLDivElement | null = null;

function ensureImeOverlay(): void {
  if (overlayRoot && overlayRoot.isConnected) return;
  overlayRoot = document.createElement("div");
  overlayRoot.dataset.imeDiagnosticsOverlay = "true";
  Object.assign(overlayRoot.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    zIndex: "2147483647",
  });

  domBox = document.createElement("div");
  Object.assign(domBox.style, {
    position: "absolute",
    boxSizing: "border-box",
    border: "1.5px solid rgba(255, 64, 64, 0.9)",
    background: "rgba(255, 64, 64, 0.08)",
    display: "none",
  });

  appBox = document.createElement("div");
  Object.assign(appBox.style, {
    position: "absolute",
    boxSizing: "border-box",
    border: "1.5px solid rgba(64, 128, 255, 0.9)",
    background: "rgba(64, 128, 255, 0.08)",
    display: "none",
  });

  // 候補ウィンドウが矩形側を隠してもスクショで数値が読めるよう、
  // 読み出しは viewport 左下隅に固定する
  labelEl = document.createElement("div");
  Object.assign(labelEl.style, {
    position: "absolute",
    left: "4px",
    bottom: "4px",
    maxWidth: "90vw",
    padding: "2px 6px",
    font: "10px/1.5 monospace",
    color: "#fff",
    background: "rgba(0, 0, 0, 0.75)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
  });

  overlayRoot.append(domBox, appBox, labelEl);
  document.body.appendChild(overlayRoot);
}

function positionBox(
  box: HTMLDivElement | null,
  rect: ImeLogEntry["domSelectionRect"],
): void {
  if (!box) return;
  if (!rect) {
    box.style.display = "none";
    return;
  }
  box.style.display = "block";
  box.style.left = `${rect.left}px`;
  box.style.top = `${rect.top}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
}

function renderImeOverlay(entry: ImeLogEntry): void {
  ensureImeOverlay();
  if (overlayRoot) overlayRoot.style.display = "";
  positionBox(domBox, entry.domSelectionRect);
  positionBox(appBox, entry.appCaretRect);
  if (labelEl) {
    labelEl.textContent = `[imeLog #${entry.seq}] 赤=DOM selection / 青=app caret\n${formatImeLogEntry(entry)}`;
  }
}

function hideImeOverlay(): void {
  if (overlayRoot) overlayRoot.style.display = "none";
}
