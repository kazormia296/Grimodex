/**
 * 本文の追記を「読者が反応する候補」にまとめるための副作用のない判定。
 * TipTap/React/Rust から分離しておくことで、IME・置換・閾値の境界を単体で
 * 検証できるようにする。
 */

export const LIVE_READER_MIN_PENDING_CHARS = 80;
export const LIVE_READER_MAX_PENDING_CHARS = 160;
export const LIVE_READER_CONTEXT_MAX_CHARS = 2_800;
export const LIVE_READER_IDLE_DELAY_MS = 1_100;

export type LiveReaderChangeKind = "insert" | "delete" | "replace" | "ignored";

export interface LiveReaderChange {
  kind: LiveReaderChangeKind;
  addedText: string;
  removedText: string;
}

export interface LiveReaderChangeOptions {
  /** transaction.docChanged。false の update は保存/解析対象外。 */
  docChanged?: boolean;
  /** IME composition 中は確定後の update だけを数える。 */
  isComposing?: boolean;
  /** AI/貼り付け変換/外部 projection などの programmatic transaction。 */
  isProgrammatic?: boolean;
}

function ignoredChange(): LiveReaderChange {
  return { kind: "ignored", addedText: "", removedText: "" };
}

/**
 * 前後の plain text から、単一の連続した差分を取り出す。
 * 追記以外（削除・置換）はコメントを古い本文へ紐付けないため無視する。
 */
export function classifyLiveReaderChange(
  previousText: string,
  nextText: string,
  options: LiveReaderChangeOptions = {},
): LiveReaderChange {
  if (
    options.docChanged === false ||
    options.isComposing === true ||
    options.isProgrammatic === true
  ) {
    return ignoredChange();
  }

  if (previousText === nextText) return ignoredChange();

  let prefix = 0;
  const prefixLimit = Math.min(previousText.length, nextText.length);
  while (prefix < prefixLimit && previousText[prefix] === nextText[prefix]) {
    prefix++;
  }

  let suffix = 0;
  const previousRemaining = previousText.length - prefix;
  const nextRemaining = nextText.length - prefix;
  while (
    suffix < previousRemaining &&
    suffix < nextRemaining &&
    previousText[previousText.length - 1 - suffix] ===
      nextText[nextText.length - 1 - suffix]
  ) {
    suffix++;
  }

  const previousEnd = previousText.length - suffix;
  const nextEnd = nextText.length - suffix;
  const removedText = previousText.slice(prefix, previousEnd);
  const addedText = nextText.slice(prefix, nextEnd);

  if (removedText && addedText) {
    return { kind: "replace", addedText, removedText };
  }
  if (removedText) return { kind: "delete", addedText: "", removedText };
  if (addedText) return { kind: "insert", addedText, removedText: "" };
  return ignoredChange();
}

export interface LiveReaderAccumulator {
  pendingText: string;
  pendingChars: number;
}

export function createLiveReaderAccumulator(): LiveReaderAccumulator {
  return { pendingText: "", pendingChars: 0 };
}

export function accumulateLiveReaderInsertion(
  state: LiveReaderAccumulator,
  addedText: string,
): LiveReaderAccumulator {
  if (!addedText) return state;
  return {
    pendingText: state.pendingText + addedText,
    pendingChars: state.pendingChars + addedText.length,
  };
}

function containsNaturalBoundary(text: string): boolean {
  return /[。！？.!?\n]/u.test(text);
}

/** 閾値到達か、十分な長さのまとまりを読者へ渡せる状態か。 */
export function shouldTriggerLiveReader(state: LiveReaderAccumulator): boolean {
  return (
    state.pendingChars >= LIVE_READER_MIN_PENDING_CHARS &&
    (state.pendingChars >= LIVE_READER_MAX_PENDING_CHARS ||
      containsNaturalBoundary(state.pendingText))
  );
}

export function takeLiveReaderInsertion(state: LiveReaderAccumulator): {
  text: string;
  next: LiveReaderAccumulator;
} {
  return { text: state.pendingText, next: createLiveReaderAccumulator() };
}

/**
 * 直近の追記を中心に、前後の短い近傍だけをモデルへ渡す。
 * 全シーンを毎回送らず、マーカーで「今回読む箇所」を明示する。
 */
export function buildLiveReaderContext(
  fullText: string,
  addedText: string,
  maxChars: number = LIVE_READER_CONTEXT_MAX_CHARS,
): string {
  const open = "[RECENTLY_ADDED]\n";
  const close = "\n[/RECENTLY_ADDED]";
  const safeMax = Math.max(
    open.length + close.length + 1,
    Math.floor(maxChars),
  );
  const addedBudget = Math.max(1, safeMax - open.length - close.length);
  const markedText =
    addedText.length <= addedBudget ? addedText : addedText.slice(-addedBudget);
  const markerStart = fullText.lastIndexOf(markedText);
  const start =
    markerStart >= 0
      ? markerStart
      : Math.max(0, fullText.length - markedText.length);
  const end =
    markerStart >= 0 ? markerStart + markedText.length : fullText.length;
  const nearbyBudget = Math.max(
    0,
    safeMax - open.length - close.length - markedText.length,
  );
  const beforeBudget = Math.ceil(nearbyBudget * 0.6);
  const afterBudget = nearbyBudget - beforeBudget;
  const before = fullText.slice(Math.max(0, start - beforeBudget), start);
  const after = fullText.slice(end, end + afterBudget);
  return `${before}${open}${markedText}${close}${after}`.slice(0, safeMax);
}
