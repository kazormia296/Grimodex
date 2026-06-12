// IME composition 診断ログ。縦書きMODE の実機 QA ゲート「IME 変換窓」
// (docs/Grimodex_縦書きMODE設計書.md「IME 変換対応の方針」) の判定材料を集める。
//
// 候補ウィンドウは OS の IME が描くため WebView 内からは観測できない。
// ここで記録するのは「エンジンがプラットフォームに伝えているはずの位置」=
// composition 中の DOM selection 矩形と、アプリ側が認識しているキャレット
// 矩形。実機スクリーンショットの候補窓位置と突き合わせて、ズレが
// WebView 起因かアプリ起因かを判定する。
//
// dev-tools コンソール (または DebugLogViewer ヘッダのトグル) から:
//   enableImeLog()   // localStorage 永続 — リロード後も有効
//   disableImeLog()
//   dumpImeLog()     // 記録済みエントリ (リングバッファ、最大 300 件)
//   clearImeLog()
//
// 純関数 (buildImeLogEntry / formatImeLogEntry / roundRect) はスナップ
// ショットを引数で受けて DOM 非依存に保つ (unit test 対象)。DOM 計測は
// ImeDiagnosticsPlugin 側の責務。

import { debugLog } from "./debugLog";

export type RectLike = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type RectLog = RectLike & { width: number; height: number };

export type ImeEventType =
  | "compositionstart"
  | "compositionupdate"
  | "compositionend";

/** ImeDiagnosticsPlugin が DOM から集めた生スナップショット。 */
export type ImeEventSnapshot = {
  type: ImeEventType;
  /** performance.now() の取得は呼び出し側 (純関数性の維持)。 */
  at: number;
  /** CompositionEvent.data (build 時に切り詰める)。 */
  data: string | null;
  selectionFrom: number;
  selectionTo: number;
  /** ProseMirror が composition 中と認識しているか (view.composing)。 */
  pmComposing: boolean;
  vertical: boolean;
  /** DOM selection range の矩形 — エンジンが OS IME に伝える位置の源泉。 */
  domSelectionRect: RectLike | null;
  domSelectionRects: RectLike[];
  /** アプリ認識キャレット矩形 (resolveCoordsVertical / resolveCoords)。 */
  appCaretRect: RectLike | null;
  /** PM coordsAtPos (flattenV 経由) — flatten 起因の乖離検出用。 */
  pmCaretRect: RectLike | null;
  logicalScrollOffset: number | null;
  rawScrollLeft: number | null;
  rawScrollTop: number | null;
  containerRect: RectLike | null;
  /** スクショ (デバイス px) と CSS px の突合せ用。 */
  devicePixelRatio: number;
  screenX: number;
  screenY: number;
};

export type ImeLogEntry = Omit<
  ImeEventSnapshot,
  | "domSelectionRect"
  | "domSelectionRects"
  | "appCaretRect"
  | "pmCaretRect"
  | "containerRect"
> & {
  seq: number;
  domSelectionRect: RectLog | null;
  domSelectionRects: RectLog[];
  appCaretRect: RectLog | null;
  pmCaretRect: RectLog | null;
  containerRect: RectLog | null;
};

const STORAGE_KEY = "grimodex.imeLog";
const MAX_ENTRIES = 300;
/** 未確定文字列は本文そのもの — ログへの混入は先頭だけに留める。 */
const MAX_DATA_CHARS = 32;

let enabled = false;
let nextSeq = 1;
const entries: ImeLogEntry[] = [];

export function isImeLogEnabled(): boolean {
  return enabled;
}

/** 0.1px 丸め (サブピクセルノイズを落としつつ flatten 判定には十分)。 */
export function roundRect(r: RectLike): RectLog {
  const round = (v: number) => Math.round(v * 10) / 10;
  return {
    left: round(r.left),
    top: round(r.top),
    right: round(r.right),
    bottom: round(r.bottom),
    width: round(r.right - r.left),
    height: round(r.bottom - r.top),
  };
}

function truncateData(data: string | null): string | null {
  if (data == null) return null;
  return data.length > MAX_DATA_CHARS
    ? `${data.slice(0, MAX_DATA_CHARS)}…`
    : data;
}

export function buildImeLogEntry(
  s: ImeEventSnapshot,
): Omit<ImeLogEntry, "seq"> {
  const round1 = (v: number | null) =>
    v == null ? null : Math.round(v * 10) / 10;
  return {
    type: s.type,
    at: Math.round(s.at),
    data: truncateData(s.data),
    selectionFrom: s.selectionFrom,
    selectionTo: s.selectionTo,
    pmComposing: s.pmComposing,
    vertical: s.vertical,
    domSelectionRect: s.domSelectionRect ? roundRect(s.domSelectionRect) : null,
    domSelectionRects: s.domSelectionRects.map(roundRect),
    appCaretRect: s.appCaretRect ? roundRect(s.appCaretRect) : null,
    pmCaretRect: s.pmCaretRect ? roundRect(s.pmCaretRect) : null,
    logicalScrollOffset: round1(s.logicalScrollOffset),
    rawScrollLeft: round1(s.rawScrollLeft),
    rawScrollTop: round1(s.rawScrollTop),
    containerRect: s.containerRect ? roundRect(s.containerRect) : null,
    devicePixelRatio: s.devicePixelRatio,
    screenX: s.screenX,
    screenY: s.screenY,
  };
}

function fmtRect(r: RectLog | null): string {
  // "取得不能" も診断情報なので明示的に残す
  return r ? `(${r.left},${r.top} ${r.width}×${r.height})` : "∅";
}

export function formatImeLogEntry(e: Omit<ImeLogEntry, "seq">): string {
  const parts = [
    e.type,
    e.vertical ? "vertical" : "horizontal",
    `data=${e.data == null ? "null" : JSON.stringify(e.data)}`,
    `sel=${e.selectionFrom}..${e.selectionTo}`,
    `pmComposing=${e.pmComposing}`,
    `dom=${fmtRect(e.domSelectionRect)}`,
    `app=${fmtRect(e.appCaretRect)}`,
    `pm=${fmtRect(e.pmCaretRect)}`,
    `scroll=${e.logicalScrollOffset ?? "∅"}`,
    `dpr=${e.devicePixelRatio}`,
    `screen=(${e.screenX},${e.screenY})`,
  ];
  return parts.join(" ");
}

/**
 * エントリを記録する (ゲート OFF なら null)。debugLog へミラーするので
 * devtools が開けない production でも DebugLogViewer (Ctrl+Shift+D) で
 * 閲覧・コピーできる。detail は JSON 全文 — Copy all で QA 結果ごと回収。
 */
export function recordImeEvent(
  entry: Omit<ImeLogEntry, "seq">,
): ImeLogEntry | null {
  if (!enabled) return null;
  const full: ImeLogEntry = { ...entry, seq: nextSeq++ };
  entries.push(full);
  if (entries.length > MAX_ENTRIES) entries.shift();
  debugLog.info("IME", formatImeLogEntry(full), JSON.stringify(full));
  return full;
}

export function dumpImeLog(): ImeLogEntry[] {
  return entries.slice();
}

export function clearImeLog(): void {
  entries.length = 0;
  nextSeq = 1;
}

export function enableImeLog(): void {
  if (enabled) return;
  enabled = true;
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // ignore storage failures
  }
  console.info(
    "[imeLog] enabled. Composition events are logged (ring buffer 300). dumpImeLog() to export, disableImeLog() to stop.",
  );
}

export function disableImeLog(): void {
  if (!enabled) return;
  enabled = false;
  try {
    localStorage.setItem(STORAGE_KEY, "0");
  } catch {
    // ignore
  }
  // entries は保持 — 無効化後も dumpImeLog() で回収できる
  console.info("[imeLog] disabled.");
}

/**
 * 素の contenteditable 切り分けページへ遷移する (SPA を離れるため
 * 未保存の編集は事前に保存すること)。dev/production 同一オリジンの
 * 静的アセット (public/ime-test.html)。
 */
export function openImeTestPage(): void {
  location.assign("/ime-test.html");
}

declare global {
  interface Window {
    enableImeLog?: () => void;
    disableImeLog?: () => void;
    dumpImeLog?: () => ImeLogEntry[];
    clearImeLog?: () => void;
    openImeTestPage?: () => void;
  }
}

if (typeof window !== "undefined") {
  window.enableImeLog = enableImeLog;
  window.disableImeLog = disableImeLog;
  window.dumpImeLog = dumpImeLog;
  window.clearImeLog = clearImeLog;
  window.openImeTestPage = openImeTestPage;
  try {
    if (localStorage.getItem(STORAGE_KEY) === "1") {
      enableImeLog();
    }
  } catch {
    // ignore
  }
}
