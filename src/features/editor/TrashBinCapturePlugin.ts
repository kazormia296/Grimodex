import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useTrashBinStore } from "@/features/trash-bin/trashBinStore";
import type { TrashOrigin, TrashSpan } from "@/features/trash-bin/types";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { markStart, markEnd } from "@/lib/perfLog";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { registerQuiescenceParticipant } from "@/application/lifecycle/quiescenceParticipants";
import { isQuiescenceLeaseActive } from "@/application/lifecycle/quiescenceLease";

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
  projectId: string;
  text: string;
  spans: TrashSpan[];
  lastFrom: number;
  lastTo: number;
  lastUpdatedAt: number;
  origin: TrashOrigin;
  timerId: ReturnType<typeof setTimeout> | null;
  tempId: string;
  /** Captured before a lifecycle lease and therefore eligible to drain. */
  preexistingDraft: boolean;
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
        traceId: (a.traceId as string | null) ?? null,
        timestamp: (a.timestamp as string | null) ?? null,
      });
    } else {
      spans.push({
        text: slice,
        source: "human",
        model: null,
        chatMessageId: null,
        traceId: null,
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
function flushBuffer(
  buffer: BackspaceBuffer,
  options: { preexistingDraft?: boolean } = {},
): void {
  if (buffer.timerId !== null) {
    clearTimeout(buffer.timerId);
    buffer.timerId = null;
  }
  if ([...buffer.text].length < MIN_FRAGMENT_CHARS) return;
  // 空白のみの削除はゴミ箱に積まない
  if (buffer.text.trim().length === 0) return;

  const trashStore = useTrashBinStore.getState();
  if (trashStore.activeProjectId !== buffer.projectId) {
    throw new Error(
      `Trash capture authority changed before flush: ${buffer.projectId}`,
    );
  }
  const accepted = trashStore.enqueuePending(
    {
      projectId: buffer.projectId,
      kind: "text-fragment",
      subKind: "text-fragment",
      originSceneId: buffer.origin.kind === "scene" ? buffer.origin.id : null,
      originCodexId: buffer.origin.kind === "codex" ? buffer.origin.id : null,
      previewText: buffer.text,
      previewMeta: null,
      payload: { text: buffer.text, spans: buffer.spans },
    },
    {
      tempId: buffer.tempId,
      preexistingDraft: options.preexistingDraft,
    },
  );
  if (!accepted) {
    throw new Error(
      `Trash capture was not admitted for retry: ${buffer.tempId}`,
    );
  }
}

export function createTrashBinCapturePlugin(): Plugin<TrashBinCaptureState> {
  // バッファは plugin インスタンスごとに 1 つ (closure でエディタ単位)
  let buffer: BackspaceBuffer | null = null;
  const participantId = nextTempId().replace("trash-pending", "trash-capture");

  const flushCurrentBuffer = (): void => {
    const current = buffer;
    if (!current) return;
    if (isQuiescenceLeaseActive() && !current.preexistingDraft) {
      throw new Error(
        `Trash capture started during lifecycle lease: ${current.tempId}`,
      );
    }
    flushBuffer(current, { preexistingDraft: current.preexistingDraft });
    if (buffer === current) buffer = null;
  };

  const scheduleFlush = (b: BackspaceBuffer) => {
    if (b.timerId !== null) clearTimeout(b.timerId);
    b.timerId = setTimeout(() => {
      try {
        flushBuffer(b, { preexistingDraft: b.preexistingDraft });
        if (buffer === b) buffer = null;
      } catch (error) {
        // Keep the ref-backed buffer and participant recovery snapshot. A
        // later strict lifecycle retry can flush it under the captured
        // Project authority instead of silently assigning it to another one.
        debugLog.error(
          "TrashBinCapturePlugin",
          "buffer flush failed",
          errorDetail(error),
        );
      }
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
          // TipTap marks `setContent(..., { emitUpdate: false })` with
          // preventUpdate. Whole-document projection can contain an empty
          // paragraph replacement, which looks like a deletion to a
          // ReplaceStep but is not user-authored text removal. Inline AI
          // rollback uses the same marker for its programmatic cleanup.
          if (tr.getMeta("preventUpdate") === true) continue;
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
            const projectId = getCurrentProjectId();

            if (
              buffer &&
              buffer.projectId === projectId &&
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
              try {
                flushCurrentBuffer();
              } catch (error) {
                debugLog.error(
                  "TrashBinCapturePlugin",
                  "non-adjacent buffer flush failed",
                  errorDetail(error),
                );
                return null;
              }
            } else if (buffer) {
              // A Project identity change is also a hard coalescing boundary.
              // Normally strict quiescence drains this first; if it did not,
              // preserve the old recovery buffer instead of relabeling it.
              try {
                flushCurrentBuffer();
              } catch (error) {
                debugLog.error(
                  "TrashBinCapturePlugin",
                  "project-bound buffer flush failed",
                  errorDetail(error),
                );
                return null;
              }
            }

            buffer = {
              projectId,
              text,
              spans,
              lastFrom: from,
              lastTo: to,
              lastUpdatedAt: Date.now(),
              origin: state.origin,
              timerId: null,
              tempId: nextTempId(),
              preexistingDraft: !isQuiescenceLeaseActive(),
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
      let mounted = true;
      let unregister = () => {};
      const participant = {
        id: participantId,
        flush: async () => {
          // participant stage precedes the trash store's scoped-mutations
          // provider, so the latter can durably drain this newly transferred
          // pre-lease deletion in the same strict lifecycle.
          flushCurrentBuffer();
          if (!mounted && !buffer) unregister();
        },
        discard: () => {
          if (buffer?.timerId != null) clearTimeout(buffer.timerId);
          buffer = null;
          if (!mounted) unregister();
        },
        recovery: () =>
          buffer
            ? {
                kind: "trash-capture",
                projectId: buffer.projectId,
                origin: buffer.origin,
                text: buffer.text,
                spans: buffer.spans,
              }
            : null,
      };
      unregister = registerQuiescenceParticipant(participant);
      return {
        destroy() {
          mounted = false;
          if (!buffer) {
            unregister();
            return;
          }
          // Do not retire a failed detached capture. The participant keeps the
          // old Project identity and recovery payload for a lifecycle retry.
          void participant.flush().catch(() => {});
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
