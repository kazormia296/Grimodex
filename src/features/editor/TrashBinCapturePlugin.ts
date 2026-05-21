import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useTrashBinStore } from "@/features/trash-bin/trashBinStore";
import type { TrashOrigin, TrashSpan } from "@/features/trash-bin/types";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { markStart, markEnd } from "@/lib/perfLog";

export const trashBinCaptureKey = new PluginKey<TrashBinCaptureState>(
  "trashBinCapture",
);

export const META_ORIGIN = "trashBin.origin";
export const META_PAUSED = "trashBin.paused";
export const META_SKIP = "trashBin.skip";

interface TrashBinCaptureState {
  origin: TrashOrigin | null;
  paused: boolean;
}

interface BackspaceBuffer {
  text: string;
  spans: TrashSpan[];
  lastFrom: number;
  lastTo: number;
  lastUpdatedAt: number;
  origin: TrashOrigin;
  timerId: ReturnType<typeof setTimeout> | null;
  tempId: string;
}

const BUFFER_DEBOUNCE_MS = 500;
const MIN_FRAGMENT_CHARS = 2;

function nextTempId(): string {
  return `trash-pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 削除範囲のテキストノードから authorship mark を抽出して
 * TrashSpan[] と連結テキストを返す。
 */
function extractSpans(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): { text: string; spans: TrashSpan[] } {
  const spans: TrashSpan[] = [];
  const parts: string[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    const text = node.text ?? "";
    const sliceFrom = Math.max(from, pos) - pos;
    const sliceTo = Math.min(to, pos + text.length) - pos;
    if (sliceFrom >= sliceTo) return true;
    const slice = text.slice(sliceFrom, sliceTo);
    parts.push(slice);
    const mark = node.marks.find((m) => m.type.name === "authorship");
    if (mark) {
      const a = mark.attrs;
      spans.push({
        text: slice,
        source: (a.source as TrashSpan["source"]) ?? "human",
        model: (a.model as string | null) ?? null,
        chatMessageId: (a.chatMessageId as string | null) ?? null,
        timestamp: (a.timestamp as string | null) ?? null,
      });
    } else {
      spans.push({
        text: slice,
        source: "human",
        model: null,
        chatMessageId: null,
        timestamp: null,
      });
    }
    return true;
  });
  return { text: parts.join(""), spans };
}

/**
 * Backspace 連打バッファのフラッシュ。
 * 2 文字未満なら破棄、それ以上なら trashBinStore.enqueuePending へ。
 */
function flushBuffer(buffer: BackspaceBuffer): void {
  if (buffer.timerId !== null) {
    clearTimeout(buffer.timerId);
    buffer.timerId = null;
  }
  if ([...buffer.text].length < MIN_FRAGMENT_CHARS) return;
  // 空白のみの削除はゴミ箱に積まない
  if (buffer.text.trim().length === 0) return;

  useTrashBinStore.getState().enqueuePending(
    {
      projectId: getCurrentProjectId(),
      kind: "text-fragment",
      subKind: "text-fragment",
      originSceneId: buffer.origin.kind === "scene" ? buffer.origin.id : null,
      originCodexId: buffer.origin.kind === "codex" ? buffer.origin.id : null,
      previewText: buffer.text,
      previewMeta: null,
      payload: { text: buffer.text, spans: buffer.spans },
    },
    { tempId: buffer.tempId },
  );
}

export function createTrashBinCapturePlugin(): Plugin<TrashBinCaptureState> {
  // バッファは plugin インスタンスごとに 1 つ (closure でエディタ単位)
  let buffer: BackspaceBuffer | null = null;

  const scheduleFlush = (b: BackspaceBuffer) => {
    if (b.timerId !== null) clearTimeout(b.timerId);
    b.timerId = setTimeout(() => {
      flushBuffer(b);
      if (buffer === b) buffer = null;
    }, BUFFER_DEBOUNCE_MS);
  };

  return new Plugin<TrashBinCaptureState>({
    key: trashBinCaptureKey,
    state: {
      init(): TrashBinCaptureState {
        return { origin: null, paused: false };
      },
      apply(tr: Transaction, prev: TrashBinCaptureState): TrashBinCaptureState {
        let next = prev;
        const origin = tr.getMeta(META_ORIGIN);
        if (origin !== undefined) {
          next = { ...next, origin: origin as TrashOrigin | null };
        }
        const paused = tr.getMeta(META_PAUSED);
        if (paused !== undefined) {
          next = { ...next, paused: !!paused };
        }
        return next;
      },
    },
    appendTransaction(transactions, oldState, newState) {
      markStart("plugin.trashBinCapture.appendTransaction");
      try {
        // Undo / Redo 起源 → 直近の保留を破棄して return null。
        // docChanged チェックより先に置くことで、meta だけの dispatch も検出可。
        // history$ のみで判定 (addToHistory:false は origin meta dispatch 等で
        // 立つので Undo 起源とは限らない)
        const isUndoRedo = transactions.some(
          (tr) => tr.getMeta("history$") !== undefined,
        );
        if (isUndoRedo) {
          const state = trashBinCaptureKey.getState(newState);
          const origin = state?.origin ?? null;
          if (origin) {
            // scene / codex は FK でまとめてキャンセル (1500ms 内の連打全部)。
            // snippet / sticky は FK が無いので、現バッファの tempId だけを
            // 取り消す (現セッションの flush 済み 1 件のみ対象)。
            if (origin.kind === "scene") {
              useTrashBinStore
                .getState()
                .cancelPending({ originSceneId: origin.id });
            } else if (origin.kind === "codex") {
              useTrashBinStore
                .getState()
                .cancelPending({ originCodexId: origin.id });
            } else if (buffer) {
              useTrashBinStore
                .getState()
                .cancelPending({ tempId: buffer.tempId });
            }
          }
          // 連打バッファも破棄 (合体中の屑は捨てる)
          if (buffer) {
            if (buffer.timerId !== null) clearTimeout(buffer.timerId);
            buffer = null;
          }
          return null;
        }

        const state = trashBinCaptureKey.getState(newState);
        if (!state) return null;
        if (state.paused) return null;
        if (state.origin === null) return null;

        // IME 合成中はキャプチャ保留
        // (ProseMirror plugin の view.composing は appendTransaction 内では
        //  直接参照不可。ProseMirror state には storedMarks 経由で見えないので
        //  meta `composition` で transaction を識別するか、from/to/slice の
        //  パターンで Replace 判定に委ねる。今回は Replace 規則に任せる)

        for (const tr of transactions) {
          if (tr.getMeta("programmaticDelete") === true) continue;
          if (tr.getMeta(META_SKIP) === true) continue;

          for (const step of tr.steps) {
            if (!(step instanceof ReplaceStep)) continue;
            const { from, to } = step as { from: number; to: number };
            if (from === to) continue; // 純粋挿入はスキップ
            // 置換 (Replace + Insert) はスキップ。ただし slice が「空段落」など
            // 構造ノードのみで実テキストを持たない場合は、ProseMirror が
            // doc に 1 ブロック残すために挿入した補填であって実質「全消し」なので
            // キャプチャ対象に含める。Ctrl+A → Delete (複数段落) がこのケース。
            const sliceContent = step.slice.content;
            const sliceText = sliceContent.textBetween(
              0,
              sliceContent.size,
              "",
            );
            if (sliceText.length > 0) continue;

            // 削除範囲のテキスト・spans 抽出
            const { text, spans } = extractSpans(oldState.doc, from, to);
            if (text.length === 0) continue;

            if (
              buffer &&
              Date.now() - buffer.lastUpdatedAt <= BUFFER_DEBOUNCE_MS
            ) {
              const isBackspace = to === buffer.lastFrom; // 直前削除位置の左を削った
              const isDelete = from === buffer.lastFrom; // 同じ位置から右を削った
              if (isBackspace) {
                buffer.text = text + buffer.text;
                buffer.spans = [...spans, ...buffer.spans];
                buffer.lastFrom = from;
                buffer.lastUpdatedAt = Date.now();
                scheduleFlush(buffer);
                continue;
              }
              if (isDelete) {
                buffer.text = buffer.text + text;
                buffer.spans = [...buffer.spans, ...spans];
                buffer.lastTo = to;
                buffer.lastUpdatedAt = Date.now();
                scheduleFlush(buffer);
                continue;
              }
              // 非隣接 → 既存をフラッシュして新バッファへ
              flushBuffer(buffer);
              buffer = null;
            }

            buffer = {
              text,
              spans,
              lastFrom: from,
              lastTo: to,
              lastUpdatedAt: Date.now(),
              origin: state.origin,
              timerId: null,
              tempId: nextTempId(),
            };
            scheduleFlush(buffer);
          }
        }
        return null;
      } finally {
        markEnd("plugin.trashBinCapture.appendTransaction");
      }
    },
    view() {
      return {
        destroy() {
          // エディタ unmount 時、保留バッファをフラッシュしてから破棄
          if (buffer) flushBuffer(buffer);
          buffer = null;
        },
      };
    },
  });
}

/** テスト・デバッグ用 (現在のバッファを覗き見) */
export function getCurrentBufferForTest(
  state: EditorState,
): { text: string } | null {
  // closure の buffer はテスト側からは観測できないので、
  // 代わりに plugin state を返す。バッファ自体の検証は flush 経由で行う。
  const s = trashBinCaptureKey.getState(state);
  return s ? { text: "" } : null;
}
